import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, existsSync, readFileSync, statSync, rmSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// This test lives at <repo>/test/tool-map.test.mjs, so REPO_ROOT is the
// parent of the test/ directory.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'antianqi', 'tool-map');
const SCAN = join(PLUGIN_DIR, 'scripts', 'scan.mjs');
const SMOKE = join(PLUGIN_DIR, 'scripts', 'smoke.mjs');

function runScan(outPath) {
  return spawnSync(process.execPath, [SCAN, outPath], {
    encoding: 'utf8',
    timeout: 30_000,
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
      assert.ok(!e.includes('.staging-'), `staging file leaked: ${e}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('scan.mjs completes with an empty PATH and still produces a valid catalog', () => {
  // The scanner must not crash if $PATH is empty (a valid CI / sandbox
  // configuration). Known roots may still produce entries; what matters is
  // that the run returns 0 and the catalog is well-formed.
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
    // No tool whose `category` is exactly 'PATH' should appear when PATH is empty.
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
