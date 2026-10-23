import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The Plugin lives either under plugins/<owner>/<name>/ (the hosted layout of
// the community repository) or at the repository root (a standalone Plugin
// repository that the local marketplace can install directly). Detect both so
// one test file can guard either layout.
const hostedRoot = path.join(repositoryRoot, 'plugins', 'antianqi', 'jianying');
const pluginRoot = existsSync(path.join(hostedRoot, 'plugin.json')) ? hostedRoot : repositoryRoot;
const read = (relative) => readFile(path.join(pluginRoot, relative), 'utf8');
const exists = async (relative) => {
  try { await stat(path.join(pluginRoot, relative)); return true; } catch { return false; }
};

// ★ Skill 名单【动态扫描】，不硬编码
//   （硬编码过一次：新增 jianying-pipeline 时两个用例直接红了 ——
//     "新增 skill 要改两处"本身就是缺陷 ⇒ 改成扫目录，此后新增 skill 不用改测试）
const skillNames = async () => {
  const entries = await readdir(path.join(pluginRoot, 'skills'), { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
};
// ★ manifest 里的路径 "./skills/<dir>/SKILL.md" ⇒ 归一到目录名（这个归一化错过两次，单独一个函数）
const skillDirFromPath = (p) => String(p)
  .replace(/^\.\//, '')
  .replace(/\/SKILL\.md$/, '')
  .replace(/^skills\//, '');

const frontmatter = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(m, 'SKILL.md must start with a frontmatter block');
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
};

test('both runtime layouts ship and agree on the Plugin identity', async () => {
  const portable = JSON.parse(await read('plugin.json'));
  const v04 = JSON.parse(await read('.claude-plugin/plugin.json'));

  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(portable.name, 'jianying');
  assert.equal(portable.license, 'Apache-2.0');
  assert.equal(v04.name, 'jianying');
  assert.equal(v04.license, 'Apache-2.0');
});

test('v0.4 manifest lists every Skill at a path that resolves and whose frontmatter name matches its directory', async () => {
  const v04 = JSON.parse(await read('.claude-plugin/plugin.json'));
  assert.ok(Array.isArray(v04.skills), 'skills must be an array of paths');
  // ★ manifest 列的必须与磁盘上的 skill 目录一一对应（不硬编码名单）
  const dirs = await skillNames();
  const listed = v04.skills.map(skillDirFromPath).sort();
  assert.deepEqual(listed, dirs, 'manifest skills[] must match the skills/ directories exactly');

  for (const relative of v04.skills) {
    // A path into a subdirectory whose name does not match the frontmatter
    // name is silently dropped by the runtime: the Plugin loads, with no
    // diagnostic. Assert both halves so that trap cannot reach upstream.
    assert.ok(relative.startsWith('./'), `${relative} must start with "./"`);
    const file = relative.replace(/^\.\//, '');
    assert.ok(await exists(file), `${relative} does not exist`);

    const dir = path.basename(path.dirname(file));
    const fm = frontmatter(await read(file));
    assert.equal(fm.name, dir, `${file}: frontmatter name must equal its directory name`);
    assert.ok(fm.description, `${file}: description is required`);
    assert.ok(fm.description.length <= 1024, `${file}: description is ${fm.description.length} chars (limit 1024)`);
  }
});

test('portable layout exposes the same Skills under skills/<name>/SKILL.md', async () => {
  const entries = await readdir(path.join(pluginRoot, 'skills'), { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.ok(dirs.length > 0, 'there must be at least one Skill');
  for (const name of dirs) {
    const fm = frontmatter(await read(path.join('skills', name, 'SKILL.md')));
    assert.equal(fm.name, name);
  }
});

test('MCP declaration uses the stdio transport with a contained working directory', async () => {
  for (const file of ['mcp.json', '.claude-plugin/plugin.json']) {
    const manifest = JSON.parse(await read(file));
    const server = manifest.mcpServers?.jianying;
    assert.ok(server, `${file}: mcpServers.jianying is required`);
    assert.equal(server.type, 'stdio', `${file}: only stdio is used by this Plugin`);
    assert.equal(server.command, 'node');
    assert.ok(Array.isArray(server.args) && server.args.length === 1);
    // The compatibility contract allows a relative "./" path or a
    // ${PLUGIN_ROOT}/${PLUGIN_DATA} path. Anything else breaks when the
    // Plugin is installed at a different location.
    assert.match(server.cwd, /^\.\/|^\$\{PLUGIN_(ROOT|DATA)\}/u, `${file}: cwd must be portable`);
    assert.ok(await exists(server.args[0].replace(/^\.\//, '')), `${file}: server entry point missing`);
  }
});

test('every verb ships a parsable input schema', async () => {
  const files = (await readdir(path.join(pluginRoot, 'mcp', 'tools'))).filter((f) => f.endsWith('.schema.json'));
  // 9 = draft_open/draft_read/draft_patch/draft_commit/render_frames/grade_apply/audio_mix/verify_diff/make_film
  assert.equal(files.length, 9, `expected 9 verb schemas, found ${files.length}`);
  for (const file of files) {
    const schema = JSON.parse(await read(path.join('mcp', 'tools', file)));
    assert.equal(schema.inputSchema.type, 'object', `${file}: inputSchema must be an object`);
  }
});

test('runnable script invocations in the Skills are anchored to ${PLUGIN_ROOT}', async () => {
  for (const name of await skillNames()) {
    const text = await read(path.join('skills', name, 'SKILL.md'));
    for (const line of text.split(/\r?\n/)) {
      if (!/node\s+\S*scripts\//u.test(line)) continue;
      assert.match(line, /\$\{PLUGIN_ROOT\}/u,
        `skills/${name}/SKILL.md: script invocation must use \${PLUGIN_ROOT}: ${line.trim()}`);
    }
  }
});

test('referenced scripts and references exist', async () => {
  for (const name of await skillNames()) {
    const text = await read(path.join('skills', name, 'SKILL.md'));
    for (const m of text.matchAll(/\$\{PLUGIN_ROOT\}\/(scripts|references)\/([A-Za-z0-9._-]+)/gu)) {
      assert.ok(await exists(`${m[1]}/${m[2]}`), `skills/${name}/SKILL.md references missing ${m[1]}/${m[2]}`);
    }
  }
});

test('the Plugin declares no network client, no credential handling and no telemetry', async () => {
  for (const file of ['mcp/server.mjs', 'scripts/run-verb.mjs', 'scripts/check-env.mjs',
    'scripts/selftest-mcp.mjs', 'scripts/selftest-draft-edit.mjs', 'scripts/selftest-talk-cut.mjs',
    'scripts/talk-cut-plan.mjs', 'scripts/talk-cut-apply.mjs']) {
    const text = await read(file);
    assert.ok(!/\bfetch\s*\(/u.test(text), `${file}: must not make HTTP requests`);
    assert.ok(!/https?:\/\//u.test(text), `${file}: must not embed a network endpoint`);
    assert.ok(!/\b(api[_-]?key|secret|password|token)\b\s*[:=]\s*['"][^'"]{8,}/iu.test(text),
      `${file}: must not embed a credential literal`);
  }
  // The only socket the Plugin opens is the local Windows named pipe of a
  // running Jianying instance. A TCP target would be a network client.
  const server = await read('mcp/server.mjs');
  for (const m of server.matchAll(/net\.connect\(([^)]*)\)/gu)) {
    assert.ok(/PREFIX|PIPE|pipe/u.test(m[1]), `mcp/server.mjs: net.connect target must be the local named pipe: ${m[1]}`);
  }
});

test('the Plugin does not hardcode a contributor machine path', async () => {
  for (const file of ['mcp/server.mjs', 'scripts/run-verb.mjs', 'scripts/check-env.mjs',
    'scripts/selftest-mcp.mjs', 'scripts/selftest-draft-edit.mjs', 'scripts/selftest-talk-cut.mjs',
    'scripts/talk-cut-plan.mjs', 'scripts/talk-cut-apply.mjs']) {
    const text = await read(file);
    assert.ok(!/[A-Za-z]:\\Users\\/u.test(text), `${file}: must not hardcode a user profile path`);
    assert.ok(!/D:\\/u.test(text), `${file}: must not hardcode a drive letter path`);
    assert.ok(!/\/Users\/|\/home\//u.test(text), `${file}: must not hardcode a POSIX home path`);
  }
});

test('the README discloses the platform, the example prompt, the expected result and the data behaviour', async () => {
  const readme = await read('README.md');
  assert.match(readme, /Windows/u, 'supported platform must be disclosed');
  assert.match(readme, /示例提示词/u, 'README must carry a copyable example prompt');
  assert.match(readme, /预期结果/u, 'README must state the expected result');
  assert.match(readme, /无网络访问/u, 'README must disclose network behaviour');
  assert.match(readme, /不需要凭据/u, 'README must disclose credential behaviour');
  assert.match(readme, /无遥测/u, 'README must disclose telemetry behaviour');
  assert.match(readme, /无第三方服务/u, 'README must disclose third-party service behaviour');
  assert.match(readme, /不需要任何账号/u, 'README must disclose account and paid-service requirements');
});


// ★★★ 会话状态不得越界（PR #72 review 的合并阻塞项：sessionId 路径穿越）
//   server.mjs 原来把 sessionId 原样拼进状态文件名 ⇒ "x/../../canary" 经 path.join
//   归一化后落到 PLUGIN_DATA 之外 ⇒ draft_read 读出任意本地 JSON、draft_patch 往那里写。
//   这里跑插件自带的探针：9 种恶意 sessionId × 3 个动词 + 写路径检查 + 阳性对照。
test('session state cannot read or write outside PLUGIN_DATA', async () => {
  const mod = await import(pathToFileURL(path.join(pluginRoot, 'scripts', 'security-probe.mjs')).href);
  const r = await mod.runSecurityProbe();
  const failed = r.cases.filter((c) => !c.ok);
  assert.equal(failed.length, 0,
    'session-state containment failures:\n'
    + failed.map((f) => `  - ${f.name}: ${f.detail}`).join('\n'));
  // ★ 探针本身要有区分力：必须覆盖足够的形态（9 种恶意 × 3 动词 + 写路径 + 阳性对照）
  assert.ok(r.total >= 30, `expected at least 30 containment checks, got ${r.total}`);
});
