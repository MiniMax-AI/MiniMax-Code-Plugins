/**
 * The event projection: the per-record stream, its per-turn fold, and the compact
 * timeline projection.
 *
 * Every record is read in stable insert order. `detailLevel` gates whether content
 * is returned at all: `summary` never returns message text, tool arguments or tool
 * results, so a read-only dashboard cannot leak a session's words by accident.
 */

import { num, parseJson } from './json.mjs';
import { LIMITS, clamp, normalizeOffset } from './config.mjs';
import { taskIndex } from './tasks.mjs';

/**
 * A record's turn identity, from whichever place the runtime recorded it. Used for
 * both the per-turn fold and the event projection so the two always agree.
 *
 * Two things are settled here rather than at each call site.
 *
 * The `json_valid` guards: `json_extract` raises "malformed JSON" on a row whose
 * `data_json` is not a JSON document, and that error aborts the whole statement, not
 * the row. The turn-filtered read built this predicate against the raw table, so one
 * truncated write made the *whole session* unreadable by turn — the same
 * "empty trajectory beside a full event list" shape the `DOC_SQL` normalisation was
 * added for, reached through a different door. `CASE` short-circuits, so the guard
 * costs nothing on a readable row.
 *
 * The `NULLIF(…, '')`: a row the runtime left with an empty turn id has no turn
 * identity, and treating that as a second distinct "no turn" group made the turn fold
 * report one more turn than the summary counted, for the same rows.
 *
 * The result alias must differ from every real column name: `local_runtime_message_rows`
 * has its own `turn_id`, and aliasing the JSON expression to the same name makes
 * the driver return the column instead — silently yielding null turn ids.
 */
export const TURN_KEY_SQL = `NULLIF(COALESCE(
  CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.turn_id') END,
  CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.turnId') END,
  turn_id
), '')`;

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
  pageBytes = LIMITS.eventPageBytes,
} = {}) {
  if (!store.db) return { events: [], total: 0, sessionRows: 0, nextOffset: null, offset: 0, source: 'unavailable' };
  const safeLimit = clamp(limit, LIMITS.events);
  // The offset is normalised here, once, and echoed back to the caller.
  //
  // `limit` already went through `clamp`, but `offset` did not, and `OFFSET ?` binds
  // a literal: a fractional, negative, string or non-numeric offset raised
  // `datatype mismatch` inside SQLite, the read failed, and the page came back
  // `source: 'error'` with no records — which the egress then reported as a session
  // that was "not in the projection". A caller whose offset happened to be a float
  // got an empty trajectory that looked like an empty session.
  //
  // Normalising at the boundary means the reply echoes the offset that was actually
  // read, and the cursor a trimmed page returns is always feedable back in.
  const safeOffset = normalizeOffset(offset);
  const cap = Number.isFinite(maxJsonBytes) && maxJsonBytes > 0 ? maxJsonBytes : LIMITS.eventJsonBytes;

  const where = ['session_id = ?'];
  const params = [sessionId];
  // Three states, because a filter that matches nothing and no filter at all are
  // different questions. `undefined` means the caller did not ask. `null` or `''`
  // means the caller asked for the rows that carry *no* turn identity — a real group
  // the turn fold reports as `turnId: null`, and the one a caller holding that id from
  // `getTurnSummaries` is most likely to pass back. Both used to fall through the
  // `if (turnId)` test, so asking for the unturn-keyed group returned the entire
  // session instead. `= NULL` matches nothing at all, hence `IS NULL`.
  if (turnId !== undefined) {
    if (turnId === null || turnId === '') {
      where.push(`${TURN_KEY_SQL} IS NULL`);
    } else {
      where.push(`${TURN_KEY_SQL} = ?`);
      params.push(turnId);
    }
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
  // How many rows the session has, before any turn filter — which is not the same
  // question, and the artifact fallback needs this one. `total` answers "how many match
  // what you asked for", so a turn filter that matched nothing made it zero, and a
  // caller asking a narrowed question was answered from a second source. The count is
  // taken only when the filtered one is zero, so an ordinary read pays nothing for it.
  let sessionRows = total;
  if (total === 0) {
    try {
      const row = store.db.prepare(
        'SELECT COUNT(*) AS n FROM local_runtime_message_rows WHERE session_id = ?',
      ).get(sessionId);
      sessionRows = num(row?.n) ?? 0;
    } catch {
      sessionRows = 0;
    }
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
    // Two steps, because one is not.
    //
    // Selecting the page inline with the byte-cap expression made SQLite sort the
    // candidate rows *including* `data_json` before the OFFSET applied: the sorter
    // carried the whole payload column of the session to produce 200 records. On a
    // 200k-row session that is the difference between a 16 ms first page and a 228 ms
    // deep one, and the cost is paid by the offset, not by the rows returned.
    //
    // The inner query projects the key columns only and finds the page; the join then
    // fetches those rows by primary key. The sort moves 4 narrow columns instead of the
    // whole payload, and the byte test still runs in SQL on the 200 rows that were
    // actually selected, so an oversized value is never materialised.
    rows = store.db.prepare(`
      WITH page AS (
        SELECT id, role, created_at_ms, turn_id, source
        FROM local_runtime_message_rows
        WHERE ${where.join(' AND ')}
        ORDER BY id ASC
        LIMIT ? OFFSET ?
      )
      SELECT
        page.id AS id, page.role AS role, page.created_at_ms AS created_at_ms,
        page.turn_id AS turn_id, page.source AS source,
        CASE WHEN length(CAST(rows.data_json AS BLOB)) <= ? THEN rows.data_json ELSE NULL END AS data_json,
        length(CAST(rows.data_json AS BLOB)) AS data_bytes
      FROM page JOIN local_runtime_message_rows AS rows ON rows.id = page.id
      ORDER BY page.id ASC
    `).all(...params, safeLimit, safeOffset, cap);
  } catch (error) {
    // The reason travels with the page. A caller that got `source: 'error'` with no
    // explanation had no way to tell a broken query from a session that genuinely has
    // no records, and the panel answered "not in the SQLite projection" for both.
    store.warn(`event_read_failed:${error.message}`);
    return {
      events: [], total: 0, sessionRows: 0, nextOffset: null, offset: safeOffset, source: 'error', error: error.message,
    };
  }

  // The index reports its own cap, and the cap travels with the page: a tool call
  // outside the indexed slice carries no task timing, and a caller reading
  // `durationMs: null` has no way to tell that from a call that was never a
  // background task.
  const tasks = withTasks ? taskIndex(store, sessionId) : { byCall: new Map(), capped: false, total: 0 };
  const taskByCall = tasks.byCall;
  let oversized = 0;
  let projectedBytes = 0;
  let cutForBytes = 0;
  // The per-row cap and the response budget bound two different things and neither
  // bounds this. A page of 1,000 rows at the 8 MiB row ceiling is 8 GiB of `data_json`
  // to answer at most 2 MiB: every one of those rows would be parsed into JavaScript
  // and swept by the redaction regexes before the budget that trims the reply ever
  // ran. Measured on twenty 1 MiB rows, 6.4 s of sweeping for a 0.38 MB answer.
  //
  // So the page stops projecting once it has read a bounded number of raw bytes. The
  // rows are already in hand — the savings are the parse and the sweep, which is
  // where the time goes — and the cursor stays honest, because `nextOffset` counts the
  // rows that were actually delivered and the client simply asks again.
  const events = [];
  for (const [index, row] of rows.entries()) {
    const position = safeOffset + index;
    const size = num(row.data_bytes) ?? 0;
    if (projectedBytes + size > pageBytes && events.length > 0) { cutForBytes = index + 1; break; }
    projectedBytes += size;
    if (row.data_json === null && num(row.data_bytes) !== null && row.data_bytes > cap) {
      oversized += 1;
      const stub = projectEvent({ ...row, data_json: '{}' }, position, 'summary', taskByCall);
      stub.oversized = true;
      stub.bytes = num(row.data_bytes);
      events.push(stub);
      continue;
    }
    events.push(projectEvent(row, position, detailLevel, taskByCall));
  }
  if (oversized > 0) {
    store.warn(`events_oversized:${oversized} record(s) exceeded ${cap} bytes and were returned as metadata only`);
  }
  // The cursor counts the rows this reply actually carries, whether they were dropped
  // by the byte budget or not: a cursor that skipped over them would lose records
  // permanently, which is the one thing a paging cursor must never do.
  const consumed = safeOffset + events.length;
  if (cutForBytes > 0) {
    store.warn(`events_page_bytes:${cutForBytes} row(s) past the ${pageBytes}-byte page budget; ask again with the cursor`);
  }
  return {
    events,
    total,
    // Unfiltered, so the caller can tell an empty session from an empty answer.
    sessionRows,
    // The offset this page was read at, after normalisation, so a caller can tell what
    // was actually read rather than what it asked for.
    offset: safeOffset,
    nextOffset: consumed < total ? consumed : null,
    pageBytesTruncated: cutForBytes > 0,
    ...(tasks.capped ? { taskIndexTruncated: true, taskIndexTotal: tasks.total } : {}),
    source: 'sqlite',
  };
}

/**
 * There is deliberately no projection-time string clip.
 *
 * One was added here to bound the redaction sweep, and it had to be removed: a clip
 * landing inside a quoted value deletes that value's closing delimiter, and every
 * redaction layer fails open at once. `redactJsonText` cannot `JSON.parse` the
 * unterminated document, the escaped-document rule needs its closing delimiter, and
 * the key/value rule's unquoted branch excludes `"` — so a `read` or `bash` result
 * over 256 KiB carrying `api_key` inside a JSON object was delivered unredacted,
 * through the one surface whose output reaches a model.
 *
 * The work is bounded instead by `eventJsonBytes` per row and `eventPageBytes` per
 * page, both of which already report themselves: a row past the per-row ceiling is
 * returned as an `oversized` stub carrying its byte count, and a page past the
 * per-page budget is left for the next page with an honest cursor. Measured on the
 * shape that motivated the clip — twenty 1 MiB records — removing it moves the sweep
 * from 350 ms to 1.1 s, and on the common shape (2000 records of ~4 KB) it moves
 * nothing at all: 816 ms against 811 ms, because those fields never reached the
 * 256 KiB clip in the first place.
 */

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
  return store.cached(store.turnsCache, `${sessionId}|${store.messageSignature(sessionId)}`,
    () => computeTurnSummaries(store, sessionId));
}

/**
 * The document to extract from, per row.
 *
 * `json_extract` raises "malformed JSON" on a row whose `data_json` is not a JSON
 * document, and that error aborts the whole statement — not the row. Substituting
 * `{}` makes an unreadable row contribute nothing while every other row is still
 * counted, so one truncated write cannot report a session as having no turns or no
 * timeline while `getEvents` goes on listing its records.
 */
const DOC_SQL = `CASE WHEN json_valid(data_json) THEN data_json ELSE '{}' END`;


function computeTurnSummaries(store, sessionId) {
  try {
    return store.db.prepare(`
      SELECT
        ${TURN_KEY_SQL} AS turn_key,
        COUNT(*) AS count,
        SUM(COALESCE(json_extract(data_json, '$.usage.request_duration_ms'), 0)) AS llm_ms,
        SUM(COALESCE(json_extract(data_json, '$.usage.output_tokens'), 0)) AS output_tokens,
        MIN(created_at_ms) AS first_ms
      FROM (
        SELECT created_at_ms, turn_id, ${DOC_SQL} AS data_json
        FROM local_runtime_message_rows WHERE session_id = ?
      )
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
  if (!store.db) return { points: [], truncated: false };
  // Cached against the message rows it folds, like the statistics and turn folds
  // beside it. The panel asks for the timeline on every overview, so an uncached fold
  // was 7 json_extracts over the whole session per request (78 ms at 6,000 rows).
  // It used to be keyed on the session's own updated_at_ms, which the runtime does not
  // touch while it indexes — so a session that grew kept drawing the old axis.
  return store.cached(store.timelineCache, `${sessionId}|${store.messageSignature(sessionId)}|${cap}`,
    () => computeTimeline(store, sessionId, cap));
}

function computeTimeline(store, sessionId, cap) {
  const expr = (jsonPath) => `json_extract(${DOC_SQL}, '${jsonPath}')`;
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
    `).all(sessionId, cap + 1);
    // One row past the cap, so "there is more" is known without a second count —
    // and a session with 7,000 records reports 6,000 points and says so, instead of
    // presenting the cap as the whole session.
    const truncated = rows.length > cap;
    const points = rows.slice(0, cap).map((row) => ({
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
    // No `total` here, deliberately. The query read one row past the cap and stopped,
    // so the number of records after it was never counted; a field named `total`
    // holding the delivered count is read as the session's size, which is the exact
    // misreading this Plugin exists to prevent. `points.length` is what arrived and
    // `truncated` says whether the session has more. A caller needing the true count
    // asks `getStats`, which counts properly.
    if (truncated) store.warn(`timeline_truncated:more than ${cap} points; the axis was cut at the cap`);
    return { points, truncated };
  } catch (error) {
    store.warn(`timeline_failed:${error.message}`);
    return { points: [], truncated: false };
  }
}
