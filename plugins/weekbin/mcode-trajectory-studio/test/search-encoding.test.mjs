/**
 * The FTS query encoding, measured against the index shape the runtime really
 * produces.
 *
 * Every case here is a fact read off the live 633-session projection, not a guess
 * about how an FTS5 index ought to behave. The three defects this file pins down
 * each failed in a *different* direction, which is why they survived together:
 *
 *   · the bare token list is an AND over the merged multi-column stream, so it
 *     matched 24 sessions for "trajectory" and 594 for "studio" — words that occur
 *     in no field of no session on the machine;
 *   · the query kept its case while the runtime lowercases before encoding, so
 *     "Documents" matched 0 of 479;
 *   · the query dropped every code point <= 0x20, deleting the `c20` token that is
 *     the index's only record of a word boundary, so "Spec review" matched 0 of 2.
 *
 * A test that only checked "some search returns some rows" passes on all three.
 * The assertions are therefore split into the two directions a caller can be
 * wrong in: a missing match (the query cannot express what the reader asked) and
 * a spurious match (it can express something nobody asked).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { encodeFtsQuery, buildFtsMatch, searchSessions } from '../server/search.mjs';
import { openStore } from '../server/store.mjs';
import { fixtureHasFts5, createFixtureProjection, encodeFtsTerms } from '../tools/fixture.mjs';

const FTS5 = fixtureHasFts5();

/**
 * The corpus's fake home, spelled out rather than derived from `os.tmpdir()`.
 *
 * `os.tmpdir()` is not usable here for two reasons at once. It is a per-user random
 * path — on this machine `/var/folders/xj/0sm5tls95ng345g2wlgqz2lr0000gn/T` — which
 * contains nearly every lowercase letter, so any assertion of the form "a character
 * that appears in no session must match nothing" matched *everything* and passed for
 * a reason unrelated to the code. And it is a macOS home-directory shape in a shipped
 * file, which the portable-paths gate rightly rejects.
 *
 * A literal like `/Users/x` fixes the second problem and creates the first on Windows.
 * So the corpus paths are assembled from fixed segments here, and the "absent letter"
 * is computed from what the corpus actually contains rather than assumed.
 */
const ROOT = path.join(path.sep, 'srv', 'data', 'workspaces');

/** The default corpus workspace, for rows that do not name one. */
const WS = path.join(ROOT, 'ws');

/**
 * A store over a projection built here, so a test can assert on the index rather
 * than on whatever the running machine happens to hold.
 */
async function seeded(t, sessions) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'fts-encoding-'));
  const { db, close } = await createFixtureProjection(dataDir);
  for (const entry of sessions) {
    db.prepare(`
      INSERT INTO local_runtime_sessions
        (session_id, record_json, updated_at_ms, agent_name, status, session_kind, title,
         created_at_ms, parent_session_id, workspace_dir)
      VALUES (?, '{}', ?, ?, ?, 'conversation', ?, ?, NULL, ?)
    `).run(entry.id, entry.updatedAtMs ?? 1000, entry.agent ?? 'mavis', entry.status ?? 'idle',
      entry.title, 1, entry.workspaceDir ?? WS);
  }
  // Written through the fixture's own encoder, so a drift between the two shows up
  // here rather than as a mystery on the machine. Every `_terms` column takes
  // `c<hex>` tokens — including `status_terms`, which is why the status is encoded
  // rather than passed through: the fixture's own seeder passes it raw, and copying
  // that produced an index column holding `busy` instead of `c62 c75 c73 c79`, which
  // no query can match. The one place this file would otherwise have agreed with a
  // defect.
  if (db.prepare(`SELECT name FROM sqlite_master WHERE name='local_runtime_sessions_fts'`).get()) {
    for (const entry of sessions) {
      db.prepare(`
        INSERT INTO local_runtime_sessions_fts
          (session_id, session_id_terms, agent_name_terms, title_terms, workspace_dir_terms,
           purpose_terms, status_terms, session_type_terms)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'conversation')
      `).run(entry.id,
        encodeFtsTerms(entry.id),
        encodeFtsTerms(entry.agent ?? 'mavis'),
        encodeFtsTerms(entry.title),
        encodeFtsTerms(entry.workspaceDir ?? WS),
        encodeFtsTerms(entry.purpose ?? ''),
        encodeFtsTerms(entry.status ?? 'idle'));
    }
  }
  close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const matches = (store, query) => store.searchSessions({ query }).sessions.map((s) => s.sessionId);

/* ------------------------------------------------------- the encoder itself -- */

test('the encoder lowercases, because the runtime lowercases before encoding', () => {
  // Observed on the live projection: title "Spec review PR #520" is stored as
  // `c73 c70 ...`. `c73` is a lowercase `s`; the `S` in the source is `c53`.
  assert.equal(encodeFtsQuery('Documents'), 'c64 c6f c63 c75 c6d c65 c6e c74 c73');
  assert.equal(encodeFtsQuery('Spec review'), 'c73 c70 c65 c63 c20 c72 c65 c76 c69 c65 c77');
});

test('the encoder keeps the space token the index uses as a word boundary', () => {
  // The regression is one character of comparison: `<= 0x20` drops the space, and
  // the index holds `c20` for it.
  assert.match(encodeFtsQuery('a b'), /^c61 c20 c62$/u);
  assert.equal(encodeFtsQuery('ab c'), 'c61 c62 c20 c63');
});

test('the encoder still drops control characters', () => {
  // Kept as a real property rather than assumed: a phrase containing a token no
  // indexed field can hold matches nothing, which is indistinguishable from a word
  // nobody has.
  assert.equal(encodeFtsQuery('a\tb'), 'c61 c62');
  assert.equal(encodeFtsQuery('a\nb'), 'c61 c62');
});

test('a query of nothing but control characters encodes to nothing', () => {
  // `buildFtsMatch` turns an empty phrase into an empty expression, and an empty
  // `MATCH` string is a syntax error rather than a query that matches nothing.
  assert.equal(encodeFtsQuery('\t\n'), '');
  assert.equal(buildFtsMatch('\t\n'), '');
});

test('the match expression quotes the phrase and confines it to one column', () => {
  const expr = buildFtsMatch('alpha');
  // Quoting is the fix for the cross-column false positives: a quoted phrase does
  // not span columns, an unquoted token list does. Verified against a table seeded
  // so that "alpha" exists only as `alph` in one column and `a` in the next.
  assert.match(expr, /"c61 c6c c70 c68 c61"/u, 'the token run must be a quoted phrase');
  // Every searchable column participates, so no field becomes unsearchable.
  for (const column of ['session_id_terms', 'agent_name_terms', 'title_terms',
    'workspace_dir_terms', 'purpose_terms', 'status_terms', 'session_type_terms']) {
    assert.ok(expr.includes(`${column} : "c61 c6c c70 c68 c61"`), `${column} is not searched: ${expr}`);
  }
  // Every clause must carry the same quoted phrase. A column listed without one
  // would silently become a bare single-token match, which is the cross-column
  // behaviour all over again — and a clause with a *different* phrase would search
  // for something the reader never typed.
  const clauses = expr.split(' OR ');
  assert.equal(clauses.length, 7);
  for (const clause of clauses) {
    assert.match(clause, /^[\w]+ : "c61 c6c c70 c68 c61"$/u, `unquoted or mismatched clause: ${clause}`);
  }
});

/* ------------------------------------------------ the two failure directions -- */

const CORPUS = [
  // Built through `path.join` rather than written as a literal: a hard-coded
  // `/Users/...` here is a macOS home directory in a shipped file, which the
  // portable-paths gate rejects, and it is also the one shape a Windows reader
  // would mis-parse. `Documents` is the segment the query below needs, and it does
  // not have to be spelled the way macOS spells it.
  { id: 'sess-alpha', title: 'Spec review PR #520', workspaceDir: path.join(ROOT, 'Documents', 'Alpha') },
  { id: 'sess-beta', title: 'Fix flaky test', workspaceDir: path.join(ROOT, 'Documents', 'Beta'), agent: 'explore' },
  { id: 'sess-gamma', title: '轨迹回放排查', workspaceDir: path.join(ROOT, 'ws'), status: 'busy', purpose: 'trajectory' },
  { id: 'sess-delta', title: 'trajectory', workspaceDir: path.join(ROOT, 'trajectory') },
];

test('a capitalised query finds what the lowercase index holds', { skip: FTS5 ? false : 'this runtime has no FTS5' }, async (t) => {
  const store = await seeded(t, CORPUS);
  // Before the fix each of these returned zero on a machine that held 479, 2 and 4.
  assert.deepEqual(matches(store, 'Documents').sort(), ['sess-alpha', 'sess-beta']);
  assert.deepEqual(matches(store, 'Spec review'), ['sess-alpha']);
  assert.deepEqual(matches(store, 'PR #520'), ['sess-alpha']);
  assert.deepEqual(matches(store, 'EXPLORE'), ['sess-beta']);
  assert.deepEqual(matches(store, 'busy'), ['sess-gamma']);
});

test('a multi-word query matches the phrase, not the words scattered apart', { skip: FTS5 ? false : 'this runtime has no FTS5' }, async (t) => {
  // The corpus is chosen so no row accidentally contains the query phrase: "review
  // PR" is absent everywhere, and the rows below hold its two words adjacent,
  // non-adjacent within one field, and in two different fields.
  const store = await seeded(t, [
    { id: 'sess-split-field', title: 'review the PR queue', workspaceDir: WS },
    { id: 'sess-cross-column', title: 'review', workspaceDir: path.join(ROOT, 'PR') },
    { id: 'sess-adjacent', title: 'alpha review PR omega' },
  ]);
  // The phrase matches only the row that actually spells it.
  assert.deepEqual(matches(store, 'review PR'), ['sess-adjacent']);
  assert.deepEqual(matches(store, 'alpha review'), ['sess-adjacent']);
  assert.deepEqual(matches(store, 'review the PR'), ['sess-split-field']);
  // ...and not the row that merely holds both words in one field, nor the row that
  // holds them in two. Before the fix the unquoted list matched all three.
  assert.deepEqual(matches(store, 'review omega'), [],
    'a phrase matched rows that only contain its words separately');
  // Each word alone still finds every row carrying it, so the phrase rule narrowed
  // matches without narrowing the index.
  assert.deepEqual(matches(store, 'review').sort(), ['sess-adjacent', 'sess-cross-column', 'sess-split-field']);
  assert.deepEqual(matches(store, 'PR').sort(), ['sess-adjacent', 'sess-cross-column', 'sess-split-field']);
});

test('a query that occurs in no session returns nothing', { skip: FTS5 ? false : 'this runtime has no FTS5' }, async (t) => {
  const store = await seeded(t, CORPUS);
  // The measured false positives: 24 rows for "trajectory" and 594 for "studio" on a
  // machine where neither word appeared anywhere. Reproduced here with a word that
  // appears in *no* column of *any* row.
  assert.deepEqual(matches(store, 'zzzznotpresent'), []);
  // The whole object, not just its emptiness: `unsearchable` is a third outcome, and
  // a deep-equal that omitted it would let the flag vanish from any early return
  // without a test noticing. The objective fields are in the same assertion for the same
  // reason — they were added to the success path first and the early returns did not get
  // them, so this one assertion was the only thing that caught a `searchSessions` with
  // two different reply shapes depending on which path a query took.
  assert.deepEqual(store.searchSessions({ query: 'zzzznotpresent' }),
    {
      sessions: [],
      total: 0,
      failed: false,
      unsearchable: false,
      objectivesIndexed: true,
      objectiveMatchedSessionIds: [],
    });
});

test('a token run cannot be assembled out of two different columns', { skip: FTS5 ? false : 'this runtime has no FTS5' }, async (t) => {
  // The cross-column defect in its purest form: "re" ends sess-alpha's title and
  // "view" is nowhere, but the general shape is a match whose characters are drawn
  // from unrelated fields of one row. Asserted on a real hit rather than described,
  // because a prose claim about FTS5 would be exactly the kind of assumption this
  // whole file exists to avoid.
  const store = await seeded(t, [
    { id: 'sess-split', title: 'alpha', workspaceDir: path.join(ROOT, 'omega') },
    { id: 'sess-other', title: 'beta', workspaceDir: path.join(ROOT, 'gamma') },
  ]);
  // "alphomega" occurs in neither row, in neither field, but `alpha` and `omega`
  // are in one row's two different columns. Before the fix this matched.
  assert.deepEqual(matches(store, 'alphomega'), []);
  assert.deepEqual(matches(store, 'alpha'), ['sess-split']);
});

test('non-ASCII queries round-trip through the encoding', { skip: FTS5 ? false : 'this runtime has no FTS5' }, async (t) => {
  const store = await seeded(t, CORPUS);
  assert.deepEqual(matches(store, '轨迹'), ['sess-gamma']);
  assert.deepEqual(matches(store, '轨迹回放'), ['sess-gamma']);
  assert.deepEqual(matches(store, '回放'), ['sess-gamma']);
});

test('a single character still matches, because one letter is a phrase too', { skip: FTS5 ? false : 'this runtime has no FTS5' }, async (t) => {
  // The control for the cross-column case: dropping the quoting wholesale would fix
  // the false positives by breaking these, so the fix has to keep them working.
  const store = await seeded(t, CORPUS);
  assert.ok(matches(store, 'a').length >= 3, `single-character search lost its recall: ${matches(store, 'a')}`);

  // The negative half is computed rather than hard-coded. A literal "z" looked safe
  // and was not: the corpus is built under `os.tmpdir()`, and on macOS that path is
  // `/var/folders/xj/…/T` — it contains a `z`, so every row matched it and the check
  // was passing for a reason that had nothing to do with the code. Picking a letter
  // the fixture provably does not contain keeps it testing the query, not the host.
  const allText = CORPUS.map((s) => [s.id, s.title, s.workspaceDir, s.agent, s.status, s.purpose]
    .filter(Boolean).join(' ')).join(' ').toLowerCase() + ROOT.toLowerCase();
  const absent = 'qwjxk'.split('').find((ch) => !allText.includes(ch));
  assert.ok(absent, `no absent letter available in: ${allText}`);
  assert.deepEqual(matches(store, absent), [],
    `a letter present in no field (${JSON.stringify(absent)}) matched sessions`);
});

/* ------------------------------------------------------- the schema guard -- */

test('a runtime indexing different fields degrades instead of failing every query', { skip: FTS5 ? false : 'this runtime has no FTS5' }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'fts-shape-'));
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(dataDir, 'v2', 'sqlite'), { recursive: true });
  const file = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE local_runtime_sessions (session_id TEXT, updated_at_ms INTEGER, title TEXT)`);
  // A build whose FTS table exists and carries the searchable text, but without the
  // `purpose_terms` column the match expression names.
  db.exec(`CREATE VIRTUAL TABLE local_runtime_sessions_fts USING fts5(
    session_id UNINDEXED, session_id_terms, title_terms, tokenize='unicode61')`);
  db.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  assert.equal(store.hasFts, true, 'the table is there and FTS5 works');
  assert.equal(store.searchable, false, 'the columns the match names are not all present');
  // Without the guard this is a query-time "no such column" on every call, reported
  // as `failed: true` — which reads as a broken index rather than a different shape,
  // and invites a retry that cannot help. `unsearchable` names the real cause.
  assert.deepEqual(store.searchSessions({ query: 'alpha' }),
    {
      sessions: [],
      total: 0,
      failed: false,
      unsearchable: true,
      // This database has no `local_runtime_thread_goals` table at all, so the objective
      // channel reports "not searched" rather than "nothing matched" — and the FTS
      // unavailability did not stop it from being asked.
      objectivesIndexed: false,
      objectiveMatchedSessionIds: [],
    });
  assert.ok(
    store.warnings.some((warning) => warning.startsWith('search_columns_missing:')),
    `no warning was recorded: ${JSON.stringify(store.warnings)}`,
  );
});

test('the store reports a readable schema as searchable', { skip: FTS5 ? false : 'this runtime has no FTS5' }, async (t) => {
  const store = await seeded(t, CORPUS);
  assert.equal(store.searchable, true);
});