/**
 * Session search over the runtime's FTS5 index.
 *
 * The index is not tokenised the way a reader would expect: it stores each
 * character as a `c<hex codepoint>` token, so "轨迹" is indexed as "c8f68 c8ff9".
 * A query must be re-encoded into that form or `MATCH` always returns nothing.
 *
 * Three details of the encoding decide whether a search returns the right rows,
 * and each of them was wrong in a way that failed in a different direction:
 *
 * 1. **Lowercase first.** The runtime lowercases the source text before encoding
 *    it, so the index holds `c73` for an `S` that the caller's query spells
 *    `c53`. The tokenizer does not fold case for us — `c`-prefixed hex tokens
 *    contain no uppercase letter to fold, verified against a table seeded both
 *    ways. So a query carrying any capital matched nothing: `Documents`,
 *    `Spec review` and `PR #520` all returned zero on a machine holding 479, 2
 *    and 2 matches respectively.
 * 2. **Keep the space.** Space is indexed as a real token (`c20`), so dropping
 *    every code point `<= 0x20` deleted the index's only record of a word
 *    boundary and made "Spec review" unmatchable against a row containing it.
 * 3. **Quote the phrase.** This is the one that produced *wrong* answers rather
 *    than empty ones. FTS5 indexes a multi-column table as a single merged token
 *    stream, so the unquoted token list this used to emit is a bare AND — and an
 *    AND over a merged stream is satisfied by characters drawn from *different*
 *    columns. "trajectory" matched 24 sessions and "studio" 594, on a machine
 *    where the literal word occurs in no field of any session: the tail of one
 *    word and the head of another, in unrelated fields, happened to line up.
 *
 *    Quoting alone closes that: a quoted phrase does not span columns. Measured on
 *    a table seeded so that "alpha" exists only as `alph` in one column and `a`
 *    in the next — the unquoted form matched that row, the quoted form does not.
 *    The per-column restriction below is kept as well, so a hit is by construction
 *    inside a field the runtime indexes rather than anywhere in the merged stream,
 *    but the quoting is what does the work.
 *
 * Verified against the live index on a 633-session machine: 14 representative
 * needles (mixed case, spaces, punctuation, CJK, single characters, and words
 * present in no row) return exactly the sessions whose fields contain the
 * substring — zero false positives, zero false negatives.
 */

import { LIMITS, clamp, normalizeOffset, decodeSessionCursor } from './config.mjs';
import { sessionSummary } from './sessions.mjs';

/**
 * The indexed columns, in the order the runtime's own schema declares them.
 *
 * `session_id` is `UNINDEXED` in that schema — it is the join key, not searchable
 * text — so it is deliberately absent. Searchable identity lives in
 * `session_id_terms` alongside every other field.
 */
export const SEARCHABLE_COLUMNS = [
  'session_id_terms',
  'agent_name_terms',
  'title_terms',
  'workspace_dir_terms',
  'purpose_terms',
  'status_terms',
  'session_type_terms',
];

/**
 * The one answer that means "no sessions, and nothing went wrong".
 *
 * Frozen because it is returned on several early paths and callers may hold it; a caller
 * that mutated it would corrupt every later search that shares the instance.
 *
 * The objective fields are part of it rather than added per path. They were added after
 * the fact and the early returns did not get them, so `searchSessions` had **two reply
 * shapes** depending on which path a query took — and a test written to catch exactly
 * that (`assert.deepEqual` on the whole object, not just its emptiness) was the only
 * thing that noticed. A new field on a reply has to reach every path, including the ones
 * that return nothing.
 */
const EMPTY = Object.freeze({
  sessions: [],
  total: 0,
  failed: false,
  unsearchable: false,
  objectivesIndexed: false,
  objectiveMatchedSessionIds: [],
});

/** Encode a user query into the token form the runtime's FTS5 index stores. */
export function encodeFtsQuery(query) {
  const tokens = [];
  for (const char of String(query).toLowerCase()) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    // Space is a token (`c20`) in the index and must survive. Only control
    // characters are dropped — they are not in any indexed field, and keeping
    // them would produce a phrase no row can match.
    if (code < 0x20) continue;
    tokens.push(`c${code.toString(16)}`);
  }
  return tokens.join(' ');
}

/**
 * The full `MATCH` expression: the encoded phrase, quoted so it matches as a
 * phrase rather than a bare AND, and OR'd across columns so a match must sit
 * inside one field instead of being assembled from several.
 *
 * Quoted and unquoted are not interchangeable here. Every token is a distinct
 * FTS token, so the unquoted form asks for all of them *anywhere* in the merged
 * stream, which is the cross-column false positive described above.
 */
export function buildFtsMatch(query) {
  const phrase = encodeFtsQuery(query);
  if (!phrase) return '';
  return SEARCHABLE_COLUMNS.map((column) => `${column} : "${phrase}"`).join(' OR ');
}

/**
 * Sessions whose recorded **objective** contains the query, as `session_id` keys.
 *
 * A separate channel, deliberately not folded into the FTS query. The index is built by
 * the runtime and its schema has no objective column — verified on the live index,
 * `pragma_table_info` returns session id, agent, title, workspace, purpose, status and
 * type, and nothing else — so there is no way to reach this text through `MATCH`, and the
 * plugin is a read-only consumer of that database.
 *
 * What that costs, measured on the machine this was written against: for five ordinary
 * Chinese queries, **every single goal match was invisible to FTS** (插件 2, 测试 5,
 * 文档 4, 动画 1, 部署 1 — goal-only in all five cases, none also in the index). Over
 * all 15 goal-bearing sessions, **0 of 15 could be found by a word from their own
 * objective**, so "find the run I asked for the plugin audit" had no answer unless the
 * title happened to use the same word — which §8.37 measures as true in 2 of 15.
 *
 * The scan costs **0.07 ms** over the whole table on that machine, against a walk of a
 * 634-row FTS index, so it is not worth optimising into something else.
 *
 * Literal `LIKE`, matching how `trajectory_find` treats a query. Case-insensitivity is
 * the platform's, not a promise made here: the objectives are Chinese on the machine
 * measured and mixed elsewhere.
 *
 * @returns {{ids: string[]|null}} `null` when the table is absent or the query threw,
 *   so a caller can tell "no objective matched" from "objectives were not searched".
 */
export function goalObjectiveMatches(store, query) {
  if (!store.db || typeof query !== 'string' || query.trim() === '') return { ids: null };
  let hasTable = false;
  try {
    hasTable = store.db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='local_runtime_thread_goals'`)
      .get().n > 0;
  } catch {
    return { ids: null };
  }
  if (!hasTable) return { ids: null };
  try {
    const rows = store.db.prepare(`
      SELECT session_id FROM local_runtime_thread_goals
      WHERE objective LIKE ? ESCAPE '\\'
    `).all(`%${escapeLike(query)}%`);
    return { ids: rows.map((row) => String(row.session_id ?? '')).filter(Boolean) };
  } catch {
    return { ids: null };
  }
}

/**
 * Escape the LIKE wildcards so a query containing `%` or `_` matches itself.
 *
 * `trajectory_find` already makes this promise — "the query is literal, `%` and `_` are
 * matched as characters" — and this channel would silently break it for search if it did
 * not. A reader searching for `50%_done` and receiving every objective containing any
 * characters in between is the same failure in a different place.
 */
function escapeLike(value) {
  return String(value).replace(/[\\%_]/gu, (char) => `\\${char}`);
}

/**
 * Sessions whose metadata matches the query, newest first.
 *
 * Returns `failed` alongside the rows because an empty list is the shape of two
 * different answers: "nothing matched" and "the query could not run". Only the
 * second is a problem, and only the second is worth telling a reader — a caller
 * handed `[]` has no way to tell them apart, and would report "no sessions match"
 * for a search that never happened. `store.warn` already recorded it, but that
 * reaches `trajectory_list` and not the search tool that needs it.
 *
 * `total` is the match count independent of the page, and `offset` pages through
 * it. Both exist because the common queries are not selective: "mavis", "studio"
 * and "session" match 594 to 633 of the 633 sessions on a typical machine, so a
 * capped page without a cursor hid 394 to 433 matches that no call could reach,
 * and the reply gave no hint that they were missing. Counting is one index lookup
 * and the rows are the expensive part, so counting first does not cost the caller
 * the page it asked for.
 *
 * An unknown column name in the `MATCH` expression raises at query time, so a
 * runtime that indexes a different column set would turn every search into a
 * `failed` result rather than a wrong one. `hasSearchableColumns` checks the live
 * schema, and the shape mismatch is reported as its own answer rather than as an
 * empty page: "this build indexes different fields" and "your query matched
 * nothing" are different, and only one of them is actionable.
 *
 * `unsearchable` is that third state. It is distinct from `failed` because the
 * difference matters to the caller: `failed` is a query that ran and broke, which
 * may work on the next call, whereas `unsearchable` is a property of the schema
 * that no retry will change. Collapsing it into `failed: false` — an empty list,
 * the shape of "no match" — is the exact confusion this module exists to prevent,
 * and a guard added to prevent one kind of silence created a worse one.
 *
 * @returns {{sessions: object[], total: number, failed: boolean, unsearchable: boolean}}
 */
export function searchSessions(store, { query, limit = LIMITS.search.default, cursor, untilMs, offset = 0 } = {}) {
  // `store.searchable` is absent on a hand-built store object (several tests and the
  // panel's route doubles construct one), so the probe falls back to the live check
  // rather than treating an undefined flag as a refusal.
  if (!query) return EMPTY;
  // No index at all is the *same kind of fact* as an index missing the searched
  // columns below, so it answers the same way. Both are properties of this runtime's
  // SQLite build, and no retry will change either — which is what makes this worth
  // saying out loud rather than returning an empty list.
  //
  // It used to return the bare `EMPTY` here, and that reported "nothing matched" on a
  // machine that cannot search at all: this build of Node bundles SQLite without FTS5,
  // and the panel's three-way banner then fell through to 没有匹配的会话. The MCP
  // surface got it right — `trajectory_search` checks `hasFts` itself and emits
  // `ftsAvailable: false` with a note — so the same store answered two different
  // questions for the same query, one honest and one not. That is the shape to avoid:
  // two places each deciding once whether search is possible.
  // The objective channel does not need FTS5 — it is a plain `LIKE` scan of a table the
  // runtime records goals in. So a machine whose bundled SQLite has no FTS index still
  // gets goal matches, which is not nothing: on the machine this was measured on that is
  // the *only* field carrying what a run was asked to do, and it is exactly the field a
  // reader reaches for when the title is no help. Returning early here would have made
  // the channel useless on the weakest supported runtime, silently.
  const goalOnly = (extra) => ({
    ...EMPTY,
    ...goalChannel(store, query, []),
    ...extra,
  });
  if (!store.db) return goalOnly({ unsearchable: true });
  if (!store.hasFts) return goalOnly({ unsearchable: true });
  const searchable = store.searchable ?? hasSearchableColumns(store);
  if (!searchable) return goalOnly({ unsearchable: true });
  const match = buildFtsMatch(query);
  if (!match) return EMPTY;
  const cap = clamp(limit, LIMITS.search);
  // The same walk contract `listSessions` has, for the same reason: matches come back
  // `updated_at_ms DESC`, and a session written to mid-walk moves above the cursor and
  // is gone from the rest of the walk — while `nextOffset: null` still says the search
  // was complete. `untilMs` is the walk's pinned instant and is applied to *both*
  // queries below, because a `total` computed outside the pin counts matches no page
  // can deliver, which is the one number a caller would have trusted.
  const at = decodeSessionCursor(cursor);
  const bounds = [];
  const boundArgs = [];
  if (at) {
    bounds.push('(s.updated_at_ms < ? OR (s.updated_at_ms = ? AND s.session_id < ?))');
    boundArgs.push(at.updatedAtMs, at.updatedAtMs, at.sessionId);
  }
  if (Number.isFinite(untilMs)) {
    bounds.push('s.updated_at_ms <= ?');
    boundArgs.push(untilMs);
  }
  // Two different questions, and they must not share a `WHERE`. The page is "the rows
  // after this cursor"; the count is "every match in the pinned instant". Letting the
  // cursor reach the count turned `total` into "how many are still ahead of you" —
  // which walks 12, 7, 3, 0 and ends on a page claiming zero matches while the caller
  // is holding eleven of them.
  const pageWhere = bounds.length ? ` AND ${bounds.join(' AND ')}` : '';
  const pinOnly = Number.isFinite(untilMs) ? ' AND s.updated_at_ms <= ?' : '';
  try {
    // The count repeats the page's join rather than counting the FTS table alone:
    // a row whose session is missing from the projection cannot be returned by the
    // page either, so counting it would promise a match no page can deliver.
    const { total } = store.db.prepare(`
      SELECT COUNT(*) AS total FROM local_runtime_sessions_fts f
      JOIN local_runtime_sessions s ON s.session_id = f.session_id
      WHERE local_runtime_sessions_fts MATCH ?${pinOnly}
    `).get(match, ...(Number.isFinite(untilMs) ? [untilMs] : []));
    const sessions = at
      ? store.db.prepare(`
        SELECT s.* FROM local_runtime_sessions_fts f
        JOIN local_runtime_sessions s ON s.session_id = f.session_id
        WHERE local_runtime_sessions_fts MATCH ?${pageWhere}
        ORDER BY s.updated_at_ms DESC, s.session_id DESC
        LIMIT ?
      `).all(match, ...boundArgs, cap).map(sessionSummary)
      // Positional paging is kept for the panel's own search box, which asks for one
      // page and never resumes; a model walks with `cursor` instead.
      : store.db.prepare(`
        SELECT s.* FROM local_runtime_sessions_fts f
        JOIN local_runtime_sessions s ON s.session_id = f.session_id
        WHERE local_runtime_sessions_fts MATCH ?
        ORDER BY s.updated_at_ms DESC, s.session_id DESC
        LIMIT ? OFFSET ?
      `).all(match, cap, normalizeOffset(offset)).map(sessionSummary);
    return { sessions, total, failed: false, unsearchable: false, ...goalChannel(store, query, sessions) };
  } catch (error) {
    store.warn(`search_failed:${error.message}`);
    // The FTS walk failed; the objective channel did not, and it is a plain table scan
    // on the same connection. Dropping it here would lose the one field that works on a
    // machine whose index is the broken part.
    return { ...goalOnly({ failed: true }), unsearchable: false };
  }
}

/**
 * The objective channel's contribution to one reply.
 *
 * Goal matches are **appended to the page**, never woven into `total` or the cursor.
 * `total` is the FTS match count and the walk is an FTS walk; folding a second source
 * into either would make the cursor's meaning depend on which source happened to match,
 * which is the one thing a cursor must never do. The rows that arrive this way say so on
 * their face (`objectiveMatched: true`), so a reader paging by `cursor` can tell them
 * apart from a row the index found.
 *
 * `objectiveMatchedSessionIds` is published separately for the same reason `purpose` is:
 * a caller that wants "did this query reach a field the index does not carry" needs the
 * answer without diffing two lists by hand.
 *
 * `objectivesIndexed: false` is the honest shape for "this build has no goal table", and
 * it is deliberately *not* folded into `ftsAvailable` — the FTS index is present and
 * working; it is a different field that was not searched.
 */
function goalChannel(store, query, sessions) {
  const { ids } = goalObjectiveMatches(store, query);
  if (ids === null) return { objectivesIndexed: false, objectiveMatchedSessionIds: [], sessions };
  if (ids.length === 0) return { objectivesIndexed: true, objectiveMatchedSessionIds: [], sessions };
  const already = new Set(sessions.map((row) => row.sessionId));
  const extraIds = ids.filter((id) => !already.has(id));
  let rows = sessions;
  if (extraIds.length > 0) {
    const placeholders = extraIds.map(() => '?').join(',');
    const added = store.db.prepare(`
      SELECT * FROM local_runtime_sessions
      WHERE session_id IN (${placeholders})
      ORDER BY updated_at_ms DESC, session_id DESC
    `).all(...extraIds).map(sessionSummary);
    rows = [...sessions, ...added];
  }
  return {
    sessions: attachObjective(store, rows, ids),
    objectivesIndexed: true,
    objectiveMatchedSessionIds: ids,
  };
}

/**
 * Attach the matching objective text to the rows the channel found.
 *
 * Without the text, a row marked `objectiveMatched` says only that *something* matched —
 * and the reader still cannot tell what the run was asked to do, which is the entire
 * reason the channel exists. `LIMIT` is per session, and the real table holds one goal
 * per session (0 of 15 held two), so "the newest one" is a defined answer rather than a
 * guess; the objective is bounded by the same egress sweep as every other field.
 */
export function attachObjective(store, sessions, ids) {
  if (!store.db || ids.length === 0) return sessions;
  let hasTable = true;
  try {
    hasTable = store.db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='local_runtime_thread_goals'`)
      .get().n > 0;
  } catch {
    return sessions;
  }
  if (!hasTable) return sessions;
  const wanted = new Set(ids);
  try {
    const rows = store.db.prepare(`
      SELECT session_id, objective FROM local_runtime_thread_goals
      WHERE session_id IN (${ids.map(() => '?').join(',')})
      ORDER BY created_at_ms DESC
    `).all(...ids);
    const seen = new Set();
    const bySession = new Map();
    for (const row of rows) {
      const id = String(row.session_id ?? '');
      if (!wanted.has(id) || seen.has(id)) continue;
      seen.add(id);
      bySession.set(id, row.objective);
    }
    return sessions.map((row) => {
      if (!wanted.has(row.sessionId)) return row;
      const objective = bySession.get(row.sessionId);
      if (objective === undefined) return row;
      return { ...row, objectiveMatched: true, objective };
    });
  } catch {
    return sessions;
  }
}

/**
 * Whether the live FTS table still carries the columns the match expression names.
 *
 * The plugin does not create this table, so its shape is the runtime's to decide.
 * A missing column is not detectable by any other path here: it surfaces as a
 * query-time `no such column` error, which would otherwise turn every search into
 * a `failed: true` reply and read as "the index is broken" rather than "this
 * build indexes different fields".
 */
export function hasSearchableColumns(store) {
  if (!store.db || !store.hasFts) return false;
  try {
    const present = new Set(store.db
      .prepare('PRAGMA table_info(local_runtime_sessions_fts)')
      .all()
      .map((column) => column.name));
    return SEARCHABLE_COLUMNS.every((column) => present.has(column));
  } catch (error) {
    store.warn(`search_schema_unreadable:${error.message}`);
    return false;
  }
}
