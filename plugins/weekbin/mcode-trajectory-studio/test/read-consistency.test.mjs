import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createFixtureProjection, FIXTURE_HOME } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';

/**
 * Every surface must agree about the same session.
 *
 * The four defects this file covers all had the same shape: one surface reported a
 * plain, confident, wrong answer while another reported the truth, and nothing said
 * they were in conflict. A reader saw "0 turns" beside 41 records, "no records" for
 * a session whose artifact was on disk, and "not in the projection" for a bad offset.
 * Nothing crashed; everything looked fine and was wrong.
 *
 * So the assertions here are cross-surface rather than per-function: the same session,
 * compared against itself. Each is a case where the earlier revision produced a
 * confident wrong answer, not an error.
 */

const NOW = 1_700_000_000_000;

/** A store with one session, seeded through the shared fixture. */
async function seed(t, rows, { artifact, withSqlite = true } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'consistency-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-c', title: 'Consistency', updatedAtMs: NOW });
  // A `raw` row carries a `data_json` the fixture cannot express — one that is not a
  // JSON document at all — so it is inserted directly and never through `row()`, which
  // would stringify it into a valid document and test nothing.
  for (const row of (rows ?? []).filter((entry) => entry.raw === undefined)) {
    projection.row({ sessionId: 'sess-c', ...row });
  }
  if (artifact) {
    const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '18', '10-00-00-000-sess-artifact');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'messages.jsonl'), artifact, 'utf8');
  }
  projection.close();
  if (rows?.some((row) => row.raw !== undefined)) {
    const db = new DatabaseSync(path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
    const insert = db.prepare(
      `INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json, source)
       VALUES (?, ?, ?, ?, ?, ?, 'api')`,
    );
    for (const row of rows.filter((entry) => entry.raw !== undefined)) {
      insert.run('sess-c', row.msgId ?? 'raw', 'assistant', row.turnId ?? 't1', NOW, row.raw);
    }
    db.close();
  }
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const studio = { start: async () => ({ url: 'http://127.0.0.1:1/#t=x', port: 1, reused: false }), stop: async () => true };
  return { dataDir, store, call: (name, args) => createHandler({ store, studio, homeDir: FIXTURE_HOME, redactRoots: [dataDir] }).call(name, args) };
}

const good = (i, turnId = `t${Math.floor(i / 2)}`) => ({
  msgId: `m${i}`, role: i % 2 ? 'assistant' : 'user', turnId, createdAtMs: NOW - i, source: 'api',
  data: {
    msg_id: `m${i}`, role: i % 2 ? 'assistant' : 'user', source: 'api', msg_type: 2,
    turn_id: turnId, msg_content: `row ${i}`,
  },
});

/* ------------------------------------------- one unreadable row, four surfaces -- */

test('an unreadable row costs itself, not the session', async (t) => {
  // `json_extract` raises on a row that is not a JSON document, and that error aborts
  // the whole statement. One row — which is what an interrupted write leaves behind —
  // took turns, events, token totals and the timeline to zero while the event list
  // went on listing every record.
  const { store } = await seed(t, [
    ...Array.from({ length: 8 }, (_, i) => good(i)),
    { msgId: 'truncated', raw: '{"msg_id":"truncated","role":' },
  ]);

  const page = store.getEvents({ sessionId: 'sess-c', limit: 50, detailLevel: 'summary' });
  const stats = store.getStats('sess-c');
  const turns = store.getTurnSummaries('sess-c');
  const { points } = store.getTimeline('sess-c');

  assert.equal(page.total, 9, 'the event list sees every row, including the unreadable one');
  assert.equal(stats.events, 9, 'the statistics must count the same rows the event list does');
  assert.equal(stats.turns, 4, 'the readable rows contribute their turns');
  assert.equal(turns.reduce((sum, turn) => sum + turn.count, 0), 9, 'the turn fold counts the same rows');
  assert.equal(points.length, 9, 'the timeline covers the same rows');
  assert.equal(stats.unreadableRows, 1, 'and it says how many rows it could not read');
  assert.ok(
    store.warnings.some((entry) => entry.startsWith('rows_unreadable:1')),
    'the excluded rows are reported rather than absorbed',
  );
});

test('a JSON document that is not an object is not an unreadable row', async (t) => {
  // `null`, `[1,2,3]` and `"text"` all parse; they simply have no fields. Counting them
  // as unreadable would report a session as damaged for ordinary content.
  const { store } = await seed(t, [
    good(0),
    { msgId: 'x1', raw: 'null' },
    { msgId: 'x2', raw: '[1,2,3]' },
    { msgId: 'x3', raw: '"a string"' },
  ]);
  const stats = store.getStats('sess-c');
  assert.equal(stats.events, 4);
  assert.equal(stats.unreadableRows, 0);
  assert.deepEqual(store.warnings, []);
});

/* ---------------------------------------------------- the artifact is reachable -- */

test('a session the projection has not indexed is read from its artifact', async (t) => {
  // The fallback guard was `source !== 'sqlite'`, and a live projection answers
  // `sqlite` for zero rows — so it never ran for the case it exists for.
  const artifact = [
    { message_id: 'a0', turn_id: 'tA', message: { role: 'user', content: [{ type: 'text', text: 'zero' }] } },
    { message_id: 'a1', turn_id: 'tB', message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] } },
  ].map((record) => `${JSON.stringify(record)}\n`).join('');
  const { call } = await seed(t, [], { artifact });

  const reply = await call('trajectory_get', { sessionId: 'sess-artifact', limit: 10 });
  assert.equal(reply.source, 'jsonl', 'the artifact was not consulted');
  assert.equal(reply.returned, 2);
  assert.deepEqual(reply.events.map((event) => event.msgId), ['a0', 'a1']);
});

test('a session with neither records nor an artifact still answers "no records"', async (t) => {
  // The fallback is adopted only when it actually holds something, so the projection
  // remains the authority on emptiness.
  const { call } = await seed(t, [good(0), good(1)], { artifact: undefined });
  const reply = await call('trajectory_get', { sessionId: 'sess-c', limit: 10 });
  assert.equal(reply.source, 'sqlite');
  assert.equal(reply.returned, 2);
});

test('a turn filter narrows the artifact as it narrows the projection', async (t) => {
  // The parameter was absent from the artifact's signature, so asking for one turn
  // returned every turn from that same session.
  const record = (id, turnId) => `${JSON.stringify({
    message_id: id, turn_id: turnId, message: { role: 'user', content: [] },
  })}\n`;
  const artifact = record('x0', 'tA') + record('x1', 'tB') + record('x2', 'tA');
  const { store, call } = await seed(t, [], { artifact });

  const reply = await call('trajectory_get', { sessionId: 'sess-artifact', turnId: 'tA', limit: 10 });
  assert.deepEqual(reply.events.map((event) => event.msgId), ['x0', 'x2']);

  const direct = await store.readJsonlEvents({ sessionId: 'sess-artifact', turnId: 'tA', limit: 10 });
  assert.equal(direct.events.length, 2, 'the store applies the filter too, not only the caller');
});

/* ------------------------------------------------------------- offset hygiene -- */

test('an offset that is not an integer is normalised, and the reply says what was read', async (t) => {
  // `OFFSET ?` binds a literal: a fractional or non-numeric offset raised
  // `datatype mismatch`, the read failed, and the page came back empty — reported as a
  // session "not in the projection". A float offset from a client that computes one by
  // division is ordinary, not hostile.
  const rows = Array.from({ length: 6 }, (_, i) => good(i));
  const { store, call } = await seed(t, rows);

  for (const [asked, expected, firstIndex] of [
    [2.5, 2, 2],
    ['3', 3, 3],
    [-10, 0, 0],
    ['abc', 0, 0],
    [undefined, 0, 0],
  ]) {
    const page = store.getEvents({ sessionId: 'sess-c', offset: asked, limit: 2, detailLevel: 'summary' });
    assert.equal(page.source, 'sqlite', `offset ${String(asked)} produced a failed read`);
    assert.equal(page.offset, expected, `offset ${String(asked)} was not normalised`);
    if (firstIndex < 6) assert.equal(page.events[0]?.index, firstIndex, `offset ${String(asked)} read the wrong record`);

    const reply = await call('trajectory_get', { sessionId: 'sess-c', offset: asked, limit: 2 });
    assert.equal(reply.source, 'sqlite');
    assert.equal(reply.offset, expected, 'the reply echoes the offset that was read, not the one asked for');
  }
});

test('a cursor handed back can always be fed straight back in', async (t) => {
  // The chained failure: a fractional offset produced a fractional `nextOffset`
  // (`offset + delivered`), and feeding that in raised `datatype mismatch`, so a
  // 400-record session stopped after 108 records with a null cursor.
  const rows = Array.from({ length: 40 }, (_, i) => good(i));
  const { call } = await seed(t, rows);

  const seen = [];
  let offset = 0;
  for (let page = 0; page < 20; page += 1) {
    const reply = await call('trajectory_get', { sessionId: 'sess-c', offset, limit: 7 });
    assert.ok(Number.isInteger(offset), `offset ${offset} is not an integer`);
    assert.ok(Number.isInteger(reply.nextOffset ?? 0), `cursor ${reply.nextOffset} is not an integer`);
    for (const event of reply.events) seen.push(event.index);
    if (reply.nextOffset === null) break;
    assert.ok(reply.nextOffset > offset, `the cursor did not advance: ${offset} -> ${reply.nextOffset}`);
    offset = reply.nextOffset;
  }
  assert.deepEqual(seen, rows.map((_, i) => i), 'paging skipped or repeated records');
});

test('an offset past the end is empty and terminates, never restarts', async (t) => {
  const { call } = await seed(t, Array.from({ length: 4 }, (_, i) => good(i)));
  const reply = await call('trajectory_get', { sessionId: 'sess-c', offset: 1e9, limit: 10 });
  assert.equal(reply.returned, 0);
  assert.equal(reply.nextOffset, null);
});

/* -------------------------------------------------- artifact shapes on disk -- */

test('an artifact keeps its last record when the file does not end in a newline', async (t) => {
  // The line loop only looked at lines a `\n` terminated, so the tail of a file
  // without a final newline went missing — silently, with no counter. That is the
  // shape an interrupted write leaves behind, and it is the most recent record in the
  // file: the one someone opens a session to find.
  const record = (i) => JSON.stringify({
    message_id: `r${i}`, turn_id: 't1', message: { role: 'user', content: [{ type: 'text', text: `row ${i}` }] },
  });
  const { store } = await seed(t, [], { artifact: `${record(0)}\n${record(1)}\n${record(2)}` });
  const page = await store.readJsonlEvents({ sessionId: 'sess-artifact', limit: 10 });
  assert.equal(page.events.length, 3, 'the unterminated last record was dropped');
  assert.deepEqual(page.events.map((event) => event.messageId ?? event.msgId), ['r0', 'r1', 'r2']);
});

test('a byte-order mark is file metadata, not part of the first record', async (t) => {
  // `JSON.parse` throws on a leading BOM, so the first record of every artifact a
  // Windows tool wrote disappeared, with nothing reported.
  const record = (i) => JSON.stringify({
    message_id: `r${i}`, turn_id: 't1', message: { role: 'user', content: [] },
  });
  const { store } = await seed(t, [], { artifact: `\uFEFF${record(0)}\n${record(1)}\n` });
  const page = await store.readJsonlEvents({ sessionId: 'sess-artifact', limit: 10 });
  assert.equal(page.events.length, 2, 'the first record was lost to the BOM');
});

test('an artifact with CRLF endings is read whole', async (t) => {
  const record = (i) => JSON.stringify({
    message_id: `r${i}`, turn_id: 't1', message: { role: 'user', content: [] },
  });
  const { store } = await seed(t, [], { artifact: `${record(0)}\r\n${record(1)}\r\n` });
  const page = await store.readJsonlEvents({ sessionId: 'sess-artifact', limit: 10 });
  assert.equal(page.events.length, 2);
});
