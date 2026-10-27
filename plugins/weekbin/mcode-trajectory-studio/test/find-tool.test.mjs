/**
 * Finding a record without paging to it.
 *
 * A session's message text is the one thing none of the tools could search. Titles,
 * agent names, statuses and workspace paths go through the runtime's FTS5 index;
 * message bodies do not, and a LIKE scan across the whole projection measures 6.4 s
 * over 109k rows on this machine. So a cross-session text search is not merely
 * unimplemented — at that cost it would not be a usable tool call.
 *
 * Scoped to one session it is cheap: the session filter is indexed, and the busiest
 * session here — 21,315 rows and 137 MB of payload — scans in 197 ms. That is the
 * shape this tool takes, and the shape worth having: for a long session, locating a
 * known record costs twenty-odd `trajectory_get` calls otherwise.
 *
 * The property that makes it more than a filter is that every hit carries the record's
 * index in the same insert-order numbering `trajectory_get` pages in, so a match is
 * addressable rather than merely reportable. That correspondence is two different
 * queries agreeing on an ordering, so it is pinned here rather than assumed.
 *
 * And the property that makes it safe: the query is literal. `%` and `_` are LIKE
 * wildcards, so without escaping a search for `50%` returns everything starting with
 * "50" — a confident wrong answer rather than an obviously broken query.
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

const BODIES = [
  'the parser needs a rewrite before anything else',
  'nothing interesting in this turn at all',
  'watch out for 50% of the cases failing',
  'the snake_case identifier was renamed to camelCase',
  'a backslash \\ appears in this line deliberately',
  'the tail of the session repeats the parser',
];

async function seeded(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'find-tool-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-f', title: 'Findable', updatedAtMs: NOW });
  BODIES.forEach((text, index) => {
    projection.row({
      sessionId: 'sess-f',
      msgId: `m${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      turnId: `turn-${Math.floor(index / 2)}`,
      createdAtMs: NOW + index,
      data: { msg_content: text },
    });
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const call = (store, tool, args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
  .call(tool, args);

/* --------------------------------------------------------- it finds things -- */

test('a hit carries the index trajectory_get pages in', async (t) => {
  const store = await seeded(t);
  const found = await call(store, 'trajectory_find', { sessionId: 'sess-f', query: 'parser' });
  assert.equal(found.total, 2, 'both lines mentioning the parser should be found');
  for (const hit of found.matches) {
    const page = await call(store, 'trajectory_get', { sessionId: 'sess-f', offset: hit.index, limit: 1 });
    assert.equal(page.events[0].index, hit.index,
      'the hit index does not address the record it names');
  }
});

test('the reported total and the rows describe the same set', async (t) => {
  const store = await seeded(t);
  const found = await call(store, 'trajectory_find', { sessionId: 'sess-f', query: 'parser' });
  assert.equal(found.returned, found.matches.length);
  const walked = [];
  let at = 0;
  for (let page = 0; page < 5 && at !== null; page += 1) {
    const reply = await call(store, 'trajectory_find', { sessionId: 'sess-f', query: 'parser', offset: at, limit: 1 });
    walked.push(...reply.matches.map((hit) => hit.index));
    at = reply.nextOffset;
  }
  assert.equal(walked.length, found.total, 'paging saw a different number than the total');
  assert.equal(new Set(walked).size, walked.length, 'the same record was returned on two pages');
});

/* ------------------------------------------------------- the query is literal -- */

test('LIKE wildcards in the query are matched literally', async (t) => {
  // The failure this prevents is quiet and confident: unescaped, `50%` matches every
  // row starting with "50", and the reply looks like a real result set rather than a
  // broken query. `%` and `_` are the two that do it; `\` is what escapes them.
  const store = await seeded(t);
  const all = await call(store, 'trajectory_get', { sessionId: 'sess-f', limit: 100 });
  const rows = all.events.length;

  const percent = await call(store, 'trajectory_find', { sessionId: 'sess-f', query: '50%' });
  assert.equal(percent.total, 1, 'the literal "50%" was treated as a wildcard');
  assert.equal(percent.matches[0].index, 2);

  const underscore = await call(store, 'trajectory_find', { sessionId: 'sess-f', query: 'snake_case' });
  assert.equal(underscore.total, 1, 'the literal "snake_case" was treated as a wildcard');
  assert.equal(underscore.matches[0].index, 3);

  // And the escaped form still finds the backslash, which is the escape character.
  const backslash = await call(store, 'trajectory_find', { sessionId: 'sess-f', query: '\\' });
  assert.equal(backslash.total, 1, 'a literal backslash could not be searched for');
  assert.equal(backslash.matches[0].index, 4);
  assert.ok(backslash.total < rows, 'the wildcard check is only meaningful against a real session');
});

test('a query with no wildcards in it is unaffected by the escaping', async (t) => {
  const store = await seeded(t);
  const plain = await call(store, 'trajectory_find', { sessionId: 'sess-f', query: 'camelCase' });
  assert.equal(plain.total, 1, 'escaping changed an ordinary query');
  assert.equal(plain.matches[0].index, 3);
});

test('a blank query returns nothing rather than everything', async (t) => {
  const store = await seeded(t);
  for (const query of ['', '   ']) {
    const reply = await call(store, 'trajectory_find', { sessionId: 'sess-f', query });
    assert.equal(reply.total, 0, `a blank query matched ${reply.total} records`);
    assert.deepEqual(reply.matches, []);
    assert.equal(reply.nextOffset, null);
  }
});

/* ----------------------------------------------------------- content is gated -- */

test('summary returns no message text, full does', async (t) => {
  // Same rule as every other message body this Plugin hands out: a search result is
  // not a consent. Summary locates the record; `full` quotes it.
  const store = await seeded(t);
  const summary = await call(store, 'trajectory_find', { sessionId: 'sess-f', query: 'parser' });
  for (const hit of summary.matches) {
    assert.equal('snippet' in hit, false, 'summary mode carried an excerpt');
  }
  const full = await call(store, 'trajectory_find', { sessionId: 'sess-f', query: 'parser', detailLevel: 'full' });
  for (const hit of full.matches) {
    assert.equal(typeof hit.snippet, 'string', 'full mode withheld the excerpt');
    assert.match(hit.snippet, /parser/iu, 'the excerpt does not show what was found');
  }
});

test('a hit says which field it was in', async (t) => {
  // A hit located in thinking or in a tool argument is still a hit, and a caller shown
  // an excerpt of message text that does not contain the query has no way to tell.
  const store = await seeded(t);
  const found = await call(store, 'trajectory_find', { sessionId: 'sess-f', query: 'parser' });
  for (const hit of found.matches) {
    assert.equal(hit.field, 'content', 'a plain message hit was not reported as content');
  }
});

/* ------------------------------------------------------------- boundaries -- */

test('a session with no match is empty and says so without pretending it failed', async (t) => {
  const store = await seeded(t);
  const none = await call(store, 'trajectory_find', { sessionId: 'sess-f', query: 'nonexistentstring' });
  assert.equal(none.total, 0);
  assert.deepEqual(none.matches, []);
  assert.equal(none.source, 'sqlite', 'an empty result was reported as a failure');
  assert.equal(none.error, undefined);
});

test('paging terminates instead of offering a cursor forever', async (t) => {
  const store = await seeded(t);
  const past = await call(store, 'trajectory_find', { sessionId: 'sess-f', query: 'parser', offset: 99 });
  assert.deepEqual(past.matches, []);
  assert.equal(past.nextOffset, null);
});
test('a credential in the matched text does not survive the excerpt', async (t) => {
  // A snippet is a slice of a message body, so it carries what a message body carries.
  // `trajectory_get` sweeps its full-detail records through the redactor; a match that
  // skipped that sweep would make the *search* tool the one path that hands out
  // unredacted session text — and it would look safer than the plain read, because an
  // excerpt reads as a quotation rather than as a record.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'find-redact-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-r', title: 'Secretive', updatedAtMs: NOW });
  projection.row({
    sessionId: 'sess-r',
    msgId: 'm0',
    role: 'user',
    turnId: 't0',
    createdAtMs: NOW,
    data: { msg_content: 'the deploy key is api_key=FIND-CANARY-4b7e and work happens in ' + FIXTURE_HOME + '/ws' },
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const tool = (args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] }).call('trajectory_find', args);

  const full = await tool({ sessionId: 'sess-r', query: 'FIND-CANARY-4b7e', detailLevel: 'full' });
  assert.equal(full.total, 1, 'the record holding the credential was not found');
  assert.equal(full.matches[0].snippet.includes('FIND-CANARY-4b7e'), false,
    `the excerpt leaked the credential: ${full.matches[0].snippet}`);
  assert.equal(full.matches[0].snippet.includes(FIXTURE_HOME), false,
    `the excerpt leaked an absolute path: ${full.matches[0].snippet}`);
  // The record is still findable — the search is over what the runtime stored, and the
  // redaction happens on the way out.
  assert.equal(full.matches[0].index, 0, 'the hit did not report where the credential was');
});

test('a session the indexer has not reached is searched in its artifact', async (t) => {
  // The projection is written as the session runs, so the newest session can be on
  // disk but not yet in SQLite. `trajectory_get` has always fallen back there; the
  // search did not, and answered "no matches" — for a session whose records it could
  // have read. A search that says nothing is here when it never looked is the one
  // answer this Plugin is built not to give.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'find-artifact-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-art', title: 'Artifact only', updatedAtMs: NOW });
  projection.close();
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '18', '10-00-00-000-sess-art');
  await mkdir(dir, { recursive: true });
  const line = (i, text) => `${JSON.stringify({
    message_id: `m${i}`,
    turn_id: 't0',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
  await writeFile(path.join(dir, 'messages.jsonl'),
    line(0, 'the needle is here') + line(1, 'nothing of note') + line(2, 'needle again'), 'utf8');

  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const tool = (args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] }).call('trajectory_find', args);

  const found = await tool({ sessionId: 'sess-art', query: 'needle' });
  assert.equal(found.source, 'jsonl', 'the search claimed the projection even though it is empty for this session');
  assert.equal(found.matches.length, 2, 'the artifact held two records mentioning the needle');

  // And it agrees with the plain read, which is what makes the fallback trustworthy:
  // the same session, the same records, from either source.
  const page = await createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
    .call('trajectory_get', { sessionId: 'sess-art', limit: 10 });
  assert.equal(page.source, 'jsonl');
  assert.ok(page.events.length >= 2, 'the projection read disagrees with the search about whether records exist');
});

test('the artifact path redacts what it quotes, not only the projection path', async (t) => {
  // The excerpt is built from the artifact record *before* redaction runs — that
  // ordering is deliberate and correct, but it means the artifact branch carries its
  // own obligation. The egress sweep seeds a projected session, so without this the
  // second source would be the one place a credential could come back out, and the
  // gap would be invisible until someone searched a session that was not indexed yet.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'find-artifact-redact-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-ar', title: 'Secretive artifact', updatedAtMs: NOW });
  projection.close();
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '18', '10-00-00-000-sess-ar');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'messages.jsonl'),
    `${JSON.stringify({
      message_id: 'm0',
      turn_id: 't0',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `token ARTIFACT-CANARY-8c1d near ${FIXTURE_HOME}/ws` }],
      },
    })}\n`, 'utf8');

  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const reply = await createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
    .call('trajectory_find', { sessionId: 'sess-ar', query: 'ARTIFACT-CANARY-8c1d', detailLevel: 'full' });

  assert.equal(reply.source, 'jsonl', 'this case is only meaningful on the artifact path');
  assert.equal(reply.matches.length, 1, 'the artifact record mentioning the token was not found');
  assert.equal(typeof reply.matches[0].snippet, 'string', 'the artifact path quoted nothing, so nothing was checked');
  assert.equal(reply.matches[0].snippet.includes('ARTIFACT-CANARY-8c1d'), false,
    `the artifact excerpt leaked the credential: ${reply.matches[0].snippet}`);
  assert.equal(reply.matches[0].snippet.includes(FIXTURE_HOME), false,
    `the artifact excerpt leaked an absolute path: ${reply.matches[0].snippet}`);
});

/* ------------------------------------------ the artifact path has a cursor too -- */

/**
 * `total` is null on the artifact path, and that null used to end every walk.
 *
 * The projection knows its own record count, so its cursor is computed from `total`.
 * The artifact fold deliberately does not pay for a whole-file count — it stops at the
 * page boundary and publishes a cursor instead. The handler computed both from
 * `total`, which made `offset + delivered >= null` true on the first page: a
 * just-written session holding twelve matches delivered five and answered
 * `nextOffset: null`, so the other seven were reachable by no call and the reply
 * called the list complete.
 *
 * The session is one the indexer has not reached, which is exactly the case the
 * artifact exists for — and the only case where this could not have been seen on the
 * projection path.
 */
async function artifactSeeded(t, records, { pageSize = 5 } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'find-artifact-cursor-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-ar', title: 'Freshly written', updatedAtMs: NOW });
  projection.close();
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '18', '10-00-00-000-sess-ar');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'messages.jsonl'), records.map((text, index) => `${JSON.stringify({
    message_id: `m${index}`,
    turn_id: 't0',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`).join(''), 'utf8');
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { store, pageSize };
}

const find = (store, args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
  .call('trajectory_find', args);

test('an artifact search pages past its first page', async (t) => {
  const { store } = await artifactSeeded(t, Array.from({ length: 12 }, (_, i) => `needle record ${i}`));
  const first = await find(store, { sessionId: 'sess-ar', query: 'needle', limit: 5 });
  assert.equal(first.source, 'jsonl', 'this case is only meaningful on the artifact path');
  assert.equal(first.total, null, 'the artifact fold reports no whole-file count by design');
  assert.equal(first.returned, 5);
  assert.equal(first.nextOffset, 5, 'the walk ended on the first page of a session with more matches');
});

test('paging an artifact search reaches every match exactly once and then stops', async (t) => {
  const { store } = await artifactSeeded(t, Array.from({ length: 12 }, (_, i) => `needle record ${i}`));
  const seen = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const reply = await find(store, { sessionId: 'sess-ar', query: 'needle', limit: 5, offset });
    pages += 1;
    assert.ok(pages <= 10, 'the artifact walk did not terminate');
    seen.push(...reply.matches.map((match) => match.index));
    if (reply.nextOffset === null) break;
    assert.equal(reply.nextOffset, offset + reply.returned,
      'the cursor must name the first match the caller did not receive');
    offset = reply.nextOffset;
  }
  assert.equal(seen.length, 12, `the walk delivered ${seen.length} of 12 matches`);
  assert.equal(new Set(seen).size, 12, 'the walk repeated a match');
});

test('the artifact cursor still terminates on the last page', async (t) => {
  // The control for the case above: a cursor that always continues is just as wrong as
  // one that always stops, and only one of them is caught by the walk test.
  const { store } = await artifactSeeded(t, ['needle one', 'noise two', 'needle three']);
  const reply = await find(store, { sessionId: 'sess-ar', query: 'needle', limit: 5 });
  assert.equal(reply.returned, 2, 'the filter did not apply to the artifact');
  assert.equal(reply.nextOffset, null, 'a complete artifact page handed back a cursor');
});

test('a projection search is unaffected by the artifact cursor rule', async (t) => {
  // The other source: its `total` is a count, so the cursor stays computed from it.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'find-projection-cursor-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-p', title: 'Indexed', updatedAtMs: NOW });
  for (let i = 0; i < 12; i += 1) {
    projection.row({
      sessionId: 'sess-p', msgId: `m${i}`, role: 'user', turnId: 't0', createdAtMs: NOW + i,
      data: { msg_id: `m${i}`, role: 'user', msg_type: 1, turn_id: 't0', msg_content: `needle record ${i}` },
    });
  }
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const first = await find(store, { sessionId: 'sess-p', query: 'needle', limit: 5 });
  assert.equal(first.source, 'sqlite');
  assert.equal(first.total, 12);
  assert.equal(first.nextOffset, 5);
  const last = await find(store, { sessionId: 'sess-p', query: 'needle', limit: 5, offset: 10 });
  assert.equal(last.returned, 2);
  assert.equal(last.nextOffset, null);
});

test('the artifact path quotes around the match, not from the start of the record', async (t) => {
  // The artifact branch built its excerpt with `event.content.slice(0, 400)` — the
  // first four hundred characters of the message, wherever the match happened to be.
  // On a long record the match sits past that window, so the excerpt showed four
  // hundred characters of something else while claiming to be the hit. The projection
  // path has always quoted around the match; the two sources answered differently for
  // the same question, and only one of them was showing what was found.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'find-artifact-window-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-win', title: 'Long record', updatedAtMs: NOW });
  projection.close();
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '18', '10-00-00-000-sess-win');
  await mkdir(dir, { recursive: true });
  // The match sits well past 400 characters from the start.
  const body = `${'filler text that says nothing useful. '.repeat(30)}the-needle-is-here`;
  await writeFile(path.join(dir, 'messages.jsonl'), `${JSON.stringify({
    message_id: 'm0',
    turn_id: 't0',
    message: { role: 'user', content: [{ type: 'text', text: body }] },
  })}\n`, 'utf8');

  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const found = await createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
    .call('trajectory_find', { sessionId: 'sess-win', query: 'needle', detailLevel: 'full' });
  assert.equal(found.source, 'jsonl');
  assert.equal(found.matches.length, 1);
  const snippet = found.matches[0].snippet;
  assert.ok(typeof snippet === 'string', 'the artifact path quoted nothing in full detail');
  assert.ok(snippet.includes('needle'),
    `the excerpt does not contain the match: ${JSON.stringify(snippet?.slice(-80))}`);
  assert.ok(snippet.length < body.length,
    `the excerpt is the whole record, so the window was never placed: ${snippet?.length} of ${body.length}`);
});

test('the tool says when a match came from the case-folding scan', async (t) => {
  // The store reports `unindexedCaseMatch`, but a flag that stops at the store
  // boundary reports nothing to the model — which is the only caller that pays for the
  // scan. Three answers have to stay distinguishable: `true` when the scan ran and
  // found something, absent when the indexed path answered, and absent (not `true`)
  // when the scan ran and found nothing.
  //
  // Projected rows, not an artifact: the flag belongs to the SQL path. The artifact
  // fold reads the file and folds in JavaScript already, so there is no cheaper path
  // being escalated to and nothing to report — the first draft of this test used a
  // JSONL session and saw `total: null`, which said nothing about the flag either way.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'find-scanflag-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-case', title: 'Case test', updatedAtMs: NOW });
  projection.row({
    sessionId: 'sess-case',
    msgId: 'm0',
    role: 'assistant',
    turnId: 't0',
    createdAtMs: NOW,
    data: { role: 'assistant', msg_content: 'Der TURKGÜRTEL liegt im Şark' },
  });
  projection.close();

  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const tool = (args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
    .call('trajectory_find', args);

  const scanned = await tool({ sessionId: 'sess-case', query: 'turkgürtel' });
  assert.equal(scanned.source, 'sqlite', 'this case only means anything on the projection path');
  assert.equal(scanned.total, 1, 'the case-folding pass did not reach the tool');
  assert.equal(scanned.unindexedCaseMatch, true, 'the scan ran and the tool did not say so');

  const plain = await tool({ sessionId: 'sess-case', query: 'Şark' });
  assert.equal(plain.total, 1);
  assert.equal(plain.unindexedCaseMatch, undefined,
    'the ordinary path claimed a scan it did not perform');

  const nothing = await tool({ sessionId: 'sess-case', query: 'zzz-not-here' });
  assert.equal(nothing.total, 0);
  assert.equal(nothing.unindexedCaseMatch, undefined,
    'a scan that found nothing still claimed one ran');
});

test('a hit inside a tool call still comes with its excerpt', async (t) => {
  // The commonest kind of hit on a working session, and the one that used to be a dead
  // end: the needle is in neither the message nor the thinking, so the hit was reported
  // as `field: 'other'` with no excerpt at all — the caller who had just asked for `full`
  // detail was told only which record to go and read next. Measured on a real session,
  // one word from the user's own messages matched 193 records and three of the first five
  // were of this kind.
  //
  // The excerpt is not new disclosure: `full` detail already returns the whole
  // `toolCalls[].args` and `.result` for this record through `trajectory_get`. It just
  // arrives before the second call rather than after it.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'find-tool-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-tc', title: 'Toolcall', updatedAtMs: NOW });
  const padding = 'a commit line that says nothing useful. '.repeat(20);
  projection.row({
    sessionId: 'sess-tc',
    msgId: 'm0',
    role: 'assistant',
    turnId: 'turn-0',
    createdAtMs: NOW,
    data: {
      msg_content: 'the branch and the remote have diverged',
      tool_calls: [
        {
          name: 'bash',
          tool_call_status: 2,
          tool_call_args: 'git log --oneline -5',
          tool_call_result_data: `${padding}1c8082c refactor(mcode-docs): drop a column${padding}`,
        },
      ],
    },
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const full = await call(store, 'trajectory_find', { sessionId: 'sess-tc', query: 'mcode-docs', detailLevel: 'full' });
  assert.equal(full.matches.length, 1, 'the hit inside the tool result was not found at all');
  const hit = full.matches[0];
  assert.equal(hit.field, 'other', 'the hit was attributed to the message instead of the tool call');
  assert.ok(hit.snippet, 'a hit in a tool call still returns no excerpt in full detail');
  assert.ok(hit.snippet.includes('mcode-docs'), `the excerpt does not contain the needle: ${hit.snippet}`);
  assert.equal(hit.matchedToolCall, 'result', 'the reply does not say which half of the tool call matched');
  // Which of the two matched matters: an argument is what the model wrote, a result is
  // what came back, and they answer different questions.
  assert.ok(hit.snippet.length < 1000, `the excerpt is ${hit.snippet.length} chars — it is not an excerpt`);

  // Summary detail still withholds it, on the same terms as every other message body.
  const summary = await call(store, 'trajectory_find', { sessionId: 'sess-tc', query: 'mcode-docs' });
  assert.equal(summary.matches[0].snippet, undefined, 'summary detail leaked a message excerpt');
});

test('a needle in a tool argument is reported as the argument', async (t) => {
  // The two halves are told apart, so a reader knows whether the term came from something
  // the model wrote or something the machine returned.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'find-tool-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-arg', title: 'Argument', updatedAtMs: NOW });
  projection.row({
    sessionId: 'sess-arg',
    msgId: 'm0',
    role: 'assistant',
    turnId: 'turn-0',
    createdAtMs: NOW,
    data: {
      msg_content: 'running the check',
      tool_calls: [{
        name: 'bash',
        tool_call_status: 2,
        tool_call_args: 'pytest -k "currency-parser" -x',
        tool_call_result_data: 'no tests ran',
      }],
    },
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const reply = await call(store, 'trajectory_find', { sessionId: 'sess-arg', query: 'currency-parser', detailLevel: 'full' });
  assert.equal(reply.matches.length, 1);
  assert.equal(reply.matches[0].matchedToolCall, 'args');
  assert.ok(reply.matches[0].snippet.includes('currency-parser'));
});

test('when both halves of a call hold the needle, the argument is the one named', async (t) => {
  // This is the shape every shell call produces: the model writes
  // `pytest -k "currency-parser"` and the result echoes the command line back before the
  // output that mentions it too. Both halves match, so which one is reported decides
  // whether the reader is told "the model asked for this" or "the machine said this" —
  // and the two are different claims about who put the term in the transcript.
  //
  // The argument is the one named, because it is the one that says what was being done.
  // The excerpt is checked against the same half, so a hit in the argument quotes the
  // argument rather than the result that happens to repeat it.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'find-tool-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-both', title: 'Both halves', updatedAtMs: NOW });
  projection.row({
    sessionId: 'sess-both',
    msgId: 'm0',
    role: 'assistant',
    turnId: 'turn-0',
    createdAtMs: NOW,
    data: {
      msg_content: 'running the check',
      tool_calls: [{
        name: 'bash',
        tool_call_status: 2,
        tool_call_args: 'pytest -k "currency-parser" -x',
        // The needle is here too, which is the whole point of this fixture.
        tool_call_result_data: '$ pytest -k "currency-parser" -x\n1 passed, 4 skipped',
      }],
    },
  });
  // A second record where the needle is only in the *later* call, so the order the
  // function walks the calls in is pinned as well: the first call that holds the needle
  // anywhere is the one reported, not the first half of it.
  projection.row({
    sessionId: 'sess-both',
    msgId: 'm1',
    role: 'assistant',
    turnId: 'turn-1',
    createdAtMs: NOW + 1,
    data: {
      msg_content: 'two calls in one turn',
      tool_calls: [
        { name: 'read', tool_call_status: 2, tool_call_args: '{"path":"README.md"}', tool_call_result_data: '# the project' },
        { name: 'grep', tool_call_status: 2, tool_call_args: 'grep -rn hedgehog .', tool_call_result_data: 'src/x.mjs:4: hedgehog' },
      ],
    },
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const both = await call(store, 'trajectory_find', { sessionId: 'sess-both', query: 'currency-parser', detailLevel: 'full' });
  assert.equal(both.matches.length, 1);
  assert.equal(both.matches[0].matchedToolCall, 'args',
    "the model's own wording was reported as the tool's output");
  assert.ok(both.matches[0].snippet.includes('pytest -k'),
    `the excerpt was quoted from the result rather than the argument: ${both.matches[0].snippet}`);

  const later = await call(store, 'trajectory_find', { sessionId: 'sess-both', query: 'hedgehog', detailLevel: 'full' });
  assert.equal(later.matches.length, 1);
  assert.equal(later.matches[0].matchedToolCall, 'args',
    'the second call in the record was skipped for the first one');
});

/* ------------------------------------- the artifact path answers the same way -- */

/**
 * One artifact-only session, in the shape the runtime actually writes.
 *
 * Every key here was read off real `messages.jsonl` files rather than invented: an
 * assistant turn carries `content: [{type:'toolCall', name, id, arguments}]` and
 * `[{type:'thinking', thinking}]`, and a tool result is its own `role: 'toolResult'`
 * record whose output is a `text` part. That last detail is why the needle is searched
 * for in a call's `arguments` here — `input` and `args`, the two names the reader used to
 * accept, are not keys the runtime writes, which is how 1,273 real tool calls
 * contributed the string `{}` to every haystack.
 */
const ARTIFACT_ONLY = [
  {
    turn_id: 'turn-0',
    message_id: 'a0',
    message: {
      role: 'assistant',
      timestamp: NOW,
      model: 'minimax-m3',
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: 'let me look at the parser first' },
        { type: 'thinking', thinking: 'the rewrite only pays off once the hedgehog case is settled' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'grep -rn "octopus-meme" .' } },
      ],
    },
  },
  {
    turn_id: 'turn-1',
    message_id: 'a1',
    message: {
      role: 'toolResult',
      timestamp: NOW + 1,
      toolName: 'bash',
      toolCallId: 'call_1',
      isError: false,
      content: [{ type: 'text', text: 'src/worker.mjs:12: const mood = "octopus-meme";' }],
    },
  },
].map((record) => JSON.stringify(record)).join('\n');

/**
 * The same three records as the cross-path test below, in the artifact's own shape.
 *
 * One term, three destinations, so the field a reader reports is decided by where the
 * term is rather than by which reader answered: in the message, in the thinking alone,
 * and in a tool argument alone. The projection's copy of the third stores its argument
 * as a string and the artifact's as the object the model was called with — the two
 * shapes the locator has to fold together.
 */
const ARTIFACT_SAME_RECORDS = [
  {
    turn_id: 't0',
    message_id: 'r1',
    message: { role: 'user', timestamp: NOW, content: [{ type: 'text', text: 'the hedgehog case' }] },
  },
  {
    turn_id: 't0',
    message_id: 'r2',
    message: {
      role: 'assistant',
      timestamp: NOW + 1,
      content: [
        { type: 'text', text: 'settling it now' },
        { type: 'thinking', thinking: 'first the hedgehog question' },
      ],
    },
  },
  {
    turn_id: 't1',
    message_id: 'r3',
    message: {
      role: 'assistant',
      timestamp: NOW + 2,
      content: [
        { type: 'text', text: 'looking for it' },
        { type: 'toolCall', id: 'call_1', name: 'grep', arguments: { pattern: 'hedgehog' } },
      ],
    },
  },
].map((record) => JSON.stringify(record)).join('\n');

/** A store whose only evidence for `sess-art` is the artifact on disk. */
async function artifactOnly(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'find-artifact-'));
  const projection = await createFixtureProjection(dataDir);
  // The session id is part of the directory name: that is how the reader finds it.
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '18', '10-00-00-000-sess-art');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'messages.jsonl'), `${ARTIFACT_ONLY}\n`, 'utf8');
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** One projected session, closed and ready for a store to be opened over it. */
async function createProjection(t, rows, sessionId = 'sess-p') {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'find-both-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: sessionId, title: 'Projected', updatedAtMs: NOW + 5 });
  rows.forEach((row, index) => projection.row({
    sessionId, createdAtMs: NOW + index, ...row,
  }));
  projection.close();
  return { dataDir };
}

test('a term in a tool argument is findable from the artifact', async (t) => {
  // The projection searches `data_json` whole, so it has always found this. The artifact
  // path did not: its predicate read `part.input ?? part.args ?? {}` and the runtime
  // writes `part.arguments`, so the term was absent from the haystack and the tool
  // answered "no matches" — for a session whose records were sitting on disk, on the one
  // tool whose job is to say what a session contains.
  const store = await artifactOnly(t);
  const reply = await call(store, 'trajectory_find', { sessionId: 'sess-art', query: 'octopus-meme' });
  assert.equal(reply.source, 'jsonl', 'the artifact is not what answered, so this proves nothing');
  // `total` is null by design on this path — the fold stops at the page boundary rather
  // than paying for a whole-file count — so the count that can be asserted is the one
  // actually returned.
  assert.equal(reply.total, null);
  assert.equal(reply.matches.length, 2, 'the term is in a tool argument and in that tool result');
  const fromCall = reply.matches.find((hit) => hit.field === 'other');
  assert.ok(fromCall, 'no hit was attributed to a tool call at all');
});

test('a hit in the thinking is labelled thinking, not content', async (t) => {
  // `field` was hardcoded `'content'` on this path, so a term in the thinking came back
  // saying it was in the message. Worse, the excerpt was quoted from `event.content`,
  // which does not hold the term — so in full detail the hit had no excerpt at all. That
  // is the identical dead end the projection path had, still reachable through the
  // fallback, and it is invisible to a caller who has no way to know which source
  // answered beyond the one word `source`.
  const store = await artifactOnly(t);
  const reply = await call(store, 'trajectory_find', {
    sessionId: 'sess-art', query: 'hedgehog', detailLevel: 'full',
  });
  assert.equal(reply.source, 'jsonl');
  assert.equal(reply.matches.length, 1);
  const hit = reply.matches[0];
  assert.equal(hit.field, 'thinking', 'a term in the thinking was reported as the message');
  assert.ok(hit.snippet, 'a hit in the thinking comes back with no excerpt in full detail');
  assert.ok(hit.snippet.includes('hedgehog'), `the excerpt does not hold the needle: ${hit.snippet}`);
});

test('the two paths name the same field for the same records', async (t) => {
  // The cross-surface form of the same claim, and the one that actually catches drift:
  // the *same three records* are written twice — once into the projection in its own
  // shape, once to `messages.jsonl` in the runtime's — and both readers are asked the
  // same question. Neither reply says the other exists, so agreement has to be asserted.
  //
  // The needle is placed to land in a different field in each of the three, which is the
  // only way this is a test of agreement rather than of two lookups that both happen to
  // succeed: a reader that always answered `content` would pass a single-term check.
  const term = 'hedgehog';
  const projected = await createProjection(t, [
    { msgId: 'r1', role: 'user', turnId: 't0', data: { msg_content: `the ${term} case` } },
    {
      msgId: 'r2',
      role: 'assistant',
      turnId: 't0',
      data: { msg_content: 'settling it now', thinking_content: `first the ${term} question` },
    },
    {
      msgId: 'r3',
      role: 'assistant',
      turnId: 't1',
      data: {
        msg_content: 'looking for it',
        tool_calls: [{ name: 'grep', tool_call_status: 2, tool_call_args: `grep -rn ${term} .` }],
      },
    },
  ]);
  const store = openStore({ dataDir: projected.dataDir });
  t.after(async () => {
    store.close();
    await rm(projected.dataDir, { recursive: true, force: true });
  });
  const dir = path.join(projected.dataDir, 'v2', 'sessions', '2026', '09', '18', '10-00-00-000-sess-art');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'messages.jsonl'), `${ARTIFACT_SAME_RECORDS}\n`, 'utf8');

  const fromDb = await call(store, 'trajectory_find', {
    sessionId: 'sess-p', query: term, detailLevel: 'full',
  });
  const fromDisk = await call(store, 'trajectory_find', {
    sessionId: 'sess-art', query: term, detailLevel: 'full',
  });
  assert.equal(fromDb.source, 'sqlite');
  assert.equal(fromDisk.source, 'jsonl');
  assert.equal(fromDb.matches.length, 3, 'the projected session lost a record');
  assert.equal(fromDisk.matches.length, 3, 'the artifact session lost a record');
  assert.deepEqual(
    fromDisk.matches.map((hit) => hit.field).sort(),
    fromDb.matches.map((hit) => hit.field).sort(),
    'the same records are described differently depending on which reader answered',
  );
  assert.deepEqual(
    fromDb.matches.map((hit) => hit.field).sort(),
    ['content', 'other', 'thinking'],
    'a reader that answered `content` for everything would pass a single-term check',
  );
  // And the excerpt follows the field, on both sides — a snippet quoted from a text the
  // needle is not in is the failure this whole change exists to remove.
  for (const [label, reply] of [['projection', fromDb], ['artifact', fromDisk]]) {
    for (const hit of reply.matches) {
      assert.ok(hit.snippet?.includes(term),
        `${label}: a hit labelled ${hit.field} has an excerpt without the needle: ${hit.snippet}`);
    }
  }
  assert.deepEqual(
    fromDisk.matches.filter((hit) => hit.matchedToolCall).map((hit) => hit.matchedToolCall),
    ['args'],
    'the artifact path does not say which half of the tool call matched',
  );
});
