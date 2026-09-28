import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  sqliteCandidates,
  sessionsCandidates,
  resolveDataDir,
} from '../server/config.mjs';
import { resolveSqliteFile } from '../server/sqlite.mjs';
import { resolveSessionsRoot } from '../server/fsutil.mjs';
import { openStore } from '../server/store.mjs';

/**
 * Portability of the paths.
 *
 * The Plugin has to locate the runtime's data on whatever machine it is installed
 * on: the data directory comes from the environment (or the platform's home
 * variable), and the paths inside it are resolved against what is actually there
 * rather than assuming one layout. Nothing may hardcode this machine's paths.
 *
 * `~/.minimax` is deliberately NOT treated as a violation: it is the runtime's
 * documented default data directory, not a maintainer-local path. What is
 * forbidden is a path that names a real user's home.
 */

const PLUGIN = path.join(import.meta.dirname, '..');
const SELF = path.join('test', 'portable-paths.test.mjs');

// This file necessarily contains the patterns it forbids, so it is skipped.
const FORBIDDEN = [
  { label: 'a POSIX home directory', re: /\/home\/[A-Za-z0-9._-]+\//u },
  { label: 'a macOS home directory', re: /\/Users\/[A-Za-z0-9._-]+\//u },
  { label: 'a Windows home directory', re: /[A-Za-z]:\\+Users\\+/u },
  { label: 'a literal ${HOME}', re: /\$\{HOME\}/u },
  { label: 'a literal ${USERPROFILE}', re: /\$\{USERPROFILE\}/u },
  { label: 'a host placeholder', re: /\$\{HOST_[A-Z_]+\}/u },
];

async function collectFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collectFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

test('no shipped file hardcodes a path belonging to a particular machine', async () => {
  const offenders = [];
  for (const rel of await collectFiles(PLUGIN)) {
    if (rel === SELF) continue;
    if (!/\.(?:mjs|js|md|json|css|html|txt)$/u.test(rel)) continue;
    const text = await readFile(path.join(PLUGIN, rel), 'utf8');
    for (const { label, re } of FORBIDDEN) {
      if (re.test(text)) offenders.push(`${rel} contains ${label}`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('; '));
});

test('the guard is not vacuous', () => {
  const samples = [
    '/home/someone/project/file',
    '/Users/someone/Library/thing',
    'C:\\Users\\someone\\AppData',
    '${HOME}/thing',
    '${USERPROFILE}/thing',
    '${HOST_TMP}/thing',
  ];
  for (const sample of samples) {
    assert.ok(
      FORBIDDEN.some(({ re }) => re.test(sample)),
      `sample should be rejected: ${sample}`,
    );
  }
  // The runtime's documented default is not a machine path.
  assert.ok(!FORBIDDEN.some(({ re }) => re.test('~/.minimax')), '~/.minimax must stay allowed');
});

test('candidate lists put the canonical layout first', () => {
  const dataDir = path.join('/srv', 'data');
  assert.equal(sqliteCandidates(dataDir)[0], path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  assert.equal(sessionsCandidates(dataDir)[0], path.join(dataDir, 'v2', 'sessions'));
  assert.ok(sqliteCandidates(dataDir).length > 1, 'there must be alternatives to fall back to');
  assert.ok(sessionsCandidates(dataDir).length > 1, 'there must be alternatives to fall back to');
});

test('the projection is found wherever this machine keeps it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'trajectory-paths-'));

  // Nothing there yet: the canonical path is reported without claiming a hit.
  const missing = resolveSqliteFile(root);
  assert.equal(missing.found, false);
  assert.equal(missing.discovered, false);
  assert.equal(missing.file, sqliteCandidates(root)[0]);

  // The canonical layout.
  const canonicalDir = path.join(root, 'v2', 'sqlite');
  await mkdir(canonicalDir, { recursive: true });
  const canonical = path.join(canonicalDir, 'runtime-state.sqlite');
  await writeFile(canonical, '');
  const hit = resolveSqliteFile(root);
  assert.equal(hit.file, canonical);
  assert.equal(hit.discovered, false, 'the canonical layout is not a discovery');

  // A differently laid-out build is still found, and reported as a discovery.
  const otherRoot = await mkdtemp(path.join(tmpdir(), 'trajectory-paths-'));
  const otherDir = path.join(otherRoot, 'sqlite');
  await mkdir(otherDir, { recursive: true });
  const other = path.join(otherDir, 'runtime-state.sqlite');
  await writeFile(other, '');
  const fallback = resolveSqliteFile(otherRoot);
  assert.equal(fallback.file, other);
  assert.equal(fallback.discovered, true, 'a non-canonical hit must be surfaced');

  const sessionsFallback = resolveSessionsRoot(otherRoot);
  assert.equal(sessionsFallback.found, false, 'no session artifacts in this fixture');

  await rm(root, { recursive: true, force: true });
  await rm(otherRoot, { recursive: true, force: true });
});

test('a store opens a projection that is not in the canonical location, and says so', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-store-'));
  const dir = path.join(dataDir, 'sqlite');
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'runtime-state.sqlite'));
  db.exec('CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)');
  db.close();

  const warnings = [];
  const store = openStore({ dataDir, warnings });
  try {
    assert.ok(store.db, 'the projection at the alternative path must open');
    assert.equal(store.sqliteFile, path.join(dir, 'runtime-state.sqlite'));
    assert.ok(
      warnings.some((w) => w.startsWith('sqlite_discovered:')),
      `a discovery must be recorded, got ${JSON.stringify(warnings)}`,
    );
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the data directory follows the environment, never a baked-in location', () => {
  // Resolved, not passed through: comparing against the literal only holds on a
  // POSIX host, and this assertion is about the environment winning, not about the
  // separator a host happens to use.
  const home = path.resolve('/tmp', 'portable-home');
  assert.equal(resolveDataDir({ MINIMAX_DATA_DIR: '/tmp/explicit' }), path.resolve('/tmp/explicit'));
  assert.equal(resolveDataDir({ USERPROFILE: home }), path.join(home, '.minimax'));
  assert.equal(resolveDataDir({ HOME: home }), path.join(home, '.minimax'));
});
