/**
 * The one boolean on the MCP surface, and what a caller can send in its place.
 *
 * `tools/call` arguments reach the handler as whatever JSON the client sent. Nothing
 * between the wire and the handler checks them against the declared `inputSchema` —
 * the schema is documentation for the model, not an enforced gate. So a boolean
 * parameter can arrive as the string `"false"`, and `Boolean("false")` is `true`.
 *
 * For `includeArchived` that returned the **archived** sessions to a caller that had
 * asked for the opposite. The reply looked complete, `total` counted them, and nothing
 * said a flag had been read backwards — which is the worst shape a wrong answer can
 * have on an interface a model reads.
 *
 * These go through the real handler against a real projection rather than a stub,
 * because the defect is in what the arguments become, and a stub would answer whatever
 * the test was written to say.
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { toBoolean } from '../server/config.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';

const dirs = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A projection with one live and one archived session. */
async function storeWithArchive() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'archived-'));
  dirs.push(dataDir);
  await mkdir(path.join(dataDir, 'v2', 'sqlite'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  db.exec(`CREATE TABLE local_runtime_sessions (
    session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
    agent_name TEXT, session_type TEXT, status TEXT, archived INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'visible', session_kind TEXT NOT NULL DEFAULT 'unknown',
    parent_session_id TEXT, workspace_dir TEXT, title TEXT, created_at_ms INTEGER
  );`);
  const insert = db.prepare(`INSERT INTO local_runtime_sessions
    (session_id, record_json, updated_at_ms, agent_name, session_type, status, archived, title, created_at_ms)
    VALUES (?, '{}', ?, 'mavis', 'conversation', 'idle', ?, ?, 1)`);
  insert.run('s-live', 3000, 0, 'Live session');
  insert.run('s-arch', 2000, 1, 'Archived session');
  db.close();
  return openStore({ dataDir });
}

/* -------------------------------------------------------------- the coercion -- */

test('a boolean is read from every spelling a JSON client can send it in', () => {
  // The truthy direction `Boolean` already got right is kept, so this is not a fix
  // that trades one wrong answer for another.
  for (const value of [true, 1, 'true', 'TRUE', ' True ', 'yes', '1']) {
    assert.equal(toBoolean(value, false), true, `${JSON.stringify(value)} should be true`);
  }
  for (const value of [false, 0, 'false', 'FALSE', ' False ', 'no', '0', '']) {
    assert.equal(toBoolean(value, true), false, `${JSON.stringify(value)} should be false`);
  }
});

test('a token nobody defined falls back rather than being guessed at', () => {
  // The default is the safe answer, and it is passed in rather than assumed: an
  // unreadable flag must not silently become permission.
  assert.equal(toBoolean(undefined, false), false);
  assert.equal(toBoolean(undefined, true), true, 'a caller that defaults to true must still get true');
  assert.equal(toBoolean('maybe', false), false);
  assert.equal(toBoolean({}, false), false);
  assert.equal(toBoolean([], true), true);
});

/* ------------------------------------------------------- what the tool does -- */

test('a string "false" excludes archived sessions instead of including them', async (t) => {
  const store = await storeWithArchive();
  t.after(() => store.close());
  const call = (args) => createHandler({ store, homeDir: tmpdir(), redactRoots: [] })
    .call('trajectory_list', args);

  const asString = await call({ includeArchived: 'false' });
  assert.equal(asString.total, 1,
    'a string "false" read as "include archived" and returned the archived session');
  assert.deepEqual(asString.sessions.map((s) => s.sessionId), ['s-live']);

  // The control for the case above: a real boolean still works, in both directions.
  assert.equal((await call({ includeArchived: false })).total, 1);
  assert.equal((await call({ includeArchived: true })).total, 2);
  // And omitting it keeps the documented default.
  assert.equal((await call({})).total, 1);
});

test('the flag is the only thing that decides, so the counts cannot drift apart', async (t) => {
  const store = await storeWithArchive();
  t.after(() => store.close());
  const call = (args) => createHandler({ store, homeDir: tmpdir(), redactRoots: [] })
    .call('trajectory_list', args);

  for (const value of ['false', false, 'no', 0]) {
    const reply = await call({ includeArchived: value });
    assert.equal(reply.total, reply.sessions.length,
      `total and the delivered list disagree for ${JSON.stringify(value)}`);
    assert.ok(reply.sessions.every((s) => s.sessionId === 's-live'),
      `${JSON.stringify(value)} leaked an archived session`);
  }
  for (const value of ['true', true, 'yes', 1]) {
    const reply = await call({ includeArchived: value });
    assert.equal(reply.total, 2, `${JSON.stringify(value)} did not include archived sessions`);
  }
});

/* ------------------------------------------- a field that was published but not filterable -- */

/**
 * `sessionSummary` returns `parentSessionId`, so a model reading a session could see
 * that it dispatched sub-agent sessions and then have no call that would list them:
 * the filter did not exist, `parent_session_id` is not an FTS column, and the only
 * route was to page the whole machine and pick them out locally.
 *
 * Measured on this machine before the filter: four calls across all 614 sessions to
 * find the 292 children of `mvs_d91a302ec40c47e8…`, where one indexed query returns
 * the same 292.
 */
async function storeWithTree() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tree-'));
  dirs.push(dataDir);
  await mkdir(path.join(dataDir, 'v2', 'sqlite'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  db.exec(`CREATE TABLE local_runtime_sessions (
    session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
    agent_name TEXT, session_type TEXT, status TEXT, archived INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'visible', session_kind TEXT NOT NULL DEFAULT 'unknown',
    parent_session_id TEXT, workspace_dir TEXT, title TEXT, created_at_ms INTEGER
  );`);
  const insert = db.prepare(`INSERT INTO local_runtime_sessions
    (session_id, record_json, updated_at_ms, agent_name, session_type, status, archived,
     session_kind, parent_session_id, title, created_at_ms)
    VALUES (?, '{}', ?, ?, 'conversation', 'idle', 0, ?, ?, ?, 1)`);
  insert.run('s-root', 5000, 'mavis', 'conversation', null, 'Root session');
  insert.run('s-root2', 4900, 'mavis', 'conversation', null, 'Another root');
  for (let i = 0; i < 5; i += 1) {
    insert.run(`s-kid-${i}`, 4000 - i, 'worker', 'conversation', 's-root', `Child ${i}`);
  }
  insert.run('s-grandkid', 3800, 'worker', 'conversation', 's-kid-0', 'Grandchild');
  // Noise, so "the filter narrowed" is not the same as "the filter did nothing".
  for (let i = 0; i < 20; i += 1) {
    insert.run(`s-noise-${i}`, 3000 - i, 'mavis', 'conversation', null, `Noise ${i}`);
  }
  db.close();
  return openStore({ dataDir });
}

test('a parent session lists its sub-agent sessions directly', async (t) => {
  const store = await storeWithTree();
  t.after(() => store.close());
  const call = (args) => createHandler({ store, homeDir: tmpdir(), redactRoots: [] })
    .call('trajectory_list', args);

  const children = await call({ parentSessionId: 's-root', limit: 50 });
  assert.equal(children.total, 5, `expected 5 children, got ${children.total}`);
  assert.ok(children.sessions.every((s) => s.parentSessionId === 's-root'));
  assert.equal(children.sessions.length, 5, 'the count and the delivered rows disagree');

  // And it agrees with the only way there was before: read everything and pick.
  const all = await call({ limit: 200 });
  const byHand = all.sessions.filter((s) => s.parentSessionId === 's-root');
  assert.equal(byHand.length, children.total,
    'the filter and a full read disagree about how many children there are');
});

test('"root" means top-level sessions only', async (t) => {
  const store = await storeWithTree();
  t.after(() => store.close());
  const call = (args) => createHandler({ store, homeDir: tmpdir(), redactRoots: [] })
    .call('trajectory_list', args);

  const roots = await call({ parentSessionId: 'root', limit: 200 });
  assert.equal(roots.total, 22, 'the fixture has 2 named roots plus 20 noise rows');
  assert.ok(roots.sessions.every((s) => !s.parentSessionId),
    'a nested session came back from the root filter');
});

test('the two filters compose rather than replacing one another', async (t) => {
  // The composition is the point: "the explore sub-agents of this session" is one
  // call, not a filter followed by a local sweep.
  const store = await storeWithTree();
  t.after(() => store.close());
  const call = (args) => createHandler({ store, homeDir: tmpdir(), redactRoots: [] })
    .call('trajectory_list', args);

  const exploreKids = await call({ parentSessionId: 's-root', agent: 'explore', limit: 50 });
  assert.equal(exploreKids.total, 0, 'no child is an explore agent in the fixture');
  const workerKids = await call({ parentSessionId: 's-root', agent: 'worker', limit: 50 });
  assert.equal(workerKids.total, 5, 'the agent filter did not compose with the parent filter');
});

test('an unknown parent returns an empty page rather than the whole machine', async (t) => {
  // The failure shape worth pinning: a filter that does not match anything must not
  // degrade into "no filter", which is how a reader ends up believing an unrelated
  // page is the answer to their question.
  const store = await storeWithTree();
  t.after(() => store.close());
  const reply = await createHandler({ store, homeDir: tmpdir(), redactRoots: [] })
    .call('trajectory_list', { parentSessionId: 'no-such-parent', limit: 50 });
  assert.equal(reply.total, 0);
  assert.equal(reply.sessions.length, 0);
});

test('an empty parent id is not a filter', async (t) => {
  // `" "` trims to nothing; treating that as a filter would hide every child session
  // from a caller who passed a stray space.
  const store = await storeWithTree();
  t.after(() => store.close());
  const reply = await createHandler({ store, homeDir: tmpdir(), redactRoots: [] })
    .call('trajectory_list', { parentSessionId: '   ', limit: 200 });
  // 28 = 2 roots + 20 noise + 5 children + 1 grandchild. The grandchild being here
  // is the point: a blank id means "no filter", so nothing is hidden.
  assert.equal(reply.total, 28, 'a blank parent id silently filtered the list');
  assert.ok(reply.sessions.some((s) => s.sessionId === 's-grandkid'),
    'a blank parent id hid a nested session');
});
