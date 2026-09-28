/**
 * The event projection: the per-record stream, its per-turn fold, and the compact
 * timeline projection.
 *
 * Every record is read in stable insert order. `detailLevel` gates whether content
 * is returned at all: `summary` never returns message text, tool arguments or tool
 * results, so a read-only dashboard cannot leak a session's words by accident.
 */

import { num, parseJson } from './json.mjs';
import { LIMITS, clamp } from './config.mjs';
import { taskIndex } from './tasks.mjs';

/**
 * A record's turn identity, from whichever place the runtime recorded it. Used for
 * both the per-turn fold and the event projection so the two always agree.
 *
 * The result alias must differ from every real column name: `local_runtime_message_rows`
 * has its own `turn_id`, and aliasing the JSON expression to the same name makes
 * the driver return the column instead — silently yielding null turn ids.
 */
const TURN_KEY_SQL =
  "COALESCE(json_extract(data_json, '$.turn_id'), json_extract(data_json, '$.turnId'), turn_id)";

/**
 * Which doorway did this record enter the session through?
 *
 * `human` means the text is the person's own. `injected` means the harness put it
 * there — a goal objective, a questionnaire answer channel, a background-task
 * result — and the reader should not mistake it for something they typed.
 */
export function classifyInput(source, originType) {
  if (typeof originType === 'string' && originType) return 'injected';
  if (source === 'thread-goal' || source === 'background-task' || source === 'task' || source === 'agent') {
    return 'injected';
  }
  if (source === 'api' || source === 'questionnaire' || source === 'greeting') return 'human';
  return 'unknown';
}

/**
 * Read trajectory records in stable insert order, grouped by turn.
 *
 * `maxJsonBytes` bounds one row's `data_json`. The JSONL fallback has always had a
 * per-line cap; the SQLite read had none, so a single multi-megabyte row was parsed
 * into the process whole. A row past the bound comes back as an `oversized` record
 * carrying its byte count instead of its content — reported rather than dropped, so
 * `total` and the record indices still line up and the reader learns the row exists.
 */
export function getEvents(store, {
  sessionId,
  offset = 0,
  limit = LIMITS.events.default,
  detailLevel = 'summary',
  turnId,
  withTasks = true,
  maxJsonBytes = LIMITS.eventJsonBytes,
} = {}) {
  if (!store.db) return { events: [], total: 0, nextOffset: null, source: 'unavailable' };
  const safeLimit = clamp(limit, LIMITS.events);
  const safeOffset = Math.max(0, offset);
  const cap = Number.isFinite(maxJsonBytes) && maxJsonBytes > 0 ? maxJsonBytes : LIMITS.eventJsonBytes;

  const where = ['session_id = ?'];
  const params = [sessionId];
  if (turnId) {
    where.push(`${TURN_KEY_SQL} = ?`);
    params.push(turnId);
  }

  let total = 0;
  try {
    const row = store.db.prepare(
      `SELECT COUNT(*) AS n FROM local_runtime_message_rows WHERE ${where.join(' AND ')}`,
    ).get(...params);
    total = num(row?.n) ?? 0;
  } catch {
    total = 0;
  }

  let rows = [];
  try {
    // The size test runs in SQL so an oversized value is never materialised as a
    // JavaScript string. It measures *bytes*: `length(x)` on a TEXT column counts
    // characters, so a row of 4-byte code points passes a byte budget at a quarter
    // of its real size and is then parsed and returned whole — which is the whole
    // point of the cap. Casting to BLOB makes SQLite report the stored byte length,
    // which for a blob is the record header rather than a scan, so this is also the
    // cheaper of the two forms.
    rows = store.db.prepare(`
      SELECT
        id, role, created_at_ms, turn_id, source,
        CASE WHEN length(CAST(data_json AS BLOB)) <= ? THEN data_json ELSE NULL END AS data_json,
        length(CAST(data_json AS BLOB)) AS data_bytes
      FROM local_runtime_message_rows
      WHERE ${where.join(' AND ')}
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `).all(cap, ...params, safeLimit, safeOffset);
  } catch (error) {
    store.warn(`event_read_failed:${error.message}`);
    return { events: [], total: 0, nextOffset: null, source: 'error' };
  }

  const taskByCall = withTasks ? taskIndex(store, sessionId) : new Map();
  let oversized = 0;
  const events = rows.map((row, index) => {
    const position = safeOffset + index;
    if (row.data_json === null && num(row.data_bytes) !== null && row.data_bytes > cap) {
      oversized += 1;
      const stub = projectEvent({ ...row, data_json: '{}' }, position, 'summary', taskByCall);
      stub.oversized = true;
      stub.bytes = num(row.data_bytes);
      return stub;
    }
    return projectEvent(row, position, detailLevel, taskByCall);
  });
  if (oversized > 0) {
    store.warn(`events_oversized:${oversized} record(s) exceeded ${cap} bytes and were returned as metadata only`);
  }
  const consumed = safeOffset + rows.length;
  return {
    events,
    total,
    nextOffset: consumed < total ? consumed : null,
    source: 'sqlite',
  };
}

function projectEvent(row, index, detailLevel, taskByCall = new Map()) {
  const data = parseJson(row.data_json) || {};
  const usage = data.usage && typeof data.usage === 'object' ? data.usage : null;
  const contextUsage = data.context_usage && typeof data.context_usage === 'object' ? data.context_usage : null;
  const toolCalls = Array.isArray(data.tool_calls) ? data.tool_calls : null;
  const source = data.source ?? row.source ?? null;
  const origin = data.sourceContext?.origin && typeof data.sourceContext.origin === 'object'
    ? data.sourceContext.origin
    : null;

  const event = {
    index,
    rowId: row.id,
    msgId: data.msg_id ?? null,
    turnId: data.turn_id ?? row.turn_id ?? data.turnId ?? null,   // same order as TURN_KEY_SQL
    role: data.role ?? row.role ?? null,
    source,
    msgType: num(data.msg_type),
    kind: data.kind ?? null,
    finishReason: data.finish_reason ?? null,
    createdAtMs: num(row.created_at_ms) ?? num(data.timestamp),
    thinkingDurationMs: num(data.thinking_duration_ms),
    requestDurationMs: usage ? num(usage.request_duration_ms) : null,
    // Only an inbound record has an input doorway. Distinguishes a person's own
    // words from context the harness injected (a goal objective, a task result).
    inputKind: (data.role ?? row.role) === 'user' ? classifyInput(source, origin?.type) : null,
    originType: origin?.type ?? null,
    goalId: origin?.goalId ?? null,
    usage: usage ? {
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read),
      totalTokens: num(usage.total_tokens),
      contextWindowTokens: num(usage.context_window),
    } : null,
    contextUsage: contextUsage ? {
      usedTokens: num(contextUsage.usedTokens),
      contextWindowTokens: num(contextUsage.contextWindowTokens),
      totalCountSource: contextUsage.totalCountSource ?? null,
      components: Array.isArray(contextUsage.components) ? contextUsage.components : null,
    } : null,
    toolCallCount: toolCalls ? toolCalls.length : 0,
    failureCount: toolCalls
      ? toolCalls.filter((call) => num(call?.tool_call_status) !== null && num(call?.tool_call_status) !== 2).length
      : 0,
    hasThinking: typeof data.thinking_content === 'string' && data.thinking_content.length > 0,
    contentLength: typeof data.msg_content === 'string' ? data.msg_content.length : 0,
  };

  event.toolCalls = toolCalls
    ? toolCalls.map((call) => {
        const status = num(call?.tool_call_status);
        const task = call?.tool_call_id ? taskByCall.get(call.tool_call_id) ?? null : null;
        const projected = {
          name: call?.tool_name ?? null,
          id: call?.tool_call_id ?? null,
          status,
          ok: status === 2,
          // The measured wall-clock for this call, when the runtime recorded it
          // as a background task. Never estimated from record spacing.
          durationMs: task?.durationMs ?? null,
          taskId: task?.taskId ?? null,
          taskStatus: task?.status ?? null,
          agentName: task?.agentName ?? null,
          childSessionId: task?.childSessionId ?? null,
          hasOutput: task?.hasOutput ?? false,
        };
        if (detailLevel === 'full') {
          projected.args = call?.tool_call_args ?? null;
          projected.result = call?.tool_call_result_data ?? null;
          projected.description = task?.description ?? null;
        }
        return projected;
      })
    : null;

  if (detailLevel === 'full') {
    event.content = typeof data.msg_content === 'string' ? data.msg_content : null;
    event.thinking = typeof data.thinking_content === 'string' ? data.thinking_content : null;
    if (data.metadata && typeof data.metadata === 'object') event.metadata = data.metadata;
  }

  return event;
}

/**
 * Per-turn totals folded once on the server.
 *
 * The stream pages its rows, so a turn header cannot be summed from the rows that
 * happen to be loaded — it has to come from the whole session. Doing it here also
 * removes the client-side regrouping that used to run on every render.
 */
export function getTurnSummaries(store, sessionId) {
  if (!store.db) return [];
  const updatedAtMs = store.getSession(sessionId)?.updatedAtMs ?? 0;
  return store.cached(store.turnsCache, `${sessionId}|${updatedAtMs}`,
    () => computeTurnSummaries(store, sessionId));
}

function computeTurnSummaries(store, sessionId) {
  try {
    return store.db.prepare(`
      SELECT
        ${TURN_KEY_SQL} AS turn_key,
        COUNT(*) AS count,
        SUM(COALESCE(json_extract(data_json, '$.usage.request_duration_ms'), 0)) AS llm_ms,
        SUM(COALESCE(json_extract(data_json, '$.usage.output_tokens'), 0)) AS output_tokens,
        MIN(created_at_ms) AS first_ms
      FROM local_runtime_message_rows
      WHERE session_id = ?
      GROUP BY turn_key
      ORDER BY first_ms ASC
    `).all(sessionId).map((row) => ({
      turnId: row.turn_key ?? null,
      count: num(row.count) ?? 0,
      llmMs: num(row.llm_ms) ?? 0,
      outputTokens: num(row.output_tokens) ?? 0,
    }));
  } catch (error) {
    store.warn(`turn_summary_failed:${error.message}`);
    return [];
  }
}

/**
 * Compact projection for the timeline.
 *
 * The timeline needs every event's timing to draw an honest axis, but it needs no
 * text at all. Fetching it separately keeps the axis complete while the stream
 * pages, instead of forcing one large request to serve both.
 */
export function getTimeline(store, sessionId, { cap = LIMITS.timeline } = {}) {
  if (!store.db) return [];
  const expr = (jsonPath) => `json_extract(data_json, '${jsonPath}')`;
  try {
    const rows = store.db.prepare(`
      SELECT
        id AS row_id,
        created_at_ms AS at_ms,
        ${expr('$.role')} AS role_json,
        ${expr('$.source')} AS source_json,
        ${expr('$.kind')} AS kind_json,
        ${expr('$.sourceContext.origin.type')} AS origin_type,
        ${expr('$.usage.request_duration_ms')} AS duration_ms,
        ${expr('$.thinking_duration_ms')} AS thinking_ms
      FROM local_runtime_message_rows
      WHERE session_id = ?
      ORDER BY id ASC
      LIMIT ?
    `).all(sessionId, cap);
    return rows.map((row) => ({
      rowId: row.row_id,
      at: num(row.at_ms),
      role: row.role_json ?? null,
      source: row.source_json ?? null,
      kind: row.kind_json ?? null,
      injected: Boolean(row.origin_type) || row.source_json === 'thread-goal'
        || row.source_json === 'background-task' || row.source_json === 'task',
      durationMs: num(row.duration_ms),
      thinkingMs: num(row.thinking_ms),
    }));
  } catch (error) {
    store.warn(`timeline_failed:${error.message}`);
    return [];
  }
}
