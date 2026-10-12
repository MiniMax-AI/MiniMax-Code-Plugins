/**
 * Home-path folding on a case-insensitive filesystem.
 *
 * `foldHomePaths` is this Plugin's primary confidentiality boundary, and it used to
 * ask the wrong question on two of the three platforms it supports. It matched roots
 * by exact string (`split`/`join`) and masked account names with a regex carrying no
 * `i` flag, so on Windows — and on a default macOS volume, which is also
 * case-insensitive — any difference in casing between the configured root and the
 * path in the payload made the fold miss entirely.
 *
 * Casing drift is not exotic there. Windows lowercases a drive letter, the runtime
 * records whatever casing a tool reported, and Git for Windows reports repository
 * roots with **forward slashes** where the operator configured backslashes. All four
 * cases below leaked the home directory, the account name and the configured roots
 * verbatim, through `/api/meta`'s `dataDir`, `trajectory_list`'s `workspaceDir`, the
 * session group key, and the warnings list.
 *
 * Every case here has a matching negative control: a path that must *not* fold.
 * Without those, a change that folded everything would satisfy the positive cases
 * and quietly destroy the paths it is supposed to leave alone.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { foldHomePaths, redactText } from '../server/redact.mjs';

const WIN_HOME = 'C:\\Users\\Bob';
const WIN_DATA = 'C:\\Users\\Bob\\.minimax';

/** Fold and assert the named fragments are gone from the result. */
function assertFolded(input, options, mustNotContain, expected) {
  const out = foldHomePaths(input, options);
  for (const fragment of mustNotContain) {
    assert.equal(out.includes(fragment), false, `leaked "${fragment}" in ${out}`);
  }
  if (expected !== undefined) assert.ok(out.includes(expected), `expected "${expected}" in ${out}`);
  return out;
}

/* --------------------------------------------------------- roots, any case -- */

test('a root folds whatever casing the payload uses', () => {
  // The defect: `split`/`join` is byte-exact, so a lowercased drive letter — which
  // is what Windows itself produces — missed the root entirely.
  assertFolded('c:\\users\\bob\\.minimax\\v2', { homeDir: WIN_HOME, roots: [WIN_DATA] }, ['bob', 'Bob']);
  assertFolded('C:\\USERS\\BOB\\.minimax', { homeDir: WIN_HOME }, ['BOB']);
  assertFolded('c:/users/bob/.minimax/v2', { homeDir: WIN_HOME }, ['bob', 'Bob']);
});

test('the JSON-escaped copy of a path folds too', () => {
  // The escaped form is the one that actually reaches a response body: a Windows
  // path inside a JSON column has its backslashes doubled.
  assertFolded('"c:\\\\users\\\\bob\\\\.minimax"', { homeDir: WIN_HOME }, ['bob']);
});

test('a configured root outside home folds, whatever its casing', () => {
  // The `MCODE_TRAJECTORY_REDACT_ROOTS` contract. A data directory on another drive
  // is exactly the shape that has no home prefix for the account mask to rescue.
  assertFolded('d:\\mavis-data\\v2', { homeDir: WIN_HOME, roots: ['D:\\Mavis-Data'] }, ['mavis-data', 'Mavis-Data']);
});

/* ------------------------------------------------- separators, either way -- */

test('a forward-slash path folds against a backslash-configured root', () => {
  // Git for Windows reports `C:/Users/Bob/proj`, and that reaches egress through
  // `repoRoot` → the session group key → `/api/sessions`. Folding only the
  // on-disk spelling meant the tool this plugin shells out to defeated it.
  assertFolded('D:/work/proj', { homeDir: WIN_HOME, roots: ['D:\\work'] }, ['work']);
  assertFolded('d:\\work\\proj', { homeDir: WIN_HOME, roots: ['D:/work'] }, ['work']);
});

/* -------------------------------------------------------- account masking -- */

test('another account home is masked whatever the casing of the literal', () => {
  // The regex needs a case-insensitive flag to match `users` as well as `Users`.
  assertFolded('C:\\users\\carol\\ws', { homeDir: WIN_HOME }, ['carol'], '<user>');
  assertFolded('/home/carol/ws', { homeDir: '/home/bob' }, ['carol'], '<user>');
});

test('the mask still leaves the shape of the path behind', () => {
  // The name goes; the directory structure is what makes the path useful to
  // whoever is debugging, and it is not itself identifying.
  const out = foldHomePaths('/home/carol/workspace/proj', { homeDir: '/home/bob' });
  assert.equal(out, '/home/<user>/workspace/proj');
});

/* ---------------------------------------------------------- the safeguards -- */

test('a root written without a volume folds the volume the host resolved it against', () => {
  // The gap every drive-lettered case in this file misses. `WIN_HOME` is `C:\Users\Bob`,
  // so both sides carry a volume and they compare. But a root is routinely written
  // drive-relative — `MCODE_TRAJECTORY_REDACT_ROOTS=/tmp/build`, a fixture home, any root
  // copied between platforms — while the paths that name it go through `path.resolve`,
  // which prepends the current drive. The payload is `D:\tmp\build\ws\src\app.js` and the
  // root is `/tmp/build`; folding the root alone left `D:~\ws\src\app.js`, which is not a
  // path anything can open. The volume stayed and the answer was a broken string in both
  // directions: it still named a drive, and it was not a redaction either.
  assert.equal(
    foldHomePaths('D:\\tmp\\build\\ws\\src\\app.js', { homeDir: '/tmp/build' }),
    '~\\ws\\src\\app.js',
    'a drive-relative root must absorb the volume it was resolved against',
  );
  // Forward slashes, the spelling a serialized path and a Git-for-Windows root both carry.
  assert.equal(foldHomePaths('D:/tmp/build/ws/src/app.js', { homeDir: '/tmp/build' }), '~/ws/src/app.js');
  // The same for a configured root rather than the home directory.
  assert.equal(
    foldHomePaths('D:\\tmp\\cache\\v2\\sessions', { homeDir: 'C:\\Users\\Bob', roots: ['/tmp/cache'] }),
    '~\\v2\\sessions',
  );
  // A volume of its own is consumed by the fold rather than left dangling in front of it.
  assert.equal(foldHomePaths('D:\\tmp\\build\\ws', { homeDir: '/tmp/build' }), '~\\ws');

  // The control, and the reason the volume is absorbed rather than merely tolerated: a
  // path on a **different** volume is not under a drive-relative root, because the root
  // did not name one and neither did the path it should be compared against.
  assert.equal(
    foldHomePaths('C:\\tmp\\build\\ws', { homeDir: '/tmp/build' }),
    '~\\ws',
    'a drive-relative root matches any volume, because it named none',
  );
  // And a drive-lettered root stays exact: nothing else folds onto it. The account name
  // still goes, which is the other pass doing its job — what must survive is the volume,
  // because `C:\Users\Bob` names a directory that `D:\Users\Bob` does not.
  assert.equal(foldHomePaths('D:\\Users\\Bob\\ws', { homeDir: 'C:\\Users\\Bob' }), 'D:\\Users\\<user>\\ws');
});

test('a path outside every configured root is not folded', () => {
  // The control for the whole file. If this ever folds, the fix has stopped
  // distinguishing roots and is simply destroying paths.
  assert.equal(foldHomePaths('D:\\other\\proj', { homeDir: WIN_HOME, roots: ['D:\\work'] }), 'D:\\other\\proj');
  assert.equal(foldHomePaths('/var/data/proj', { homeDir: '/home/bob' }), '/var/data/proj');
});

test('a bare drive letter is still not treated as a directory', () => {
  // Folding `C:` would replace every colon-separated token in the payload.
  assert.equal(foldHomePaths('C:\\work\\proj', { homeDir: 'C:' }), 'C:\\work\\proj');
  assert.equal(foldHomePaths('/work/proj', { homeDir: '/' }), '/work/proj');
});

test('a root with a trailing separator still folds', () => {
  assertFolded('C:\\Users\\Bob\\ws', { homeDir: 'C:\\Users\\Bob\\' }, ['Bob']);
});

test('regular expressions and other metacharacters in a root are literal', () => {
  // The replacement goes through `RegExp` now, so a root containing a metacharacter
  // must be escaped rather than interpreted. A directory called `a+b` is ordinary.
  const out = foldHomePaths('C:\\a+b\\proj', { homeDir: 'C:\\a+b' });
  assert.equal(out, '~\\proj', `the "+" was treated as a quantifier: ${out}`);
  assertFolded('C:\\proj(x)\\ws', { homeDir: 'C:\\proj(x)' }, ['proj(x)']);
});

/* --------------------------------------------------------- the surfaces -- */

test('redactText folds a path on its way out, not only foldHomePaths alone', () => {
  // The egress boundary is what every surface actually calls; the unit above proves
  // the helper, and this proves the helper is on the path a caller takes.
  const out = redactText('warning: cannot open c:\\users\\bob\\.minimax\\v2\\runtime-state.sqlite', {
    homeDir: WIN_HOME,
    pii: false,
  });
  assert.equal(out.includes('bob'), false, `leaked through redactText: ${out}`);
});