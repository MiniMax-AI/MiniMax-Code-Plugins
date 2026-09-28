/**
 * The dsh `sessionStats` fold.
 *
 * One pass over a session's message rows folds every message-level total —
 * including compactions — plus a single join that expands `tool_calls`, and small
 * aggregates over background tasks and assets. Large sessions run to tens of
 * thousands of rows, so the number of expressions here matters far less than the
 * number of scans.
 *
 * The result is cached by the facade against the session's `updated_at_ms`, because
 * browsing revisits the same sessions constantly.
 */

import { num } from './json.mjs';
import { tableExists } from './sqlite.mjs';
import { TURN_KEY_SQL } from './events.mjs';

/** Folded totals for one session, or null when the session is unknown. */
export function getStats(store, sessionId) {
  const session = store.getSession(sessionId);
  if (!store.db || !session) return null;
  // Keyed on the message rows themselves, not on the session's own updated_at_ms:
  // the runtime writes those rows while indexing and does not touch the session
  // row, so a session-scoped key kept serving the totals from before the write.
  return store.cached(store.statsCache, `${sessionId}|${store.messageSignature(sessionId)}`,
    () => computeStats(store, sessionId, session));
}

function computeStats(store, sessionId, session) {
  const agg = rowAggregate(store, sessionId);
  const toolTasks = toolTaskAggregate(store, sessionId);
  const assets = assetAggregate(store, sessionId);

  const llmMs = agg.requestMs;
  const decodeMs = agg.requestMs !== null && agg.thinkingMs !== null
    ? Math.max(0, agg.requestMs - agg.thinkingMs)
    : null;

  return {
    sessionId,
    title: session.title,
    agent: session.agent,
    sessionKind: session.sessionKind,
    status: session.status,
    workspaceDir: session.workspaceDir,
    parentSessionId: session.parentSessionId,
    createdAtMs: session.createdAtMs,
    updatedAtMs: session.updatedAtMs,
    // dsh parity -------------------------------------------------------
    turns: agg.turns,
    steps: agg.steps,
    llmMs,
    toolMs: toolTasks.totalMs,
    // mcode does not persist time-to-first-token, so this stays unavailable
    // rather than being fabricated.
    ttftMs: null,
    ttftAvailable: false,
    decodeMs,
    decodeTokens: agg.outputTokens,
    // ----------------------------------------------------------------
    thinkingMs: agg.thinkingMs,
    inputTokens: agg.inputTokens,
    cacheReadTokens: agg.cacheReadTokens,
    totalTokens: agg.totalTokens,
    contextWindowTokens: agg.contextWindowTokens,
    toolCalls: agg.toolCalls,
    toolFailures: agg.toolFailures,
    events: agg.events,
    // Rows whose `data_json` is not a JSON document, excluded from every total above.
    // Non-zero means those totals describe fewer records than `getEvents` lists.
    unreadableRows: agg.unreadable,
    thinkingEvents: agg.thinkingEvents,
    subagentTasks: toolTasks.subagentCount,
    backgroundTasks: toolTasks.taskCount,
    compactions: agg.compactions,
    compactionFailures: agg.compactionFailures,
    assets: assets.total,
    sources: agg.sources,
    children: session.children.length,
    warnings: [],
  };
}

function rowAggregate(store, sessionId) {
  // Every row is normalised to a parseable document before anything is extracted
  // from it.
  //
  // `json_extract` raises "malformed JSON" on a row whose `data_json` is not a JSON
  // document, and that error aborts the WHOLE statement — not the row. One row, so
  // one truncated write (which is what an interrupted runtime write leaves behind)
  // took the session's turns, events, token totals and tool-call count to zero while
  // `getEvents` still listed every record. The reader was told the session was empty
  // and shown it full of records at the same time.
  //
  // Substituting `{}` for an unparseable row makes the row contribute nothing, which
  // is the honest answer for a record whose contents cannot be read, and leaves every
  // other row counted. `json_valid` is also what lets `unreadable` report how many rows
  // were skipped, so the gap is stated rather than hidden behind a plausible total.
  const expr = (jsonPath) => `json_extract(data_json, '${jsonPath}')`;
  const sql = `
    WITH rows AS (
      SELECT
        -- Aliased back to data_json, because the turn-key expression reads that name
        -- and the column name is what keeps this fold and the event projection reading
        -- the same document.
        CASE WHEN json_valid(data_json) THEN data_json ELSE '{}' END AS data_json,
        turn_id,
        json_valid(data_json) AS readable
      FROM local_runtime_message_rows
      WHERE session_id = ?
    )
    SELECT
      COUNT(*) AS events,
      -- The same expression the event projection and the turn fold use. This counted
      -- turns straight out of the JSON, so a row whose turn id lives only in the
      -- turn_id column contributed to the turn summaries and to a turnId-filtered
      -- event read but not to this: one session reporting 0 turns beside a timeline
      -- with turns in it.
      --
      -- TURN_KEY_SQL now folds an empty turn id into NULL, so the NULLIF this used to
      -- carry is redundant — and redundant in a way that hid a disagreement. It
      -- dropped the unturn-keyed group on this side while the turn fold's GROUP BY
      -- kept it, so a session of two rows in one turn, one with no turn id and one
      -- with an empty one reported turns: 1 beside three turn cards. The group is
      -- real — getTurnSummaries returns it and the panel draws it — so it is counted
      -- here too, and the two surfaces now answer with the same number.
      COUNT(DISTINCT ${TURN_KEY_SQL})
        + MAX(CASE WHEN ${TURN_KEY_SQL} IS NULL THEN 1 ELSE 0 END) AS turns,
      SUM(readable) AS readable,
      -- The rows that contributed nothing above: json_valid is 1 or 0 per row, so the
      -- unreadable count is the total less the readable ones.
      COUNT(*) - SUM(readable) AS unreadable,
      SUM(CASE WHEN ${expr('$.usage.request_duration_ms')} IS NOT NULL THEN 1 ELSE 0 END) AS steps,
      SUM(COALESCE(${expr('$.usage.request_duration_ms')}, 0)) AS request_ms,
      SUM(COALESCE(${expr('$.thinking_duration_ms')}, 0)) AS thinking_ms,
      SUM(CASE WHEN ${expr('$.thinking_duration_ms')} IS NOT NULL THEN 1 ELSE 0 END) AS thinking_events,
      SUM(COALESCE(${expr('$.usage.input_tokens')}, 0)) AS input_tokens,
      SUM(COALESCE(${expr('$.usage.output_tokens')}, 0)) AS output_tokens,
      SUM(COALESCE(${expr('$.usage.cache_read')}, 0)) AS cache_read,
      SUM(COALESCE(${expr('$.usage.total_tokens')}, 0)) AS total_tokens,
      MAX(${expr('$.usage.context_window')}) AS context_window,
      SUM(CASE WHEN ${expr('$.kind')} = 'compaction' THEN 1 ELSE 0 END) AS compactions,
      SUM(CASE WHEN ${expr('$.kind')} = 'compaction_failed' THEN 1 ELSE 0 END) AS compaction_failures
    FROM rows
  `;
  let base;
  try {
    base = store.db.prepare(sql).get(sessionId) || {};
  } catch (error) {
    store.warn(`row_aggregate_failed:${error.message}`);
    base = {};
  }

  // Expanding tool_calls with json_each in a join is one pass. The previous
  // correlated subquery re-parsed every row's JSON separately and dominated the
  // whole statistics call on large sessions.
  //
  // `json_each` raises on an unparseable `data_json` exactly as `json_extract` does,
  // so the same substitution applies: an unreadable row expands to zero tool calls
  // instead of taking the whole tool-call count with it.
  let toolCalls = 0;
  let toolFailures = 0;
  try {
    const row = store.db.prepare(`
      SELECT
        COUNT(*) AS calls,
        SUM(CASE WHEN COALESCE(json_extract(tc.value, '$.tool_call_status'), 2) <> 2 THEN 1 ELSE 0 END) AS failures
      FROM local_runtime_message_rows AS r, json_each(
        CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END, '$.tool_calls'
      ) AS tc
      WHERE r.session_id = ?
    `).get(sessionId) || {};
    toolCalls = num(row.calls) ?? 0;
    toolFailures = num(row.failures) ?? 0;
  } catch {
    /* older rows may lack the tool_calls shape */
  }

  let sources = [];
  try {
    sources = store.db.prepare(`
      SELECT json_extract(doc, '$.source') AS source, COUNT(*) AS count
      FROM (
        SELECT CASE WHEN json_valid(data_json) THEN data_json ELSE '{}' END AS doc
        FROM local_runtime_message_rows WHERE session_id = ?
      )
      WHERE json_extract(doc, '$.source') IS NOT NULL
      GROUP BY source ORDER BY count DESC
    `).all(sessionId).map((row) => ({ source: row.source, count: row.count }));
  } catch {
    sources = [];
  }

  const unreadable = (num(base.unreadable) ?? 0);
  if (unreadable > 0) {
    // Reported rather than absorbed: a session whose totals silently omit N records
    // is a different answer from one that has none to omit.
    store.warn(`rows_unreadable:${unreadable} record(s) were not valid JSON and are excluded from these totals`);
  }

  return {
    events: num(base.events) ?? 0,
    turns: num(base.turns) ?? 0,
    unreadable,
    steps: num(base.steps) ?? 0,
    requestMs: num(base.request_ms),
    thinkingMs: base.thinking_events ? num(base.thinking_ms) : null,
    thinkingEvents: num(base.thinking_events) ?? 0,
    inputTokens: num(base.input_tokens) ?? 0,
    outputTokens: num(base.output_tokens) ?? 0,
    cacheReadTokens: num(base.cache_read) ?? 0,
    totalTokens: num(base.total_tokens) ?? 0,
    contextWindowTokens: num(base.context_window),
    compactions: num(base.compactions) ?? 0,
    compactionFailures: num(base.compaction_failures) ?? 0,
    toolCalls,
    toolFailures,
    sources,
  };
}

function toolTaskAggregate(store, sessionId) {
  if (!store.db || !tableExists(store.db, 'local_runtime_background_tasks')) {
    return { totalMs: null, taskCount: 0, subagentCount: 0 };
  }
  try {
    const row = store.db.prepare(`
      SELECT
        COUNT(*) AS task_count,
        SUM(CASE WHEN kind = 'subagent' THEN 1 ELSE 0 END) AS subagent_count,
        SUM(MAX(0, COALESCE(ended_at_ms, updated_at_ms) - created_at_ms)) AS total_ms
      FROM local_runtime_background_tasks
      WHERE owner_session_id = ?
    `).get(sessionId) || {};
    return {
      totalMs: num(row.total_ms),
      taskCount: num(row.task_count) ?? 0,
      subagentCount: num(row.subagent_count) ?? 0,
    };
  } catch {
    return { totalMs: null, taskCount: 0, subagentCount: 0 };
  }
}

function assetAggregate(store, sessionId) {
  if (!store.db || !tableExists(store.db, 'local_runtime_session_assets')) return { total: 0 };
  try {
    const row = store.db.prepare(
      'SELECT COUNT(*) AS total FROM local_runtime_session_assets WHERE session_id = ?',
    ).get(sessionId) || {};
    return { total: num(row.total) ?? 0 };
  } catch {
    return { total: 0 };
  }
}
