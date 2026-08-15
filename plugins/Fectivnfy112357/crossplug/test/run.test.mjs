// run.test.mjs — crossplug 转换器自动化测试（随仓库 npm test → node --test 运行）
//
// 覆盖评审要求：
//   1. 输入路径边界（不存在/缺文件/错误形态 → 干净报错，不产生输出）
//   2. 输出覆盖语义（--out 已存在时：同名覆盖，其余文件不受影响）
//   3. symlink / path traversal 安全（不跟随 symlink 复制；插件名净化）
//   4. 生成 manifest / MCP 的可加载性（JSON 可解析、server 语法可检查）
//   5. 失败时不破坏既有目录（转换失败 → 输出目录原样保留）

import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, readdir, stat, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const coreDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core');
const runJs = path.join(coreDir, 'run.js');
const dsh2mcode = require('../core/dsh2mcode.js');
const mcode2dsh = require('../core/mcode2dsh.js');

const PLUGIN_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const SAFE = /^(?!.*(?:--|\.\.)).*$/u;

async function tempWorkspace(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix || 'crossplug-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function cli(t, args, cwd) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [runJs, ...args], { cwd: cwd ?? os.tmpdir() });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function writeFixturePreset(srcDir, { name = 'mini-preset' } = {}) {
  return Promise.all([
    writeFile(path.join(srcDir, 'preset.yml'), `name: ${name}\ndescription: minimal fixture\norder: 90\n`),
    writeFile(path.join(srcDir, 'agent.cordis.yml'), [
      '- id: persona',
      '  name: "@deepseek-ai/dsh-persona"',
      '  config:',
      '    text: |-',
      '      测试 preset 人设',
      '- id: converted-plugin',
      '  name: ./plugins/bridge.js',
      '',
    ].join('\n')),
  ]);
}

const DSH_PLUGIN_SOURCE = [
  "module.exports = {",
  "  name: 'mini-plugin',",
  "  apply(ctx) {",
  "    const tools = ctx.get('tools');",
  "    tools.register({",
  "      name: 'mini_hello',",
  "      description: 'say hello',",
  "      parameters: { type: 'object', properties: {} },",
  "      async execute(args) { return 'hi'; },",
  "    });",
  "  },",
  "};",
  "",
].join('\n');

const PI_EXTENSION = [
  "export default function (pi) {",
  "  pi.registerTool({",
  "    name: 'e2e_ping',",
  "    description: 'e2e ping tool',",
  "    parameters: { type: 'object', properties: {} },",
  "    async execute() { return { content: [{ type: 'text', text: 'pong' }], details: {} }; },",
  "  });",
  "  pi.registerCommand('e2e-hello', {",
  "    description: 'e2e command',",
  "    handler: async (args) => 'hi ' + (args || 'world'),",
  "  });",
  "};",
  "",
].join('\n');

async function nodeCheck(t, file) {
  const r = await execFileAsync(process.execPath, ['--check', file]);
  return r;
}

// 加载生成的 DSH 桥接插件（preset 的 plugins/bridge.js 或 host 的 lib/index.js），
// 用 mock ctx 复刻 DSH cordis 的加载方式（import + 注入 tools/commands + apply），
// 返回注册到的 tools/commands，供执行断言。
async function loadDshBridge(file) {
  const mod = await import(pathToFileURL(file).href);
  const plugin = mod.default;
  const tools = new Map();
  const commands = new Map();
  const ctx = {
    get(name) {
      if (name === 'tools') return { register(spec) { tools.set(spec.name, spec); } };
      if (name === 'commands') return { register(spec) { commands.set(spec.name, spec); } };
      return undefined;
    },
    on() {},
  };
  await plugin.apply(ctx);
  return { tools, commands };
}

// ── 1. 输入路径边界 ──

test('dsh2mcode without input path fails with usage error', async (t) => {
  const ws = await tempWorkspace(t);
  const r = await cli(t, ['dsh2mcode'], ws);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr ?? '', /需要输入路径/u);
});

test('dsh2mcode with nonexistent source fails cleanly', async (t) => {
  const ws = await tempWorkspace(t);
  const out = path.join(ws, 'out');
  const r = await cli(t, ['dsh2mcode', path.join(ws, 'nope'), '--out', out], ws);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr ?? '', /ENOENT|不存在|错误/u);
  // 不产生输出目录
  await assert.rejects(stat(out), /ENOENT/u);
});

test('dsh2mcode preset missing preset.yml fails without touching out dir', async (t) => {
  const ws = await tempWorkspace(t);
  const src = path.join(ws, 'src');
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, 'agent.cordis.yml'), '- id: x\n  name: y\n');
  const out = path.join(ws, 'out');
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'sentinel.txt'), 'keep-me');
  const r = await cli(t, ['dsh2mcode', src, '--out', out], ws);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr ?? '', /preset\.yml 不存在/u);
  // 失败不破坏既有目录
  assert.equal(await readFile(path.join(out, 'sentinel.txt'), 'utf8'), 'keep-me');
});

test('mcode2dsh with nonexistent source fails cleanly', async (t) => {
  const ws = await tempWorkspace(t);
  const r = await cli(t, ['mcode2dsh', path.join(ws, 'nope')], ws);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr ?? '', /ENOENT|错误/u);
});

test('unknown command exits non-zero', async (t) => {
  const ws = await tempWorkspace(t);
  const r = await cli(t, ['frobnicate'], ws);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr ?? '', /未知命令/u);
});

// ── 2. 转换 + 输出覆盖语义 ──

test('dsh2mcode converts a minimal preset; output valid and sentinel preserved', async (t) => {
  const ws = await tempWorkspace(t);
  const src = path.join(ws, 'src');
  await mkdir(path.join(src, 'skills', 'test-skill'), { recursive: true });
  await writeFixturePreset(src);
  await writeFile(path.join(src, 'skills', 'test-skill', 'SKILL.md'),
    '---\nname: test-skill\ndescription: fixture skill\n---\n\n# Skill\n');
  const out = path.join(ws, 'out');
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'sentinel.txt'), 'keep-me');

  const result = dsh2mcode.convert(src, out);
  assert.equal(result.ok ?? true, true);

  const manifest = JSON.parse(await readFile(path.join(out, 'plugin.json'), 'utf8'));
  assert.match(manifest.name, PLUGIN_NAME);
  assert.ok(manifest.$schema.includes('agent-plugins.org'));
  const skillFile = path.join(out, 'skills', 'test-skill', 'SKILL.md');
  assert.match(await readFile(skillFile, 'utf8'), /^name: test-skill/mu);
  assert.ok((await stat(path.join(out, 'CONVERSION-REPORT.md'))).isFile());
  // 不破坏既有文件
  assert.equal(await readFile(path.join(out, 'sentinel.txt'), 'utf8'), 'keep-me');
});

test('dsh2mcode plugin source yields loadable MCP package', async (t) => {
  const ws = await tempWorkspace(t);
  const srcFile = path.join(ws, 'mini-plugin.js');
  await writeFile(srcFile, DSH_PLUGIN_SOURCE);
  const out = path.join(ws, 'out');

  const result = dsh2mcode.convert(srcFile, out);
  assert.ok(result);

  const manifest = JSON.parse(await readFile(path.join(out, 'plugin.json'), 'utf8'));
  assert.match(manifest.name, PLUGIN_NAME);
  assert.ok(manifest.name && SAFE.test(manifest.name));

  const mcp = JSON.parse(await readFile(path.join(out, 'mcp.json'), 'utf8'));
  const servers = Object.values(mcp.mcpServers ?? {});
  assert.ok(servers.length >= 1);
  assert.equal(servers[0].type, 'stdio');
  assert.equal(servers[0].command, 'node');

  // 生成 server 语法可检查
  await nodeCheck(t, path.join(out, 'mcp-server.js'));
  await nodeCheck(t, path.join(out, 'vendor', 'dsh-plugin.cjs'));
});

test('generated MCP server completes initialize, tools/list, and tools/call', async (t) => {
  const ws = await tempWorkspace(t);
  const srcFile = path.join(ws, 'mini-plugin.js');
  await writeFile(srcFile, DSH_PLUGIN_SOURCE);
  const out = path.join(ws, 'out');
  dsh2mcode.convert(srcFile, out);

  const child = spawn(process.execPath, ['mcp-server.js'], {
    cwd: out,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = [];
  lines.on('line', (line) => { try { responses.push(JSON.parse(line)); } catch { /* 忽略非 JSON */ } });

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mini_hello', arguments: {} } }) + '\n');

  await waitFor(() => responses.filter((r) => r.id !== undefined).length >= 3);
  const byId = Object.fromEntries(responses.filter((r) => r.id !== undefined).map((r) => [r.id, r]));
  assert.equal(byId[1].result.serverInfo.name, 'crossplug-mini-plugin');
  assert.equal(byId[2].result.tools[0].name, 'mini_hello');
  assert.equal(byId[3].result.content[0].text, 'hi');

  // 显式收尾：结束 stdin → 杀进程 → 等子进程退出 → 关 readline，
  // 避免 t.after 里 rm(ws) 时子进程仍占用 out/ 文件（Windows 下 EBUSY）。
  child.stdin.end();
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  lines.close();
});

test('plugin name from hostile preset is sanitized', async (t) => {
  const ws = await tempWorkspace(t);
  const src = path.join(ws, 'src');
  await mkdir(src, { recursive: true });
  await writeFixturePreset(src, { name: '../../Evil --Name!' });
  const out = path.join(ws, 'out');
  dsh2mcode.convert(src, out);
  const manifest = JSON.parse(await readFile(path.join(out, 'plugin.json'), 'utf8'));
  assert.match(manifest.name, PLUGIN_NAME);
  assert.ok(SAFE.test(manifest.name));
  assert.ok(!manifest.name.includes('..') && !manifest.name.includes('--'));
});

test('mcode2dsh converts a pi extension into a bridge preset', async (t) => {
  const ws = await tempWorkspace(t);
  const ext = path.join(ws, 'extension.js');
  await writeFile(ext, PI_EXTENSION);
  const out = path.join(ws, 'out');

  const result = mcode2dsh.convert(ext, out);
  assert.ok(result);

  const preset = await readFile(path.join(out, 'preset.yml'), 'utf8');
  assert.match(preset, /name:/u);
  assert.ok((await stat(path.join(out, 'agent.cordis.yml'))).isFile());
  assert.ok((await stat(path.join(out, 'plugins', 'bridge.js'))).isFile());
  assert.ok((await stat(path.join(out, 'CONVERSION-REPORT.md'))).isFile());
});

test('mcode2dsh --host produces lib/index.js with module package.json', async (t) => {
  const ws = await tempWorkspace(t);
  const ext = path.join(ws, 'extension.js');
  await writeFile(ext, PI_EXTENSION);
  const out = path.join(ws, 'out');

  const result = mcode2dsh.convert(ext, out, { host: true });
  assert.ok(result);
  assert.ok((await stat(path.join(out, 'lib', 'index.js'))).isFile());
  const pkg = JSON.parse(await readFile(path.join(out, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'lib/index.js');
});

test('generated DSH host plugin loads and executes the converted tool', async (t) => {
  const ws = await tempWorkspace(t);
  const ext = path.join(ws, 'extension.js');
  await writeFile(ext, PI_EXTENSION);
  const out = path.join(ws, 'out');
  mcode2dsh.convert(ext, out, { host: true });

  const { tools, commands } = await loadDshBridge(path.join(out, 'lib', 'index.js'));
  assert.ok(tools.has('e2e_ping'), 'e2e_ping 工具应注册');
  assert.ok(commands.has('e2e-hello'), 'e2e-hello 命令应注册');

  const result = await tools.get('e2e_ping').execute({}, { callId: undefined, signal: undefined });
  assert.equal(result.content[0].text, 'pong');
});

test('generated DSH preset bridge also loads and executes', async (t) => {
  const ws = await tempWorkspace(t);
  const ext = path.join(ws, 'extension.js');
  await writeFile(ext, PI_EXTENSION);
  const out = path.join(ws, 'out');
  mcode2dsh.convert(ext, out);

  const { tools } = await loadDshBridge(path.join(out, 'plugins', 'bridge.js'));
  assert.ok(tools.has('e2e_ping'));
  const result = await tools.get('e2e_ping').execute({}, { callId: undefined, signal: undefined });
  assert.equal(result.content[0].text, 'pong');
});

test('generated DSH host plugin loads via real @deepseek-ai/cordis DI', async (t) => {
  const cordisEntry = resolveCordis();
  if (!cordisEntry) {
    t.skip('@deepseek-ai/cordis 未找到 — 需在 DSH 环境跑（设 DSH_NODE_MODULES）');
    return;
  }
  const { Context } = await import(pathToFileURL(cordisEntry).href);

  const ws = await tempWorkspace(t);
  const ext = path.join(ws, 'extension.js');
  await writeFile(ext, PI_EXTENSION);
  const out = path.join(ws, 'out');
  mcode2dsh.convert(ext, out, { host: true });

  const plugin = (await import(pathToFileURL(path.join(out, 'lib', 'index.js')).href)).default;
  assert.deepEqual(plugin.inject, ['tools', 'commands']);

  // 真 cordis DI：提供 stub 的 tools/commands 服务，用真 registry 安装插件（校验 inject + 跑 apply）
  const tools = new Map();
  const commands = new Map();
  const ctx = new Context();
  ctx.provide('tools', { register(spec) { tools.set(spec.name, spec); } });
  ctx.provide('commands', { register(spec) { commands.set(spec.name, spec); } });
  await ctx.plugin(plugin, {});

  assert.ok(tools.has('e2e_ping'), '真 cordis 应注册 e2e_ping');
  assert.ok(commands.has('e2e-hello'), '真 cordis 应注册 e2e-hello');
  const result = await tools.get('e2e_ping').execute({}, { callId: undefined, signal: undefined });
  assert.equal(result.content[0].text, 'pong');
});

// ── 3. symlink / path traversal ──

test('dsh2mcode does not follow symlinks out of the source tree', async (t) => {
  const ws = await tempWorkspace(t);
  const outside = path.join(ws, 'outside.txt');
  await writeFile(outside, 'top-secret');
  const src = path.join(ws, 'src');
  await mkdir(path.join(src, 'skills', 'test-skill'), { recursive: true });
  await writeFixturePreset(src);
  await writeFile(path.join(src, 'skills', 'test-skill', 'SKILL.md'), '---\nname: test-skill\ndescription: s\n---\n');
  // 指向树外的 symlink
  try {
    await symlink(outside, path.join(src, 'skills', 'test-skill', 'leak.md'));
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip('symlink creation not permitted on this platform');
      return;
    }
    throw err;
  }
  const out = path.join(ws, 'out');
  dsh2mcode.convert(src, out);
  const entries = await readdir(path.join(out, 'skills', 'test-skill'));
  assert.ok(!entries.includes('leak.md'), 'symlinked file must not be copied');
  assert.equal((await readdir(out)).includes('outside.txt'), false);
});

// ── 5. 失败不破坏既有目录（与 1 中预设缺失用例互补：模块级 + 邻目录） ──

test('module-level failure leaves existing output and neighbor dirs intact', async (t) => {
  const ws = await tempWorkspace(t);
  const badSrc = path.join(ws, 'bad-src');
  await mkdir(badSrc, { recursive: true });
  await writeFile(path.join(badSrc, 'agent.cordis.yml'), '- id: x\n  name: y\n');
  const out = path.join(ws, 'out');
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'sentinel.txt'), 'keep-me');
  const neighbor = path.join(ws, 'neighbor');
  await mkdir(neighbor, { recursive: true });
  await writeFile(path.join(neighbor, 'n.txt'), 'keep-neighbor');

  assert.throws(() => dsh2mcode.convert(badSrc, out), /preset\.yml 不存在/u);

  assert.equal(await readFile(path.join(out, 'sentinel.txt'), 'utf8'), 'keep-me');
  assert.equal((await readdir(out)).includes('plugin.json'), false);
  assert.equal(await readFile(path.join(neighbor, 'n.txt'), 'utf8'), 'keep-neighbor');
});

// ── CLI 冒烟 ──

test('run.js version and list are read-only and exit 0', async (t) => {
  const ws = await tempWorkspace(t);
  const v = await cli(t, ['version'], ws);
  assert.equal(v.code, 0);
  assert.match(v.stdout, /crossplug/u);

  const l = await cli(t, ['list', '--side', 'mcode', '--json'], ws);
  assert.equal(l.code, 0);
  const parsed = JSON.parse(l.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.side, 'mcode');
  assert.ok(Array.isArray(parsed.plugins));
});

// ── 双向真实 e2e：dsh2mcode 产物被真实 mcode 加载 ──
// 需要本机装 mcode（~/.minimax-code/node_modules/@minimax-ai/code/cli.js）；
// CI（无 mcode）自动 skip。设 MCODE_CLI 指向 cli.js、MCODE_NODE 指向 node 可覆盖。

function resolveMcodeCli() {
  const cli = process.env.MCODE_CLI
    || path.join(os.homedir(), '.minimax-code', 'node_modules', '@minimax-ai', 'code', 'cli.js');
  if (!existsSync(cli)) return null;
  const node = process.env.MCODE_NODE || process.execPath;
  return [node, cli];
}

// 解析 @deepseek-ai/cordis（DSH 的 cordis 运行时）入口；找不到返回 null。
// DSH_NODE_MODULES 可覆盖（默认 ~/.dsh/profiles/node_modules）。
function resolveCordis() {
  const base = process.env.DSH_NODE_MODULES
    || path.join(os.homedir(), '.dsh', 'profiles', 'node_modules');
  try {
    const req = createRequire(path.join(base, '__cordis_resolve__.js'));
    return req.resolve('@deepseek-ai/cordis');
  } catch {
    return null;
  }
}

// 杀整个进程树：mcode CLI 会派生常驻 MCP server 子进程（Windows 下孤儿进程
// 会占住插件目录导致 EBUSY），仅杀顶层进程不够。Windows 用 taskkill /T /F
// 连根拔；非 Windows 用负 pid 发信号（需 detached 进程组，失败忽略）。
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* 忽略 */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* 忽略 */ }
  }
}

test('dsh2mcode output is discovered by real mcode (plugin list parses mcp.json)', async (t) => {
  const cmd = resolveMcodeCli();
  if (!cmd) {
    t.skip('mcode cli.js 未找到 — 设 MCODE_CLI 指向 cli.js 可跑真实 mcode 加载 e2e');
    return;
  }
  const ws = await tempWorkspace(t);
  const srcFile = path.join(ws, 'mini-plugin.js');
  await writeFile(srcFile, DSH_PLUGIN_SOURCE);
  const out = path.join(ws, 'out');
  dsh2mcode.convert(srcFile, out);

  // 安装到 ~/.minimax/plugins/ 让 mcode 自己发现（不清理旧目录/临时文件）
  const pluginsDir = path.join(os.homedir(), '.minimax', 'plugins');
  await mkdir(pluginsDir, { recursive: true });
  const dest = path.join(pluginsDir, 'crossplug-e2e-test');
  await cp(out, dest, { recursive: true });

  // mcode plugin list 也会派生常驻 MCP server；用 spawn 拿到顶层 pid，
  // 结束后 killTree 连根杀（Windows 下仅杀顶层会留孤儿进程占住插件目录）。
  const child = spawn(
    cmd[0],
    [...cmd.slice(1), 'plugin', 'list', '--marketplace', 'local', '--json'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  await Promise.race([
    new Promise((r) => child.once('exit', r)),
    new Promise((r) => setTimeout(r, 60000)),
  ]);
  try { child.stdin.end(); } catch { /* 忽略 */ }
  child.kill();
  killTree(child.pid);

  try {
    const parsed = JSON.parse(stdout);
    const ours = (parsed.installed || []).find((p) => p.name === 'mini-plugin');
    assert.ok(ours, 'mcode 应发现转换产物 mini-plugin；stderr: ' + stderr.slice(-400));
    assert.ok((ours.capabilities && ours.capabilities.mcpServerCount) >= 1, 'mcode 应解析出 mcp.json 里的 MCP server');
  } finally {
    // 不删除安装到 ~/.minimax/plugins/ 的临时插件目录（按需手动清理）
  }
});

test('mcode really calls the converted tool (exec returns the tool result)', async (t) => {
  const cmd = resolveMcodeCli();
  if (!cmd) {
    t.skip('mcode cli.js 未找到 — 设 MCODE_CLI 指向 cli.js 可跑真实 mcode 工具调用 e2e');
    return;
  }
  const MARKER = 'CROSSPLUG_E2E_PONG';
  const ws = await tempWorkspace(t);
  const srcFile = path.join(ws, 'mcode-e2e.js');
  await writeFile(srcFile, [
    "module.exports = {",
    "  name: 'mcode-e2e',",
    "  apply(ctx) {",
    "    const tools = ctx.get('tools');",
    "    tools.register({",
    "      name: 'mcode_e2e_ping',",
    "      description: 'e2e ping tool',",
    "      parameters: { type: 'object', properties: {} },",
    "      async execute(args) { return '" + MARKER + "'; },",
    "    });",
    "  },",
    "};",
    "",
  ].join('\n'));
  const out = path.join(ws, 'out');
  dsh2mcode.convert(srcFile, out);

  const pluginsDir = path.join(os.homedir(), '.minimax', 'plugins');
  await mkdir(pluginsDir, { recursive: true });
  const dest = path.join(pluginsDir, 'crossplug-mcode-e2e');
  await cp(out, dest, { recursive: true });

  // 关键：mcode exec 调工具后不干净退出（会留常驻 stdio MCP server），
  // 所以这里 spawn + 读到 MARKER 即判成功 + 显式 kill，而不是等进程退出。
  const child = spawn(
    cmd[0],
    [...cmd.slice(1), 'exec', '请调用工具 mcode_e2e_ping（无参数），把它的返回内容原样输出，不要输出其他内容。', '--permission', 'off', '--timeout', '180s'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  let collected = '';
  let found = false;
  let timer;
  const markerPromise = new Promise((resolve) => {
    const onData = (chunk) => {
      collected += chunk.toString();
      if (collected.includes(MARKER)) {
        found = true;
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });

  // 最多等 120s（LLM + MCP 握手 + 工具调用）；race 结束即 clearTimeout，避免拖住事件循环
  await Promise.race([
    markerPromise,
    new Promise((r) => { timer = setTimeout(r, 120000); }),
  ]);
  clearTimeout(timer);

  try { child.stdin.end(); } catch { /* 忽略 */ }
  child.kill();
  killTree(child.pid); // mcode 派生的 MCP server 子进程一并连根杀，不留孤儿占住插件目录

  // 不删除安装到 ~/.minimax/plugins/ 的临时插件目录（按需手动清理）

  assert.ok(found, 'mcode 应在输出里返回工具结果 ' + MARKER + '；实际输出尾: ' + collected.slice(-400));
});

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for MCP responses');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
// ─────────────────────────────────────────────────────────────
// 回归：codex 审查 14 条问题修复（2026-08-15）

test('extract: 注释内注册不提取、regex literal 不丢调用、顶层属性不被嵌套顶替', async (t) => {
  const extract = require('../core/extract.js');

  // [9] 注释里的 tools.register 不应被提取
  const calls = extract.findCalls('// tools.register({ name: "ghost" })\n', /tools\.register/g);
  assert.equal(calls.length, 0);

  // [4] 工具体含 regex /\\)/ 时调用不丢失
  const src = "tools.register({\n  name: 'rx',\n  execute: async () => { const re = /\\)/; return 'ok'; },\n});\n";
  assert.equal(extract.findCalls(src, /tools\.register/g).length, 1);

  // [11] 嵌套 name 不顶替顶层 name
  const name = extract.propertyValue("{ parameters: { name: 'nested' }, name: 'real' }", 'name', { topLevel: true });
  assert.equal(name.value, 'real');
});

test('dsh2mcode: mcp.json server key 无下划线、多文件插件 sidecar 复制', async (t) => {
  const ws = await tempWorkspace(t);
  const srcDir = path.join(ws, 'src');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, 'multi-tool.js'), [
    "const { fmt } = require('./fmt.js');",
    "module.exports = {",
    "  name: 'multi-tool',",
    "  apply(ctx) {",
    "    const tools = ctx.get('tools');",
    "    tools.register({ name: 't', execute: async () => fmt() });",
    "  },",
    "};",
    "",
  ].join('\n'));
  await writeFile(path.join(srcDir, 'fmt.js'), "module.exports = { fmt() { return 'hi'; } };\n");
  const out = path.join(ws, 'out');
  const result = dsh2mcode.convert(path.join(srcDir, 'multi-tool.js'), out);
  assert.ok(result);

  // [2] server key 必须符合 PLUGIN_NAME（不允许下划线）
  const mcp = JSON.parse(await readFile(path.join(out, 'mcp.json'), 'utf8'));
  for (const key of Object.keys(mcp.mcpServers)) {
    assert.match(key, PLUGIN_NAME, 'mcpServers key 不允许下划线');
  }

  // [6] 相对导入依赖被复制到 vendor/
  assert.ok(existsSync(path.join(out, 'vendor', 'fmt.js')), 'fmt.js 应被复制到 vendor/');
});

test('dsh2mcode: parameters 在 name 前且 schema 含 name 字段时工具不丢/不错名', async (t) => {
  const ws = await tempWorkspace(t);
  const srcFile = path.join(ws, 'ordered.js');
  await writeFile(srcFile, [
    "module.exports = {",
    "  name: 'ordered',",
    "  apply(ctx) {",
    "    const tools = ctx.get('tools');",
    "    tools.register({",
    "      parameters: { type: 'object', properties: { name: { type: 'string' } } },",
    "      name: 'ordered_tool',",
    "      description: 'd',",
    "      execute: async () => 'ok',",
    "    });",
    "  },",
    "};",
    "",
  ].join('\n'));
  const out = path.join(ws, 'out');
  const result = dsh2mcode.convert(srcFile, out);
  assert.ok(result.mcpTools >= 1, '工具不应被丢弃');
  const server = await readFile(path.join(out, 'mcp-server.js'), 'utf8');
  assert.ok(server.includes('ordered_tool'), '工具名应为 ordered_tool 而非嵌套 name');
});

test('mcode2dsh: TS 源剥离后 vendor JS 可加载、CJS 源 host 模式有工具、sidecar 复制', async (t) => {
  const ws = await tempWorkspace(t);

  // [0] TS 源：vendor/*.js 不再残留 TS 语法
  const tsFile = path.join(ws, 'ext.ts');
  await writeFile(tsFile, [
    "import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';",
    "export default function (pi: ExtensionAPI) {",
    "  const s: string = 'x';",
    "  pi.registerTool({ name: 't1', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: s }] }) });",
    "}",
    "",
  ].join('\n'));
  const tsOut = path.join(ws, 'ts-out');
  mcode2dsh.convert(tsFile, tsOut, {});
  await nodeCheck(t, path.join(tsOut, 'vendor', 'ext.js'));

  // [5] CJS 源 host 模式：vendor 用 .cjs，桥接加载有工具
  const cjsFile = path.join(ws, 'cjs-ext.js');
  await writeFile(cjsFile, [
    "module.exports = function (pi) {",
    "  pi.registerTool({ name: 'c1', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });",
    "};",
    "",
  ].join('\n'));
  const cjsOut = path.join(ws, 'cjs-out');
  const cjsResult = mcode2dsh.convert(cjsFile, cjsOut, { host: true });
  assert.ok(cjsResult);
  assert.ok(existsSync(path.join(cjsOut, 'vendor', 'cjs-ext.cjs')), 'CJS 源 vendor 应为 .cjs');
  const { tools } = await loadDshBridge(path.join(cjsOut, 'lib', 'index.js'));
  assert.ok(tools.has('c1'), 'CJS 源转换后工具应可注册');

  // [1] 多文件 extension：相对导入依赖复制到 vendor/
  const pkgDir = path.join(ws, 'pkg');
  await mkdir(pkgDir, { recursive: true });
  await writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'multi', main: 'index.js', type: 'module' }));
  await writeFile(path.join(pkgDir, 'index.js'), [
    "import { helper } from './helper.js';",
    "export default function (pi) { pi.registerTool({ name: 'm', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: helper() }] }) }); }",
    "",
  ].join('\n'));
  await writeFile(path.join(pkgDir, 'helper.js'), "export function helper() { return 'from-helper'; }\n");
  const multiOut = path.join(ws, 'multi-out');
  mcode2dsh.convert(path.join(pkgDir, 'index.js'), multiOut, {});
  assert.ok(existsSync(path.join(multiOut, 'vendor', 'helper.js')), 'helper.js 应被复制到 vendor/');
  const { tools: mt } = await loadDshBridge(path.join(multiOut, 'plugins', 'bridge.js'));
  assert.ok(mt.has('m'), '多文件 extension 转换后工具应可注册');
});

test('dsh2mcode: async apply 完成前 tools/call 等待注册（不丢请求）', async (t) => {
  const ws = await tempWorkspace(t);
  const srcFile = path.join(ws, 'slow.js');
  await writeFile(srcFile, [
    "module.exports = {",
    "  name: 'slow',",
    "  async apply(ctx) {",
    "    await new Promise((r) => setTimeout(r, 600));",
    "    const tools = ctx.get('tools');",
    "    tools.register({ name: 'slow_ping', execute: async () => 'slow-ok' });",
    "  },",
    "};",
    "",
  ].join('\n'));
  const out = path.join(ws, 'out');
  dsh2mcode.convert(srcFile, out);

  const child = spawn(process.execPath, ['mcp-server.js'], { cwd: out, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = [];
  lines.on('line', (line) => { try { responses.push(JSON.parse(line)); } catch { /* 忽略 */ } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  // 立即（apply 未完成时）调用工具
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow_ping', arguments: {} } }) + '\n');
  await waitFor(() => responses.some((r) => r.id === 2));
  const call = responses.find((r) => r.id === 2);
  assert.equal(call.result.content[0].text, 'slow-ok', 'async apply 期间到达的调用应等注册完成后成功');
  child.stdin.end();
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  lines.close();
});

test('dsh2mcode provider: default 形态可启动、有 package.json、server key 合法', async (t) => {
  const ws = await tempWorkspace(t);
  const srcFile = path.join(ws, 'provider.js');
  await writeFile(srcFile, [
    "export default {",
    "  async apply(ctx) {",
    "    ctx.web.registerSearchProvider({ name: 'sx', async search(query, signal) { return { sources: [] }; } });",
    "  },",
    "};",
    "",
  ].join('\n'));
  const out = path.join(ws, 'out');
  const result = dsh2mcode.convert(srcFile, out);
  assert.ok(result);

  // [8] 输出包有 package.json 且 type: module（mcp-server.js 是 ESM）
  const pkg = JSON.parse(await readFile(path.join(out, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');

  // [7] default 形态也能通过语法检查，且不再静态 named import apply
  await nodeCheck(t, path.join(out, 'mcp-server.js'));
  const server = await readFile(path.join(out, 'mcp-server.js'), 'utf8');
  assert.ok(!server.includes('import { apply }'), '不应再静态 named import apply');

  // [2] provider server key 无下划线
  const mcp = JSON.parse(await readFile(path.join(out, 'mcp.json'), 'utf8'));
  for (const key of Object.keys(mcp.mcpServers)) assert.match(key, PLUGIN_NAME);
});

test('dsh2mcode provider: 调用参数透传到 provider.search', async (t) => {
  const ws = await tempWorkspace(t);
  const srcFile = path.join(ws, 'provider.js');
  await writeFile(srcFile, [
    "export async function apply(ctx) {",
    "  ctx.web.registerSearchProvider({",
    "    name: 'sx',",
    "    async search(query, signal) {",
    "      process.stdout.write('SEEN=' + JSON.stringify(query) + '\\n');",
    "      return { sources: [{ title: 'x', url: 'https://x', snippet: 'y' }] };",
    "    },",
    "  });",
    "}",
    "",
  ].join('\n'));
  const out = path.join(ws, 'out');
  dsh2mcode.convert(srcFile, out);

  const child = spawn(process.execPath, ['mcp-server.js'], { cwd: out, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', (d) => chunks.push(d.toString()));
  child.stderr.on('data', (d) => chunks.push(d.toString()));
  await new Promise((r) => setTimeout(r, 200));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'provider_search', arguments: { query: 'hello', maxResults: 5 } } }) + '\n');
  await new Promise((r) => setTimeout(r, 600));
  try { child.stdin.end(); } catch { /* 忽略 */ }
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));

  const all = chunks.join('');
  assert.match(all, /SEEN=\{"query":"hello","maxResults":5\}/, 'maxResults 应透传给 provider.search');
});
