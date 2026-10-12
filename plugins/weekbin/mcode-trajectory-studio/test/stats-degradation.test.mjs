/**
 * A failed count is not a count of zero.
 *
 * `trajectory_summary` computes three aggregates beside each other. When the query
 * behind one of them fails, two of them answered `null` and the third answered `0` —
 * and `0` is the shape a reader treats as a finding. A model handed
 * `subagentTasks: 0, backgroundTasks: 0` on a runtime whose background-task table is
 * absent will report that no sub-agents ran, with the same confidence it would use for
 * a session that genuinely ran none.
 *
 * The field that would have caught this, `warnings`, was a hardcoded `[]`. No code path
 * could ever put anything in it, and it reached the model as a clean bill of health —
 * so the degradation was both invisible and actively reassuring.
 *
 * These cases drive the failure two different ways, because the two are not the same
 * failure: a table the runtime does not have, and a table whose shape the query does
 * not fit. Both have to say so.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createFixtureProjection } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';

const NOW = 1_700_000_000_000;

/**
 * A store whose projection has been damaged in `damage`'s way.
 *
 * The store caches per-session stats, so the damage has to be in place before the
 * first read rather than between two of them.
 */
async function damagedStore(t, damage) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'stats-degraded-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Degraded', updatedAtMs: NOW });
  projection.row({ sessionId: 'sess-a', msgId: 'm1', role: 'assistant', turnId: 't1', createdAtMs: NOW, data: {} });
  projection.close();
  // Closed, not merely handed over. `damage(new DatabaseSync(dbPath))` reads as though the
  // handle is the callback's business, but the callback never owned it: the fixture did,
  // and nobody closes it. POSIX unlinks an open file so the leak is invisible there, and
  // Windows refuses — so every test in this file reported EBUSY at teardown while the code
  // under test was fine. `try/finally` rather than a plain call because a `damage` that
  // throws must not leak the handle either.
  const damaged = new DatabaseSync(dbPath);
  try {
    damage(damaged);
  } finally {
    damaged.close();
  }
  const store = openStore({ dataDir });
  // Close before removing: Windows refuses to unlink a file that is still open, so
  // registering the removal first passed on POSIX and failed elsewhere with EBUSY.
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

test('a healthy projection reports no warnings', async (t) => {
  // The control. Without it, a `warnings` array that is always non-empty would satisfy
  // every case below while making the healthy answer wrong in the other direction.
  const store = await damagedStore(t, () => {});
  const stats = store.getStats('sess-a');
  assert.deepEqual(stats.warnings, [], 'a projection that answered everything was still made to apologise');
  assert.equal(stats.toolMs, 0, 'an empty task table is a real answer, not a degradation');
  assert.equal(stats.subagentTasks, 0);
  assert.equal(stats.assets, 0);
});

test('a missing background-task table is reported instead of counted as zero', async (t) => {
  const store = await damagedStore(t, (db) => {
    db.exec('DROP TABLE local_runtime_background_tasks');
  });
  const stats = store.getStats('sess-a');
  assert.equal(stats.subagentTasks, 0);
  assert.equal(stats.backgroundTasks, 0);
  assert.equal(stats.toolMs, null, 'the duration was already honest; the counts were not');
  assert.ok(stats.warnings.length > 0, 'a runtime with no task table produced no warning at all');
  assert.match(stats.warnings.join(' '), /background task/i);
});

test('a background-task query that throws is reported, not swallowed', async (t) => {
  // Same symptom as above from the caller's side, different cause: the table is there,
  // so the schema probe passes and the failure only surfaces when the statement runs.
  const store = await damagedStore(t, (db) => {
    db.exec('DROP TABLE local_runtime_background_tasks');
    // Recreate it with the right name and none of the right columns, so `tableExists`
    // is satisfied and the projection of the column names fails instead.
    db.exec('CREATE TABLE local_runtime_background_tasks (owner_session_id TEXT)');
  });
  const stats = store.getStats('sess-a');
  assert.equal(stats.subagentTasks, 0);
  assert.ok(stats.warnings.length > 0, 'a failing task query produced no warning at all');
  assert.match(stats.warnings.join(' '), /background task/i);
});

test('a missing asset table is reported instead of counted as zero', async (t) => {
  const store = await damagedStore(t, (db) => {
    db.exec('DROP TABLE local_runtime_session_assets');
  });
  const stats = store.getStats('sess-a');
  assert.equal(stats.assets, 0);
  assert.ok(stats.warnings.length > 0, 'a runtime with no asset table produced no warning at all');
  assert.match(stats.warnings.join(' '), /asset/i);
});

test('the headline fold failing says so on the answer, not only in the session log', async (t) => {
  // `turns`, `steps` and the token totals all fall back to zero when the aggregate
  // query throws, and those are the numbers a reader quotes back as findings. The
  // session-level warning already existed, but it only reaches a caller who happens
  // to call `trajectory_list` — someone asking only for this summary would have been
  // told an empty session with nothing to contradict it.
  const store = await damagedStore(t, (db) => {
    db.exec('DROP TABLE local_runtime_message_rows');
    db.exec('CREATE TABLE local_runtime_message_rows (placeholder TEXT)');
  });
  const stats = store.getStats('sess-a');
  assert.equal(stats.turns, 0, 'the fallback is still zero — that is the point of the warning');
  assert.equal(stats.events, 0);
  assert.ok(
    stats.warnings.some((warning) => /turns, steps and token totals are unavailable/iu.test(warning)),
    `the failed fold is not on the answer: ${JSON.stringify(stats.warnings)}`,
  );
});

test('each degraded aggregate names itself rather than speaking for the other', async (t) => {
  // Both tables gone at once. One combined sentence would be read as covering both,
  // and a reader could not tell which number had stopped being real.
  const store = await damagedStore(t, (db) => {
    db.exec('DROP TABLE local_runtime_background_tasks');
    db.exec('DROP TABLE local_runtime_session_assets');
  });
  const stats = store.getStats('sess-a');
  assert.equal(stats.warnings.length, 2, 'two aggregates degraded, so there are two things to say');
  assert.match(stats.warnings[0], /background task/i);
  assert.match(stats.warnings[1], /asset/i);
});
