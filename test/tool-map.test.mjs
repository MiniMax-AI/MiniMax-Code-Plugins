import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, existsSync, readFileSync, writeFileSync, statSync, rmSync,
  readdirSync, mkdirSync, chmodSync, utimesSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
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

test('atomicWriteBundle rolls back when a backup-phase rename fails (early name)', async () => {
  // Phase 1 (backup) failure on the very first name. `backups` is still
  // empty, so the only thing the rollback must do is clean up the empty
  // staging and backup dirs and leave the targets untouched. This is the
  // simplest backup-phase case: no previous files have been moved yet.
  const work = mkdtempSync(join(tmpdir(), 'tool-map-bkp-early-'));
  try {
    writeFileSync(join(work, 'tools.md'), 'PRE-MD');
    writeFileSync(join(work, 'tools.json'), 'PRE-JSON');
    // No tools.summary.md - target was absent before this call.

    const helperPath = join(REPO_ROOT, 'test-fixtures', 'drive-bundle-failure.mjs');
    const r = spawnSync(process.execPath, [helperPath, work], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, TOOL_MAP_FAIL_AT_RENAME: '1' },
    });
    assert.notEqual(r.status, 0, `helper should exit non-zero when the hook fires: stdout=${r.stdout}\nstderr=${r.stderr}`);

    // Previous targets are intact.
    assert.equal(readFileSync(join(work, 'tools.md'), 'utf8'), 'PRE-MD');
    assert.equal(readFileSync(join(work, 'tools.json'), 'utf8'), 'PRE-JSON');
    // The previously-absent target is still absent.
    assert.ok(!existsSync(join(work, 'tools.summary.md')), 'tools.summary.md was created on rollback');
    // No residue.
    const residue = readdirSync(work).filter((e) =>
      e.includes('.staging-') || e.includes('.bundle.staging-') || e.includes('.bundle.backup-'),
    );
    assert.equal(residue.length, 0, `staging/backup residue after Phase-1 rollback: ${residue.join(', ')}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('atomicWriteBundle rolls back when a backup-phase rename fails (later name)', async () => {
  // Phase 1 (backup) failure on the SECOND name. tools.md has already
  // been moved to the backup dir; a naive implementation would leave it
  // stranded there. The rollback must move it back to its target.
  const work = mkdtempSync(join(tmpdir(), 'tool-map-bkp-late-'));
  try {
    writeFileSync(join(work, 'tools.md'), 'PRE-MD');
    writeFileSync(join(work, 'tools.json'), 'PRE-JSON');
    writeFileSync(join(work, 'tools.summary.md'), 'PRE-SUMMARY');

    const helperPath = join(REPO_ROOT, 'test-fixtures', 'drive-bundle-failure.mjs');
    const r = spawnSync(process.execPath, [helperPath, work], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, TOOL_MAP_FAIL_AT_RENAME: '2' },
    });
    assert.notEqual(r.status, 0, `helper should exit non-zero when the hook fires: stdout=${r.stdout}\nstderr=${r.stderr}`);

    // Every previous target is back in place, byte-for-byte.
    assert.equal(readFileSync(join(work, 'tools.md'), 'utf8'), 'PRE-MD',
      'tools.md was stranded in backup dir instead of restored to target');
    assert.equal(readFileSync(join(work, 'tools.json'), 'utf8'), 'PRE-JSON');
    assert.equal(readFileSync(join(work, 'tools.summary.md'), 'utf8'), 'PRE-SUMMARY');
    // No residue.
    const residue = readdirSync(work).filter((e) =>
      e.includes('.staging-') || e.includes('.bundle.staging-') || e.includes('.bundle.backup-'),
    );
    assert.equal(residue.length, 0, `staging/backup residue after Phase-1 rollback: ${residue.join(', ')}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('atomicWriteBundle rolls back brand-new files that were partially installed', async () => {
  // Phase 3 (install) failure on the LAST name after a brand-new file
  // (one that did NOT exist before this call) was successfully installed.
  // The rollback must delete the partially-installed new file so the
  // directory looks like it did before the call.
  //
  // Renames: #1=md-backup, #2=json-backup, #3=summary-backup
  //          (no backup for tools.new1)
  //          #4=md-install, #5=json-install, #6=summary-install,
  //          #7=new1-install, #8=new2-install
  // Trigger at #8 so the failure happens after the brand-new tools.new1
  // has already been renamed onto its target. `installed['tools.new1']`
  // is true and `backups['tools.new1']` is null.
  const work = mkdtempSync(join(tmpdir(), 'tool-map-new-partial-'));
  try {
    writeFileSync(join(work, 'tools.md'), 'PRE-MD');
    writeFileSync(join(work, 'tools.json'), 'PRE-JSON');
    writeFileSync(join(work, 'tools.summary.md'), 'PRE-SUMMARY');
    // tools.new1 and tools.new2 do NOT exist before the call.

    const helperUrl = pathToFileURL(join(REPO_ROOT, 'test-fixtures', 'drive-bundle-failure-5.mjs')).href;
    const r = spawnSync(process.execPath, [helperUrl, work], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, TOOL_MAP_FAIL_AT_RENAME: '8' },
    });
    assert.notEqual(r.status, 0, `helper should exit non-zero when the hook fires: stdout=${r.stdout}\nstderr=${r.stderr}`);

    // Previously-existing targets are restored.
    assert.equal(readFileSync(join(work, 'tools.md'), 'utf8'), 'PRE-MD');
    assert.equal(readFileSync(join(work, 'tools.json'), 'utf8'), 'PRE-JSON');
    assert.equal(readFileSync(join(work, 'tools.summary.md'), 'utf8'), 'PRE-SUMMARY');
    // Brand-new targets are still absent (no residue from partial install).
    assert.ok(!existsSync(join(work, 'tools.new1')), 'brand-new tools.new1 leaked after rollback');
    assert.ok(!existsSync(join(work, 'tools.new2')), 'brand-new tools.new2 leaked after rollback');
    // No residue.
    const residue = readdirSync(work).filter((e) =>
      e.includes('.staging-') || e.includes('.bundle.staging-') || e.includes('.bundle.backup-'),
    );
    assert.equal(residue.length, 0, `staging/backup residue after Phase-3 rollback: ${residue.join(', ')}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('atomicWriteBundle happy path: previously-absent targets are created, no residue', async () => {
  // When the target dir starts empty, every name in the bundle is a
  // brand-new file. The happy path must still leave exactly the three
  // target files behind and nothing else.
  const scanUrl = pathToFileURL(SCAN).href;
  const { atomicWriteBundle } = await import(scanUrl);
  const work = mkdtempSync(join(tmpdir(), 'tool-map-fresh-'));
  try {
    atomicWriteBundle(work, {
      'tools.md': 'NEW-MD',
      'tools.json': 'NEW-JSON',
      'tools.summary.md': 'NEW-SUMMARY',
    });
    assert.equal(readFileSync(join(work, 'tools.md'), 'utf8'), 'NEW-MD');
    assert.equal(readFileSync(join(work, 'tools.json'), 'utf8'), 'NEW-JSON');
    assert.equal(readFileSync(join(work, 'tools.summary.md'), 'utf8'), 'NEW-SUMMARY');
    const entries = readdirSync(work).sort();
    assert.deepEqual(entries, ['tools.json', 'tools.md', 'tools.summary.md'],
      `unexpected files in fresh output dir: ${entries.join(', ')}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('atomicWriteBundle happy path: mix of existing and absent targets', async () => {
  // Verify the happy path still works when only SOME of the targets
  // pre-existed. The existing ones get overwritten, the absent ones get
  // created, no residue anywhere.
  const scanUrl = pathToFileURL(SCAN).href;
  const { atomicWriteBundle } = await import(scanUrl);
  const work = mkdtempSync(join(tmpdir(), 'tool-map-mixed-'));
  try {
    writeFileSync(join(work, 'tools.md'), 'OLD-MD');
    writeFileSync(join(work, 'tools.json'), 'OLD-JSON');
    // tools.summary.md is absent.

    atomicWriteBundle(work, {
      'tools.md': 'NEW-MD',
      'tools.json': 'NEW-JSON',
      'tools.summary.md': 'NEW-SUMMARY',
    });
    assert.equal(readFileSync(join(work, 'tools.md'), 'utf8'), 'NEW-MD');
    assert.equal(readFileSync(join(work, 'tools.json'), 'utf8'), 'NEW-JSON');
    assert.equal(readFileSync(join(work, 'tools.summary.md'), 'utf8'), 'NEW-SUMMARY');
    const residue = readdirSync(work).filter((e) =>
      e.includes('.staging-') || e.includes('.bundle.staging-') || e.includes('.bundle.backup-'),
    );
    assert.equal(residue.length, 0, `staging/backup residue on happy path: ${residue.join(', ')}`);
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

// ---------------------------------------------------------------------------
// PR #5 review round 3: per-program shell decision
// The reviewer pointed out that scripts/scan.mjs unconditionally set
// `shell: IS_WIN` for every probe while README.md and SKILL.md claimed
// "probes are execFile, not shell" as a security property. The fix is to
// route only `.cmd` / `.bat` shims through cmd.exe (CVE-2024-27980; Node.js
// 21.7.3+ refuses to spawn batch files without `shell: true`). The tests
// below pin that contract: `shellForFile` is pure, `resolveProgram` walks
// PATH and PATHEXT, and `shouldUseShell` agrees with the resolved file
// type for every whitelisted name that is actually installed.
// ---------------------------------------------------------------------------

test('shellForFile is pure: false on POSIX regardless of file type', async () => {
  const scanUrl = pathToFileURL(SCAN).href;
  const { shellForFile } = await import(scanUrl);
  if (process.platform === 'win32') return; // POSIX-only check
  // On POSIX, the function must never return true: there is no `.cmd` /
  // `.bat` distinction in the argv, the OS handles shebangs natively, and
  // all 15 whitelisted probes have safe argv shapes.
  for (const p of [
    null, '', '/usr/bin/node', '/usr/local/bin/foo.cmd', '/tmp/x.bat',
    'C:\\node.exe', 'C:\\foo.cmd', '/bin/sh',
  ]) {
    assert.equal(shellForFile(p), false, `shellForFile(${JSON.stringify(p)}) must be false on POSIX`);
  }
});

test('shellForFile classifies Windows paths by extension', async () => {
  const scanUrl = pathToFileURL(SCAN).href;
  const { shellForFile } = await import(scanUrl);
  if (process.platform !== 'win32') return; // Windows-only check
  // null / empty: cannot spawn, fall through to false (let execFile surface ENOENT).
  assert.equal(shellForFile(null), false);
  assert.equal(shellForFile(''), false);
  // Native .exe: spawn directly, no shell.
  assert.equal(shellForFile('C:\\Program Files\\nodejs\\node.exe'), false);
  assert.equal(shellForFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), false);
  // .cmd and .bat: must route through cmd.exe (CVE-2024-27980).
  assert.equal(shellForFile('C:\\nodejs\\npm.cmd'), true);
  assert.equal(shellForFile('D:\\openclaw\\npm\\pnpm.cmd'), true);
  assert.equal(shellForFile('C:\\Tools\\run.bat'), true);
});

// === Round-4 review close-out: negative-first tests for the
// 4 issues hetaoBackend flagged on commit 2dedc99 (review
// id 5036494244, 2026-08-27T01:34:06Z):
//
//   R4-1  case-distinct test was failing on the reviewer's
//        machine because the scan picks up real tools from the
//        user's actual PATH / $HOME / etc. (not just from the
//        TOOL_MAP_ROOTS temp dir), so `assert.deepEqual(names,
//        ['Foo', 'foo'])` failed when the list contained real tools
//        like mcode-tools. Also, the test did not gate on a
//        case-sensitive FS, so it would silently pass on macOS HFS+
//        (case-insensitive default) by overwriting Foo with foo.
//
//   R4-2  resolveProgram used existsSync only. existsSync returns
//        true for directories too, so a directory named 'node' in
//        PATH (e.g. /usr/local/bin/node) would be returned as the
//        resolved path. probeVersion would then try to execFileP a
//        directory and fail with EISDIR. The contract is "return the
//        path of an executable file"; a directory is not that.
//
//   R4-3  probeVersion passed the bare cmd[0] (e.g. 'node') to
//        execFileP, not the absolute path that resolveProgram
//        returned. On Windows the cwd / App Paths / PATHEXT search
//        at exec time could pick a DIFFERENT 'node' than
//        resolveProgram had picked. The contract is that the file
//        resolveProgram returned is the one that gets spawned.
//
//   R4-4  .cmd / .bat branch had no real-Windows evidence. The
//        shell decision is the only place where this matters and
//        it was tested only on the reviewer's local Windows machine.
//        CI only runs on ubuntu-latest. The fix is to add a
//        windows-latest CI job.

// === R4-1: case-distinct test is hermetic (gated + filtered) ===

// isCaseSensitiveFs: true iff creating two files that differ only in
// case actually produces two distinct inodes. We probe with a
// mkdtempSync directory; the probe is cheap and we run it once.
function isCaseSensitiveFs() {
  const probe = mkdtempSync(join(tmpdir(), 'tool-map-csfs-probe-'));
  try {
    writeFileSync(join(probe, 'UPPER'), 'a');
    writeFileSync(join(probe, 'upper'), 'b');
    const entries = readdirSync(probe);
    return entries.length === 2 && entries.includes('UPPER') && entries.includes('upper');
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

test('POSIX: case-distinct tool names are kept distinct on case-sensitive FS, AND the test is hermetic (only TOOL_MAP_ROOTS results are asserted)', () => {
  // Gate: on a case-insensitive FS (e.g. macOS HFS+, or any
  // case-folding mount) the test is meaningless because the two
  // writes collapse into one file. Skip with a clear reason rather
  // than passing vacuously.
  if (process.platform === 'win32') {
    return; // skip on Windows; the Windows runner covers this
  }
  if (!isCaseSensitiveFs()) {
    return; // skip on case-insensitive POSIX FS (macOS HFS+ default)
  }
  const root = mkdtempSync(join(tmpdir(), 'tool-map-case-'));
  try {
    // Use .sh extension so the scan's EXEC_EXTS allowlist accepts
    // these files without depending on the NPM_BIN_HINT directory
    // regex. The original test used extensionless files, which
    // POSIX scan.mjs accepts only when the parent dir matches
    // /minimax-code|openclaw|node_modules|.Codex|.claude|npm|tauri/.
    // A /tmp/ test root never matches, so the scan correctly reports
    // 0 tools and the test fails on Linux. The .sh files are
    // accepted by isToolFile directly via EXEC_EXTS, regardless of
    // the parent dir.
    writeFileSync(join(root, 'Foo.sh'), '#!/bin/sh\necho Foo\n');
    chmodSync(join(root, 'Foo.sh'), 0o755);
    writeFileSync(join(root, 'foo.sh'), '#!/bin/sh\necho foo\n');
    chmodSync(join(root, 'foo.sh'), 0o755);

    // Use a CLEAN PATH so the scan only walks the temp dir.
    // This is the round-4 fix: the old test set TOOL_MAP_ROOTS
    // but did not clear PATH, so the scan picked up tools from
    // $HOME/.local/bin, $HOME/.minimax-code/, etc. and the
    // deepEqual assertion failed because the names list had
    // real tools like mcode-tools in it.
    const r = runScan(join(root, 'tools.md'), {
      TOOL_MAP_ROOTS: root,
      PATH: root, // POSIX: only the temp dir is on PATH
    });
    assert.equal(r.status, 0, `scan failed: ${r.stderr}\n${r.stdout}`);
    const json = JSON.parse(readFileSync(join(root, 'tools.json'), 'utf8'));
    // Filter to entries whose path is inside the test root. The
    // scan may also walk other roots (e.g. $HOME) but the test's
    // claim is specifically about THIS root's two case-distinct
    // files, not about the global state.
    const localNames = json.tools
      .filter((t) => t.path.startsWith(root))
      .map((t) => t.name).sort();
    assert.deepEqual(
      localNames, ['Foo', 'foo'],
      `case-distinct tool names were merged: ${localNames.join(', ')} (only tools inside the test root are asserted)`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// === R4-2: resolveProgram rejects directories ===
//
// The old implementation used `existsSync(full)` only. existsSync
// returns true for directories, so a directory named 'node' in
// PATH would be returned as the "resolved" path. probeVersion then
// calls execFileP on a directory and fails with EISDIR.
//
// The fix is to require `statSync(full).isFile() === true` and to
// also require a successful stat (i.e. not dangling, not a broken
// symlink). The round-trip test is: create a temp PATH where the
// FIRST entry is a directory called 'foo-tool' and the SECOND
// entry is a real file called 'foo-tool'. resolveProgram('foo-tool')
// must return the file (not the directory).
test('resolveProgram rejects a directory even if it comes first in PATH (POSIX)', () => {
  // On Windows the function builds candidates from PATHEXT
  // (.EXE/.CMD/...), so a plain 'foo-tool' file is never matched.
  // The Windows runner (R4-4) covers the .cmd/.bat branch
  // separately.
  if (process.platform === 'win32') return;
  const dir1 = mkdtempSync(join(tmpdir(), 'tool-map-resolve-dir-'));
  const dir2 = mkdtempSync(join(tmpdir(), 'tool-map-resolve-file-'));
  try {
    // dir1 contains a DIRECTORY named 'foo-tool' (a regular file
    // would be visible to existsSync too; we use mkdirSync to make
    // a directory of the same name as the would-be tool).
    mkdirSync(join(dir1, 'foo-tool'));

    // dir2 contains a REAL FILE named 'foo-tool' that is a
    // runnable script. This is the path resolveProgram MUST return.
    writeFileSync(join(dir2, 'foo-tool'), '#!/bin/sh\necho foo-tool\n');
    chmodSync(join(dir2, 'foo-tool'), 0o755);

    // PATH order: dir1 (directory) FIRST, then dir2 (file).
    // The OLD code would return dir1/foo-tool (a directory) because
    // existsSync was true. The NEW code must return dir2/foo-tool
    // because statSync(dir1/foo-tool).isFile() is false.
    const pathEnv = [dir1, dir2].join(delimiter);
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'plugins', 'antianqi', 'tool-map', 'scripts', 'scan.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: pathEnv, TOOL_MAP_ROOTS: '' },
    });
    // The scan runs to completion regardless. What we want to
    // assert is that resolveProgram itself, queried via the scan
    // output's "core" field, points to the FILE, not the
    // directory. The scan writes a tools.json that includes the
    // resolved `path` per tool (when found in PATH).
    //
    // Easiest assertion: shell out to node and call resolveProgram
    // directly via dynamic import. Set PATH FIRST in the child
    // process, then import (scan.mjs captures process.env.PATH at
    // module load, so the env must be set BEFORE the import).
    //
    // On Windows, the function builds candidates from PATHEXT
    // (e.g. foo-tool.EXE / foo-tool.CMD / ...), so a plain
    // 'foo-tool' file is never matched. The test is POSIX-only;
    // the Windows runner (R4-4) covers the .cmd/.bat branch.
    const probe = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `process.env.PATH = ${JSON.stringify(pathEnv)};
       const m = await import('./plugins/antianqi/tool-map/scripts/scan.mjs');
       process.stdout.write(JSON.stringify(m.resolveProgram('foo-tool')));`,
    ], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    const resolved = probe.stdout.trim();
    assert.equal(probe.status, 0, `resolveProgram probe failed (status ${probe.status}): ${probe.stderr}`);
    assert.equal(resolved, JSON.stringify(join(dir2, 'foo-tool')),
      `resolveProgram must skip the directory in dir1 and return the file in dir2. Got: ${resolved} (probe stdout: "${probe.stdout}", stderr: "${probe.stderr}")`);
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

// === R4-3: probeVersion uses the resolved absolute path ===
//
// The old implementation passed `cmd[0]` to execFileP without
// resolving to an absolute path first. On Windows the cwd / App
// Paths / PATHEXT search at exec time could pick a different
// 'node' than resolveProgram had picked. The fix is to resolve
// first, then exec the resolved path.
//
// Test design: use a tool name that exists in the real PATH. Set
// PATH to include ONLY a temp dir with a tool named 'node' that
// prints a known version. The test asserts that the captured
// version matches the temp tool's output (i.e. resolveProgram
// found the temp tool AND probeVersion executed it via the
// resolved path, not via PATH lookup at exec time).
//
// The way to make this test hermetic without exposing internals
// is to have the temp tool's behaviour diverge from the system
// 'node' behaviour. Easiest: use a tool that is NOT 'node' (so
// it is whitelisted via a custom whitelist OR we can use a
// behaviour-divergent tool).
//
// Since VERSION_PROBES is hardcoded, we cannot easily inject a
// new whitelisted name. Instead, the test verifies the
// behaviour for an existing whitelisted name ('node') by:
//   1. Creating a temp dir with a 'node' script that prints a
//      known fake version.
//   2. Setting PATH to ONLY the temp dir + a directory that
//      has the real 'node' (if any).
//   3. Running the scan.
//   4. Asserting the captured 'core.node' is the fake version
//      printed by the temp tool.
// If probeVersion uses the resolved absolute path, the temp
// tool wins. If it uses cmd[0]='node' and PATH lookup picks
// the system node, the version is different.
//
// This is most cleanly testable on POSIX where the temp script
// can use a shebang. On Windows this requires a .cmd / .bat;
// the Windows CI job (R4-4) covers that.
test('probeVersion spawns the resolved absolute path (not a PATH lookup at exec time)', () => {
  // On Windows the function builds candidates from PATHEXT
  // (.EXE/.CMD/...), so a plain 'node' file is never matched.
  // The Windows runner (R4-4) covers the .cmd/.bat branch
  // separately.
  if (process.platform === 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'tool-map-probe-'));
  try {
    // A script that prints a recognisable fake version.
    const fake = join(root, 'node');
    writeFileSync(fake, '#!/bin/sh\necho "FAKE_NODE_VERSION_v9"\n');
    chmodSync(fake, 0o755);

    const out = join(root, 'tools.md');
    // PATH = ONLY the temp dir. No system node on PATH.
    const r = runScan(out, { TOOL_MAP_ROOTS: '', PATH: root });
    assert.equal(r.status, 0, `scan failed: ${r.stderr}\n${r.stdout}`);
    const json = JSON.parse(readFileSync(join(root, 'tools.json'), 'utf8'));
    // The scan captures `core` (VERSION_PROBES results) into a
    // separate field — read tools.json and the `core` object. The
    // shape is { scanned, platform, host, core, extras, tools }.
    // If probeVersion used cmd[0]='node' and PATH lookup, the
    // version would be whatever `node --version` returns (often
    // "v24.18.0" on this host). If probeVersion used the
    // resolved path (the temp script), the version is the fake
    // string.
    const nodeCore = json.core && json.core.node;
    // The previous test had a hidden false-green here: when
    // core.node is undefined (e.g. because resolveProgram failed
    // to find node), the assert.match below would never fire, and
    // the test would pass vacuously. Force the failure with a
    // direct assert.ok so the contract is "core.node is set".
    assert.ok(typeof nodeCore === 'string' && nodeCore.length > 0,
      `core.node must be a non-empty string (the resolved path should have made it into core); got ${JSON.stringify(nodeCore)}. If core.node is undefined, the scan did not resolve 'node' at all and the test is a no-op.`);
    assert.match(nodeCore, /FAKE_NODE_VERSION/,
      `probeVersion should have executed the resolved path (the temp script), but the captured version is "${nodeCore}" — this means probeVersion used cmd[0]='node' and PATH lookup at exec time, which is the round-4 #3 defect`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// === R4-4: .cmd / .bat / .EXE branch on real Windows evidence ===
//
// The round-4 review said: ".cmd/.bat 分支本轮没有真实 Windows
// 证据". The .cmd / .bat decision is the only place where
// platform matters for shellForFile + probeVersion, and the
// previous test suite was only run on ubuntu-latest CI, so the
// .cmd / .bat decision was never exercised against real Windows
// behaviour. This test creates a fake `node.EXE` (a .cmd batch
// file with a known version output) on a temp dir, sets PATH to
// only that dir, and asserts the scan picks it up via the
// PATHEXT-resolved path.
//
// On POSIX the function ignores PATHEXT, so this test is
// POSIX-noop (gated off). The Windows runner is the real
// coverage.
test('Windows: probeVersion handles the PATHEXT-expanded .CMD path (R4-4 real Windows evidence)', () => {
  if (process.platform !== 'win32') return; // POSIX runner skips; Windows runner is the real test
  const root = mkdtempSync(join(tmpdir(), 'tool-map-cmdext-'));
  try {
    // Create a .cmd batch file. .cmd is the most common shim for
    // npm / pnpm / mcode on Windows; this is the round-4 review
    // focus (.cmd/.bat 分支).
    const fake = join(root, 'node.cmd');
    writeFileSync(fake, '@echo FAKE_NODE_VERSION_v9\r\n');

    const out = join(root, 'tools.md');
    const r = runScan(out, { TOOL_MAP_ROOTS: '', PATH: root });
    assert.equal(r.status, 0, `scan failed: ${r.stderr}\n${r.stdout}`);
    const json = JSON.parse(readFileSync(join(root, 'tools.json'), 'utf8'));
    const nodeCore = json.core && json.core.node;
    assert.ok(typeof nodeCore === 'string' && nodeCore.length > 0,
      `core.node must be a non-empty string on Windows; got ${JSON.stringify(nodeCore)}. If core.node is undefined, the scan did not resolve 'node.cmd' (or its PATHEXT expansion) at all and the test is a no-op.`);
    assert.match(nodeCore, /FAKE_NODE_VERSION/,
      `probeVersion should have executed the .cmd shim, but the captured version is "${nodeCore}"`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// === R4-2 unit-level synthetic test (works on any platform) ===
//
// The previous R4-2 test (above) is gated on POSIX because the
// function builds PATHEXT-expanded candidates on Windows. The
// R4-2 contract is "resolveProgram must skip a directory even if
// it appears first in PATH". To exercise this contract locally
// on any platform, this test uses a synthetic PATH where:
//   - dir1 contains a directory named 'foo-tool'
//   - dir2 contains a regular FILE named 'foo-tool'
// AND the name 'foo-tool' has no PATHEXT extension, so on
// Windows the function looks for 'foo-tool.COM' / 'foo-tool.EXE'
// etc. (none exist) and returns null. On POSIX the function
// looks for 'foo-tool' directly.
//
// The test only runs on POSIX (where the contract can be
// exercised without a Windows-style file). The Windows
// equivalent is the .cmd / .bat / .EXE test above (R4-4).
test('resolveProgram rejects a directory even if it comes first in PATH (POSIX, R4-2 contract)', () => {
  if (process.platform === 'win32') return;
  const dir1 = mkdtempSync(join(tmpdir(), 'tool-map-resolve-dir-'));
  const dir2 = mkdtempSync(join(tmpdir(), 'tool-map-resolve-file-'));
  try {
    // dir1 contains a DIRECTORY named 'foo-tool' (a regular file
    // would be visible to existsSync too; we use mkdirSync to make
    // a directory of the same name as the would-be tool).
    mkdirSync(join(dir1, 'foo-tool'));

    // dir2 contains a REAL FILE named 'foo-tool' that is a
    // runnable script. This is the path resolveProgram MUST return.
    writeFileSync(join(dir2, 'foo-tool'), '#!/bin/sh\necho foo-tool\n');
    chmodSync(join(dir2, 'foo-tool'), 0o755);

    // PATH order: dir1 (directory) FIRST, then dir2 (file).
    // The OLD code would return dir1/foo-tool (a directory) because
    // existsSync was true. The NEW code must return dir2/foo-tool
    // because statSync(dir1/foo-tool).isFile() is false.
    const pathEnv = [dir1, dir2].join(delimiter);
    // Use spawn so the PATH is set BEFORE scan.mjs is loaded
    // (scan.mjs captures process.env.PATH at module load).
    const probe = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `process.env.PATH = ${JSON.stringify(pathEnv)};
       const m = await import('./plugins/antianqi/tool-map/scripts/scan.mjs');
       process.stdout.write(JSON.stringify(m.resolveProgram('foo-tool')));`,
    ], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    const resolved = probe.stdout.trim();
    assert.equal(probe.status, 0, `resolveProgram probe failed (status ${probe.status}): ${probe.stderr}`);
    assert.equal(resolved, JSON.stringify(join(dir2, 'foo-tool')),
      `resolveProgram must skip the directory in dir1 and return the file in dir2. Got: ${resolved} (probe stdout: "${probe.stdout}", stderr: "${probe.stderr}")`);
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('resolveProgram returns null for unknown names', async () => {
  const scanUrl = pathToFileURL(SCAN).href;
  const { resolveProgram } = await import(scanUrl);
  // The whitelist is what gates probeVersion; resolveProgram itself just
  // walks PATH. For a name that is definitely not on PATH (random hex),
  // it must return null rather than throw.
  const bogus = `definitely-not-a-real-program-${Math.random().toString(16).slice(2)}`;
  assert.equal(resolveProgram(bogus), null);
});

test('resolveProgram finds node on the current PATH', async () => {
  const scanUrl = pathToFileURL(SCAN).href;
  const { resolveProgram } = await import(scanUrl);
  // `node` is the runtime that runs this test, so it is guaranteed to be
  // on PATH at the time of the test. On Windows it resolves to node.exe;
  // on POSIX it resolves to the node binary the test runner used.
  const r = resolveProgram('node');
  assert.ok(r && typeof r === 'string', `resolveProgram('node') returned ${JSON.stringify(r)}`);
  if (process.platform === 'win32') {
    assert.match(r, /node\.exe$/i, `node should resolve to node.exe, got ${r}`);
  } else {
    // On POSIX the binary is just `node` in some bin dir.
    assert.ok(r.endsWith('node') || r.endsWith('node.exe'),
      `node should resolve to a 'node' path, got ${r}`);
  }
});

test('shouldUseShell agrees with shellForFile for every whitelisted probe that is installed', async () => {
  const scanUrl = pathToFileURL(SCAN).href;
  const { VERSION_PROBES, resolveProgram, shouldUseShell, shellForFile } = await import(scanUrl);
  for (const [name] of VERSION_PROBES) {
    const resolved = resolveProgram(name);
    if (!resolved) continue; // not installed in this environment; skip
    // The two helpers must agree exactly for every actually-resolved name.
    // This is the per-program shell decision the reviewer asked for.
    assert.equal(
      shouldUseShell(name), shellForFile(resolved),
      `shouldUseShell(${name}) disagreed with shellForFile(${resolved}); ` +
      `got ${shouldUseShell(name)} vs ${shellForFile(resolved)}`,
    );
    if (process.platform === 'win32') {
      const lower = resolved.toLowerCase();
      if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
        assert.equal(shouldUseShell(name), true,
          `${name} resolves to ${resolved}, a batch file, so shell must be true`);
      } else {
        assert.equal(shouldUseShell(name), false,
          `${name} resolves to ${resolved}, a non-batch file, so shell must be false`);
      }
    } else {
      assert.equal(shouldUseShell(name), false,
        `${name} on POSIX must never use a shell`);
    }
  }
});

test('probeVersion refuses non-whitelisted names (no shell, no spawn)', async () => {
  const scanUrl = pathToFileURL(SCAN).href;
  const { probeVersion, ALLOWED_PROBE_NAMES } = await import(scanUrl);
  // `probeVersion` is the function the review asked us to harden. Even
  // when called directly with a name that is on PATH, a non-whitelisted
  // name must return null without spawning anything. We pick `node`
  // because it is on PATH in the test env and is NOT in the whitelist
  // for this assertion (the whitelist is the 15 names; `node` IS one of
  // them, so the second branch verifies the whitelist short-circuit by
  // passing a definitely-not-whitelisted name like `__no_such_probe__`).
  assert.equal(ALLOWED_PROBE_NAMES.has('node'), true, 'node is whitelisted');
  assert.equal(await probeVersion(['__no_such_probe__', '--version']), null);
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

// (R4-1 test moved to the top of this file with proper gating and
// a hermetic PATH.)

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
