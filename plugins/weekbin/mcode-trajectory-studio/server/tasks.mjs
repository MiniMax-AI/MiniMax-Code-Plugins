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
import { LIMITS, clamp, normalizeOffset, backgroundTasksRoot } from './config.mjs';

/** Background tasks owned by a session, including sub-agent dispatches. */
export function listBackgroundTasks(store, sessionId, { limit = LIMITS.tasks.default, kind, offset = 0 } = {}) {
  if (!store.db || !tableExists(store.db, 'local_runtime_background_tasks')) return [];
  const expr = (jsonPath) => `json_extract(record_json, '${jsonPath}')`;
  const where = ['owner_session_id = ?'];
  const params = [sessionId];
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
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
    description: redactText(row.description ?? row.command ?? null),
    command: redactText(row.command ?? null),
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
  if (!store.db || !tableExists(store.db, 'local_runtime_background_tasks')) return 0;
  const where = ['owner_session_id = ?'];
  const params = [sessionId];
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
  try {
    return num(store.db.prepare(
      `SELECT COUNT(*) AS n FROM local_runtime_background_tasks WHERE ${where.join(' AND ')}`,
    ).get(...params)?.n) ?? 0;
  } catch {
    return 0;
  }
}

export function taskIndex(store, sessionId) {
  // Cached for the same reason as the timeline: every page of every event read built
  // this, and building it is a full scan of the task table.
  const updatedAtMs = store.getSession(sessionId)?.updatedAtMs ?? 0;
  return store.cached(store.tasksCache, `${sessionId}|${updatedAtMs}`, () => {
    const index = new Map();
    for (const task of listBackgroundTasks(store, sessionId, { limit: LIMITS.tasks.max })) {
      if (task.toolCallId) index.set(task.toolCallId, task);
      else index.set(`__task__${task.taskId}`, task);
    }
    return index;
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
