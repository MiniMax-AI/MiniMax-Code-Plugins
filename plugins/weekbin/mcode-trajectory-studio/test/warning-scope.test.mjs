/**
 * `trajectory_list` published warnings that had nothing to do with it.
 *
 * `store.warnings` is a capped ring, and it is cumulative by design — the diagnostic
 * surfaces (`/api/meta` in the panel, `--doctor` on the command line) are supposed to
 * report everything that has gone wrong with this store since the process opened it.
 * `trajectory_list` published the same array, and its entry in the Skill says what it
 * means:
 *
 *   `warnings` | `trajectory_list` | reads that failed **while building this answer** …
 *
 * Which was not what it published. A `trajectory_find` that failed with
 * `event_find_failed:no such column` left its warning on the store, and the very next
 * `trajectory_list` — one that answered completely, `returned: 1, total: 1` — reported
 * that unrelated failure as its own.
 *
 * The cost is not the stray line. It is that **nothing ever clears them**: once any read
 * fails, every later list reply carries that warning, so a reply that is perfectly whole
 * keeps announcing a failure. The Skill's contract for this field is "a `0` in the same
 * answer means *not counted*, not *none*" — a signal only the reader of that answer can
 * use, and it stops meaning anything when it is attached to answers that failed nothing.
 *
 * Sliced from where the call started, the same contract holds: a warning on this reply
 * is a warning about this reply. The cumulative view is not lost — it is what
 * `/api/meta` and `--doctor` are for.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createFixtureProjection } from '../tools/fixture.mjs';
import { WARNINGS_MAX } from '../server/config.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';
import { createRequestHandler } from '../server/http.mjs';

const NOW = 1_700_000_000_000;
const FIXTURE_HOME = '/tmp/trajectory-warnscope-home';
const PORT = 4795;
const TOKEN = 'ws-token';

const studio = {
  start: async () => ({ url: 'http://127.0.0.1:1/', port: 1, reused: false }),
  stop: async () => true,
};

/** A healthy two-session store. */
async function healthy(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-warnscope-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'A', updatedAtMs: NOW });
  projection.session({ id: 'sess-b', title: 'B', updatedAtMs: NOW - 1 });
  projection.row({ sessionId: 'sess-a', msgId: 'm1', role: 'assistant', turnId: 't1', createdAtMs: NOW, data: {} });
  projection.close();
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  // Two teardowns, not one. `finish(store)` is the common case: this fixture's own store
  // is the handle to close. `remove()` is for the case where the caller has already handed
  // those handles to a shared hook and only the directory is left. A single function with
  // an optional store would have to invent a store to close when handed none, and
  // `store.close()` on `undefined` is a crash *inside teardown* — reported as a test
  // failure with nothing to do with what was being tested.
  return {
    dataDir,
    dbPath,
    finish: async (store) => {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
    remove: () => rm(dataDir, { recursive: true, force: true }),
  };
}

function makeRes() {
  return {
    status: null, headers: null, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); },
  };
}

async function metaOf(store) {
  const res = makeRes();
  const handler = createRequestHandler({
    store, homeDir: FIXTURE_HOME, getFocus: () => null, setFocus: () => {}, getToken: () => TOKEN,
  });
  await handler({
    method: 'GET', url: '/api/meta',
    headers: { host: `127.0.0.1:${PORT}`, 'x-trajectory-token': TOKEN },
    socket: { localPort: PORT, remoteAddress: '127.0.0.1' },
  }, res);
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body);
}

const call = (store, name, args) => createHandler({
  store, studio, homeDir: FIXTURE_HOME,
}).call(name, args);

test('a warning from an earlier call is not published by a later list', async (t) => {
  const { dataDir, dbPath, finish } = await healthy(t);
  // Break the message table so `trajectory_find` fails and records a warning. The
  // sessions table is untouched, so the list that follows answers completely.
  const db = new DatabaseSync(dbPath);
  db.exec('DROP TABLE local_runtime_message_rows');
  db.exec('CREATE TABLE local_runtime_message_rows (placeholder TEXT)');
  db.close();
  const store = openStore({ dataDir });
  t.after(() => finish(store));

  await call(store, 'trajectory_find', { sessionId: 'sess-a', query: 'anything' });
  const stored = store.warnings.length;
  assert.ok(stored > 0, 'the failing find recorded no warning, so this test would prove nothing');

  const list = await call(store, 'trajectory_list', { limit: 5 });
  assert.equal(list.returned, 2, 'the list did not answer completely, so the warning would be about it');
  assert.deepEqual(list.warnings, [],
    `a list that read nothing that failed published ${JSON.stringify(list.warnings)}`);
});

test('a warning this call does raise is published', async (t) => {
  const { dataDir, dbPath, finish } = await healthy(t);
  const store = openStore({ dataDir });
  t.after(() => finish(store));

  // Remove the column the agent-name list needs. `trajectory_list` reads it itself, so
  // the failure belongs to this answer and must be reported — a fix that silenced the
  // field entirely would pass the test above and lose the signal.
  const db = new DatabaseSync(dbPath);
  db.exec('ALTER TABLE local_runtime_sessions RENAME TO sessions_backup');
  db.exec('CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, updated_at_ms INTEGER)');
  db.exec(`INSERT INTO local_runtime_sessions SELECT session_id, updated_at_ms FROM sessions_backup`);
  db.exec('DROP TABLE sessions_backup');
  db.close();
  const broken = openStore({ dataDir });

  const list = await call(broken, 'trajectory_list', { limit: 5 });
  assert.ok(
    list.warnings.some((warning) => warning.startsWith('agent_list_failed:')),
    `a list whose own read failed published no warning: ${JSON.stringify(list.warnings)}`,
  );
  broken.close();
});

test('the drops counted here are this call\'s drops, not the ring\'s history', async (t) => {
  // The count and the list have to agree. Scoping the array but not the counter would
  // leave a reply saying it dropped three entries when it dropped one — and the number a
  // caller trusts more than the array is the one that explains the array.
  const { dataDir, dbPath, finish } = await healthy(t);

  // Make this call's own read fail, which appends one warning.
  const db = new DatabaseSync(dbPath);
  db.exec('ALTER TABLE local_runtime_sessions RENAME TO sessions_backup');
  db.exec('CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, updated_at_ms INTEGER)');
  db.exec(`INSERT INTO local_runtime_sessions SELECT session_id, updated_at_ms FROM sessions_backup`);
  db.exec('DROP TABLE sessions_backup');
  db.close();

  // Opened *after* the table was rebuilt and then filled — the ring belongs to the store
  // instance, so filling a different instance and calling this one tests nothing.
  const broken = openStore({ dataDir });
  t.after(() => finish(broken));
  for (let i = 0; i < WARNINGS_MAX + 3; i += 1) broken.warn(`earlier:${i}`);
  const droppedBefore = broken.warningsDropped;
  assert.ok(droppedBefore > 0, 'the ring did not overflow, so there is no drop to attribute');

  const list = await call(broken, 'trajectory_list', { limit: 5 });
  assert.equal(list.warnings.length, 1,
    `this call raised one warning and the reply carried ${list.warnings.length}`);
  assert.equal(list.warningsDropped, 1,
    `this call dropped one entry; the reply reported ${list.warningsDropped}`
    + ` (the store had already dropped ${droppedBefore} before it ran)`);
});

test('the task list scopes the ring exactly the way the session list does', async (t) => {
  // `trajectory_tasks` adopted the slicing idiom rather than inventing one, and the four
  // properties above were written while it was still the only tool that had it — so they
  // said nothing about this one. The tool that consumed them the longest was the one with
  // no coverage: it had no `warnings` key at all, and the `task_count_failed` the store
  // had been recording all along had no route to a model.
  //
  // All three assertions in one test because they are one mechanism seen from three
  // sides, and each mutation below breaks exactly one of them.
  const { dataDir, dbPath, finish } = await healthy(t);
  const store = openStore({ dataDir });
  // One hook, in one order. node:test runs `after` hooks in registration order, so
  // registering `finish(store)` here and `broken.close()` a few lines below meant the
  // directory was removed **while `broken` still had it open** — EBUSY on Windows, and
  // invisible on POSIX. The right order is the same in every test here, so it is written
  // once and the second `t.after` is never registered.
  const opened = [];
  // Both lists hold plain closures, not mixed shapes. An earlier version pushed
  // `{ finish }` for the first fixture and bare functions for the other two, and the loop
  // that walked them called `.finish()` — so the two bare functions had no such property
  // and the hook threw `fixture.finish is not a function`. That is the failure mode of a
  // list whose element type is only enforced by the line that consumes it.
  const removals = [() => finish(store)];
  t.after(async () => {
    // Every handle this test opened, then every directory it made — in that order, and
    // in one hook. The two lists are separate because a store holds a directory open and
    // a directory cannot be removed while it does: closing the last store and then
    // removing is the only order that works, and it is the same order in all four blocks
    // below.
    for (const extra of opened) extra.close();
    for (const remove of removals) await remove();
  });

  // 1. A warning this call raises is published.
  //    The table is present but carries no column the task count needs, so the query runs
  //    and throws rather than being skipped by the guard.
  const db = new DatabaseSync(dbPath);
  db.exec('DROP TABLE local_runtime_background_tasks');
  db.exec('CREATE TABLE local_runtime_background_tasks (placeholder TEXT)');
  db.close();
  const broken = openStore({ dataDir });
  opened.push(broken);
  const carried = await call(broken, 'trajectory_tasks', { sessionId: 'sess-a', limit: 5 });
  assert.ok(
    carried.warnings.some((warning) => warning.startsWith('task_count_failed:')),
    `the count failed and the task reply said nothing: ${JSON.stringify(carried.warnings)}`,
  );

  // 2. A warning from an earlier read is not published as this answer's omission.
  const healthy2 = await healthy(t);
  const clean = openStore({ dataDir: healthy2.dataDir });
  opened.push(clean);
  removals.push(() => healthy2.remove());
  clean.warn('earlier_read_failed:something this call did not ask about');
  const scoped = await call(clean, 'trajectory_tasks', { sessionId: 'sess-a', limit: 5 });
  assert.deepEqual(scoped.warnings, [],
    'the task reply presented an earlier read\'s warning as its own');
  assert.ok(!('warningsDropped' in scoped),
    'a drop that happened earlier was reported as this answer\'s omission');

  // 3. The count beside the array counts only this call's drops.
  //    The ring is filled *before* the call, so the store has already overflowed.
  const overflowed = await healthy(t);
  const busy = openStore({ dataDir: overflowed.dataDir });
  opened.push(busy);
  removals.push(() => overflowed.remove());
  for (let i = 0; i < WARNINGS_MAX + 3; i += 1) busy.warn(`earlier:${i}`);
  assert.ok(busy.warningsDropped > 0, 'the ring did not overflow, so there is no drop to attribute');
  const db3 = new DatabaseSync(overflowed.dbPath);
  db3.exec('DROP TABLE local_runtime_background_tasks');
  db3.exec('CREATE TABLE local_runtime_background_tasks (placeholder TEXT)');
  db3.close();
  const busy2 = openStore({ dataDir: overflowed.dataDir });
  opened.push(busy2);
  for (let i = 0; i < WARNINGS_MAX + 3; i += 1) busy2.warn(`earlier:${i}`);
  const counted = await call(busy2, 'trajectory_tasks', { sessionId: 'sess-a', limit: 5 });
  assert.equal(counted.warnings.length, 1,
    `this call raised one warning and the reply carried ${counted.warnings.length}`);
  assert.equal(counted.warningsDropped, 1,
    `this call dropped one entry; the reply reported ${counted.warningsDropped}`
    + ` (the store had already dropped ${busy2.warningsDropped - 1} before it ran)`);
});

test('the diagnostic surface still reports everything that has failed', async (t) => {
  const { dataDir, dbPath, finish } = await healthy(t);
  const db = new DatabaseSync(dbPath);
  db.exec('DROP TABLE local_runtime_message_rows');
  db.exec('CREATE TABLE local_runtime_message_rows (placeholder TEXT)');
  db.close();
  const store = openStore({ dataDir });
  t.after(() => finish(store));

  await call(store, 'trajectory_find', { sessionId: 'sess-a', query: 'anything' });
  const list = await call(store, 'trajectory_list', { limit: 5 });
  assert.deepEqual(list.warnings, [], 'the list scoped its own warnings');

  // Scoping the per-answer surface must not cost the cumulative one: that is what
  // `/api/meta` is for, and it is the only place a model can learn about a failure in a
  // read it never made.
  const meta = await metaOf(store);
  assert.ok(
    meta.warnings.some((warning) => warning.startsWith('event_find_failed:')),
    `/api/meta no longer reports the earlier failure: ${JSON.stringify(meta.warnings)}`,
  );
});