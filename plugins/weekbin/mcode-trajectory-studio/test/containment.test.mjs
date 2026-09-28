import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { readTaskOutput } from '../server/tasks.mjs';
import { findSessionDir, foldJsonl, readJsonlEvents } from '../server/jsonl.mjs';
import { isWithin, openContainedRead, openedPathAllowed, openedRealPath } from '../server/fsutil.mjs';
import { openStore } from '../server/store.mjs';

/**
 * Containment canaries.
 *
 * Every file this Plugin reads has to resolve, after canonicalization, to
 * somewhere inside the approved data directory. A lexical `startsWith` check is
 * not enough: a symlink planted anywhere along the traversed path keeps the
 * string inside the root while the kernel resolves it outside. The earlier
 * revision was exploitable exactly that way — a symlinked task directory and a
 * symlinked session directory both read a file outside the data directory — so
 * each of those shapes is pinned here as a canary.
 *
 * Every case therefore asserts two things: the canary never appears in the
 * result, and the read is reported as unavailable. A positive control runs
 * alongside each escape shape, because "refuse everything" would otherwise make
 * the whole file pass.
 */

// Unique strings so a leak cannot be confused with fixture noise, and so the
// assertion can search the whole serialized result rather than one field.
const CANARY_OUTPUT = 'CANARY-OUTSIDE-OUTPUT-LOG-7f31';
const CANARY_MESSAGES = 'CANARY-OUTSIDE-MESSAGES-JSONL-7f31';

const approx = { detailLevel: 'full' };

async function makeFixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'trajectory-containment-'));
  const dataDir = path.join(base, 'data');
  const outside = path.join(base, 'outside');
  await mkdir(path.join(dataDir, 'background-tasks'), { recursive: true });
  await mkdir(path.join(dataDir, 'v2', 'sessions', '2026', '01', '02'), { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(path.join(outside, 'output.log'), `${CANARY_OUTPUT}\n`, 'utf8');
  await writeFile(
    path.join(outside, 'messages.jsonl'),
    `${JSON.stringify({
      message_id: 'outside-1',
      turn_id: 'outside-turn',
      message: { role: 'user', content: [{ type: 'text', text: CANARY_MESSAGES }] },
    })}\n`,
    'utf8',
  );

  const taskDir = (name) => path.join(dataDir, 'background-tasks', name);
  const dayDir = path.join(dataDir, 'v2', 'sessions', '2026', '01', '02');
  const sessionDir = (name) => path.join(dayDir, name);

  return { base, dataDir, outside, taskDir, dayDir, sessionDir };
}

function storeFor(dataDir) {
  return openStore({ dataDir });
}

/** Assert a task-output read refused, without naming how. */
function assertRefused(output) {
  assert.equal(output.available, false, `task output was readable: ${JSON.stringify(output)}`);
  assert.equal(JSON.stringify(output).includes(CANARY_OUTPUT), false, 'canary leaked into the task result');
}

/** Assert a JSONL read refused, without naming how. */
function assertRefusedEvents(result) {
  assert.equal(result.source, 'unavailable', `jsonl source was ${result.source}`);
  assert.equal(result.events.length, 0, 'events were returned from outside the root');
  assert.equal(JSON.stringify(result).includes(CANARY_MESSAGES), false, 'canary leaked into the events');
}

/* ------------------------------------------------------- task output.log -- */

test('a symlinked task directory cannot escape the data directory', async () => {
  const f = await makeFixture();
  await symlink(f.outside, f.taskDir('escape-dir'));
  assertRefused(await readTaskOutput(storeFor(f.dataDir), 'escape-dir'));
});

test('a two-hop symlinked task directory cannot escape the data directory', async () => {
  const f = await makeFixture();
  await symlink(f.outside, f.taskDir('hop-2'));
  await symlink(f.taskDir('hop-2'), f.taskDir('hop-1'));
  assertRefused(await readTaskOutput(storeFor(f.dataDir), 'hop-1'));
});

test('a task directory symlinked by relative path cannot escape the data directory', async () => {
  const f = await makeFixture();
  await symlink(path.relative(path.join(f.dataDir, 'background-tasks'), f.outside), f.taskDir('rel'));
  assertRefused(await readTaskOutput(storeFor(f.dataDir), 'rel'));
});

test('a symlinked output.log cannot escape the data directory', async () => {
  const f = await makeFixture();
  await mkdir(f.taskDir('link-file'), { recursive: true });
  await symlink(path.join(f.outside, 'output.log'), path.join(f.taskDir('link-file'), 'output.log'));
  assertRefused(await readTaskOutput(storeFor(f.dataDir), 'link-file'));
});

test('a symlinked task root cannot escape the data directory', async () => {
  const f = await makeFixture();
  // Replace the whole approved root with a link to the outside directory, so the
  // lexical path stays inside the data directory while the kernel resolves it
  // outside. Canonicalizing only the leaf would still let this through.
  await mkdir(path.join(f.outside, 'redirected'), { recursive: true });
  await writeFile(path.join(f.outside, 'redirected', 'output.log'), `${CANARY_OUTPUT}\n`, 'utf8');
  await rm(path.join(f.dataDir, 'background-tasks'), { recursive: true, force: true });
  await symlink(path.join(f.outside, 'redirected'), path.join(f.dataDir, 'background-tasks'), 'dir');
  const root = path.join(f.dataDir, 'background-tasks');
  assert.ok(root.startsWith(f.dataDir), 'sanity: the root is lexically inside the data directory');
  assertRefused(await readTaskOutput(storeFor(f.dataDir), 'redirected'));
});

test('the positive control still reads a task directory inside the data directory', async () => {
  const f = await makeFixture();
  await mkdir(f.taskDir('legit'), { recursive: true });
  await writeFile(path.join(f.taskDir('legit'), 'output.log'), 'legitimate output\n', 'utf8');
  const output = await readTaskOutput(storeFor(f.dataDir), 'legit');
  assert.equal(output.available, true, JSON.stringify(output));
  assert.equal(output.text, 'legitimate output\n');
});

/* ---------------------------------------------------------- messages.jsonl */

test('a symlinked session directory cannot escape the data directory', async () => {
  const f = await makeFixture();
  await symlink(f.outside, f.sessionDir('20260102-aaaa1111'));
  const store = storeFor(f.dataDir);
  const found = await findSessionDir(store, 'aaaa1111');
  assert.equal(found, null, `findSessionDir returned ${found}`);
  assertRefusedEvents(await readJsonlEvents(store, { sessionId: 'aaaa1111', ...approx }));
});

test('a two-hop symlinked session directory cannot escape the data directory', async () => {
  const f = await makeFixture();
  await symlink(f.outside, f.sessionDir('20260102-hop2bbbb'));
  await symlink(f.sessionDir('20260102-hop2bbbb'), f.sessionDir('20260102-hop1bbbb'));
  const store = storeFor(f.dataDir);
  assert.equal(await findSessionDir(store, 'hop1bbbb'), null);
  assertRefusedEvents(await readJsonlEvents(store, { sessionId: 'hop1bbbb', ...approx }));
});

test('a symlinked messages.jsonl cannot escape the data directory', async () => {
  const f = await makeFixture();
  await mkdir(f.sessionDir('20260102-filecccc'), { recursive: true });
  await symlink(
    path.join(f.outside, 'messages.jsonl'),
    path.join(f.sessionDir('20260102-filecccc'), 'messages.jsonl'),
  );
  const store = storeFor(f.dataDir);
  assertRefusedEvents(await readJsonlEvents(store, { sessionId: 'filecccc', ...approx }));
});

test('a session directory reached through a symlinked day cannot escape the data directory', async () => {
  const f = await makeFixture();
  const month = path.join(f.dataDir, 'v2', 'sessions', '2026', '02');
  await writeFile(path.join(f.outside, 'messages.jsonl'), `${JSON.stringify({
    message_id: 'x',
    message: { role: 'user', content: [{ type: 'text', text: CANARY_MESSAGES }] },
  })}\n`);
  await symlink(f.outside, path.join(f.outside, 'day'));
  await mkdir(month, { recursive: true });
  await symlink(path.join(f.outside, 'day'), path.join(month, '03'));
  const store = storeFor(f.dataDir);
  assert.equal(await findSessionDir(store, 'whatever'), null);
});

test('the positive control still reads a messages.jsonl inside the data directory', async () => {
  const f = await makeFixture();
  const dir = f.sessionDir('20260102-legitddd');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'messages.jsonl'), `${JSON.stringify({
    message_id: 'inside-1',
    turn_id: 't1',
    message: { role: 'user', content: [{ type: 'text', text: 'legitimate message body' }] },
  })}\n`, 'utf8');
  const store = storeFor(f.dataDir);
  // `findSessionDir` returns the canonical directory — that is the whole point of
  // the containment check — so the expectation has to be canonical too. On macOS
  // `/var` resolves to `/private/var`, and on Windows a short `RUNNER~1` temp path
  // resolves to its long form; comparing against the raw temporary path passes only
  // on a host where canonicalizing is the identity.
  assert.equal(await findSessionDir(store, 'legitddd'), await realpath(dir));
  const result = await readJsonlEvents(store, { sessionId: 'legitddd', ...approx });
  assert.equal(result.source, 'jsonl');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].content, 'legitimate message body');
});

/* --------------------------------------------- bounded JSONL line buffer -- */

/**
 * The line buffer is capped *incrementally*.
 *
 * The previous revision appended a chunk and only then checked the 2 MiB line
 * limit, so a single line with no newline grew the buffer to the size of the whole
 * file before the check ever ran — unbounded memory from a bounded read. The cap
 * now runs per chunk, and `droppedOversized` proves the oversized line took the
 * discard path instead of being retained.
 */
const JSONL_CANARY = 'CANARY-OVERSIZED-LINE-4b27';

test('a large unterminated line is discarded instead of buffered whole', async () => {
  const huge = `${'A'.repeat(8 * 1024 * 1024)}${JSONL_CANARY}`;
  const valid = JSON.stringify({
    message_id: 'ok-1', turn_id: 't1',
    message: { role: 'user', content: [{ type: 'text', text: 'legitimate body' }] },
  });
  const out = await foldJsonl(Readable.from([huge, '\n', valid, '\n']), { limit: 100, detailLevel: 'full' });
  assert.equal(out.droppedOversized, 1, 'the oversized line did not take the discard path');
  assert.equal(JSON.stringify(out).includes(JSONL_CANARY), false, 'the oversized record leaked');
  assert.equal(out.events.length, 1, 'the record after the oversized line was lost');
  assert.equal(out.events[0].content, 'legitimate body');
});

test('a small line that arrives right after an oversized one is still folded', async () => {
  // The discard state has to clear on the next newline, or one corrupt line silently
  // swallows every record after it.
  const huge = 'B'.repeat(4 * 1024 * 1024);
  const first = JSON.stringify({ message_id: 'a', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } });
  const second = JSON.stringify({ message_id: 'b', message: { role: 'user', content: [{ type: 'text', text: 'two' }] } });
  const out = await foldJsonl(Readable.from([huge, '\n', first, '\n', second, '\n']), { limit: 100, detailLevel: 'full' });
  assert.equal(out.droppedOversized, 1);
  assert.deepEqual(out.events.map((event) => event.content), ['one', 'two']);
});

test('an oversized line that arrives with its newline is still counted', async () => {
  // The count must not depend on where the chunk boundary fell. Delivered as a single
  // chunk, an oversized line never crosses the pending-buffer cap, so it takes the
  // per-line discard rather than the overflow discard — and that path used to drop it
  // silently while the docs promise that dropped lines are reported.
  const line = (id, text) => JSON.stringify({ message_id: id, message: { role: 'user', content: [{ type: 'text', text }] } });
  const cap = 200;
  const oversized = 'C'.repeat(400);
  const delivered = [
    ['one chunk', [ `${oversized}\n${line('after', 'still here')}\n` ]],
    ['two chunks', [ oversized, `\n${line('after', 'still here')}\n` ]],
  ];
  for (const [label, chunks] of delivered) {
    const out = await foldJsonl(Readable.from(chunks), { limit: 10, detailLevel: 'full', maxLineBytes: cap });
    assert.equal(out.droppedOversized, 1, `${label}: the oversized line was not counted`);
    assert.deepEqual(out.events.map((event) => event.content), ['still here'], `${label}: the following line was not folded`);
  }
});

test('a normal file is unaffected by the incremental cap', async () => {
  const line = (id, text) => JSON.stringify({ message_id: id, message: { role: 'user', content: [{ type: 'text', text }] } });
  const body = [line('1', 'alpha'), line('2', 'beta'), line('3', 'gamma')].join('\n') + '\n';
  const out = await foldJsonl(Readable.from([body]), { limit: 100, detailLevel: 'full' });
  assert.equal(out.droppedOversized, 0);
  assert.deepEqual(out.events.map((event) => event.content), ['alpha', 'beta', 'gamma']);
});

test('a real file with a huge no-newline record is read through the capped path', async () => {
  // The synthetic-stream test above feeds the huge line as one chunk; the real read
  // path uses `createReadStream`, which delivers it in many chunks. This exercises
  // the per-chunk cap and asserts the discard is counted once per line, not once per
  // chunk that happens to cross the cap.
  const f = await makeFixture();
  const dir = f.sessionDir('20260102-hugeeeee');
  await mkdir(dir, { recursive: true });
  const valid = JSON.stringify({
    message_id: 'ok', turn_id: 't1',
    message: { role: 'user', content: [{ type: 'text', text: 'after the huge line' }] },
  });
  await writeFile(
    path.join(dir, 'messages.jsonl'),
    `${'Z'.repeat(9 * 1024 * 1024)}${JSONL_CANARY}\n${valid}\n`,
    'utf8',
  );
  const store = storeFor(f.dataDir);
  const result = await readJsonlEvents(store, { sessionId: 'hugeeeee', ...approx });
  assert.equal(result.source, 'jsonl');
  assert.equal(result.droppedOversized, 1, `expected one discarded line, got ${result.droppedOversized}`);
  assert.equal(JSON.stringify(result).includes(JSONL_CANARY), false, 'the oversized record leaked');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].content, 'after the huge line');
});

/* ------------------------------------------------- post-open verification -- */

/**
 * The residual `realpath`→`open` race, and its accepted boundary.
 *
 * Pre-open canonicalization plus `O_NOFOLLOW` close the static-symlink cases above
 * and the final-component race. What remained was an *intermediate directory*
 * swapped between `realpath` and `open`. On Linux the opened descriptor's own path
 * (`/proc/self/fd/<fd>`) is authoritative and is now checked against the root; where
 * `/proc` is absent that race is the documented, accepted limit rather than an
 * unstated one, and the gate says so explicitly.
 */
// Built with `path.resolve` / `path.join` rather than written as POSIX literals.
// `isWithin` compares a prefix plus `path.sep`, which is `\\` on Windows, so a
// hard-coded `/base/data/ok.log` can never start with `/base/data\\` there: both
// assertions failed on windows-latest while testing the separator rather than the
// containment rule. The rule is platform-independent; the fixture has to be too.
const ROOT = path.resolve('base/data');

test('a descriptor that resolves outside the root is refused', () => {
  assert.equal(openedPathAllowed(ROOT, path.resolve('base/outside/output.log')), false);
  assert.equal(openedPathAllowed(ROOT, path.join(ROOT, 'ok.log')), true);
  assert.equal(openedPathAllowed(ROOT, ROOT), true);
});

test('the containment test is not fooled by a sibling sharing a name prefix', () => {
  assert.equal(isWithin(ROOT, path.resolve('base/data-evil/x')), false);
  assert.equal(isWithin(ROOT, path.join(ROOT, 'x')), true);
  assert.equal(isWithin(ROOT, path.resolve('base/dat')), false);
});

test('an unavailable /proc path falls back to the documented boundary', () => {
  // macOS and Windows have no `/proc`, so `openedRealPath` returns null and the
  // pre-open canonical check is the only evidence. The gate accepts that evidence
  // rather than silently pretending the extra check ran.
  assert.equal(openedPathAllowed('/base/data', null), true);
  assert.equal(openedPathAllowed('/base/data', ''), true);
});

test('the post-open check is active where /proc exists', async () => {
  const f = await makeFixture();
  await mkdir(f.taskDir('legit-proc'), { recursive: true });
  await writeFile(path.join(f.taskDir('legit-proc'), 'output.log'), 'inside\n', 'utf8');
  const opened = await openContainedRead(f.dataDir, path.join(f.taskDir('legit-proc'), 'output.log'));
  assert.ok(opened, 'a legitimate read was refused');
  try {
    const real = await openedRealPath(opened.handle);
    if (real === null) return; // no /proc on this platform: the boundary is documented
    // The descriptor names the file actually opened, and it stays inside the root.
    assert.equal(isWithin(await realpath(f.dataDir), real), true, `opened path escaped: ${real}`);
  } finally {
    await opened.handle.close();
  }
});
