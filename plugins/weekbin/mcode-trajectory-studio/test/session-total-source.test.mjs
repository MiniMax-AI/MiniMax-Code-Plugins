/**
 * `sessionTotal` described the wrong session.
 *
 * `getEvents` returns two counts: `total` (what matched the query) and `sessionRows`
 * (what the session holds). When a session has no indexed rows, the read falls back to
 * its `messages.jsonl` — and the fallback merged the artifact over the projection with
 * `{ ...page, ...artifact }`. `readJsonlEvents` has no `sessionRows` of its own, so the
 * projection's own `0` survived into a reply that carried the artifact's events.
 *
 * Both surfaces then published it, because the emit condition asks whether the two
 * counts differ and `0 !== null` differs:
 *
 *   source: 'jsonl', total: null, sessionTotal: 0, returned: 3
 *
 * That is the answer this Plugin exists not to give. `sessionTotal: 0` is not an
 * absence a reader can question — it is a count, sitting beside three returned records,
 * saying the session is empty. A model that reports it concludes the session is empty
 * while holding its records.
 *
 * The rule the tests below hold: a count may only be published if it counts the records
 * the same reply is publishing. A count that survived a source swap describes the
 * source that was replaced.
 *
 * The control matters as much as the defect. `sessionTotal` is load-bearing — it is how
 * a caller learns that a turn filter matched nothing in a session that is *not* empty —
 * so removing the field outright would trade a lie for a silence. It has to be right in
 * both directions.
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
import { findEvents } from '../server/events.mjs';

const NOW = 1_700_000_000_000;
const FIXTURE_HOME = '/tmp/trajectory-sessiontotal-home';
const PORT = 4791;
const TOKEN = 'st-token';

const RECORD_COUNT = 3;

const studio = {
  start: async () => ({ url: 'http://127.0.0.1:1/', port: 1, reused: false }),
  stop: async () => true,
};

function makeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); },
  };
}

/** A session in the projection with `rows` indexed message rows and no artifact. */
async function indexedSession(t, { id = 'sess-a', rows = 0, matching = rows } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-sessiontotal-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id, title: 'Indexed', updatedAtMs: NOW });
  for (let i = 0; i < rows; i += 1) {
    projection.row({
      sessionId: id,
      msgId: `m${i}`,
      role: i === 0 ? 'user' : 'assistant',
      turnId: 't1',
      createdAtMs: NOW + i,
      // Only the first `matching` rows carry the needle, so a query for it can tell the
      // match count apart from the row count. A fixture where every row matches cannot:
      // both counts are the same number and the assertion below is vacuous.
      data: { msg_content: i < matching ? `indexed record ${i}` : `plain record ${i}` },
    });
  }
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store, id };
}

/** The same session with its records on disk and *none* of them indexed. */
async function artifactOnlySession(t, { id = 'sess-a', records = RECORD_COUNT } = {}) {
  const { dataDir, store } = await indexedSession(t, { id, rows: 0 });
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '20', `10-00-00-000-${id}`);
  await mkdir(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < records; i += 1) {
    lines.push(JSON.stringify({
      message_id: `m${i}`,
      // `timestamp` lives inside `message`, which is where the runtime puts it — read
      // from a real artifact on this machine. A top-level copy validates a shape the
      // runtime never produces, which is worse than no fixture: it looks like coverage.
      message: { role: i === 0 ? 'user' : 'assistant', timestamp: NOW + i, content: `record ${i} on disk` },
    }));
  }
  await writeFile(path.join(dir, 'messages.jsonl'), `${lines.join('\n')}\n`, 'utf8');
  return { dataDir, store, id };
}

async function callTool(store, name, args) {
  const handler = createHandler({ store, studio, homeDir: FIXTURE_HOME });
  return handler.call(name, args);
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

/* ------------------------------------------------------- the defect itself -- */

test('the artifact fallback does not publish the projection\'s row count', async (t) => {
  const { store, id } = await artifactOnlySession(t);
  const reply = await callTool(store, 'trajectory_get', { sessionId: id, limit: 50 });

  // The fixture is the one shape that reaches this path at all. Without these two the
  // assertion below could pass on a reply that never fell back.
  assert.equal(reply.source, 'jsonl', 'the fixture did not take the artifact path');
  assert.equal(reply.returned, RECORD_COUNT, 'the artifact records were not returned');

  assert.equal(
    reply.sessionTotal,
    undefined,
    `the reply published sessionTotal: ${reply.sessionTotal} beside ${RECORD_COUNT} returned records`,
  );
});

test('the panel route does not publish it either', async (t) => {
  const { store, id } = await artifactOnlySession(t);
  const body = await apiGet(store, `/api/events?id=${id}&detailLevel=summary`);

  assert.equal(body.source, 'jsonl', 'the fixture did not take the artifact path');
  assert.equal(body.events.length, RECORD_COUNT, 'the artifact records were not returned');
  assert.equal(
    body.sessionTotal,
    undefined,
    `the panel was told the session holds ${body.sessionTotal} records while holding ${RECORD_COUNT}`,
  );
});

/* -------------------------------------------------------- the control: keep -- */

test('a turn filter that matched nothing still reports the session size', async (t) => {
  const { store, id } = await indexedSession(t, { rows: 7 });
  const reply = await callTool(store, 'trajectory_get', { sessionId: id, turnId: 'no-such-turn', limit: 50 });

  assert.equal(reply.returned, 0, 'the fixture turn filter matches nothing');
  assert.equal(reply.total, 0, 'the filtered count is not zero');
  // The field this whole file is about: removing it would answer a different question
  // with silence, which is the failure mode the defect above also has to avoid.
  assert.equal(reply.sessionTotal, 7, 'the session size was lost along with the wrong one');
});

test('the panel route reports the session size under a turn filter too', async (t) => {
  const { store, id } = await indexedSession(t, { rows: 7 });
  const body = await apiGet(store, `/api/events?id=${id}&turnId=no-such-turn&detailLevel=summary`);

  assert.equal(body.events.length, 0, 'the fixture turn filter matches nothing');
  assert.equal(body.sessionTotal, 7, 'the panel lost the session size');
});

test('an ordinary page of an indexed session publishes no session size at all', async (t) => {
  const { store, id } = await indexedSession(t, { rows: 4 });
  const reply = await callTool(store, 'trajectory_get', { sessionId: id, limit: 50 });

  assert.equal(reply.returned, 4, 'the page is short');
  assert.equal(reply.total, 4);
  // Nothing to distinguish here, so the field is noise rather than a finding.
  assert.equal(reply.sessionTotal, undefined, 'a redundant session size was published');
});

/* ------------------------------------- the same lie in `findEvents` internals -- */

test('findEvents does not report the match count as the session row count', async (t) => {
  const { store, id } = await indexedSession(t, { rows: 5, matching: 2 });
  const found = findEvents(store, { sessionId: id, query: 'indexed', limit: 20 });

  assert.equal(found.total, 2, 'the fixture query does not match exactly two of the five rows');
  // `sessionRows` is named for the session's own row count and is consumed as such by
  // `trajectory_get`. In `findEvents` it was assigned the match count, so the two
  // functions answered the same name with different questions.
  assert.equal(
    found.sessionRows,
    undefined,
    `sessionRows carried the match count (${found.sessionRows}) under the name of a session row count`,
  );
});