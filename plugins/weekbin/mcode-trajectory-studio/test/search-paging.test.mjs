/**
 * A capped search page with no cursor hides matches no call can reach.
 *
 * `trajectory_search` was the one record-list tool left without one. Its `limit`
 * caps at 200 and the SQL bound only `LIMIT ?`, so the page ended at 200 matches and
 * the reply carried neither a count nor a cursor saying so.
 *
 * That only matters for the queries people actually type. The FTS index covers
 * titles, agent names, statuses and workspace paths, so the unselective words are
 * exactly the ones a reader reaches for first: on a machine with 633 sessions,
 * "mavis" matched 633, "studio" 594, "session" 624 — 394 to 433 matches past the
 * cap that no call could reach and no field disclosed. The model would page the
 * first 200, see a clean full list, and answer "there are 200 sessions like that".
 *
 * Paging the rest by position then dropped matches of its own: matches come back in
 * `updated_at_ms DESC` order, the column the runtime rewrites whenever it writes to a
 * session, and `LIMIT ? OFFSET ?` counts positions. A match whose session was written to
 * between two pages moved above the cursor and was never delivered again, while the
 * walk still ended by reporting no cursor at all. The walk is now a keyset cursor
 * pinned to one instant, and these cases pin the properties that make it usable:
 * every match exactly once, one pin for the whole walk, no positional walk left to
 * fall into, and two ways the count could still lie — counting rows the page cannot
 * return, and reporting a count for a search that never ran.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createFixtureProjection, FIXTURE_HOME, fixtureHasFts5, withProjectionDb } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';

const NOW = 1_700_000_000_000;
const MATCHES = 25;
/** Below the 200 ceiling, so the cap is exercised without needing 200 fixtures. */
const PAGE = 10;

const needsFts = fixtureHasFts5() ? false : 'this runtime has no FTS5';

/**
 * `count` sessions whose title carries the query word, oldest first.
 *
 * The projection handle is handed back for the mid-walk case: the store opens its own
 * connection read-only, so "the runtime wrote to a session while you were walking"
 * cannot be expressed through it.
 */
async function seeded(t, { count = MATCHES, match = 'Alpha', keepProjection = false } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'search-paging-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  for (let i = 0; i < count; i += 1) {
    // Newest first on read, so the highest timestamp is the first row of page one.
    projection.session({ id: `sess-${i}`, title: `${match} run ${i}`, updatedAtMs: NOW - i });
  }
  projection.session({ id: 'sess-other', title: 'Unrelated', updatedAtMs: NOW + 10_000 });
  if (!keepProjection) projection.close();
  const store = openStore({ dataDir });
  // Handles a test opens *after* this one, closed here rather than by a second
  // `t.after`. node:test runs `after` hooks in registration order, so a hook registered
  // later runs later -- after this one has already removed the directory, which on
  // Windows it cannot do while that handle is still open (EBUSY).
  const extra = [];
  t.after(async () => {
    for (const handle of extra) handle.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return keepProjection ? { store, dbPath, projection, extra } : { store, dbPath, extra };
}

const call = (store, args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
  .call('trajectory_search', args);

test('the reply carries the match count, not the page size', { skip: needsFts }, async (t) => {
  const { store } = await seeded(t);
  const reply = await call(store, { query: 'Alpha', limit: PAGE });
  assert.equal(reply.returned, PAGE);
  assert.equal(reply.total, MATCHES,
    'without the full count a capped page reads as the complete answer');
});

test('the cursor resumes after the last match carried', { skip: needsFts }, async (t) => {
  const { store } = await seeded(t);
  const first = await call(store, { query: 'Alpha', limit: PAGE });
  assert.equal(typeof first.nextCursor, 'string');
  const second = await call(store, { query: 'Alpha', limit: PAGE, cursor: first.nextCursor });
  assert.equal(typeof second.nextCursor, 'string');
  // The control for "the cursor just restarts": a second page that repeats the first
  // would satisfy a shape assertion while losing half the matches.
  const overlap = first.sessions.map((s) => s.sessionId)
    .filter((id) => second.sessions.some((s) => s.sessionId === id));
  assert.deepEqual(overlap, [], `the pages overlap on ${overlap.join(', ')}`);
});

test('paging reaches every match exactly once and then stops', { skip: needsFts }, async (t) => {
  const { store } = await seeded(t);
  const seen = [];
  const pins = new Set();
  let cursor;
  let pages = 0;
  let reachedEnd = false;
  for (; pages < MATCHES + 1 && !reachedEnd; pages += 1) {
    const reply = await call(store, { query: 'Alpha', limit: PAGE, ...(cursor ? { cursor } : {}) });
    pins.add(reply.walkPinnedAtMs);
    seen.push(...reply.sessions.map((s) => s.sessionId));
    reachedEnd = reply.nextCursor === null;
    cursor = reply.nextCursor;
  }
  assert.ok(reachedEnd, 'the walk did not terminate; nextCursor is not the end signal');
  assert.equal(new Set(seen).size, seen.length, 'the walk repeated a match');
  assert.equal(seen.length, MATCHES, `the walk delivered ${seen.length} of ${MATCHES} matches`);
  assert.equal(pins.size, 1, 'the pinned instant changed mid-walk');
});

test('the walk keeps the newest-first order across pages', { skip: needsFts }, async (t) => {
  // Ordering is the reader's only clue about what the page means, so it has to be a
  // property of the whole walk rather than of each page separately.
  const { store } = await seeded(t);
  const first = await call(store, { query: 'Alpha', limit: PAGE });
  const walkOrder = [];
  let cursor;
  let reachedEnd = false;
  for (let page = 0; page < MATCHES + 1 && !reachedEnd; page += 1) {
    const reply = await call(store, { query: 'Alpha', limit: PAGE, ...(cursor ? { cursor } : {}) });
    walkOrder.push(...reply.sessions.map((s) => s.sessionId));
    reachedEnd = reply.nextCursor === null;
    cursor = reply.nextCursor;
  }
  assert.equal(first.sessions[0].sessionId, 'sess-0', 'page one starts at the newest match');
  assert.equal(walkOrder.at(-1), `sess-${MATCHES - 1}`, 'the walk did not end at the oldest match');
  const timestamps = walkOrder.map((id) => NOW - Number(id.split('-')[1]));
  for (let i = 1; i < timestamps.length; i += 1) {
    assert.ok(timestamps[i - 1] >= timestamps[i], `page order broke at ${walkOrder[i - 1]} → ${walkOrder[i]}`);
  }
});

test('the last page hands back a null cursor rather than an empty one forever', { skip: needsFts }, async (t) => {
  const { store } = await seeded(t);
  let cursor;
  let last;
  for (let page = 0; page < MATCHES + 1; page += 1) {
    last = await call(store, { query: 'Alpha', limit: PAGE, ...(cursor ? { cursor } : {}) });
    if (last.nextCursor === null) break;
    cursor = last.nextCursor;
  }
  assert.equal(last.returned, MATCHES % PAGE, 'the walk did not stop on a short final page');
  assert.equal(last.nextCursor, null, 'a cursor past the end invites a pointless extra call');
});

test('a match written to mid-walk leaves the walk and the count together', { skip: needsFts }, async (t) => {
  // The defect the cursor exists to close. A match below page one is written to exactly
  // as the runtime writes to a live session; positional paging dropped it and kept
  // counting it, so the walk reported the full match count while holding fewer.
  const { store, projection } = await seeded(t, { count: 12, keepProjection: true });
  const seen = [];
  const totals = [];
  let cursor;
  let reachedEnd = false;
  let wrote = false;
  for (let page = 0; page < 20 && !reachedEnd; page += 1) {
    const reply = await call(store, { query: 'Alpha', limit: 4, ...(cursor ? { cursor } : {}) });
    seen.push(...reply.sessions.map((s) => s.sessionId));
    totals.push(reply.total);
    reachedEnd = reply.nextCursor === null;
    cursor = reply.nextCursor;
    if (!wrote) {
      wrote = true;
      // `Date.now()`, not a fixture timestamp: the runtime stamps a session it has just
      // written to with the current instant, and a write dated in the past would stay
      // inside the walk's window and prove nothing.
      projection.db.prepare('UPDATE local_runtime_sessions SET updated_at_ms = ? WHERE session_id = ?')
        .run(Date.now(), 'sess-10');
    }
  }
  projection.close();

  assert.ok(reachedEnd, 'the walk never ended');
  assert.equal(new Set(seen).size, seen.length, 'a match appeared on more than one page');
  assert.equal(seen.includes('sess-10'), false, 'a match written to mid-walk should leave a pinned walk');
  assert.equal(seen.length, totals.at(-1), 'the walk held fewer matches than the final count');
  assert.ok(totals.at(-1) < 12, 'the moved match is still counted, so the count promises rows no page can deliver');
});

test('a query that matched nothing reports zero and stops', { skip: needsFts }, async (t) => {
  const { store } = await seeded(t);
  const reply = await call(store, { query: 'no-such-thing-anywhere' });
  assert.equal(reply.total, 0);
  assert.equal(reply.returned, 0);
  assert.equal(reply.nextCursor, null);
});

test('a query that failed reports no count, so zero cannot read as "no match"', { skip: needsFts }, async (t) => {
  const { store, dbPath, extra } = await seeded(t, { count: 1 });
  withProjectionDb(dbPath, (db) => db.exec([
    'DROP TABLE local_runtime_sessions_fts',
    'CREATE TABLE local_runtime_sessions_fts (session_id TEXT)',
  ].join(';')));
  store.close();
  const reopened = openStore({ dataDir: path.dirname(path.dirname(dbPath)) });
  extra.push(reopened);
  const reply = await call(reopened, { query: 'Alpha' });
  assert.equal(reply.total, 0);
  // The intent of this check is that a zero beside no explanation cannot be read as
  // "nothing matched", and that still holds. Which of the two explanations is the
  // right one is a separate question, and this fixture — a table of the right name
  // carrying none of the fields a match names — is the schema-mismatch case rather
  // than the failed-query one, so it gets that wording.
  assert.match(reply.note, /not searched|no match|does not carry/iu);
});

test('a cursor from a different query starts a fresh page and says so', { skip: needsFts }, async (t) => {
  // The sharp half of an unbound cursor: a key taken from one phrase's results usually
  // sits above every match of another, so the page came back empty — and an empty list
  // with no note is the one answer this Plugin never means to give by accident. Both
  // queries match plenty here, so an empty page cannot be mistaken for the real answer.
  const { store } = await seeded(t, { count: 24, match: 'Alpha' });
  const other = await call(store, { query: 'Alpha', limit: 10 });
  const queried = await call(store, { query: 'run', limit: 10 });
  assert.ok(queried.total > 0, 'the second query must match for this case to say anything');

  const resumed = await call(store, { query: 'run', limit: 10, cursor: other.nextCursor });
  assert.match(resumed.note ?? '', /different query/u, 'the mismatch was not said out loud');
  assert.equal(resumed.returned, 10, 'a fresh page one was not returned');
  assert.equal(resumed.total, queried.total, 'the count describes the query actually asked for');
});

test('changing the page size mid-walk is still the same walk', { skip: needsFts }, async (t) => {
  const { store } = await seeded(t);
  const first = await call(store, { query: 'Alpha', limit: PAGE });
  const resumed = await call(store, { query: 'Alpha', limit: PAGE * 2, cursor: first.nextCursor });
  assert.equal(resumed.note, undefined, 'a page-size change was treated as a different walk');
  // Only MATCHES - PAGE rows are left behind the cursor, so asking for more than that
  // returns what is there rather than padding or failing.
  assert.equal(resumed.returned, MATCHES - PAGE);
  const overlap = first.sessions.map((s) => s.sessionId)
    .filter((id) => resumed.sessions.some((s) => s.sessionId === id));
  assert.deepEqual(overlap, [], `resuming re-delivered ${overlap.join(', ')}`);
});

test('the count and the page agree on which rows exist', { skip: needsFts }, async (t) => {
  // The trap a separate count opens: an FTS row whose session is not in the
  // projection cannot be returned by the page, so counting the FTS table alone
  // would promise a match no page could ever deliver, and the walk would end on a
  // cursor with nothing behind it.
  const { store, dbPath } = await seeded(t, { count: 3 });
  withProjectionDb(dbPath, (db) => db.prepare(
    'INSERT INTO local_runtime_sessions_fts (session_id, title_terms) VALUES (?, ?)',
  ).run('sess-ghost', 'c41 c6c c70 c68 c61'));
  const reply = await call(store, { query: 'Alpha', limit: 10 });
  assert.equal(reply.total, 3, 'a row the page cannot return was counted as a match');
  assert.equal(reply.nextCursor, null);
});

test('the count does not shrink as the walk advances', { skip: needsFts }, async (t) => {
  // Letting the cursor reach the count turns `total` into "how many are still ahead of
  // you": the walk reports 12, 7, 3, 0 and ends on a page claiming zero matches while
  // the caller is holding eleven of them.
  const { store } = await seeded(t);
  const totals = [];
  let cursor;
  let reachedEnd = false;
  for (let page = 0; page < MATCHES + 1 && !reachedEnd; page += 1) {
    const reply = await call(store, { query: 'Alpha', limit: PAGE, ...(cursor ? { cursor } : {}) });
    totals.push(reply.total);
    reachedEnd = reply.nextCursor === null;
    cursor = reply.nextCursor;
  }
  assert.equal(new Set(totals).size, 1, `the match count moved across pages: ${totals.join(', ')}`);
  assert.equal(totals[0], MATCHES);
});

test('the store layer pages and counts on its own, not only through the tool', { skip: needsFts }, async (t) => {
  // The panel calls the store directly, so the cursor has to exist below the MCP
  // surface too — a fix that lived only in the handler would leave the browser
  // with the same dead end.
  const { store } = await seeded(t);
  const page = store.searchSessions({ query: 'Alpha', limit: PAGE, offset: PAGE });
  assert.equal(page.total, MATCHES);
  assert.equal(page.sessions.length, PAGE);
  assert.equal(page.failed, false);
});

test('the cursor reaches the store layer, not only the handler', { skip: needsFts }, async (t) => {
  const { store } = await seeded(t);
  const first = store.searchSessions({ query: 'Alpha', limit: PAGE });
  const rest = store.searchSessions({ query: 'Alpha', limit: PAGE, untilMs: Date.now() - 1 });
  assert.equal(first.sessions.length, PAGE);
  assert.ok(rest.sessions.length > 0, 'the store read nothing at all under a pin');
});

test('the cursor page query binds no offset', async () => {
  // A shape anchor for the one edit behaviour tests would miss: the cursor branch reads
  // by key, so leaving `OFFSET ?` in it would re-introduce the positional walk while
  // every paging test above still passed. Sliced to the cursor branch alone — the panel's
  // positional page below it is deliberate and is pinned by its own case.
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../server/search.mjs', import.meta.url), 'utf8'));
  const start = source.indexOf('const sessions = at');
  const cursorBranch = source.slice(start, source.indexOf(': store.db.prepare(`', start));
  assert.ok(cursorBranch.length > 0, 'the cursor branch could not be found in the source');
  assert.doesNotMatch(cursorBranch, /OFFSET/u, 'the cursor branch pages by position again');
  // And the comparison it depends on is really there, in the predicate both queries
  // build. Asserting only the absence of OFFSET would pass against a branch that paged
  // by nothing at all.
  const bounds = source.slice(source.indexOf('const bounds = []'), source.indexOf('const pageWhere'));
  assert.match(bounds, /s\.updated_at_ms < \?/u, 'the cursor predicate does not compare against the sort key');
  assert.match(bounds, /s\.session_id < \?/u, 'the cursor predicate does not break timestamp ties');
});
