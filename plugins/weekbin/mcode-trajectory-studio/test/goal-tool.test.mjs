/**
 * The objective a session was kicked off with, and no route to it.
 *
 * `local_runtime_thread_goals` holds what the runtime recorded as the run's goal. On
 * the machine this was measured on it is 15 rows across 15 sessions — and that text is
 * the **only** copy: the FTS index does not carry it (`local_runtime_sessions_fts`
 * indexes session id, agent, title, workspace, purpose, status and type), and none of
 * those sessions has a `messages.jsonl` artifact. So "what was that run actually asked
 * to do" had no answer anywhere in the plugin, and `grep -rn thread_goals` over
 * `server/ web/ skills/ tools/` returned nothing at all.
 *
 * It is not a restatement of the title. Measuring vocabulary overlap between `objective`
 * and `title` over all 15 rows: **13 of 15 share almost nothing.** Real pairs:
 *
 * | title | objective |
 * |---|---|
 * | 同步本地与远程分支代码 | 继续深挖当前插件的方方面面可能存在的问题，持续优化迭代… |
 * | 查询项目前后端架构 | 整理并落地一套比较好的后续方案，可以很方便的集成更多的动画效果 |
 * | 排查项目部署缺少的组件 | 尽可能删除所有对这台远程机器的操作记录和访问记录 |
 *
 * A reader scanning history sees the title, concludes from it what the run was for, and
 * is wrong about two in three. Nothing on the page contradicts them — the title is a
 * real field of a real row.
 *
 * The tests pin the parts that make this usable rather than merely present: the absence
 * is reported as absence rather than an empty string, the objective is never silently
 * replaced by the title, and it is reachable by search — which it demonstrably was not.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createFixtureProjection, FIXTURE_HOME, FIXTURE_WORKSPACE, fixtureHasFts5, dropProjectionTable } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';

const NOW = 1_700_000_000_000;

// Real pairs, taken verbatim from the machine this was measured on. Using them rather
// than invented ones matters: an invented pair would share vocabulary, and the whole
// point is that these do not.
const REAL = {
  title: "同步本地与远程分支代码",
  objective: "继续深挖当前插件的方方面面可能存在的问题，持续优化迭代，确保所有已经存在的功能从各个角度都无问题，无跨操作系统的问题，无skill的调用坑，无死路径。另外你要注意 MCP 的相关功能，这个是直接给到模型的接口，对于找历史会话和找历史会话的进展和内容都非常有帮助的一个功能，不能存在什么实际问题。另外你还要检查，当前 MCP 的相关接口是否够用，易用性上是否还要拓展。",
};

async function seeded(t, { dropTable = false, goal = REAL.objective } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'goal-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-goal', title: REAL.title, updatedAtMs: NOW, workspaceDir: FIXTURE_WORKSPACE });
  projection.session({ id: 'sess-plain', title: 'Nothing recorded', updatedAtMs: NOW - 10_000, workspaceDir: FIXTURE_WORKSPACE });
  for (const id of ['sess-goal', 'sess-plain']) {
    for (let i = 0; i < 2; i += 1) {
      projection.row({
        sessionId: id, msgId: `${id}-m${i}`, role: i % 2 ? 'assistant' : 'user',
        turnId: `t${i}`, createdAtMs: NOW - 5000 + i,
        data: { role: i % 2 ? 'assistant' : 'user', content: 'working' },
      });
    }
  }
  projection.goal({
    sessionId: 'sess-goal', objective: goal, status: 'complete',
    createdAtMs: NOW - 6000, updatedAtMs: NOW - 1000,
    tokensUsed: 24_239_379, timeUsedSeconds: 36_102,
  });
  // The real table has one row per session, so only `sess-goal` has one. `sess-plain` is
  // the control: the shape is "most sessions have no goal", not "every session has one".
  projection.close();
  if (dropTable) dropProjectionTable(dbPath, 'local_runtime_thread_goals');
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const call = (store, tool, args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
  .call(tool, args);

/* ------------------------------------------------ the summary publishes it -- */

test('the summary publishes the objective the run was given', async (t) => {
  const store = await seeded(t);
  const reply = await call(store, 'trajectory_summary', { sessionId: 'sess-goal' });

  assert.equal(reply.objective, REAL.objective,
    'the objective must arrive verbatim, not summarised or folded into the title');
  assert.equal(reply.goalStatus, 'complete');
  assert.equal(reply.goalCreatedAtMs, NOW - 6000);
  assert.equal(reply.goalTokensUsed, 24_239_379,
    'what the goal cost is part of what it was');
  assert.equal(reply.goalTimeUsedSeconds, 36_102);
  // The control the whole feature exists to make possible: the title is still there,
  // and the objective says something the title does not.
  assert.equal(reply.title, REAL.title);
  assert.notEqual(reply.objective, reply.title);
});

test('a session with no recorded goal says so rather than showing the title again', async (t) => {
  // 618 of 633 sessions on the measured machine have no goal row at all, so this is the
  // common case and the one most likely to be got wrong. Falling back to the title is
  // the failure that matters: it would make a field that is usually absent look present,
  // and a reader would believe they had been told what the run was asked to do.
  const store = await seeded(t);
  const reply = await call(store, 'trajectory_summary', { sessionId: 'sess-plain' });

  assert.equal('objective' in reply, false,
    'absent is not the same as empty, and neither is the same as the title');
  assert.equal(reply.title, 'Nothing recorded', 'the control: the title is unaffected');
  assert.equal(reply.goalStatus, undefined);
});

test('a runtime without the table reports it instead of reading as "no goal"', async (t) => {
  // Same rule as every other capability here: "this runtime cannot tell" and "this
  // session had no goal" are both an absent field, and only one of them is a finding.
  // A `goalAvailable` flag is what separates them.
  const store = await seeded(t, { dropTable: true });
  const reply = await call(store, 'trajectory_summary', { sessionId: 'sess-goal' });

  assert.equal(reply.objective, undefined);
  assert.equal(reply.goalAvailable, false,
    'a missing table must be visible, or every reader concludes the run had no goal');
  assert.ok(Array.isArray(reply.warnings));
  assert.ok(reply.warnings.some((w) => String(w).includes('thread_goals')),
    `the warning must name the table: ${JSON.stringify(reply.warnings)}`);
});

test('the happy path does not claim a degraded reading', async (t) => {
  const store = await seeded(t);
  const reply = await call(store, 'trajectory_summary', { sessionId: 'sess-goal' });
  assert.equal(reply.goalAvailable, true);
  assert.deepEqual(reply.warnings, [],
    'a goal that was counted is not a degraded aggregate');
});

/* ------------------------------------------------------ search reaches it -- */

// The four cases below reach the index, so a runtime whose SQLite has no FTS5 cannot
// run them: they are skipped rather than failed, and the reason names FTS5 so the
// compatibility tool can tell this skip apart from any other. `compat-matrix` asserts
// exactly that — every skip on such a runtime must be an FTS5 skip — which is why the
// wording is not optional.
const NEEDS_FTS5 = fixtureHasFts5() ? false : 'this runtime has no FTS5';

test('a word from the objective finds the session its title never mentions', { skip: NEEDS_FTS5 }, async (t) => {
  // The gap with a cost. `local_runtime_sessions_fts` indexes the title, and none of
  // these 13 real objectives shares usable vocabulary with it — so on the measured
  // machine **0 of 15** goal-bearing sessions could be found by a word from their own
  // objective. A reader looking for a past run by what it was asked to do had to browse.
  const store = await seeded(t);
  // `插件` is in the objective and not in the title, workspace or agent.
  const reply = await call(store, 'trajectory_search', { query: '插件' });

  assert.equal(reply.ftsAvailable, true);
  assert.ok(reply.sessions.length >= 1,
    `the objective must be searchable: ${JSON.stringify(reply.sessions)}`);
  const hit = reply.sessions.find((row) => row.sessionId === 'sess-goal');
  assert.ok(hit, 'the goal-bearing session must be among the hits');
  assert.equal(hit.objective, REAL.objective,
    'the match must say which text matched, so the reader can tell why');
});

test('the search control: a session with no goal is still findable by its title', { skip: NEEDS_FTS5 }, async (t) => {
  // The index is additive. Without this, a change that indexed the objective could have
  // quietly narrowed the title search, and every existing test still passing.
  const store = await seeded(t);
  const byTitle = await call(store, 'trajectory_search', { query: 'Nothing' });
  assert.ok(byTitle.sessions.some((row) => row.sessionId === 'sess-plain'),
    'the title search must keep working');
  assert.equal(byTitle.sessions.find((row) => row.sessionId === 'sess-plain').objective, undefined,
    'a session with no goal must not acquire one from the index');
});

test('a runtime whose index never carried objectives says the goal was not searched', async (t) => {
  // A reader must be able to tell "no match" from "that field was not searched" — the
  // same distinction `ftsAvailable` already draws for the index as a whole.
  const store = await seeded(t);
  const reply = await call(store, 'trajectory_search', { query: '插件' });
  assert.equal(reply.objectivesIndexed, true,
    'this build does index objectives, so it must say so');
  assert.equal('objectiveMatched' in reply.sessions[0], true,
    'each row must say whether it matched on the objective or on its metadata');
});

test('a runtime without FTS5 still finds a run by what it was asked', { skip: fixtureHasFts5() ? false : 'this case simulates a runtime without FTS5 by dropping its index, so it needs one to drop' }, async (t) => {
  // The channel is a plain `LIKE` scan of a table — it never needed the index. Gating it
  // behind `hasFts` makes the strongest runtimes the only ones that can search a run by
  // its own brief, and on the machine this was measured on the brief is the only field
  // carrying the task at all. Node bundles SQLite without FTS5 on 22.13.0–22.18.x and
  // every 23.x, so "this machine" is not a hypothetical build.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'goal-nofts-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: REAL.title, updatedAtMs: NOW, workspaceDir: FIXTURE_WORKSPACE });
  projection.goal({ sessionId: 'sess-a', objective: REAL.objective, status: 'complete' });
  projection.close();
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  dropProjectionTable(dbPath, 'local_runtime_sessions_fts');
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  assert.equal(store.hasFts, false, 'this case needs a store that cannot search');
  const reply = store.searchSessions({ query: '插件' });
  assert.equal(reply.unsearchable, true,
    'the index is genuinely unavailable and must still say so');
  assert.equal(reply.objectivesIndexed, true,
    'the objective channel does not depend on the index, so it still ran');
  assert.deepEqual(reply.objectiveMatchedSessionIds, ['sess-a']);
  const hit = reply.sessions.find((row) => row.sessionId === 'sess-a');
  assert.ok(hit, 'the run must be found by its own brief');
  assert.equal(hit.objectiveMatched, true);
  assert.match(hit.objective, /持续优化迭代/u);
});

test('objective matches ride on the page without joining the walk count or cursor', { skip: NEEDS_FTS5 }, async (t) => {
  // Two contracts, one reason. `total` is the FTS match count and the cursor is an FTS
  // cursor; folding a second source into either makes the cursor's meaning depend on
  // which source happened to match, and makes `total` promise rows the walk cannot
  // deliver. Both are checkable without reading the implementation: the reply's own
  // numbers must add up without a second source folded in, and the control — a session
  // whose title *does* match — must be counted normally.
  const store = await seeded(t);
  // 'Nothing' is in `sess-plain`'s title; '插件' is only in `sess-goal`'s objective.
  const titleHit = await call(store, 'trajectory_search', { query: 'Nothing' });
  assert.ok(titleHit.total >= 1, 'the control: the index match is counted');
  assert.deepEqual(titleHit.objectiveMatchedSessionIds, [],
    'the control: a title match is not an objective match');

  const goalHit = await call(store, 'trajectory_search', { query: '插件' });
  assert.equal(goalHit.objectivesIndexed, true);
  assert.deepEqual(goalHit.objectiveMatchedSessionIds, ['sess-goal']);
  // One objective match, zero index matches — and `total` says zero. That is the whole
  // contract: the row is on the page because the objective channel found it, and `total`
  // is not pretending otherwise.
  assert.equal(goalHit.total, 0,
    'total counts index matches only, so the cursor walk stays an index walk');
  const onPage = goalHit.sessions.filter((row) => row.objectiveMatched);
  assert.equal(onPage.length, 1);
  assert.notEqual(goalHit.returned, goalHit.total,
    'the page can hold more rows than total counts, and both numbers are honest');
  assert.equal(goalHit.nextCursor, null,
    'a walk that never started has no cursor, whatever rode on the page');
});

test('the objective is swept like every other piece of user text', async (t) => {
  // The objective is the most free-form text this plugin publishes: it is whatever the
  // user typed to start the run, so it can hold a home path, a branch name, a pasted
  // snippet or a credential. The index path and the summary path both carry it, and a
  // sweep that reaches one but not the other would mean a reader's own machine layout
  // — or their own pasted key — travelling out through whichever surface was missed.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'goal-redact-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Alpha', updatedAtMs: NOW, workspaceDir: FIXTURE_WORKSPACE });
  projection.goal({
    sessionId: 'sess-a',
    // Two separate things in one string: a path rooted at **this machine's** home, which
    // the sweep must fold to `~`, and a credential, which it must remove. The user-written
    // `~/.ssh` spelling is deliberately not what is asserted on — that is their text, and
    // an assertion that no `~` appears would pass on a reply that published nothing.
    objective: `把 ${FIXTURE_HOME}/.ssh/id_rsa 收好，token 是 sk-proj-AAAABBBBCCCCDDDDEEEEFFFF`,
    status: 'complete', createdAtMs: NOW, updatedAtMs: NOW,
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  for (const [tool, args, pick] of [
    ['trajectory_summary', { sessionId: 'sess-a' }, (r) => r.objective],
    // `token` is in the objective and in no other field, so this row can only have been
    // found by the objective channel — a match on the index would make `NO ROW` and the
    // test would pass without the channel ever running.
    ['trajectory_search', { query: 'token' }, (r) => r.sessions.find((row) => row.objectiveMatched)?.objective ?? 'NO ROW'],
  ]) {
    const text = pick(await call(store, tool, args));
    assert.ok(typeof text === 'string' && text.length > 0,
      `${tool} must carry the objective at all: ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, /sk-proj-AAAABBBBCCCCDDDDEEEEFFFF/u,
      `${tool} published a credential verbatim`);
    assert.doesNotMatch(text, new RegExp(FIXTURE_HOME.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
      `${tool} published this machine's home directory unfolded`);
    // Both surfaces are checked by this loop and neither is allowed to be the one that
    // does the work. The first version asserted only that *something* swept the text, so
    // deleting either call site left the other to satisfy the assertion and the whole test
    // green — which is the mutation that proved it: removing the search-side sweep
    // survived. Each surface publishes the same text through a different call, and only
    // checking both can tell which one was skipped.
    assert.match(text, /\[redacted\]/u,
      `${tool} must show the sweep actually ran on this reply, not merely that the other surface swept`);
  }
});
