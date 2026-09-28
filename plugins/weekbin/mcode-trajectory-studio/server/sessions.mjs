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
import { LIMITS, clamp } from './config.mjs';

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

/** Recent sessions, newest first, with optional agent/kind/time filters. */
export function listSessions(store, { limit = LIMITS.sessions.default, agent, kind, sinceMs, includeArchived = false } = {}) {
  if (!store.db) return [];
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
  if (Number.isFinite(sinceMs)) {
    where.push('updated_at_ms >= ?');
    params.push(sinceMs);
  }
  const order = store.has('sessions', 'updated_at_ms') ? 'updated_at_ms DESC' : 'rowid DESC';
  const sql = `SELECT * FROM local_runtime_sessions WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`;
  params.push(clamp(limit, LIMITS.sessions));
  let rows = [];
  try {
    rows = store.db.prepare(sql).all(...params);
  } catch (error) {
    store.warn(`session_list_failed:${error.message}`);
    return [];
  }
  return rows.map(sessionSummary);
}

/** Read one session row plus its direct child sessions (sub-agents / tasks). */
export function getSession(store, sessionId) {
  if (!store.db) return null;
  let row;
  try {
    row = store.db.prepare('SELECT * FROM local_runtime_sessions WHERE session_id = ?').get(sessionId);
  } catch {
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
    } catch {
      children = [];
    }
  }
  return { ...summary, children, ...(childrenCapped ? { childrenCapped: true } : {}) };
}

/**
 * Agent names actually present in this install, with session counts.
 *
 * Sub-agent presets are per-machine, so the sidebar filter is built from the data
 * rather than from a fixed list of names.
 */
export function listAgents(store) {
  if (!store.db || !store.has('sessions', 'agent_name')) return [];
  try {
    return store.db.prepare(`
      SELECT agent_name AS name, COUNT(*) AS count
      FROM local_runtime_sessions
      WHERE agent_name IS NOT NULL AND agent_name <> ''
      GROUP BY agent_name
      ORDER BY count DESC, name ASC
    `).all().map((row) => ({ name: row.name, count: num(row.count) ?? 0 }));
  } catch {
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

/** Child sessions of a parent, for sub-agent drill-down. */
export function listChildSessions(store, parentSessionId, { limit = 100 } = {}) {
  if (!store.db || !store.has('sessions', 'parent_session_id')) return [];
  try {
    return store.db.prepare(`
      SELECT * FROM local_runtime_sessions
      WHERE parent_session_id = ?
      ORDER BY created_at_ms DESC
      LIMIT ?
    `).all(parentSessionId, clamp(limit, LIMITS.sessions)).map(sessionSummary);
  } catch {
    return [];
  }
}
