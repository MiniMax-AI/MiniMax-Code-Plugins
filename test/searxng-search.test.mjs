// Bridge from the repo's `node --test` to the Python regression suite.
// Spawns `python run_tests.py` and asserts a zero exit code. No network,
// no gh binary required — the Python suite is self-contained.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = join(
  __dirname,
  '..',
  'plugins',
  'Fectivnfy112357',
  'searxng-search',
  'skills',
  'searxng-search',
  'scripts',
);

test('searxng-search Python regression tests', () => {
  const r = spawnSync('python', [join(SCRIPT_DIR, 'run_tests.py')], {
    cwd: SCRIPT_DIR,
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
  }
  assert.equal(r.status, 0, 'python run_tests.py must exit 0');
});
