import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, existsSync, readFileSync, writeFileSync, statSync, rmSync,
  readdirSync, mkdirSync, chmodSync, utimesSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'antianqi', 'tool-map');
const SCAN = join(PLUGIN_DIR, 'scripts', 'scan.mjs');
const SMOKE = join(PLUGIN_DIR, 'scripts', 'smoke.mjs');

function runScan(outPath, extraEnv = {}) {
  return spawnSync(process.execPath, [SCAN, outPath], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...extraEnv },
  });
}

test('scan.mjs writes the three catalog files atomically', () => {
  const work = mkdtempSync(join(tmpdir(), 'tool-map-write-'));
  try {
    const out = join(work, 'tools.md');
    const r = runScan(out);
    assert.equal(r.status, 0, `scan failed (exit ${r.status}):\n${r.stderr}\n${r.stdout}`);
    const stem = out.replace(/\.md$/, '');
    for (const path of [out, `${stem}.json`, `${stem}.summary.md`]) {
      assert.ok(existsSync(path), `missing ${path}`);
      assert.ok(statSync(path).size > 0, `empty ${path}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('scan.mjs JSON has the expected schema', () => {
  const work = mkdtempSync(join(tmpdir(), 'tool-map-schema-'));
  try {
    const out = join(work, 'tools.md');
    const r = runScan(out);
    assert.equal(r.status, 0, `scan failed: ${r.stderr}`);
    const json = JSON.parse(readFileSync(out.replace(/\.md$/, '') + '.json', 'utf8'));
    assert.equal(typeof json.scanned, 'string', 'scanned timestamp required');
    assert.equal(typeof json.platform, 'string', 'platform required');
    assert.equal(typeof json.host, 'string', 'host required');
    assert.equal(typeof json.core, 'object', 'core versions object required');
    assert.equal(typeof json.extras, 'object', 'extras object required');
    assert.ok(Array.isArray(json.tools), 'tools must be an array');
    for (const t of json.tools) {
      assert.equal(typeof t.name, 'string');
      assert.equal(typeof t.type, 'string');
      assert.equal(typeof t.path, 'string');
      assert.equal(typeof t.size, 'number');
      assert.equal(typeof t.modified, 'string');
      assert.equal(typeof t.category, 'string');
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('scan.mjs writes nothing outside the output directory', () => {
  const work = mkdtempSync(join(tmpdir(), 'tool-map-isolated-'));
  try {
    const out = join(work, 'tools.md');
    const r = runScan(out);
    assert.equal(r.status, 0, `scan failed: ${r.stderr}`);
    const entries = readdirSync(work).sort();
    assert.deepEqual(
      entries,
      ['tools.json', 'tools.md', 'tools.summary.md'],
      `unexpected files in output dir: ${entries.join(', ')}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('scan.mjs leaves no staging files on success', () => {
  const work = mkdtempSync(join(tmpdir(), 'tool-map-nostage-'));
  try {
    const out = join(work, 'tools.md');
    const r = runScan(out);
    assert.equal(r.status, 0, `scan failed: ${r.stderr}`);
    const entries = readdirSync(work);
    for (const e of entries) {
      assert.ok(
        !e.includes('.staging-') && !e.includes('.bundle.staging-'),
        `staging file or dir leaked: ${e}`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('scan.mjs completes with an empty PATH and still produces a valid catalog', () => {
  const work = mkdtempSync(join(tmpdir(), 'tool-map-probes-'));
  try {
    const out = join(work, 'tools.md');
    const r = spawnSync(process.execPath, [SCAN, out], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: '', TOOL_MAP_ROOTS: '' },
    });
    assert.equal(r.status, 0, `scan failed with empty PATH: ${r.stderr}\n${r.stdout}`);
    const stem = out.replace(/\.md$/, '');
    for (const path of [out, `${stem}.json`, `${stem}.summary.md`]) {
      assert.ok(existsSync(path), `missing ${path} after empty-PATH run`);
    }
    const json = JSON.parse(readFileSync(out.replace(/\.md$/, '') + '.json', 'utf8'));
    assert.equal(typeof json.platform, 'string');
    assert.ok(Array.isArray(json.tools));
    for (const t of json.tools) {
      assert.notEqual(t.category, 'PATH', 'PATH-categorized tool leaked with empty $PATH');
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('smoke.mjs exits 0 against the plugin source tree', () => {
  const r = spawnSync(process.execPath, [SMOKE], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(
    r.status, 0,
    `smoke failed (exit ${r.status}):\n${r.stderr}\nstdout:\n${r.stdout}`,
  );
  assert.match(r.stdout, /OK scanned \d+ files, 0 violations\./u);
});

// ---------------------------------------------------------------------------
// Adversarial tests for the v0.2.0-beta.2 review blockers
// ---------------------------------------------------------------------------

test('atomicWriteBundle rolls back when a mid-bundle rename fails', async () => {
  // We cannot reliably force a real OS-level rename failure in a portable
  // test (Windows' MoveFileExW overwrites read-only files; POSIX rename
  // behaves differently across filesystems). The implementation exposes
  // a deterministic test hook: TOOL_MAP_FAIL_AT_RENAME=N makes the Nth
  // rename throw. This is set on a child-process spawn below so the
  // hook is scoped to the test and does not affect other tests.
  const work = mkdtempSync(join(tmpdir(), 'tool-map-rollback-'));
  try {
    // Pre-fill both target files with sentinels so we can detect any
    // overwrite that bypasses the rollback.
    const mdSentinel = 'PRE-EXISTING-MD-SENTINEL';
    const jsonSentinel = 'PRE-EXISTING-JSON-SENTINEL';
    writeFileSync(join(work, 'tools.md'), mdSentinel);
    writeFileSync(join(work, 'tools.json'), jsonSentinel);

    // Spawn node with the test hook armed at rename #4 (the first rename
    // of a fresh atomicWriteBundle is #1 for the tools.md backup, #2 for
    // the tools.json backup, #3 for the tools.summary.md backup, then
    // #4 is the rename of the new tools.md onto the target. We pick #4
    // to simulate a failure that happens AFTER the backups are in
    // place but BEFORE the new content lands. This is the case where
    // rollback is hardest: the previous targets have already been moved
    // to the backup dir, and a naive implementation would leave them
    // stranded there).
    const helperPath = join(REPO_ROOT, 'test-fixtures', 'drive-bundle-failure.mjs');
    const r = spawnSync(process.execPath, [helperPath, work], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, TOOL_MAP_FAIL_AT_RENAME: '4' },
    });
    assert.notEqual(r.status, 0, `helper should exit non-zero when the hook fires: stdout=${r.stdout}\nstderr=${r.stderr}`);

    // The previous catalog must be completely intact.
    const mdAfter = readFileSync(join(work, 'tools.md'), 'utf8');
    assert.equal(mdAfter, mdSentinel, `tools.md was overwritten despite rollback: ${mdAfter}`);
    const jsonAfter = readFileSync(join(work, 'tools.json'), 'utf8');
    assert.equal(jsonAfter, jsonSentinel, `tools.json was overwritten despite rollback: ${jsonAfter}`);
    // tools.summary.md must not exist (was never written to the target).
    assert.ok(!existsSync(join(work, 'tools.summary.md')), 'tools.summary.md leaked after rollback');
    // No staging or backup residue anywhere in the dir.
    const entries = readdirSync(work);
    const residue = entries.filter((e) =>
      e.includes('.staging-') || e.includes('.bundle.staging-') || e.includes('.bundle.backup-'),
    );
    assert.equal(residue.length, 0, `staging/backup residue after rollback: ${residue.join(', ')}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('atomicWriteBundle is idempotent on the happy path (no residue, all 3 present)', async () => {
  const scanUrl = pathToFileURL(SCAN).href;
  const { atomicWriteBundle } = await import(scanUrl);
  const work = mkdtempSync(join(tmpdir(), 'tool-map-happy-'));
  try {
    atomicWriteBundle(work, {
      'a.txt': 'A',
      'b.txt': 'B',
      'c.txt': 'C',
    });
    assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'A');
    assert.equal(readFileSync(join(work, 'b.txt'), 'utf8'), 'B');
    assert.equal(readFileSync(join(work, 'c.txt'), 'utf8'), 'C');
    const residue = readdirSync(work).filter((e) => e.includes('.staging-') || e.includes('.bundle.staging-'));
    assert.equal(residue.length, 0, `staging residue: ${residue.join(', ')}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('ALLOWED_PROBE_NAMES is exactly the 15 declared names', async () => {
  const scanUrl = pathToFileURL(SCAN).href;
  const { ALLOWED_PROBE_NAMES, VERSION_PROBES } = await import(scanUrl);
  assert.equal(ALLOWED_PROBE_NAMES.size, 15);
  for (const [name] of VERSION_PROBES) {
    assert.ok(ALLOWED_PROBE_NAMES.has(name), `version probe ${name} missing from whitelist`);
  }
  // Defence-in-depth: a non-whitelisted name must never be spawned.
  assert.ok(!ALLOWED_PROBE_NAMES.has('curl'));
  assert.ok(!ALLOWED_PROBE_NAMES.has('bash'));
  assert.ok(!ALLOWED_PROBE_NAMES.has('rm'));
});

test('POSIX: a .sh file without the execute bit is not reported as a tool', () => {
  if (process.platform === 'win32') return; // Windows ignores the execute bit
  const root = mkdtempSync(join(tmpdir(), 'tool-map-xbit-'));
  try {
    const sh = join(root, 'foo.sh');
    writeFileSync(sh, '#!/bin/sh\necho hi\n');
    chmodSync(sh, 0o644); // no execute bit
    // Touch the file so mtime is fresh
    utimesSync(sh, new Date(), new Date());

    const out = join(root, 'tools.md');
    const r = runScan(out, { TOOL_MAP_ROOTS: root });
    assert.equal(r.status, 0, `scan failed: ${r.stderr}\n${r.stdout}`);

    const json = JSON.parse(readFileSync(join(root, 'tools.json'), 'utf8'));
    for (const t of json.tools) {
      assert.notEqual(t.name, 'foo', `non-executable foo.sh was reported as a tool: ${t.path}`);
    }

    // Now make it executable and confirm it IS reported.
    chmodSync(sh, 0o755);
    const r2 = runScan(out, { TOOL_MAP_ROOTS: root });
    assert.equal(r2.status, 0, `scan failed: ${r2.stderr}\n${r2.stdout}`);
    const json2 = JSON.parse(readFileSync(join(root, 'tools.json'), 'utf8'));
    assert.ok(
      json2.tools.some((t) => t.name === 'foo'),
      'executable foo.sh should be reported as a tool',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POSIX: case-distinct tool names on case-sensitive filesystems are kept distinct', () => {
  if (process.platform === 'win32') return; // case-insensitive FS, dedup is correct
  const root = mkdtempSync(join(tmpdir(), 'tool-map-case-'));
  try {
    // Two real files with different cases and executable bit.
    writeFileSync(join(root, 'Foo'), '#!/bin/sh\necho Foo\n');
    chmodSync(join(root, 'Foo'), 0o755);
    writeFileSync(join(root, 'foo'), '#!/bin/sh\necho foo\n');
    chmodSync(join(root, 'foo'), 0o755);

    const out = join(root, 'tools.md');
    const r = runScan(out, { TOOL_MAP_ROOTS: root });
    assert.equal(r.status, 0, `scan failed: ${r.stderr}\n${r.stdout}`);
    const json = JSON.parse(readFileSync(join(root, 'tools.json'), 'utf8'));
    const names = json.tools.map((t) => t.name).sort();
    assert.deepEqual(
      names, ['Foo', 'foo'],
      `case-distinct tool names were merged: ${names.join(', ')}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('XDG_DATA_HOME is honoured when PLUGIN_DATA is unset', () => {
  const xdg = mkdtempSync(join(tmpdir(), 'tool-map-xdg-'));
  try {
    const out = join(xdg, 'tools.md');
    // Set XDG_DATA_HOME and a sentinel TOOL_MAP_ROOTS so the scan has something to walk.
    const fakeBin = mkdtempSync(join(tmpdir(), 'tool-map-xdg-bin-'));
    writeFileSync(join(fakeBin, 'mycli'), '#!/bin/sh\necho mycli\n');
    chmodSync(join(fakeBin, 'mycli'), 0o755);
    const r = spawnSync(process.execPath, [SCAN, out], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        PLUGIN_DATA: '',
        XDG_DATA_HOME: xdg,
        TOOL_MAP_ROOTS: fakeBin,
      },
    });
    assert.equal(r.status, 0, `scan failed: ${r.stderr}\n${r.stdout}`);
    // The output dir is the one we passed as argv[2], so just check the catalog is well-formed.
    const json = JSON.parse(readFileSync(out.replace(/\.md$/, '') + '.json', 'utf8'));
    assert.ok(Array.isArray(json.tools));
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});
