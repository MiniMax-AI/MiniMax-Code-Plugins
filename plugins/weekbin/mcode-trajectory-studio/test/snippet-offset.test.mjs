/**
 * The excerpt a match is quoted with, and the case rule the match itself is found by.
 *
 * Two layers are checked here because they disagree about case, and the disagreement
 * is the defect.
 *
 * **SQL layer.** `findEvents` selects its rows with `data_json LIKE ?`. SQLite's
 * `LIKE` folds ASCII and nothing else: `LIKE '%matters%'` finds "MATTERS", and
 * `LIKE '%ı%'` does not find "I". So the set of rows returned is already decided by a
 * rule the JavaScript side does not share.
 *
 * **JavaScript layer.** The excerpt was located by `text.toLowerCase().indexOf(...)`
 * and the *original* string was sliced at that offset. Folding is not
 * length-preserving — `İ` (U+0130) becomes two characters — so the offset belonged to
 * a different string than the one being cut. In "İstanbul matters" the hit is quoted
 * as "atters": the match itself, missing its first character, handed over as the
 * answer.
 *
 * Not hypothetical. `İ` appears in 16 of the most recent 20000 message rows on the
 * machine this was measured on.
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '../server/store.mjs';

const dirs = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/**
 * A real projection, because the point is what SQLite does with `LIKE` — a stub would
 * answer whatever the stub was written to answer, which is the mistake this file is
 * about.
 */
async function storeWith(text, { thinking = false, extra = [] } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'snippet-'));
  dirs.push(dataDir);
  await mkdir(path.join(dataDir, 'v2', 'sqlite'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  db.exec(`
    CREATE TABLE local_runtime_sessions (
      session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
      agent_name TEXT, session_type TEXT, status TEXT, archived INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'visible', session_kind TEXT NOT NULL DEFAULT 'unknown',
      parent_session_id TEXT, workspace_dir TEXT, title TEXT, created_at_ms INTEGER
    );
    CREATE TABLE local_runtime_message_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, msg_id TEXT NOT NULL,
      role TEXT, turn_id TEXT, created_at_ms INTEGER NOT NULL, data_json TEXT NOT NULL,
      source TEXT, UNIQUE(session_id, msg_id)
    );
    INSERT INTO local_runtime_sessions
      (session_id, record_json, updated_at_ms, title, created_at_ms)
      VALUES ('s1', '{}', 1, 'T', 1);
    INSERT INTO local_runtime_message_rows
      (session_id, msg_id, role, turn_id, created_at_ms, data_json)
      VALUES ('s1', 'm1', 'assistant', 't1', 1, '{}');
  `);
  // A second row carries the text under test, so the first row's `{}` cannot satisfy
  // a search for any word in it.
  db.prepare(`
    INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json)
    VALUES (?, 'm2', 'assistant', 't2', 2, ?)
  `).run('s1', JSON.stringify(thinking
    ? { role: 'assistant', thinking_content: text }
    : { role: 'assistant', msg_content: text }));
  // Extra rows are seeded here rather than after the store opens: the projection is
  // opened strictly read-only, so a test that tried to insert through it would be
  // testing its own mistake rather than the search.
  for (const [id, body] of extra) {
    db.prepare(`
      INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json)
      VALUES ('s1', ?, 'assistant', ?, 9, ?)
    `).run(id, id, JSON.stringify({ role: 'assistant', msg_content: body }));
  }
  db.close();
  const store = openStore({ dataDir });
  return store;
}

async function excerptFor(text, needle, options = {}) {
  const store = await storeWith(text, options);
  try {
    const result = store.findEvents
      ? store.findEvents({ sessionId: 's1', query: needle, detailLevel: 'full', limit: 10, offset: 0 })
      : null;
    return result?.matches?.find((m) => m.field !== 'other')?.snippet;
  } finally {
    store.close();
  }
}

/* --------------------------------------------- the offset belongs to the wrong string -- */

/**
 * Text long enough that the excerpt window is narrower than the text.
 *
 * `SNIPPET_RADIUS` is 160 characters either side, so a snippet of a 16-character line
 * is the whole line no matter where it is cut. Both the corrected search and the
 * broken one returned the identical string, and the assertions below passed — not
 * because the fix works but because there was nothing left to cut. Every case here
 * pads past `SNIPPET_RADIUS * 2` so the window has to choose, and choosing differently
 * is what the defect does.
 */
const FILLER = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(6);

function padded(prefix, needle, suffix) {
  return `${FILLER}${prefix}${needle}${FILLER.slice(0, 120)}${suffix ?? ''}`;
}

test('a match is quoted in full when an earlier character folds to a longer form', async () => {
  const snippet = await excerptFor(padded('İstanbul ', 'matters'), 'matters');
  assert.ok(snippet, 'a real match went unreported');
  assert.ok(snippet.includes('matters'),
    `the excerpt cut the match itself: ${JSON.stringify(snippet)}`);
  // And the window really is narrower than the text, or this proves nothing again.
  assert.ok(snippet.length < padded('İstanbul ', 'matters').length,
    'the excerpt covered the whole text, so no offset could have been wrong');
});

test('the drift accumulates with each such character', async () => {
  const snippet = await excerptFor(padded('İİİ alpha beta ', 'gamma'), 'gamma');
  assert.ok(snippet?.includes('gamma'), `the match was cut: ${JSON.stringify(snippet)}`);
});

test('the window is placed at the match, not merely wide enough to contain it', async () => {
  // The control for the two above. If the excerpt merely *contained* the needle, a
  // window shifted by one character would still pass; requiring the exact characters
  // around it pins where the window starts.
  //
  // The trailing text is placed immediately after the match rather than after another
  // filler block, so "the seven characters after the match" are observable. With the
  // filler in between they fell outside the window and this assertion could not be
  // made at all.
  const head = 'BEFORE-TAG ';
  const tail = ' AFTER-TAG';
  const text = `${FILLER}${head}NEEDLE${tail}${FILLER}`;
  const snippet = await excerptFor(text, 'needle');
  assert.ok(snippet, 'the match was missed');
  assert.ok(snippet.includes('BEFORE-TAG NEEDLE AFTER-TAG'),
    `the window did not line up with the match: ${JSON.stringify(snippet)}`);
  assert.ok(snippet.length < text.length,
    'the excerpt covered the whole text, so no offset could have been wrong');
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'),
    'a window taken from the middle should say it is cut at both ends');
});

test('the window starts at the match, checked by its boundary rather than its contents', async () => {
  // The assertion that actually distinguishes the two implementations.
  //
  // Every other check here asks whether the excerpt *contains* the needle, and it does
  // either way: a window shifted by one character still covers the match, because the
  // radius is 160 characters either side and the match is six. So "contains" cannot
  // see this defect at all, and the test file passed green against the broken search.
  //
  // What differs is where the window begins — one character earlier or later — so this
  // compares the excerpt against one built from an independently computed offset. The
  // case is arranged so both a case-insensitive match and a drifting character are
  // needed at once: `NEEDLE` against the needle `needle` forces the fold, and the `İ`
  // before it makes the fold change the length.
  const head = 'İstanbul notes ';
  const tail = ' AFTER-TAG';
  const text = `${FILLER}${head}NEEDLE${tail}${FILLER}`;
  const needle = 'needle';
  const folded = needle.toLowerCase();

  // The offset a correct implementation must find: walk the original, comparing each
  // candidate slice folded on both sides.
  let expectedAt = -1;
  for (let at = 0; at + needle.length <= text.length; at += 1) {
    if (text.slice(at, at + needle.length).toLowerCase() === folded) { expectedAt = at; break; }
  }
  assert.ok(expectedAt > 0, 'the fixture does not contain the needle');
  // And it must differ from the drifted one, or this test cannot tell them apart.
  const driftedAt = text.toLowerCase().indexOf(folded);
  assert.notEqual(driftedAt, expectedAt,
    'the folded and true offsets coincide, so this case cannot detect the drift');

  const radius = 160;
  const from = Math.max(0, expectedAt - radius);
  const to = Math.min(text.length, expectedAt + needle.length + radius);
  const expected = (from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '');

  const store = await storeWith(text);
  try {
    const result = store.findEvents({ sessionId: 's1', query: needle, detailLevel: 'full', limit: 10, offset: 0 });
    const snippet = result.matches.find((m) => m.snippet)?.snippet;
    assert.equal(snippet, expected,
      `the excerpt window is not where the match is: got ${JSON.stringify(snippet?.slice(0, 40))}`);
  } finally {
    store.close();
  }
});

test('the same text is quoted when it lives in thinking', async () => {
  const snippet = await excerptFor(padded('İstanbul ', 'matters'), 'matters', { thinking: true });
  assert.ok(snippet?.includes('matters'), `thinking excerpt cut the match: ${JSON.stringify(snippet)}`);
});

/* ---------------------------------------------------------- the ordinary cases -- */

test('an ASCII match is quoted in full', async () => {
  // The control: the common case must keep working exactly as before, or this fix has
  // traded one wrong answer for another.
  const snippet = await excerptFor('The quick brown fox jumps', 'brown');
  assert.ok(snippet?.includes('brown'), `ASCII matching broke: ${JSON.stringify(snippet)}`);
});

test('a lowercase ASCII needle finds an uppercase occurrence', async () => {
  const snippet = await excerptFor('Deploy the PRODUCTION branch', 'production');
  assert.ok(snippet, 'SQLite LIKE does not fold ASCII case, or the needle never matched');
  assert.ok(snippet.includes('PRODUCTION'), `wrong excerpt: ${JSON.stringify(snippet)}`);
});

test('a non-ASCII needle matches an occurrence that differs only in case', async () => {
  const snippet = await excerptFor('Der TURKGÜRTEL liegt im Şark', 'turkgürtel');
  assert.ok(snippet, 'a non-ASCII needle stopped matching');
  assert.ok(snippet.includes('TURKGÜRTEL'), `wrong excerpt: ${JSON.stringify(snippet)}`);
});

test('a needle that genuinely is not present yields no excerpt', async () => {
  // The control for the other direction: matching harder must not invent a hit.
  assert.equal(await excerptFor('İstanbul matters', 'zzz-not-here'), undefined);
});

test('wildcards in the needle are matched literally', async () => {
  // `LIKE` would otherwise treat these as a pattern that matches everything, which is
  // a "search" that returns the session rather than an answer.
  assert.equal(await excerptFor('a real line', '%'), undefined);
  assert.equal(await excerptFor('a real line', '_'), undefined);
});

/* --------------------------------------------- a partial match, not only an empty one -- */

test('a needle that matches some rows by ASCII and others only by Unicode gets them all', async () => {
  // The case the first version of this fix missed, and the worse of the two.
  //
  // Firing the Unicode pass only when `LIKE` returned *nothing* looks sufficient:
  // a query whose only match needed non-ASCII folding is invisible, so the pass runs.
  // But a session holding both "the şark city" and "the ŞARK city" answers the needle
  // "şark" with one row from `LIKE` — the first — so the guard does not fire and the
  // reply carries `total: 1` for a query with two matches.
  //
  // A partial match is worse than a total miss: a miss reads as an absence the reader
  // can question, a partial reads as a *count*, and a count is believed.
  const store = await storeWith('the şark city', {
    extra: [['m3', 'the ŞARK city']],
  });
  try {
    const result = store.findEvents({ sessionId: 's1', query: 'şark', detailLevel: 'summary', limit: 10, offset: 0 });
    assert.equal(result.total, 2,
      `a partial match reported a confident wrong count: ${result.total}`);
    assert.equal(result.matches.length, 2);
    assert.equal(result.unindexedCaseMatch, true);
  } finally {
    store.close();
  }
});

test('the second pass is skipped entirely for an all-ASCII needle', async () => {
  // The cost control. `LIKE` folds ASCII, so an ASCII needle is already correct and
  // the scan would buy nothing; running it on every English query would make a 227 ms
  // scan the price of every search.
  const store = await storeWith('the needle is here and the NEEDLE is there');
  try {
    const result = store.findEvents({ sessionId: 's1', query: 'NEEDLE', detailLevel: 'summary', limit: 10, offset: 0 });
    assert.equal(result.total, 1, 'LIKE should have answered this one on its own');
    assert.equal(result.unindexedCaseMatch, undefined,
      'an ASCII query paid for a scan it did not need');
  } finally {
    store.close();
  }
});

test('a single-case non-ASCII needle does not pay for the scan either', async () => {
  // `é` folds to itself and Chinese has no case at all, so `LIKE`'s byte comparison
  // already agrees with JavaScript. Firing on these would make a full scan the price
  // of every Chinese query, which is the most common non-ASCII query there is.
  const store = await storeWith('轨迹回放排查 done');
  try {
    const result = store.findEvents({ sessionId: 's1', query: '轨迹', detailLevel: 'summary', limit: 10, offset: 0 });
    assert.equal(result.total, 1);
    assert.equal(result.unindexedCaseMatch, undefined,
      'a needle with no case variants paid for a scan that could not find anything new');
  } finally {
    store.close();
  }
});

/* ----------------------------------------- the answer says which path answered -- */

async function findIn(text, needle) {
  const store = await storeWith(text);
  try {
    return store.findEvents({ sessionId: 's1', query: needle, detailLevel: 'full', limit: 10, offset: 0 });
  } finally {
    store.close();
  }
}

test('an ordinary ASCII query does not report a scan', async () => {
  const result = await findIn('Deploy the PRODUCTION branch', 'production');
  assert.equal(result.total, 1);
  assert.equal(result.unindexedCaseMatch, undefined,
    'the cheap indexed path answered, yet the reply claims a scan happened');
});

test('a query only the Unicode pass can see says so', async () => {
  // The cost differs by an order of magnitude between the two paths, so the caller
  // gets to know which one ran rather than discovering it as a slow call.
  const result = await findIn('Der TURKGÜRTEL liegt im Şark', 'turkgürtel');
  assert.equal(result.total, 1);
  assert.equal(result.unindexedCaseMatch, true);
});

test('a query that matches nothing reports no scan and no matches', async () => {
  const result = await findIn('Der Turkgürtel liegt im Şark', 'zzz-not-here');
  assert.equal(result.total, 0);
  assert.equal(result.matches.length, 0);
  assert.equal(result.unindexedCaseMatch, undefined,
    'a scan that found nothing still claimed one ran');
});

test('the Unicode pass numbers its hits the way the event read numbers records', async () => {
  // `index` is how a caller reaches the record — SKILL.md tells the model to read a hit
  // with `offset: hit.index` rather than paging to find it — and *two* implementations
  // produce that number: `getEvents`'s window, and `unicodeCaseScan`'s `ROW_NUMBER`.
  // They are separate SQL written separately. If they drift, every match the second one
  // found becomes a pointer to the wrong record, which is worse than not finding it at
  // all: a missing answer can be questioned, a wrong one gets acted on.
  //
  // The needle is `şark` against stored `ŞARK`, so the indexed `LIKE` — which folds ASCII
  // case and nothing else — finds nothing and the JavaScript pass answers.
  //
  // This test used to carry this name while running the *other* path. Its needle was
  // `i` + U+0307 + `stanbul`, which matches the stored bytes exactly, and it asserted
  // `unindexedCaseMatch === undefined`: it was proving the indexed path skips the scan,
  // under a name that promised it was checking the scan's numbering. The property was
  // untested. The `İ` behaviour it was really about is kept below, renamed to say so.
  const store = await storeWith('the ŞARK city', {
    extra: [['m3', 'a quiet record'], ['m4', 'another quiet one']],
  });
  try {
    const found = store.findEvents({ sessionId: 's1', query: 'şark', detailLevel: 'summary', limit: 10, offset: 0 });
    assert.equal(found.unindexedCaseMatch, true,
      'the indexed path answered, so this is not exercising the numbering it claims to check');
    assert.equal(found.total, 1);

    const hit = found.matches[0];
    const page = store.getEvents({ sessionId: 's1', offset: hit.index, limit: 1, detailLevel: 'summary' });
    assert.equal(page.events.length, 1, `offset ${hit.index} addressed no record`);
    assert.equal(page.events[0].index, hit.index, 'the read came back under a different index');
    // Turn identity rather than content: the point is that *this* record is the one the
    // scan pointed at, not merely that some record sits at that offset.
    assert.equal(page.events[0].turnId, hit.turnId,
      `the hit says turn ${hit.turnId}, but offset ${hit.index} holds turn ${page.events[0].turnId}`);
  } finally {
    store.close();
  }
});

test('a needle the index can match byte-for-byte skips the scan entirely', async () => {
  // The behaviour the test above used to cover under a misleading name.
  //
  // `İ` (U+0130) folds to a two-character sequence, so the one-character spelling
  // `i` + U+0307 + `stanbul` is *not* the same string and must not match. That is
  // Unicode's case equivalence, not a defect here — Turkish dotted capital I and English
  // lowercase i are different code points in any standard, and NFC normalisation does not
  // merge them either. A test that expected `istanbul` to find `İstanbul` would be
  // asserting a locale-specific rule this Plugin has no business inventing.
  const needle = 'i̇stanbul';
  const store = await storeWith(`first ${needle} line then a second ${needle} line`);
  try {
    const all = store.findEvents({ sessionId: 's1', query: needle, detailLevel: 'summary', limit: 10, offset: 0 });
    assert.equal(all.total, 1, `expected one row, got ${all.total}`);
    const paged = store.findEvents({ sessionId: 's1', query: needle, detailLevel: 'summary', limit: 1, offset: 0 });
    assert.equal(paged.matches.length, 1);
    assert.equal(paged.matches[0].index, all.matches[0].index,
      'the paged and unpaged reads disagree about which record this is');
    // No scan is claimed, and correctly so: this needle already matches the stored bytes
    // exactly, so the indexed path answered. The flag reports which path ran — it is not
    // a claim about non-ASCII content.
    assert.equal(all.unindexedCaseMatch, undefined);
  } finally {
    store.close();
  }
});

test('a needle that differs only by an unmappable case pair is reported absent', async () => {
  // The other direction, and the reason the test above uses the folded spelling: the
  // one-character spelling is not a case variant of `İ`, so it is correctly not a
  // match. Asserted so the behaviour is chosen rather than inherited.
  const store = await storeWith('İstanbul line');
  try {
    const result = store.findEvents({ sessionId: 's1', query: 'istanbul', detailLevel: 'summary', limit: 10, offset: 0 });
    assert.equal(result.total, 0);
  } finally {
    store.close();
  }
});
