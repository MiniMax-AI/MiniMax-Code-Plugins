#!/usr/bin/env node
// run.js — crossplug 转换引擎入口（零依赖）
//
// 用法：
//   node core/run.js dsh2mcode <src> [--out <dir>] [--json]
//   node core/run.js mcode2dsh <src> [--out <dir>] [--json]
//   node core/run.js list --side <dsh|mcode> [--json]
//   node core/run.js install --side <dsh|mcode|dsh-host> [--force] [--preset-id <id>] [--ext-dir <dir>] [--profile <web|cc-tui|headless>] [--json]
//
// 输出：人类可读文本或 --json 的 JSON 对象（供适配器解析）。

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dsh2mcode = require('./dsh2mcode.js');
const mcode2dsh = require('./mcode2dsh.js');
const { installDsh, installDshHost, installDshHostPlugin, installMcode, registerPluginSkills, dshHome, minimaxHome, piHome } = require('./install.js');

function fail(message) {
  process.stderr.write('错误: ' + message + '\n');
  process.exit(1);
}

function argsOf(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out.flags[a.slice(2)] = next;
          i++;
        } else {
          out.flags[a.slice(2)] = true;
        }
      }
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function defaultOutDir(src, sub) {
  const base = path.basename(path.resolve(src));
  return path.join(process.cwd(), 'out', sub + '-' + base);
}

function listDsh() {
  const userDir = path.join(dshHome(), '.agent-presets');
  const result = [];
  if (fs.existsSync(userDir)) {
    for (const d of fs.readdirSync(userDir, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(userDir, d.name, 'agent.cordis.yml'))) {
        result.push({ id: d.name, scope: 'user', dir: path.join(userDir, d.name) });
      }
    }
  }
  // 部署自带 preset（通过 npm 全局根定位 @deepseek-ai/dsh 安装目录）
  for (const root of globalNpmRoots()) {
    const deployDir = path.join(root, '@deepseek-ai', 'dsh', 'config', 'agent-presets');
    if (fs.existsSync(deployDir)) {
      for (const d of fs.readdirSync(deployDir, { withFileTypes: true })) {
        if (d.isDirectory() && fs.existsSync(path.join(deployDir, d.name, 'agent.cordis.yml'))) {
          result.push({ id: d.name, scope: 'deployment', dir: path.join(deployDir, d.name) });
        }
      }
      break;
    }
  }
  return result;
}

function globalNpmRoots() {
  const roots = [];
  try {
    const { spawnSync } = require('node:child_process');
    // Windows 下 npm.cmd 需要 shell；先用 cmd /c 试，失败静默
    const cmd = process.platform === 'win32'
      ? spawnSync('cmd', ['/c', 'npm root -g'], { encoding: 'utf8', windowsHide: true })
      : spawnSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true });
    if (cmd.status === 0 && cmd.stdout && cmd.stdout.trim()) roots.push(cmd.stdout.trim());
  } catch { /* 忽略 */ }
  // 从 node 可执行文件位置推导：<node根>/node_global/node_modules（Windows npm 常见布局）
  try {
    const exeDir = path.dirname(process.execPath);
    roots.push(path.join(exeDir, 'node_global', 'node_modules'));
    roots.push(path.join(path.dirname(exeDir), 'lib', 'node_modules'));
    roots.push(path.join(path.dirname(exeDir), 'lib'));
  } catch { /* 忽略 */ }
  // 兜底常见位置
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  const home = os.homedir();
  roots.push(path.join(home, '.local', 'lib', 'node_modules'));
  roots.push(path.join(home, '.npm', 'global', 'node_modules'));
  return roots;
}

function listMcode() {
  const result = [];
  const pluginsDir = path.join(minimaxHome(), 'plugins');
  if (fs.existsSync(pluginsDir)) {
    for (const d of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (d.isDirectory()) result.push({ id: d.name, scope: 'minimax-plugins', dir: path.join(pluginsDir, d.name) });
    }
  }
  const extDir = path.join(piHome(), 'agent', 'extensions');
  if (fs.existsSync(extDir)) {
    for (const d of fs.readdirSync(extDir, { withFileTypes: true })) {
      const p = path.join(extDir, d.name);
      if (d.isDirectory()) result.push({ id: d.name, scope: 'pi-extensions', dir: p });
      else if (d.isFile() && /\.(js|ts)$/.test(d.name)) result.push({ id: d.name, scope: 'pi-extensions', dir: p });
    }
  }
  return result;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd) {
    process.stdout.write(usage());
    return;
  }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    process.stdout.write('crossplug 0.1.0\n');
    return;
  }
  const rest = argv.slice(1);
  const a = argsOf(rest);
  const json = !!a.flags.json;

  try {
    let result;
    if (cmd === 'dsh2mcode') {
      const src = a.positional[0];
      if (!src) fail('dsh2mcode 需要输入路径（preset 目录或插件源码文件）');
      const out = a.flags.out || defaultOutDir(src, 'mcode');
      result = dsh2mcode.convert(path.resolve(src), path.resolve(out));
      result.ok = true;
      // 输出落在 ~/.minimax/plugins/ 下时：把包内技能自动注册为用户技能（斜杠命令可用）
      const outAbs = path.resolve(out);
      const mmPlugins = path.join(minimaxHome(), 'plugins');
      if (outAbs === mmPlugins || outAbs.startsWith(mmPlugins + path.sep)) {
        result.skillCommands = registerPluginSkills(outAbs);
      }
    } else if (cmd === 'mcode2dsh') {
      const src = a.positional[0];
      if (!src) fail('mcode2dsh 需要输入路径（extension 文件或插件包目录）');
      const out = a.flags.out || defaultOutDir(src, 'preset');
      result = mcode2dsh.convert(path.resolve(src), path.resolve(out), { host: !!a.flags.host });
      result.ok = true;
    } else if (cmd === 'list') {
      const side = a.flags.side;
      if (side === 'dsh') result = { ok: true, side, plugins: listDsh() };
      else if (side === 'mcode') result = { ok: true, side, plugins: listMcode() };
      else fail('list 需要 --side dsh|mcode');
    } else if (cmd === 'install') {
      const side = a.flags.side;
      if (side === 'dsh') result = installDsh({ presetId: a.flags['preset-id'] || 'crossplug', force: !!a.flags.force });
      else if (side === 'mcode') result = installMcode({
        extDir: a.flags['ext-dir'] ? path.resolve(a.flags['ext-dir']) : undefined,
        srcDir: a.flags.src ? path.resolve(a.flags.src) : undefined,
        force: !!a.flags.force,
        piSettings: !!a.flags['pi-settings'],
      });
      else if (side === 'dsh-host') {
        if (a.flags.src) result = installDshHostPlugin(path.resolve(a.flags.src), { profile: a.flags.profile, force: !!a.flags.force });
        else result = installDshHost({ profile: a.flags.profile, force: !!a.flags.force });
      }
      else fail('install 需要 --side dsh|mcode|dsh-host');
    } else {
      fail('未知命令: ' + cmd + '\n\n' + usage());
    }

    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(render(result) + '\n');
    }
  } catch (e) {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
      process.exit(1);
    }
    fail(e.message);
  }
}

function render(r) {
  const lines = [];
  if (r.ok === false) return '错误: ' + r.error;
  if (r.plugins !== undefined) {
    lines.push(`【${r.side === 'dsh' ? 'DSH' : 'mcode'}】插件清单（${r.plugins.length}）:`);
    for (const p of r.plugins) lines.push(`  - ${p.id}  (${p.scope})  ${p.dir}`);
    return lines.join('\n');
  }
  if (r.side !== undefined) {
    const label = r.side === 'dsh' ? 'DSH' : r.side === 'dsh-host' ? 'DSH(宿主组合)' : 'mcode';
    lines.push(`✔ 已安装到 ${label}:`);
    for (const f of r.files) lines.push(`  - ${f}`);
    lines.push(`  目录: ${r.target || r.extDir}`);
    if (r.settingsFile) lines.push(`  settings: ${r.settingsFile}`);
    if (r.patchFile) lines.push(`  patch: ${r.patchFile}（${r.patchAction}）`);
    lines.push(`  下一步: ${r.next}`);
    return lines.join('\n');
  }
  lines.push(`✔ 转换完成: ${r.kind}`);
  lines.push(`  来源: ${r.source}`);
  lines.push(`  输出: ${r.out}`);
  if (r.presetName) lines.push(`  名称: ${r.presetName}`);
  if (r.packageName) lines.push(`  包名: ${r.packageName}`);
  if (r.rows !== undefined) lines.push(`  preset 行: ${r.rows}，生成桩工具 ${r.tools} / 命令 ${r.commands}，说明项 ${r.notes}`);
  if (r.tools !== undefined && r.kind === 'mcode-extension') {
    lines.push(`  工具: ${r.tools}，命令: ${r.commands}，事件: ${r.events}，警告: ${r.warnings}`);
  }
  if (r.warnings !== undefined && r.kind !== 'mcode-extension') lines.push(`  警告: ${r.warnings}`);
  if (r.reportFile) lines.push(`  报告: ${r.reportFile}`);
  return lines.join('\n');
}

function usage() {
  return `crossplug — DSH 插件 ↔ mcode（MiniMax Code / pi）插件双向转换

用法:
  node core/run.js dsh2mcode <preset目录|插件源码文件> [--out <dir>]
  node core/run.js mcode2dsh <extension文件|插件包目录> [--out <dir>] [--host]
  node core/run.js list --side dsh|mcode
  node core/run.js install --side dsh|mcode|dsh-host [--force] [--preset-id <id>] [--ext-dir <dir>] [--profile <web|cc-tui|headless>] [--src <host转换产物目录>]
  node core/run.js version

所有命令支持 --json 输出（供插件/脚本调用）。
`;
}

main();
