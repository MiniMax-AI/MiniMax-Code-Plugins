/**
 * Background tasks: the runtime's record of tool and sub-agent work.
 *
 * A task row carries `created_at_ms`/`ended_at_ms`, which is where a tool call's
 * *measured* wall-clock comes from — the Plugin never estimates a duration from
 * record spacing. Tasks are indexed by the tool call that spawned them so a tool
 * call and its duration live on one row.
 */

import path from 'node:path';

import { num } from './json.mjs';
import { tableExists } from './sqlite.mjs';
import { openContainedRead } from './fsutil.mjs';
import { redactText } from './redact.mjs';
import { LIMITS, clamp, normalizeOffset, backgroundTasksRoot, TASK_TEXT_LIMIT } from './config.mjs';

/**
 * The one description of "the tasks this session owns, of this kind".
 *
 * `listBackgroundTasks` and `countBackgroundTasks` used to spell this out separately.
 * They agreed, and they would have kept agreeing right up until someone added a
 * filter to one of them — at which point `total` would describe a different set than
 * the page, and `nextOffset` would walk toward a bound that no longer matched what
 * the cursor was skipping. That is not hypothetical here: the session list and its
 * count drifted exactly this way once, and the fix there was a shared `sessionFilter`.
 *
 * One builder, so a new filter is added in one place and the two cannot disagree.
 *
 * @returns {{where: string[], params: unknown[]}}
 */
function taskFilter(sessionId, kind) {
  const where = ['owner_session_id = ?'];
  const params = [sessionId];
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
  return { where, params };
}

/**
 * Whether this runtime has a table to read background tasks from at all.
 *
 * A missing table is the same kind of fact as a count that failed: the query could not
 * run, so a `0` from it is "not counted" rather than "this session dispatched nothing".
 * The count path below already says so when the query *throws*, and leaving the other
 * way it can fail silent meant a runtime without this table reported an empty task list
 * with nothing to distinguish it from a session that really ran none — which is the one
 * answer here that is a finding, and the one this could not support.
 *
 * The warning itself is raised once by the `Store` constructor, which probes every
 * install-level capability in one place; this is only the read-side test, and it trusts
 * the flag when the store has one so a directly constructed stub still works.
 */
function tasksTableMissing(store) {
  if (typeof store.hasTasks === 'boolean') return !store.hasTasks;
  return Boolean(store.db) && !tableExists(store.db, 'local_runtime_background_tasks');
}

/** Background tasks owned by a session, including sub-agent dispatches. */
export function listBackgroundTasks(store, sessionId, { limit = LIMITS.tasks.default, kind, offset = 0 } = {}) {
  if (!store.db || tasksTableMissing(store)) return [];
  const expr = (jsonPath) => `json_extract(record_json, '${jsonPath}')`;
  const { where, params } = taskFilter(sessionId, kind);
  params.push(clamp(limit, LIMITS.tasks), normalizeOffset(offset));
  let rows = [];
  try {
    rows = store.db.prepare(`
      SELECT
        task_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms,
        MAX(0, COALESCE(ended_at_ms, updated_at_ms) - created_at_ms) AS duration_ms,
        ${expr('$.description')} AS description,
        ${expr('$.toolCallId')} AS tool_call_id,
        ${expr('$.metadata.agentName')} AS agent_name,
        ${expr('$.metadata.childSessionId')} AS child_session_id,
        ${expr('$.metadata.parentTurnId')} AS parent_turn_id,
        ${expr('$.metadata.command')} AS command,
        ${expr('$.metadata.executionMode')} AS execution_mode,
        ${expr('$.startedAt')} AS started_at_ms,
        ${expr('$.outputRef.uri')} AS output_uri
      FROM local_runtime_background_tasks
      WHERE ${where.join(' AND ')}
      ORDER BY created_at_ms DESC
      LIMIT ? OFFSET ?
    `).all(...params);
  } catch {
    return [];
  }

  return rows.map((row) => ({
    taskId: row.task_id,
    kind: row.kind,
    status: row.status,
    // A task's description is its command line for a `bash` task, which is where
    // an inline credential actually lives. Redacting here rather than at each
    // consumer means every surface — MCP, the panel, the full-detail event join —
    // gets the scrubbed text and a new consumer cannot forget to ask for it.
    description: redactText(row.description ?? row.command ?? null, { maxLength: TASK_TEXT_LIMIT }),
    command: redactText(row.command ?? null, { maxLength: TASK_TEXT_LIMIT }),
    toolCallId: row.tool_call_id ?? null,
    agentName: row.agent_name ?? null,
    childSessionId: row.child_session_id ?? null,
    parentTurnId: row.parent_turn_id ?? null,
    executionMode: row.execution_mode ?? null,
    createdAtMs: num(row.created_at_ms),
    startedAtMs: num(row.started_at_ms),
    endedAtMs: num(row.ended_at_ms),
    updatedAtMs: num(row.updated_at_ms),
    durationMs: num(row.duration_ms),
    // The absolute log path never leaves the process; consumers ask for the tail instead.
    hasOutput: Boolean(row.output_uri),
  }));
}

/**
 * Index background tasks by the tool call that spawned them, so a tool call and
 * its measured duration live on one row instead of two separate views.
 */
/**
 * How many tasks a session owns, for the same `kind` filter.
 *
 * Without this, a capped page cannot say what it left out. The task list used to take
 * the newest N with no count and no cursor, so a session with 2,500 tasks answered
 * 2,000, reported `truncated: false, omitted: 0`, and left the oldest 500 unreachable
 * through every surface — a complete-looking answer about an incomplete list.
 */
export function countBackgroundTasks(store, sessionId, { kind } = {}) {
  if (!store.db || tasksTableMissing(store)) return 0;
  const { where, params } = taskFilter(sessionId, kind);
  try {
    return num(store.db.prepare(
      `SELECT COUNT(*) AS n FROM local_runtime_background_tasks WHERE ${where.join(' AND ')}`,
    ).get(...params)?.n) ?? 0;
  } catch {
    // `total` is the claim "this session owns N tasks". Answering 0 after a failed
    // count turns a query that could not run into a finding that nothing ran, and the
    // empty `trajectory_tasks` list beside it agrees — so nothing else would contradict
    // it. The warning is the only thing that does.
    store.warn('task_count_failed:the task count could not be computed, so total=0 means "not counted"');
    return 0;
  }
}

export function taskIndex(store, sessionId) {
  // Cached for the same reason as the timeline: every page of every event read built
  // this, and building it is a full scan of the task table.
  // The task signature, not the session's: a task moving from running to completed
  // updates its own row and leaves the session row alone, so a session-scoped key
  // kept reporting the tool call as ok with the duration it had while running.
  return store.cached(store.tasksCache, `${sessionId}|${store.taskSignature(sessionId)}`, () => {
    const index = new Map();
    // "This session owns more tasks than the index holds" has to be known without a
    // second query, but asking for `LIMITS.tasks.max + 1` cannot answer it:
    // `listBackgroundTasks` clamps its `limit` to `LIMITS.tasks`, so 2001 arrived as
    // 2000, `tasks.length > LIMITS.tasks.max` was never true, and `capped` — and with
    // it `taskIndexTruncated` — stayed false for every session including ones holding
    // tens of thousands of tasks. The oldest tasks then silently resolved to no task at
    // all. The count is already needed for `total`, so it is what the cap is measured
    // against: the same query, and a bound that does not depend on the clamp.
    const tasks = listBackgroundTasks(store, sessionId, { limit: LIMITS.tasks.max });
    const total = countBackgroundTasks(store, sessionId);
    const capped = total > tasks.length;
    if (capped) {
      store.warn(`task_index_capped:more than ${LIMITS.tasks.max} tasks owned by ${sessionId}; `
        + 'tool calls outside the newest slice carry no task timing');
    }
    for (const task of tasks) {
      if (task.toolCallId) index.set(task.toolCallId, task);
      else index.set(`__task__${task.taskId}`, task);
    }
    return { byCall: index, capped, total };
  });
}

/**
 * Read the tail of a background task's captured output.
 *
 * The path is rebuilt from the data directory and the task ID rather than taken
 * from the stored URI, the ID is validated against a strict shape, and the read
 * goes through `openContainedRead`, which canonicalizes the whole path and refuses
 * anything that resolves outside the data directory. Checking the shape of the ID
 * alone is not enough: a symlinked task directory keeps the lexical path inside
 * the data directory while the kernel resolves `output.log` outside it, which is
 * how an earlier revision could be made to read an arbitrary file.
 */
export async function readTaskOutput(store, taskId, { maxBytes = LIMITS.taskOutputBytes.default } = {}) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) {
    throw new Error('invalid_task_id');
  }
  const unavailable = { taskId, available: false, bytes: 0, truncated: false, text: '' };
  // The data directory is the containment root, not `background-tasks`: that keeps
  // a root which is itself a symlink from widening the approved area.
  const opened = await openContainedRead(
    store.dataDir,
    path.join(backgroundTasksRoot(store.dataDir), taskId, 'output.log'),
  );
  if (!opened) return unavailable;

  const { handle, size } = opened;
  try {
    const limit = clamp(maxBytes, LIMITS.taskOutputBytes);
    const start = Math.max(0, size - limit);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, start);
    const text = buffer.toString('utf8');
    return {
      taskId,
      available: true,
      bytes: size,
      truncated: start > 0,
      text: start > 0 ? `… [tail of ${size} bytes]\n${text}` : text,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}
