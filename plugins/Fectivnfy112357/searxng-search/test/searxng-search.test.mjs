// Bridge from the repo's `node --test` to this plugin's Python regression
// suite. Lives inside the Plugin directory so the Plugin stays a portable,
// self-contained contribution: nothing outside plugins/<owner>/<plugin> is
// modified. `node --test` at the repository root discovers this file
// recursively.
//
// Spawns the first available Python interpreter (python3, python, py -3)
// and asserts a zero exit code. No network, no gh binary required — the
// Python suite is self-contained.
//
// Interpreter discovery:
//   - On Windows, prefer `py -3` (the official Python launcher), then
//     fall back to `python` and `python3`.
//   - On POSIX, prefer `python3`, then `python`.
//   - Each candidate is checked by `version --version` so a non-Python
//     stub (a Windows command name collision, a `py` shim that is
//     actually pip) fails fast and we move on to the next candidate.
//   - If no interpreter is found, the test fails with an explicit
//     diagnostic instead of producing a pass that misleads CI.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = join(
  __dirname,
  '..',
  'skills',
  'searxng-search',
  'scripts',
);

const isWindows = process.platform === 'win32';

const CANDIDATES = isWindows
  ? [
      { cmd: 'py', args: ['-3', '--version'] },
      { cmd: 'py', args: ['--version'] },
      { cmd: 'python', args: ['--version'] },
      { cmd: 'python3', args: ['--version'] },
    ]
  : [
      { cmd: 'python3', args: ['--version'] },
      { cmd: 'python', args: ['--version'] },
    ];

function findPython() {
  for (const c of CANDIDATES) {
    const r = spawnSync(c.cmd, c.args, { encoding: 'utf-8' });
    if (r.status === 0) {
      return { cmd: c.cmd, prefix: c.cmd === 'py' ? ['-3'] : [] };
    }
  }
  return null;
}

test('searxng-search Python regression tests', () => {
  const py = findPython();
  assert.ok(py, `no usable Python interpreter found; tried: ${CANDIDATES.map((c) => `${c.cmd} ${c.args.join(' ')}`).join(', ')}`);

  const r = spawnSync(py.cmd, [...py.prefix, join(SCRIPT_DIR, 'run_tests.py')], {
    cwd: SCRIPT_DIR,
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
  }
  assert.equal(r.status, 0, 'python run_tests.py must exit 0');
});
