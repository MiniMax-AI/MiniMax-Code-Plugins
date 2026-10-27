/**
 * The progress view had no clock on it.
 *
 * `trajectory_turns` folds each turn into `{turnId, count, llmMs, outputTokens,
 * failureCount}`. The SQL behind it already computed `MIN(created_at_ms) AS first_ms` —
 * it is what the rows are *ordered by* — and the mapping step then dropped it. So a
 * caller could see that turn 40 came after turn 39 and could not say when either
 * happened.
 *
 * That is the whole of "progress" missing from the tool whose stated job is progress.
 * Dating one turn meant paging `trajectory_get` until a record carried a timestamp,
 * which on a session of thousands of records is paging the whole session. The machine
 * this was written against has a 451-turn session whose turn times now come back
 * directly.
 *
 * Both sources have to agree, because the module's invariant is that a caller cannot
 * tell the projection from the artifact from the record alone. The projection takes the
 * value from the row column; the artifact has to compute the same aggregate over
 * `message.timestamp`, which is the field its own event path already reads as
 * `createdAtMs`. One of the two dating itself and the other not is a difference nobody
 * can see — and it is the difference that makes one source look like it lost its timing.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureProjection } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';

const NOW = 1_700_000_000_000;
const FIXTURE_HOME = '/tmp/trajectory-turntime-home';

const call = (store, name, args) =>
  createHandler({ store, studio: null, homeDir: FIXTURE_HOME }).call(name, args);

/**
 * Three turns whose records are *not* in chronological order.
 *
 * The order matters: a fold that published the last record's time instead of the first
 * would still be monotonic here, and `ORDER BY first_ms` would still hold, so only a
 * session whose turns are written out of order can tell the two apart.
 */
async function seeded(t, { id = 'sess-t' } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-turntime-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id, title: 'Turned', updatedAtMs: NOW });
  const turns = [
    { id: 'turn-c', at: NOW + 3000 },
    { id: 'turn-a', at: NOW + 1000 },
    { id: 'turn-b', at: NOW + 2000 },
  ];
  for (const turn of turns) {
    for (let i = 0; i < 3; i += 1) {
      projection.row({
        sessionId: id,
        msgId: `${turn.id}-${i}`,
        role: i === 0 ? 'user' : 'assistant',
        turnId: turn.id,
        createdAtMs: turn.at + i,
        data: { msg_content: `${turn.id} record ${i}` },
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

/** The same three turns, on disk instead of in the projection. */
async function onDisk(t, { id = 'sess-t' } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-turntime-art-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id, title: 'Turned', updatedAtMs: NOW });
  projection.close();
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '20', `10-00-00-000-${id}`);
  await mkdir(dir, { recursive: true });
  const lines = [];
  for (const [turn, at] of [['turn-c', NOW + 3000], ['turn-a', NOW + 1000], ['turn-b', NOW + 2000]]) {
    for (let i = 0; i < 3; i += 1) {
      lines.push(JSON.stringify({
        message_id: `${turn}-${i}`,
        turn_id: turn,
        message: { role: i === 0 ? 'user' : 'assistant', timestamp: at + i, content: `${turn} record ${i}` },
      }));
    }
  }
  await writeFile(path.join(dir, 'messages.jsonl'), `${lines.join('\n')}\n`, 'utf8');
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/* ---------------------------------------------------------- the defect itself -- */

test('every turn says when it started', async (t) => {
  const store = await seeded(t);
  const reply = await call(store, 'trajectory_turns', { sessionId: 'sess-t', limit: 10 });

  assert.equal(reply.total, 3);
  for (const turn of reply.turns) {
    assert.equal(typeof turn.firstMs, 'number', `turn ${turn.turnId} has no start time`);
  }
  // The aggregate is the *first* record's time, not the last. `ORDER BY first_ms`
  // already depends on it being the first, so a fold that published the last would look
  // right on any session written in order — and this one is not.
  assert.deepEqual(reply.turns.map((turn) => turn.firstMs), [NOW + 1000, NOW + 2000, NOW + 3000]);
});

test('the times agree with the turn order', async (t) => {
  const store = await seeded(t);
  const reply = await call(store, 'trajectory_turns', { sessionId: 'sess-t', limit: 10 });
  const times = reply.turns.map((turn) => turn.firstMs);
  const sorted = [...times].sort((a, b) => a - b);

  // The rows were written c, a, b. If the times came out in write order the caller would
  // be handed a timeline that runs backwards, which is worse than no timeline.
  assert.deepEqual(times, sorted, 'the published order disagrees with the published times');
  assert.deepEqual(reply.turns.map((turn) => turn.turnId), ['turn-a', 'turn-b', 'turn-c']);
});

/* ----------------------------------------------- the two sources must agree -- */

test('a turn dated from the artifact carries the same kind of time', async (t) => {
  const store = await onDisk(t);
  const reply = await call(store, 'trajectory_turns', { sessionId: 'sess-t', limit: 10 });

  // The fixture has to have taken the artifact path, or this proves nothing.
  assert.equal(reply.source, 'jsonl', 'the fixture did not fall back to the artifact');
  assert.deepEqual(reply.turns.map((turn) => turn.firstMs), [NOW + 1000, NOW + 2000, NOW + 3000]);
  // Same instants as the projection fold over the same rows — the projection is built
  // from the artifact, so a disagreement here would mean one of the two is reading a
  // different field than the other.
  for (const turn of reply.turns) {
    assert.equal(turn.firstMs !== null, true, `artifact turn ${turn.turnId} has no time`);
    // And the timing fields stay null on this path: the artifact recorded no durations,
    // so a time without them is what this source can honestly offer.
    assert.equal(turn.llmMs, null);
  }
});

test('an artifact with no timestamps reports null, not zero', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-turntime-notime-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-n', title: 'No clock', updatedAtMs: NOW });
  projection.close();
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '20', `10-00-00-000-sess-n`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'messages.jsonl'), `${JSON.stringify({
    message_id: 'm1',
    turn_id: 'turn-x',
    message: { role: 'user', content: 'no timestamp on this one' },
  })}\n`, 'utf8');
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const reply = await call(store, 'trajectory_turns', { sessionId: 'sess-n', limit: 10 });
  assert.equal(reply.source, 'jsonl');
  assert.equal(reply.turns[0].firstMs, null,
    'a record with no timestamp came back as a real instant');
});

test('a turn with no time sorts last and keeps its place among the others', async (t) => {
  // Sorting by a value that is sometimes absent is where an order quietly stops being
  // an order. Two undated turns between two dated ones: they have to end up last, and
  // they have to keep the relative order they were written in, or the sort is not stable
  // and the same artifact answers differently on a different run.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-turntime-mixed-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-m', title: 'Mixed clocks', updatedAtMs: NOW });
  projection.close();
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '20', `10-00-00-000-sess-m`);
  await mkdir(dir, { recursive: true });
  const lines = [
    { turn_id: 'turn-undated-1', message: { role: 'user', content: 'one' } },
    { turn_id: 'turn-dated', message: { role: 'user', timestamp: NOW, content: 'two' } },
    { turn_id: 'turn-undated-2', message: { role: 'user', content: 'three' } },
  ].map((record, i) => JSON.stringify({ message_id: `m${i}`, ...record }));
  await writeFile(path.join(dir, 'messages.jsonl'), `${lines.join('\n')}\n`, 'utf8');
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const reply = await call(store, 'trajectory_turns', { sessionId: 'sess-m', limit: 10 });
  assert.deepEqual(reply.turns.map((turn) => turn.turnId),
    ['turn-dated', 'turn-undated-1', 'turn-undated-2']);
  assert.equal(reply.turns[0].firstMs, NOW);
  assert.equal(reply.turns[1].firstMs, null);
});