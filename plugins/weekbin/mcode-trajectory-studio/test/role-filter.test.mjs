/**
 * A role filter on `trajectory_get`, because the conversation is 2% of the records.
 *
 * The gap, measured rather than imagined. On the machine this was written against,
 * `local_runtime_message_rows.role` is `assistant` for 112,290 of **116,304** rows, `user`
 * for **2,388**, and null for 1,626. One real session — the one this was measured on —
 * held 5,272 assistant records and **9** user ones.
 *
 * That makes "what did this conversation actually ask for, and how far did it get" a
 * question about nine records sitting inside five thousand others. With no way to ask for
 * them, the only route was to walk the whole session and discard: measured on that same
 * session, **27 calls and 24.6 MiB of reply text** to surface nine messages.
 *
 * The cost is not merely high, it is decisive: 24.6 MiB of `full` detail is far past any
 * model's context, and `full` is precisely the detail level the Skill tells a model **not
 * to widen to on its own**. So the price of the privacy-safe path was that the question
 * could not be asked at all — the filter has to exist for the safe answer to be reachable.
 *
 * Three states, for the same reason `turnId` has three: `undefined` is no filter, a string
 * is that role, and `null` is the rows that carry **no** role — a real group of 1,626 on
 * that machine, and the one a caller holding a null role off a previous reply is asking
 * about. Collapsing `undefined` into `null` would answer "the records with no role" with
 * every record in the session.
 *
 * The filter has to hold on **both** sources. `trajectory_get` falls back to the session's
 * own `messages.jsonl` when the projection has no rows for it, and a filter honoured on the
 * projection and dropped on the artifact would answer the same question two ways depending
 * on whether the session happened to be indexed yet — the exact shape the `turnId` filter
 * was moved into place to prevent.
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

/**
 * A session whose roles are deliberately not one value each: two roles and a role-less
 * row, so a filter that returned "everything" and a filter that returned "the wrong
 * single role" are both distinguishable from the right answer.
 */
async function seeded(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'role-filter-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-r', title: 'Roles', updatedAtMs: NOW });
  for (let i = 0; i < 12; i += 1) {
    projection.row({
      sessionId: 'sess-r',
      msgId: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      turnId: `turn-${i}`,
      createdAtMs: NOW + i,
      data: { msg_content: `record number ${i}` },
    });
  }
  // One row carrying no role at all. `null` has to be its own answer.
  projection.row({
    sessionId: 'sess-r',
    msgId: 'm-roleless',
    role: null,
    turnId: null,
    createdAtMs: NOW + 99,
    data: { msg_content: 'the record with no role' },
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** A session whose records exist only as an artifact — the fallback path. */
async function artifactOnly(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'role-artifact-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-j', title: 'Artifact only', updatedAtMs: NOW });
  projection.close();
  const session = path.join(dataDir, 'sessions', '2026', '09', '20', '10-00-00-000-sess-j');
  await mkdir(session, { recursive: true });
  const lines = [];
  for (let i = 0; i < 9; i += 1) {
    lines.push(JSON.stringify({
      message_id: `j${i}`,
      turn_id: `jturn-${i}`,
      // The role lives inside `message`, on the same object the event is built from —
      // not at the top level of the line. A fixture that puts it at the top level is
      // testing a field no artifact carries.
      message: {
        role: i % 3 === 0 ? 'user' : 'assistant',
        timestamp: NOW + i,
        content: [{ type: 'text', text: `artifact record ${i}` }],
      },
    }));
  }
  lines.push(JSON.stringify({
    message_id: 'j-roleless',
    turn_id: null,
    message: { timestamp: NOW + 99, content: [{ type: 'text', text: 'no role here' }] },
  }));
  await writeFile(path.join(session, 'messages.jsonl'), `${lines.join('\n')}\n`, 'utf8');
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const call = (store, args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
  .call('trajectory_get', { sessionId: 'sess-r', detailLevel: 'full', ...args });

/* ------------------------------------------------------- the projection -- */

test('a role filter narrows the records and the count together', async (t) => {
  const store = await seeded(t);
  const all = await call(store, {});
  const users = await call(store, { role: 'user' });

  assert.ok(users.events.length > 0, 'the fixture has no user records to find');
  assert.ok(users.total < all.total, `the filter did not narrow: ${users.total} of ${all.total}`);
  // The count has to be the *filtered* count. `total` is what a caller compares against
  // what it walked, so leaving it unfiltered would report six delivered records out of a
  // `total` of thirteen and answer "you have seen everything" while three pages remain.
  assert.equal(users.total, users.events.length,
    'total must describe the filtered set, not the session');
  assert.ok(all.total > users.total, 'the unfiltered total must still be the whole session');
});

test('every returned record carries the role that was asked for', async (t) => {
  // This is the assertion an ignored filter cannot pass. `total` alone would survive a
  // filter that counted correctly and returned everything, and a list of the right length
  // would survive a filter that returned the wrong rows — only looking at the records
  // tells the two apart.
  const store = await seeded(t);
  for (const role of ['user', 'assistant']) {
    const reply = await call(store, { role });
    assert.ok(reply.events.length > 0, `the fixture has no ${role} records`);
    for (const event of reply.events) {
      assert.equal(event.role, role, `a ${role} filter returned a ${event.role} record`);
    }
  }
});

test('null asks for the records that carry no role', async (t) => {
  // A real group, not a hypothetical one: 1,626 rows on the machine this was measured on.
  // And the state that matters is that `null` does **not** mean "no filter" — that
  // collapse answers this question with every record in the session.
  const store = await seeded(t);
  const none = await call(store, { role: null });
  assert.ok(none.total > 0, 'the fixture has a role-less record and the filter did not find it');
  for (const event of none.events) {
    assert.equal(event.role, null, `a null filter returned a ${event.role} record`);
  }
  const all = await call(store, {});
  assert.ok(none.total < all.total, 'null answered with the whole session');
});

test('omitting the role is no filter at all', async (t) => {
  const store = await seeded(t);
  const omitted = await call(store, {});
  assert.equal(omitted.total, 13, 'the fixture holds thirteen records and the reply says otherwise');
  assert.ok(omitted.events.some((event) => event.role === 'user'));
  assert.ok(omitted.events.some((event) => event.role === 'assistant'));
  assert.ok(omitted.events.some((event) => event.role === null));
});

test('a cursor walk over a filtered page reaches every match exactly once', async (t) => {
  // The filter is worthless if the cursor does not walk the filtered set: a `nextOffset`
  // that counts session positions would step over the matches it was asked for, and one
  // that stops early would report a short list as the whole thing.
  const store = await seeded(t);
  const seen = new Set();
  let reply = await call(store, { role: 'user', limit: 2 });
  let guard = 0;
  while (guard++ < 20) {
    for (const event of reply.events) {
      assert.ok(!seen.has(event.index), `record ${event.index} was delivered twice`);
      seen.add(event.index);
    }
    if (reply.nextOffset === null || reply.nextOffset === undefined) break;
    const next = reply.nextOffset;
    if (next <= reply.offset) break;
    reply = await call(store, { role: 'user', limit: 2, offset: next });
    if (!reply.events.length) break;
  }
  const expected = (await call(store, { role: 'user', limit: 1000 })).total;
  assert.equal(seen.size, expected, `walked ${seen.size} of ${expected} user records`);
});

/* -------------------------------------------------------- the artifact -- */

test('the artifact fallback honours the same filter', async (t) => {
  // The defect this is here for: a filter honoured on the projection and dropped on
  // `messages.jsonl` answers the same question two ways depending on whether the session
  // happens to be indexed yet — and nothing in the reply would say which one ran.
  const store = await artifactOnly(t);
  const handler = createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] });

  const all = await handler.call('trajectory_get', { sessionId: 'sess-j', detailLevel: 'full' });
  assert.equal(all.source, 'jsonl', 'the fixture did not reach the artifact path');

  const users = await handler.call('trajectory_get', { sessionId: 'sess-j', detailLevel: 'full', role: 'user' });
  assert.ok(users.events.length > 0, 'the artifact holds user records and the filter found none');
  for (const event of users.events) {
    assert.equal(event.role, 'user', 'the artifact filter was dropped and a filtered walk returned everything');
  }
  assert.ok(users.events.length < all.events.length,
    `the artifact filter did not narrow: ${users.events.length} of ${all.events.length}`);

  const none = await handler.call('trajectory_get', { sessionId: 'sess-j', detailLevel: 'full', role: null });
  assert.ok(none.events.length > 0, 'null on the artifact returned nothing at all');
  for (const event of none.events) {
    assert.equal(event.role, null, 'a null filter on the artifact returned a record with a role');
  }
});