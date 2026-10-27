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
import { ingressAggregate } from './ingress.mjs';
import { LIMITS, TOOL_STATUS_OK, clamp, normalizeOffset } from './config.mjs';

/** Folded totals for one session, or null when the session is unknown. */
export function getStats(store, sessionId) {
  const session = store.getSession(sessionId);
  if (!store.db || !session) return null;
  // Keyed on the message rows themselves, not on the session's own updated_at_ms:
  // the runtime writes those rows while indexing and does not touch the session
  // row, so a session-scoped key kept serving the totals from before the write.
  //
  // The change-set signature rides along because this reply now reports `changedTurns`,
  // and a change set is written *after* the message rows of its own turn — 320 of 351
  // sessions on the machine this was measured on have their last change set land after
  // their last message row. Without it, a summary computed in that window reported
  // `changedTurns: 0` for as long as the process lived.
  //
  // The intake signature rides along for the same reason and one more: a turn that fails
  // at intake writes **no message row at all** — that is the whole shape this field
  // exists for — so neither the message signature nor the session row moves when one
  // dies. A summary computed before the failure would report `turnsFailedOrAborted: 0`
  // and keep saying so, which is precisely the clean bill of health the field exists to
  // withhold. A cache key has to carry everything the cached value is allowed to forget.
  return store.cached(store.statsCache,
    `${sessionId}|${store.messageSignature(sessionId)}|${store.changeSignature(sessionId)}|${store.ingressSignature(sessionId)}`,
    () => computeStats(store, sessionId, session));
}

function computeStats(store, sessionId, session) {
  const agg = rowAggregate(store, sessionId);
  const toolTasks = toolTaskAggregate(store, sessionId);
  const assets = assetAggregate(store, sessionId);
  const changes = changeAggregate(store, sessionId);
  const goal = goalAggregate(store, sessionId);
  const ingress = ingressAggregate(store, sessionId);

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
    // Why this run stopped, when it stopped badly.
    //
    // The session row already carries it, already mapped and already swept for
    // credentials — `sessionSummary` publishes it on every `trajectory_list` and
    // `trajectory_search` row. This fold republished seven fields off the same row and
    // dropped the eighth, so `status: 'error'` arrived without the one thing that says
    // what went wrong. That is the worst shape, because a status word is read as an
    // answer: on the machine this was found on, 43 sessions carry an error and the
    // messages are `ENOSPC: no space left on device, write`,
    // `Mandatory V2 Agent prompt is missing: _v2/…`, `BYOK provider … failed`. The
    // sessions that failed *first* are the ones with a single message row and
    // `turns: 1` — the error text is the whole story, and the fold reported a run that
    // did one turn of nothing.
    //
    // Conditional, like every other disclosure here: absent when the row has no message,
    // which is the ordinary case. A constant `errorMessage: null` would ask every reader
    // to check whether it means anything.
    ...(typeof session.errorMessage === 'string' && session.errorMessage.length > 0
      ? { errorMessage: session.errorMessage } : {}),
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
    // Delivered or attached, not edited. `changedTurns` sits beside it because the two
    // disagree on almost every real session, and a reader who has only `assets` cannot
    // tell a session that produced nothing from one that rewrote a repository.
    assets: assets.total,
    changedTurns: changes.turns,
    changesAvailable: changes.available,
    // How many of those change sets name a turn the transcript does not carry. `null`
    // when the count could not be read, never `0` — the same rule as `changesAvailable`:
    // a broken query is not a finding of zero. A reader who sees `changedTurns: 6` and
    // `unmatchedTurns: 5` knows before paging anything that the turn view is not where
    // those six live.
    unmatchedTurns: changes.unmatchedTurns,
    // What the run was asked to do, when the runtime recorded it. Spread flat rather
    // than nested under a `goal` key so a reader holding `title` next to `objective`
    // has both in the same object — the whole point is that they are different facts
    // that must be read together, 13 of 15 real pairs sharing almost no vocabulary.
    //
    // Absent when no goal was recorded, which is the common case (618 of 633 sessions on
    // the measured machine). Never the title: a fallback there would make the field look
    // present whenever the reader most wants it to be.
    ...(goal.goal?.objective ? {
      objective: goal.goal.objective,
      goalId: goal.goal.goalId,
      goalStatus: goal.goal.status,
      goalCreatedAtMs: goal.goal.createdAtMs,
      goalTokensUsed: goal.goal.tokensUsed,
      goalTimeUsedSeconds: goal.goal.timeUsedSeconds,
    } : {}),
    // Whether the runtime could have told us, as opposed to having nothing to tell. This
    // is the field that separates "this session had no goal" from "this runtime has no
    // such table", and it is always present so the two never look the same.
    goalAvailable: goal.available,
    // Turns the runtime accepted that ended badly, and accepted turns the transcript does
    // not carry. Two separate numbers because they answer separate questions, and a
    // session can have either without the other: 13 turns on the machine this was measured
    // on completed and are equally invisible, while the session's own `turns`, `status`
    // and `errorMessage` all read clean. Without these a reader has no way to learn that
    // some of its turns died, because the transcript does not contain them.
    //
    // `null` when the runtime records no intake at all — never `0`, which would be the
    // clean bill of health this field exists to withhold.
    ingressAvailable: ingress.available,
    turnsFailedOrAborted: ingress.failedOrAborted,
    turnsMissingFromTranscript: ingress.missingFromTranscript,
    sources: agg.sources,
    children: session.children.length,
    // Never an empty array by construction: an aggregate that could not run says so
    // here. This field was a hardcoded `[]` that no code path could ever fill, which
    // made it worse than absent — a model reading `warnings: []` concluded the summary
    // was clean while `subagentTasks` was quietly reporting a failed count as a real
    // zero. Now the only way it reads empty is when nothing degraded.
    // `agg.degraded` is a list already — `rowAggregate` pushes onto it per failed subquery
    // — so it is spread, while the other four are single strings or null and are not. The
    // first version of this line collected all five alike and shipped `[[]]` as a warning,
    // because `filter(Boolean)` keeps an empty array: a nested empty array in a warnings
    // field is the one value that makes every reader's "did anything degrade?" check say
    // yes while naming nothing.
    warnings: [
      ...agg.degraded, toolTasks.degraded, assets.degraded, changes.degraded, goal.degraded,
      ingress.degraded,
    ].filter(Boolean),
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
  // Every fallback below turns a missing column into a zero, and the two headline
  // numbers this produces — `turns` and `events` — are the ones a reader reports as
  // findings. Collected here so the answer carries the fact, not just the session log:
  // `store.warn` reaches `trajectory_list`, but a caller that asked only for this
  // summary would never see it and would read a failed fold as an empty session.
  const degraded = [];
  try {
    base = store.db.prepare(sql).get(sessionId) || {};
  } catch (error) {
    store.warn(`row_aggregate_failed:${error.message}`);
    degraded.push('turns, steps and token totals are unavailable: the aggregate query failed, so 0 in each means "not counted"');
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
        SUM(CASE WHEN COALESCE(json_extract(tc.value, '$.tool_call_status'), ${TOOL_STATUS_OK}) <> ${TOOL_STATUS_OK} THEN 1 ELSE 0 END) AS failures
      FROM local_runtime_message_rows AS r, json_each(
        CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END, '$.tool_calls'
      ) AS tc
      WHERE r.session_id = ?
    `).get(sessionId) || {};
    toolCalls = num(row.calls) ?? 0;
    toolFailures = num(row.failures) ?? 0;
  } catch {
    // Older rows may lack the tool_calls shape, so the counts below stay at the 0 they
    // were seeded with — and `toolCalls: 0` is a finding ("this run called no tools"),
    // not a failure. Recorded, because nothing else in the answer would say otherwise.
    store.warn('tool_call_count_failed:tool call counts could not be computed, so toolCalls=0 means "not counted"');
    degraded.push('tool call counts are unavailable: the query failed, so toolCalls=0 means "not counted"');
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
    degraded,
  };
}

/**
 * Background-task totals, with the reason when they are not real.
 *
 * `totalMs` degrades to `null` and reads as "unavailable", which is honest. The
 * counts cannot: they are numbers, and a `0` produced by a failed query is
 * indistinguishable from a session that genuinely ran no tasks. So the failure rides
 * along in `degraded` and becomes a warning on the answer. Silence here would let a
 * model report "no sub-agents were dispatched" for a runtime that could not be asked.
 */
function toolTaskAggregate(store, sessionId) {
  if (!store.db || !tableExists(store.db, 'local_runtime_background_tasks')) {
    return {
      totalMs: null,
      taskCount: 0,
      subagentCount: 0,
      degraded: 'background task totals are unavailable: this runtime exposes no local_runtime_background_tasks table',
    };
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
      // COALESCE, because SQL sums no rows to NULL and that null means "this session
      // ran no background tasks" — a known zero — not "the duration could not be
      // computed". Left un-coalesced, `toolMs` answered null for a session that
      // demonstrably used no tools, which is the one answer the panel can make with
      // certainty. The unavailable case is now reached only through `degraded`.
      totalMs: num(row.total_ms) ?? 0,
      taskCount: num(row.task_count) ?? 0,
      subagentCount: num(row.subagent_count) ?? 0,
      // An empty table is a real answer, not a degradation: COUNT is 0 and there is
      // nothing to apologise for.
      degraded: null,
    };
  } catch {
    return {
      totalMs: null,
      taskCount: 0,
      subagentCount: 0,
      degraded: 'background task totals are unavailable: the query failed, so 0 means "not counted", not "none ran"',
    };
  }
}

/** Session asset count, with the same failure-does-not-become-a-zero rule. */
function assetAggregate(store, sessionId) {
  if (!store.db || !tableExists(store.db, 'local_runtime_session_assets')) {
    return { total: 0, degraded: 'session asset counts are unavailable: this runtime exposes no local_runtime_session_assets table' };
  }
  try {
    const row = store.db.prepare(
      'SELECT COUNT(*) AS total FROM local_runtime_session_assets WHERE session_id = ?',
    ).get(sessionId) || {};
    return { total: num(row.total) ?? 0, degraded: null };
  } catch {
    return { total: 0, degraded: 'session asset counts are unavailable: the query failed, so 0 means "not counted", not "none exist"' };
  }
}

/**
 * How many of the session's turns recorded file changes, and whether that can be said.
 *
 * This exists because of a measured asymmetry rather than a design preference. On the
 * machine this was measured on, **329 of the 351 sessions that have any file change
 * record have no delivered asset at all** — `assets: 0` — while `trajectory_summary`
 * was the tool that reported it. A reader who checks `assets` and sees zero concludes
 * the session produced nothing, and for nine sessions in ten that is wrong by dozens of
 * files: one session reports `assets: 0` next to 84 edited files. Where both exist the
 * counts differ 19 times out of 22, in both directions, so neither number stands in for
 * the other.
 *
 * A turn count, and not a file count, on purpose. The file total would need
 * `SUM(json_array_length(file_changes_json))` over the session's change sets, which
 * measures **206 ms on the busiest session here (328 change sets)** against **0.03 ms**
 * for the row count — and parsing the same JSON in the process costs 965 ms. This is
 * the tool the Skill tells a reader to call *first*; spending a fifth of a second there
 * to repeat a number `trajectory_changes` already returns as `matchedFiles` would buy
 * nothing. The turn count is enough to kill the misreading, because it is the cheapest
 * fact that says "this session touched files".
 *
 * `unmatchedTurns` is the other half of that same sentence, and it exists because the
 * count above is **not a subset of the turns `trajectory_turns` lists**. The two tables
 * are written independently and are not required to agree on which turns exist: on the
 * machine this was measured on, 307 of 1,417 change sets — 11.8% of every file entry —
 * name a turn no message row carries, and on **7 of 351 sessions this count is strictly
 * larger than the turn total**, the worst case 165 against 2.
 *
 * Both numbers were correct. A reader who pages `trajectory_turns` to see what
 * `changedTurns` refers to finds fewer turns than the number they are holding, with
 * nothing on either reply to say the two were never comparable — and `trajectory_get`
 * with one of those turn ids returns nothing at all.
 *
 * The count is not shrunk to make the two fit: that would report 1 and hide five real
 * change sets. The disagreement is published instead, on the tool the Skill tells a
 * reader to call first.
 */
function changeAggregate(store, sessionId) {
  if (!store.db || !tableExists(store.db, 'local_runtime_turn_diffs')) {
    return {
      turns: 0,
      unmatchedTurns: null,
      available: false,
      degraded: 'file change counts are unavailable: this runtime exposes no local_runtime_turn_diffs table, so 0 means "not recorded", not "nothing changed"',
    };
  }
  try {
    // One statement, so the two numbers cannot come from different moments in a run that
    // is still writing.
    //
    // `IS`, not `=`, and that one word is the whole performance story. The runtime keeps
    // `idx_local_runtime_message_rows_turn_source (session_id, turn_id, role, id)`, which
    // is exactly the index this probe wants — but `COALESCE(m.turn_id, '') =
    // COALESCE(d.turn_id, '')` wraps both sides in a function, so the planner cannot use
    // it and every change set rescans the session's message rows. Measured on the busiest
    // session here (330 change sets): **287 ms with `COALESCE`, 0.20 ms with `IS`**.
    //
    // `IS` is not a trick to dodge the NULL problem — it *is* SQLite's NULL-safe
    // comparison, so a change set carrying no turn id is matched against the transcript's
    // own "no turn" rows exactly as the turn fold's `COALESCE(turn_id, '')` group defines
    // it. The first version normalised both sides in SQL for readability and spent 287 ms
    // on the tool this plugin tells a reader to call *first* — the same mistake as the
    // file count this aggregate was written to avoid, one field over.
    const row = store.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN EXISTS (
               SELECT 1 FROM local_runtime_message_rows m
               WHERE m.session_id = d.session_id AND m.turn_id IS d.turn_id
             ) THEN 0 ELSE 1 END) AS unmatched
      FROM local_runtime_turn_diffs d
      WHERE d.session_id = ?
    `).get(sessionId) || {};
    const turns = num(row.total) ?? 0;
    const unmatched = num(row.unmatched) ?? 0;
    return {
      turns,
      unmatchedTurns: unmatched,
      available: true,
      // No `degraded` here, on purpose. In this reply a warning means an aggregate could
      // not be computed, so its `0` is not a finding — and both numbers came from real
      // rows. A caveat filed here would tell a reader `changedTurns` is unreliable when
      // the only thing wrong is that they measured it against the wrong denominator.
      // The disagreement is published as a field the reader can compare, not as an
      // apology attached to a number that is exactly right.
      degraded: null,
    };
  } catch {
    return {
      turns: 0,
      unmatchedTurns: null,
      available: false,
      degraded: 'file change counts are unavailable: the query failed, so 0 means "not counted", not "nothing changed"',
    };
  }
}

/**
 * The assets themselves: one row per file a session delivered or referenced.
 *
 * `assetAggregate` above answers how many; this answers which. The count was
 * reachable and the content was not, so a reader asking "which files came out of
 * that session" was told there were 112 and then had to page the event log to
 * discover their names — and an event page is a thousand records to find rows this
 * table already indexes. On the largest session measured, the whole list is one
 * 2 ms query against a 28 KB page.
 *
 * `available` is separate from `total` for the same reason `degraded` is: a runtime
 * with no assets table, or a query that threw, must not answer `[]` and let the
 * reader conclude the session produced nothing. There is no JSONL fallback here —
 * the fallback directory holds messages, and an asset that exists only as a path in
 * a message body is that session's `trajectory_find` business, not this table's.
 *
 * Ordering is the order they were produced: `message_created_at_ms`, then `id`.
 * `asset_index` is deliberately not in the sort: it is per message, not per session —
 * it restarts at zero for each `msg_id` — and `id` is a unique key, so an `asset_index`
 * term after it could never be reached. It is carried on the row instead, for a caller
 * that wants the position within its message.
 *
 * @returns {{assets: object[], total: number, available: boolean}}
 */
/**
 * The objective the run was kicked off with, and whether that can be said.
 *
 * `local_runtime_thread_goals` is the runtime's own record of what it was asked to do.
 * On the machine this was read from it is 15 rows across 15 sessions, and on that
 * machine the text is the **only** copy of the objective: the FTS index does not carry
 * it, and none of those sessions has a `messages.jsonl` artifact to fall back on. So
 * "what was that run actually asked to do" had no answer anywhere in the plugin — a
 * reader scanning history saw the title and inferred the rest.
 *
 * The inference is wrong more often than not. Over all 15 rows, **`objective` and
 * `title` share almost no vocabulary in 13 of them** — measured as Jaccard overlap on
 * tokenised text, 13 below 0.15:
 *
 * | title | objective (truncated) |
 * |---|---|
 * | 同步本地与远程分支代码 | 继续深挖当前插件的方方面面可能存在的问题，持续优化迭代… |
 * | 查询项目前后端架构 | 整理并落地一套比较好的后续方案，可以很方便的集成更多的动画效果 |
 * | 排查项目部署缺少的组件 | 尽可能删除所有对这台远程机器的操作记录和访问记录 |
 *
 * The title is a real field of a real row, so nothing on any reply contradicts the
 * reader's inference. That is what makes this worth publishing rather than leaving to
 * inference: **a wrong conclusion drawn from a correct field looks exactly like a right
 * one.**
 *
 * Absent — not empty, not the title — when the session has no row. 618 of the 633
 * sessions on that machine have none, so the common case is the absent one, and falling
 * back to the title there would make the field look present when it was never recorded.
 * `available` separates "no goal was recorded" from "this runtime has no such table",
 * which is the same distinction every other capability in this reply draws.
 *
 * One row per session on that machine (0 sessions had two), but `ORDER BY created_at_ms
 * DESC` keeps the answer defined if that ever stops being true rather than letting an
 * arbitrary row win.
 */
function goalAggregate(store, sessionId) {
  if (!store.db || !tableExists(store.db, 'local_runtime_thread_goals')) {
    return {
      goal: null,
      available: false,
      degraded: 'the recorded objective is unavailable: this runtime exposes no local_runtime_thread_goals table, so the title is all there is',
    };
  }
  try {
    const row = store.db.prepare(`
      SELECT goal_id, objective, status, created_at_ms, updated_at_ms,
             tokens_used, time_used_seconds
      FROM local_runtime_thread_goals
      WHERE session_id = ?
      ORDER BY created_at_ms DESC
      LIMIT 1
    `).get(sessionId);
    if (!row) return { goal: null, available: true, degraded: null };
    return {
      goal: {
        goalId: row.goal_id ?? null,
        objective: typeof row.objective === 'string' ? row.objective : null,
        status: typeof row.status === 'string' ? row.status : null,
        createdAtMs: num(row.created_at_ms),
        updatedAtMs: num(row.updated_at_ms),
        tokensUsed: num(row.tokens_used),
        timeUsedSeconds: num(row.time_used_seconds),
      },
      available: true,
      degraded: null,
    };
  } catch (error) {
    store.warn(`thread_goal_read_failed:${error.message}`);
    return {
      goal: null,
      available: false,
      degraded: 'the recorded objective is unavailable: the query failed, so the title is all there is',
    };
  }
}

export function listSessionAssets(store, sessionId, { offset = 0, limit = 50 } = {}) {
  const unavailable = { assets: [], total: 0, available: false };
  if (!store.db || !tableExists(store.db, 'local_runtime_session_assets')) return unavailable;
  const from = normalizeOffset(offset);
  const cap = clamp(limit, LIMITS.assets);
  try {
    const { total } = store.db.prepare(
      'SELECT COUNT(*) AS total FROM local_runtime_session_assets WHERE session_id = ?',
    ).get(sessionId) || {};
    const rows = store.db.prepare(`
      SELECT id, msg_id, role, message_created_at_ms, asset_index, source_tag, path, name,
             asset_type, artifact_id, drive_node_id, created_at_ms
      FROM local_runtime_session_assets
      WHERE session_id = ?
      ORDER BY message_created_at_ms, id
      LIMIT ? OFFSET ?
    `).all(sessionId, cap, from);
    return {
      // `asset_type` is NULL for 571 of 746 rows on a real machine, so it is carried
      // through as-is rather than guessed from the extension: a guessed type would be
      // wrong more often than it was right.
      assets: rows.map((row) => ({
        id: num(row.id),
        msgId: row.msg_id ?? null,
        role: row.role ?? null,
        // Its position inside that message, not inside the session. Real data repeats
        // both the path and this value: one session delivered the same `final.gif`
        // three times, each as `asset_index` 0 of its own message.
        assetIndex: num(row.asset_index),
        createdAtMs: num(row.message_created_at_ms ?? row.created_at_ms),
        sourceTag: row.source_tag ?? null,
        path: row.path ?? null,
        name: row.name ?? null,
        assetType: row.asset_type ?? null,
        artifactId: row.artifact_id ?? null,
        driveNodeId: row.drive_node_id ?? null,
      })),
      total: num(total) ?? 0,
      available: true,
    };
  } catch (error) {
    store.warn(`asset_list_failed:${error.message}`);
    return unavailable;
  }
}
