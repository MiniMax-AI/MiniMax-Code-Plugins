import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureProjection, FIXTURE_HOME } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler, TOOLS } from '../server/mcp.mjs';
import { createRequestHandler } from '../server/http.mjs';

/**
 * Every egress, driven end to end against the *real* projection.
 *
 * The three defects that reached review shared one root cause: the code path was
 * only ever exercised through a stub store. A stub can express `getAgentDefinition:
 * () => null`, and a null definition skips the branch that reads the overview's
 * redaction context — so `/api/overview` could 500 for every session with an agent
 * definition while every fixture in the repository agreed it was fine.
 *
 * So this file has no stubs. It seeds the shared fixture, opens the Store the way
 * `main.mjs` does, and then calls every tool and each API route once.
 * The assertions that matter are structural rather than value-level: no tool answers
 * an error where a session exists, no route 500s on a populated session, and each
 * reply carries the fields a client pages and budgets against. A new egress added
 * without those fields fails here, on the real store, instead of in review.
 */

const TOKEN = 'egress-contract-capability-0123456789';
const PORT = 7411;

/** Routes that need a session in the fixture, plus the query each one requires. */
const ROUTES = [
  '/api/meta',
  '/api/sessions',
  '/api/sessions?id=sess-egress',
  '/api/agents',
  '/api/search?q=fixture',
  '/api/overview',
  '/api/overview?id=sess-egress',
  '/api/timeline?id=sess-egress',
  '/api/task-output?taskId=t-egress',
  '/api/events?id=sess-egress',
  '/api/events?id=sess-egress&detailLevel=full',
  '/api/events?id=sess-egress&detailLevel=full&offset=1&limit=1',
];

async function seedEgressFixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-egress-'));
  const projection = await createFixtureProjection(dataDir);
  const now = 1_700_000_000_000;

  projection.session({ id: 'sess-egress', title: 'Egress fixture', updatedAtMs: now });
  projection.session({ id: 'sess-child', title: 'Child fixture', agent: 'explore', updatedAtMs: now - 500, parent: 'sess-egress' });
  // The row the whole file exists for: a populated agent definition, with a
  // credential and an absolute path in the prompt.
  projection.agent({
    sessionId: 'sess-egress',
    systemPrompt: `Work in ${FIXTURE_HOME}/ws with api_key=EGRESS-CANARY-9d2f`,
  });

  for (const [i, role] of ['user', 'assistant', 'assistant'].entries()) {
    projection.row({
      sessionId: 'sess-egress',
      msgId: `m${i + 1}`,
      role,
      turnId: `turn-${Math.floor(i / 2) + 1}`,
      createdAtMs: now - 3000 + i * 100,
      source: 'api',
      data: {
        msg_id: `m${i + 1}`,
        role,
        source: 'api',
        msg_type: role === 'user' ? 1 : 2,
        turn_id: `turn-${Math.floor(i / 2) + 1}`,
        // A credential and an absolute path in a *message body*, not only in the
        // agent definition. The definition-only fixture left every tool that quotes
        // message text unprobed: a search tool that returned a raw excerpt would
        // have passed this sweep because there was nothing in a message to catch.
        msg_content: i === 0
          ? `record ${i} with api_key=EGRESS-CANARY-9d2f under ${FIXTURE_HOME}/ws`
          : `record ${i}`,
        ...(role === 'user' ? {} : {
          tool_calls: [{ tool_name: 'bash', tool_call_id: `c${i}`, tool_call_status: 2, tool_call_args: '{"command":"ls"}', tool_call_result_data: '{"text":"ok"}' }],
        }),
      },
    });
  }
  projection.task({
    taskId: 't-egress',
    sessionId: 'sess-egress',
    kind: 'bash',
    status: 'completed',
    createdAtMs: now - 2000,
    endedAtMs: now - 1500,
    record: { description: 'ls -la', toolCallId: 'c1', metadata: { command: 'ls -la' }, outputRef: { uri: 'x' } },
  });
  // A delivered file, carrying a credential in its *name* and an absolute path in
  // its own field. The assets table is a data source of its own, so it needs its own
  // canary: a sweep whose canaries live only in message bodies and agent prompts is
  // blind to a tool that reads a table nobody put a canary in. That is exactly how the
  // excerpt leak in `trajectory_find` survived a sweep that ran every tool.
  projection.asset({
    sessionId: 'sess-egress',
    msgId: 'm2',
    createdAtMs: now - 2900,
    path: `${FIXTURE_HOME}/ws/out/report.pdf`,
    name: 'report for api_key=EGRESS-CANARY-9d2f',
    artifactId: 'artifact-egress-1',
  });

  projection.close();
  const store = openStore({ dataDir });
  // Close before removing. Windows refuses to unlink a file that is still open, so
  // registering the removal first passes on POSIX and fails everywhere else.
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store };
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

async function callRoute(store, url) {
  const res = makeRes();
  const req = {
    method: 'GET',
    url,
    headers: { host: `127.0.0.1:${PORT}`, 'x-trajectory-token': TOKEN },
    socket: { localPort: PORT, remoteAddress: '127.0.0.1' },
  };
  const handler = createRequestHandler({
    store,
    homeDir: FIXTURE_HOME,
    getFocus: () => 'sess-egress',
    setFocus: () => {},
    getToken: () => TOKEN,
  });
  const stderr = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    await handler(req, res);
  } finally {
    process.stderr.write = original;
  }
  return { status: res.status, body: res.body, stderr: stderr.join('') };
}

/* ------------------------------------------------------------ http egress -- */

test('every API route answers a populated session without erroring', async (t) => {
  const { store } = await seedEgressFixture(t);
  for (const route of ROUTES) {
    const { status, body, stderr } = await callRoute(store, route);
    assert.equal(status, 200, `${route} answered ${status}: ${body}${stderr}`);
    // The error contract maps anything unexpected to one generic code, so a 200 with
    // that code would be the same defect wearing a different hat.
    assert.notEqual(body.includes('internal_error'), true, `${route} logged an unexpected error: ${stderr}`);
    assert.doesNotThrow(() => JSON.parse(body), `${route} did not answer JSON`);
  }
});

test('/api/overview carries the agent definition and its task list', async (t) => {
  // The specific regression: a populated definition made this route 500. Asserting
  // only "status is 200" would pass if the field silently disappeared, so the shape
  // is checked too.
  const { store } = await seedEgressFixture(t);
  const { body } = await callRoute(store, '/api/overview?id=sess-egress');
  const payload = JSON.parse(body);

  assert.equal(payload.agent.ownerName, 'mavis');
  assert.equal(typeof payload.agent.systemPrompt, 'string');
  assert.equal(payload.agent.systemPrompt.includes('EGRESS-CANARY-9d2f'), false, 'the system prompt leaked a credential');
  assert.equal(payload.agent.systemPrompt.includes(FIXTURE_HOME), false, 'the system prompt leaked an absolute path');
  assert.equal(payload.session.workspaceDir.startsWith('/'), false, 'the workspace path left verbatim');
  assert.equal(payload.stats.workspaceDir.startsWith('/'), false, 'the stats workspace path left verbatim');
  // Every record list is budgeted, so every one of them reports whether it was cut.
  assert.equal(payload.tasksTruncated, false, 'two short tasks must not read as a trimmed list');
  assert.equal(payload.tasksOmitted, 0);
  assert.equal(payload.tasks.length, payload.tasks.length + payload.tasksOmitted);
});

/* ------------------------------------------------------------- mcp egress -- */

const CALLS = [
  { name: 'trajectory_list', args: {} },
  { name: 'trajectory_summary', args: { sessionId: 'sess-egress' } },
  { name: 'trajectory_turns', args: { sessionId: 'sess-egress' } },
  { name: 'trajectory_agent', args: { sessionId: 'sess-egress' } },
  { name: 'trajectory_find', args: { sessionId: 'sess-egress', query: 'egress' } },
  { name: 'trajectory_find', args: { sessionId: 'sess-egress', query: 'egress', detailLevel: 'full' } },
  { name: 'trajectory_get', args: { sessionId: 'sess-egress' } },
  { name: 'trajectory_get', args: { sessionId: 'sess-egress', detailLevel: 'full' } },
  { name: 'trajectory_search', args: { query: 'fixture' } },
  { name: 'trajectory_tasks', args: { sessionId: 'sess-egress' } },
  { name: 'trajectory_task_output', args: { taskId: 't-egress' } },
  { name: 'trajectory_assets', args: { sessionId: 'sess-egress' } },
];

test('every MCP tool answers a populated session without erroring', async (t) => {
  const { store } = await seedEgressFixture(t);
  const studio = {
    start: async () => ({ url: `http://127.0.0.1:1/#t=x`, port: 1, reused: false }),
    stop: async () => true,
  };
  const handler = createHandler({ store, studio, homeDir: FIXTURE_HOME, redactRoots: [store.dataDir] });

  for (const call of CALLS) {
    const result = await handler.call(call.name, call.args);
    assert.ok(result && typeof result === 'object', `${call.name} returned no result`);
    assert.doesNotThrow(
      () => JSON.stringify(result),
      `${call.name} returned a value the MCP frame cannot serialise`,
    );
  }
});

/**
 * The record-list contract, asserted per tool rather than per surface.
 *
 * `trajectory_tasks` shipped for two rounds with `limit: 2000` and no aggregate
 * bound, because the budget had been added to `trajectory_get` and the list tools
 * were not audited against it. Declaring which tools return records — and checking
 * the declaration against the tools that actually exist — is what stops the next
 * list tool from being added without the same three fields.
 */
const RECORD_LIST_TOOLS = new Set([
  'trajectory_list',
  'trajectory_get',
  'trajectory_search',
  'trajectory_tasks',
  'trajectory_turns',
  'trajectory_find',
  'trajectory_assets',
  'trajectory_changes',
  'trajectory_ingress',
]);

test('every record-list tool reports whether it was trimmed', async (t) => {
  const { store } = await seedEgressFixture(t);
  const studio = {
    start: async () => ({ url: 'http://127.0.0.1:1/#t=x', port: 1, reused: false }),
    stop: async () => true,
  };
  const handler = createHandler({ store, studio, homeDir: FIXTURE_HOME, redactRoots: [store.dataDir] });

  for (const tool of TOOLS.filter((entry) => RECORD_LIST_TOOLS.has(entry.name))) {
    const args = { sessionId: 'sess-egress', ...(tool.name === 'trajectory_search' ? { query: 'fixture' } : {}) };
    const result = await handler.call(tool.name, args);
    assert.equal(typeof result.truncated, 'boolean', `${tool.name} does not report truncated`);
    assert.equal(typeof result.omitted, 'number', `${tool.name} does not report omitted`);
    assert.equal(typeof result.returned, 'number', `${tool.name} does not report how many it returned`);
    assert.ok(result.returned >= 0 && result.omitted >= 0, `${tool.name} reported a negative count`);
  }
});

test('a paged record list resumes at the first undelivered record', async (t) => {
  // The cursor is the one value every client pages on, and it was the one that did
  // not survive the aggregate bound: a trimmed page answered with the store's
  // read-count and skipped the records in between, permanently. On a short fixture
  // nothing is trimmed, so this pins the *unchanged* contract — that the cursor still
  // points past the last delivered record — while the trimming case is covered by
  // the over-budget tests in `http.test.mjs`.
  const { store } = await seedEgressFixture(t);
  const studio = {
    start: async () => ({ url: 'http://127.0.0.1:1/#t=x', port: 1, reused: false }),
    stop: async () => true,
  };
  const handler = createHandler({ store, studio, homeDir: FIXTURE_HOME, redactRoots: [store.dataDir] });

  const first = await handler.call('trajectory_get', { sessionId: 'sess-egress', offset: 0, limit: 1 });
  assert.equal(first.events.length, 1);
  assert.equal(first.nextOffset, 1, 'the cursor must name the first record the caller did not get');
  assert.equal(first.offset, 0, 'the reply must echo the offset it was asked for');

  const second = await handler.call('trajectory_get', { sessionId: 'sess-egress', offset: first.nextOffset, limit: 1 });
  assert.equal(second.offset, 1);
  assert.equal(second.events[0].index, 1, 'the second page repeated or skipped a record');

  const third = await handler.call('trajectory_get', { sessionId: 'sess-egress', offset: second.nextOffset, limit: 1 });
  assert.equal(third.nextOffset, null, 'the cursor must terminate at the end of the session');
  assert.equal(third.events.length, 1);
});

test('no tool leaks a path or a credential on a populated session', async (t) => {
  const { store } = await seedEgressFixture(t);
  const studio = {
    start: async () => ({ url: 'http://127.0.0.1:1/#t=x', port: 1, reused: false }),
    stop: async () => true,
  };
  const handler = createHandler({ store, studio, homeDir: FIXTURE_HOME, redactRoots: [store.dataDir] });
  for (const call of CALLS) {
    const result = await handler.call(call.name, call.args);
    const body = JSON.stringify(result);
    assert.equal(body.includes(FIXTURE_HOME), false, `${call.name} returned the absolute home path`);
    // The credential canary now lives in a *message body*, an agent prompt and an asset
    // display name, so this also covers every tool that quotes any of the three —
    // the search tool returning a raw excerpt passed the path-only version of this
    // sweep, because there was nothing in a message for it to catch, and an asset
    // list would pass for the same reason.
    assert.equal(
      body.includes('EGRESS-CANARY-9d2f'),
      false,
      `${call.name} returned the credential canary`,
    );
  }
});

test('the asset sweep has teeth: the canary is reachable in the first place', async (t) => {
  // A sweep is only evidence if the leak it would catch is real. This reads the asset
  // row straight out of the fixture, unredacted, and asserts the canary and the
  // absolute path are both actually there — so a green sweep above means the
  // redaction worked, not that there was nothing to redact.
  const { store } = await seedEgressFixture(t);
  const row = store.db.prepare(
    'SELECT name, path FROM local_runtime_session_assets WHERE session_id = ?',
  ).get('sess-egress');
  assert.ok(row, 'the fixture no longer seeds an asset, so the asset egress is unprobed');
  assert.match(row.name, /EGRESS-CANARY-9d2f/u);
  assert.ok(row.path.startsWith(FIXTURE_HOME), 'the fixture asset path is not under the home directory');
});

test('the asset list folds its path and redacts its name', async (t) => {
  const { store } = await seedEgressFixture(t);
  const handler = createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [store.dataDir] });
  const reply = await handler.call('trajectory_assets', { sessionId: 'sess-egress' });
  assert.equal(reply.available, true);
  assert.equal(reply.total, 1);
  const [asset] = reply.assets;
  assert.ok(asset, 'the seeded asset did not come back');
  assert.equal(asset.path.startsWith(FIXTURE_HOME), false, `the asset path left verbatim: ${asset.path}`);
  assert.match(asset.path, /^~/u, 'a home-relative path should fold to `~` rather than be dropped');
  assert.equal(asset.name.includes('EGRESS-CANARY-9d2f'), false, 'the credential in the asset name leaked');
  // The path still has to be a usable answer after folding: a redaction that removed
  // it entirely would pass the check above and leave the reader with nothing.
  assert.match(asset.path, /out\/report\.pdf$/u, 'folding removed the part of the path that identifies the file');
});
