/**
 * Asking for one port and getting another is something the caller has to be told.
 *
 * `trajectory_studio` takes a `port`. `listenOnFreePort` refuses to fail on a busy one —
 * it moves to an ephemeral port and answers — which is the right behaviour, and the
 * comment above that write says exactly why moving is not enough on its own:
 *
 *   Silently moving to another port hides the real problem: something else is already
 *   serving the requested one, so the old panel keeps answering and the reader is
 *   looking at stale code.
 *
 * It then reported the move only to `process.stderr`. The operator saw it; the caller
 * did not. The reply carried a working URL on a different port and no word about it,
 * with the capability note the only string in it — which is exactly the shape that
 * reads as "done what you asked". A reader who had that port's panel already open in a
 * browser tab had no way to tell it from this one.
 *
 * The plugin already has the mechanism for this and documents it: a `note` means
 * *something in the call did not do what you asked*. This file pins that the port is
 * named in it, that the reason is given rather than just the fact, and that the
 * capability note survives — a second fact must never displace the one that says the
 * URL is safe to hand over.
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { createFixtureProjection, FIXTURE_HOME } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';
import { createStudio } from '../server/http.mjs';

const CAPABILITY_NOTE = /#t= fragment/u;

/** A panel over a throwaway projection, with the caller wired to it. */
async function harness(t) {
  const dataDir = await fixtureDir(t);
  const store = openStore({ dataDir });
  const studio = createStudio({ store, homeDir: FIXTURE_HOME, redactRoots: [] });
  const call = (args) => createHandler({ store, studio, homeDir: FIXTURE_HOME, redactRoots: [] })
    .call('trajectory_studio', args);
  // One hook, in one order, for a reason that is measured rather than assumed.
  //
  // `t.after` hooks run in **registration** order — verified, not recalled — so a helper
  // that registers "remove the directory" before the caller registers "close the store"
  // removes a directory SQLite still holds. POSIX allows unlinking an open file, so the
  // suite is green everywhere it is developed and fails on Windows with `EBUSY` at
  // teardown: an error that names a temp path, points at no assertion, and cannot be
  // reproduced locally. Four of the Windows suite's failures were this.
  //
  // A retry cannot fix it either: the close has not run yet, so the lock is still held
  // however long the retry waits. Only the order can.
  t.after(async () => {
    await studio.stop();
    store.close();
    const { rm } = await import('node:fs/promises');
    await rm(dataDir, { recursive: true, force: true });
  });
  return { store, studio, call, dataDir };
}

async function fixtureDir(t) {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-studio-port-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'A', updatedAtMs: 1_700_000_000_000 });
  projection.close();
  // Deliberately registers no teardown of its own: whoever opens the projection owns
  // closing it, and therefore owns removing the directory. A fixture helper that removes
  // it is a fixture helper that can remove it too early.
  return dataDir;
}

/** Hold one port so the panel cannot have it. */
async function occupyPort(t) {
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

test('a requested port that is in use is reported, with the reason', async (t) => {
  const { call } = await harness(t);
  const taken = await occupyPort(t);
  const reply = await call({ port: taken });

  // The fixture has to have reached the branch, or the assertion below is vacuous.
  assert.notEqual(reply.port, taken, 'the panel was not moved off the occupied port');
  assert.equal(reply.url.includes(`:${reply.port}/`), true, 'the URL does not name the port actually bound');

  assert.match(reply.note, new RegExp(String(taken), 'u'),
    `the note does not name the port that was asked for: ${reply.note}`);
  assert.match(reply.note, /in use/u,
    `the note reports the move without saying why: ${reply.note}`);
});

test('the reason distinguishes "occupied" from "already running"', async (t) => {
  const { call } = await harness(t);
  const taken = await occupyPort(t);

  const fresh = await call({ port: taken });
  const reused = await call({ port: taken });

  assert.equal(fresh.reused, false);
  assert.equal(reused.reused, true, 'the second call did not reuse the running panel');
  // Both are "you asked for X, you got Y", and they need different words: on the second
  // one the other panel is *this* panel, and replacing it would invalidate a URL the
  // caller may already hold open. A single generic message would be right about neither.
  assert.match(reused.note, /already running/u,
    `reuse reads like the occupied case: ${reused.note}`);
  assert.doesNotMatch(reused.note, /in use by something else/u,
    'reuse is reported as though a stranger held the port');
});

test('a port that was honoured adds nothing to the note', async (t) => {
  const { call } = await harness(t);
  // The control. A note that fires whenever a port was named — or worse, always — would
  // satisfy both cases above while telling the reader nothing.
  const first = await call({});
  const free = first.port;
  const second = await call({ port: free });

  assert.equal(second.reused, true);
  assert.equal(second.port, free, 'the requested port was not the one in use');
  assert.match(second.note, CAPABILITY_NOTE, 'the capability note was displaced');
  assert.doesNotMatch(second.note, /requested but/u,
    `a honoured port still produced a complaint: ${second.note}`);
});

test('a second fact never displaces the capability note', async (t) => {
  const { call } = await harness(t);
  const taken = await occupyPort(t);
  const reply = await call({ port: taken });

  // Appending, not replacing. The capability note is the reason the URL is safe to hand
  // over at all; a second sentence that replaced it would trade a credential warning for
  // a port warning, which is not a trade anybody asked for.
  assert.match(reply.note, CAPABILITY_NOTE,
    `the capability note is gone: ${reply.note}`);
});
