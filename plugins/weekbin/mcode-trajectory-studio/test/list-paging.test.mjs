/**
 * Every session on the machine must be reachable by the tool whose job is to name them —
 * and a walk that says it reached the end must actually have reached the end.
 *
 * `trajectory_list` had no offset and a `limit` ceiling of 200. On the machine this
 * was written on that is not an abstract limit: 633 sessions, of which 200 were
 * reachable. The other 433 — including every session older than the recent working
 * set — could not be named by any tool call. `trajectory_search` is not a substitute:
 * it needs FTS5 in the bundled SQLite (absent on Node 22.13–22.18 and every 23.x), it
 * reads only title, agent, status and workspace path, and it matches phrases. A user
 * asking "the session where I refactored the parser last week" got an empty list and
 * a confident wrong conclusion.
 *
 * `sinceMs` cannot stand in either, because it only ever moves the window forward.
 *
 * Paging by `offset` did reach all of them, and that was the second defect. The list is
 * ordered `updated_at_ms DESC`, and that column is the one the runtime rewrites whenever
 * it writes to a session, so `LIMIT ? OFFSET ?` — which counts positions — silently drops
 * any session that moves during the walk: twelve sessions, one written to between page
 * one and page two, and the walk ended reporting `nextOffset: null` having delivered
 * eleven of them, with `total` agreeing with the number of rows sent, so a caller
 * counting its own results could not have noticed. The walk is now a keyset cursor
 * pinned to one instant, and these cases pin the properties that make it usable:
 * every session appears exactly once, the pin does not move mid-walk, and what the last
 * page's `total` claims is what the caller is holding.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureProjection, FIXTURE_HOME } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';

const NOW = 1_700_000_000_000;
/** Comfortably past the 200 ceiling, so "the newest page only" cannot pass. */
const SESSIONS = 250;

/**
 * A projection with `count` sessions, oldest last, one page boundary inside them.
 *
 * The projection handle is handed back rather than closed, because two cases below have
 * to write to the database *between* pages — and the store opens its own connection
 * read-only, so a write through a closed or store-side handle is the one thing that
 * cannot express "the runtime wrote to a session while you were walking".
 */
async function seeded(t, count = SESSIONS, { keepProjection = false } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'list-paging-'));
  const projection = await createFixtureProjection(dataDir);
  for (let index = 0; index < count; index += 1) {
    projection.session({
      id: `sess-${String(index).padStart(4, '0')}`,
      title: `Session ${index}`,
      updatedAtMs: NOW - index * 1000,
    });
  }
  if (!keepProjection) projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return keepProjection ? { store, projection } : store;
}

const list = (store, args = {}) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
  .call('trajectory_list', args);

/**
 * Drive a walk the way the Skill tells a model to, collecting what each page said.
 *
 * Returns the delivered ids, the `total` on the *last* page, and whether every page
 * agreed on the same pinned instant. The last page's `total` is the number the walk is
 * accountable for: everything reachable under the pin has been delivered by then.
 */
async function walk(store, args = {}) {
  const seen = [];
  const totals = [];
  const pins = new Set();
  let cursor;
  let pages = 0;
  let reachedEnd = false;
  // Bounded so a cursor that never advances fails the case instead of hanging it.
  for (; pages < 50 && !reachedEnd; pages += 1) {
    const reply = await list(store, { ...args, ...(cursor ? { cursor } : {}) });
    seen.push(...reply.sessions.map((session) => session.sessionId));
    totals.push(reply.total);
    pins.add(reply.walkPinnedAtMs);
    reachedEnd = reply.nextCursor === null;
    cursor = reply.nextCursor;
  }
  return { seen, total: totals.at(-1), totals, pins, reachedEnd, pages };
}

test('the tool reports how many sessions its filter matches', async (t) => {
  const store = await seeded(t);
  const reply = await list(store, { limit: 20 });
  assert.equal(reply.total, SESSIONS, 'a total of "one page" would let a caller believe it had seen everything');
  assert.equal(reply.returned, 20);
  assert.equal(reply.sessions[0].sessionId, 'sess-0000', 'newest first');
});

test('paging the cursor reaches every session, each exactly once', async (t) => {
  const store = await seeded(t);
  const { seen, reachedEnd } = await walk(store, { limit: 20 });
  assert.ok(reachedEnd, 'the cursor never reached the end');
  assert.ok(seen.length > 0, 'the walk delivered nothing at all');
  assert.equal(seen.length, SESSIONS, `paging saw ${seen.length} of ${SESSIONS}`);
  assert.equal(new Set(seen).size, SESSIONS, 'a session appeared on more than one page');
  assert.equal(seen.at(-1), `sess-${String(SESSIONS - 1).padStart(4, '0')}`, 'the oldest session was never reached');
});

test('every page of one walk describes the same instant', async (t) => {
  // The pin is what makes `total` and the rows mean the same thing across pages. If it
  // moved, a count from page one and rows from page three would describe two different
  // machines, and nothing in either reply would say so.
  const store = await seeded(t);
  const { pins, seen } = await walk(store, { limit: 20 });
  assert.equal(seen.length, SESSIONS, 'the walk did not finish, so the pin was never compared across pages');
  assert.equal(pins.size, 1, `the pinned instant changed mid-walk: ${[...pins].join(', ')}`);
});

test('what the last page totals is what the walk delivered', async (t) => {
  const store = await seeded(t);
  const { seen, total } = await walk(store, { limit: 20 });
  assert.equal(seen.length, total, 'the walk ended holding a different number of sessions than it was told');
});

test('a single large-enough page needs no cursor at all', async (t) => {
  const store = await seeded(t);
  const reply = await list(store, { limit: 200 });
  assert.equal(reply.sessions.length, 200);
  assert.equal(typeof reply.nextCursor, 'string', 'a partial page must hand back a way to get the rest');
});

test('the cursor is null on the final page, not merely past the end', async (t) => {
  const store = await seeded(t, 5);
  const first = await list(store, { limit: 3 });
  assert.equal(first.total, 5);
  assert.equal(typeof first.nextCursor, 'string');
  const last = await list(store, { limit: 3, cursor: first.nextCursor });
  assert.equal(last.sessions.length, 2);
  assert.equal(last.nextCursor, null, 'a cursor past the end would invite a pointless extra call');
});

test('the cursor resumes after the last row carried, not after the page it read', async (t) => {
  // A cursor built from what was *read* rather than what was *carried* skips whatever
  // the response budget dropped: those sessions would be counted in `omitted` and never
  // delivered by any page of the walk. `limit: 1` puts a page boundary inside every pair
  // so the two readings disagree at each step.
  const store = await seeded(t, 6);
  const { seen, reachedEnd, total } = await walk(store, { limit: 1 });
  assert.ok(reachedEnd);
  assert.equal(seen.length, total, 'the walk held a different number of sessions than the final total');
  assert.equal(new Set(seen).size, 6, 'a session appeared on more than one page');
});

test('a session written to mid-walk is excluded from the rows *and* from the total', async (t) => {
  // The defect this whole cursor exists to close. A session below page one is written to
  // exactly as the runtime writes to a running session; positional paging dropped it and
  // kept counting it, so the walk reported twelve of twelve while holding eleven.
  const { store, projection } = await seeded(t, 12, { keepProjection: true });
  const seen = [];
  const totals = [];
  let cursor;
  let reachedEnd = false;
  let wrote = false;
  for (let page = 0; page < 20 && !reachedEnd; page += 1) {
    const reply = await list(store, { limit: 4, ...(cursor ? { cursor } : {}) });
    seen.push(...reply.sessions.map((session) => session.sessionId));
    totals.push(reply.total);
    reachedEnd = reply.nextCursor === null;
    cursor = reply.nextCursor;
    if (!wrote) {
      wrote = true;
      // `Date.now()`, not a fixture timestamp: the runtime stamps a session it has just
      // written to with the current instant, and a write dated in the past would stay
      // inside the walk's window and prove nothing.
      projection.db.prepare('UPDATE local_runtime_sessions SET updated_at_ms = ? WHERE session_id = ?')
        .run(Date.now(), 'sess-0010');
    }
  }
  projection.close();

  assert.ok(reachedEnd, 'the walk never ended');
  assert.equal(new Set(seen).size, seen.length, 'a session appeared on more than one page');
  assert.equal(
    seen.includes('sess-0010'),
    false,
    'a session written to mid-walk should leave a pinned walk entirely',
  );
  // The whole point: the walk does not lose a session *silently*. What it holds is what
  // the last page told it, so the difference is arithmetic a caller can see.
  assert.equal(seen.length, totals.at(-1), 'the walk held fewer sessions than the final total counted');
  assert.ok(
    totals.at(-1) < 12,
    'the moved session is still counted, so the count promises rows no page can deliver',
  );
});

test('a session stamped in the pin\'s own millisecond still leaves the walk', async (t) => {
  // The one-millisecond corner the strict bound exists for. `updated_at_ms` is
  // millisecond-resolution, so a write landing in the same millisecond the walk pinned at
  // is indistinguishable from one that landed just before it: with an inclusive upper
  // bound the moved row stays inside the window, becomes the newest row, falls above the
  // cursor, and is dropped from the walk while `total` still counts it — the original
  // defect, intact, in the window between two page calls.
  //
  // The write is stamped with the pin read off page one rather than with `Date.now()`,
  // because a wall-clock write almost never lands on the exact millisecond and would let
  // an inclusive bound pass every other time.
  const { store, projection } = await seeded(t, 12, { keepProjection: true });
  const seen = [];
  const totals = [];
  let cursor;
  let reachedEnd = false;
  let wrote = false;
  for (let page = 0; page < 20 && !reachedEnd; page += 1) {
    const reply = await list(store, { limit: 4, ...(cursor ? { cursor } : {}) });
    seen.push(...reply.sessions.map((session) => session.sessionId));
    totals.push(reply.total);
    reachedEnd = reply.nextCursor === null;
    cursor = reply.nextCursor;
    if (!wrote) {
      wrote = true;
      projection.db.prepare('UPDATE local_runtime_sessions SET updated_at_ms = ? WHERE session_id = ?')
        .run(reply.walkPinnedAtMs, 'sess-0010');
    }
  }
  projection.close();

  assert.ok(reachedEnd, 'the walk never ended');
  assert.equal(seen.includes('sess-0010'), false,
    'a session stamped in the pin\'s own millisecond stayed in the walk');
  assert.equal(seen.length, totals.at(-1), 'the walk held fewer sessions than the final total counted');
});

test('a cursor from a walk with different filters starts a fresh page and says so', async (t) => {
  // A cursor says where to resume and says nothing about what it was resuming *for*.
  // Handing a filtered walk's cursor back without its filter returned a page of a
  // different population at an arbitrary key — measured on the real machine, rows that
  // were not the filtered agent, beside the unfiltered `total`, which is how a caller
  // concludes the filter matched everything on the box. Page one of the filters actually
  // asked for is the only answer that cannot mislead.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'list-paging-'));
  const projection = await createFixtureProjection(dataDir);
  for (let index = 0; index < 6; index += 1) {
    projection.session({ id: `sess-mavis-${index}`, title: `A ${index}`, agent: 'mavis', updatedAtMs: NOW - index * 1000 });
    projection.session({ id: `sess-other-${index}`, title: `B ${index}`, agent: 'explore', updatedAtMs: NOW - 500 - index * 1000 });
  }
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const filtered = await list(store, { agent: 'mavis', limit: 4 });
  assert.equal(filtered.total, 6);
  assert.equal(typeof filtered.nextCursor, 'string');

  const resumed = await list(store, { limit: 4, cursor: filtered.nextCursor });
  assert.match(resumed.note ?? '', /different filters/u, 'the mismatch was not said out loud');
  assert.equal(resumed.sessions.length, 4, 'a fresh page one was not returned');
  assert.equal(resumed.total, 12, 'the count describes the filters actually asked for');
  assert.equal(
    resumed.sessions.some((session) => session.agent !== 'mavis'),
    true,
    'the filter was dropped rather than honoured, so the reply is page one of the wrong walk',
  );
  // The newest row overall is also the newest `mavis` row, so this distinguishes the
  // two readings only by position: a fresh walk starts at index 0, a resumed one at 4.
  assert.equal(resumed.sessions[0].sessionId, 'sess-mavis-0', 'a fresh walk must start at the newest row');
});

test('changing the page size mid-walk is still the same walk', async (t) => {
  // `limit` decides how much is carried, not which rows match, so folding it into the
  // walk's identity would refuse a perfectly good continuation — and the refusal is
  // silent from the caller's side unless the note is there, which is a worse way to fail.
  const store = await seeded(t, 30);
  const first = await list(store, { limit: 5 });
  const resumed = await list(store, { limit: 10, cursor: first.nextCursor });
  assert.equal(resumed.note, undefined, 'a page-size change was treated as a different walk');
  assert.equal(resumed.sessions.length, 10);
  const overlap = first.sessions.map((s) => s.sessionId)
    .filter((id) => resumed.sessions.some((s) => s.sessionId === id));
  assert.deepEqual(overlap, [], `resuming re-delivered ${overlap.join(', ')}`);
});

test('sessions sharing one timestamp each appear exactly once', async (t) => {
  // `updated_at_ms` is a millisecond stamp, so sessions tie on it — three do on the
  // machine this was measured on. With no secondary key, which of a tie group lands on
  // which side of a page boundary is a rule nobody wrote down, and a walk can re-deliver
  // the group or skip half of it. The page size here splits the group twice over.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'list-paging-'));
  const projection = await createFixtureProjection(dataDir);
  for (let index = 0; index < 6; index += 1) {
    projection.session({ id: `sess-tie${index}`, title: `Tie ${index}`, updatedAtMs: NOW });
  }
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const { seen, total, reachedEnd } = await walk(store, { limit: 2 });
  assert.ok(reachedEnd);
  assert.equal(seen.length, 6, `the tie group was walked ${seen.length} times over`);
  assert.equal(new Set(seen).size, 6, 'a tied session was delivered twice or skipped');
  assert.equal(seen.length, total);
});

test('an unreadable cursor starts a fresh walk instead of an empty one', async (t) => {
  // A truncated or hand-built cursor reaches the handler as-is — nothing validates
  // `tools/call` arguments. Reading it as a comparison key would compare against `NaN`
  // and answer nothing, and an empty page from the tool whose job is to name sessions
  // reads as "this machine has none".
  //
  // The broken cursors are derived from a real one rather than written from scratch, so
  // they carry its walk fingerprint. That matters: a cursor that also fails the identity
  // check is refused as a *foreign* cursor and never reaches the parser at all, so a
  // parser that quietly answered `NaN` would pass a test built from hand-written
  // garbage. Only a cursor whose fingerprint is right isolates the shape check.
  const store = await seeded(t, 5);
  const first = await list(store, { limit: 2 });
  const [, pin, key, fingerprint, id] = first.nextCursor.split('.');
  const broken = [
    'garbage',
    '',
    'v9.1.2.x',
    ['v2', 'not-a-number', key, fingerprint, id].join('.'),
    ['v2', pin, 'not-a-number', fingerprint, id].join('.'),
    ['v2', pin, key, fingerprint].join('.'),
  ];
  for (const cursor of broken) {
    const reply = await list(store, { limit: 10, cursor });
    assert.ok(reply.sessions.length > 0, `cursor ${JSON.stringify(cursor)} produced an empty page`);
    assert.equal(reply.sessions[0].sessionId, 'sess-0000',
      `cursor ${JSON.stringify(cursor)} did not restart from the newest`);
    assert.equal(reply.note, undefined, 'a malformed cursor is not a foreign walk');
  }
});

test('the offset argument is gone, so there is no positional walk left to fall into', async (t) => {
  // Two paging mechanisms on one tool is one too many: a model that picks the wrong one
  // gets the defect this file exists to prevent, with no reply that says so.
  const store = await seeded(t, 250);
  const reply = await list(store, { limit: 10, offset: 200 });
  assert.equal(reply.sessions[0].sessionId, 'sess-0000', 'an offset still moved the walk');
  assert.equal('offset' in reply, false, 'the reply still echoes an offset');
});

test('total counts the same population the list returns', async (t) => {
  // The count and the rows are built from one filter function; a second copy of those
  // conditions is how a total comes to describe a different population than the list,
  // and a total that disagrees is believed rather than checked.
  const store = await seeded(t, 30);
  for (const filters of [{}, { kind: 'conversation' }, { agent: 'mavis' }, { includeArchived: true }]) {
    const reply = await list(store, { limit: 200, ...filters });
    assert.equal(
      reply.total - reply.sessions.length >= 0,
      true,
      `total ${reply.total} is below the ${reply.sessions.length} rows actually returned for ${JSON.stringify(filters)}`,
    );
  }
  // And when one page holds everything, the two must be equal — with a list that is
  // actually non-empty, or the equality holds trivially at zero and proves nothing.
  const all = await list(store, { limit: 200 });
  assert.ok(all.sessions.length > 0, 'the fixture produced nothing to compare a total against');
  assert.equal(all.total, all.sessions.length);
});

test('the filters still narrow the count, not just the rows', async (t) => {
  // Filtered on `agent`, not `kind`: the shared fixture writes `session_kind` as a
  // literal 'conversation' for every session, so a kind filter could only ever match
  // zero and the case would prove nothing either way.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'list-paging-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-mavis', title: 'A', agent: 'mavis', updatedAtMs: NOW });
  projection.session({ id: 'sess-explore', title: 'B', agent: 'explore', updatedAtMs: NOW - 5000 });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const all = await list(store, { limit: 50 });
  const onlyExplore = await list(store, { limit: 50, agent: 'explore' });
  assert.equal(all.total, 2);
  assert.equal(onlyExplore.total, 1, 'the count ignored the filter the rows honoured');
  assert.deepEqual(onlyExplore.sessions.map((s) => s.sessionId), ['sess-explore']);
});

test('a date range is a range, not a lower bound', async (t) => {
  // "The session from March" is a range. `sinceMs` alone answers it with everything
  // since March — on a busy machine, the whole list, newest first, with the March
  // session buried at whatever offset it lands on. Without an upper bound the
  // question cannot be asked at all, which is why this is a filter and not a hint.
  const store = await seeded(t);
  const all = await list(store, { limit: 200 });
  // From the fixture's own construction, not from the page just read: with 250
  // sessions and a 200-row page, `sessions.at(-1)` is the 200th newest and not the
  // oldest at all — asking this test to derive its bound from a partial page is
  // precisely the mistake the bound exists to prevent.
  const newestMs = NOW;
  const oldestMs = NOW - (SESSIONS - 1) * 1000;
  const newest = all.sessions[0];
  assert.ok(all.total > 2, 'the fixture needs sessions on both sides of the bound');

  const window = await list(store, { limit: 200, sinceMs: oldestMs, untilMs: newestMs });
  assert.equal(window.total, all.total, 'a bound spanning every session changed the count');

  // A window that excludes the newest session must actually exclude it.
  const narrow = await list(store, { limit: 200, untilMs: newestMs - 1 });
  assert.ok(narrow.total < all.total, 'an upper bound did not exclude anything');
  assert.equal(narrow.total, SESSIONS - 1, 'exactly one session sits past the upper bound');
  assert.equal(
    narrow.sessions.some((session) => session.sessionId === newest.sessionId),
    false,
    'a session past the upper bound was returned anyway',
  );
  // And the count and the rows still describe the same population — which here means
  // the count exceeds the page, and the cursor says so rather than the two silently
  // disagreeing. They are only equal when one page holds the whole window.
  assert.equal(narrow.sessions.length, 200, 'the page did not fill to its limit');
  assert.equal(typeof narrow.nextCursor, 'string', 'a window too large for one page offered no cursor');
});

test("a caller's own upper bound is the tighter of the two", async (t) => {
  // The walk pins the instant; a caller asking for "before March" has an upper bound of
  // its own, and taking the newer of the two would silently widen their range back to
  // the whole list. The pin may only ever narrow.
  const store = await seeded(t, 10);
  const reply = await list(store, { limit: 200, untilMs: NOW - 3000 });
  assert.equal(reply.total, 7, 'the walk pin overrode the caller\'s own upper bound');
});

test('a session id carrying a dot does not trap the walk', async (t) => {
  // The cursor joins four fields and the session id with `.`, so a decoder that splits on
  // every dot and reads the id as one field fails on an id that carries one. The failure
  // is not a wrong page: it is a *dead* walk. Every page comes back as page one, each
  // carrying a fresh cursor that also cannot be read, so `nextCursor` is never null and a
  // caller paging until it is — the thing every tool description tells it to do — runs
  // forever.
  //
  // `session_id` is a TEXT primary key and nothing constrains it to the shape the
  // artifact lookup assumes, so the encoding has to survive an id it did not choose.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'list-paging-'));
  const projection = await createFixtureProjection(dataDir);
  const ids = ['sess.plain', 'sess.with.dots', 'a.b.c.d.e.f'];
  ids.forEach((id, index) => projection.session({ id, title: `T${index}`, updatedAtMs: NOW - index * 1000 }));
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const seen = [];
  let cursor;
  let reachedEnd = false;
  let pages = 0;
  for (; pages < 10 && !reachedEnd; pages += 1) {
    const reply = await list(store, { limit: 1, ...(cursor ? { cursor } : {}) });
    seen.push(...reply.sessions.map((session) => session.sessionId));
    reachedEnd = reply.nextCursor === null;
    cursor = reply.nextCursor ?? undefined;
    if (cursor === undefined) break;
  }
  assert.ok(reachedEnd, `the walk never ended after ${pages} pages — a cursor it cannot read keeps handing back page one`);
  assert.deepEqual(seen, ids, 'the walk did not deliver every dotted id exactly once, in order');
});
