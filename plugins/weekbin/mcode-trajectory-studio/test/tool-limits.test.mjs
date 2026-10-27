/**
 * Every other read in this Plugin clamps `limit` before it uses it. One did not.
 *
 * `trajectory_turns` is the only session-scoped tool that pages in the handler rather
 * than in the store, so it was the only one that never saw `clamp`. The turn list is
 * already in memory — it is a fold of the whole session — so the page is a `slice`, and
 * a `slice` has no bounds of its own:
 *
 *   limit: 0   -> slice(at, at)      -> an empty page
 *   limit: -5  -> slice(at, at - 5)  -> everything except the last five turns
 *
 * Neither is reachable through the schema, which declares `minimum: 1` — but
 * `tools/call` performs no schema validation. `params.arguments` reaches the handler
 * as written, so a bound that exists only in a JSON Schema is documentation, and this
 * session already had that proven the hard way: `includeArchived: "false"` arrived as
 * the boolean `true`.
 *
 * `limit: 0` is the sharp one. The reply carries `total: 100`, `returned: 0`, and
 * `nextOffset: null` — and a cursor of `null` is how every other tool here says "that
 * is the whole list". A caller paging on the cursor concludes the session has no turns
 * while holding the count that says it has a hundred. An empty page is supposed to
 * mean "you are past the end", never "you asked for nothing and I will not tell you
 * where to go next".
 *
 * `limit: -5` is the quieter half: it returns *more* than the caller asked for and
 * more than the schema permits, and nothing on the reply says the ceiling was ignored.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureProjection } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';
import { TOOLS } from '../server/mcp.mjs';

const NOW = 1_700_000_000_000;
const TURNS = 40;
const RECORDS_PER_TURN = 3;

const studio = {
  start: async () => ({ url: 'http://127.0.0.1:1/', port: 1, reused: false }),
  stop: async () => true,
};

/** One session whose records fall into `TURNS` turn groups. */
async function multiTurnSession(t, { id = 'sess-a', turns = TURNS } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-turnlimit-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id, title: 'Turns', updatedAtMs: NOW });
  let msg = 0;
  for (let turn = 0; turn < turns; turn += 1) {
    for (let k = 0; k < RECORDS_PER_TURN; k += 1) {
      projection.row({
        sessionId: id,
        msgId: `m${msg}`,
        role: k === 0 ? 'user' : 'assistant',
        turnId: `turn-${turn}`,
        createdAtMs: NOW + msg,
        data: { msg_content: `record ${msg} of turn ${turn}` },
      });
      msg += 1;
    }
  }
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { store, id, turns };
}

async function callTool(store, name, args) {
  const handler = createHandler({ store, studio, homeDir: '/tmp/trajectory-turnlimit-home' });
  return handler.call(name, args);
}

/* ------------------------------------------------------- the defect itself -- */

test('limit 0 does not answer a complete walk from a page it never delivered', async (t) => {
  const { store, id, turns } = await multiTurnSession(t);
  const reply = await callTool(store, 'trajectory_turns', { sessionId: id, limit: 0 });

  assert.equal(reply.total, turns, 'the fixture does not hold the turn count the reply claims');
  // The clamp floor, not nothing: a page of zero records beside `total: 40` is the lie,
  // because `nextOffset: null` means "no more pages" everywhere else in this Plugin.
  assert.equal(reply.returned, 1, 'the clamp floor is one turn');
  assert.equal(reply.nextOffset, 1, 'the walk did not close itself over undelivered turns');
});

test('a negative limit does not hand back more turns than asked for', async (t) => {
  const { store, id, turns } = await multiTurnSession(t);
  const reply = await callTool(store, 'trajectory_turns', { sessionId: id, limit: -5 });

  assert.equal(reply.total, turns, 'the fixture does not hold the turn count');
  // `slice(0, -5)` on a forty-element array returns thirty-five, so "less than the whole
  // session" is not the assertion — the clamp floor is, because it is the only value that
  // distinguishes a bounded read from a slice's accidental arithmetic.
  assert.equal(reply.returned, 1, `a negative limit returned ${reply.returned} turns instead of the clamp floor`);
});

test('a limit that is not a number falls back to the default rather than to nothing', async (t) => {
  const { store, id } = await multiTurnSession(t);
  const reply = await callTool(store, 'trajectory_turns', { sessionId: id, limit: 'lots' });

  assert.ok(reply.returned > 0, `a non-numeric limit delivered ${reply.returned} turns`);
});

/* ----------------------------------------------------------- the controls -- */

test('an ordinary page and its cursor still walk the whole session exactly once', async (t) => {
  const { store, id, turns } = await multiTurnSession(t, { turns: 9 });
  const seen = [];
  let offset = 0;
  let last = null;
  for (let guard = 0; guard < turns + 2; guard += 1) {
    const page = await callTool(store, 'trajectory_turns', { sessionId: id, limit: 4, offset });
    last = page;
    for (const turn of page.turns) seen.push(turn.turnId);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }

  assert.equal(seen.length, turns, `the walk saw ${seen.length} of ${turns} turns`);
  assert.equal(new Set(seen).size, turns, 'the walk repeated a turn, so paging skipped nothing but doubled something');
  assert.equal(last.nextOffset, null, 'the walk never reached the end');
});

test('an offset past the end closes the walk instead of looping on itself', async (t) => {
  const { store, id, turns } = await multiTurnSession(t);
  const reply = await callTool(store, 'trajectory_turns', { sessionId: id, limit: 5, offset: turns + 10 });

  assert.equal(reply.returned, 0, 'the fixture offset is past the end');
  assert.equal(reply.nextOffset, null, 'a past-the-end page must close the walk');
});

/* ------------------------------------ the same hole, asked of every paging tool -- */

test('no paging tool turns a forbidden limit into an empty walk or an oversized page', async (t) => {
  const { store, id } = await multiTurnSession(t, { turns: 12 });
  // The defect was never turns-specific; it was that `tools/call` validates nothing and
  // each tool's own clamp is the only bound. So this asks every paged tool the two
  // questions a caller can ask with a value the schema forbids: do you hand me a page,
  // and is it a page?
  const probes = [
    ['trajectory_get', { sessionId: id }],
    ['trajectory_find', { sessionId: id, query: 'record' }],
    ['trajectory_turns', { sessionId: id }],
    ['trajectory_assets', { sessionId: id }],
    ['trajectory_changes', { sessionId: id }],
    ['trajectory_ingress', { sessionId: id }],
    ['trajectory_tasks', { sessionId: id }],
    ['trajectory_list', {}],
    ['trajectory_search', { query: 'Turns' }],
  ];

  const wrong = [];
  for (const [name, args] of probes) {
    const ceiling = TOOLS.find((tool) => tool.name === name)
      ?.inputSchema?.properties?.limit?.maximum;
    for (const limit of [0, -5, 'lots']) {
      const reply = await callTool(store, name, { ...args, limit });
      // A tool with nothing to return may say so; a tool holding rows must not answer
      // `limit: 0` with nothing, because `nextOffset: null` is how this Plugin says
      // "that is the whole list" and there is a list left.
      if ((reply.total ?? 0) > 0 && (reply.returned ?? 0) === 0) {
        wrong.push(`${name} limit=${JSON.stringify(limit)} returned nothing while total=${reply.total}`);
      }
      if (typeof ceiling === 'number' && (reply.returned ?? 0) > ceiling) {
        wrong.push(`${name} limit=${JSON.stringify(limit)} returned ${reply.returned} against a declared ceiling of ${ceiling}`);
      }
    }
  }

  assert.deepEqual(wrong, [], `limits outside the schema produced:\n${wrong.join('\n')}`);
});