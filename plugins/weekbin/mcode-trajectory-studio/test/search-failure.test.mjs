/**
 * A search that never ran is not a search that found nothing.
 *
 * `trajectory_search` already went to some trouble to separate "the answer is empty"
 * from "search is off": `ftsAvailable` is false and a `note` says so on a runtime
 * whose bundled SQLite has no FTS5. That distinction is the whole reason the field
 * exists — an empty `sessions: []` on such a runtime reads as "nothing matched"
 * otherwise.
 *
 * The query *throwing* produced the same empty list with `ftsAvailable: true` and no
 * note. So the one case where the answer is least trustworthy was the one case the
 * disclosure did not cover: the reader was told search was available, given nothing,
 * and had every reason to conclude their query was wrong.
 *
 * The fix carries the failure out of the store layer instead of leaving it in a
 * session-level log that `trajectory_search` callers never read.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createFixtureProjection, FIXTURE_HOME, fixtureHasFts5 } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';
import { createRequestHandler } from '../server/http.mjs';

const NOW = 1_700_000_000_000;

async function seeded(t, { breakFts = false, thinIndex = false, noFts = false } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'search-failed-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Alpha', updatedAtMs: NOW });
  projection.close();
  if (noFts) {
    // No index at all — the state a Node runtime bundling SQLite without FTS5 is in.
    // Distinct from both shapes below: there the table is present, so the schema probe
    // has something to answer. Here there is nothing to probe and the store's own
    // capability flag is the whole of the answer.
    const bare = new DatabaseSync(dbPath);
    bare.exec('DROP TABLE local_runtime_sessions_fts');
    bare.close();
  }
  if (breakFts) {
    // A *damaged* index, not a missing one. Dropping the table outright is the
    // `ftsAvailable: false` case, which the tool already discloses and which this file
    // is not about. Replacing the virtual table with a plain table of the same name
    // passes the probe — the name is in sqlite_master — and fails only when `MATCH`
    // is used against it, which is the shape a half-written index actually takes.
    //
    // All seven indexed columns are kept, so the schema guard passes and the query
    // really is attempted. This is the path that must end in `failed`.
    const damaged = new DatabaseSync(dbPath);
    damaged.exec('DROP TABLE local_runtime_sessions_fts');
    damaged.exec(`CREATE TABLE local_runtime_sessions_fts (
      session_id TEXT, session_id_terms TEXT, agent_name_terms TEXT, title_terms TEXT,
      workspace_dir_terms TEXT, purpose_terms TEXT, status_terms TEXT, session_type_terms TEXT
    )`);
    damaged.close();
  }
  if (thinIndex) {
    // The other damage: the table is a plain table of the right name but carries only
    // one of the indexed columns. The schema guard catches this before any query
    // runs, which is a different answer with a different cause — `unsearchable`
    // rather than `failed` — and is covered separately below.
    const damaged = new DatabaseSync(dbPath);
    damaged.exec('DROP TABLE local_runtime_sessions_fts');
    damaged.exec('CREATE TABLE local_runtime_sessions_fts (session_id TEXT)');
    damaged.close();
  }
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const call = (store, args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
  .call('trajectory_search', args);

test('a working search answers with rows and no note', { skip: fixtureHasFts5() ? false : 'this runtime has no FTS5' }, async (t) => {
  const store = await seeded(t);
  const reply = await call(store, { query: 'Alpha' });
  assert.equal(reply.ftsAvailable, true);
  assert.equal(reply.note, undefined, 'a search that worked should not carry an explanation of why it might not have');
  assert.deepEqual(reply.sessions.map((s) => s.sessionId), ['sess-a']);
});

test('a search that matched nothing is empty and unremarked', { skip: fixtureHasFts5() ? false : 'this runtime has no FTS5' }, async (t) => {
  // The control for the case below. "Nothing matched" genuinely deserves a bare empty
  // list, so the note has to be specific to failure rather than to emptiness.
  const store = await seeded(t);
  const reply = await call(store, { query: 'no-such-thing-anywhere' });
  assert.deepEqual(reply.sessions, []);
  assert.equal(reply.note, undefined, 'a search that ran and matched nothing was reported as a failure');
  assert.equal(reply.ftsAvailable, true);
});

test('a full-text query that fails says the result is "not searched"', { skip: fixtureHasFts5() ? false : 'this runtime has no FTS5' }, async (t) => {
  const store = await seeded(t, { breakFts: true });
  const reply = await call(store, { query: 'Alpha' });
  assert.deepEqual(reply.sessions, [], 'the fallback is still empty — that is what makes the note necessary');
  assert.equal(reply.ftsAvailable, true, 'the store still believes FTS5 is available, which is the whole trap');
  assert.match(reply.note, /failed/iu);
  assert.match(reply.note, /not searched|no match/iu,
    'the note has to distinguish a failed search from a query that simply matched nothing');
});

test('the store reports the failure rather than only the session log', { skip: fixtureHasFts5() ? false : 'this runtime has no FTS5' }, async (t) => {
  // `store.warn` was already recording this, but it reaches `trajectory_list` and not
  // the tool that needs to know — so the caller's answer carried nothing.
  const store = await seeded(t, { breakFts: true });
  const result = store.searchSessions({ query: 'Alpha' });
  assert.deepEqual(result.sessions, []);
  assert.equal(result.failed, true);
  assert.equal(result.unsearchable, false, 'a query that ran and broke is not a schema mismatch');
  assert.ok(
    store.warnings.some((warning) => warning.startsWith('search_failed:')),
    'the failure was not recorded on the store either',
  );
});

test('an index missing the searched fields is reported as unsearchable, not as no match', { skip: fixtureHasFts5() ? false : 'this runtime has no FTS5' }, async (t) => {
  // The third shape. The table is there and FTS5 works, but it does not carry the
  // columns a match expression names, so no query of this form can ever run here.
  //
  // This is deliberately not folded into `failed`. That flag means a query ran and
  // broke, which is worth retrying; this one is a property of the schema, which no
  // retry will change. Collapsing the two — or answering with a plain empty list —
  // is the confusion this file exists to prevent.
  const store = await seeded(t, { thinIndex: true });
  const result = store.searchSessions({ query: 'Alpha' });
  assert.deepEqual(result.sessions, [], 'the empty list is what makes the flag necessary');
  assert.equal(result.total, 0);
  assert.equal(result.unsearchable, true);
  assert.equal(result.failed, false, 'nothing failed; the query was never attempted');
  assert.ok(
    store.warnings.some((warning) => warning.startsWith('search_columns_missing:')),
    `the mismatch was not recorded: ${JSON.stringify(store.warnings)}`,
  );
});

test('the tool tells an unsearchable index apart from a failed query', { skip: fixtureHasFts5() ? false : 'this runtime has no FTS5' }, async (t) => {
  // The wording is the whole point: both answers are empty lists, and the note is the
  // only thing that separates "try again" from "this build cannot do that".
  const store = await seeded(t, { thinIndex: true });
  const reply = await call(store, { query: 'Alpha' });
  assert.equal(reply.ftsAvailable, true);
  assert.match(reply.note, /does not carry the fields/iu);
  assert.doesNotMatch(reply.note, /query failed/iu,
    'an index mismatch was described as a failed query, which invites a pointless retry');
});
test('a runtime with no index at all says so on the panel too, not only on MCP', { skip: fixtureHasFts5() ? false : 'this runtime has no FTS5' }, async (t) => {
  // The `breakFts` comment above calls the dropped-table case "the `ftsAvailable: false`
  // case, which the tool already discloses", and leaves it out of this file on that
  // basis. True of `trajectory_search`, which checks `hasFts` itself. False of the panel:
  // `searchSessions` returned the bare empty list whenever the store had no index, so
  // `/api/search` answered `searchUnsearchable: false, searchFailed: false, total: 0` and
  // the client's three-way banner fell all the way through to 没有匹配的会话.
  //
  // That is the finding, not a cosmetic one: this build of Node bundles SQLite without
  // FTS5, so on it the panel's search box reports "no session matches that" for every
  // query on a machine that cannot search at all — while the MCP tool, asked the same
  // question about the same store, says the runtime cannot search. One store, two
  // surfaces, one honest answer and one that invents a finding.
  const store = await seeded(t, { noFts: true });
  assert.equal(store.hasFts, false, 'this store still has an index, so the case under test is not it');

  const result = store.searchSessions({ query: 'Alpha' });
  assert.equal(result.unsearchable, true, 'a store with no index reported itself as searchable');
  assert.equal(result.failed, false, 'nothing ran, so nothing failed');
  assert.deepEqual(result.sessions, []);
  // The flag has to come from the **guard**, not from somewhere else in the reply. A
  // mutation that rewrote these two returns as `{ ...EMPTY, unsearchable: true }` looked
  // like the defect it was meant to be and left every assertion here green — `EMPTY`
  // already carries `unsearchable`, so the spread's explicit `true` and the guard's
  // `extra` argument are the same value wearing two shapes. An equivalent mutation is
  // not weak, it is **invisible**: it reports a pass for a face nothing tested.
  //
  // So the no-index case is checked on its own terms rather than through a shared
  // helper, and the mutation tier was rewritten to drop the flag outright instead of
  // re-spelling it.
  assert.equal(result.objectivesIndexed, true,
    'the objective channel does not need an index, so it still ran and says so');
  assert.deepEqual(result.objectiveMatchedSessionIds, [],
    'and it found nothing here because this projection records no goals');

  // The note has to name the *right* one of the two facts. `searchSessions` now reports
  // this case as unsearchable, and the tool's first cut reused the schema wording for it
  // — "does not carry the fields full-text search needs" — which points the reader at an
  // index that does not exist on this runtime at all. The test caught that, which is the
  // reason it is written against the wording and not only the flag.
  const mcp = await call(store, { query: 'Alpha' });
  assert.equal(mcp.ftsAvailable, false);
  assert.match(mcp.note, /without FTS5/iu,
    'a runtime with no index was described as having one that lacks fields');
  assert.doesNotMatch(mcp.note, /does not carry the fields/iu,
    'the schema-mismatch wording was used for a runtime that has no index at all');

  const TOKEN = 'search-failure-token';
  const res = {
    statusCode: 200, headers: {}, body: '',
    writeHead(c) { this.statusCode = c; }, setHeader() {}, end(c) { this.body = c ?? ''; },
  };
  await createRequestHandler({
    store, homeDir: FIXTURE_HOME, getFocus: () => null, setFocus: () => {}, getToken: () => TOKEN,
  })({
    method: 'GET', url: '/api/search?q=Alpha&limit=10',
    headers: { host: '127.0.0.1:1', 'x-trajectory-token': TOKEN },
    socket: { localPort: 1, remoteAddress: '127.0.0.1' },
  }, res);

  assert.equal(res.statusCode, 200, 'the route answered with an error instead of a state');
  const panel = JSON.parse(res.body);
  assert.equal(panel.searchUnsearchable, true,
    'the panel route reported a machine that cannot search as one with no matches');
  assert.equal(panel.searchFailed, false);
  assert.deepEqual(panel.sessions, []);
});

test('an empty query is still an ordinary empty answer, not a refusal', { skip: fixtureHasFts5() ? false : 'this runtime has no FTS5' }, async (t) => {
  // The one early return that must stay benign. `unsearchable` means "this installation
  // cannot search", and a caller who typed nothing has not asked anything — folding the
  // two together would make the panel claim the runtime is broken before the first
  // keystroke. Checked on a *working* index, so the no-index path cannot hide a
  // regression that affects the ordinary case.
  const store = await seeded(t);
  assert.equal(store.hasFts, true, 'this case needs a store that can search');
  // The whole object again: the objective fields ride on every path now, including this
  // one, and `objectivesIndexed: false` is right here — an empty query searched nothing.
  assert.deepEqual(store.searchSessions({ query: '' }),
    {
      sessions: [],
      total: 0,
      failed: false,
      unsearchable: false,
      objectivesIndexed: false,
      objectiveMatchedSessionIds: [],
    });
});
