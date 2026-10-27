/**
 * The event projection: the per-record stream, its per-turn fold, and the compact
 * timeline projection.
 *
 * Every record is read in stable insert order. `detailLevel` gates whether content
 * is returned at all: `summary` never returns message text, tool arguments or tool
 * results, so a read-only dashboard cannot leak a session's words by accident.
 */

import { num, parseJson } from './json.mjs';
import { INPUT_KINDS, LIMITS, TOOL_STATUS_OK, clamp, normalizeOffset } from './config.mjs';
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
  // The three values come from `INPUT_KINDS` rather than from literals here. The
  // constant used to be declared and never read, while this function spelled the same
  // three words out by hand — so the declared set and the produced set were two
  // unconnected facts about the same thing, and the Skill documents the produced one.
  const [HUMAN, INJECTED, UNKNOWN] = INPUT_KINDS;
  if (typeof originType === 'string' && originType) return INJECTED;
  if (source === 'thread-goal' || source === 'background-task' || source === 'task' || source === 'agent') {
    return INJECTED;
  }
  if (source === 'api' || source === 'questionnaire' || source === 'greeting') return HUMAN;
  return UNKNOWN;
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
  role,
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
  // The same three states, for the same reason, on a column this Plugin does not own.
  //
  // Why this filter exists at all: on the machine this was measured on, `role` is
  // `assistant` for 112,290 of 116,304 rows, `user` for **2,388** — 2.1%. One session
  // measured here held 5,272 assistant records and **9** user ones. "What did this
  // conversation actually ask for, and how far did it get" is a question about those 9
  // records, and without a role filter the only way to see them was to walk all 5,343 and
  // filter client-side: **27 calls and 24.6 MiB of reply text** for nine messages. That
  // is not a large context, it is an impossible one — and the reading was `full`, which
  // is exactly the detail level the Skill tells a model not to widen to on its own. So
  // the cost of the safe path was the cost of not asking the question at all.
  //
  // `null`/`''` asks for the rows carrying no role. That is not a hypothetical group: the
  // same count found **1,626** of them machine-wide, and they are the rows a caller
  // holding a `null` role off `trajectory_get`'s own reply is asking about. `= NULL`
  // matches nothing, hence `IS NULL`.
  if (role !== undefined) {
    if (role === null || role === '') {
      where.push('role IS NULL');
    } else {
      where.push('role = ?');
      params.push(role);
    }
  }

  let total = 0;
  try {
    const row = store.db.prepare(
      `SELECT COUNT(*) AS n FROM local_runtime_message_rows WHERE ${where.join(' AND ')}`,
    ).get(...params);
    total = num(row?.n) ?? 0;
  } catch {
    // Zero here reads as "this session matched nothing", which is a finding rather
    // than a failure — and it is a finding the caller will report. The count query is
    // the one place that can say how much was missed, so a failure to count has to be
    // recorded rather than swallowed into a number that looks like an answer.
    store.warn('event_count_failed:the record count could not be computed, so total=0 means "not counted"');
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
      store.warn('session_row_count_failed:this session\'s own row count could not be computed, so sessionRows=0 means "not counted"');
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
  const tasks = taskIndex(store, sessionId);
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
      ? toolCalls.filter((call) => num(call?.tool_call_status) !== null && num(call?.tool_call_status) !== TOOL_STATUS_OK).length
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
          ok: status === TOOL_STATUS_OK,
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

/**
 * Characters either side of a match carried in a snippet.
 *
 * A snippet is context, not the record: enough to recognise what was found and to
 * decide whether to read further, and short enough that a page of hits cannot smuggle
 * a session's worth of message text out through what looks like a list of pointers.
 */
const SNIPPET_RADIUS = 160;


function computeTurnSummaries(store, sessionId) {
  try {
    const turns = store.db.prepare(`
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
    `).all(sessionId);
    // Once, not once per turn: a 444-turn session would otherwise run 445 copies of the
    // same statement, and this fold is on the path of the cheapest progress query there is.
    const failures = turnFailures(store, sessionId);
    return turns.map((row) => ({
      turnId: row.turn_key ?? null,
      count: num(row.count) ?? 0,
      llmMs: num(row.llm_ms) ?? 0,
      outputTokens: num(row.output_tokens) ?? 0,
      failureCount: failures.get(row.turn_key ?? null) ?? 0,
      // When this turn started. The aggregate was already computed — it is what the
      // rows are ordered by — and then dropped at the mapping step, so a caller could
      // see that turn 40 came after turn 39 and could not say when either happened.
      // That is the whole of "progress" missing from the progress view: dating a turn
      // meant paging records until one carried a timestamp, which on a session of
      // thousands is paging the whole session.
      //
      // `null` rather than `0` when the rows carry no time, because 0 is a real instant
      // and would sort a broken session before every healthy one.
      firstMs: num(row.first_ms) ?? null,
    }));
  } catch (error) {
    store.warn(`turn_summary_failed:${error.message}`);
    return [];
  }
}

/**
 * Failed tool calls per turn, on the same terms `trajectory_summary` counts them.
 *
 * This is the field that makes a session's failures *addressable*. `trajectory_summary`
 * publishes `toolFailures` and every record carries its own `failureCount`, but the turn
 * rows carried neither — so the question "which turn of this run went wrong" had no cheap
 * answer at all: on a 21992-record session it cost twenty-two pages and 1.4 seconds to
 * read every record and inspect `toolCalls[].ok` by hand. With the count here, the same
 * answer is three pages of turns followed by one `trajectory_get` with `turnId`, using a
 * filter the tool already had.
 *
 * `json_each` rather than a correlated subquery, for the reason `stats.mjs` gives: the
 * correlated form re-parsed every row's JSON separately and dominated the whole fold on
 * large sessions. It is a separate statement for the same reason — joining `json_each`
 * into the aggregate above would multiply `count`, `llm_ms` and `output_tokens` by the
 * number of tool calls each record made, and those three reconcile exactly against
 * `trajectory_summary` today.
 *
 * A turn whose records made no tool calls is absent from this result rather than present
 * with a zero, because `json_each` on a missing path yields no rows at all; the caller's
 * `?? 0` is what turns "absent" into "no failures", which is what it means.
 */
function turnFailures(store, sessionId) {
  const byTurn = new Map();
  try {
    for (const row of store.db.prepare(`
      SELECT
        ${TURN_KEY_SQL} AS turn_key,
        SUM(CASE WHEN COALESCE(json_extract(tc.value, '$.tool_call_status'), ${TOOL_STATUS_OK}) <> ${TOOL_STATUS_OK} THEN 1 ELSE 0 END) AS failures
      FROM local_runtime_message_rows AS r, json_each(
        CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END, '$.tool_calls'
      ) AS tc
      WHERE r.session_id = ?
      GROUP BY turn_key
    `).all(sessionId)) {
      byTurn.set(row.turn_key ?? null, num(row.failures) ?? 0);
    }
  } catch (error) {
    // The turn rows themselves still describe the run; this one column being unavailable
    // is a degraded answer, so it is recorded rather than folded into a zero that reads
    // as "nothing failed".
    store.warn(`turn_failure_count_failed:${error.message}`);
    return new Map();
  }
  return byTurn;
}

/**
 * Compact projection for the timeline.
 *
 * The timeline needs every event's timing to draw an honest axis, but it needs no
 * text at all. Fetching it separately keeps the axis complete while the stream
 * pages, instead of forcing one large request to serve both.
 */
export function getTimeline(store, sessionId, { cap = LIMITS.timeline } = {}) {
  // `sessionRows` rides along so the route can decide whether the artifact is worth a
  // read. The projection read below is where the axis comes from when it can be; the
  // fallback is async and belongs to the route, which is where the other four record
  // reads already make that same decision.
  if (!store.db) return { points: [], truncated: false, sessionRows: 0 };
  // Cached against the message rows it folds, like the statistics and turn folds
  // beside it. The panel asks for the timeline on every overview, so an uncached fold
  // was 7 json_extracts over the whole session per request (78 ms at 6,000 rows).
  // It used to be keyed on the session's own updated_at_ms, which the runtime does not
  // touch while it indexes — so a session that grew kept drawing the old axis.
  return store.cached(store.timelineCache, `${sessionId}|${store.messageSignature(sessionId)}|${cap}`,
    () => computeTimeline(store, sessionId, cap));
}

/**
 * Project an artifact stream into axis points.
 *
 * The point shape is fixed by the panel, which already tolerates every field being
 * absent here: it filters on `Number.isFinite(point.at)` and skips a point whose
 * `durationMs` is falsy. So a user turn draws as an input marker and an assistant turn
 * draws nothing at all — which is exactly what the file recorded, since a `messages.jsonl`
 * carries no durations. The caller still has to say so; see `http.mjs`.
 */
export function jsonlTimelinePoints(events) {
  return events.map((event) => ({
    rowId: event.index,
    at: num(event.createdAtMs),
    role: event.role ?? null,
    source: null,
    kind: null,
    injected: false,
    durationMs: null,
    thinkingMs: null,
  }));
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
    // A real count, not `rows.length`: the query stopped at the cap, so the delivered
    // length is a floor. Read inside the cached fold, so it costs one indexed aggregate
    // on a miss and nothing on a hit. `null` when it could not be counted, and the route
    // reads that as "do not go looking elsewhere" — a store that could not look must not
    // be told it looked and found nothing.
    return { points, truncated, sessionRows: store.messageRowCount(sessionId) };
  } catch (error) {
    store.warn(`timeline_failed:${error.message}`);
    return { points: [], truncated: false };
  }
}

/**
 * Escape a user string for use as a literal in a SQL `LIKE` pattern.
 *
 * `%` and `_` are wildcards, so a query containing either matches more than it says:
 * `50%` is "anything starting with 50" rather than the three characters typed. The
 * backslash is the escape character named by `ESCAPE '\'` at the call site. Without
 * this, a search for a literal string can quietly return every row containing a
 * fragment of it — which reads as a confident, wrong answer rather than a bad query.
 */
function escapeLike(text) {
  return String(text).replace(/[\\%_]/gu, (char) => `\\${char}`);
}

/**
 * Whether this needle can match text that SQL's case folding cannot see.
 *
 * Decided from the needle alone, so it costs nothing and needs no query. The question
 * is not "does this character change when lower-cased" — it does not, for `ş` or `İ`
 * any more than for `é` — but "**does some other form of it exist**". `Ş` is a
 * different character that means the same letter and lower-cases to `ş`; `LIKE` cannot
 * move one to the other, so a row holding `Ş` is reachable only by the JavaScript pass.
 *
 * The check is therefore whether `toUpperCase` or `toLowerCase` produces a *different*
 * single character. A character with one form (`é`, `中`) fails both, correctly: folding
 * it changes nothing, so `LIKE`'s byte comparison already agrees with JavaScript and the
 * second pass would find nothing new. Firing on those would make a full scan the price
 * of every Chinese query, which is the most common non-ASCII query there is.
 */
function needsUnicodeFold(needle) {
  for (const char of String(needle)) {
    // ASCII is already folded by `LIKE`; only the non-ASCII half is in question.
    if (char.codePointAt(0) <= 0x7f) continue;
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    if ((lower !== char && lower.length === 1) || (upper !== char && upper.length === 1)) {
      return true;
    }
  }
  return false;
}

/**
 * The second pass: every row of one session, folded in JavaScript, that contains the
 * needle once case is ignored the way `toLowerCase` ignores it.
 *
 * Only reached when the indexed `LIKE` found nothing, because that path already
 * answers every ASCII-case query correctly and is far cheaper. Rows are read in the
 * same `id` order the SQL path uses and numbered the same way, so `position` means
 * the same thing whichever path answered — a hit found here is addressable by
 * `trajectory_get` exactly as one found there is.
 */
function unicodeCaseScan(store, sessionId, needle, offset, limit) {
  const folded = needle.toLowerCase();
  const rows = store.db.prepare(`
    SELECT
      id AS id, role AS role, created_at_ms AS created_at_ms,
      turn_id AS turn_id, source AS source,
      ROW_NUMBER() OVER (ORDER BY id) - 1 AS position,
      ${DOC_SQL} AS data_json
    FROM local_runtime_message_rows WHERE session_id = ?
    ORDER BY id ASC
  `).all(sessionId);
  const hits = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (String(rows[index].data_json ?? '').toLowerCase().includes(folded)) hits.push(index);
  }
  return {
    total: hits.length,
    rows: hits.slice(offset, offset + limit).map((index) => rows[index]),
  };
}

/**
 * Records whose message text contains `query`, newest match first by position.
 *
 * Scoped to one session on purpose. Measured on this machine: the same `LIKE` across
 * the whole projection takes 6.4 s over 109k rows, while the busiest session — 21,315
 * rows and 137 MB of payload — takes 197 ms, because the session filter is indexed and
 * only that session's rows are tested. So the useful shape of this is "find it in
 * *this* session", and the cross-session form is not merely omitted, it is too slow to
 * be a tool call.
 *
 * Each match carries the record's index in the same insert-order numbering
 * `trajectory_get` uses, so a caller can jump straight to it instead of paging there.
 * That index is what makes this worth having: a 21k-record session otherwise costs
 * around twenty calls to reach a record you already know the position of.
 *
 * Neither `scanned` nor `truncated` is reported. A scan count is `matches.length` before
 * the response budget trims it, and a `truncated: false` on this object would be a field
 * that claims nothing was cut while the budget was doing exactly that — the shape the
 * `warnings` array used to have, where a constant is worse than an absence because it
 * is believed. The budget reports itself at the surface, on the fields it actually
 * decides.
 *
 * @returns {{matches: object[], total: number, sessionRows: number, nextOffset: number|null,
 *            offset: number, source: string}}
 */
export function findEvents(store, {
  sessionId, query, offset = 0, limit = LIMITS.events.default, detailLevel = 'summary',
  maxJsonBytes = LIMITS.eventJsonBytes,
} = {}) {
  if (!store.db) {
    return { matches: [], total: 0, sessionRows: 0, nextOffset: null, offset: 0, source: 'unavailable' };
  }
  const safeOffset = normalizeOffset(offset);
  const safeLimit = clamp(limit, LIMITS.events);
  const cap = Number.isFinite(maxJsonBytes) && maxJsonBytes > 0 ? maxJsonBytes : LIMITS.eventJsonBytes;
  // A pattern of only wildcards is not a search, it is a request to read the whole
  // session through a filter that pretends to narrow it. Escaping already neutralises
  // them; this only rejects the empty string, which would otherwise match everything.
  const needle = typeof query === 'string' ? query.trim() : '';
  if (needle === '') {
    return { matches: [], total: 0, sessionRows: 0, nextOffset: null, offset: safeOffset, source: 'unavailable' };
  }

  const pattern = `%${escapeLike(needle)}%`;
  let rows = [];
  let total = 0;
  // Whether the cheap SQL path was enough, or the Unicode pass below had to answer.
  // Reported rather than kept internal: the two paths have different costs, and a
  // caller who asked a question this Plugin answered by scanning is entitled to know
  // that before wondering why the call was slow.
  let unindexedCase = false;
  try {
    total = num(store.db.prepare(`
      SELECT COUNT(*) AS n FROM local_runtime_message_rows
      WHERE session_id = ? AND data_json LIKE ? ESCAPE '\\'
    `).get(sessionId, pattern)?.n) ?? 0;
    // The window gives each match its position among the session's own records, which
    // is the numbering `trajectory_get` hands out — so a hit is addressable, not just
    // reportable.
    rows = store.db.prepare(`
      WITH session_rows AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS position
        FROM local_runtime_message_rows WHERE session_id = ?
      ), hits AS (
        SELECT id FROM local_runtime_message_rows
        WHERE session_id = ? AND data_json LIKE ? ESCAPE '\\'
        ORDER BY id ASC LIMIT ? OFFSET ?
      )
      SELECT
        hits.id AS id, rows.role AS role, rows.created_at_ms AS created_at_ms,
        rows.turn_id AS turn_id, rows.source AS source,
        session_rows.position AS position,
        ${DOC_SQL} AS data_json
      FROM hits
      JOIN local_runtime_message_rows AS rows ON rows.id = hits.id
      JOIN session_rows ON session_rows.id = hits.id
      ORDER BY hits.id ASC
    `).all(sessionId, sessionId, pattern, safeLimit, safeOffset);
  } catch (error) {
    store.warn(`event_find_failed:${error.message}`);
    return {
      matches: [], total: 0, sessionRows: 0, nextOffset: null, offset: safeOffset,
      source: 'error', error: error.message,
    };
  }

  // SQL `LIKE` folds ASCII case and nothing else, and SQLite's own `lower()` is the
  // same: neither moves `Ş` to `ş` or `İ` to `i`. So a query whose occurrence differs
  // from the needle by a non-ASCII letter is invisible to the query above, even though
  // the JavaScript this module already uses for the excerpt would have found it. The
  // two halves disagreed about case, and the cheap half won — the answer was "no such
  // text" for text that is there.
  //
  // The fix is a second pass rather than a cleverer first one. Doing the folding in
  // SQL is not available (the built-in is ASCII-only) and doing it through a
  // registered JS function was measured at 10.2 s over this table, against 6.5 s for
  // the plain `LIKE` on the same query — a per-row callback is not affordable. But
  // this function is scoped to one session, and the busiest one here holds 21,689
  // rows: fetching and folding those in JavaScript costs 390 ms plus 227 ms, which
  // is. So the indexed `LIKE` stays the primary path.
  //
  // When the second pass runs is the part that is easy to get wrong. Firing it only
  // when `LIKE` returned *nothing* is not enough: a session holding both "the şark
  // city" and "the ŞARK city" returns one row from `LIKE` for the needle "şark", so
  // the guard never fires and the answer is a confident `total: 1` for a query with
  // two matches. A partial match is worse than a total miss — the miss reads as an
  // absence the reader can question, the partial reads as a count.
  //
  // So the pass runs whenever the needle contains a character whose case could differ
  // only in a way `LIKE` cannot see, which is decided from the needle alone and costs
  // nothing. For the overwhelmingly common all-ASCII needle the second pass never
  // runs and this function costs exactly what it did before.
  if (needsUnicodeFold(needle)) {
    const fallback = unicodeCaseScan(store, sessionId, needle, safeOffset, safeLimit);
    if (fallback.total > total) {
      rows = fallback.rows;
      total = fallback.total;
      unindexedCase = true;
    }
  }

  const matches = [];
  for (const row of rows) {
    const data = parseJson(row.data_json) || {};
    // The match is located against `data_json` as a whole, so it can be in the message,
    // in thinking, or in neither — a tool argument or a result carries arbitrary text
    // too. Saying which one it is, rather than handing back an empty excerpt, is the
    // difference between "here is your answer" and "here is a hit, go look".
    //
    // The location comes from `locateNeedle`, which is the same function the artifact
    // path uses, so `field` and `snippet` cannot end up describing different texts.
    const located = locateNeedle({
      content: data.msg_content,
      thinking: data.thinking_content,
      calls: Array.isArray(data.tool_calls)
        ? data.tool_calls.map((call) => ({ args: call?.tool_call_args, result: call?.tool_call_result_data }))
        : [],
    }, needle);
    const hit = {
      index: num(row.position),
      role: data.role ?? row.role ?? null,
      turnId: data.turn_id ?? row.turn_id ?? data.turnId ?? null,
      createdAtMs: num(row.created_at_ms),
      // A row the SQL `LIKE` matched but `locateNeedle` cannot place is still a hit —
      // the row exists and the record contains the text somewhere this reader does not
      // model — so it is reported as `other` rather than dropped. Dropping it would make
      // `total` and `matches.length` disagree, which is the one thing a caller cannot
      // check for itself.
      field: located?.field ?? 'other',
    };
    // Content is content: excerpts are returned only in `full`, on the same terms as
    // every other message body this Plugin hands out.
    //
    // A match inside a tool call used to end here, at `field: 'other'` and no excerpt at
    // all — so the caller who had just asked for `full` detail was told only which record
    // to go and read. That is the commonest kind of hit on a working session: searching
    // one word from the user's own messages for `插件` on this session returned 193
    // matches, and three of the first five were in tool results with no excerpt at all.
    // The excerpt is not new disclosure — `full` detail already hands back the whole
    // `toolCalls[].args` and `.result` for this record through `trajectory_get` — it just
    // arrives before the second call instead of after it.
    if (detailLevel === 'full' && located) {
      hit.snippet = snippetAround(located.text, needle);
      if (located.in) hit.matchedToolCall = located.in;
    }
    matches.push(hit);
  }
  const readTo = safeOffset + rows.length;
  // The session's own row count, before any narrowing, which is what tells the caller
  // whether an empty result means "no matches" or "this session is not indexed yet".
  //
  // Counted only when `total` came back zero, and **absent** otherwise. It used to be
  // seeded with `total`, which in this function is the *match* count: a session holding
  // 21,689 rows with 3 hits reported `sessionRows: 3` under the name of a session row
  // count. `getEvents` publishes the same field name as `sessionTotal`, and there `total`
  // *is* the row count — so one name, two questions, and a caller reading it had no way
  // of telling which one it was being handed. Absent rather than zeroed: the count was
  // never taken on this path, and a count that was not taken is not zero.
  let sessionRows;
  if (total === 0) {
    try {
      sessionRows = num(store.db.prepare(
        'SELECT COUNT(*) AS n FROM local_runtime_message_rows WHERE session_id = ?',
      ).get(sessionId)?.n) ?? 0;
    } catch (error) {
      store.warn(`session_row_count_failed:${error.message}`);
      sessionRows = 0;
    }
  }
  return {
    matches,
    total,
    ...(sessionRows === undefined ? {} : { sessionRows }),
    offset: safeOffset,
    nextOffset: rows.length === 0 || readTo >= total ? null : readTo,
    source: 'sqlite',
    // Set only when the indexed `LIKE` found nothing and the Unicode pass answered.
    // Absent otherwise, rather than `false`, so a caller reading the key's presence
    // is reading "this one cost a scan" and not "this one did not".
    ...(unindexedCase ? { unindexedCaseMatch: true } : {}),
  };
}

/**
 * Where in a record a needle sits, or `null` when it is nowhere in it.
 *
 * One function, because two callers had one answer each and disagreed. The projection
 * search built its own three-way test over `msg_content` / `thinking_content` /
 * `tool_calls`, and the artifact search built another over `content[].text` /
 * `content[].thinking` / `content[].toolCall` — and the second one read a tool call's
 * payload from `part.input ?? part.args` while the runtime writes `part.arguments`. It
 * found the same term on the projection path and did not find it on the artifact path,
 * for the same session, with no note saying the two sources differ.
 *
 * So the field a hit is *reported* under and the text the excerpt is *taken* from are
 * both decided here, once. A caller cannot be told `field: 'content'` and handed an
 * excerpt from somewhere else, because there is no longer a place where those two could
 * be chosen independently.
 *
 * Arguments before results: a result is usually the larger text and the argument is the
 * one that names what was being done. A shell result echoes its own command line, so the
 * same term is often in both halves of the same call — and the argument is the one worth
 * naming, since it is the one the model wrote.
 *
 * @param {{content?: unknown, thinking?: unknown, calls?: Array<{args?: unknown, result?: unknown}>}} record
 * @param {string} needle the caller's query, not case-folded
 * @returns {{field: 'content'|'thinking'|'other', in: 'args'|'result'|null, text: string}|null}
 */
export function locateNeedle({ content, thinking, calls } = {}, needle) {
  if (typeof needle !== 'string' || needle === '') return null;
  const lower = needle.toLowerCase();
  const holds = (value) => {
    const text = asSearchableText(value);
    return text !== null && text.toLowerCase().includes(lower) ? text : null;
  };
  const inContent = holds(content);
  if (inContent !== null) return { field: 'content', in: null, text: inContent };
  const inThinking = holds(thinking);
  if (inThinking !== null) return { field: 'thinking', in: null, text: inThinking };
  for (const call of Array.isArray(calls) ? calls : []) {
    const inArgs = holds(call?.args);
    if (inArgs !== null) return { field: 'other', in: 'args', text: inArgs };
    const inResult = holds(call?.result);
    if (inResult !== null) return { field: 'other', in: 'result', text: inResult };
  }
  return null;
}

/**
 * A tool call's payload as text a substring can be searched in.
 *
 * The projection stores an argument as a string already; the artifact stores it as the
 * structured object the model was called with. Both are real, so both are folded into
 * text rather than one of them being read as absent — and a `null` stays `null`, because
 * `JSON.stringify(null)` is the four characters `null` and a search for the word "null"
 * must not match every call the model never returned a result for.
 */
function asSearchableText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  return JSON.stringify(value) ?? null;
}

/**
 * The match with `SNIPPET_RADIUS` characters either side, and where it sits.
 *
 * The index is found on the *original* string, not on a lower-cased copy, and the
 * reason is not a preference. Lower-casing is not length-preserving: `İ` (U+0130)
 * becomes two characters, so in "İstanbul matters" the offset of "matters" in the
 * lower-cased text is 10 while it is 9 in the original, and slicing the original at
 * the lower-cased offset returns "atters" — the match itself, cut. With two such
 * characters in front of it the drift is larger still.
 *
 * This is not hypothetical: `İ` appears in 16 of the most recent 20000 message rows
 * on the machine this was measured on. A case-insensitive match is still wanted, so
 * the needle is folded while the haystack is not, and the search is done in a way that
 * keeps the offsets honest — comparing on a folded copy but only ever reporting a
 * position in the original.
 *
 * Exported because `trajectory_find`'s artifact path quotes matches too, and it used
 * to take the first 400 characters of a message instead — a window chosen by where the
 * record begins rather than by where the match is.
 */
export function snippetAround(text, needle) {
  if (typeof text !== 'string' || text === '') return null;
  const folded = needle.toLowerCase();
  // Fast path: when folding preserves the length — every ASCII needle, which is the
  // overwhelming majority — the offsets coincide and one `indexOf` answers both.
  if (text.toLowerCase().length === text.length) {
    return sliceAt(text, text.toLowerCase().indexOf(folded), needle.length);
  }
  // Otherwise walk the original and compare each candidate slice, folded on both
  // sides, against the folded needle. Comparing slices rather than whole strings keeps
  // the comparison length-correct even when the two sides fold to different lengths.
  const width = needle.length;
  for (let at = 0; at + width <= text.length; at += 1) {
    if (text.slice(at, at + width).toLowerCase() === folded) {
      return sliceAt(text, at, width);
    }
  }
  return null;
}

/** `SNIPPET_RADIUS` either side of a known-good offset, with ellipses where cut. */
function sliceAt(text, at, width) {
  if (at < 0) return null;
  const from = Math.max(0, at - SNIPPET_RADIUS);
  const to = Math.min(text.length, at + width + SNIPPET_RADIUS);
  return (from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '');
}
