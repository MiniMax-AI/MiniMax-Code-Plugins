/**
 * A failed query that answers zero is a lie with a number on it.
 *
 * Five reads in this Plugin fall back to a zeroed result when their query throws:
 * the event count, the session's own row count, the background-task count, the
 * tool-call totals, and the agent-name list. Every one of those fallbacks was
 * indistinguishable from the real thing — and each is read as a *finding* rather
 * than an absence. `total: 0` says "this session matched nothing". `toolCalls: 0`
 * says "this run called no tools". `[]` agents says "this machine has no sub-agent
 * presets". A caller reporting any of those is confident, and wrong, and nothing in
 * the answer contradicts them: the empty page, the empty task list and the zeroed
 * count all agree with each other.
 *
 * The Plugin already had the right channel — `store.warn()`, surfaced on
 * `trajectory_list` as `warnings` with a `warningsDropped` count for the rest. These
 * sites simply were not using it. Each one now records what it could not count, and
 * the warning says plainly that the zero means "not counted".
 *
 * What is *not* asserted here: that every possible malformed projection is covered.
 * What is asserted is the property that makes the rest hold — a zero that a caller
 * could report as a finding is accompanied by a warning naming it.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createFixtureProjection, withProjectionDb } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';

const NOW = 1_700_000_000_000;

/**
 * A store whose named tables have been replaced by tables of the right name and
 * none of the right columns.
 *
 * Dropping a table would read as "this runtime has no such table"; recreating it
 * empty is the harder case, because the schema probe is satisfied, the store looks
 * healthy, and only the statement itself fails. That is the shape worth pinning.
 */
async function storeWithBrokenTables(t, tables) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'silent-degraded-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Broken', updatedAtMs: NOW });
  projection.row({ sessionId: 'sess-a', msgId: 'm1', role: 'assistant', turnId: 't1', createdAtMs: NOW, data: {} });
  projection.close();
  const db = new DatabaseSync(dbPath);
  for (const table of tables) {
    db.exec(`DROP TABLE ${table}`);
    db.exec(`CREATE TABLE ${table} (placeholder TEXT)`);
  }
  db.close();
  const store = openStore({ dataDir });
  // Close before removing: Windows refuses to unlink a file that is still open.
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/**
 * The warnings a read is answerable for, with one exclusion.
 *
 * `fts5_unavailable` is the store stating that this Node runtime's SQLite has no FTS5,
 * which is true and worth saying on Node 22.13.0–22.18.x and every 23.x. It is not a
 * warning *about the read under test*, and both cases below are about whether the store
 * stays honest about a read it could not complete — which is exactly the behaviour that
 * has to keep working on the runtimes where FTS5 is missing. Skipping them there would
 * trade coverage of the degraded path for coverage of the healthy one, on precisely the
 * runtimes that need the degraded path covered.
 *
 * Filtered rather than skipped, and named rather than filtered by position: a filter that
 * drops "the last warning" turns a passing run into a vacuous one the moment the store
 * reorders or adds one.
 */
function warningsAboutReads(store) {
  return store.warnings.filter((warning) => !warning.startsWith('fts5_unavailable:'));
}

test('a healthy projection records no warnings at all', async (t) => {
  // The control. Without it, a warning emitted on every read would satisfy every case
  // below while making the healthy answer wrong in the other direction.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'silent-degraded-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Healthy', updatedAtMs: NOW });
  projection.row({ sessionId: 'sess-a', msgId: 'm1', role: 'assistant', turnId: 't1', createdAtMs: NOW, data: {} });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  store.listAgents();
  store.countBackgroundTasks('sess-a');
  await store.getEvents({ sessionId: 'sess-a' });
  store.getStats('sess-a');
  assert.deepEqual(warningsAboutReads(store), [], 'a projection that answered everything still produced a warning');
  // Named, not merely excluded: the warning this drops is the store saying search is
  // unavailable, so on a runtime that genuinely lacks FTS5 it is the honest answer and
  // belongs in the list — it simply is not about the reads these cases exercise.
  assert.equal(
    store.warnings.length,
    store.hasFts ? 0 : 1,
    `expected ${store.hasFts ? 'no' : 'one FTS5'} warning(s) on this runtime, saw ${JSON.stringify(store.warnings)}`,
  );
});

test('a task count that could not run is recorded rather than returned as zero', async (t) => {
  const store = await storeWithBrokenTables(t, ['local_runtime_background_tasks']);
  const total = store.countBackgroundTasks('sess-a');
  assert.equal(total, 0, 'the fallback is still zero — that is the point of the warning');
  const aboutReads = warningsAboutReads(store);
  assert.equal(aboutReads.length, 1, 'a count that failed produced no warning at all');
  assert.match(aboutReads[0], /task count|could not be computed/iu);
});

test('an agent list that could not run is recorded rather than returned as empty', async (t) => {
  const store = await storeWithBrokenTables(t, ['local_runtime_sessions']);
  // `getSession` needs the sessions table, so this reads through the narrower entry
  // point — the same one the sidebar's filter is built from.
  assert.deepEqual(store.listAgents(), []);
  // There are two ways this fails — the column is absent, or the statement throws —
  // and they word themselves differently. The prefix is what both carry, so that is
  // what is asserted; the message after it is free to name its own cause.
  assert.ok(
    store.warnings.some((warning) => warning.startsWith('agent_list_failed:')),
    `a failed agent list produced no warning at all: ${JSON.stringify(store.warnings)}`,
  );
  assert.match(store.warnings.join(' '), /not counted/iu,
    'the warning does not say the empty list is unreliable');
});

test('a record count that could not run is recorded rather than returned as zero', async (t) => {
  const store = await storeWithBrokenTables(t, ['local_runtime_message_rows']);
  const page = await store.getEvents({ sessionId: 'sess-a' });
  assert.equal(page.total, 0);
  assert.ok(store.warnings.length > 0, 'a failed record count produced no warning at all');
  assert.match(store.warnings.join(' '), /count/iu);
});

test('a tool-call count that could not run is recorded rather than returned as zero', async (t) => {
  // `getStats` and `getEvents` reach the same broken table by different routes, and
  // each has its own counts to account for. The base aggregate already records
  // itself as `row_aggregate_failed`; the tool-call count beside it did not.
  const store = await storeWithBrokenTables(t, ['local_runtime_message_rows']);
  const stats = store.getStats('sess-a');
  assert.equal(stats.toolCalls, 0, 'the fallback is still zero — that is the point of the warning');
  assert.ok(
    store.warnings.some((warning) => warning.startsWith('tool_call_count_failed:')),
    `a failed tool-call count produced no warning: ${JSON.stringify(store.warnings)}`,
  );
});

test('the follow-up session-row count fails loudly, not as a silent zero', async (t) => {
  // `total` goes to zero first, which is what makes the session-wide count run at
  // all — so this second failure is reached *because of* the first one, and it lands
  // on a field the JSONL fallback consults to decide whether there is an artifact.
  const store = await storeWithBrokenTables(t, ['local_runtime_message_rows']);
  const page = await store.getEvents({ sessionId: 'sess-a' });
  assert.equal(page.sessionRows, 0);
  assert.ok(
    store.warnings.some((warning) => warning.startsWith('session_row_count_failed:')),
    `the session-row count failed silently: ${JSON.stringify(store.warnings)}`,
  );
});

/**
 * A projection that is *missing* the table, rather than one whose table is broken.
 *
 * The cases above all reach a query and watch it throw. This one never gets that far —
 * the reads guard on `tableExists` and return before preparing anything — so it was
 * outside the list this file was built from, and it produced the same answer: an empty
 * task list and a count of `0`, which is exactly what "this session dispatched nothing"
 * looks like. A caller reporting it would be confident and wrong.
 */
async function storeWithMissingTasksTable(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'silent-no-tasks-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'No tasks', updatedAtMs: NOW });
  projection.task({
    taskId: 'bg-present-before-drop', sessionId: 'sess-a', kind: 'bash', status: 'completed',
    createdAtMs: NOW, endedAtMs: NOW + 1, record: {},
  });
  projection.close();
  // Dropped outright, not recreated: this is the shape a projection from a runtime that
  // never wrote task rows has, and the guard the reads take is on the table's existence.
  const db = new DatabaseSync(dbPath);
  db.exec('DROP TABLE local_runtime_background_tasks');
  db.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

test('a projection with no task table says so, rather than reporting zero tasks', async (t) => {
  const store = await storeWithMissingTasksTable(t);
  assert.equal(store.hasTasks, false, 'the store still believes it can read tasks');

  const page = store.listBackgroundTasks('sess-a', { limit: 10 });
  assert.deepEqual(page, [], 'the guard does not return an empty list');
  assert.equal(store.countBackgroundTasks('sess-a'), 0);

  assert.ok(
    store.warnings.some((warning) => warning.startsWith('task_table_missing:')),
    `a runtime with no task table produced no warning: ${JSON.stringify(store.warnings)}`,
  );
  // Once, not once per read: the count and the list each hit the guard, and the ring is
  // capped, so a warning raised inside the guard would push out whatever else was there.
  assert.equal(
    store.warnings.filter((warning) => warning.startsWith('task_table_missing:')).length, 1,
    'the same install-level fact was recorded more than once',
  );
});

test('the task list tells a model the difference between "none ran" and "cannot say"', async (t) => {
  const store = await storeWithMissingTasksTable(t);
  const handler = createHandler({ store, homeDir: '/tmp/silent-degraded-home', redactRoots: [] });
  const reply = await handler.call('trajectory_tasks', { sessionId: 'sess-a', limit: 10 });

  // A capability rather than a count, and it has to be a field on the reply: the warning
  // is raised when the store opens, so a reply scoped to "what arrived while building
  // this answer" would filter it out — and the model would be back to reading `total: 0`.
  assert.equal(reply.tasksAvailable, false,
    'an unreadable task list is indistinguishable from a session that dispatched nothing');
  assert.equal(reply.total, 0);
  assert.deepEqual(reply.tasks, []);
  assert.ok('warnings' in reply,
    'this list tool has no `warnings` key, so a warning raised while answering it cannot reach a model');
});

test('a warning raised while answering this call is carried by its reply', async (t) => {
  // The other half of the slice, and the half `trajectory_tasks` never had at all: the
  // store already records `task_count_failed`, whose whole text is "total=0 means not
  // counted", but this reply had no `warnings` key — so the one warning this tool's
  // family can produce had no route to a model.
  //
  // The table is present and broken rather than absent, which is what makes the query run
  // and throw rather than be skipped by the guard.
  const store = await storeWithBrokenTables(t, ['local_runtime_background_tasks']);
  assert.equal(store.hasTasks, true, 'this case needs the table to be present');
  const handler = createHandler({ store, homeDir: '/tmp/silent-degraded-home', redactRoots: [] });
  const reply = await handler.call('trajectory_tasks', { sessionId: 'sess-a', limit: 10 });

  assert.ok(
    reply.warnings.some((warning) => warning.startsWith('task_count_failed:')),
    `the count failed and the reply did not say so: ${JSON.stringify(reply)}`,
  );
  assert.equal(reply.total, 0);
  assert.deepEqual(reply.tasks, []);
});

test('a warning raised before this call is not presented as this answer\'s', async (t) => {
  // `trajectory_tasks` is a new consumer of the ring-slicing idiom `trajectory_list` uses,
  // and nothing pinned it for this tool: a reply reporting the whole ring would satisfy
  // every other assertion in this file. A caller told "these rows were not counted"
  // because of something it did not ask has been handed a reason to distrust an answer
  // that may well be complete.
  //
  // The warning here was raised when the store opened — an install-level fact, and the
  // strongest case for it *not* to appear as this call's own omission. The reply is still
  // honest about the same fact, through the capability field rather than through a
  // warning, which is the split this file is really about.
  const store = await storeWithMissingTasksTable(t);
  assert.ok(
    store.warnings.some((warning) => warning.startsWith('task_table_missing:')),
    'the store opened without recording why it cannot read tasks',
  );

  const handler = createHandler({ store, homeDir: '/tmp/silent-degraded-home', redactRoots: [] });
  const reply = await handler.call('trajectory_tasks', { sessionId: 'sess-a', limit: 10 });
  assert.deepEqual(reply.warnings, [],
    'the task reply carried a warning raised before it was called');
  assert.ok(!('warningsDropped' in reply),
    'a drop that happened earlier was reported as this answer\'s omission');
  assert.equal(reply.tasksAvailable, false,
    'and with the warning filtered out, the capability field is what keeps the answer honest');
});

test('a session that really dispatched nothing is not given the capability caveat', async (t) => {
  // The control for the pair above: the same reply shape from a store that can read
  // tasks, so `tasksAvailable` cannot be read as a permanent property of this tool.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'silent-tasks-ok-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Quiet', updatedAtMs: NOW });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const handler = createHandler({ store, homeDir: '/tmp/silent-degraded-home', redactRoots: [] });
  const reply = await handler.call('trajectory_tasks', { sessionId: 'sess-a', limit: 10 });

  assert.equal(reply.tasksAvailable, true);
  assert.equal(reply.total, 0);
  assert.deepEqual(reply.warnings, [], 'a healthy read produced a warning to explain itself');
});

test('each warning says the zero is not a finding', async () => {
  // A bare "query failed" leaves the reader to work out whether the zero they are
  // looking at is trustworthy. The whole point of the warning is that it is not.
  for (const message of [
    'task_count_failed:the task count could not be computed, so total=0 means "not counted"',
    'event_count_failed:the record count could not be computed, so total=0 means "not counted"',
  ]) {
    assert.match(message, /not counted/iu, `the warning does not say the zero is unreliable: ${message}`);
  }
});

test('a session read that throws is not dressed up as "no such session"', async (t) => {
  // `getSession` returning null is how every surface says `session_not_found:<id>`,
  // and that code's advice is to re-read the list in case the id was mistyped. A
  // failed read produces the same null and the same advice, and following it would
  // not help — so the failure is recorded instead of being folded into the answer.
  const store = await storeWithBrokenTables(t, ['local_runtime_sessions']);
  assert.equal(store.getSession('sess-a'), null);
  assert.ok(
    store.warnings.some((warning) => warning.startsWith('session_read_failed:')),
    `a failed session read produced no warning: ${JSON.stringify(store.warnings)}`,
  );
});

test('children=[] is counted as "none ran" when the column is simply absent', async (t) => {
  // Not a malformed projection this time — a plainer one. Every other column is
  // intact, so the session reads fine and only the child lookup is unavailable.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'silent-degraded-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'No children column', updatedAtMs: NOW });
  projection.close();
  withProjectionDb(dbPath, (db) => db.exec('ALTER TABLE local_runtime_sessions DROP COLUMN parent_session_id'));
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const session = store.getSession('sess-a');
  assert.ok(session, 'the session itself should still read — only the child lookup is gone');
  assert.deepEqual(session.children, []);
  assert.ok(
    store.warnings.some((warning) => warning.startsWith('child_sessions_unavailable:')),
    `a missing child column produced no warning: ${JSON.stringify(store.warnings)}`,
  );
});
