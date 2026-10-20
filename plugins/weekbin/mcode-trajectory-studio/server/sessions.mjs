/**
 * Session-level reads for the sidebar and the overview header.
 *
 * The session list, one session with its direct children, the agent names actually
 * present in this install, the recorded agent definition, and the repository
 * grouping that folds every worktree of one project into a single group.
 *
 * Functions take the `Store` facade as their first argument so the domain layer
 * stays free of circular imports: they read state through `store` rather than
 * importing sibling modules.
 */

import { parseJson, num } from './json.mjs';
import { tableExists } from './sqlite.mjs';
import { redactText } from './redact.mjs';
import { resolveWorkspaceIdentities } from './git.mjs';
import { LIMITS, clamp, normalizeOffset, decodeSessionCursor } from './config.mjs';

export const SESSION_KINDS = ['conversation', 'task', 'peek', 'channel', 'cron', 'unknown'];

/**
 * Normalise a `local_runtime_sessions` row into the shape consumers use.
 *
 * A title is a person's own words, so it is kept — but it is also free text, and a
 * title that happens to quote an API key or a bearer token must not carry it out
 * of the process. Redacting the credential substring in place keeps the title
 * searchable and the secret out.
 */
export function sessionSummary(row) {
  const record = parseJson(row.record_json) || {};
  const col = (name, fallback) => (row[name] === undefined || row[name] === null ? fallback : row[name]);
  return {
    sessionId: row.session_id,
    title: redactText(col('title', record.title ?? null), { maxLength: 1024 }),
    agent: col('agent_name', record.agentName ?? null),
    sessionKind: col('session_kind', record.sessionKind ?? 'unknown'),
    status: col('status', record.status ?? null),
    runtime: col('runtime', record.runtime ?? null),
    workspaceDir: col('workspace_dir', record.workspaceDir ?? null),
    parentSessionId: col('parent_session_id', record.parentSessionId ?? null),
    createdAtMs: col('created_at_ms', record.createdAtMs ?? null),
    updatedAtMs: col('updated_at_ms', null),
    archived: Boolean(col('archived', 0)),
    // A failed session's error text routinely quotes the command that failed.
    errorMessage: redactText(col('error_message', null)),
  };
}

/**
 * The filter clause shared by the session list and its total.
 *
 * One function on purpose. A second copy of these conditions is how a count comes to
 * describe a different population than the rows it is counting — and a `total` that
 * disagrees with the list is worse than no `total`, because it is believed.
 */
function sessionFilter(store, { agent, kind, parentSessionId, sinceMs, untilMs, includeArchived = false } = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (!includeArchived && store.has('sessions', 'archived')) where.push('archived = 0');
  if (store.has('sessions', 'visibility')) where.push("visibility <> 'hidden'");
  if (agent) {
    where.push('agent_name = ?');
    params.push(agent);
  }
  if (kind) {
    where.push('session_kind = ?');
    params.push(kind);
  }
  // The sub-agent sessions one session dispatched, as a filter rather than as
  // something the caller has to assemble.
  //
  // `sessionSummary` already returns `parentSessionId`, so a model reading a session
  // could *see* that it has children and then have no way to reach them: this filter
  // did not exist, `parent_session_id` is not one of the FTS columns, and the only way
  // to enumerate them was to page the whole machine and pick them out locally. On this
  // one that is four calls across 614 rows to find the 292 children of
  // `mvs_d91a302ec40c47e8…`, against one indexed query. A field that is published but
  // not filterable is a dead end wearing a label.
  //
  // `rootOnly` is the other half of the same question and is cheaper to answer here
  // than in the client: it is the same predicate with `NULL` instead of the id, and
  // without it "show me the top-level sessions" costs the same full-machine page.
  if (parentSessionId === 'root') {
    where.push("parent_session_id IS NULL OR parent_session_id = ''");
  } else if (typeof parentSessionId === 'string' && parentSessionId.trim()) {
    where.push('parent_session_id = ?');
    params.push(parentSessionId.trim());
  }
  if (Number.isFinite(sinceMs)) {
    where.push('updated_at_ms >= ?');
    params.push(sinceMs);
  }
  // The upper bound `sinceMs` cannot express. "The session from March" is a range,
  // and a lower bound alone answers it by returning everything since March instead —
  // which on a busy machine is the whole list, newest first, with the March session
  // buried at whatever offset it happens to land on.
  if (Number.isFinite(untilMs)) {
    where.push('updated_at_ms <= ?');
    params.push(untilMs);
  }
  return { where: where.join(' AND '), params };
}

/**
 * Recent sessions, newest first, with optional agent/kind/time filters.
 *
 * Two ways to say "the rest of it", and which one applies depends on the cursor:
 *
 * - `cursor` is a keyset cursor — the sort key of the last row the caller already has,
 *   plus the instant the walk started. It is what a walk pages on, because `LIMIT ?
 *   OFFSET ?` counts *positions* and the runtime rewrites `updated_at_ms` whenever it
 *   writes to a session: a session updated after the page that would have carried it
 *   jumps above the cursor and is never delivered again, while the walk still ends by
 *   reporting no cursor at all. Measured on a fixture, that walk ended claiming twelve
 *   of twelve sessions and had delivered eleven distinct ones.
 * - `offset` is the positional form, kept only for a runtime whose sessions table has
 *   no `updated_at_ms`. There the recency order never existed and `rowid` is the sort
 *   key, which nothing rewrites, so positional paging cannot lose a row.
 *
 * The secondary sort key is not decoration. `updated_at_ms` is a millisecond stamp, so
 * sessions tie on it — three do on one measured machine — and a row order that is only
 * partly determined puts that tie group across a page boundary by a rule nobody wrote
 * down. `session_id` is the table's primary key, so it makes the order total.
 *
 * @param {object} store the `Store` facade
 * @param {{limit?: number, agent?: string, kind?: string, parentSessionId?: string,
 *   sinceMs?: number, untilMs?: number, includeArchived?: boolean, cursor?: string,
 *   offset?: number}} [options]
 */
export function listSessions(store, { limit = LIMITS.sessions.default, agent, kind, parentSessionId, sinceMs, untilMs, includeArchived = false, cursor, offset = 0 } = {}) {
  if (!store.db) return [];
  // Named out rather than spread: this signature lists its filters by hand, so a new
  // one added to `sessionFilter` and forgotten here would be accepted, counted by
  // `countSessions`, and then ignored by the read that answers the page — a filter the
  // caller was told applied and that silently did not.
  const { where, params } = sessionFilter(store, { agent, kind, parentSessionId, sinceMs, untilMs, includeArchived });
  const keyed = store.has('sessions', 'updated_at_ms');
  const at = keyed ? decodeSessionCursor(cursor) : null;
  // `where` is one assembled clause, not a list of them, so it joins as a single element.
  const clauses = [where];
  const args = [...params];
  let order;
  if (keyed) {
    // Strictly older than the cursor, with `session_id` breaking the tie the stamp
    // leaves open. `updated_at_ms = ? AND session_id < ?` is what makes a page that
    // stops in the middle of a tie group resume *after* the last row it carried rather
    // than re-delivering the rest of the group.
    if (at) {
      clauses.push('(updated_at_ms < ? OR (updated_at_ms = ? AND session_id < ?))');
      args.push(at.updatedAtMs, at.updatedAtMs, at.sessionId);
    }
    order = 'updated_at_ms DESC, session_id DESC';
  } else {
    order = 'rowid DESC';
  }
  const sql = keyed
    ? `SELECT * FROM local_runtime_sessions WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT ?`
    : `SELECT * FROM local_runtime_sessions WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`;
  args.push(clamp(limit, LIMITS.sessions));
  if (!keyed) args.push(normalizeOffset(offset));
  let rows = [];
  try {
    rows = store.db.prepare(sql).all(...args);
  } catch (error) {
    store.warn(`session_list_failed:${error.message}`);
    return [];
  }
  return rows.map(sessionSummary);
}

/**
 * How many sessions the same filter matches, independent of any page.
 *
 * Not cached. A count over a sessions table is cheap, and the obvious cache key here —
 * the message-row signature — has nothing to do with the sessions table, so caching
 * against it would return one session's number to every caller.
 */
export function countSessions(store, filters = {}) {
  if (!store.db) return 0;
  const { where, params } = sessionFilter(store, filters);
  try {
    return num(store.db.prepare(`SELECT COUNT(*) AS n FROM local_runtime_sessions WHERE ${where}`).get(...params)?.n) ?? 0;
  } catch (error) {
    store.warn(`session_count_failed:${error.message}`);
    return 0;
  }
}

/** Read one session row plus its direct child sessions (sub-agents / tasks). */
export function getSession(store, sessionId) {
  if (!store.db) return null;
  let row;
  try {
    row = store.db.prepare('SELECT * FROM local_runtime_sessions WHERE session_id = ?').get(sessionId);
  } catch (error) {
    // A null here becomes `session_not_found:<id>` at every surface above, whose advice
    // is "re-read trajectory_list, it may have been mistyped or archived". Following
    // that advice would not help: the row was never asked for successfully.
    store.warn(`session_read_failed:${error.message}`);
    return null;
  }
  if (!row) return null;
  const summary = sessionSummary(row);
  let children = [];
  let childrenCapped = false;
  if (store.has('sessions', 'parent_session_id')) {
    try {
      // One row past the cap, so "there are more children" is known without a second
      // query. LIMIT 200 with no count meant a parent with 210 children reported 200
      // of them and said nothing, which is the same shape as a session that really
      // has 200.
      const childRows = store.db
        .prepare('SELECT * FROM local_runtime_sessions WHERE parent_session_id = ? ORDER BY created_at_ms ASC LIMIT 201')
        .all(sessionId);
      childrenCapped = childRows.length > 200;
      children = childRows.slice(0, 200).map(sessionSummary);
    } catch (error) {
      store.warn(`child_sessions_failed:${error.message}`);
      children = [];
    }
  } else {
    // No column to ask about, so the empty list is an assumption rather than a count —
    // and `subagentTasks`-style reasoning reads an empty `children` as "ran none".
    store.warn('child_sessions_unavailable:this runtime\'s sessions table has no parent_session_id column, so children=[] means "not counted"');
  }
  return { ...summary, children, ...(childrenCapped ? { childrenCapped: true } : {}) };
}

/**
 * Agent names actually present in this install, with session counts.
 *
 * Sub-agent presets are per-machine, so the sidebar filter is built from the data
 * rather than from a fixed list of names.
 *
 * The counts describe the **population** this call is scoped to, not the machine in
 * general, and they come from `sessionFilter` so that "which sessions count" is
 * decided in one place. It was not, and the two copies disagreed in the same reply:
 * `trajectory_list` publishes `agents` beside the `total` it filtered, the panel's
 * filter prints `mavis (183)` next to a list whose `total` is 614, and selecting
 * that option returns 172 — because this function's `GROUP BY` had no `archived`
 * condition while the `total` beside it did. Measured on this install: 19 archived
 * sessions, every one of them named, all 19 counted here and none of them in the
 * total. That is the failure `sessionFilter`'s own note above warns about — a count
 * that disagrees with the rows it counts is believed, and here both numbers were in
 * the same object.
 *
 * Population, not slice: `sessionFilter`'s population conditions (`archived`,
 * `visibility`) are applied, while the caller's narrowing filters (`agent`, `kind`,
 * `sinceMs`, `parentSessionId`) are not. A vocabulary has to survive a filter that
 * matched nothing — that empty page is precisely when the caller needs to be told the
 * name was wrong. What it must not do is describe sessions the caller cannot see.
 * A name owned only by archived sessions is therefore absent by default and returns
 * with `includeArchived`, which is also the scope in which filtering on it works.
 */
export function listAgents(store, { includeArchived = false } = {}) {
  // No database is reported everywhere else — `sqliteAvailable: false` on the meta and
  // panel surfaces — so warning here as well would repeat it on every read. A *missing
  // column* is different: the store opened, the sessions table is there, and this one
  // list is the only thing that failed. It returns the same empty array a machine with
  // no sub-agent presets returns, so it has to say so.
  if (!store.db) return [];
  if (!store.has('sessions', 'agent_name')) {
    store.warn('agent_list_failed:this runtime\'s sessions table has no agent_name column, so an empty list means "not counted"');
    return [];
  }
  // Reads its own filter rather than repeating it, including the `store.has` gates: a
  // runtime whose table lacks `visibility` must be counted the same way here as it is
  // in every `total`.
  const { where: population, params } = sessionFilter(store, { includeArchived });
  try {
    return store.db.prepare(`
      SELECT agent_name AS name, COUNT(*) AS count
      FROM local_runtime_sessions
      WHERE agent_name IS NOT NULL AND agent_name <> '' AND ${population}
      GROUP BY agent_name
      ORDER BY count DESC, name ASC
    `).all(...params).map((row) => ({ name: row.name, count: num(row.count) ?? 0 }));
  } catch {
    // An empty agent list is the shape of "this machine has no sub-agent presets",
    // which is what the sidebar filter builds itself from. A failed query produces the
    // same empty list and the same conclusion, so it has to be recorded.
    store.warn('agent_list_failed:the agent names could not be listed, so an empty list means "not counted"');
    return [];
  }
}

/**
 * Annotate sessions with the repository they actually belong to, so every worktree
 * of one project groups together instead of fragmenting by path.
 */
export async function annotateWorkspaces(store, sessions) {
  const resolve = await resolveWorkspaceIdentities(sessions.map((session) => session.workspaceDir));
  return sessions.map((session) => {
    const identity = resolve(session.workspaceDir);
    return {
      ...session,
      groupKey: identity.key,
      groupLabel: identity.label,
      groupKind: identity.kind,
      branch: identity.branch,
      worktree: identity.worktree,
    };
  });
}

/**
 * The agent definition the runtime recorded for a session: model selection, tool
 * and skill allowlists, and the system prompt. Present only for sessions the
 * runtime dispatched with an explicit definition (presets, sub-agents).
 */
export function getAgentDefinition(store, sessionId) {
  if (!store.db || !tableExists(store.db, 'local_runtime_session_agent_definitions')) return null;
  let row;
  try {
    row = store.db.prepare(
      'SELECT definition_json FROM local_runtime_session_agent_definitions WHERE session_id = ?',
    ).get(sessionId);
  } catch {
    return null;
  }
  const definition = parseJson(row?.definition_json);
  if (!definition) return null;

  const capabilities = definition.capabilities && typeof definition.capabilities === 'object'
    ? definition.capabilities
    : {};
  const model = definition.model && typeof definition.model === 'object' ? definition.model : {};
  return {
    definitionVersion: num(definition.definitionVersion),
    ownerName: definition.exactOwnerName ?? null,
    model: {
      providerId: model.providerId ?? null,
      modelId: model.modelId ?? null,
      variant: model.variant ?? null,
      contextWindow: num(model.contextWindow),
      maxOutputTokens: num(model.maxOutputTokens),
      parameterSnapshot: model.parameterSnapshot ?? null,
    },
    tools: Array.isArray(capabilities.tools) ? capabilities.tools : [],
    disallowedTools: Array.isArray(capabilities.disallowedTools) ? capabilities.disallowedTools : [],
    mcpServers: Array.isArray(capabilities.mcpServers) ? capabilities.mcpServers : [],
    skills: Array.isArray(capabilities.skills) ? capabilities.skills : [],
    extensionSkills: Array.isArray(capabilities.extensionSkills) ? capabilities.extensionSkills : [],
    systemPrompt: typeof definition.systemPrompt === 'string' ? definition.systemPrompt : null,
    project: definition.project && typeof definition.project === 'object' ? definition.project : null,
  };
}


