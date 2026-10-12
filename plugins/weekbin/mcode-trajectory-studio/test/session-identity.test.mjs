/**
 * A session id that names nothing must not read as a session that produced nothing.
 *
 * Every session-scoped tool used to resolve the id and then read from a table keyed
 * by it. A mistyped id — or one a model invented — therefore came back as the empty
 * list of a quiet session: `trajectory_find` reported `total: 0` for a session it had
 * never searched, `trajectory_turns` reported a run with no turns, `trajectory_get`
 * a session with no records. Each of those is a statement about the work, made
 * without having looked.
 *
 * The fix has to draw the line in exactly one place, because both sides of it are
 * real: a session the indexer has not reached yet legitimately has no SQLite row and
 * must still be readable from its own `messages.jsonl`. An existence check that only
 * knew about the projection would have turned every freshly-written session into an
 * error — which is why these tests pin the artifact case as loudly as the typo case.
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

/** The tools that take a session id and read something keyed by it. */
const SESSION_SCOPED = [
  ['trajectory_summary', {}],
  ['trajectory_turns', {}],
  ['trajectory_assets', {}],
  ['trajectory_agent', {}],
  ['trajectory_find', { query: 'needle' }],
  ['trajectory_get', {}],
  ['trajectory_tasks', {}],
];

const handler = (store) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] });

async function seeded(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'session-identity-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-real', title: 'Indexed', updatedAtMs: NOW });
  projection.row({
    sessionId: 'sess-real',
    msgId: 'm1',
    role: 'user',
    turnId: 't1',
    createdAtMs: NOW,
    data: { msg_id: 'm1', role: 'user', msg_type: 1, turn_id: 't1', msg_content: 'a needle in the projection' },
  });
  // A session the indexer has not reached: a directory and an artifact, and nothing
  // at all in SQLite. The id is part of the directory name because that is how the
  // reader finds it.
  //
  // The record shape is the artifact's own — `message_id` and a nested `message` —
  // not the projection row's `msg_id`/`msg_content`. Writing the projection shape
  // here folds into an event with a null role and zero content, which reads exactly
  // like a broken fold and is in fact a correctly-folded record that said nothing.
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '18', '10-00-00-000-sess-artifact-only');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'messages.jsonl'), `${JSON.stringify({
    message_id: 'a1', turn_id: 't1', message: { role: 'user', content: [{ type: 'text', text: 'a needle in the artifact' }] },
  })}\n`, 'utf8');
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { store, dataDir };
}

test('every session-scoped tool refuses an id that names nothing', async (t) => {
  const { store } = await seeded(t);
  for (const [tool, extra] of SESSION_SCOPED) {
    await assert.rejects(
      () => handler(store).call(tool, { sessionId: 'sess-does-not-exist', ...extra }),
      /session_not_found/iu,
      `${tool} answered an empty result for a session that does not exist`,
    );
  }
});

test('the refusal names the id that was asked for', async (t) => {
  // The caller passed one id and got another back? The error is the only place the
  // id can appear, and a model retrying needs to see which of its ids failed.
  const { store } = await seeded(t);
  await assert.rejects(
    () => handler(store).call('trajectory_find', { sessionId: 'sess-does-not-exist', query: 'needle' }),
    /sess-does-not-exist/u,
  );
});

test('an empty string is still a bad id, not "the latest session"', async (t) => {
  // The distinction `resolveSessionId` already draws, kept here because the guard
  // sits on top of it: an unfilled variable must not silently become a different
  // session.
  const { store } = await seeded(t);
  await assert.rejects(
    () => handler(store).call('trajectory_get', { sessionId: '   ' }),
    /session_not_found|unknown_session_id/iu,
  );
});

test('a session with no SQLite row is still served from its artifact', async (t) => {
  // The case an existence check gets wrong. `sess-artifact-only` has a directory and
  // a `messages.jsonl` and no row anywhere in the projection; refusing it would
  // break the fallback that exists for exactly the newest sessions.
  const { store } = await seeded(t);
  const reply = await handler(store).call('trajectory_get', { sessionId: 'sess-artifact-only' });
  assert.equal(reply.source, 'jsonl', 'the artifact session did not fall back');
  assert.equal(reply.events.length, 1, 'the artifact session came back empty');
  // `total` is null on this path by design — the fold stops at the page boundary
  // rather than counting the whole file — so the page length is the honest check.
  assert.equal(reply.total, null, 'the artifact path reported a full-file count it never paid for');
  assert.equal(reply.events[0].role, 'user', 'the artifact record did not fold');
  assert.equal(reply.nextOffset, null);
});

test('an artifact session is findable by content, not just by page', async (t) => {
  const { store } = await seeded(t);
  const reply = await handler(store).call('trajectory_find', { sessionId: 'sess-artifact-only', query: 'needle' });
  // `total` is null on the artifact path for the same reason it is on the page path:
  // the fold stops at the page boundary. The matches themselves are the answer.
  assert.equal(reply.matches.length, 1, 'the search did not reach the artifact');
  assert.equal(reply.source, 'jsonl');
  assert.equal(reply.total, null);
});

test('an existing but unindexed session says "not indexed", not "not found"', async (t) => {
  // The two errors have to stay distinguishable, because the recovery is opposite: a
  // mistyped id means go re-read the list, an unindexed session means come back later.
  // Reporting the second as the first sends the caller looking for a session that is
  // sitting in `trajectory_list` under the name it just used.
  const { store } = await seeded(t);
  await assert.rejects(
    () => handler(store).call('trajectory_summary', { sessionId: 'sess-artifact-only' }),
    (error) => {
      assert.match(error.message, /^session_not_indexed:sess-artifact-only$/u,
        `expected an unindexed-session error, got: ${error.message}`);
      return true;
    },
  );
  // And the contrast, so the pair cannot collapse into one code by accident.
  await assert.rejects(
    () => handler(store).call('trajectory_summary', { sessionId: 'sess-nope' }),
    /session_not_found:sess-nope(?!_)/u,
  );
});

test('a session in the projection answers normally', async (t) => {
  // The control: the guard must not turn a real session into an error, and must not
  // make the common call pay for the artifact probe.
  const { store } = await seeded(t);
  for (const [tool, extra] of SESSION_SCOPED) {
    const reply = await handler(store).call(tool, { sessionId: 'sess-real', ...extra });
    assert.ok(reply && typeof reply === 'object', `${tool} refused a session that exists`);
  }
});

test('the tools that are not session-scoped are unaffected', async (t) => {
  const { store } = await seeded(t);
  const studio = { start: async () => ({ url: 'http://127.0.0.1:1/#t=x', port: 1, reused: false }), stop: async () => true };
  // None of these take a session id, so a bogus one has nothing to be wrong about —
  // and a guard placed on them would have rejected valid calls.
  assert.ok(Array.isArray((await handler(store).call('trajectory_list', {})).sessions));
  assert.ok(Array.isArray((await handler(store).call('trajectory_search', { query: 'Indexed' })).sessions));
  await handler(store).call('trajectory_task_output', { taskId: 'no-such-task' });
  await createHandler({ store, studio, homeDir: FIXTURE_HOME }).call('trajectory_studio', { stop: true });
});