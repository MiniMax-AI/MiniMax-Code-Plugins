/**
 * A session that exists but has no records anywhere is not an empty session.
 *
 * The projection holds a `local_runtime_sessions` row for every session the runtime has
 * heard of, and message rows for the ones it has indexed. Those are separate decisions,
 * and on the machine this was found on there were 18 sessions sitting in the first state
 * and not the second — every one of them at least a week old, twelve of them archived,
 * several carrying titles like "Skill Sync Upgrade" from work that plainly happened.
 *
 * Every surface answered those sessions with clean emptiness. `trajectory_summary`
 * returned `turns: 0, steps: 0, toolCalls: 0`. `trajectory_turns` returned
 * `source: 'sqlite', total: 0, turns: []`. `trajectory_get` returned
 * `source: 'sqlite', total: 0, returned: 0`. No note, no flag, no warning — just a
 * correct count of nothing, which is the shape a reader treats as an answer. A model
 * asked "what did this session do?" and given that reply says it did nothing, with the
 * same confidence it would use for a session that really was empty, and it cannot tell
 * the two apart from the reply.
 *
 * The row exists, so nothing upstream rejects the id either: `requireSession` accepts a
 * session on either the row or the artifact, and the artifact was not there either.
 *
 * What the reply now says is `recordsUnavailable: true` — a capability, not a count, in
 * the same family as `ftsAvailable` and `tasksAvailable`. The zeros stay, because they
 * are true; the flag is what stops them being read as a finding.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureProjection } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';
import { createRequestHandler } from '../server/http.mjs';
import { recordsUnavailable } from '../server/jsonl.mjs';

const NOW = 1_700_000_000_000;
const FIXTURE_HOME = '/tmp/trajectory-unavailable-home';
const PORT = 4793;
const TOKEN = 'unavailable-token';

const studio = {
  start: async () => ({ url: 'http://127.0.0.1:1/', port: 1, reused: false }),
  stop: async () => true,
};

/**
 * A projection holding one session, with `rows` indexed message rows and optionally the
 * session's `messages.jsonl` on disk.
 *
 * The three states have to be separable, because each one is a different answer and the
 * whole defect is that they used to be the same one. `rows: 0, artifact: false` is the
 * state under test; `rows: 0, artifact: true` is the transient one a fresh session is
 * in before the indexer reaches it; `rows > 0` is the ordinary case that must stay
 * silent.
 */
async function session(t, { id = 'sess-a', rows = 0, artifact = false } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-unavailable-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id, title: 'Unindexed', updatedAtMs: NOW });
  for (let i = 0; i < rows; i += 1) {
    projection.row({
      sessionId: id,
      msgId: `m${i}`,
      role: i === 0 ? 'user' : 'assistant',
      turnId: 't1',
      createdAtMs: NOW + i,
      data: { msg_content: `record ${i}` },
    });
  }
  projection.close();
  if (artifact) {
    const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '20', `10-00-00-000-${id}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'messages.jsonl'), `${JSON.stringify({
      message_id: 'on-disk-1',
      // Inside `message`, where the runtime writes it — a top-level copy is a shape no
      // real artifact has, and it makes a working read look broken.
      message: { role: 'user', timestamp: NOW, content: 'record on disk' },
    })}\n`, 'utf8');
  }
  const store = openStore({ dataDir });
  // See the same note in `search-paging.test.mjs`: a handle opened after this hook was
  // closed by a second `t.after`, which runs *after* this one -- so the directory was
  // already being removed while that handle was still open.
  const extra = [];
  t.after(async () => {
    for (const handle of extra) handle.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store, id, extra };
}

function callTool(store, name, args) {
  return createHandler({ store, studio, homeDir: FIXTURE_HOME }).call(name, args);
}

function makeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); },
  };
}

async function apiGet(store, url) {
  const res = makeRes();
  const handler = createRequestHandler({
    store,
    homeDir: FIXTURE_HOME,
    getFocus: () => null,
    setFocus: () => {},
    getToken: () => TOKEN,
  });
  await handler({
    method: 'GET',
    url,
    headers: { host: `127.0.0.1:${PORT}`, 'x-trajectory-token': TOKEN },
    socket: { localPort: PORT, remoteAddress: '127.0.0.1' },
  }, res);
  assert.equal(res.status, 200, `${url} did not answer 200: ${res.body}`);
  return JSON.parse(res.body);
}

/* -------------------------------------------------------- the defect itself -- */

test('a session with no records anywhere is flagged by every tool that reads them', async (t) => {
  const { store, id } = await session(t);

  const summary = await callTool(store, 'trajectory_summary', { sessionId: id });
  const turns = await callTool(store, 'trajectory_turns', { sessionId: id });
  const records = await callTool(store, 'trajectory_get', { sessionId: id, limit: 50 });
  const search = await callTool(store, 'trajectory_find', { sessionId: id, query: 'record', limit: 50 });

  // The zeros are still asserted, and that is the point: the flag does not replace the
  // counts, it stops them being mistaken for a finding. A fix that published the flag
  // and started inventing numbers would satisfy neither.
  assert.equal(summary.turns, 0);
  assert.equal(summary.toolCalls, 0);
  assert.equal(turns.total, 0);
  assert.equal(records.total, 0);
  assert.equal(records.returned, 0);

  assert.equal(summary.recordsUnavailable, true, 'trajectory_summary did not disclose it');
  assert.equal(turns.recordsUnavailable, true, 'trajectory_turns did not disclose it');
  assert.equal(records.recordsUnavailable, true, 'trajectory_get did not disclose it');
  assert.equal(search.recordsUnavailable, true, 'trajectory_find did not disclose it');
});

test('a search over an unreadable session says it searched nothing', async (t) => {
  // The fourth tool, and the one where the omission was worst. `trajectory_find` answers
  // `total: 0, matches: []` for a session it never read a single record of, and that is
  // read as a claim about the content — the word is absent from this run. On the machine
  // this was found on, the query `the` matches 22,207 records of a real session and zero
  // of an unreadable one, so the number does not even depend on what was asked.
  const { store, id } = await session(t);
  const search = await callTool(store, 'trajectory_find', { sessionId: id, query: 'record', limit: 50 });

  assert.equal(search.total, 0);
  assert.equal(search.matches.length, 0);
  assert.equal(search.recordsUnavailable, true,
    'a search that never searched reported zero matches with nothing to say so');
});

test('a search that really matched keeps quiet about missing records', async (t) => {
  // The control for the case above. A disclosure that fires whenever a search returns
  // nothing would be worse than the silence: "nothing found" is the ordinary answer for a
  // word that is genuinely not in a session, and flagging it would train the reader to
  // ignore the flag.
  const { store, id } = await session(t, { rows: 3 });
  const hit = await callTool(store, 'trajectory_find', { sessionId: id, query: 'record', limit: 50 });
  const miss = await callTool(store, 'trajectory_find', { sessionId: id, query: 'absentword', limit: 50 });

  assert.equal(hit.total, 3, 'the fixture did not match the query it was searched for');
  assert.equal(hit.matches.length, 3);
  assert.equal(hit.recordsUnavailable, undefined);

  assert.equal(miss.total, 0);
  assert.equal(miss.matches.length, 0);
  assert.equal(miss.recordsUnavailable, undefined,
    'a word genuinely absent from a readable session was reported as unreadable');
});

test('the panel route discloses the same thing', async (t) => {
  const { store, id } = await session(t);
  const page = await apiGet(store, `/api/events?id=${id}&limit=50`);
  assert.equal(page.total, 0);
  assert.equal(page.recordsUnavailable, true, '/api/events did not disclose it');
});

test('an unknown session id is not reported as one whose records went missing', async (t) => {
  const { store } = await session(t);
  // `/api/events` takes its id from the query string and never resolves it first, so
  // without the existence check this answered "the records are unavailable" for a
  // session that was never there — a second wrong answer next to the first.
  const page = await apiGet(store, '/api/events?id=sess-never-existed&limit=50');
  assert.equal(page.recordsUnavailable, undefined);
});

/* ------------------------------------------------------------------ controls -- */

test('an indexed session says nothing about missing records', async (t) => {
  const { store, id } = await session(t, { rows: 3 });

  const summary = await callTool(store, 'trajectory_summary', { sessionId: id });
  const turns = await callTool(store, 'trajectory_turns', { sessionId: id });
  const records = await callTool(store, 'trajectory_get', { sessionId: id, limit: 50 });
  const page = await apiGet(store, `/api/events?id=${id}&limit=50`);

  // Absent rather than `false`. The other disclosures in this Plugin are conditional for
  // the same reason: a field that is only ever `true` is a fact, and a field that is
  // sometimes `false` asks every reader to check which it is.
  assert.equal(summary.recordsUnavailable, undefined);
  assert.equal(summary.recordsInArtifact, undefined);
  assert.equal(turns.recordsUnavailable, undefined);
  assert.equal(records.recordsUnavailable, undefined);
  assert.equal(page.recordsUnavailable, undefined);
  const search = await callTool(store, 'trajectory_find', { sessionId: id, query: 'record', limit: 50 });
  assert.equal(search.recordsUnavailable, undefined);

  // The control has to be a session that really has records, or "said nothing" would be
  // satisfied by a fixture that reached the same empty answer as the defect.
  assert.equal(summary.turns, 1);
  assert.equal(turns.total, 1);
  assert.equal(records.returned, 3);
});

test('a session whose records are on disk is not reported as unavailable', async (t) => {
  const { store, id } = await session(t, { rows: 0, artifact: true });

  const summary = await callTool(store, 'trajectory_summary', { sessionId: id });
  const turns = await callTool(store, 'trajectory_turns', { sessionId: id });
  const records = await callTool(store, 'trajectory_get', { sessionId: id, limit: 50 });

  // The fixture reached the artifact path rather than the empty one, so a pass here is
  // not a pass on a session that happened to be empty for a different reason.
  assert.equal(turns.source, 'jsonl', 'the fixture did not fall back to the artifact');
  assert.equal(records.source, 'jsonl');
  assert.equal(records.returned, 1);

  assert.equal(summary.recordsUnavailable, undefined, 'readable records were reported as missing');
  assert.equal(turns.recordsUnavailable, undefined);
  assert.equal(records.recordsUnavailable, undefined);
  const search = await callTool(store, 'trajectory_find', { sessionId: id, query: 'record', limit: 50 });
  assert.equal(search.recordsUnavailable, undefined);
  assert.equal(search.source, 'jsonl', 'the search did not fall back to the artifact');
});

/* ------------------------------------- the summary the two list tools disagree with -- */

test('a summary that folded nothing says the records are in the artifact', async (t) => {
  const { store, id } = await session(t, { rows: 0, artifact: true });

  const summary = await callTool(store, 'trajectory_summary', { sessionId: id });
  const records = await callTool(store, 'trajectory_get', { sessionId: id, limit: 50 });

  // The transient shape the fallback was written for: the session row has landed, the
  // artifact is on disk, the indexer has not reached the message rows. `trajectory_get`
  // lists the record; `trajectory_summary` folds only the projection, so it cannot
  // report it — and every number in it is a correct count of the projection, which is
  // why it read as a contradiction rather than as a limitation.
  assert.equal(records.returned, 1, 'the fixture lost its artifact record');
  assert.equal(summary.turns, 0, 'the fold can only count what it read');
  assert.equal(summary.recordsInArtifact, true,
    'trajectory_summary reported zeroes beside a session its own tools list records for');
});

test('the two disclosure fields are mutually exclusive', async (t) => {
  const nowhere = await session(t);
  const summary = await callTool(nowhere.store, 'trajectory_summary', { sessionId: nowhere.id });
  assert.equal(summary.recordsUnavailable, true);
  assert.equal(summary.recordsInArtifact, undefined, 'a session with no records claimed some');

  const onDisk = await session(t, { id: 'sess-b', artifact: true });
  const other = await callTool(onDisk.store, 'trajectory_summary', { sessionId: onDisk.id });
  assert.equal(other.recordsInArtifact, true);
  assert.equal(other.recordsUnavailable, undefined, 'a readable session was reported as missing');
});

/* ------------------------------------------------------------------- the predicate -- */

test('the predicate refuses every answer it cannot support', () => {
  const artifact = { source: 'jsonl', events: [] };

  // The three refusals, each for its own reason.
  assert.equal(recordsUnavailable({ sessionExists: true, projectionRows: 0 }), true);
  assert.equal(recordsUnavailable({ sessionExists: false, projectionRows: 0 }),
    false, 'a session that does not exist has no missing records');
  assert.equal(recordsUnavailable({ sessionExists: true, projectionRows: null }),
    false, 'a count that failed is not a count of zero');
  assert.equal(recordsUnavailable({ sessionExists: true, projectionRows: 4 }),
    false, 'a session with rows is not one whose records went missing');
  assert.equal(recordsUnavailable({ sessionExists: true, projectionRows: 0, artifact }),
    false, 'an artifact found and read is evidence about the session either way');
  assert.equal(recordsUnavailable(), false, 'the predicate answered about nothing');
});

test('a row count that cannot be computed is not read as zero', async (t) => {
  const { dataDir, store, id, extra } = await session(t, { rows: 3 });
  // Closed and reopened with the table gone, so `messageRowCount` takes its error path.
  store.close();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  raw.exec('ALTER TABLE local_runtime_message_rows RENAME TO gone_rows');
  raw.close();

  const damaged = openStore({ dataDir });
  extra.push(damaged);
  assert.equal(damaged.messageRowCount(id), null, 'a failed count came back as a number');

  // A store that could not look must not be reported as one that looked and found
  // nothing — that is the same confident wrong answer this file is about, one layer down.
  const reply = await callTool(damaged, 'trajectory_get', { sessionId: id, limit: 5 });
  assert.equal(reply.recordsUnavailable, undefined);
});