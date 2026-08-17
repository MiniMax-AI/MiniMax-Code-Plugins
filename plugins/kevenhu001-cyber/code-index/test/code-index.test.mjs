import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildIndex, findReferences, getIndex, indexStatus, searchCode, searchFiles, searchSymbols } from '../lib/indexer.mjs';
import { drainOutboundRequests, handleRpc } from '../server.mjs';

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('builds an index with symbols across languages', async () => {
  const { root, dataDir } = await makeFixture();
  try {
    const result = await buildIndex({ root, dataDir });
    assert.equal(result.fileCount, 6);
    assert.equal(result.symbolCount, 25);
    assert.equal(result.persisted, true);
    assert.ok(result.indexPath.endsWith(path.join('code-index', 'index.json')));
    assert.ok((await stat(result.indexPath)).isFile());

    const index = await getIndex({ root, dataDir });
    assert.deepEqual(index.symbolIndex.greet[0], { file: 'src/index.js', line: 2, column: 17, kind: 'function' });
    assert.deepEqual(index.symbolIndex['node:http'][0].kind, 'import');
    assert.deepEqual(index.symbolIndex.Server[0], { file: 'src/index.js', line: 6, column: 14, kind: 'class' });
    assert.deepEqual(index.symbolIndex.constructor[0].kind, 'method');
    assert.deepEqual(index.symbolIndex.start[0].kind, 'method');
    assert.deepEqual(index.symbolIndex.Config[0], { file: 'src/types.ts', line: 1, column: 18, kind: 'interface' });
    assert.deepEqual(index.symbolIndex.Callback[0].kind, 'type');
    assert.deepEqual(index.symbolIndex.Mode[0].kind, 'enum');
    assert.deepEqual(index.symbolIndex.parse[0].kind, 'function');
    assert.deepEqual(index.symbolIndex.Greeter[0], { file: 'src/main.py', line: 4, column: 7, kind: 'class' });
    assert.deepEqual(index.symbolIndex.__init__[0].kind, 'method');
    assert.deepEqual(index.symbolIndex.hello[0].kind, 'method');
    assert.deepEqual(index.symbolIndex.top_level[0].kind, 'function');
    assert.deepEqual(index.symbolIndex.User[0], { file: 'src/server.go', line: 5, column: 6, kind: 'struct' });
    assert.deepEqual(index.symbolIndex.Greet[0].kind, 'method');
    assert.ok(index.symbolIndex.main.some((def) => def.kind === 'function' && def.file === 'src/server.go' && def.line === 13));
    assert.ok(index.symbolIndex.main.some((def) => def.kind === 'package' && def.line === 1));
    assert.deepEqual(index.symbolIndex.helper[0], { file: 'src/util.ts', line: 1, column: 17, kind: 'function' });
    assert.deepEqual(index.symbolIndex.handler[0].kind, 'function');
  } finally {
    await cleanup(root, dataDir);
  }
});

test('rebuilds incrementally and picks up changed files', async () => {
  const { root, dataDir } = await makeFixture();
  try {
    await buildIndex({ root, dataDir });
    const second = await buildIndex({ root, dataDir });
    assert.equal(second.filesChanged, 0);
    assert.equal(second.filesReused, 6);

    const utilPath = path.join(root, 'src', 'util.ts');
    const original = await readFile(utilPath, 'utf8');
    await writeFile(utilPath, `${original}\nexport function brandNew() {}\n`, 'utf8');
    const third = await buildIndex({ root, dataDir });
    assert.equal(third.filesChanged, 1);

    const index = await getIndex({ root, dataDir });
    assert.ok(index.symbolIndex.brandNew);
    assert.equal(index.symbolIndex.brandNew[0].file, 'src/util.ts');
  } finally {
    await cleanup(root, dataDir);
  }
});

test('skips gitignored, hidden, symlinked, and dependency directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-index-ignore-'));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-index-data-ignore-'));
  try {
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await mkdir(path.join(root, 'vendor'), { recursive: true });
    await mkdir(path.join(root, 'logs'), { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), 'vendor/\n*.log\n', 'utf8');
    await writeFile(path.join(root, 'app.js'), 'export function app() {}\n', 'utf8');
    await writeFile(path.join(root, 'node_modules', 'x.js'), 'export function x() {}\n', 'utf8');
    await writeFile(path.join(root, 'vendor', 'lib.js'), 'export function lib() {}\n', 'utf8');
    await writeFile(path.join(root, 'logs', 'app.log'), 'ignored\n', 'utf8');
    await writeFile(path.join(root, '.env'), 'SECRET=1\n', 'utf8');
    await writeFile(path.join(root, 'src', 'keep.js'), 'export function keep() {}\n', 'utf8');

    const result = await buildIndex({ root, dataDir });
    assert.equal(result.fileCount, 2);
    const index = await getIndex({ root, dataDir });
    assert.deepEqual(index.files.map((file) => file.path).sort(), ['app.js', 'src/keep.js']);
    assert.ok(!index.symbolIndex.x);
    assert.ok(!index.symbolIndex.lib);
    assert.ok(index.symbolIndex.keep);
  } finally {
    await cleanup(root, dataDir);
  }
});

test('search_symbol finds exact, prefix, substring, and kind-filtered matches', async () => {
  const { root, dataDir } = await makeFixture();
  try {
    await buildIndex({ root, dataDir });
    const exact = await searchSymbols({ index: await getIndex({ root, dataDir }), root, query: 'top_level' });
    assert.equal(exact.total, 1);
    assert.equal(exact.results[0].name, 'top_level');
    assert.equal(exact.results[0].definitions[0].file, 'src/main.py');
    assert.match(exact.results[0].definitions[0].snippet, /def top_level/u);

    const substring = await searchSymbols({ index: await getIndex({ root, dataDir }), root, query: 'allback' });
    assert.ok(substring.results.some((r) => r.name === 'Callback'));

    const fuzzy = await searchSymbols({ index: await getIndex({ root, dataDir }), root, query: 'greet' });
    assert.ok(fuzzy.total >= 2);
    assert.ok(fuzzy.results.some((r) => r.name === 'greet'));
    assert.ok(fuzzy.results.some((r) => r.name === 'Greeter'));

    const kindFiltered = await searchSymbols({ index: await getIndex({ root, dataDir }), root, query: 'Server', kind: 'class' });
    assert.equal(kindFiltered.results[0].name, 'Server');
    assert.equal(kindFiltered.results[0].kind, 'class');

    const caseSensitive = await searchSymbols({ index: await getIndex({ root, dataDir }), root, query: 'GREET', caseSensitive: true });
    assert.equal(caseSensitive.total, 0);
    const caseInsensitive = await searchSymbols({ index: await getIndex({ root, dataDir }), root, query: 'GREET' });
    assert.ok(caseInsensitive.total >= 1);

    await assert.rejects(
      searchSymbols({ index: await getIndex({ root, dataDir }), root, query: '   ' }),
      /query_required/u,
    );
  } finally {
    await cleanup(root, dataDir);
  }
});

test('find_references returns definitions and usage sites without the definition line', async () => {
  const { root, dataDir } = await makeFixture();
  try {
    await buildIndex({ root, dataDir });
    const result = await findReferences({ index: await getIndex({ root, dataDir }), root, name: 'handler' });
    assert.equal(result.definitions.length, 1);
    assert.equal(result.definitions[0].file, 'src/util.ts');
    assert.equal(result.definitions[0].line, 3);
    assert.deepEqual(result.references.map((r) => `${r.file}:${r.line}`), ['src/util.ts:6']);
    assert.match(result.references[0].snippet, /handler\(1\)/u);
  } finally {
    await cleanup(root, dataDir);
  }
});

test('search_file ranks basename matches and returns metadata', async () => {
  const { root, dataDir } = await makeFixture();
  try {
    await buildIndex({ root, dataDir });
    const byBase = await searchFiles({ index: await getIndex({ root, dataDir }), query: 'util' });
    assert.equal(byBase.results[0].path, 'src/util.ts');
    assert.equal(byBase.results[0].language, 'typescript');
    const byAsset = await searchFiles({ index: await getIndex({ root, dataDir }), query: 'logo' });
    assert.equal(byAsset.results[0].path, 'assets/logo.svg');
    assert.equal(byAsset.results[0].language, null);
  } finally {
    await cleanup(root, dataDir);
  }
});

test('get_file_symbols previews a file structure without reading the file', async () => {
  const { root, dataDir } = await makeFixture();
  try {
    await buildIndex({ root, dataDir });
    const result = await handleRpc(
      { method: 'tools/call', params: { name: 'get_file_symbols', arguments: { path: 'main.py' } } },
      { root, dataDir },
    );
    assert.equal(result.result.structuredContent.path, 'src/main.py');
    assert.equal(result.result.structuredContent.language, 'python');
    assert.ok(result.result.structuredContent.symbols.some((s) => s.name === 'Greeter' && s.kind === 'class'));
    const missing = await handleRpc(
      { method: 'tools/call', params: { name: 'get_file_symbols', arguments: { path: 'nope.py' } } },
      { root, dataDir },
    );
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /file_not_in_index/u);
  } finally {
    await cleanup(root, dataDir);
  }
});

test('search_code matches regexes, respects filePattern and limit truncation', async () => {
  const { root, dataDir } = await makeFixture();
  try {
    await buildIndex({ root, dataDir });
    const index = await getIndex({ root, dataDir });

    const all = await searchCode({ index, root, query: 'return' });
    assert.ok(['builtin', 'ripgrep'].includes(all.engine));
    assert.ok(all.results.some((r) => r.file === 'src/util.ts' && r.line === 6));

    const narrowed = await searchCode({ index, root, query: 'return', filePattern: 'main.py' });
    assert.ok(narrowed.results.length >= 2);
    assert.ok(narrowed.results.every((r) => r.file === 'src/main.py'));

    const truncated = await searchCode({ index, root, query: 'return', limit: 1 });
    assert.equal(truncated.results.length, 1);
    assert.equal(truncated.truncated, true);

    const invalid = searchCode({ index, root, query: '[' });
    await assert.rejects(invalid, /invalid_regex/u);
  } finally {
    await cleanup(root, dataDir);
  }
});

test('handles MCP initialize, tool listing, and tool calls', async () => {
  const { root, dataDir } = await makeFixture();
  try {
    const initialized = await handleRpc({ method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.equal(initialized.result.protocolVersion, '2025-03-26');
    assert.equal(initialized.result.serverInfo.name, 'code-index');
    assert.deepEqual(initialized.result.capabilities, { tools: {} });

    const listed = await handleRpc({ method: 'tools/list' });
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      [
        'index_status',
        'build_code_index',
        'search_symbol',
        'find_references',
        'search_file',
        'search_code',
        'get_file_symbols',
      ],
    );

    const statusBefore = await handleRpc({ method: 'tools/call', params: { name: 'index_status', arguments: {} } }, { root, dataDir });
    assert.equal(statusBefore.result.structuredContent.indexed, false);

    const built = await handleRpc({ method: 'tools/call', params: { name: 'build_code_index', arguments: {} } }, { root, dataDir });
    assert.equal(built.result.structuredContent.fileCount, 6);

    const statusAfter = await handleRpc({ method: 'tools/call', params: { name: 'index_status', arguments: {} } }, { root, dataDir });
    assert.equal(statusAfter.result.structuredContent.indexed, true);

    const searched = await handleRpc(
      { method: 'tools/call', params: { name: 'search_symbol', arguments: { query: 'helper' } } },
      { root, dataDir },
    );
    assert.equal(searched.result.structuredContent.results[0].name, 'helper');
    assert.equal(searched.result.structuredContent.results[0].definitions[0].line, 1);

    const missing = await handleRpc({ method: 'tools/call', params: { name: 'missing' } }, { root, dataDir });
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /Unknown tool/u);
  } finally {
    await cleanup(root, dataDir);
  }
});

test('searching without an index reports index_not_built', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-index-unbuilt-'));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-index-data-unbuilt-'));
  try {
    await writeFile(path.join(root, 'app.js'), 'export function app() {}\n', 'utf8');
    const response = await handleRpc(
      { method: 'tools/call', params: { name: 'search_symbol', arguments: { query: 'app' } } },
      { root, dataDir },
    );
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /index_not_built/u);
    const status = await indexStatus({ root, dataDir });
    assert.equal(status.indexed, false);
  } finally {
    await cleanup(root, dataDir);
  }
});

test('serves MCP requests over the configured stdio process boundary', async (context) => {
  const { root, dataDir } = await makeFixture();
  try {
    const serverPath = path.join(PLUGIN_ROOT, 'server.mjs');
    const child = spawn(process.execPath, [serverPath], {
      cwd: root,
      env: { ...process.env, PLUGIN_ROOT: PLUGIN_ROOT },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    context.after(() => {
      if (!child.killed) child.kill();
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'build_code_index', arguments: {} } }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'search_symbol', arguments: { query: 'greet' } },
      }),
      '',
    ].join('\n'));

    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, stderr);
    const responses = stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(responses.map((response) => response.id), [1, 2, 3, 4]);
    assert.equal(responses[0].result.serverInfo.name, 'code-index');
    assert.equal(responses[1].result.tools.length, 7);
    assert.equal(responses[2].result.structuredContent.fileCount, 6);
    assert.equal(responses[3].result.structuredContent.results[0].name, 'greet');
  } finally {
    await cleanup(root, dataDir);
  }
});

test('launched from the plugin directory it refuses to index the plugin and accepts an explicit root', async (context) => {
  const { root, dataDir } = await makeFixture();
  try {
    const requests = [
      rpc(1, 'initialize', {}),
      rpc(2, 'tools/call', { name: 'build_code_index', arguments: {} }),
      rpc(3, 'tools/call', { name: 'build_code_index', arguments: { root } }),
      rpc(4, 'tools/call', { name: 'search_symbol', arguments: { query: 'greet' } }),
    ];
    const { exit, stdout, stderr } = await runStdio(requests, {
      cwd: PLUGIN_ROOT,
      env: { PLUGIN_ROOT },
    });
    assert.equal(exit.code, 0, stderr);
    const responses = parseResponses(stdout);
    assert.deepEqual(responses.map((r) => r.id), [1, 2, 3, 4]);

    assert.equal(responses[1].result.isError, true);
    assert.match(responses[1].result.content[0].text, /workspace_root_unknown/u);

    assert.equal(responses[2].result.structuredContent.fileCount, 6);
    assert.equal(path.resolve(responses[2].result.structuredContent.root), path.resolve(root));

    assert.equal(responses[3].result.structuredContent.results[0].name, 'greet');
    assert.equal(responses[3].result.structuredContent.results[0].definitions[0].file, 'src/index.js');
  } finally {
    await cleanup(root, dataDir);
  }
});

test('honors CODE_INDEX_ROOT when the host offers no other project signal', async (context) => {
  const { root, dataDir } = await makeFixture();
  try {
    const requests = [
      rpc(1, 'initialize', {}),
      rpc(2, 'tools/call', { name: 'build_code_index', arguments: {} }),
    ];
    const { exit, stdout, stderr } = await runStdio(requests, {
      cwd: PLUGIN_ROOT,
      env: { PLUGIN_ROOT, CODE_INDEX_ROOT: root },
    });
    assert.equal(exit.code, 0, stderr);
    const responses = parseResponses(stdout);
    assert.equal(path.resolve(responses[1].result.structuredContent.root), path.resolve(root));
    assert.equal(responses[1].result.structuredContent.fileCount, 6);
  } finally {
    await cleanup(root, dataDir);
  }
});

test('persists and reuses the active root under PLUGIN_DATA across server restarts', async (context) => {
  const { root } = await makeFixture();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-index-data-persist-'));
  try {
    const build = await runStdio(
      [
        rpc(1, 'initialize', {}),
        rpc(2, 'tools/call', { name: 'build_code_index', arguments: { root } }),
      ],
      { cwd: PLUGIN_ROOT, env: { PLUGIN_ROOT, PLUGIN_DATA: dataDir } },
    );
    assert.equal(build.exit.code, 0, build.stderr);
    const stateFile = path.join(dataDir, 'code-index', 'active-root.json');
    assert.ok((await stat(stateFile)).isFile());
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).root, path.resolve(root));

    const restart = await runStdio(
      [
        rpc(1, 'initialize', {}),
        rpc(2, 'tools/call', { name: 'index_status', arguments: {} }),
        rpc(3, 'tools/call', { name: 'search_symbol', arguments: { query: 'top_level' } }),
      ],
      { cwd: PLUGIN_ROOT, env: { PLUGIN_ROOT, PLUGIN_DATA: dataDir } },
    );
    assert.equal(restart.exit.code, 0, restart.stderr);
    const responses = parseResponses(restart.stdout);
    assert.equal(responses[1].result.structuredContent.indexed, true);
    assert.equal(path.resolve(responses[1].result.structuredContent.root), path.resolve(root));
    assert.equal(responses[2].result.structuredContent.results[0].name, 'top_level');
  } finally {
    await cleanup(root, null);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('accepts the project root from MCP roots, both announced and pulled', async () => {
  const { root } = await makeFixture();
  try {
    await handleRpc({
      method: 'notifications/roots/list_changed',
      params: { roots: [{ uri: pathToFileURL(root).href }] },
    });
    const built = await handleRpc({ method: 'tools/call', params: { name: 'build_code_index', arguments: {} } });
    assert.equal(built.result.structuredContent.fileCount, 6);
    assert.equal(path.resolve(built.result.structuredContent.root), path.resolve(root));
    const searched = await handleRpc({ method: 'tools/call', params: { name: 'search_symbol', arguments: { query: 'greet' } } });
    assert.equal(searched.result.structuredContent.results[0].name, 'greet');
  } finally {
    await handleRpc({ method: 'notifications/roots/list_changed', params: { roots: [] } });
    await cleanup(root, null);
  }
});

test('requests the root list from clients that only announce a change', async () => {
  const { root } = await makeFixture();
  try {
    await handleRpc({
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientCapabilities: { roots: { listChanged: true } } },
    });
    const handled = await handleRpc({ method: 'notifications/roots/list_changed' });
    assert.equal(handled, null);
    const outbound = drainOutboundRequests();
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].method, 'roots/list');
    assert.ok(typeof outbound[0].id === 'string');

    await handleRpc({ id: outbound[0].id, result: { roots: [{ uri: pathToFileURL(root).href }] } });
    const built = await handleRpc({ method: 'tools/call', params: { name: 'build_code_index', arguments: {} } });
    assert.equal(built.result.structuredContent.fileCount, 6);
    assert.equal(path.resolve(built.result.structuredContent.root), path.resolve(root));
  } finally {
    await handleRpc({ method: 'notifications/roots/list_changed', params: { roots: [] } });
    await cleanup(root, null);
  }
});

test('skill documents the search-before-explore workflow', async () => {
  const skill = await readFile(path.join(PLUGIN_ROOT, 'skills', 'code-index', 'SKILL.md'), 'utf8');
  for (const tool of ['index_status', 'build_code_index', 'search_symbol', 'find_references', 'search_file', 'search_code', 'get_file_symbols']) {
    assert.match(skill, new RegExp(tool, 'u'));
  }
  assert.match(skill, /index_not_built/u);
  assert.match(skill, /search-before-explore/u);
});

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-index-project-'));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-index-data-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'src', 'index.js'), [
    "import { createServer } from 'node:http';",
    'export function greet(name) {',
    '  return `Hello ${name}`;',
    '}',
    'export const PI = 3.14;',
    'export class Server {',
    '  constructor(port) {',
    '    this.port = port;',
    '  }',
    '  start() {',
    '    return this.port;',
    '  }',
    '  async stop() {}',
    '}',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(root, 'src', 'types.ts'), [
    'export interface Config {',
    '  name: string;',
    '}',
    'export type Callback = (x: number) => void;',
    'export enum Mode {',
    '  A,',
    '  B,',
    '}',
    'export function parse(config: Config): void {}',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(root, 'src', 'main.py'), [
    'import os',
    'from pathlib import Path',
    '',
    'class Greeter:',
    '    def __init__(self, name):',
    '        self.name = name',
    '',
    '    def hello(self):',
    '        return self.name',
    '',
    '',
    'def top_level(x):',
    '    return x',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(root, 'src', 'server.go'), [
    'package main',
    '',
    'import "fmt"',
    '',
    'type User struct {',
    '    Name string',
    '}',
    '',
    'func (u User) Greet() string {',
    '    return "hi"',
    '}',
    '',
    'func main() {}',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(root, 'src', 'util.ts'), [
    'export function helper() {}',
    '',
    'export const handler = (a: number) => a + 1;',
    '',
    'export function useHandler() {',
    '  return handler(1);',
    '}',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(root, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n', 'utf8');
  return { root, dataDir };
}

async function cleanup(root, dataDir) {
  await rm(root, { recursive: true, force: true });
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}

function rpc(id, method, params) {
  return { jsonrpc: '2.0', id, method, params };
}

function parseResponses(stdout) {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runStdio(requests, { cwd, env }) {
  const serverPath = path.join(PLUGIN_ROOT, 'server.mjs');
  const child = spawn(process.execPath, [serverPath], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`);
  const exit = await waitForExit(child);
  return { exit, stdout, stderr };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('stdio server did not exit after stdin closed'));
    }, 10_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}
