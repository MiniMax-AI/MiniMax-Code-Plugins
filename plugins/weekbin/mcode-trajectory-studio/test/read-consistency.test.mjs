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
async function seed(t, rows, { artifact, artifactSessionId = 'sess-artifact', withSqlite = true } = {}) {
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
    // The session id is part of the directory name, because that is how the reader
    // finds a session's directory. An artifact written for one session is invisible to
    // a read of another, which is the point of the guard it is used to test.
    const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '18', `10-00-00-000-${artifactSessionId}`);
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
  // Scoped to the warning this is about: a store opened on a runtime without FTS5
  // legitimately carries an `fts5_unavailable` warning, and asserting the list was
  // empty would make this fail on the Node floor for an unrelated reason.
  assert.deepEqual(
    store.warnings.filter((entry) => entry.startsWith('rows_unreadable:')),
    [],
    'ordinary content must not be reported as unreadable rows',
  );
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

/* ------------------------------------------------- work is bounded by bytes -- */

test('a page stops reading raw bytes rather than multiplying by limit', async (t) => {
  // `limit` bounds records and the response budget bounds the reply, and neither
  // bounds the work between them: a page of rows at the 8 MiB row ceiling is GiB of
  // `data_json` parsed into JavaScript and swept by the redaction regexes before the
  // budget that trims the reply ever runs. Measured on twenty 1 MiB records, 6.4 s of
  // sweeping for a 0.38 MB answer.
  const MB = 1024 * 1024;
  const { store } = await seed(t, []);
  const db = new DatabaseSync(path.join(store.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  const insert = db.prepare(
    `INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json, source)
     VALUES ('sess-c', ?, 'assistant', 't1', ?, ?, 'api')`,
  );
  const body = 'z'.repeat(MB);
  db.exec('BEGIN');
  for (let i = 0; i < 20; i += 1) {
    insert.run(`m${i}`, NOW - i, JSON.stringify({ msg_id: `m${i}`, role: 'assistant', source: 'api', msg_type: 2, turn_id: 't1', msg_content: body }));
  }
  db.exec('COMMIT');
  db.close();

  const page = store.getEvents({ sessionId: 'sess-c', limit: 20, detailLevel: 'full', pageBytes: 4 * MB });
  assert.equal(page.total, 20, 'the whole session still reports its size');
  assert.ok(page.events.length < 20, `every row was projected: ${page.events.length}`);
  assert.equal(page.pageBytesTruncated, true, 'and the page says it stopped early');
  assert.equal(page.nextOffset, page.events.length, 'the cursor resumes where the reply stopped');
  assert.ok(store.warnings.some((entry) => entry.startsWith('events_page_bytes:')));
});

test('the cursor from a byte-cut page still reaches every record', async (t) => {
  const { store } = await seed(t, Array.from({ length: 30 }, (_, i) => ({
    ...good(i),
    data: { ...good(i).data, msg_content: 'y'.repeat(4000) },
  })));
  const seen = [];
  let offset = 0;
  for (let page = 0; page < 20; page += 1) {
    const reply = store.getEvents({ sessionId: 'sess-c', offset, limit: 30, detailLevel: 'full', pageBytes: 16_000 });
    for (const event of reply.events) seen.push(event.index);
    if (reply.nextOffset === null) break;
    assert.ok(reply.nextOffset > offset, `the cursor stalled at ${offset}`);
    offset = reply.nextOffset;
  }
  assert.deepEqual(seen, Array.from({ length: 30 }, (_, i) => i), 'a byte-cut page lost records');
});

test('projection does not shorten a value the sweep still has to read', async (t) => {
  // This test used to put its canary past a projection-time clip and assert it was
  // gone — which it was, because it had been cut rather than redacted. It passed with
  // the redaction sweep deleted outright. The property worth pinning is the one that
  // was actually broken: a clip landing inside a quoted value deletes that value's
  // closing delimiter, and all three redaction layers fail open together.
  //
  // `redactJsonText` cannot parse the unterminated document, the escaped-document
  // rule needs its closing delimiter, and the key/value rule's unquoted branch
  // excludes `"`. A `read` result over 256 KiB carrying `api_key` inside a JSON
  // object is the runtime's normal storage shape, and the MCP surface is the one
  // egress whose output reaches a model.
  // The canary carries no token prefix on purpose. `ghp_…`, `sk-…` and friends are
  // matched by a shape rule that does not need the surrounding key/value structure,
  // so a prefixed canary is redacted even when the clip has destroyed that structure
  // — which is how the first version of this test passed against broken code.
  const SECRET = 'ZZCANARYZZ9f3a7c1e4b2d';
  const { store } = await seed(t, [{
    ...good(0),
    data: {
      ...good(0).data,
      msg_content: `{"api_key":"${SECRET}${'padding '.repeat(40000)}","note":"tail"}`,
    },
  }]);
  const page = store.getEvents({ sessionId: 'sess-c', limit: 1, detailLevel: 'full' });
  const { redactEvent } = await import('../server/redact.mjs');
  const swept = redactEvent(page.events[0], { maxLength: 20000, homeDir: FIXTURE_HOME, roots: [store.dataDir] });
  assert.ok(page.events[0].content.includes(SECRET), 'projection must not have removed the value — only redaction may');
  assert.equal(swept.content.includes(SECRET), false, 'the credential survived to the egress');
  assert.equal(swept.content.includes('[redacted]'), true, 'and it was redacted rather than merely cut');
});

test('the truncation marker counts the value the reader had, not a shortened copy', async (t) => {
  // While projection clipped first, the marker was computed from the clipped string:
  // a 500,000-char value was reported as "truncated 242144 chars" when 480,000 had
  // gone. A count that is wrong by 4x reads as a measurement.
  const SIZE = 500_000;
  const { store } = await seed(t, [{
    ...good(0),
    data: { ...good(0).data, msg_content: 'A'.repeat(SIZE) },
  }]);
  const page = store.getEvents({ sessionId: 'sess-c', limit: 1, detailLevel: 'full' });
  const { redactEvent } = await import('../server/redact.mjs');
  const swept = redactEvent(page.events[0], { maxLength: 20000, homeDir: FIXTURE_HOME, roots: [store.dataDir] });
  const marker = /\n… \[truncated (\d+) chars\]/.exec(swept.content);
  assert.ok(marker, 'the reply must say that it dropped something');
  const kept = swept.content.slice(0, swept.content.indexOf('\n… ['));
  assert.equal(Number(marker[1]), SIZE - kept.length, 'the reported count must match what was actually dropped');
});

test('a turn id in the column counts the same everywhere it is asked about', async (t) => {
  // Three surfaces decided "which turn is this row" three ways. The statistics counted
  // turns straight out of the document, so a row whose turn id the runtime wrote only
  // to the `turn_id` column contributed to the turn fold and to a turnId-filtered read
  // but not to the summary — one session reporting 0 turns beside a timeline with
  // turns in it.
  const { store } = await seed(t, []);
  const db = new DatabaseSync(path.join(store.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  const insert = db.prepare(
    `INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json, source)
     VALUES ('sess-c', ?, 'assistant', 'column-turn', ?, ?, 'api')`,
  );
  db.exec('BEGIN');
  for (let i = 0; i < 5; i += 1) {
    insert.run(`m${i}`, NOW - i, JSON.stringify({ msg_id: `m${i}`, role: 'assistant', source: 'api', msg_type: 2, msg_content: `row ${i}` }));
  }
  db.exec('COMMIT');
  db.close();

  const stats = store.getStats('sess-c');
  const summaries = store.getTurnSummaries('sess-c');
  const filtered = store.getEvents({ sessionId: 'sess-c', turnId: 'column-turn', limit: 10 });
  assert.equal(stats.turns, 1, 'the summary disagrees with the turn fold about how many turns exist');
  assert.equal(summaries.length, 1);
  assert.equal(filtered.events.length, 5, 'the same filter finds the records the fold counted');
});

/* --------------------------------------- the properties a green suite missed -- */

/**
 * Everything below is a behaviour that the suite did not pin, and each one survived a
 * mutation of the code that implements it. They are grouped here because they share a
 * shape: each is a case where a surface answered confidently and wrongly, and nothing
 * in the repository could see it.
 */

test('a capped timeline says it was capped', async (t) => {
  // The only timeline assertion in the suite was `truncated === false` on a six-row
  // fixture, so the 6,000-point cap — the entire reason `truncated` exists — was
  // unreachable: the largest fixture is 1,000 rows. The cap is a parameter, so this
  // exercises the same branch without seeding 6,001 rows.
  const { store } = await seed(t, Array.from({ length: 8 }, (_, i) => good(i)));
  const capped = store.getTimeline('sess-c', { cap: 5 });
  assert.equal(capped.points.length, 5, 'the axis drew past its cap');
  assert.equal(capped.truncated, true, 'and did not say so');
  const whole = store.getTimeline('sess-c', { cap: 50 });
  assert.equal(whole.points.length, 8);
  assert.equal(whole.truncated, false, 'a session under the cap must not be reported as capped');
  // No `total`: the query never counted past the cap, so a field by that name could
  // only have held the delivered count.
  assert.equal('total' in capped, false, 'a delivered count under the name `total` is the misreading this Plugin exists to prevent');
});

test('the task cursor reaches the oldest task and reports the real count', async (t) => {
  // No test seeded more than a handful of tasks, so `offset`, the count behind
  // `total`, and the cursor were all replaceable with no-ops and the suite stayed
  // green. The 2,500-task defect this Plugin fixed was entirely re-openable.
  const { store } = await seed(t, []);
  const db = new DatabaseSync(path.join(store.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  const ins = db.prepare(
    `INSERT INTO local_runtime_background_tasks
      (task_id, owner_session_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms, record_json)
     VALUES (?,'sess-c','bash','completed',?,?,?,?)`,
  );
  db.exec('BEGIN');
  for (let i = 0; i < 250; i += 1) {
    ins.run(`t${String(i).padStart(4, '0')}`, NOW - i, NOW - i, NOW - i, JSON.stringify({ toolName: 'bash' }));
  }
  db.exec('COMMIT');
  db.close();

  const first = store.listBackgroundTasks('sess-c', { limit: 200 });
  assert.equal(first.length, 200);
  const second = store.listBackgroundTasks('sess-c', { limit: 200, offset: 200 });
  assert.equal(second.length, 50, 'the oldest 50 were unreachable behind the first page');
  assert.equal(store.countBackgroundTasks('sess-c'), 250, 'and the count behind `total` was the page size');

  const seen = new Set([...first, ...second].map((task) => task.taskId));
  assert.equal(seen.size, 250, 'paging lost or repeated a task');
  assert.ok(seen.has('t0000'), 'the true oldest task is unreachable');
});

test('an explicitly empty session id is refused, not answered with someone else\'s session', async (t) => {
  // `''` means a caller passed a variable it never filled. Answering with the newest
  // session returned plausible records under a name the caller did not ask for, and
  // no test asserted the error code at all.
  const { store, call } = await seed(t, [good(0), good(1, 't1')]);
  await assert.rejects(
    () => call('trajectory_get', { sessionId: '', limit: 10 }),
    /unknown_session_id/,
  );
  await assert.rejects(() => call('trajectory_get', { sessionId: '   ' }), /unknown_session_id/);
  // Omitting it still means "the most recent session", which is what the tool promises.
  const latest = await call('trajectory_get', { limit: 10 });
  assert.equal(latest.source, 'sqlite', 'an omitted session id stopped meaning the latest session');
});

test('a turn id that lives only in the document counts as that turn everywhere', async (t) => {
  // The fixture wrote the turn id to the column *and* into the document, so the two
  // halves of TURN_KEY_SQL were interchangeable and neither was exercised. A row whose
  // turn id exists only under the camelCase key counted in the event projection and
  // not in the summary.
  const { store } = await seed(t, []);
  const db = new DatabaseSync(path.join(store.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  const insert = db.prepare(
    `INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json, source)
     VALUES ('sess-c', ?,'assistant','',?,?,'api')`,
  );
  db.exec('BEGIN');
  for (let i = 0; i < 5; i += 1) {
    insert.run(`j${i}`, NOW - i, JSON.stringify({ msg_id: `j${i}`, role: 'assistant', source: 'api', turnId: 'doc-turn' }));
  }
  db.exec('COMMIT');
  db.close();

  const stats = store.getStats('sess-c');
  const summaries = store.getTurnSummaries('sess-c');
  const filtered = store.getEvents({ sessionId: 'sess-c', turnId: 'doc-turn', limit: 10 });
  assert.equal(filtered.events.length, 5, 'the filter did not find what the fold counted');
  assert.equal(summaries.length, 1, 'the turn fold disagrees with the filter');
  assert.equal(stats.turns, 1, 'the summary disagrees with the fold about how many turns exist');
});

test('the unturn-keyed group is addressable, and both surfaces count it the same way', async (t) => {
  // `turnId: null` came out of the turn fold as a real group, and passing it straight
  // back asked the read for nothing — `if (turnId)` read it as "no filter" and
  // returned the whole session. Separately the summary dropped the group and the fold
  // kept it, so a session of two rows in one turn plus one unturn-keyed row plus one
  // with an empty turn id reported `turns: 1` beside three turn cards.
  const { store } = await seed(t, []);
  const db = new DatabaseSync(path.join(store.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  const insert = db.prepare(
    `INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json, source)
     VALUES ('sess-c', ?,'assistant',?,?,?,'api')`,
  );
  const row = (id, turnId) => JSON.stringify({ msg_id: id, role: 'assistant', source: 'api', ...(turnId === undefined ? {} : { turn_id: turnId }) });
  db.exec('BEGIN');
  insert.run('a', 't1', NOW, row('a', 't1'));
  insert.run('b', 't1', NOW - 1, row('b', 't1'));
  insert.run('c', null, NOW - 2, row('c'));
  insert.run('d', '', NOW - 3, row('d', ''));
  db.exec('COMMIT');
  db.close();

  const summaries = store.getTurnSummaries('sess-c');
  const stats = store.getStats('sess-c');
  assert.equal(summaries.length, 2, 'an empty turn id and no turn id are the same group');
  assert.equal(stats.turns, summaries.length, 'the summary and the fold must count the same turns');

  const unturn = store.getEvents({ sessionId: 'sess-c', turnId: null, limit: 10 });
  assert.equal(unturn.events.length, 2, `asking for the unturn-keyed group returned ${unturn.events.length} records`);
  assert.deepEqual(unturn.events.map((e) => e.rowId).sort(), [3, 4]);
  const empty = store.getEvents({ sessionId: 'sess-c', turnId: '', limit: 10 });
  assert.equal(empty.events.length, 2, 'an empty turn id is the same question as a null one');
  const all = store.getEvents({ sessionId: 'sess-c', limit: 10 });
  assert.equal(all.events.length, 4, 'and omitting the filter still returns everything');
});

test('a filtered read is answered from the projection, not from a second source', async (t) => {
  // The artifact fallback keyed on "this page came back empty", so any read that
  // legitimately matched nothing consulted a second source. With a turn the projection
  // does not hold but the artifact does, the same question was answered from SQLite on
  // one call and from `messages.jsonl` on the next — two sources, two `total`
  // semantics, for one session. The guard now keys on the session: a session with any
  // projection at all is answered entirely from it, so one cursor walk cannot change
  // source between pages.
  //
  // A whole cursor staying in one index space is the property that matters. It does not
  // lose records in practice — the projection is built from the artifact, so offset n
  // names the same record in both — but a reply whose `source` and `total` change
  // halfway through a walk is exactly the disagreement this Plugin exists to avoid.
  const { store, call } = await seed(t, [good(0), good(1)], {
    artifactSessionId: 'sess-c',
    artifact: [
      { message_id: 'a0', turn_id: 'tA', message: { role: 'user', content: [{ type: 'text', text: 'zero' }] } },
      { message_id: 'a1', turn_id: 'tB', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } },
    ].map((record) => `${JSON.stringify(record)}\n`).join(''),
  });

  // `tB` exists only in the artifact. Answering it from there would answer a question
  // about the projection from a source the projection says does not contain it.
  const reply = await call('trajectory_get', { sessionId: 'sess-c', turnId: 'tB', limit: 10 });
  assert.equal(reply.source, 'sqlite', 'a filtered read was answered from a different source');
  assert.equal(reply.returned, 0);
  // `total` is what the filter matched; the session's own count travels beside it so
  // the two questions are never answered with one number.
  assert.equal(reply.total, 0, 'total must count what the filter matched');
  assert.equal(reply.sessionTotal, 2, 'and the session\'s own count was not reported');

  // A session with no projection at all is still read from its artifact — the case the
  // fallback exists for, and the one its original `source !== 'sqlite'` guard skipped.
  const unindexed = await seed(t, [], {
    artifactSessionId: 'sess-artifact',
    artifact: `${JSON.stringify({ message_id: 'a0', turn_id: 'tA', message: { role: 'user', content: [{ type: 'text', text: 'zero' }] } })}\n`,
  });
  const fallback = await unindexed.call('trajectory_get', { sessionId: 'sess-artifact', limit: 10 });
  assert.equal(fallback.source, 'jsonl', 'an unindexed session is no longer read from its artifact');
  assert.equal(fallback.returned, 1);
});

test('a page cut by the byte budget says so at the egress, not only inside the store', async (t) => {
  // The store set the flag and both egresses dropped it, so a reply carrying 7 of 20
  // records answered `truncated: false, omitted: 0`. The only assertion was against
  // the store's return value — the one layer that was never the problem.
  const MB = 1024 * 1024;
  const { store, call } = await seed(t, []);
  const db = new DatabaseSync(path.join(store.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  const insert = db.prepare(
    `INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json, source)
     VALUES ('sess-c', ?,'assistant','t1',?,?,'api')`,
  );
  const body = 'z'.repeat(MB);
  db.exec('BEGIN');
  for (let i = 0; i < 12; i += 1) {
    insert.run(`m${i}`, NOW - i, JSON.stringify({ msg_id: `m${i}`, role: 'assistant', source: 'api', turn_id: 't1', msg_content: body }));
  }
  db.exec('COMMIT');
  db.close();

  const page = store.getEvents({ sessionId: 'sess-c', limit: 12, detailLevel: 'full', pageBytes: 4 * MB });
  assert.equal(page.pageBytesTruncated, true, 'the store did not notice its own cut');

  const reply = await call('trajectory_get', { sessionId: 'sess-c', limit: 12, detailLevel: 'full' });
  assert.equal(reply.pageBytesTruncated, true, 'the egress dropped the flag and reported a short page as whole');
  assert.ok(reply.returned < reply.total);
});

test('a cached fold follows the rows it folds', async (t) => {
  // The four per-session folds were cached against the session row's updated_at_ms,
  // which the runtime does not touch while it indexes — the rows being written are
  // message rows. A session that gained a record kept serving the statistics, turn
  // summaries, timeline and task index it had before. The method that existed to
  // break this, invalidateSession, was never called from anywhere.
  const { store } = await seed(t, [good(0)]);
  assert.equal(store.getStats('sess-c').events, 1);
  assert.equal(store.getTimeline('sess-c').points.length, 1);
  assert.equal(store.getTurnSummaries('sess-c').length, 1);

  const db = new DatabaseSync(path.join(store.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  db.prepare(
    `INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json, source)
     VALUES ('sess-c','m1','assistant','t2',?,?,'api')`,
  ).run(NOW + 1, JSON.stringify({ msg_id: 'm1', role: 'assistant', source: 'api', turn_id: 't2', msg_content: 'second' }));
  db.close();

  assert.equal(store.getStats('sess-c').events, 2, 'the statistics fold served a stale count');
  assert.equal(store.getTimeline('sess-c').points.length, 2, 'the timeline drew the session as it was before the write');
  assert.equal(store.getTurnSummaries('sess-c').length, 2, 'the turn fold is stale');
});

test('a task that finishes is visible to the tool call it belongs to', async (t) => {
  // The task index is keyed differently from the message folds: a task moving from
  // running to completed is an update to its own row, so neither a count nor a max-id
  // high-water mark over message rows would move. A session-scoped key kept reporting
  // the call as `ok: true, status: completed` with the duration it had while still
  // running — a confident, wrong number on the surface the reader looks at.
  const { store } = await seed(t, [{
    ...good(0),
    data: {
      ...good(0).data,
      tool_calls: [{ tool_name: 'bash', tool_call_id: 'call-x', tool_call_status: 2 }],
    },
  }]);
  const db = new DatabaseSync(path.join(store.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  db.prepare(
    `INSERT INTO local_runtime_background_tasks
      (task_id, owner_session_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms, record_json)
     VALUES ('call-x','sess-c','bash','running',?,?,NULL,?)`,
  ).run(NOW, NOW, JSON.stringify({ toolName: 'bash', toolCallId: 'call-x' }));
  db.close();

  const running = store.getEvents({ sessionId: 'sess-c', limit: 5, detailLevel: 'summary' });
  const before = running.events[0].toolCalls?.[0];
  assert.equal(before.taskId, 'call-x', 'the tool call did not bind to its background task');
  assert.equal(before.taskStatus, 'running');

  const later = new DatabaseSync(path.join(store.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  later.prepare(
    `UPDATE local_runtime_background_tasks SET status='failed', updated_at_ms=?, ended_at_ms=? WHERE task_id='call-x'`,
  ).run(NOW + 60_000, NOW + 60_000);
  later.close();

  const after = store.getEvents({ sessionId: 'sess-c', limit: 5, detailLevel: 'summary' }).events[0].toolCalls?.[0];
  assert.equal(after.taskStatus, 'failed', 'the task index served a stale status for a task that had since failed');
  assert.equal(after.durationMs, 60_000, 'and the duration it had while still running');
});

test('a record the artifact cannot parse is counted, not dropped in silence', async (t) => {
  // The oversized-line path has always counted its drops. A line that does not parse
  // — the shape an interrupted write leaves behind, which is what this reader exists
  // for — was returned as neither a record nor a count, so a file whose last record
  // was corrupt read exactly like a file that simply ended.
  const { store } = await seed(t, [], {
    artifact: [
      `${JSON.stringify({ message_id: 'j0', turn_id: 'tA', message: { role: 'user', content: [{ type: 'text', text: 'zero' }] } })}\n`,
      `${JSON.stringify({ message_id: 'j1', turn_id: 'tA', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } })}\n`,
      '{"message_id":"junk","role":',
    ].join(''),
  });
  const page = await store.readJsonlEvents({ sessionId: 'sess-artifact', offset: 0, limit: 10, detailLevel: 'summary' });
  assert.equal(page.events.length, 2, 'the two readable records must survive');
  assert.equal(page.malformedLines, 1, 'the unparseable line vanished with no count');
  assert.equal(page.droppedOversized, 0);
});

test('a session with more children than the cap says so', async (t) => {
  // LIMIT 200 with no count behind it: a parent with 210 children reported 200 of
  // them and said nothing, which is indistinguishable from a parent that has 200.
  const { store } = await seed(t, [good(0)]);
  const db = new DatabaseSync(path.join(store.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  const ins = db.prepare(
    `INSERT INTO local_runtime_sessions (session_id, record_json, updated_at_ms, parent_session_id, created_at_ms)
     VALUES (?,?,?,'sess-c',?)`,
  );
  db.exec('BEGIN');
  for (let i = 0; i < 205; i += 1) ins.run(`child-${i}`, '{}', NOW, NOW - i);
  db.exec('COMMIT');
  db.close();

  const session = store.getSession('sess-c');
  assert.equal(session.children.length, 200, 'the child cap is not what it claims');
  assert.equal(session.childrenCapped, true, 'and the session does not say it has more children than it returned');
});
