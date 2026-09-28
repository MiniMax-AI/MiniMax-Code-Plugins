// tests/plugins/mcode-trajectory-studio/smoke.test.mjs
//
// Self-audit for the mcode-trajectory-studio Plugin. Static, read-only checks
// over the shipped package, plus negative injection so the audit cannot pass by
// accident. Run by `npm test`.
//
// The expected shape is the one the repository has already merged for every other
// Plugin, not the separate Marketplace-submission layout:
//
//   plugin.json              portable registry manifest (every merged Plugin has it)
//   mcp.json                 the only MCP descriptor merged Plugins use
//   .claude-plugin/plugin.json   mcode 0.4.0+ layout; declares the Skill path and the MCP server
//   skills/<name>/SKILL.md   exactly one Skill, under a directory named for it
//   README.md + LICENSE      required by the repository validator
//
// The schema URLs are imported from the validator so this file and CI agree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { PLUGIN_SCHEMA, MCP_SCHEMA } from '../../../scripts/lib/validation.mjs';

const REPO = process.cwd();
const PLUGIN = join(REPO, 'plugins', 'weekbin', 'mcode-trajectory-studio');
const NAME = 'mcode-trajectory-studio';
const PLUGIN_JSON = join(PLUGIN, 'plugin.json');
const CLAUDE_JSON = join(PLUGIN, '.claude-plugin', 'plugin.json');
const MCP_JSON = join(PLUGIN, 'mcp.json');
const README = join(PLUGIN, 'README.md');
const README_ZH = join(PLUGIN, 'README.zh-CN.md');
const LICENSE = join(PLUGIN, 'LICENSE');
const SKILL = join(PLUGIN, 'skills', NAME, 'SKILL.md');

const PLUGIN_FIELDS = new Set([
  '$schema', 'name', 'version', 'description', 'author', 'homepage',
  'repository', 'license', 'keywords', 'extensions',
]);
const MCP_ROOT_FIELDS = new Set(['$schema', 'mcpServers']);
const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd']);

/** Fields that belong to the separate submission layout, not to this repository. */
const SUBMISSION_ONLY = [
  'schemaVersion', 'displayName', 'icon', 'category',
  'exampleQueries', 'apps', 'mcpServers', 'skills',
];

const MARKDOWN_TOKENS = ['**', '`', '__', '##', ']('];
const isHttps = (v) => typeof v === 'string' && v.startsWith('https://');
const hasMarkdown = (v) => typeof v === 'string' && MARKDOWN_TOKENS.some((t) => v.includes(t));
const isBareCommand = (v) => typeof v === 'string' && v.length > 0 && !/[\\/]/.test(v);

// The Plugin is published from the official repository, so its manifests must
// advertise where it will actually live. Pointing them at a personal fork is the
// mistake this pins: the copy in the fork will not be the copy users install.
const CANONICAL_REPO = 'https://github.com/MiniMax-AI/MiniMax-Code-Plugins.git';
const CANONICAL_HOMEPAGE = `https://github.com/MiniMax-AI/MiniMax-Code-Plugins/tree/main/plugins/weekbin/${NAME}`;

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }
function readText(p) { return readFileSync(p, 'utf8'); }
function resolves(rel) { return existsSync(join(PLUGIN, rel.replace(/^\.\//, ''))); }

function collectFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checkers. Each returns [] when conformant, so the same function powers the
// positive test and the negative injection.
// ---------------------------------------------------------------------------

function auditPluginJson(m) {
  const problems = [];
  const note = (cond, message) => { if (!cond) problems.push(message); };
  for (const key of Object.keys(m)) {
    note(PLUGIN_FIELDS.has(key), `unknown root field: ${key}`);
  }
  for (const f of SUBMISSION_ONLY) {
    note(m[f] === undefined, `${f} belongs to the submission layout, not plugin.json`);
  }
  note(m.$schema === PLUGIN_SCHEMA, `$schema must be ${PLUGIN_SCHEMA} (got ${m.$schema})`);
  note(m.name === NAME, `name must be ${NAME} (got ${m.name})`);
  note(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(m.name ?? ''), `invalid name: ${m.name}`);
  note(/^\d+\.\d+\.\d+$/.test(m.version ?? ''), `version must be SemVer (got ${m.version})`);
  note(typeof m.description === 'string' && m.description.length > 0 && m.description.length <= 1024,
    `description must be 1..1024 characters (got ${m.description?.length})`);
  note(!hasMarkdown(m.description), 'description must be plain text, not markdown');
  note(m.author && typeof m.author.name === 'string' && m.author.name.length > 0, 'author.name is required');
  note(m.author && isHttps(m.author.url), 'author.url must be https');
  note(m.homepage === CANONICAL_HOMEPAGE, `homepage must point at this Plugin's canonical home (got ${m.homepage})`);
  note(m.repository === CANONICAL_REPO, `repository must be the official repository (got ${m.repository})`);
  note(typeof m.license === 'string' && m.license.length > 0, 'license is required');
  return problems;
}

function auditMcpJson(m) {
  const problems = [];
  const note = (cond, message) => { if (!cond) problems.push(message); };
  note(m.$schema === MCP_SCHEMA, `mcp.json $schema must be ${MCP_SCHEMA} (got ${m.$schema})`);
  for (const key of Object.keys(m)) {
    note(MCP_ROOT_FIELDS.has(key), `mcp.json has unknown root field: ${key}`);
  }
  note(m.mcpServers && typeof m.mcpServers === 'object' && !Array.isArray(m.mcpServers),
    'mcpServers must be an object');
  const entries = Object.entries(m.mcpServers ?? {});
  note(entries.length > 0, 'at least one MCP server is declared');
  note(entries.length <= 8, `at most 8 MCP servers (got ${entries.length})`);
  for (const [serverName, server] of entries) {
    note(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(serverName), `invalid server name: ${serverName}`);
    if (server.type === 'stdio') {
      note(isBareCommand(server.command), `${serverName}: command must be a bare PATH name (got ${server.command})`);
      note(server.args === undefined || (Array.isArray(server.args) && server.args.every((a) => typeof a === 'string')),
        `${serverName}: args must be strings`);
      for (const arg of server.args ?? []) {
        note(!/^([A-Za-z]:[\\/]|\/|\\\\)/.test(arg), `${serverName}: arg must be package-relative (got ${arg})`);
      }
      const entry = (server.args ?? []).find((a) => a.startsWith('./'));
      note(entry && resolves(entry), `${serverName}: entry script must exist in the package`);
      note(server.cwd === undefined || server.cwd === '${PLUGIN_ROOT}',
        `${serverName}: cwd must be ${'${PLUGIN_ROOT}'} or omitted (got ${server.cwd})`);
      for (const key of Object.keys(server)) {
        note(STDIO_FIELDS.has(key), `${serverName}: unsupported field ${key}`);
      }
    } else {
      note(['streamable-http', 'sse'].includes(server.type), `${serverName}: unsupported transport ${server.type}`);
    }
  }
  return problems;
}

function auditClaudeManifest(m) {
  const problems = [];
  const note = (cond, message) => { if (!cond) problems.push(message); };
  note(m.name === NAME, `.claude-plugin name must be ${NAME} (got ${m.name})`);
  note(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m.name ?? ''), 'name must be lowercase hyphenated');
  note(/^\d+\.\d+\.\d+$/.test(m.version ?? ''), 'version must be SemVer');
  note(typeof m.license === 'string' && m.license.length > 0, 'license is required');
  note(m.author && typeof m.author.name === 'string' && m.author.name.length > 0, 'author.name is required');
  note(m.homepage === CANONICAL_HOMEPAGE, `homepage must point at this Plugin's canonical home (got ${m.homepage})`);
  note(m.repository === CANONICAL_REPO, `repository must be the official repository (got ${m.repository})`);

  const skills = Array.isArray(m.skills) ? m.skills : [m.skills];
  note(skills.length >= 1 && skills.every(Boolean), 'at least one Skill is declared');
  for (const rel of skills) {
    note(typeof rel === 'string' && rel.startsWith('./'), `skills path must be root-relative with ./ (got ${rel})`);
    note(typeof rel === 'string' && resolves(rel), `skills path does not resolve: ${rel}`);
  }
  // The nested path is only legal when the subdirectory name matches the frontmatter
  // name; assert the pairing because the runtime relies on it.
  if (typeof skills[0] === 'string') {
    const parts = skills[0].replace(/^\.\//, '').split('/');
    note(parts[0] === 'skills' && parts[1] === NAME, `skill subdirectory must match the manifest name (got ${skills[0]})`);
  }
  for (const [serverName, server] of Object.entries(m.mcpServers ?? {})) {
    for (const arg of server.args ?? []) {
      if (typeof arg === 'string' && arg.startsWith('./')) {
        note(resolves(arg), `${serverName}: mcp arg does not resolve: ${arg}`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 1. Required files
// ---------------------------------------------------------------------------

test('required files exist', () => {
  for (const p of [PLUGIN_JSON, CLAUDE_JSON, MCP_JSON, README, README_ZH, LICENSE, SKILL]) {
    assert.ok(existsSync(p), `missing: ${p}`);
  }
});

test('the package uses the repository layout, not the submission layout', () => {
  // The submission layout (.minimax-plugin/plugin.json plus *.mcp.json) is only for
  // the separate Marketplace form. Every Plugin merged into this repository declares
  // its capabilities through plugin.json + mcp.json, so a stray submission-only file
  // here would be an unreferenced declaration the reviewers would have to reconcile.
  assert.equal(existsSync(join(PLUGIN, '.minimax-plugin')), false, '.minimax-plugin/ must not be shipped here');
  const strays = collectFiles(PLUGIN).filter((rel) => /\.mcp\.json$/.test(rel));
  assert.deepEqual(strays, [], `no *.mcp.json files: ${strays.join(', ')}`);
  const extra = collectFiles(PLUGIN).filter((rel) => /SKILL\.md$/.test(rel) && rel !== join('skills', NAME, 'SKILL.md'));
  assert.deepEqual(extra, [], `exactly one SKILL.md, at skills/${NAME}/SKILL.md`);
});

// ---------------------------------------------------------------------------
// 2. Manifests
// ---------------------------------------------------------------------------

test('plugin.json conforms to the portable registry shape', () => {
  const problems = auditPluginJson(readJson(PLUGIN_JSON));
  assert.deepEqual(problems, [], `plugin.json problems:\n  ${problems.join('\n  ')}`);
});

test('mcp.json conforms to the portable MCP shape', () => {
  const problems = auditMcpJson(readJson(MCP_JSON));
  assert.deepEqual(problems, [], `mcp.json problems:\n  ${problems.join('\n  ')}`);
});

test('.claude-plugin/plugin.json conforms to the mcode 0.4.0+ layout', () => {
  const problems = auditClaudeManifest(readJson(CLAUDE_JSON));
  assert.deepEqual(problems, [], `.claude-plugin problems:\n  ${problems.join('\n  ')}`);
});

test('the manifest checkers are not vacuous: each rejects deliberate mutations', () => {
  const cases = [
    [auditPluginJson, readJson(PLUGIN_JSON), [
      (m) => ({ ...m, $schema: 'https://example.com/x.json' }),
      (m) => ({ ...m, name: 'wrong' }),
      (m) => ({ ...m, version: '0.1' }),
      (m) => ({ ...m, description: 'uses `code` spans' }),
      (m) => ({ ...m, author: 'weekbin' }),
      (m) => ({ ...m, homepage: `http://insecure` }),
      // Derived rather than written out, so no fork URL is hardcoded anywhere.
      (m) => ({ ...m, homepage: m.homepage.replace('MiniMax-AI', 'some-fork') }),
      (m) => ({ ...m, repository: m.repository.replace('MiniMax-AI', 'some-fork') }),
      (m) => ({ ...m, icon: 'icon.png' }),
      (m) => ({ ...m, skills: ['./skills/x/SKILL.md'] }),
      (m) => ({ ...m, unexpected: 1 }),
    ]],
    [auditMcpJson, readJson(MCP_JSON), [
      (m) => ({ ...m, $schema: 'https://example.com/x.json' }),
      (m) => ({ ...m, extra: true }),
      (m) => ({ ...m, mcpServers: {} }),
      (m) => ({ ...m, mcpServers: { s: { type: 'stdio', command: '/usr/bin/node' } } }),
      (m) => ({ ...m, mcpServers: { s: { type: 'stdio', command: 'node', args: ['./nope.mjs'] } } }),
      (m) => ({ ...m, mcpServers: { s: { type: 'stdio', command: 'node', cwd: '/etc' } } }),
      (m) => ({ ...m, mcpServers: { s: { type: 'http', url: 'https://x' } } }),
    ]],
    [auditClaudeManifest, readJson(CLAUDE_JSON), [
      (m) => ({ ...m, name: 'wrong' }),
      (m) => ({ ...m, skills: ['skills/' + NAME + '/SKILL.md'] }),
      (m) => ({ ...m, skills: ['./skills/does-not-exist/SKILL.md'] }),
      (m) => ({ ...m, skills: ['./skills/other-name/SKILL.md'] }),
      (m) => ({ ...m, version: undefined }),
      (m) => ({ ...m, author: { url: 'https://x' } }),
      (m) => ({ ...m, repository: m.repository.replace('MiniMax-AI', 'some-fork') }),
    ]],
  ];
  for (const [checker, baseline, mutations] of cases) {
    assert.deepEqual(checker(baseline), [], 'baseline must be clean');
    for (const mutate of mutations) {
      const problems = checker(mutate(baseline));
      assert.ok(problems.length > 0, `mutation was not caught: ${JSON.stringify(mutate(baseline)).slice(0, 90)}`);
    }
  }
});

test('every version declaration agrees with the SKILL.md metadata version', () => {
  const versions = {
    'plugin.json': readJson(PLUGIN_JSON).version,
    '.claude-plugin/plugin.json': readJson(CLAUDE_JSON).version,
  };
  const meta = readText(SKILL).match(/^metadata:\n((?:\s+.+\n?)+)/m);
  if (meta) {
    const skillVersion = meta[1].match(/version:\s*([\w.-]+)/);
    if (skillVersion) versions['SKILL.md metadata'] = skillVersion[1];
  }
  const unique = [...new Set(Object.values(versions))];
  assert.equal(unique.length, 1, `every declaration must agree, got ${JSON.stringify(versions, null, 2)}`);
});

// ---------------------------------------------------------------------------
// 3. SKILL.md
// ---------------------------------------------------------------------------

test('SKILL.md has frontmatter with name and description, and real instructions', () => {
  const text = readText(SKILL);
  assert.equal(text.charCodeAt(0), 0x002d, 'no BOM; must start with ---');
  const fm = text.match(/^---\n([\s\S]+?)\n---/);
  assert.ok(fm, 'YAML frontmatter required');
  assert.match(fm[1], new RegExp(`^name: ${NAME}$`, 'm'), 'frontmatter name must equal the directory name');
  const desc = fm[1].match(/^description:\s*(.+)$/m);
  assert.ok(desc && desc[1].length > 0 && desc[1].length <= 1024, 'description 1..1024');
  assert.ok(text.slice(text.indexOf('\n---\n', 4) + 5).trim().length > 0, 'instructions are required');
});

test('SKILL.md has no host-literal paths and no TODO/FIXME markers', () => {
  const text = readText(SKILL);
  assert.ok(!/\/Users\//.test(text), 'must not contain /Users/');
  assert.ok(!/~\/Works\//.test(text), 'must not contain ~/Works/');
  assert.ok(!/\bTODO[:\b]/m.test(text), 'must not contain TODO markers');
  assert.ok(!/\bFIXME[:\b]/m.test(text), 'must not contain FIXME markers');
});

// ---------------------------------------------------------------------------
// 4. Package hygiene
// ---------------------------------------------------------------------------

test('package is plain: ASCII paths, no symlinks, no executable bits, no BOM', () => {
  for (const rel of collectFiles(PLUGIN)) {
    assert.equal(/^[\x20-\x7E]+$/.test(rel.split(/[\\/]/).join('/')), true, `non-ASCII path: ${rel}`);
    const full = join(PLUGIN, rel);
    const st = lstatSync(full);
    assert.equal(st.isSymbolicLink(), false, `symlink not allowed: ${rel}`);
    assert.equal(st.mode & 0o111, 0, `executable bit not allowed: ${rel}`);
    if (/\.(?:md|json|mjs|js|css|html|txt)$/.test(rel)) {
      assert.notEqual(readFileSync(full).subarray(0, 3).toString('latin1'), '\u00ef\u00bb\u00bf', `BOM not allowed: ${rel}`);
    }
  }
});

test('package stays within the submission size and depth limits', () => {
  const files = collectFiles(PLUGIN);
  assert.ok(files.length <= 1024, `at most 1024 regular files (got ${files.length})`);
  let total = 0;
  let deepest = 0;
  for (const rel of files) {
    const size = statSync(join(PLUGIN, rel)).size;
    total += size;
    assert.ok(size <= 16 * 1024 * 1024, `single file must be <= 16 MiB: ${rel}`);
    const segments = rel.split(/[\\/]/).join('/').split('/');
    deepest = Math.max(deepest, segments.length);
    for (const segment of segments) {
      assert.ok(Buffer.byteLength(segment, 'utf8') <= 128, `path segment must be <= 128 bytes: ${rel}`);
    }
    assert.ok(Buffer.byteLength(rel, 'utf8') <= 512, `path must be <= 512 bytes: ${rel}`);
  }
  assert.ok(total <= 64 * 1024 * 1024, `total unpacked size must be <= 64 MiB (got ${total})`);
  assert.ok(deepest <= 16, `path depth must be <= 16 segments (got ${deepest})`);
});

test('no JSON file declares a duplicate key', () => {
  const countKeys = (value) => {
    if (Array.isArray(value)) return value.reduce((n, v) => n + countKeys(v), 0);
    if (value && typeof value === 'object') {
      return Object.keys(value).length + Object.values(value).reduce((n, v) => n + countKeys(v), 0);
    }
    return 0;
  };
  for (const rel of collectFiles(PLUGIN)) {
    if (!rel.endsWith('.json')) continue;
    const text = readText(join(PLUGIN, rel));
    const seen = [...text.matchAll(/^\s*"([^"]+)"\s*:/gm)].length;
    assert.equal(seen, countKeys(JSON.parse(text)), `${rel} appears to contain a duplicate key`);
  }
});
