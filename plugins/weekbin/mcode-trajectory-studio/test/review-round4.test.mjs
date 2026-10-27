/**
 * The five defects raised in the fourth review round, at head `1857360`.
 *
 * Every test here failed against that head and passes now. They are written as
 * reproductions rather than as assertions about the shape of a fix, because the
 * earlier revisions of this plugin kept passing its suites while these five defects
 * were live: each one is a *confident wrong answer* rather than a crash. A server that
 * describes an incomplete or damaged read as a complete one needs a test that asks the
 * question the reader would ask, not one that checks a field is present.
 *
 * Two rules this file holds itself to:
 *
 * - The reproduction is stated first and the fix second. If a change makes the
 *   reproduction stop failing, that is the signal, and it is checked here by
 *   asserting the *consequence* — a task that is neither returned nor reachable, a
 *   corrupt file reported as an empty session, a cap that can never trip.
 * - No test asserts a count it did not itself create. Where a defect was about a
 *   number disagreeing with the session it describes, the fixture states the session's
 *   real size rather than letting a stub default imply one.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '../server/store.mjs';
import { TASK_LIST_MAX_ROWS } from '../server/config.mjs';
import { handleRpcMessage, handleRpcEnvelope } from '../server/mcp.mjs';
import { foldJsonl, hasArtifactEvidence } from '../server/jsonl.mjs';
import { taskIndex } from '../server/tasks.mjs';
import { createRequestHandler } from '../server/http.mjs';

const NOW = 1_700_000_000_000;
const FIXTURE_HOME = '/tmp/trajectory-r4-home';
const PORT = 4777;
const TOKEN = 'r4-token';

/* ------------------------------------------------------------- fixtures -- */

/**
 * A data directory with one session and `taskCount` background tasks.
 *
 * Descriptions are long enough that a page of them is measurable in megabytes, which
 * is what makes the read cap and the byte budget distinguishable from each other.
 */
async function makeDataDir(t, taskCount = 0, { descriptionBytes = 8000 } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-r4-'));
  const sqliteDir = path.join(dataDir, 'v2', 'sqlite');
  await mkdir(sqliteDir, { recursive: true });
  await mkdir(path.join(dataDir, 'v2', 'sessions', '2026', '09', '20', '10-00-00-000-sess-a'), { recursive: true });

  const db = new DatabaseSync(path.join(sqliteDir, 'runtime-state.sqlite'));
  db.exec(`
    CREATE TABLE local_runtime_sessions (
      session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
      agent_name TEXT, session_type TEXT, status TEXT, archived INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'visible', session_kind TEXT NOT NULL DEFAULT 'unknown',
      parent_session_id TEXT, workspace_dir TEXT, title TEXT, created_at_ms INTEGER
    );
    CREATE TABLE local_runtime_background_tasks (
      task_id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER, record_json TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO local_runtime_sessions (session_id, record_json, updated_at_ms, workspace_dir, title)
    VALUES ('sess-a', '{}', ?, ?, 'R4')
  `).run(NOW, `${FIXTURE_HOME}/ws`);
  const insert = db.prepare(`
    INSERT INTO local_runtime_background_tasks (task_id, owner_session_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms, record_json)
    VALUES (?, 'sess-a', 'bash', 'completed', ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  for (let i = 0; i < taskCount; i += 1) {
    insert.run(
      `task-${String(i).padStart(5, '0')}`,
      1000 + i,
      1100 + i,
      1100 + i,
      JSON.stringify({ description: 'x'.repeat(descriptionBytes), metadata: { command: 'x'.repeat(descriptionBytes) } }),
    );
  }
  db.exec('COMMIT');
  db.close();

  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store };
}

/** Write a `messages.jsonl` artifact for `sess-a`. */
async function writeArtifact(dataDir, body) {
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '20', '10-00-00-000-sess-a');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'messages.jsonl'), body, 'utf8');
}

const studio = { start: async () => ({ url: 'http://127.0.0.1:1/', port: 1, reused: false }), stop: async () => true };

/** The response double `createRequestHandler` writes through. */
function makeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); },
  };
}

/**
 * Call a panel API route and return its decoded body.
 *
 * Driven through the real request handler rather than by calling the shaping function,
 * because the two defects this file covers were both decided by an *adoption* gate
 * above the function that builds the payload — a unit test of the builder would have
 * passed while the route still answered the old thing.
 */
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

async function callTool(store, name, args) {
  const { createHandler } = await import('../server/mcp.mjs');
  const handler = createHandler({ store, studio, homeDir: FIXTURE_HOME });
  return handler.call(name, args);
}

async function callToolOverRpc(store, name, args, id = 1) {
  const response = await handleRpcMessage(
    { call: (tool, toolArgs) => callTool(store, tool, toolArgs) },
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  );
  return response.result.structuredContent;
}

/* --------------------------------------------------------------- defect 1 -- */

/**
 * Defect 1: a trimmed task page advanced the cursor by the rows *read* rather than the
 * rows *delivered*.
 *
 * The reproduction is the one from the review: a page whose byte budget cuts it short
 * answered `nextOffset: null` — "no more pages" — while hundreds of tasks sat between
 * the last delivered record and the end of the session. Those tasks were counted in
 * `omitted`, so the reply said they existed and then offered no way to fetch them.
 */
test('defect 1: a trimmed task page still leaves every task reachable', async (t) => {
  const COUNT = 800;
  const { store } = await makeDataDir(t, COUNT);
  const first = await callToolOverRpc(store, 'trajectory_tasks', { sessionId: 'sess-a', limit: 2000 });
  assert.equal(first.total, COUNT, 'the fixture owns a different number of tasks than it created');

  // The page must be short for this to be the defect under test rather than a pass.
  assert.ok(first.omitted > 0, 'the page was not trimmed, so this test proves nothing');

  // Walk the cursor to the end exactly as a client would, and account for every task.
  const seen = new Set(first.tasks.map((task) => task.taskId));
  let page = first;
  let guard = 0;
  while (page.nextOffset !== null && guard < 50) {
    guard += 1;
    page = await callToolOverRpc(store, 'trajectory_tasks', {
      sessionId: 'sess-a', limit: 2000, offset: page.nextOffset,
    });
    for (const task of page.tasks) seen.add(task.taskId);
  }
  assert.equal(seen.size, COUNT, 'paging on nextOffset did not reach every task');
});

test('defect 1: the cursor names the first task that was not delivered', async (t) => {
  const COUNT = 400;
  const { store } = await makeDataDir(t, COUNT);
  let offset = 0;
  let deliveredSoFar = 0;
  let pages = 0;
  let ended = false;
  while (pages < 50) {
    pages += 1;
    const page = await callToolOverRpc(store, 'trajectory_tasks', { sessionId: 'sess-a', limit: 2000, offset });
    // The invariant the defect broke: the cursor advances by exactly the records this
    // reply carried. Advancing by records merely *read* skips the ones the byte budget
    // cut, and those are precisely the tasks that then cannot be asked for again.
    assert.equal(
      page.nextOffset === null ? null : offset + page.returned,
      page.nextOffset,
      `the cursor skipped ${page.nextOffset - (offset + page.returned)} undelivered task(s)`,
    );
    deliveredSoFar += page.returned;
    if (page.nextOffset === null) { ended = true; break; }
    assert.ok(page.nextOffset > offset, 'the cursor did not advance');
    offset = page.nextOffset;
  }
  assert.equal(ended, true, 'paging never reached the end of the session');
  assert.equal(deliveredSoFar, COUNT, 'the pages together did not account for every task');
});

/* --------------------------------------------------------------- defect 2 -- */

/**
 * Defect 2: the JSONL fallback's evidence was discarded exactly when it mattered.
 *
 * Two separate losses. A page that stopped on its look-ahead record returned without
 * the `malformed` count it had accumulated, and an artifact whose lines were *all*
 * corrupt was never adopted at all — because adoption was gated on "did it yield an
 * event" — so a damaged file was reported as an empty SQLite session.
 */
test('defect 2: a corrupt line before the cursor is still counted on a later page', async () => {
  const stream = Readable.from([
    `${'{ corrupt first line\n'}\n`,
    `${JSON.stringify({ message_id: 'm1', message: { role: 'assistant' } })}\n`,
    `${JSON.stringify({ message_id: 'm2', message: { role: 'assistant' } })}\n`,
  ]);
  const folded = await foldJsonl(stream, { offset: 0, limit: 1, detailLevel: 'summary' });
  // A limit of 1 makes this the look-ahead exit, which is where the count was lost.
  assert.equal(folded.events.length, 1, 'the page was not cut at the look-ahead');
  assert.equal(folded.hasMore, true, 'the look-ahead record did not register');
  assert.equal(folded.malformed, 1, 'the corrupt line was measured and then dropped from the reply');
});

test('defect 2: an artifact that yields no events is still evidence, and is adopted', () => {
  assert.equal(
    hasArtifactEvidence({ events: [], source: 'jsonl', malformedLines: 12 }),
    true,
    'a read artifact with no valid events was treated as nothing to report',
  );
  assert.equal(
    hasArtifactEvidence({ events: [], source: 'unavailable', malformedLines: 0 }),
    false,
    'an artifact that could not be located is not evidence about the session',
  );
});

test('defect 2: an all-corrupt artifact is reported as the damaged artifact it is', async (t) => {
  const { dataDir, store } = await makeDataDir(t, 0);
  await writeArtifact(dataDir, 'not json at all\n{ also not json\nneither is this\n');
  const page = await store.getEvents({ sessionId: 'sess-a', offset: 0, limit: 200, detailLevel: 'summary' });
  assert.equal(page.sessionRows, 0, 'the fixture is not an empty projection');
  const artifact = await store.readJsonlEvents({ sessionId: 'sess-a', offset: 0, limit: 200, detailLevel: 'summary' });
  assert.equal(artifact.source, 'jsonl', 'the artifact was not read');
  assert.equal(artifact.events.length, 0, 'the fixture is not fully corrupt');
  assert.ok(artifact.malformedLines > 0, 'the corruption was not counted at all');
  // The gate the two surfaces share, asserted on the real artifact rather than a literal.
  assert.equal(hasArtifactEvidence(artifact), true);
});

test('defect 2: the HTTP route reports a wholly corrupt artifact as damaged, not as empty', async (t) => {
  const { dataDir, store } = await makeDataDir(t, 0);
  await writeArtifact(dataDir, 'not json at all\n{ also not json\nneither is this\n');

  // Through the route, because that is where the adoption gate lives and where the
  // wrong answer reached the reader: `source: 'sqlite'`, no events and no corruption
  // count is an empty projection, which is a different and false account of the disk.
  const body = await apiGet(store, '/api/events?id=sess-a&detailLevel=summary');
  assert.equal(body.source, 'jsonl', 'the reply described the artifact as a SQLite projection');
  assert.ok(body.malformedLines > 0, 'the corruption the reader needs to know about was dropped');
  assert.equal(body.events.length, 0, 'the fixture is not wholly corrupt');
});

/* --------------------------------------------------------------- defect 3 -- */

/**
 * Defect 3: the task index asked for one row past its cap to detect capping, and the
 * read clamped that request back to the cap. `capped` was therefore never true for any
 * session, and the oldest tasks silently resolved to no timing at all.
 */
test('defect 3: a session owning more tasks than the index holds reports being capped', async (t) => {
  const OVER = 2100;
  const { store } = await makeDataDir(t, OVER, { descriptionBytes: 8 });
  // Called the way `events.mjs` calls it — the index is a module function over a store,
  // not a store method — and asserted at the seam that matters: this is what
  // `taskIndexTruncated` is derived from.
  const index = taskIndex(store, 'sess-a');
  assert.equal(index.total, OVER, 'the fixture owns a different number of tasks than it created');
  assert.equal(
    index.capped,
    true,
    'a session with more tasks than the index cap reported itself as fully indexed',
  );
});

test('defect 3: a session inside the cap is not reported as capped', async (t) => {
  const { store } = await makeDataDir(t, 5, { descriptionBytes: 8 });
  const index = taskIndex(store, 'sess-a');
  assert.equal(index.total, 5);
  assert.equal(index.capped, false, 'a small session was reported as capped');
});

/* --------------------------------------------------------------- defect 4 -- */

/**
 * Defect 4: `tasksOmitted` counted only the rows dropped from the window the handler
 * read, so a session owning 5,000 tasks read 501, delivered 500 and reported one
 * omitted — against `tasksTotal: 5000` in the same payload.
 */
async function overviewOf(store, url) {
  return apiGet(store, url);
}

test('defect 4: the omission count is measured against the session total, not the read window', async (t) => {
  // Far more than any single read looks at, so a window-sized count cannot reach it.
  const OWNED = 1200;
  const { store } = await makeDataDir(t, OWNED, { descriptionBytes: 64 });
  const body = await overviewOf(store, '/api/overview?id=sess-a');
  assert.equal(body.tasksTotal, OWNED, 'the fixture owns a different number of tasks than it created');
  assert.ok(body.tasks.length < OWNED, 'the page was not cut, so this test proves nothing');
  assert.equal(
    body.tasksOmitted,
    OWNED - body.tasks.length,
    'the omission count does not describe the difference between the session and this reply',
  );
  assert.ok(body.tasksOmitted > 500, `the omission count is still window-sized: ${body.tasksOmitted}`);
  assert.equal(body.tasksTruncated, true, 'a short task list reported itself as complete');
});

test('defect 4: a complete task list reports no omissions', async (t) => {
  const { store } = await makeDataDir(t, 3, { descriptionBytes: 16 });
  const body = await overviewOf(store, '/api/overview?id=sess-a');
  assert.equal(body.tasksTotal, 3);
  assert.equal(body.tasksOmitted, 0);
  assert.equal(body.tasksTruncated, false);
});

/* --------------------------------------------------------------- defect 5 -- */
/**
 * Defect 5 had two halves.
 *
 * The first was that a list read materialised every row `limit` allowed — 2,000
 * descriptions — before the egress trim decided how many of them could be returned, so
 * the peak was a function of caller input.
 *
 * The second was that the transport answered a malformed envelope with the wrong error,
 * or with silence: a line that was not JSON was dropped without a word, an array was
 * rejected outright rather than answered as the batch the protocol defines, and a
 * request missing its version or its method was reported as a missing tool.
 */
test('defect 5: one request cannot make the process hold an unbounded number of rows', async (t) => {
  const { store } = await makeDataDir(t, 2000, { descriptionBytes: 8000 });

  // What the read is **asked for**, which is not what the reply carried.
  //
  // Those are two different quantities, and the defect was about the first: 2,000
  // unbounded descriptions were materialised before the egress trim decided how many
  // could be returned, so the peak was a function of caller input. The first version of
  // this test asserted on `returned` — the delivered count — and passed with the read cap
  // deleted, because the byte budget trims delivery to roughly the cap whether or not the
  // cap exists. The mutation survived, and a surviving tier reads exactly like a killed
  // one in any tally that counts only RED and SURVIVED.
  //
  // The store is a real `openStore` over a real SQLite fixture, so the only thing standing
  // between this and a stub is that the spy sits on the store's own method. `listBackgroundTasks`
  // is a prototype method, and assigning here shadows it for this store alone.
  const asked = [];
  const realList = store.listBackgroundTasks.bind(store);
  store.listBackgroundTasks = (sessionId, options) => {
    asked.push(options?.limit);
    return realList(sessionId, options);
  };

  const page = await callToolOverRpc(store, 'trajectory_tasks', { sessionId: 'sess-a', limit: 2000 });
  assert.equal(page.total, 2000);
  // Self-proving: a spy that never fired would make every assertion below vacuous.
  assert.ok(asked.length > 0, 'the read was never observed, so this test would prove nothing');
  assert.ok(
    asked.every((limit) => Number.isInteger(limit) && limit <= TASK_LIST_MAX_ROWS),
    `one read asked for ${asked.join(', ')} rows, past the derived cap of ${TASK_LIST_MAX_ROWS} — `
    + 'the peak is a function of caller input again',
  );
  // And the cap is not `limit` itself: the caller asked for 2,000 and did not get a read of 2,000.
  assert.ok(asked[0] < 2000, `the read honoured the caller's limit of ${asked[0]} instead of the cap`);
  // What the cap leaves unread is still accounted for, and still reachable.
  assert.equal(page.omitted, page.total - page.returned, 'the cap lost rows without accounting for them');
  assert.equal(page.truncated, true, 'a capped page described itself as whole');
  assert.ok(page.nextOffset !== null, 'the unread rows are not reachable through a cursor');
});

test('defect 5: a line that is not JSON is answered with a parse error', async () => {
  const written = [];
  const input = Readable.from(['this is not json\n']);
  await import('../server/mcp.mjs').then(({ serveStdio }) => serveStdio(
    { call: async () => ({}) },
    { input, output: { write: (chunk) => { written.push(String(chunk)); return true; } } },
  ));
  assert.equal(written.length, 1, `a parse failure produced ${written.length} replies, expected one`);
  const parsed = JSON.parse(written[0]);
  assert.equal(parsed.error.code, -32700, 'a parse failure was not reported as a parse error');
  assert.equal(parsed.id, null, 'a parse failure cannot name the request it belongs to');
});

test('defect 5: an envelope without its version is invalid, not a missing method', async () => {
  const handler = { call: async () => ({}) };
  const cases = [
    [{ id: 1, method: 'tools/list' }, 'no jsonrpc member'],
    [{ jsonrpc: '1.0', id: 1, method: 'tools/list' }, 'the wrong version'],
    [{ jsonrpc: '2.0', id: 1 }, 'no method'],
    [{ jsonrpc: '2.0', id: 1, method: '' }, 'an empty method'],
    [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: 'nope' }, 'params that are not structured'],
  ];
  for (const [message, why] of cases) {
    const response = await handleRpcMessage(handler, message);
    assert.equal(response.error?.code, -32600, `${why} was not an Invalid Request`);
  }
});

test('defect 5: a batch is answered as a batch, one response per request', async () => {
  const handler = { call: async () => ({}) };
  const answers = await handleRpcEnvelope(handler, [
    { jsonrpc: '2.0', id: 'a', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
  ]);
  assert.ok(Array.isArray(answers), 'a batch of requests was not answered with a batch');
  assert.equal(answers.length, 2, 'the notification was answered, or a request went missing');
  assert.deepEqual(answers.map((entry) => entry.id).sort(), ['a', 'b'], 'the ids do not correlate');
});

test('defect 5: an empty batch is one invalid request, not an empty reply', async () => {
  const answer = await handleRpcEnvelope({ call: async () => ({}) }, []);
  assert.equal(answer?.error?.code, -32600, 'an empty array is not an Invalid Request');
  assert.equal(Array.isArray(answer), false, 'an empty batch was answered with an empty array');
});

test('defect 5: a batch of only notifications produces no reply at all', async () => {
  const answers = await handleRpcEnvelope({ call: async () => ({}) }, [
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', method: 'ping' },
  ]);
  assert.equal(answers, null, 'a batch of notifications was answered');
});
