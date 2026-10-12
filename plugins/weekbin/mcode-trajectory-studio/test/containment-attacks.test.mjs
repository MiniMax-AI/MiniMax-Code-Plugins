/**
 * Filesystem containment, exercised against real symlinks rather than mocks.
 *
 * A symlink escape was the first finding of the first review round, and containment is
 * the one place in this Plugin where a bug hands over a file the reader was never
 * granted. The unit below therefore builds the attacks rather than describing them:
 * a link at the final component, a link at an intermediate directory, a sibling whose
 * name merely starts with the root's, and a `..` traversal.
 *
 * The fixtures are directories and symlinks only — no file contents are read, and
 * nothing outside a per-test temporary directory is touched.
 *
 * Two of these are **controls that must keep failing closed**, and they are the
 * reason the file is worth having: if `openContainedRead` ever stops refusing a
 * symlink at the final component, or starts treating `/root/data-evil` as inside
 * `/root/data`, no other test in the package notices.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isWithin, openContainedRead, containedRealPath } from '../server/fsutil.mjs';

/**
 * A data root holding one session artifact, plus a sibling `data-evil` and a
 * `outside` directory the root is supposed to be unable to reach.
 */
const ARTIFACT = '{"message_id":"m1"}\n';

async function world(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mc-containment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const session = path.join(data, 'sessions', '2026', '09', '20', '10-00-00-000-sess-a');
  await mkdir(session, { recursive: true });
  await mkdir(path.join(root, 'outside'), { recursive: true });
  await mkdir(path.join(root, 'data-evil'), { recursive: true });
  await writeFile(path.join(session, 'messages.jsonl'), ARTIFACT, 'utf8');
  await writeFile(path.join(root, 'outside', 'secret.txt'), 'not yours\n', 'utf8');
  await writeFile(path.join(root, 'data-evil', 'other.txt'), 'also not yours\n', 'utf8');
  return { root, data, session, outside: path.join(root, 'outside') };
}

/* -------------------------------------------------------------- refusals -- */

test('a symlink at the final component is refused', async (t) => {
  const { data, session, outside } = await world(t);
  await symlink(path.join(outside, 'secret.txt'), path.join(session, 'escape.jsonl'));
  assert.equal(await openContainedRead(data, path.join(session, 'escape.jsonl')), null);
  // The lexical path is inside the root, which is exactly why the check cannot be lexical.
  assert.ok(path.join(session, 'escape.jsonl').startsWith(data));
});

test('a symlinked intermediate directory is refused', async (t) => {
  const { data, outside } = await world(t);
  const link = path.join(data, 'sessions', '2026', '09', '20', 'linked-dir');
  await symlink(outside, link);
  assert.equal(await openContainedRead(data, path.join(link, 'secret.txt')), null);
  assert.equal(await containedRealPath(data, path.join(link, 'secret.txt')), null);
});

test('a symlinked data root is not mistaken for an escape', async (t) => {
  // The root itself reached through a link is the same directory, so refusing it
  // would make a real deployment unreadable rather than safe.
  //
  // This is the one call site here that took the handle for its truthiness and threw
  // the handle away. On Node 22 and 24 the descriptor survived long enough for the
  // process to exit quietly; Node 26 collects it and reports the close as an error,
  // asynchronously, after the test has already reported itself passed:
  //
  //   A FileHandle object was closed during garbage collection … Please close
  //   FileHandle objects explicitly.  File descriptor: 14 (…/sess-a/messages.jsonl)
  //
  // The assertion did not become wrong — the reader is genuinely accepted — it just
  // was not the only thing the call produced. Every other `openContainedRead` site
  // here either expects `null` or closes in `finally`; this one closed nothing.
  const { root, data, session } = await world(t);
  const linked = path.join(root, 'linked-data');
  await symlink(data, linked);
  const opened = await openContainedRead(linked, path.join(session, 'messages.jsonl'));
  assert.ok(opened, 'a symlinked data root was mistaken for an escape');
  try {
    assert.equal(path.basename(opened.realPath), 'messages.jsonl');
  } finally {
    await opened.handle.close();
  }
});

test('a sibling whose name starts with the root is not inside it', async (t) => {
  const { data, root } = await world(t);
  const evil = path.join(root, 'data-evil', 'other.txt');
  assert.ok(evil.startsWith(data), 'the prefix is what makes this a trap');
  assert.equal(await openContainedRead(data, evil), null);
  assert.equal(await containedRealPath(data, path.join(root, 'data-evil')), null);
});

test('a `..` traversal out of the root is refused', async (t) => {
  const { data, session, root } = await world(t);
  const traversal = path.join(session, '..', '..', '..', '..', 'outside', 'secret.txt');
  assert.equal(await openContainedRead(data, traversal), null);
  assert.equal(await containedRealPath(data, traversal), null);
  assert.equal(await containedRealPath(data, path.join(root, 'outside', 'secret.txt')), null);
});

test('a directory is refused even when it is inside', async (t) => {
  // `openContainedRead` is for files. Handing back a descriptor for a directory would
  // push the "is it a file" question onto every caller.
  const { data, session } = await world(t);
  assert.equal(await openContainedRead(data, session), null);
});

test('a path that does not exist is refused rather than throwing', async (t) => {
  const { data, session } = await world(t);
  assert.equal(await openContainedRead(data, path.join(session, 'nope.jsonl')), null);
});

/* -------------------------------------------------------------- acceptance -- */

test('the session artifact itself is readable', async (t) => {
  const { data, session } = await world(t);
  const opened = await openContainedRead(data, path.join(session, 'messages.jsonl'));
  assert.ok(opened, 'the one legitimate read was refused');
  try {
    // Derived from the same string the fixture wrote rather than a literal: a
    // hardcoded byte count is one more thing to miscount, and "fixing" a failing one
    // by adjusting the number would leave the assertion testing nothing.
    assert.equal(opened.size, Buffer.byteLength(ARTIFACT, 'utf8'));
    assert.equal(path.basename(opened.realPath), 'messages.jsonl');
  } finally {
    await opened.handle.close();
  }
});

/* -------------------------------------------------------------- isWithin -- */

test('isWithin compares canonical paths, not spellings', () => {
  // Built with `path.join`, not written as `/a/data`. `isWithin` appends **this
  // platform's** `path.sep`, and it is documented as taking canonical paths only —
  // every caller runs both sides through `realpath` first, so both arrive in the
  // host's own spelling. A `/a/data` literal is therefore not a shorter spelling of the
  // same directory on Windows, it is a different string that cannot occur: the function
  // correctly refused it, and the test failed while asserting that a correct refusal was
  // a pass. The containment rule under test is the separator boundary, and that needs
  // paths the host would really produce.
  const base = path.join(path.parse(process.cwd()).root === '/' ? '/a' : 'C:\\a', 'data');
  const nested = path.join(base, 'session', 'x');
  const sibling = path.join(path.parse(base).root, 'a', 'other');
  const eviled = `${base}-evil${path.sep}x`;

  assert.equal(isWithin(base, base), true);
  assert.equal(isWithin(base, nested), true);
  // The rule the separator exists for.
  assert.equal(isWithin(base, eviled), false);
  assert.equal(isWithin(base, sibling), false);
  assert.equal(isWithin(base, ''), false);
  assert.equal(isWithin('', base), false);
  assert.equal(isWithin(null, base), false);
  assert.equal(isWithin(base, null), false);
});

test('a filesystem root as the base contains everything beneath it', () => {
  // The one shape the separator rule cannot express: there is no separator *after*
  // the root, so appending one compared against `//` and refused all of it. Fail-closed
  // rather than unsafe, but a data directory resolving to the filesystem root would
  // have made the whole Plugin report nothing.
  const root = path.parse(process.cwd()).root;
  assert.equal(isWithin(root, path.join(process.cwd(), 'anything')), true);
  assert.equal(isWithin(root, root), true);
  // A root that merely looks like one must not inherit the rule. Built from the host's
  // own root for the same reason as the test above.
  const looksLikeRoot = path.join(root === '/' ? '/a' : 'C:\\a', 'data');
  assert.equal(isWithin(looksLikeRoot, `${looksLikeRoot}-evil`), false);
});