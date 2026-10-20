/**
 * Turns the runtime accepted, and the ones it buried.
 *
 * `local_runtime_turn_ingress` records every turn the runtime took in: when it was
 * accepted, what claimed it, and how it ended. The transcript projection records what
 * happened *inside* a turn. Those are not the same set, and on the machine this was
 * measured on the difference is the whole point:
 *
 * ```
 * ingress turns            2,466 across 582 sessions
 *   completed              2,344
 *   aborted                   64   ←
 *   failed                    56   ←
 *   accepted                   2
 * turns in NO message row     27   (13 completed, 10 failed, 4 aborted)
 * ```
 *
 * **14 of those 120 failed-or-aborted turns appear in no message row at all**, spread
 * across 7 sessions. Read through this plugin's tools, one of those sessions reports
 * `status: 'idle'`, `errorMessage: absent`, `warnings: []` and 62 turns of ordinary work —
 * a clean run with the deaths nowhere in it. Nothing on any reply contradicts that
 * reading, because the transcript genuinely does not contain the turns.
 *
 * What the tool can and cannot say is measured, not assumed. The ingress table has **no
 * reason column** — `pragma_table_info` returns sixteen columns and none of them records
 * why a turn failed — so this tool reports *that* a turn was accepted, *when*, *what
 * claimed it* and *how it ended*. It does not invent a cause, and the tests pin that
 * distinction rather than blurring it.
 *
 * The other reason this exists: `claim_source` distinguishes who asked. On that machine
 * **668 of 2,466 turns were started by a thread goal** — the mechanism §8.37 published —
 * so "what started this turn" is answerable only from here.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createFixtureProjection, FIXTURE_HOME, FIXTURE_WORKSPACE, dropProjectionTable, withProjectionDb } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';

const NOW = 1_700_000_000_000;

/**
 * A session whose turns mostly succeeded and three of which the transcript never saw.
 *
 * The invisible ones are the case: seeding them *and* the visible ones together is what
 * makes the tool's job checkable, because a reader has to be able to tell the two apart
 * on the same reply.
 */
async function seeded(t, { dropTable = false, turnCount = 5 } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ingress-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Alpha', updatedAtMs: NOW, workspaceDir: FIXTURE_WORKSPACE });
  projection.session({ id: 'sess-plain', title: 'Nothing recorded', updatedAtMs: NOW - 10_000, workspaceDir: FIXTURE_WORKSPACE });
  for (let i = 0; i < turnCount; i += 1) {
    const turnId = `turn-${i}`;
    projection.row({
      sessionId: 'sess-a', msgId: `m${i}`, role: i % 2 ? 'assistant' : 'user',
      turnId, createdAtMs: NOW + i, data: { role: 'user', content: 'work' },
    });
    projection.ingress({
      sessionId: 'sess-a', turnId, status: 'completed', acceptedAtMs: NOW + i,
      completedAtMs: NOW + i + 500,
    });
  }
  // Three bad endings the transcript never saw — 120 such turns exist on the machine this
  // was measured on (56 failed, 64 aborted), and 14 of them are invisible. Two failures
  // and one abort, so the status counts are not all one value and a mutation that hardcodes
  // one of them cannot pass.
  const ghosts = [['failed', 100], ['failed', 101], ['aborted', 102]];
  for (const [status, at] of ghosts) {
    projection.ingress({
      sessionId: 'sess-a', turnId: `ghost-${at}`, status, acceptedAtMs: NOW + at,
      completedAtMs: NOW + 90_000 + at, queueAcknowledgedAtMs: null,
    });
  }
  // A goal-started turn, because 668 of the machine's 2,466 come from that source and a
  // fixture that never seeds one would reproduce a shape that does not occur.
  projection.ingress({
    sessionId: 'sess-a', turnId: 'goal-turn', status: 'completed', claimSource: 'thread-goal',
    acceptedAtMs: NOW + 300, completedAtMs: NOW + 900,
  });
  projection.close();
  if (dropTable) dropProjectionTable(dbPath, 'local_runtime_turn_ingress');
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const call = (store, tool, args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
  .call(tool, args);

const turns = async (store, args = {}) => call(store, 'trajectory_ingress', { sessionId: 'sess-a', ...args });

/* -------------------------------------------------- the buried turns show up -- */

test('a turn that failed without leaving a record is still listed', async (t) => {
  const store = await seeded(t);
  const reply = await turns(store);

  assert.equal(reply.available, true);
  assert.equal(reply.total, 9, 'five completed, one goal-started, and three the transcript never saw');
  const ghosts = reply.turns.filter((turn) => turn.turnId.startsWith('ghost-'));
  assert.equal(ghosts.length, 3);
  assert.deepEqual(ghosts.map((turn) => turn.status).sort(), ['aborted', 'failed', 'failed']);

  // The fact the whole tool exists for. `inTranscript: false` on a turn that completed is
  // also true — a turn can be recorded by the runtime and absent from the projection for
  // reasons other than failure — so this flag alone is not "it died"; it is the pair.
  for (const ghost of ghosts) {
    assert.equal(ghost.inTranscript, false,
      `${ghost.turnId} left no trace in the transcript and must say so`);
  }
  const visible = reply.turns.filter((turn) => turn.turnId.startsWith('turn-'));
  assert.equal(visible.length, 5);
  assert.ok(visible.every((turn) => turn.inTranscript === true));
});

test('the counts separate "ended badly" from "never recorded"', async (t) => {
  // These are different questions and conflating them is how a session with 14 dead
  // turns gets read as a clean one. `failed`/`aborted` is what the runtime says about a
  // turn it accepted; `missingFromTranscript` is what the projection says about a turn
  // the transcript does not carry — which includes 13 turns that *completed*.
  const store = await seeded(t);
  const reply = await turns(store);

  assert.equal(reply.statusCounts.failed, 2);
  assert.equal(reply.statusCounts.aborted, 1);
  assert.equal(reply.statusCounts.completed, 6,
    'the five visible ones plus the goal-started turn, which the projection never received either');
  assert.equal(reply.failedOrAborted, 3);
  assert.equal(reply.missingFromTranscript, 4,
    'the three bad endings and the goal turn, which the projection never received');
  assert.equal(reply.reportedInTranscript, reply.total - reply.missingFromTranscript);
});

test('the summary carries the count a clean-looking session is hiding', async (t) => {
  // The surface a reader reaches first. Before this, the seeded session reported
  // `status: 'idle'`, no `errorMessage` and `warnings: []` while three of its turns were
  // dead — the transcript does not contain them, so nothing else on the reply could say
  // so.
  const store = await seeded(t);
  const summary = await call(store, 'trajectory_summary', { sessionId: 'sess-a' });

  assert.equal(summary.ingressAvailable, true);
  assert.equal(summary.turnsFailedOrAborted, 3);
  assert.equal(summary.turnsMissingFromTranscript, 4);
  assert.deepEqual(summary.warnings, [],
    'a count that was taken is not a degraded aggregate — the field is the disclosure');
  assert.equal(summary.errorMessage, undefined,
    'the control: the session row itself records no error');
});

/* ------------------------------------------------------- what it cannot say -- */

test('no reason is invented for a turn that failed', async (t) => {
  // The ingress table has no reason column — sixteen columns, none of them why. A tool
  // that published a `reason` here would be inventing the one fact a reader most wants,
  // and every value it could print would be a guess wearing a field name.
  const store = await seeded(t);
  const reply = await turns(store);
  const failed = reply.turns.find((turn) => turn.status === 'failed');

  assert.equal('reason' in failed, false, 'the table records no reason, so neither does the tool');
  assert.equal('errorMessage' in failed, false);
  // What it *does* carry is what the runtime recorded, and a reader can use it to say
  // which turn and when without being told a cause.
  // Read off the seeded timestamps rather than restated: the point of this test is that
  // the tool carries what was recorded, and an expectation copied from the implementation
  // would pass on a query that computed the same wrong thing.
  assert.equal(failed.acceptedAtMs, NOW + 100);
  assert.equal(failed.completedAtMs, NOW + 90_100);
  assert.equal(typeof failed.turnId, 'string');
});

test('what started a turn is answerable, and 668 real turns came from a goal', async (t) => {
  // `claim_source` is the only place the runtime records *who asked*, and on the machine
  // this was measured on `thread-goal` is the second-largest source at 668 of 2,466.
  // Before this there was no way to tell a turn a user typed from one a goal started.
  const store = await seeded(t);
  const reply = await turns(store);
  const bySource = reply.claimCounts;

  assert.equal(bySource['thread-goal'], 1);
  const unclaimed = reply.turns.filter((turn) => turn.claimSource === null);
  assert.equal(unclaimed.length, 8,
    'most real rows have a null claim_source — reported as null, never as "user"');
  assert.equal('user' in bySource, false,
    'a null claim_source is an absent answer, not an attribution to the user');
});

/* ------------------------------------------------------- absence vs no rows -- */

test('the transcript lookup stays index-usable', () => {
  // Nothing a test can *observe* changes if the comparison stops being index-usable —
  // the same rows come back either way, so a behavioural assertion cannot catch it, and
  // the F-tier mutation survived until this line existed. What changes is the cost: the
  // runtime keeps `idx_local_runtime_message_rows_turn_source (session_id, turn_id, role,
  // id)`, and `COALESCE(m.turn_id, '') = COALESCE(i.turn_id, '')` wraps both sides in a
  // function so the planner cannot use it, turning one probe per ingress row into a rescan
  // of the session's messages. Measured on the largest session here — 471 ingress rows over
  // 23,732 messages: **0.8 ms with `IS`, 390 ms with `COALESCE`**.
  //
  // `IS` is not a dodge for the NULL problem — it is SQLite's NULL-safe comparison, so it
  // matches exactly what the `COALESCE` form would have. Comments are stripped first: this
  // paragraph quotes both forms while explaining why one of them is wrong, and a scanner
  // that reads its own prose trips over the explanation.
  const source = readFileSync(new URL('../server/ingress.mjs', import.meta.url), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
  assert.match(code, /m\.turn_id IS i\.turn_id/u,
    'the turn comparison must be `IS` so the turn-id index can be used');
  assert.doesNotMatch(code, /COALESCE\(\s*(?:m|i)\.turn_id/,
    'wrapping turn_id in COALESCE here disables the index this lookup depends on');
});

test('a turn that fails at intake is not served from cache', async (t) => {
  // The same shape §8.35 found for change sets, one field over, and the reason it is
  // worth a test rather than a comment: **a turn that fails at intake writes no message
  // row and does not touch the session row.** So neither `messageSignature` nor the
  // session's own `updated_at_ms` moves when one dies, and a summary computed a moment
  // earlier kept reporting `turnsFailedOrAborted: 0` for as long as the process lived —
  // a clean bill of health on the one question this field exists to answer.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ingress-cache-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Alpha', updatedAtMs: NOW, workspaceDir: FIXTURE_WORKSPACE });
  projection.row({
    sessionId: 'sess-a', msgId: 'm0', role: 'user', turnId: 'turn-0',
    createdAtMs: NOW, data: { role: 'user', content: 'go' },
  });
  projection.ingress({
    sessionId: 'sess-a', turnId: 'turn-0', status: 'completed',
    acceptedAtMs: NOW, completedAtMs: NOW + 500,
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const handler = createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] });
  const before = await handler.call('trajectory_summary', { sessionId: 'sess-a' });
  assert.equal(before.turnsFailedOrAborted, 0);
  assert.equal(before.turnsMissingFromTranscript, 0);
  assert.equal(before.turns, 1, 'the control: the transcript carries one turn');

  // The runtime takes in a turn and it dies before any message row is written. Written
  // through a **separate writable connection** because the store opens the projection
  // read-only by design — which is also what makes this faithful: the runtime writes, the
  // plugin reads.
  withProjectionDb(dbPath, (db) => db.prepare(`
    INSERT INTO local_runtime_turn_ingress
      (turn_id, session_id, source, client_request_id, claim_id, claim_source,
       queue_item_ids_json, input_json, status, accepted_at_ms, accepted_sequence,
       completed_at_ms, queue_acknowledged_at_ms, input_digest, input_metadata_json)
    VALUES ('turn-dead', 'sess-a', 'turn', NULL, 'c1', NULL, '[]', '{}', 'failed',
            ?, 2, ?, NULL, 'sha256:x', '{}')
  `).run(NOW + 60_000, NOW + 90_000));

  const after = await handler.call('trajectory_summary', { sessionId: 'sess-a' });
  assert.equal(after.turnsFailedOrAborted, 1,
    'a turn that died must not be hidden by a summary computed before it did');
  assert.equal(after.turnsMissingFromTranscript, 1);
  assert.equal(after.turns, 1, 'and the transcript is unchanged, which is the whole point');
});

test('a session that recorded no turns says so rather than listing nothing', async (t) => {
  const store = await seeded(t);
  const reply = await call(store, 'trajectory_ingress', { sessionId: 'sess-plain' });

  assert.equal(reply.available, true);
  assert.equal(reply.total, 0);
  assert.deepEqual(reply.turns, []);
  assert.equal(reply.failedOrAborted, 0);
  // Absent rather than `null`, the same as every other tool here: a note that is not
  // there means the call did what was asked, and one that reads "null" is a second way
  // to say the same thing with nothing to back it up.
  assert.equal('note' in reply, false, 'an empty list is ordinary when the runtime recorded none');
});

test('a runtime without the table says so instead of reading as "every turn succeeded"', async (t) => {
  // The failure this most easily hides: an empty list plus `failedOrAborted: 0` on a
  // machine that cannot answer is a clean bill of health, which is exactly the reading
  // that was wrong in the first place.
  const store = await seeded(t, { dropTable: true });
  const reply = await turns(store);

  assert.equal(reply.available, false);
  assert.equal(reply.total, 0);
  assert.equal(reply.failedOrAborted, null,
    'a count nobody took is not a count of zero');
  assert.match(String(reply.note), /turn_ingress/u);

  const summary = await call(store, 'trajectory_summary', { sessionId: 'sess-a' });
  assert.equal(summary.ingressAvailable, false);
  assert.equal(summary.turnsFailedOrAborted, null);
  assert.ok(summary.warnings.some((warning) => String(warning).includes('turn_ingress')),
    `the warning must name the table: ${JSON.stringify(summary.warnings)}`);
});

/* ------------------------------------------------------------- the contract -- */

test('the cursor walks the ingress list without skipping or repeating a turn', async (t) => {
  const store = await seeded(t);
  const seen = [];
  const acceptedOrder = [];
  let offset = 0;
  for (;;) {
    const page = await turns(store, { offset, limit: 3 });
    seen.push(...page.turns.map((turn) => turn.turnId));
    acceptedOrder.push(...page.turns.map((turn) => turn.acceptedAtMs));
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset, 'the cursor must move');
    offset = page.nextOffset;
  }
  assert.equal(seen.length, 9);
  assert.equal(new Set(seen).size, 9, 'no turn delivered twice');
  // Accepted order, which is the order the runtime took them in — and it is NOT the
  // insertion order the fixture used, because the ghosts were accepted later. Expected
  // from the timestamps this test itself seeded, so it fails if the query's `ORDER BY`
  // changes rather than merely restating the order it already produces.
  assert.deepEqual(
    acceptedOrder,
    [NOW, NOW + 1, NOW + 2, NOW + 3, NOW + 4, NOW + 100, NOW + 101, NOW + 102, NOW + 300],
    'the list is in accepted order, which is not the order the rows were inserted in',
  );
});

test('a narrowed page reports what it matched, not the whole session', async (t) => {
  const store = await seeded(t);
  const reply = await turns(store, { status: 'failed' });

  assert.equal(reply.matchedTurns, 2);
  assert.equal(reply.total, 9,
    'total stays the session\'s own count so a narrowed read is not mistaken for a whole one');
  assert.equal(reply.turns.length, 2);
  assert.ok(reply.turns.every((turn) => turn.status === 'failed'));
  // The bad-turn total is over the filter, because that is what the caller asked about.
  assert.equal(reply.failedOrAborted, 2);
});