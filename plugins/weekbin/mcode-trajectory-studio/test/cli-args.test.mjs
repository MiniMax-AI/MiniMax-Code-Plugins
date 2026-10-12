/**
 * The entry point's command line.
 *
 * `server/main.mjs` had 35% branch coverage — the lowest in the package — and the
 * uncovered branches were not cosmetic. Every malformed invocation used to fall
 * through to the default stdio mode and exit `0`:
 *
 *   --doctr            a typo, silently ignored
 *   --session --doctor the value of `--session` swallows `--doctor`; diagnostics
 *                      become a stdio server that prints nothing
 *   --port abc         NaN port, silently treated as "any port"
 *   --session          missing value, silently null
 *   --help             the most natural request for help, answered with silence
 *
 * All six produced empty output and a success code, so a script could not tell them
 * from a correct run and a user could not tell that the Plugin had not answered.
 *
 * `parseArgs` is exported so these are unit tests of the decision itself rather than
 * of a subprocess's exit code; the subprocess behaviour is pinned below as well,
 * because "throws when imported" and "a user running the wrong command finds out"
 * are different claims and only the second one is the contract.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { HELP_FLAGS, MODE_FLAGS, parseArgs, UsageError, VALUE_FLAGS } from '../server/main.mjs';

const run = promisify(execFile);
const ENTRY = path.join(import.meta.dirname, '..', 'server', 'main.mjs');

/** Run the entry point and report what a caller could actually observe. */
async function invoke(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [ENTRY, ...args], { timeout: 15000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/* --------------------------------------------------------------- accepted -- */

test('no arguments is the stdio mode mcode launches', () => {
  assert.deepEqual(parseArgs([]), { mode: 'stdio', port: null, sessionId: null, help: false });
});

test('the documented modes are recognised, including the --http alias for --serve', () => {
  assert.equal(parseArgs(['--stdio']).mode, 'stdio');
  assert.equal(parseArgs(['--serve']).mode, 'serve');
  assert.equal(parseArgs(['--http']).mode, 'serve');
  assert.equal(parseArgs(['--doctor']).mode, 'doctor');
});

test('--serve takes a port and a session', () => {
  const args = parseArgs(['--serve', '--port', '4777', '--session', 'sess-a']);
  assert.deepEqual(args, { mode: 'serve', port: 4777, sessionId: 'sess-a', help: false });
});

test('the last of two modes wins, as it did before', () => {
  assert.equal(parseArgs(['--doctor', '--serve']).mode, 'serve');
});

test('a port may be 0, which asks the OS for a free one', () => {
  assert.equal(parseArgs(['--serve', '--port', '0']).port, 0);
});

/* --------------------------------------------------------------- rejected -- */

test('a flag is never eaten as another flag\'s value', () => {
  // The defect this file exists for. Both tokens are recognised, so nothing else in
  // the program could report the conflict: `--doctor` became the session id and the
  // request for diagnostics ran a stdio server instead.
  for (const argv of [['--session', '--doctor'], ['--port', '--serve'], ['--port', '--port', '1']]) {
    assert.throws(
      () => parseArgs(argv),
      (error) => error instanceof UsageError && /needs a value/u.test(error.message),
      `${argv.join(' ')} was accepted`,
    );
  }
});

test('a flag at the end of the line has no value to take', () => {
  assert.throws(() => parseArgs(['--port']), /--port needs a value/u);
  assert.throws(() => parseArgs(['--session']), /--session needs a value/u);
});

test('an unrecognised token is named rather than ignored', () => {
  assert.throws(() => parseArgs(['--doctr']), /unknown argument: --doctr/u);
  assert.throws(() => parseArgs(['-x']), /unknown argument: -x/u);
});

test('a port that is not a port is rejected with the value it was given', () => {
  for (const bad of ['abc', '99999', '-1']) {
    assert.throws(() => parseArgs(['--port', bad]), /--port must be a number between 0 and 65535/u);
  }
});

test('every rejection is a UsageError, so the handler can tell it from a crash', () => {
  for (const argv of [['--doctr'], ['--port'], ['--port', 'abc'], ['--session', '--doctor']]) {
    assert.throws(() => parseArgs(argv), UsageError, `${argv.join(' ')} threw the wrong kind`);
  }
});

/* ------------------------------------------------------------- observable -- */

test('--help prints usage and exits 0', async () => {
  const { code, stdout } = await invoke(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /mcode-trajectory-studio/u);
  // The flags it documents must be the flags it accepts, or help is a second defect.
  for (const flag of ['--stdio', '--serve', '--port', '--session', '--doctor']) {
    assert.ok(stdout.includes(flag), `usage does not mention ${flag}`);
  }
});

test('a wrong command line exits non-zero, names the problem, and prints usage', async () => {
  for (const args of [['--doctr'], ['--session', '--doctor'], ['--port', 'abc']]) {
    const { code, stdout, stderr } = await invoke(args);
    assert.equal(code, 1, `${args.join(' ')} exited 0`);
    assert.equal(stdout, '', `${args.join(' ')} wrote to stdout instead of stderr`);
    assert.match(stderr, /unknown argument|--port needs a value|--session needs a value|--port must be/u);
    assert.match(stderr, /node server\/main\.mjs/u, 'the failure does not say how to fix it');
  }
});

test('--doctor still answers, and still answers on stdout', async () => {
  const { code, stdout } = await invoke(['--doctor']);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.node, process.version);
  assert.ok('sqlitePath' in parsed && 'ftsAvailable' in parsed);
});

test('--help does not open the projection', async () => {
  // Help that reads the user's data directory is help with a side effect, and a
  // `--help` in a shell pipeline should not depend on a readable projection.
  const { code, stdout } = await invoke(['--help']);
  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /runtime-state\.sqlite/u);
});

test('the help text names every flag the parser accepts', async () => {
  // The help text is the CLI's contract, and it is the only description of the
  // surface a user can reach — there is no man page and no other docs. It had already
  // drifted: `--http` and `-h` were both honoured while the help listed neither, so a
  // person reading it could not know the flag they had just used successfully was
  // real, nor guess it next time. The flag sets are exported precisely so this walks
  // the parser's own set instead of a copy that could drift the same way.
  const { code, stdout } = await invoke(['--help']);
  assert.equal(code, 0);
  for (const flag of [...MODE_FLAGS, ...VALUE_FLAGS, ...HELP_FLAGS]) {
    assert.ok(stdout.includes(flag), `${flag} is accepted but the help never mentions it`);
  }
  // And every flag in the help text is one the parser actually honours, so the
  // contract cannot grow a line that reads as an instruction and does nothing.
  for (const flag of stdout.match(/--[a-z-]+/gu) ?? []) {
    if (flag === '--port' || flag === '--session' || flag === '--serve') continue; // values + usage prose
    assert.ok(
      MODE_FLAGS.has(flag) || VALUE_FLAGS.has(flag) || HELP_FLAGS.has(flag),
      `the help documents ${flag}, which the parser rejects`,
    );
  }
});
