/**
 * The progress view, without paging to build it.
 *
 * A session's turn breakdown is the first thing a question like "how did this run
 * break down?" or "which turn was expensive?" needs, and the store has always
 * computed it — the panel draws it. It was unreachable from MCP, so the only way to
 * get it was to page `trajectory_get` and fold the records client-side, at one call
 * per thousand records. On the session this was written against that is 701 records
 * to learn there are 17 turns.
 *
 * So this file pins two things. That the rollups are complete and pageable — a short
 * page must not read as a whole run, which is the defect that makes a summary
 * confidently wrong. And that they *reconcile*: summed over every turn they have to
 * equal the session aggregate `trajectory_summary` already reports. The two come from
 * different code — a GROUP BY and a single fold over the same rows — so nothing makes
 * them agree except a test, and a tool that let them drift would report a progress
 * breakdown that does not add up to the progress it claims to summarise.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureProjection, FIXTURE_HOME } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';

const NOW = 1_700_000_000_000;
const TURNS = 6;
const PER_TURN = 4;

/** Six turns of four records each, every turn carrying its own LLM duration. */
async function seeded(t, { turns = TURNS, perTurn = PER_TURN, failedToolCalls = [] } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'turns-tool-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-t', title: 'Turned', updatedAtMs: NOW });
  for (let t = 0; t < turns; t += 1) {
    for (let r = 0; r < perTurn; r += 1) {
      projection.row({
        sessionId: 'sess-t',
        msgId: `m-${t}-${r}`,
        role: r === 0 ? 'user' : 'assistant',
        turnId: `turn-${t}`,
        createdAtMs: NOW + t * 1000 + r,
        data: {
          usage: { request_duration_ms: 100 + t, output_tokens: 10 + t, input_tokens: 5 },
          // One record per turn carries that turn's tool calls, the way a turn's closing
          // assistant message would, so the fold has something to attribute to the right
          // turn rather than a session-wide total it cannot place. Status 2 is the runtime's "ok"; anything else is a
          // failure, which is the rule `trajectory_summary` counts them by.
          ...(r === perTurn - 1 && failedToolCalls[t]
            ? {
              tool_calls: Array.from({ length: 2 + failedToolCalls[t] }, (_, call) => ({
                name: `call-${call}`,
                tool_call_status: call < failedToolCalls[t] ? 3 : 2,
              })),
            }
            : {}),
        },
      });
    }
  }
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const call = (store, tool, args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
  .call(tool, args);

test('one row per turn, with the session\'s own turn count', async (t) => {
  const store = await seeded(t);
  const reply = await call(store, 'trajectory_turns', { sessionId: 'sess-t' });
  assert.equal(reply.total, TURNS);
  assert.equal(reply.returned, TURNS);
  assert.equal(reply.turns.length, TURNS);
  assert.equal(reply.nextOffset, null);
  for (const turn of reply.turns) {
    assert.equal(turn.count, PER_TURN, 'a turn did not report how many records it holds');
    assert.equal(typeof turn.llmMs, 'number');
    assert.equal(typeof turn.outputTokens, 'number');
    assert.equal(typeof turn.turnId, 'string');
  }
});

test('the rollups reconcile exactly with the session aggregate', async (t) => {
  // The property that makes the tool trustworthy. Summing every turn has to land on
  // the same record count, wall-clock and output tokens `trajectory_summary` reports,
  // because a caller will check one against the other and should never find a gap.
  const store = await seeded(t);
  const turns = await call(store, 'trajectory_turns', { sessionId: 'sess-t' });
  const summary = await call(store, 'trajectory_summary', { sessionId: 'sess-t' });
  const sum = turns.turns.reduce(
    (acc, turn) => ({
      records: acc.records + turn.count,
      llmMs: acc.llmMs + turn.llmMs,
      outputTokens: acc.outputTokens + turn.outputTokens,
    }),
    { records: 0, llmMs: 0, outputTokens: 0 },
  );
  assert.equal(sum.records, summary.events, 'turn records do not add up to the session\'s records');
  assert.equal(sum.llmMs, summary.llmMs, 'turn durations do not add up to the session\'s');
  assert.equal(sum.outputTokens, summary.decodeTokens,
    'turn output tokens do not add up to the session\'s — note the summary calls it decodeTokens');
});

test('the two tools name the output tokens the same way on each row', async (t) => {
  // The reconciliation above is the obvious thing to do with this tool, and it fails
  // on a name. `trajectory_summary` publishes the quantity as `decodeTokens` for dsh
  // parity while turn rows have always carried `outputTokens`, so a caller summing the
  // rows against the aggregate gets `undefined` and cannot tell a naming difference
  // from a miscalculation. Both names are on the row, and they agree.
  const store = await seeded(t);
  const turns = await call(store, 'trajectory_turns', { sessionId: 'sess-t' });
  for (const turn of turns.turns) {
    assert.equal(turn.decodeTokens, turn.outputTokens, 'the alias disagrees with the field it aliases');
  }
  const summary = await call(store, 'trajectory_summary', { sessionId: 'sess-t' });
  const sum = turns.turns.reduce((acc, turn) => acc + turn.decodeTokens, 0);
  assert.equal(sum, summary.decodeTokens, 'summing the aliased field does not reconcile either');
});

test('a short page says how many turns there are in total', async (t) => {
  // Without `total`, three turns on a page and three turns in a run are the same
  // shape, and a caller would report the page as the run.
  const store = await seeded(t);
  const reply = await call(store, 'trajectory_turns', { sessionId: 'sess-t', limit: 2 });
  assert.equal(reply.returned, 2);
  assert.equal(reply.total, TURNS, 'a partial page did not say how long the run was');
  assert.equal(reply.nextOffset, 2);
});

test('paging reaches every turn, each exactly once', async (t) => {
  const store = await seeded(t);
  const seen = [];
  let at = 0;
  let done = false;
  for (let page = 0; page < 10 && !done; page += 1) {
    const reply = await call(store, 'trajectory_turns', { sessionId: 'sess-t', offset: at, limit: 2 });
    seen.push(...reply.turns.map((turn) => turn.turnId));
    done = reply.nextOffset === null;
    at = reply.nextOffset;
  }
  assert.ok(done, 'the cursor never reached the end');
  assert.equal(seen.length, TURNS);
  assert.equal(new Set(seen).size, TURNS, 'a turn appeared on more than one page');
});

test('an offset past the end terminates rather than looping', async (t) => {
  const store = await seeded(t);
  const reply = await call(store, 'trajectory_turns', { sessionId: 'sess-t', offset: 999 });
  assert.deepEqual(reply.turns, []);
  assert.equal(reply.nextOffset, null);
});

test('the turn ids are the ones trajectory_get filters on', async (t) => {
  // Cross-surface agreement. The rollups and the `turnId` filter are two different
  // queries over the same rows; if they disagreed about which group a record belongs
  // to, a caller would ask for a turn by id and find the filter disagreeing with the
  // row it was just quoted.
  const store = await seeded(t);
  const turns = await call(store, 'trajectory_turns', { sessionId: 'sess-t' });
  for (const turn of turns.turns) {
    const filtered = await call(store, 'trajectory_get', { sessionId: 'sess-t', turnId: turn.turnId, limit: 100 });
    assert.equal(filtered.total, turn.count,
      `trajectory_get found ${filtered.total} records for ${turn.turnId}, but the turn row claims ${turn.count}`);
  }
});

test('omitting the session id uses the most recently updated one', async (t) => {
  const store = await seeded(t);
  const reply = await call(store, 'trajectory_turns', {});
  assert.equal(reply.sessionId, 'sess-t');
  assert.equal(reply.total, TURNS);
});

test('a session with no turns answers empty rather than failing', async (t) => {
  const store = await seeded(t, { turns: 0, perTurn: 0 });
  const reply = await call(store, 'trajectory_turns', { sessionId: 'sess-t' });
  assert.deepEqual(reply.turns, []);
  assert.equal(reply.total, 0);
  assert.equal(reply.nextOffset, null);
});
/* ------------------------------------------- the artifact path has turns too -- */

/**
 * The progress view answered `total: 0` for a session the indexer had not reached.
 *
 * `getTurnSummaries` reads the projection only. For an un-indexed session it folded
 * nothing and reported zero turns — for a run whose records `trajectory_get` was
 * listing from disk, three of them under a turn id. The progress view is the tool a
 * model reaches for to learn how a run was divided up, so a wrong zero there is worse
 * than no answer at all: it is an answer, and it is false.
 *
 * These are the artifact's own record shape (`message_id` and a nested `message`).
 * Writing the projection's shape folds into records with a null turn id, which reads
 * exactly like a broken fold and is in fact a correctly-folded record that said
 * nothing.
 */
async function artifactSeeded(t, records, { sessionId = 'sess-artifact' } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'turns-artifact-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: sessionId, title: 'Freshly written', updatedAtMs: NOW });
  projection.close();
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '18', `10-00-00-000-${sessionId}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'messages.jsonl'),
    records.map((turnId, index) => `${JSON.stringify({
      message_id: `m${index}`,
      turn_id: turnId,
      message: { role: 'user', content: [{ type: 'text', text: `record ${index}` }] },
    })}\n`).join(''), 'utf8');
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const turns = (store, args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
  .call('trajectory_turns', args);

test('an un-indexed session reports its turns, not zero', async (t) => {
  const store = await artifactSeeded(t, ['turn-1', 'turn-1', 'turn-2', 'turn-3', 'turn-3', 'turn-3']);
  const reply = await turns(store, { sessionId: 'sess-artifact' });
  assert.equal(reply.source, 'jsonl', 'this case is only meaningful on the artifact path');
  assert.equal(reply.total, 3);
  assert.deepEqual(reply.turns.map((turn) => turn.turnId), ['turn-1', 'turn-2', 'turn-3']);
  assert.deepEqual(reply.turns.map((turn) => turn.count), [2, 1, 3]);
});

test('the artifact turn view agrees with the records it comes from', async (t) => {
  // The cross-check that makes the count mean something: the same records, read by the
  // other tool, have to divide up the same way. A fold that invented a grouping would
  // pass on its own answer alone.
  const store = await artifactSeeded(t, ['a', 'a', 'b', 'b', 'b', 'c']);
  const view = await turns(store, { sessionId: 'sess-artifact' });
  const page = await createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
    .call('trajectory_get', { sessionId: 'sess-artifact', limit: 100 });
  const counted = new Map();
  for (const event of page.events) counted.set(event.turnId, (counted.get(event.turnId) ?? 0) + 1);
  assert.equal(view.total, counted.size, 'the turn view and the records disagree on how many turns there were');
  for (const turn of view.turns) {
    assert.equal(turn.count, counted.get(turn.turnId), `turn ${turn.turnId} has a different record count here`);
  }
});

test('an artifact turn reports unknown timings as null, not as zero', async (t) => {
  // The artifact records no request duration and no usage. `0` would be a measurement —
  // "this turn cost nothing" — where the truth is that nobody measured it.
  const store = await artifactSeeded(t, ['turn-1', 'turn-1']);
  const [turn] = (await turns(store, { sessionId: 'sess-artifact' })).turns;
  assert.equal(turn.llmMs, null, 'an unmeasured duration was reported as zero');
  assert.equal(turn.outputTokens, null, 'an unrecorded token count was reported as zero');
  assert.equal(turn.decodeTokens, null, 'the alias published a zero the source never claimed');
});

test('records that name no turn group together, as the projection groups them', async (t) => {
  const store = await artifactSeeded(t, ['turn-1', null, null]);
  const reply = await turns(store, { sessionId: 'sess-artifact' });
  assert.deepEqual(reply.turns.map((turn) => turn.turnId), ['turn-1', null]);
  assert.equal(reply.turns.at(-1).count, 2, 'the no-turn group did not hold both records');
});

test('an indexed session still answers from the projection', async (t) => {
  // The control: the fallback must not fire for a session the projection has, and must
  // not make the common call pay for an artifact read.
  const store = await seeded(t);
  const reply = await createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
    .call('trajectory_turns', { sessionId: 'sess-t' });
  assert.equal(reply.source, 'sqlite', 'the artifact fallback fired for an indexed session');
  assert.equal(reply.total, TURNS);
});

test('each turn says how many of its tool calls failed', async (t) => {
  // The field that makes a session's failures *addressable*. `trajectory_summary` has
  // always published `toolFailures` and every record carries its own count, but the turn
  // rows carried neither — so "which turn of this run went wrong" had no cheap answer at
  // all. On the 21992-record session this was measured against it cost twenty-two pages
  // and 1.4 seconds to read every record and inspect `toolCalls[].ok` by hand; with the
  // count here it is three pages of turns and one `trajectory_get` with `turnId`, a
  // filter the tool already had.
  const store = await seeded(t, { failedToolCalls: [0, 2, 0, 1, 0, 0] });
  const reply = await call(store, 'trajectory_turns', { sessionId: 'sess-t' });
  const byId = new Map(reply.turns.map((turn) => [turn.turnId, turn]));
  assert.equal(byId.get('turn-0').failureCount, 0);
  assert.equal(byId.get('turn-1').failureCount, 2, 'a turn with two failing calls did not report two');
  assert.equal(byId.get('turn-3').failureCount, 1);
  // A turn whose records made no tool calls at all is absent from the failure query
  // rather than present with a zero, because `json_each` on a missing path yields no
  // rows. What the caller sees has to be the zero, not `undefined` — an absent field
  // reads as "not computed" and sends the caller back to paging every record.
  for (const turnId of ['turn-0', 'turn-2', 'turn-4', 'turn-5']) {
    assert.equal(byId.get(turnId).failureCount, 0,
      `${turnId} made no tool calls and should read as zero failures, not ${byId.get(turnId).failureCount}`);
  }
});

test('the failures reconcile exactly with the session aggregate', async (t) => {
  // Same property as the records, durations and tokens above, on the same reason: the
  // two come from different statements over the same rows — a GROUP BY and a `json_each`
  // expansion — so nothing makes them agree except this test. A session that reports
  // 752 failures and whose turns add up to 751 would be a progress view that does not
  // add up to the progress it claims to summarise.
  const store = await seeded(t, { failedToolCalls: [0, 2, 0, 1, 0, 3] });
  const turns = await call(store, 'trajectory_turns', { sessionId: 'sess-t' });
  const summary = await call(store, 'trajectory_summary', { sessionId: 'sess-t' });
  const sum = turns.turns.reduce((acc, turn) => acc + turn.failureCount, 0);
  assert.equal(sum, 6, 'the fixture is not shaped the way this case assumes');
  assert.equal(sum, summary.toolFailures, 'turn failures do not add up to the session\'s');
});

test('a turn with no failures reports zero, not null', async (t) => {
  // `null` is the artifact path's answer — the fold there records no failure state — and
  // the two must not be confused. Zero is a finding ("nothing failed in this turn");
  // null means "this source does not say".
  const store = await seeded(t);
  const reply = await call(store, 'trajectory_turns', { sessionId: 'sess-t' });
  for (const turn of reply.turns) {
    assert.equal(turn.failureCount, 0);
    assert.notEqual(turn.failureCount, null);
  }
});

test('a session read from its artifact reports failures as not recorded, not as zero', async (t) => {
  // `trajectory_turns` falls back to a session's own `messages.jsonl` when the projection
  // has not indexed it. That fold records turn membership and record counts but never
  // looks at tool calls, so `failureCount` is `null` there — "this source does not say",
  // which is a different answer from "nothing failed". Getting that wrong is expensive in
  // one direction and merely confusing in the other: reporting `0` for a session whose
  // turns were never examined would tell the reader the run was clean.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'turns-artifact-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-art', title: 'Artifact', updatedAtMs: NOW });
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '18', '10-00-00-000-sess-art');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'messages.jsonl'), [0, 1].map((i) => JSON.stringify({
    message_id: `a${i}`,
    turn_id: i === 0 ? 'turn-0' : 'turn-1',
    message: { role: i === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: 'body' }] },
  })).join('\n') + '\n', 'utf8');
  projection.close();

  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const reply = await call(store, 'trajectory_turns', { sessionId: 'sess-art' });
  assert.equal(reply.source, 'jsonl', 'the reply does not say which store answered');
  assert.ok(reply.turns.length > 0, 'the artifact fold produced no turns at all');
  for (const turn of reply.turns) {
    assert.equal(turn.failureCount, null,
      'the artifact fold reports a failure count it never computed');
    assert.equal(turn.llmMs, null, 'and the same for durations, which the artifact also does not record');
  }
  // The two shapes have to stay distinguishable, or a reader cannot tell "nothing
  // failed" from "nobody looked".
  const projected = await seeded(t);
  const zero = await call(projected, 'trajectory_turns', { sessionId: 'sess-t' });
  assert.equal(zero.turns[0].failureCount, 0, 'a projected turn must read as zero, not null');
});
