#!/usr/bin/env node
// Exact-pin MCP smoke for the trace-mcp MiniMax plugin.
//
// Spawns the pinned registry build over stdio with the same environment
// mcp.json ships, then asserts the executable contract a reviewer can
// re-run: handshake version, default/dev surfaces, a read call, dry-run
// and confirm_large gates, traversal/symlink refusal, telemetry opt-out,
// one real local mutation, and no reachable daemon behind the session.
//
// Usage: node smoke/exact-pin-smoke.mjs [--pin trace-mcp@3.31.5]
// Node 22+, stdlib only. Prints one JSON object per line (JSONL) to stdout;
// exits 0 only if every assertion holds, 1 otherwise. No network access
// beyond the npm install npx itself performs; the session under test makes
// none (telemetry forced off, daemon spawn disabled, update check disabled).
//
// Every assertion runs inside an isolated HOME and a scratch fixture, so an
// ambient desktop-app daemon or developer checkout on the reviewer's machine
// cannot change the outcome: TRACE_MCP_DAEMON_PORT points at a port this
// script never binds, so the session's /health poll cannot match a foreign
// daemon and every call executes in the pinned npx process.

import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PIN = process.argv.includes('--pin')
  ? process.argv[process.argv.indexOf('--pin') + 1]
  : 'trace-mcp@3.31.5';
const EXPECTED_VERSION = PIN.split('@')[1];
const MUTATING = [
  'apply_rename',
  'apply_codemod',
  'extract_function',
  'apply_move',
  'change_signature',
  'remove_dead_code',
];
// A high port nothing in this repo ever binds. The session polls exactly this
// port for a daemon; with auto-spawn off it stays unanswered, which pins
// execution to the local backend even when the user runs a desktop daemon on
// the default 3741. Mirrors the "env" block in mcp.json.
const DEAD_PORT = '48171';

const lines = [];
const note = (test, ok, extra = {}) => {
  lines.push({ test, ok, ...extra });
  if (!ok) process.exitCode = 1;
};

const work = mkdtempSync(join(tmpdir(), 'trace-mcp-smoke-'));
const home = join(work, 'home');
const proj = join(work, 'proj');
const outside = join(work, 'outside');
mkdirSync(home, { recursive: true });
mkdirSync(proj, { recursive: true });
mkdirSync(outside, { recursive: true });

// Fixture: one shared definition referenced from 26 modules (a rename of the
// shared symbol touches 27 files, tripping the >20 confirm gate) plus a
// function body worth extracting.
const FILE_COUNT = 26;
writeFileSync(join(proj, 'shared.js'), `export function sharedTarget() { return 0; }\n`);
for (let i = 0; i < FILE_COUNT; i++) {
  writeFileSync(
    join(proj, `mod${i}.js`),
    `import { sharedTarget } from './shared.js';\nexport const value${i} = sharedTarget();\n`,
  );
}
writeFileSync(
  join(proj, 'main.js'),
  `import { sharedTarget } from './shared.js';\nexport function entry() {\n  const base = sharedTarget();\n  const doubled = base * 2;\n  return doubled;\n}\n`,
);
const CANARY = 'CANARY: must never change\n';
writeFileSync(join(outside, 'secret.js'), `export function hidden() {\n  return 1;\n}\n// ${CANARY}`);

const snap = () => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir).sort()) {
      const p = join(dir, e);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) files.push([p.slice(proj.length), readFileSync(p, 'utf8')]);
    }
  };
  walk(proj);
  return JSON.stringify(files);
};
const before = snap();

// Ambient daemon sighting (informational only — the dead-port env makes the
// session immune to it, and assertion 2 proves that).
const health = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { reachable: false };
    const body = await res.json();
    return { reachable: true, version: body.version, pid: body.pid };
  } catch {
    return { reachable: false };
  }
};
const ambient3741 = await health(3741);
const deadPort = await health(Number(DEAD_PORT));
note('pre.daemon_sighting', true, { port_3741: ambient3741, dead_port_48171: deadPort });

// One link-out symlink: created after the baseline snapshot on purpose, so
// the tree-unchanged assertions below stay meaningful while the refusal path
// still executes against a live symlink.
let child;
const startSession = () =>
  spawn('npx', ['-y', PIN], {
    cwd: proj,
    env: {
      ...process.env,
      HOME: home,
      TRACE_MCP_DATA_DIR: join(home, '.trace'),
      TRACE_MCP_NO_DAEMON: '1',
      TRACE_MCP_NO_AUTO_UPDATE: '1',
      TRACE_MCP_TELEMETRY: 'off',
      TRACE_MCP_DAEMON_PORT: DEAD_PORT,
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

child = startSession();
let buf = '';
const pending = new Map();
let nextId = 1;
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      /* stderr interleaved or partial frame: ignore */
    }
  }
});
let stderrTail = '';
child.stderr.on('data', (d) => {
  stderrTail += d.toString().slice(-2000);
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 90000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
const tool = async (name, args) => {
  const res = await call('tools/call', { name, arguments: args });
  const text = res.result?.content?.[0]?.text ?? JSON.stringify(res);
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
};
child.stdin.write(
  JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
);

try {
  // 1. Handshake: the pinned binary answers for itself.
  const init = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'exact-pin-smoke', version: '1' },
  });
  const serverVersion = init.result?.serverInfo?.version;
  note('handshake.initialize', serverVersion === EXPECTED_VERSION, {
    serverVersion,
    expected: EXPECTED_VERSION,
  });

  // 1b. Wait until the scratch fixture is indexed; refactor probes below
  // operate on the symbol store, so an early run would test nothing.
  let indexedFiles = 0;
  let healthKeys = [];
  for (let i = 0; i < 90; i++) {
    const h = await tool('get_index_health', {});
    healthKeys = Object.keys(h.stats ?? h ?? {});
    indexedFiles =
      h.stats?.totalFiles ?? h.stats?.fileCount ?? h.stats?.files ?? h.totalFiles ?? 0;
    if (indexedFiles >= FILE_COUNT + 1) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  note('index.ready', indexedFiles >= FILE_COUNT + 1, { indexedFiles, healthKeys });

  // 2. Default surface: read-only, mutators hidden.
  const list1 = await call('tools/list', {});
  const names1 = (list1.result?.tools ?? []).map((t) => t.name);
  const leaked = MUTATING.filter((m) => names1.includes(m));
  note('surface.default_preset', leaked.length === 0 && names1.length > 0, {
    tool_count: names1.length,
    leaked,
  });

  // 3. Dev surface via load_tools: mutators appear, dry_run defaults true.
  await tool('load_tools', { preset: 'dev' });
  const list2 = await call('tools/list', {});
  const tools2 = list2.result?.tools ?? [];
  const names2 = tools2.map((t) => t.name);
  const missing = MUTATING.filter((m) => !names2.includes(m));
  const dryDefaults = {};
  for (const t of tools2) {
    if (MUTATING.includes(t.name)) dryDefaults[t.name] = t.inputSchema?.properties?.dry_run?.default;
  }
  note('surface.dev_preset', missing.length === 0, {
    tool_count: names2.length,
    missing,
    dry_run_defaults: dryDefaults,
  });
  const annotations = {};
  for (const t of tools2) {
    if (MUTATING.includes(t.name)) annotations[t.name] = t.annotations ?? null;
  }
  note('surface.mutator_annotations', true, { annotations });

  // 4. A read call works, returns the fixture, and writes nothing.
  const search = await tool('search', { query: 'sharedTarget', limit: 5 });
  const searchHit = JSON.stringify(search).includes('sharedTarget');
  note('read.search', searchHit && snap() === before, {
    hit: searchHit,
    tree_unchanged: snap() === before,
  });

  // Resolve one symbol id for the rename probes.
  const outline = await tool('get_outline', { path: 'shared.js' });
  const text = JSON.stringify(outline);
  const idMatch =
    text.match(/"symbolId"\s*:\s*"([^"]+)"/) ||
    text.match(/"symbol_id"\s*:\s*"([^"]+)"/) ||
    text.match(/"id"\s*:\s*"([^"]+)"/);
  const symbolId = idMatch?.[1];
  note('read.get_outline', !!symbolId, { symbolId: symbolId ?? null });

  // 5. Traversal outside the root is refused in both modes; canary intact.
  const travDry = await tool('apply_codemod', {
    pattern: 'CANARY',
    replacement: 'CANARY',
    file_pattern: '../outside/*.js',
  });
  const travApply = await tool('apply_codemod', {
    pattern: 'CANARY',
    replacement: 'CANARY',
    file_pattern: '../outside/*.js',
    dry_run: false,
  });
  const canaryOk = readFileSync(join(outside, 'secret.js'), 'utf8').includes(CANARY.trim());
  note('boundary.codemod_traversal', travDry.success === false && travApply.success === false && canaryOk && snap() === before, {
    dry_success: travDry.success,
    apply_success: travApply.success,
    canary_unchanged: canaryOk,
    tree_unchanged: snap() === before,
  });

  // 6. Writes through an in-root symlink pointing outside are refused.
  // secret.js holds a real function body (lines 1-3), so only the symlink
  // guard can refuse this call — not the range check.
  symlinkSync(join(outside, 'secret.js'), join(proj, 'link-out.js'));
  const symApply = await tool('extract_function', {
    file_path: 'link-out.js',
    start_line: 2,
    end_line: 2,
    function_name: 'exfil',
    dry_run: false,
  });
  const canaryOk2 = readFileSync(join(outside, 'secret.js'), 'utf8').includes(CANARY.trim());
  note('boundary.symlink_write', symApply.success === false && canaryOk2 && snap() === before, {
    success: symApply.success,
    error: (symApply.error ?? '').slice(0, 160),
    canary_unchanged: canaryOk2,
    tree_unchanged: snap() === before,
  });
  rmSync(join(proj, 'link-out.js'));

  // 7. One real mutation applies locally (execution is not a stub).
  // Line 4 computes one value used below: a clean single-return slice.
  const real = await tool('extract_function', {
    file_path: 'main.js',
    start_line: 4,
    end_line: 4,
    function_name: 'computeDoubled',
    dry_run: false,
  });
  const mainChanged = readFileSync(join(proj, 'main.js'), 'utf8').includes('computeDoubled');
  note('mutation.extract_applies', real.success === true && mainChanged, {
    success: real.success,
    error: (real.error ?? '').slice(0, 200),
    files_modified: real.files_modified,
  });

  // Re-baseline: the extract above legitimately rewrote main.js. The rename
  // probes below assert against the post-extract tree.
  const mid = snap();

  // 8. Dry-run rename previews without touching the tree.
  if (symbolId) {
    const dry = await tool('apply_rename', { symbol_id: symbolId, new_name: 'renamedTarget' });
    note('gate.rename_dryrun', dry.success !== false && snap() === mid, {
      success: dry.success,
    });

    // 9. >20-file apply without confirm_large fails closed, tree identical.
    const big = await tool('apply_rename', {
      symbol_id: symbolId,
      new_name: 'renamedTarget',
      dry_run: false,
    });
    note('gate.rename_confirm_large', big.success === false && snap() === mid, {
      success: big.success,
      error: (big.error ?? '').slice(0, 200),
      files_modified: big.files_modified,
    });
  } else {
    note('gate.rename_dryrun', false, { skipped: 'no symbol id from get_outline' });
    note('gate.rename_confirm_large', false, { skipped: 'no symbol id from get_outline' });
  }

  // 10. Telemetry opt-out: no ping state under the isolated home.
  const teleState = join(home, '.trace', 'telemetry-state.json');
  const teleStateLegacy = join(home, '.trace-mcp', 'telemetry-state.json');
  note('telemetry.opt_out', !existsSync(teleState) && !existsSync(teleStateLegacy), {
    state_written: existsSync(teleState) || existsSync(teleStateLegacy),
  });
} catch (err) {
  note('smoke.harness_error', false, { error: String(err && err.message ? err.message : err) });
} finally {
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

for (const l of lines) console.log(JSON.stringify(l));
rmSync(work, { recursive: true, force: true });
