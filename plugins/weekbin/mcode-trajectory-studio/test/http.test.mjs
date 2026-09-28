import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestHandler } from '../server/http.mjs';

/**
 * The panel's error contract.
 *
 * Two CodeQL findings landed on this surface: a reflected value (the route was
 * interpolated into the error message) and information exposure (an unexpected
 * error's message was sent to the client). Both are now impossible by
 * construction — the client only ever receives a code from a fixed set, and
 * anything unexpected is logged to stderr instead. These tests pin that, because
 * it is the kind of thing that silently comes back.
 *
 * Requests here carry the capability the real panel requires, so a fence test
 * exercises the fence rather than failing on the credential check first.
 */

const TOKEN = 'test-capability-token-0123456789';
const PORT = 7399;

function makeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); },
  };
}

/** Headers carrying the panel capability, plus whatever the case adds. */
function authorized(extra = {}) {
  return { 'x-trajectory-token': TOKEN, ...extra };
}

function makeReq({ method = 'GET', url = '/api/meta', host, headers = authorized(), remoteAddress = '127.0.0.1' } = {}) {
  return {
    method,
    url,
    headers: { host: host ?? `127.0.0.1:${PORT}`, ...headers },
    socket: { localPort: PORT, remoteAddress },
  };
}

function makeStore(overrides = {}) {
  return {
    dataDir: '/tmp/trajectory-studio-test',
    db: {},
    hasFts: false,
    warnings: [],
    listSessions: () => [],
    getSession: () => null,
    listAgents: () => [],
    annotateWorkspaces: (sessions) => sessions,
    searchSessions: () => [],
    getTimeline: () => ({ points: [], total: 0, truncated: false }),
    getEvents: () => ({ events: [], total: 0, nextOffset: null, source: 'sqlite' }),
    getTurnSummaries: () => [],
    listBackgroundTasks: () => [],
    getStats: () => null,
    getAgentDefinition: () => null,
    readTaskOutput: async () => ({ taskId: 'x', available: false, bytes: 0, truncated: false, text: '' }),
    ...overrides,
  };
}

const handler = (store) => createRequestHandler({
  store,
  homeDir: '/tmp/trajectory-fixture-home',
  getFocus: () => null,
  setFocus: () => {},
  getToken: () => TOKEN,
});

async function request(store, req, { captureStderr = false } = {}) {
  const res = makeRes();
  let stderr = '';
  const original = process.stderr.write;
  if (captureStderr) process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  try {
    await handler(store)(req, res);
  } finally {
    process.stderr.write = original;
  }
  return { res, stderr };
}

async function jsonBody(res) {
  return JSON.parse(res.body);
}

test('an unknown API route answers with a fixed code, not the route', async () => {
  const { res } = await request(makeStore(), makeReq({ url: '/api/definitely-not-a-route' }));
  assert.equal(res.status, 404);
  const body = await jsonBody(res);
  assert.equal(body.error, 'unknown_route');
  // The request value must not appear anywhere in the response.
  assert.equal(res.body.includes('definitely-not-a-route'), false, `response reflected the route: ${res.body}`);
});

test('the search endpoint does not echo the query back', async () => {
  const { res } = await request(
    makeStore(),
    makeReq({ url: `/api/search?q=${encodeURIComponent('<script>alert(1)</script>')}` }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.includes('<script>'), false, `response reflected the query: ${res.body}`);
  assert.deepEqual(await jsonBody(res), { sessions: [] });
});

test('an unexpected error is a generic code, and its detail goes to stderr', async () => {
  const detail = '/api/internal-detail-that-must-not-ship';
  const store = makeStore({ listSessions: () => { throw new Error(detail); } });
  const { res, stderr } = await request(store, makeReq({ url: '/api/sessions' }), { captureStderr: true });
  assert.equal(res.status, 500);
  assert.equal((await jsonBody(res)).error, 'internal_error');
  assert.equal(res.body.includes(detail), false, `response leaked the error message: ${res.body}`);
  assert.equal(res.body.includes('at '), false, 'response must not contain a stack frame');
  assert.ok(stderr.includes(detail), 'the detail must still reach the operator on stderr');
});

test('a missing session is a bad request, not a server fault', async () => {
  const { res } = await request(makeStore(), makeReq({ url: '/api/events' }));
  assert.equal(res.status, 400);
  assert.equal((await jsonBody(res)).error, 'session_required');
});

test('a rejected task id is reported as a bad request', async () => {
  const store = makeStore({ readTaskOutput: async () => { throw new Error('invalid_task_id'); } });
  const { res } = await request(store, makeReq({ url: '/api/task-output?taskId=..%2Fetc%2Fpasswd' }));
  assert.equal(res.status, 400);
  assert.equal((await jsonBody(res)).error, 'invalid_task_id');
  assert.equal(res.body.includes('passwd'), false, 'response must not reflect the supplied id');
});

test('an unknown session is a not-found, without naming the id', async () => {
  const { res } = await request(makeStore(), makeReq({ url: '/api/overview?id=mvs_injected-value' }));
  assert.equal(res.status, 404);
  assert.equal((await jsonBody(res)).error, 'session_not_found');
  assert.equal(res.body.includes('mvs_injected-value'), false, 'response must not reflect the supplied id');
});

test('every response carries the hardening headers', async () => {
  const { res } = await request(makeStore(), makeReq({ url: '/api/meta' }));
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /^application\/json/);
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(res.headers['Content-Security-Policy'], /default-src 'none'/);
  assert.match(res.headers['Content-Security-Policy'], /script-src 'self'/);
});

test('the request fences still hold', async () => {
  const wrongHost = await request(makeStore(), makeReq({ url: '/api/meta', host: 'evil.example:7399' }));
  assert.equal(wrongHost.res.status, 403);
  assert.equal((await jsonBody(wrongHost.res)).error, 'forbidden_host');

  const wrongOrigin = await request(makeStore(), makeReq({ url: '/api/meta', headers: authorized({ origin: 'http://evil.example' }) }));
  assert.equal(wrongOrigin.res.status, 403);
  assert.equal((await jsonBody(wrongOrigin.res)).error, 'forbidden_origin');

  const noCredential = await request(makeStore(), makeReq({ url: '/api/meta', headers: {} }));
  assert.equal(noCredential.res.status, 403);
  assert.equal((await jsonBody(noCredential.res)).error, 'forbidden_token');

  const crossSite = await request(makeStore(), makeReq({ url: '/api/meta', headers: authorized({ 'sec-fetch-site': 'cross-site' }) }));
  assert.equal(crossSite.res.status, 403);
  assert.equal((await jsonBody(crossSite.res)).error, 'cross_site');

  const wrongMethod = await request(makeStore(), makeReq({ method: 'POST', url: '/api/meta' }));
  assert.equal(wrongMethod.res.status, 405);

  const outsideApi = await request(makeStore(), makeReq({ url: '/../package.json', headers: {} }));
  assert.equal(outsideApi.res.status, 404);
});

test('a static asset needs no capability, and an API route always does', async () => {
  const asset = await request(makeStore(), makeReq({ url: '/style.css', headers: {} }));
  assert.equal(asset.res.status, 200);
  assert.match(asset.res.headers['Content-Type'], /^text\/css/);

  const api = await request(makeStore(), makeReq({ url: '/api/meta', headers: {} }));
  assert.equal(api.res.status, 403);
});

test('the API response is swept for credentials on the way out', async () => {
  const secret = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const store = makeStore({
    listSessions: () => [{ sessionId: 's1', title: `deploy with ${secret} today`, workspaceDir: '/tmp/trajectory-fixture-home/ws' }],
  });
  const { res } = await request(store, makeReq({ url: '/api/sessions' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.includes(secret), false, `the sweep missed a credential: ${res.body}`);
  assert.equal(res.body.includes('deploy with'), true, 'the sweep destroyed the title text');
});

/* ---------------------------------------------- confidentiality egress -- */

const FIXTURE_HOME = '/tmp/trajectory-fixture-home';

/**
 * The absolute user path must not leave the process on any route.
 *
 * `/api/overview` returned `stats.workspaceDir` raw while the `session` field right
 * above it had been collapsed to `~` — the same path, one field guarded and the
 * other not. These regressions cover every route that can carry a path, including
 * a warning that embeds one mid-string.
 */
test('/api/overview does not leak the absolute workspace path', async () => {
  const store = makeStore({
    getSession: () => ({
      sessionId: 's1', title: 't', workspaceDir: `${FIXTURE_HOME}/ws/proj`, children: [],
    }),
    // `getStats` carries the same workspace path again, built from the session row.
    getStats: () => ({ sessionId: 's1', workspaceDir: `${FIXTURE_HOME}/ws/proj`, turns: 3 }),
  });
  const { res } = await request(store, makeReq({ url: '/api/overview?id=s1' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.includes(FIXTURE_HOME), false, `overview leaked the home path: ${res.body}`);
  const body = await jsonBody(res);
  assert.equal(body.session.workspaceDir, '~/ws/proj');
  assert.equal(body.stats.workspaceDir, '~/ws/proj');
});

/**
 * The regression: an overview of a session that *has* an agent definition 500'd.
 *
 * `overview()` is a module-level function, and its agent branch swept the system
 * prompt with `homeDir`/`redactRoots` — two names that only existed in the enclosing
 * `api()`. A populated definition therefore threw a ReferenceError inside the route,
 * which the error contract turned into `500 internal_error`. It survived every
 * previous round because every fixture stubbed `getAgentDefinition: () => null`, and
 * a null definition skips the branch that reads the missing names.
 *
 * So the stub below is populated on purpose: a system prompt, a credential inside it
 * and an absolute path, which is both what makes the branch run and what the branch
 * is supposed to scrub.
 */
test('/api/overview answers for a session with a populated agent definition', async () => {
  const canary = 'CANARY-PROMPT-SECRET-4b7e';
  const store = makeStore({
    getSession: () => ({ sessionId: 's1', title: 't', workspaceDir: `${FIXTURE_HOME}/ws/proj`, children: [] }),
    getStats: () => ({ sessionId: 's1', workspaceDir: `${FIXTURE_HOME}/ws/proj`, turns: 3 }),
    getAgentDefinition: () => ({
      definitionVersion: 2,
      ownerName: 'worker',
      tools: ['read', 'bash'],
      systemPrompt: `Work in ${FIXTURE_HOME}/ws/proj with api_key=${canary}`,
    }),
  });
  const { res, stderr } = await request(store, makeReq({ url: '/api/overview?id=s1' }));
  assert.equal(res.status, 200, `overview failed: ${res.body}${stderr}`);
  const body = await jsonBody(res);
  assert.equal(body.agent.ownerName, 'worker', 'the definition did not survive the sweep');
  assert.deepEqual(body.agent.tools, ['read', 'bash']);
  assert.equal(body.agent.systemPrompt.includes(canary), false, `the system prompt leaked: ${body.agent.systemPrompt}`);
  assert.equal(body.agent.systemPrompt.includes(FIXTURE_HOME), false, `the system prompt leaked a path: ${body.agent.systemPrompt}`);
  assert.match(body.agent.systemPrompt, /~/u, 'the prompt should have kept its folded path');
});

/**
 * `/api/overview` returns a task list, and a task's description is its command line.
 *
 * 500 of them is 500 records in one reply under a per-string bound and no aggregate
 * one — the same defect the event page was fixed for, one route over.
 */
test('the overview task list is bounded by the aggregate budget too', async () => {
  const store = makeStore({
    getSession: () => ({ sessionId: 's1', title: 't', workspaceDir: `${FIXTURE_HOME}/ws/proj`, children: [] }),
    listBackgroundTasks: () => Array.from({ length: 500 }, (_, i) => ({
      taskId: `t${i}`, kind: 'bash', status: 'completed', description: 'x'.repeat(12000), durationMs: 1,
    })),
  });
  const { res } = await request(store, makeReq({ url: '/api/overview?id=s1' }));
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.tasksTruncated, true, 'a trimmed task list must say so');
  assert.ok(body.tasksOmitted > 0, 'nothing was reported as omitted');
  assert.ok(body.tasks.length < 500, `the task list was not trimmed: ${body.tasks.length}`);
  assert.equal(body.tasks.length + body.tasksOmitted, 500, 'the accounting does not add up');
  assert.ok(res.body.length <= 4 * 1024 * 1024 + 4096, `the response exceeded its budget: ${res.body.length}`);
});

test('an embedded home path in a warning is collapsed too', async () => {
  const store = makeStore({ warnings: [`sqlite_discovered:${FIXTURE_HOME}/.minimax/v2/sqlite/runtime-state.sqlite`] });
  const { res } = await request(store, makeReq({ url: '/api/meta' }));
  assert.equal(res.body.includes(FIXTURE_HOME), false, `meta leaked the home path: ${res.body}`);
  assert.match(res.body, /sqlite_discovered:~\/\.minimax/u);
});

test('full-detail events are redacted by key name through the HTTP egress', async () => {
  // The structured variants the previous exact-name set missed: a value-only rule
  // cannot see the key, so this has to be caught by the key-name judgement.
  const canary = 'CANARY-STRUCTURED-SECRET-7c1f';
  const store = makeStore({
    getEvents: () => ({
      events: [{
        index: 0,
        toolCalls: [{
          name: 'bash', id: 'c1',
          args: { clientSecret: canary, refreshToken: canary, authToken: canary, xApiKey: canary },
          result: 'ok',
        }],
      }],
      total: 1, nextOffset: null, source: 'sqlite',
    }),
  });
  const { res } = await request(store, makeReq({ url: '/api/events?id=s1&detailLevel=full' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.includes(canary), false, `the HTTP egress leaked a structured secret: ${res.body}`);
  assert.match(res.body, /\[redacted\]/u, 'nothing was redacted at all');
  assert.match(res.body, /"bash"/u, 'the sweep destroyed the payload');
});

test('a full-detail event page is bounded by total bytes, not only per string', async () => {
  // A thousand records each bounded to 20 KB still serialise to ~20 MB. The page has
  // to be trimmed to an aggregate budget and say so, or `limit=1000&detailLevel=full`
  // is a memory amplifier for the server and the browser alike.
  const store = makeStore({
    getEvents: () => ({
      events: Array.from({ length: 1000 }, (_, i) => ({ index: i, content: 'x'.repeat(20000) })),
      total: 1000, nextOffset: null, source: 'sqlite',
    }),
  });
  const { res } = await request(store, makeReq({ url: '/api/events?id=s1&detailLevel=full&limit=1000' }));
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.truncated, true, 'the response was not reported as truncated');
  assert.ok(body.omitted > 0, 'nothing was reported as omitted');
  assert.ok(body.events.length < 1000, `the page was not trimmed: ${body.events.length}`);
  assert.ok(res.body.length <= 4 * 1024 * 1024 + 4096, `the response exceeded its budget: ${res.body.length}`);
  assert.equal(body.events[0].index, 0, 'the first record must survive so paging stays coherent');
});

/**
 * The defect a byte budget introduced, and the one that made it worth having.
 *
 * The page was trimmed to fit the budget, but the cursor it returned was the store's
 * own `nextOffset` — which counts records *read*, not records *delivered*. A
 * 1000-record page cut at 209 answered `nextOffset: 1000`, so every client that
 * paged on it skipped records 209-999 permanently. The aggregate bound was working
 * and the session was still incomplete.
 *
 * This walks the real cursor the way the browser does (`web/js/flow.js`), over a
 * store that pages honestly, and asserts the union of every page is exactly the
 * 1000 records, in order, with no repeats. A skipped range fails it; so does a
 * duplicate, and so does a cursor that never terminates.
 */
test('paging a trimmed session loses no records', async () => {
  const TOTAL = 1000;
  const all = Array.from({ length: TOTAL }, (_, i) => ({ index: i, content: 'x'.repeat(20000) }));
  const store = makeStore({
    // A faithful stand-in for the SQLite read: `offset`/`limit` are honoured and
    // `nextOffset` names the first unread record — the value the route then had to
    // stop trusting on its own.
    getEvents: ({ offset, limit }) => ({
      events: all.slice(offset, offset + limit),
      total: TOTAL,
      nextOffset: offset + limit < TOTAL ? offset + limit : null,
      source: 'sqlite',
    }),
  });

  const seen = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const { res } = await request(store, makeReq({
      url: `/api/events?id=s1&detailLevel=full&limit=1000&offset=${offset}`,
    }));
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    assert.ok(body.events.length > 0, `page ${pages} delivered nothing at offset ${offset}`);
    for (const event of body.events) seen.push(event.index);
    pages += 1;
    assert.ok(pages < 20, 'the cursor never terminated');
    if (body.nextOffset === null) break;
    // Every page after the first must have been trimmed, which is the condition the
    // old cursor got wrong: the store's page was full but the reply was not.
    if (pages === 1) assert.equal(body.truncated, true, 'the first page should not have fit');
    assert.ok(body.nextOffset > offset, `the cursor did not advance: ${offset} -> ${body.nextOffset}`);
    offset = body.nextOffset;
  }

  assert.equal(seen.length, TOTAL, `paging delivered ${seen.length} of ${TOTAL} records`);
  assert.deepEqual(seen, all.map((event) => event.index), 'paging skipped or repeated records');
});

/**
 * A page that fits nothing must still deliver a record.
 *
 * The cursor is derived from delivered records, so a page that returned zero of them
 * would answer with the same offset and every client would re-request it forever.
 * `boundPayloadList` guarantees one record for exactly this reason.
 *
 * A single record does reach that size in practice: the per-string bound caps each
 * field at 20 KB, but a record is not one field. A turn with hundreds of tool calls,
 * each carrying arguments and a result, is one event and tens of megabytes — which
 * is why the aggregate bound exists at all.
 */
test('an event page too large for the budget still delivers one record and advances', async () => {
  const fatRecord = (index) => ({
    index,
    content: 'small',
    // 150 calls × two 20 KB fields ≈ 6 MB of record against a 4 MB budget.
    toolCalls: Array.from({ length: 150 }, (_, i) => ({
      name: 'bash', id: `c${i}`, args: 'x'.repeat(20000), result: 'y'.repeat(20000),
    })),
  });
  const store = makeStore({
    getEvents: ({ offset, limit }) => ({
      events: offset === 0 ? [fatRecord(0)] : [fatRecord(1)],
      total: 2,
      nextOffset: offset + limit < 2 ? offset + limit : null,
      source: 'sqlite',
    }),
  });
  const { res } = await request(store, makeReq({ url: '/api/events?id=s1&detailLevel=full&offset=0' }));
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.events.length, 1, 'a page that fits nothing delivered nothing, so the cursor cannot move');
  assert.equal(body.truncated, true, 'an over-budget page must report itself as truncated');
  assert.equal(body.omitted, 0, 'the whole page was one record, which was delivered');
  assert.equal(body.nextOffset, 1, 'the cursor has to name the first undelivered record');
});

/**
 * An artifact line past the per-line cap is dropped at the source, and the drop has
 * to reach the reader.
 *
 * The store has always reported the count; the route discarded it, so a `messages.jsonl`
 * with a truncated or corrupt line came back one record shorter than it is and nothing
 * said so. The panel renders it as a banner.
 */
test('lines dropped from the jsonl artifact are reported to the client', async () => {
  const store = makeStore({
    getEvents: () => ({ events: [], total: 0, nextOffset: null, source: 'unavailable' }),
    readJsonlEvents: async () => ({
      events: [{ index: 0 }],
      source: 'jsonl',
      total: null,
      nextOffset: null,
      droppedOversized: 3,
    }),
  });
  const { res } = await request(store, makeReq({ url: '/api/events?id=s1' }));
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal(body.source, 'jsonl');
  assert.equal(body.droppedOversized, 3, 'the dropped lines were swallowed by the route');
  assert.equal(body.total, null, 'the fallback does not count the whole file, so it must not claim a total');
});
