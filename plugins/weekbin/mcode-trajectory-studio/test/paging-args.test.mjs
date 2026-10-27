/**
 * The two paging conventions, and what happens when a caller mixes them up.
 *
 * `trajectory_list` and `trajectory_search` page by a pinned cursor; the other five page
 * by `offset` over an append-only key. The split is not tidiness — it is what the ordering
 * column demands, and the reasoning is on the Skill and in DESIGN — but it means a caller
 * moving between the two has two argument names to carry.
 *
 * Nothing validated the argument, so the mistake was answered with silence. Measured on a
 * real 445-turn session:
 *
 * - `trajectory_turns` with `cursor: 3` returned `returned: 5, nextOffset: 5, total: 445`
 *   and no note. That is page zero presented exactly like the page the caller asked for.
 * - `trajectory_list` with `offset: 3` is the worse direction: the reply has no `offset`
 *   field to contradict the request, so there is nothing in the answer to notice at all.
 *
 * A silently-ignored argument that returns the wrong page is the same failure as a
 * silently-ignored enum value — the caller cannot tell "I did what you asked" from "I did
 * what you asked and it made no difference". These drive the real `tools/call` envelope,
 * because the note is attached at the one point every reply passes through, and testing
 * the handler directly would test nothing.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createFixtureProjection, FIXTURE_HOME } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler, handleRpcEnvelope } from '../server/mcp.mjs';

const NOW = 1_700_000_000_000;

/**
 * A session with more than one page of turns, records and tasks in each direction, so
 * "page zero" and "the page you asked for" are different answers rather than the same one.
 */
async function seeded(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'paging-args-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-p', title: 'Paging', updatedAtMs: NOW });
  for (let i = 0; i < 12; i += 1) {
    projection.row({
      sessionId: 'sess-p',
      msgId: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      turnId: `turn-${i}`,
      createdAtMs: NOW + i,
      data: { msg_content: `record number ${i}` },
    });
  }
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const handler = createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] });
  // The envelope, not `handler.call`: the note is attached on the way out of the RPC
  // layer, so a direct handler call exercises none of it.
  return async (name, args) => {
    const reply = await handleRpcEnvelope(handler, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
    });
    assert.ok(reply.result, `the call did not return a result: ${JSON.stringify(reply.error)}`);
    return reply.result.structuredContent;
  };
}

test('a cursor handed to a tool that pages by offset is said to be ignored', async (t) => {
  const call = await seeded(t);
  for (const [name, page] of [
    ['trajectory_turns', 'turns'],
    ['trajectory_get', 'events'],
    ['trajectory_tasks', 'tasks'],
    ['trajectory_find', 'matches'],
  ]) {
    const args = { sessionId: 'sess-p', limit: 3, ...(name === 'trajectory_find' ? { query: 'record' } : {}), cursor: 3 };
    const wrong = await call(name, args);
    assert.match(wrong.note ?? '', /cursor you passed was ignored/,
      `${name} silently returned a page for a cursor it does not take`);
    assert.match(wrong.note ?? '', /first page/,
      `${name}'s note does not say which page this actually is`);
    // The note claiming "the first page" is worth nothing unless the reply is one.
    const first = await call(name, { ...args, cursor: undefined, offset: 0 });
    assert.deepEqual(wrong[page]?.map((r) => r.index ?? r.turnId ?? r.taskId),
      first[page]?.map((r) => r.index ?? r.turnId ?? r.taskId),
      `${name} claims to be the first page but is not the page offset 0 returns`);
  }
});

test('an offset handed to a tool that pages by cursor is said to be ignored', async (t) => {
  const call = await seeded(t);
  for (const name of ['trajectory_list', 'trajectory_search']) {
    const args = { limit: 3, offset: 3, ...(name === 'trajectory_search' ? { query: 'Paging' } : {}) };
    const wrong = await call(name, args);
    assert.match(wrong.note ?? '', /offset you passed was ignored/, `${name} silently ignored an offset`);
    const first = await call(name, { ...args, offset: undefined });
    assert.deepEqual(wrong.sessions?.map((s) => s.sessionId), first.sessions?.map((s) => s.sessionId),
      `${name} claims to be the first page but is not the page offset 0 returns`);
  }
});

test('the right key for the tool says nothing', async (t) => {
  // A note on every call is the same defect wearing the other hat: the caller learns to
  // skip it, and the one reply that needed it is skipped too.
  const call = await seeded(t);
  assert.equal((await call('trajectory_turns', { sessionId: 'sess-p', limit: 3, offset: 3 })).note, undefined);
  assert.equal((await call('trajectory_get', { sessionId: 'sess-p', limit: 3, offset: 3 })).note, undefined);
  assert.equal((await call('trajectory_tasks', { sessionId: 'sess-p', limit: 3, offset: 3 })).note, undefined);
  assert.equal((await call('trajectory_list', { limit: 3 })).note, undefined);
  // And an explicit `cursor: null` is the end-of-walk marker, not a paging attempt.
  assert.equal((await call('trajectory_list', { limit: 3, cursor: null })).note, undefined);
});

test('a second fact about the same reply does not overwrite the first', async (t) => {
  // `detailLevel` can already be wrong on the same call, and a caller who fixed one
  // argument and broke the other needs to hear about both.
  const call = await seeded(t);
  const note = (await call('trajectory_get', {
    sessionId: 'sess-p', limit: 3, cursor: 3, detailLevel: 'nope',
  })).note ?? '';
  assert.match(note, /detailLevel "nope" is not one of/, 'the level note is missing');
  assert.match(note, /cursor you passed was ignored/, 'the paging note is missing');
});

test('a reply that already failed is not told about paging', async (t) => {
  // A failed read has no page to be wrong about. Telling a caller their cursor was
  // ignored on a reply that carries an error describes a question nobody asked.
  //
  // The failure is forced rather than hoped for: the store is closed under the call, so
  // the read throws and the read path turns that into `source: 'error'`. An assertion
  // that can return early proves nothing, which is why this one asserts it got there.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'paging-args-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-p', title: 'Paging', updatedAtMs: NOW });
  projection.row({ sessionId: 'sess-p', msgId: 'm0', role: 'user', turnId: 't0', createdAtMs: NOW, data: { msg_content: 'x' } });
  projection.close();
  const store = openStore({ dataDir });
  // `store.close()` before the removal, not after and not at all. Every other fixture in
  // this file already did it in this order; this one registered the removal on its own,
  // which is invisible on POSIX (an open file can be unlinked) and EBUSY on Windows. The
  // handle the test drops the table through is closed a few lines below and is not the
  // one that matters — the store holds the same file open too.
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const handler = createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] });
  // The table goes, not the handle. A closed handle makes the whole call throw and the
  // envelope answers with an RPC error, which is a different path entirely; dropping the
  // table is what makes the query *inside* the read fail, and the read path is built to
  // catch exactly that and answer `source: 'error'` rather than propagating.
  const db = new DatabaseSync(path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  db.exec('DROP TABLE local_runtime_message_rows');
  db.close();
  const reply = await handleRpcEnvelope(handler, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'trajectory_get', arguments: { sessionId: 'sess-p', limit: 3, cursor: 3 },
    },
  });
  assert.ok(reply.result, `the read failed out of the envelope instead of answering: ${JSON.stringify(reply.error)}`);
  const body = reply.result.structuredContent;
  assert.ok(body.error, `the forced read failure did not happen — got ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(body.note, undefined, 'a failed reply gained a note about an argument');
});
