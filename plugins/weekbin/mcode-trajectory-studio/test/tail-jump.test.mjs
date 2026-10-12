/**
 * The cheap way to the end of a long session.
 *
 * A large session holds tens of thousands of records and `trajectory_get` reads in
 * insert order, so "what happened at the end of this one?" looks like it costs one
 * page per thousand records — around twenty calls on the session this was written
 * against, each of which the model has to issue to reach an offset it could have
 * computed.
 *
 * It does not, because `trajectory_summary` already reports the session's record
 * count and it agrees exactly with `trajectory_get`'s `total`. So the last page is
 * one call: `offset: summary.events - limit`.
 *
 * That recipe is only as good as the agreement, so the agreement is what is pinned
 * here. If the two counts ever diverge the jump lands somewhere else entirely, and
 * nothing reports an error — the caller simply gets a page from the wrong place and
 * believes it is the tail. A silent wrong offset is worse than a missing feature,
 * which is why this is a test and not a paragraph.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureProjection, FIXTURE_HOME } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';

const NOW = 1_700_000_000_000;
const RECORDS = 60;

async function seeded(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tail-jump-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-tail', title: 'Long', updatedAtMs: NOW });
  for (let index = 0; index < RECORDS; index += 1) {
    projection.row({
      sessionId: 'sess-tail',
      msgId: `m${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      turnId: `t${Math.floor(index / 4)}`,
      createdAtMs: NOW + index,
      data: {},
    });
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

test('summary.events and get.total are the same number', async (t) => {
  // The whole recipe rests on this. They are computed by different code — one folds
  // the rows for statistics, the other counts them for a page — so nothing forces
  // them to agree except a test.
  const store = await seeded(t);
  const summary = await call(store, 'trajectory_summary', { sessionId: 'sess-tail' });
  const page = await call(store, 'trajectory_get', { sessionId: 'sess-tail', limit: 5 });
  assert.equal(summary.events, RECORDS);
  assert.equal(summary.events, page.total, 'the jump recipe would land on the wrong records');
});

test('the last page is one call, not one per thousand records', async (t) => {
  const store = await seeded(t);
  const summary = await call(store, 'trajectory_summary', { sessionId: 'sess-tail' });
  const limit = 5;
  const tail = await call(store, 'trajectory_get', {
    sessionId: 'sess-tail',
    offset: Math.max(0, summary.events - limit),
    limit,
  });
  assert.equal(tail.returned, limit);
  assert.equal(tail.nextOffset, null, 'the jump landed short of the end');
  // The last record of the session, by index, not merely "a record near the end".
  assert.equal(tail.events.at(-1).index, RECORDS - 1, 'the jump did not reach the final record');
  // And it agrees with the walk it replaces.
  const walked = [];
  for (let offset = 0; offset < RECORDS; offset += 10) {
    const page = await call(store, 'trajectory_get', { sessionId: 'sess-tail', offset, limit: 10 });
    walked.push(...page.events.map((event) => event.index));
  }
  assert.deepEqual(tail.events.map((e) => e.index), walked.slice(-limit),
    'the jump and the full walk disagree about the last records');
});

test('sessionTotal appears exactly when it disambiguates, and no wider', async (t) => {
  // Measured behaviour, and the shape the Skill documents: `sessionTotal` is the
  // session's own record count, and it is supplied *only* when the filter matched
  // nothing. That is the one case where "the session is empty" and "your filter is
  // wrong" are otherwise indistinguishable. It is deliberately not supplied on every
  // filtered read, because the extra COUNT would be paid on every page of every walk.
  // An earlier version of the Skill described it as arriving "under a turnId filter",
  // which promised it for the matching case and would have led a reader to read its
  // absence as meaningful.
  const store = await seeded(t);

  const unfiltered = await call(store, 'trajectory_get', { sessionId: 'sess-tail', limit: 5 });
  assert.equal(unfiltered.sessionTotal, undefined, 'an unfiltered read has no second total to distinguish');

  const matching = await call(store, 'trajectory_get', { sessionId: 'sess-tail', turnId: 't0', limit: 50 });
  assert.equal(matching.total, 4, 'the turn holds four records');
  assert.equal(matching.sessionTotal, undefined, 'a filter that matched did not need a second count');

  const empty = await call(store, 'trajectory_get', { sessionId: 'sess-tail', turnId: 'no-such-turn', limit: 50 });
  assert.equal(empty.total, 0);
  assert.equal(empty.sessionTotal, RECORDS,
    'a filter that matched nothing has to say the session itself is not empty');
});