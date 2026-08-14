// install.js — 把转换器适配器安装到 DSH 或 mcode（零依赖）

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.join(REPO_ROOT, 'adapters');
const CORE_DIR = __dirname;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
function minimaxHome() {
  return path.join(os.homedir(), '.minimax');
}
function piHome() {
  return path.join(os.homedir(), '.pi');
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

// ── 安装到 DSH：~/.dsh/.agent-presets/<presetId>/ ──

function installDsh(opts = {}) {
  const presetId = opts.presetId || 'crossplug';
  const target = path.join(dshHome(), '.agent-presets', presetId);
  if (fs.existsSync(target) && !opts.force) {
    throw new Error(`目标已存在（使用 --force 覆盖）: ${target}`);
  }
  const srcPreset = path.join(ADAPTERS_DIR, 'dsh');
  if (!fs.existsSync(path.join(srcPreset, 'preset.yml'))) {
    throw new Error(`适配器缺失: ${path.join(srcPreset, 'preset.yml')}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  copyDir(srcPreset, target);
  copyDir(CORE_DIR, path.join(target, 'core'));
  return {
    ok: true,
    side: 'dsh',
    presetId,
    target,
    files: ['preset.yml', 'agent.cordis.yml', 'plugins/convert.js', 'core/'],
    next: '重启 DSH 会话或在启动器中选择该 preset；或在本会话中直接使用转换工具。',
  };
}

// ── 安装到 mcode：agent-plugins 插件（~/.minimax/plugins/crossplug/）+ pi extension ──
//
// 两种入口：
//   A) 不传 srcDir：把 adapters/mcode/ 装为 crossplug 自身（默认）
//   B) 传 srcDir：把 dsh2mcode 转换产物（已是 agent-plugins 1.0.0 格式）整目录装到
//      ~/.minimax/plugins/<name>/，name 从 srcDir/plugin.json 读

function readPluginNameFromDir(srcDir) {
  const pj = path.join(srcDir, 'plugin.json');
  if (!fs.existsSync(pj)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(pj, 'utf8'));
    return obj && typeof obj.name === 'string' ? obj.name : null;
  } catch { return null; }
}

function installMcode(opts = {}) {
  const srcDir = opts.srcDir; // 转换产物目录（新）
  const isFromConvert = !!(srcDir && fs.existsSync(srcDir));
  const extName = opts.extName || (isFromConvert ? (readPluginNameFromDir(srcDir) || 'converted-plugin') : 'crossplug');
  const srcExt = isFromConvert ? srcDir : path.join(ADAPTERS_DIR, 'mcode');
  // extension.js 仅对 crossplug 自身适配器必需；转换产物（含社区结构包：
  // plugin.json + README + LICENSE + skills/，无 extension.js）允许缺失，pi 端安装自动跳过。
  if (!isFromConvert && !fs.existsSync(path.join(srcExt, 'extension.js'))) {
    throw new Error(`适配器缺失: ${path.join(srcExt, 'extension.js')}`);
  }
  const installed = [];

  // 1) agent-plugins 格式插件（MCode /plugins 的 Local 标签页可见，可安装/启用）
  const pluginDir = opts.pluginDir || path.join(minimaxHome(), 'plugins', extName);
  if (fs.existsSync(pluginDir) && !opts.force) {
    throw new Error(`MCode 插件目录已存在（使用 --force 覆盖）: ${pluginDir}`);
  }
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(pluginDir, { recursive: true });
  if (isFromConvert) {
    // 转换产物整目录复制（plugin.json / mcp.json / mcp-server.js / skills/ / vendor/ 都带上）
    copyDir(srcExt, pluginDir);
    // core/ 不是 mcp 运行时需要的，转换产物里通常没有，无需额外补
  } else {
    // 老路径：adapters/mcode/ → crossplug 自身
    for (const f of ['plugin.json', 'extension.js']) {
      const s = path.join(srcExt, f);
      if (fs.existsSync(s)) fs.copyFileSync(s, path.join(pluginDir, f));
    }
    copyDir(path.join(srcExt, 'skills'), path.join(pluginDir, 'skills'));
    copyDir(CORE_DIR, path.join(pluginDir, 'core'));
  }
  installed.push(`插件包: ${pluginDir}（/plugins → Local 可见）`);

  // 2) pi extension
  //    - 非 srcDir 路径：装 crossplug 自身到 pi（老行为）
  //    - srcDir 路径：转换产物的 extension.js 含事件桥接（如 before_agent_start），
  //      自动注入系统提示词的能力靠 pi 端跑出来；这里也把 extension.js 装到 pi 端 + 写入 settings.json
  let extDir = null;
  if (!isFromConvert) {
    extDir = opts.extDir || path.join(piHome(), 'agent', 'extensions', extName);
    fs.mkdirSync(path.dirname(extDir), { recursive: true });
    if (fs.existsSync(extDir) && !opts.force) {
      throw new Error(`pi 扩展目录已存在（使用 --force 覆盖）: ${extDir}`);
    }
    fs.rmSync(extDir, { recursive: true, force: true });
    copyDir(srcExt, extDir);
    copyDir(CORE_DIR, path.join(extDir, 'core'));
    fs.rmSync(path.join(extDir, 'plugin.json'), { force: true }); // pi 侧不需要 manifest
    fs.rmSync(path.join(extDir, 'skills'), { recursive: true, force: true });
    installed.push(`pi extension: ${extDir}`);
  } else {
    // srcDir 路径：装到 ~/.pi/agent/extensions/<name>/（只放 extension.js + vendor/，不需要 plugin.json / mcp.json / skills/）
    const srcExtJs = path.join(srcExt, 'extension.js');
    if (fs.existsSync(srcExtJs)) {
      extDir = opts.extDir || path.join(piHome(), 'agent', 'extensions', extName);
      fs.mkdirSync(path.dirname(extDir), { recursive: true });
      if (fs.existsSync(extDir) && !opts.force) {
        // 已经在；保留现有，跳过
        installed.push(`pi extension: 已存在 ${extDir}（保留；想重装用 --force）`);
      } else {
        fs.rmSync(extDir, { recursive: true, force: true });
        fs.mkdirSync(extDir, { recursive: true });
        // extension.js 自身
        fs.copyFileSync(srcExtJs, path.join(extDir, 'extension.js'));
        // vendor/（被 extension.js import）
        const srcVendor = path.join(srcExt, 'vendor');
        if (fs.existsSync(srcVendor)) {
          copyDir(srcVendor, path.join(extDir, 'vendor'));
        }
        // typebox-shim.js（被 extension.js import）
        const srcTypebox = path.join(srcExt, 'typebox-shim.js');
        if (fs.existsSync(srcTypebox)) {
          fs.copyFileSync(srcTypebox, path.join(extDir, 'typebox-shim.js'));
        }
        installed.push(`pi extension: ${extDir}（含 before_agent_start 等事件桥接）`);
      }
    } else {
      installed.push(`pi extension: 转换产物无 extension.js，跳过 pi 端安装`);
    }
  }

  // ⚠️ 2026-08-15 实证更正（mcode-plugin-spec.md §1.1/§2.1）：mcode CLI 不加载 pi extension，
  // ~/.minimax/settings.json 的 extensions 数组是死配置（cli.js 无消费逻辑）。
  // 不再默认写入；仅当显式 --pi-settings 时写入（目标运行时是独立 pi CLI 的场景）。
  const mmSettings = path.join(minimaxHome(), 'settings.json');
  if (extDir && opts.piSettings) {
    let settings = {};
    if (fs.existsSync(mmSettings)) {
      try { settings = JSON.parse(fs.readFileSync(mmSettings, 'utf8')); } catch { settings = {}; }
    }
    const extFile = path.join(extDir, 'extension.js');
    const extList = Array.isArray(settings.extensions) ? settings.extensions : [];
    if (!extList.includes(extFile)) extList.push(extFile);
    settings.extensions = extList;
    fs.mkdirSync(minimaxHome(), { recursive: true });
    fs.writeFileSync(mmSettings, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    installed.push(`settings: ${mmSettings}（--pi-settings 显式开启；mcode CLI 不消费此数组）`);
  } else if (extDir) {
    installed.push(`pi extension 已装到 ${extDir}（仅独立 pi CLI 生效；mcode CLI 不加载 pi extension，2026-08-15 实证）`);
  }

  return {
    ok: true,
    side: 'mcode',
    extName,
    extDir,
    pluginDir,
    srcDir: isFromConvert ? srcDir : undefined,
    settingsFile: extDir ? mmSettings : undefined,
    files: installed,
    next: isFromConvert
      ? `在 MiniMax Code 中运行 \`mcode plugin enable ${extName}@local\`（或 /plugins UI）即可使用`
      : '在 MiniMax Code 中打开 /plugins → Local 标签页，安装 crossplug 插件（Enter），Ctrl+R 刷新；pi 侧命令 /convert-dsh 与 /convert-mcode 需重启或 /reload。',
  };
}

// ── 安装到 DSH 宿主组合：~/.dsh/profiles/<profile>/plugins/dsh-crossplug/ ──
//
// 与 installDsh（装 agent preset）不同，这是把转换桥作为**宿主组合插件**
// 安装：插件随 DSH 进程启动常驻，所有会话可用，不依赖预设。
// 安装源：adapters/dsh-host/（lib/index.js + package.json + README.md）
//          + 项目 core/（转换引擎）→ 目标 plugins/dsh-crossplug/。
// 挂载：在 profile 的 cordis.patch.yml 追加 insert 行（幂等）。

const HOST_PLUGIN_ID = 'dsh-crossplug';
const HOST_PATCH_BLOCK =
  '\n' +
  '# ── DSH ↔ mcode 插件转换桥 (dsh-crossplug) ─────────────────────────────────\n' +
  '# 宿主组合插件：convert_plugin / convert_list 工具常驻，所有会话可用，\n' +
  '# 不依赖任何 agent preset。由 crossplug 项目安装：node core/run.js install --side dsh-host\n' +
  '- insert:\n' +
  '    - id: dsh-crossplug\n' +
  "      name: './plugins/dsh-crossplug/lib/index.js'\n";

function installDshHost(opts = {}) {
  const profile = opts.profile || 'web';
  const profileDir = path.join(dshHome(), 'profiles', profile);
  if (!fs.existsSync(profileDir)) {
    throw new Error(`DSH profile 不存在: ${profileDir}（可选 --profile <web|cc-tui|headless>）`);
  }
  const src = path.join(ADAPTERS_DIR, 'dsh-host');
  if (!fs.existsSync(path.join(src, 'lib', 'index.js'))) {
    throw new Error(`宿主插件适配器缺失: ${path.join(src, 'lib', 'index.js')}`);
  }
  const target = path.join(profileDir, 'plugins', HOST_PLUGIN_ID);
  if (fs.existsSync(target) && !opts.force) {
    throw new Error(`目标已存在（使用 --force 覆盖）: ${target}`);
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const f of ['package.json', 'README.md']) {
    const s = path.join(src, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(target, f));
  }
  copyDir(path.join(src, 'lib'), path.join(target, 'lib'));
  copyDir(CORE_DIR, path.join(target, 'core'));
  // 插件主体是 ESM（"type": "module"），core/ 是 CommonJS：就近声明隔离。
  fs.writeFileSync(
    path.join(target, 'core', 'package.json'),
    '{\n  "name": "dsh-crossplug-core",\n  "private": true,\n  "type": "commonjs"\n}\n',
    'utf8',
  );

  // patch 层：追加挂载行（幂等）
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  let patchText = '';
  if (fs.existsSync(patchFile)) patchText = fs.readFileSync(patchFile, 'utf8');
  let patchAction = 'already-present';
  if (!patchText.includes(HOST_PLUGIN_ID)) {
    const header = patchText.length > 0 && !patchText.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(patchFile, header + HOST_PATCH_BLOCK, 'utf8');
    patchAction = 'appended';
  }

  return {
    ok: true,
    side: 'dsh-host',
    profile,
    target,
    patchFile,
    patchAction,
    files: ['package.json', 'lib/index.js', 'core/', 'core/package.json', 'README.md'],
    next: '重启 DSH 进程后生效：所有会话获得 convert_plugin / convert_list 工具（插件列表可见 dsh-crossplug）。',
  };
}

// 把插件包内的 skills/ 注册为 MiniMax Code 用户技能（~/.minimax/skills/<name>/），
// 使 /技能名 作为斜杠命令可用（MCode 会把 skill 命令作为消息交给 agent 执行）。
function registerPluginSkills(pluginDir) {
  const skillsSrc = path.join(pluginDir, 'skills');
  if (!fs.existsSync(skillsSrc)) return { registered: [], skipped: [] };
  const userSkills = path.join(minimaxHome(), 'skills');
  fs.mkdirSync(userSkills, { recursive: true });
  const registered = [];
  const skipped = [];
  for (const child of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const name = String(child.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || child.name;
    const target = path.join(userSkills, name);
    if (fs.existsSync(target)) {
      skipped.push(name);
      continue;
    }
    copyDir(path.join(skillsSrc, child.name), target);
    registered.push(name);
  }
  return { registered, skipped };
}

// ── 安装转换产物（host 模式）为 DSH 宿主组合插件 ──
// srcDir 是 mcode2dsh --host 的输出（lib/index.js + vendor/ + package.json）。
function installDshHostPlugin(srcDir, opts = {}) {
  const profile = opts.profile || 'web';
  const profileDir = path.join(dshHome(), 'profiles', profile);
  if (!fs.existsSync(profileDir)) {
    throw new Error(`DSH profile 不存在: ${profileDir}（可选 --profile <web|cc-tui|headless>）`);
  }
  const entry = path.join(srcDir, 'lib', 'index.js');
  if (!fs.existsSync(entry)) {
    throw new Error(`srcDir 不是 host 模式转换产物（缺 lib/index.js）: ${srcDir}（请用 node core/run.js mcode2dsh <src> --out <dir> --host）`);
  }
  // 插件名：package.json 的 name（转换器已写为 presetId）
  let name = path.basename(srcDir);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'));
    if (pkg && typeof pkg.name === 'string' && pkg.name.trim()) name = pkg.name.trim();
  } catch { /* 忽略 */ }
  const target = path.join(profileDir, 'plugins', name);
  if (fs.existsSync(target) && !opts.force) {
    throw new Error(`目标已存在（使用 --force 覆盖）: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  copyDir(srcDir, target);
  // core/ 的 CJS 隔离不需要（转换产物 lib/vendor 均为 ESM）

  // patch 层：追加 insert 行（幂等）
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  let patchText = '';
  if (fs.existsSync(patchFile)) patchText = fs.readFileSync(patchFile, 'utf8');
  let patchAction = 'already-present';
  const block =
    '\n' +
    '# ── mcode 转换插件: ' + name + ' (crossplug mcode2dsh --host) ─────────────────────\n' +
    '# 宿主组合插件：所有会话可用，不依赖 agent preset。\n' +
    '- insert:\n' +
    '    - id: ' + name + '\n' +
    "      name: './plugins/" + name + "/lib/index.js'\n";
  if (!patchText.includes("id: " + name)) {
    const header = patchText.length > 0 && !patchText.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(patchFile, header + block, 'utf8');
    patchAction = 'appended';
  }
  return {
    ok: true,
    side: 'dsh-host',
    profile,
    pluginName: name,
    target,
    patchFile,
    patchAction,
    files: ['lib/index.js', 'vendor/', 'package.json', 'README.md'],
    next: '重启 DSH 进程后生效：所有会话获得该插件的工具/命令（' + name + '）。',
  };
}

module.exports = { installDsh, installDshHost, installDshHostPlugin, installMcode, registerPluginSkills, dshHome, minimaxHome, piHome };
