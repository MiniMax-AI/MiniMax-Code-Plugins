/**
 * SKILL.md sent the model to a field that was never on the reply.
 *
 * The `agent` filter is documented as an **exact, case-sensitive** match, and the Skill's
 * remedy for guessing wrong is spelled out in the same breath:
 *
 *   `agent` is an **exact, case-sensitive** match against the agent names this
 *   machine actually used (`Explore` does not match a session stored as `explore`) —
 *   read `trajectory_list`'s `agents` list rather than guessing.
 *
 * `trajectory_list` had no `agents` key. The store computed the list — `listAgents()`
 * is one indexed `GROUP BY`, and the panel's sidebar filter is built from exactly this
 * call — but nothing on the MCP surface published it. So the remedy for the documented
 * trap was itself the trap: a model that followed the instruction looked for a field
 * that was not there, found nothing, and guessed an agent name anyway.
 *
 * This is the failure class the Skill's own contract test does not cover. That file
 * checks which tools are named, which completeness fields are listed in its table, which
 * error codes can still be produced, and which detail levels exist. All four are about
 * *names being present somewhere*. None of them asks the question a model asks, which is
 * whether the reply it just received actually carries the field the sentence points at.
 *
 * Scanned generically that question has false positives — input parameters share names
 * with reply fields (`sessionId`, `offset`), and most backticked tokens are prose. So the
 * case is pinned by name below rather than by a parser that would need a denylist to be
 * trustworthy. What is general is the assertion underneath: the list must be *derived*,
 * so it cannot drift into being a hand-written vocabulary.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createFixtureProjection } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NOW = 1_700_000_000_000;
const SKILL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills', 'mcode-trajectory-studio', 'SKILL.md',
);

const studio = {
  start: async () => ({ url: 'http://127.0.0.1:1/', port: 1, reused: false }),
  stop: async () => true,
};

/**
 * A machine whose agent names are the awkward ones: a capitalised one and one with a
 * dash. Both exist to make a guessed vocabulary visibly wrong — `mavis`/`explore`/`worker`
 * would pass under any implementation, so a test built on them proves nothing.
 */
async function machine(t, agents) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-agents-'));
  const projection = await createFixtureProjection(dataDir);
  agents.forEach((name, index) => {
    for (let i = 0; i <= index; i += 1) {
      projection.session({ id: `sess-${name}-${i}`, title: `${name} ${i}`, agent: name, updatedAtMs: NOW + i });
    }
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { store, dataDir };
}

async function callTool(store, name, args) {
  const handler = createHandler({ store, studio, homeDir: '/tmp/trajectory-agents-home' });
  return handler.call(name, args);
}

test('trajectory_list carries the agent names its filter is matched against', async (t) => {
  const { store } = await machine(t, ['Explore', 'code-review']);
  const reply = await callTool(store, 'trajectory_list', { limit: 5 });

  /** The sentence in SKILL.md that names this field. `\s+` rather than a space: the
 * sentence is wrapped mid-clause, so "read" and the list are on different lines. */
assert.match(
    readFileSync(SKILL_PATH, 'utf8'),
    /the `agents` list on `trajectory_list`'s reply/,
    'the Skill no longer tells the model to read this list, so this test would be guarding a sentence that is gone',
  );
  assert.ok('agents' in reply, `the reply has no agents list; keys: ${Object.keys(reply).join(', ')}`);
  assert.deepEqual(
    reply.agents.map((agent) => agent.name).sort(),
    ['Explore', 'code-review'],
    'the list is not the agent names this machine actually used',
  );
});

/**
 * A machine where the three ways a session can be out of scope are all populated, so a
 * count that ignores any of them disagrees with the `total` beside it.
 *
 * Deliberately not the awkward-name machine above: these cases are about *which rows
 * count*, and a name that needs quoting or case-matching only adds a second way for a
 * test to be wrong about.
 *
 *   live-owner  2 live + 1 archived        counted 2 by default, 3 when asked
 *   gone-owner  0 live + 2 archived        absent by default, counted 2 when asked
 *   hidden-only 0 live + 1 hidden          counted under neither scope
 */
async function scopedMachine(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-agents-'));
  const projection = await createFixtureProjection(dataDir);
  let at = 0;
  const add = (id, agent, flags) => {
    at += 1;
    projection.session({ id, title: id, agent, updatedAtMs: NOW + at, ...flags });
  };
  add('live-1', 'live-owner', {});
  add('live-2', 'live-owner', {});
  add('live-archived', 'live-owner', { archived: 1 });
  add('gone-1', 'gone-owner', { archived: 1 });
  add('gone-2', 'gone-owner', { archived: 1 });
  add('hidden-1', 'hidden-only', { visibility: 'hidden' });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { store };
}

const countOf = (reply, name) => reply.agents.find((agent) => agent.name === name)?.count;

/**
 * The invariant the defect broke, stated once so every case below checks the same
 * thing: a name's published count is the number of sessions filtering on that name
 * returns. Both sides are read from the store through the same two methods the reply
 * and the list read from — never derived here, because a hand-written expectation for a
 * grouped count is how a test ends up asserting the implementation instead of the
 * agreement.
 *
 * `includeArchived` is passed rather than read off the reply on purpose: the reply does
 * not echo the scope it ran under, so reading it back is not possible, and reaching for
 * a field that is not there compares a count against a different population and calls
 * the disagreement something else.
 */
function assertCountsMatchTheList(store, reply, { includeArchived = false } = {}) {
  for (const agent of reply.agents) {
    assert.equal(
      agent.count,
      store.countSessions({ agent: agent.name, includeArchived }),
      `\`${agent.name}\` is published as ${agent.count}, and filtering on it returns a different number`,
    );
  }
}

test('a published count is the number of sessions filtering on that name returns', async (t) => {
  const { store } = await scopedMachine(t);
  const reply = await callTool(store, 'trajectory_list', { limit: 10 });

  // The panel's filter menu prints these counts verbatim — `mavis (183)` — next to the
  // list they claim to size, and then applies the name as a filter. Measured on a real
  // install before the fix: the menu said 183, the list's own `total` said 172, and
  // selecting it returned 172. Nineteen archived sessions, both numbers in one reply.
  assertCountsMatchTheList(store, reply);
  assert.equal(
    reply.agents.reduce((n, agent) => n + agent.count, 0),
    reply.total,
    'the counts and the total beside them describe different populations',
  );
});

test('archived sessions are out of scope by default and in scope when asked for', async (t) => {
  const { store } = await scopedMachine(t);

  const live = await callTool(store, 'trajectory_list', { limit: 10 });
  assert.equal(countOf(live, 'live-owner'), 2, 'an archived session was counted as if it were live');
  assert.equal(live.total, 2, 'the two live sessions are the whole live population');

  const all = await callTool(store, 'trajectory_list', { limit: 10, includeArchived: true });
  assert.equal(countOf(all, 'live-owner'), 3, 'includeArchived did not reach the counts');
  assert.equal(all.total, 5, 'includeArchived did not reach the total, so the two now disagree the other way');
  assertCountsMatchTheList(store, all, { includeArchived: true });
});

test('a name owned only by archived sessions is absent by default and returns on request', async (t) => {
  const { store } = await scopedMachine(t);

  // The deliberate trade: the vocabulary stays broad enough to catch a filter value that
  // matched nothing, but it does not advertise sessions the caller cannot see. A name
  // that exists only under `includeArchived` is exactly one this call cannot use, so
  // listing it by default would be a menu entry that always returns an empty page.
  const live = await callTool(store, 'trajectory_list', { limit: 10 });
  assert.equal(countOf(live, 'gone-owner'), undefined, 'a name with no live sessions is being offered as a filter');

  const all = await callTool(store, 'trajectory_list', { limit: 10, includeArchived: true });
  assert.equal(countOf(all, 'gone-owner'), 2, 'the scope that can actually filter on this name does not offer it');
});

test('a hidden session is counted under neither scope', async (t) => {
  const { store } = await scopedMachine(t);

  // `visibility` is a separate condition from `archived` in `sessionFilter`, and not one
  // `includeArchived` opens. If it were ever folded in, this name would appear in the
  // archived-inclusive reply — offering a filter value whose sessions stay unreachable.
  for (const args of [{ limit: 10 }, { limit: 10, includeArchived: true }]) {
    const reply = await callTool(store, 'trajectory_list', args);
    assert.equal(countOf(reply, 'hidden-only'), undefined, `hidden sessions counted with ${JSON.stringify(args)}`);
    assert.equal(reply.total, args.includeArchived ? 5 : 2, 'a hidden session reached the total');
  }
});

test('a string "false" is not a request for archived sessions', async (t) => {
  const { store } = await scopedMachine(t);
  // Nothing validates `tools/call` arguments, so a model that read the schema loosely can
  // send the string. `Boolean("false")` is `true`, and it reaches both counts and total
  // now — so this pins the shared coercion rather than one call site's.
  const reply = await callTool(store, 'trajectory_list', { limit: 10, includeArchived: 'false' });
  assert.equal(countOf(reply, 'live-owner'), 2, 'a string "false" opened the archived population');
  assert.equal(reply.total, 2);
});

test('the panel route sizes its menu from the same scope the list route filters by', async (t) => {
  const { store } = await scopedMachine(t);
  const { createRequestHandler } = await import('../server/http.mjs');
  const TOKEN = 'test-token';
  const ask = async (url) => {
    const res = {
      statusCode: 200, headers: {}, body: '', ended: false,
      writeHead(code) { this.statusCode = code; },
      setHeader() {}, end(chunk) { this.body = chunk ?? ''; this.ended = true; },
    };
    await createRequestHandler({
      store, homeDir: '/tmp/trajectory-agents-home', getFocus: () => null, setFocus: () => {}, getToken: () => TOKEN,
    })({
      method: 'GET', url, headers: { host: '127.0.0.1:1', 'x-trajectory-token': TOKEN }, socket: { localPort: 1, remoteAddress: '127.0.0.1' },
    }, res);
    return JSON.parse(res.body);
  };

  assert.equal(
    (await ask('/api/agents')).agents.find((a) => a.name === 'live-owner')?.count,
    2,
    'the menu option is not sized like the list it filters',
  );
  assert.equal(
    (await ask('/api/agents?includeArchived=1')).agents.find((a) => a.name === 'live-owner')?.count,
    3,
    '/api/sessions honours includeArchived and /api/agents ignored it, so the two routes size one list differently',
  );
});

test('the list is derived from the data, not written down anywhere', async (t) => {
  const { store } = await machine(t, ['Explore', 'code-review']);
  const reply = await callTool(store, 'trajectory_list', { limit: 5 });

  // Derived, not a literal: a hard-coded vocabulary would satisfy the test above and
  // still send the model to an agent name this machine has never used.
  assert.deepEqual(
    reply.agents.map((agent) => ({ ...agent })).sort((a, b) => a.name.localeCompare(b.name)),
    store.listAgents().map((agent) => ({ ...agent })).sort((a, b) => a.name.localeCompare(b.name)),
    'the published list disagrees with the store it claims to describe',
  );
});

test('the counts on it are counts, so an absent agent is a visible absence', async (t) => {
  const { store } = await machine(t, ['Explore', 'code-review']);
  const reply = await callTool(store, 'trajectory_list', { limit: 5 });

  assert.equal(reply.agents.find((agent) => agent.name === 'Explore')?.count, 1);
  assert.equal(reply.agents.find((agent) => agent.name === 'code-review')?.count, 2);
});

test('the vocabulary is whole-machine even when the page is filtered', async (t) => {
  const { store } = await machine(t, ['Explore', 'code-review']);
  // Filtered to an agent that owns no session. The reply is an empty page — and the
  // caller still needs to know the filter value was wrong, which is the entire reason
  // the Skill sends the model here.
  const empty = await callTool(store, 'trajectory_list', { agent: 'verifier', limit: 5 });
  assert.equal(empty.returned, 0, 'the fixture agent owns no sessions');
  assert.deepEqual(
    empty.agents.map((agent) => agent.name).sort(),
    ['Explore', 'code-review'],
    'the vocabulary shrank to whatever the filter happened to return',
  );
});

test('a machine with no sub-agent presets gets an empty list, not a missing field', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-agents-'));
  const projection = await createFixtureProjection(dataDir);
  // `agent: null` rather than an omitted `agent`, because the fixture defaults it to
  // `mavis` — omitting it would have built a machine with one agent and made the
  // assertion below pass for the wrong reason.
  projection.session({ id: 'sess-solo', title: 'Solo', agent: null, updatedAtMs: NOW });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const reply = await callTool(store, 'trajectory_list', { limit: 5 });
  assert.equal(reply.returned, 1, 'the fixture session is not listed at all');
  assert.ok('agents' in reply, 'the field disappeared instead of answering "none"');
  assert.deepEqual(reply.agents, [], 'a machine with no agent names did not answer with an empty list');
});

test('a runtime that cannot list the names says so instead of reporting none', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-agents-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Broken', agent: 'mavis', updatedAtMs: NOW });
  projection.close();
  // Recreated rather than dropped: the schema probe is satisfied, the store looks
  // healthy, and only the statement fails — the harder case to notice.
  const db = new DatabaseSync(dbPath);
  db.exec('DROP TABLE local_runtime_sessions');
  db.exec('CREATE TABLE local_runtime_sessions (placeholder TEXT)');
  db.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const reply = await callTool(store, 'trajectory_list', { limit: 5 });
  assert.ok('agents' in reply, 'the field vanished rather than degrading');
  // `[]` is the honest shape here, so something else has to say why. Without the
  // warning this is "this machine dispatched nothing", which is a finding — and it is
  // false.
  assert.ok(
    reply.warnings.some((warning) => warning.startsWith('agent_list_failed:')),
    `an empty vocabulary arrived with no warning: ${JSON.stringify(reply.warnings)}`,
  );
});

test('a table that disappears under a live store says so too', async (t) => {
  // The other degradation path, and the one this file originally missed.
  //
  // `listAgents` bails in two places: a column it cannot see, and a query that throws.
  // The first is what a schema change looks like. The second is what a projection file
  // that was replaced or truncated while the process held it open looks like — the
  // schema probe already answered, so the store still believes the column is there and
  // the failure only appears at `prepare`. Pinning only the first leaves the second
  // reporting `agents: []` with nothing to say for it, which reads as "this machine
  // dispatched no sub-agents" — a finding, and an invented one.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-agents-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Gone', agent: 'mavis', updatedAtMs: NOW });
  projection.close();

  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // After the store cached its columns, and through a separate connection so the open
  // handle is not the thing being replaced.
  const second = new DatabaseSync(dbPath);
  second.exec('DROP TABLE local_runtime_sessions');
  second.close();

  assert.equal(
    store.has('sessions', 'agent_name'),
    true,
    'the store no longer believes the column exists, so this is not the path under test',
  );
  const reply = await callTool(store, 'trajectory_list', { limit: 5 });
  assert.deepEqual(reply.agents, [], 'the vocabulary is not empty on this path');
  assert.ok(
    reply.warnings.some((warning) => warning.startsWith('agent_list_failed:')),
    `a failing query produced no warning: ${JSON.stringify(reply.warnings)}`,
  );
});