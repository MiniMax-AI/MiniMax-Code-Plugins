/**
 * Session search over the runtime's FTS5 index.
 *
 * The index is not tokenised the way a reader would expect: it stores each
 * character as a `c<hex codepoint>` token, so "轨迹" is indexed as "c8f68 c8ff9".
 * A query must be re-encoded into that form or `MATCH` always returns nothing.
 */

import { LIMITS, clamp } from './config.mjs';
import { sessionSummary } from './sessions.mjs';

/** Encode a user query into the token form the runtime's FTS5 index stores. */
export function encodeFtsQuery(query) {
  const tokens = [];
  for (const char of String(query)) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code <= 0x20) continue;
    tokens.push(`c${code.toString(16)}`);
  }
  return tokens.join(' ');
}

/** Sessions whose metadata matches the query, newest first. */
export function searchSessions(store, { query, limit = LIMITS.search.default } = {}) {
  if (!store.db || !store.hasFts || !query) return [];
  const encoded = encodeFtsQuery(query);
  if (!encoded) return [];
  try {
    return store.db.prepare(`
      SELECT s.* FROM local_runtime_sessions_fts f
      JOIN local_runtime_sessions s ON s.session_id = f.session_id
      WHERE local_runtime_sessions_fts MATCH ?
      ORDER BY s.updated_at_ms DESC
      LIMIT ?
    `).all(encoded, clamp(limit, LIMITS.search)).map(sessionSummary);
  } catch (error) {
    store.warn(`search_failed:${error.message}`);
    return [];
  }
}
