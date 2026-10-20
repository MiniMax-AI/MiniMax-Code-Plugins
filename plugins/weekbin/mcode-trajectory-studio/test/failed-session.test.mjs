/**
 * A session that failed does not say why.
 *
 * The session row carries `status` and `error_message`, and `sessionSummary` — the
 * mapper behind `trajectory_list`, `trajectory_search` and `/api/sessions` — publishes
 * both. `stats.mjs` republished **seven** fields off that same row and dropped the
 * eighth, so `trajectory_summary` answered "what happened to this run?" with
 * `status: 'error'` and nothing else.
 *
 * A status word is read as an answer, which makes it the worst shape this defect could
 * have taken. On the machine this was found on, 43 sessions carry an error and the
 * messages are specific enough to act on:
 *
 * ```
 * ENOSPC: no space left on device, write
 * Mandatory V2 Agent prompt is missing: _v2/coding/SYSTEM.md.hbs.
 * BYOK provider custom_provider:alibaba-cloud-model-studio upstream error:
 *   The value of the enable_thinking parameter is restricted to True.
 * Local runtime restarted before this turn completed.
 * ```
 *
 * The sessions that failed *first* are the worst case: one message row, `turns: 1`,
 * and the error text is the entire story — the fold reported a run that did one turn of
 * nothing, which is true and useless.
 *
 * Nothing tested this because the fixture had no `error_message` column at all. A
 * schema the fixture cannot produce is a path nothing can reach, and that is the same
 * mistake the fixture already documents for its `agent` helper.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureProjection } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';

const NOW = 1_700_000_000_000;
const FIXTURE_HOME = '/tmp/trajectory-failed-home';
const SECRET = 'sk-live-9f2b7c41d0e64a83';

/** One session, one message row, and whatever it failed with. */
async function seeded(t, { id = 'sess-f', status = 'error', errorMessage = null, rows = 1 } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-failed-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id, title: 'Failed run', updatedAtMs: NOW, status, errorMessage });
  for (let i = 0; i < rows; i += 1) {
    projection.row({
      sessionId: id, msgId: `m${i}`, role: i === 0 ? 'user' : 'assistant',
      turnId: 't1', createdAtMs: NOW + i, data: { msg_content: `record ${i}` },
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

const call = (store, name, args) =>
  createHandler({ store, studio: null, homeDir: FIXTURE_HOME }).call(name, args);

/* ------------------------------------------------------------ the defect itself -- */

test('a summary of a failed session says what it failed with', async (t) => {
  const store = await seeded(t, { errorMessage: 'ENOSPC: no space left on device, write' });
  const summary = await call(store, 'trajectory_summary', { sessionId: 'sess-f' });

  assert.equal(summary.status, 'error');
  assert.equal(summary.errorMessage, 'ENOSPC: no space left on device, write');
});

test('the summary and the list give the same account of the same failure', async (t) => {
  const store = await seeded(t, { errorMessage: 'Local runtime restarted before this turn completed.' });
  const summary = await call(store, 'trajectory_summary', { sessionId: 'sess-f' });
  const list = await call(store, 'trajectory_list', { limit: 50 });
  const row = list.sessions.find((s) => s.sessionId === 'sess-f');

  // The invariant, not the field. One session has one error message, and it is the same
  // message whichever tool is asked — the defect was two mappers of one row disagreeing
  // about what to keep, so the test has to compare them rather than check one of them.
  assert.ok(row, 'the list did not return the session at all');
  assert.equal(summary.errorMessage, row.errorMessage);
  assert.equal(summary.status, row.status);
});

/* ------------------------------------------------------------------ controls -- */

test('a session that did not fail carries no error field', async (t) => {
  const store = await seeded(t, { status: 'idle' });
  const summary = await call(store, 'trajectory_summary', { sessionId: 'sess-f' });

  // Absent rather than `null` or `''`. A field that is usually empty is a field every
  // reader has to learn to skip, and this Plugin's convention is that a disclosure
  // appears exactly when there is something to disclose.
  assert.ok(!('errorMessage' in summary),
    `an ordinary session published ${JSON.stringify(summary.errorMessage)}`);
});

test('an empty error text is not published as a message', async (t) => {
  // `error_message` is a nullable column, and the runtime writes '' as readily as
  // null. Publishing the empty string would give the field a third appearance — present,
  // saying nothing — which is the shape a reader cannot distinguish from a real one.
  const store = await seeded(t, { errorMessage: '' });
  const summary = await call(store, 'trajectory_summary', { sessionId: 'sess-f' });
  assert.ok(!('errorMessage' in summary), 'an empty error text was published');
});

/* ------------------------------------------------------------------- redaction -- */

test('the error message is swept for credentials before it leaves', async (t) => {
  // The mapper's own comment says a failed session's error text "routinely quotes the
  // command that failed", which is exactly how a key reaches an error string. Carrying
  // the field through the fold must not turn it into an egress the list never had —
  // and the list *does* sweep it, so a fold that skipped the sweep would be strictly
  // worse than the mapper it copies from.
  const store = await seeded(t, { errorMessage: `BYOK rejected key ${SECRET} for provider aliyun` });
  const summary = await call(store, 'trajectory_summary', { sessionId: 'sess-f' });

  assert.ok(summary.errorMessage.includes('BYOK rejected key'), 'the message was dropped whole');
  assert.equal(summary.errorMessage.includes(SECRET), false,
    `the credential survived into the summary: ${summary.errorMessage}`);
});