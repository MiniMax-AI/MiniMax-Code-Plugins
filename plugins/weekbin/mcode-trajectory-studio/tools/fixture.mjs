/**
 * A runtime-shaped SQLite projection, for tests and for the E2E harness.
 *
 * Three consumers need the same fixture: the domain tests, the protocol test that
 * spawns the real MCP server, and `tools/panel-e2e.mjs`. Building it in one place
 * means a schema detail the runtime adds later is fixed once instead of silently
 * diverging between them.
 *
 * The table shapes mirror `<dataDir>/v2/sqlite/runtime-state.sqlite` as the Plugin
 * reads it — only the columns the Plugin actually selects, since the Store probes
 * for every optional column and degrades to `null` when one is absent.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ftsModuleAvailable } from '../server/sqlite.mjs';

// A synthetic home and workspace. Written this way so no shipped string looks like
// a real machine's path, which the package audit enforces.
export const FIXTURE_HOME = '/tmp/trajectory-fixture-home';
export const FIXTURE_WORKSPACE = `${FIXTURE_HOME}/ws`;

const SCHEMA = `
  CREATE TABLE local_runtime_sessions (
    session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
    agent_name TEXT, session_type TEXT, status TEXT, archived INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'visible', session_kind TEXT NOT NULL DEFAULT 'unknown',
    parent_session_id TEXT, workspace_dir TEXT, title TEXT, created_at_ms INTEGER
  );
  CREATE TABLE local_runtime_message_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, msg_id TEXT NOT NULL,
    role TEXT, turn_id TEXT, created_at_ms INTEGER NOT NULL, data_json TEXT NOT NULL,
    source TEXT, source_context_json TEXT, UNIQUE(session_id, msg_id)
  );
  CREATE TABLE local_runtime_background_tasks (
    task_id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER, record_json TEXT NOT NULL
  );
  CREATE TABLE local_runtime_session_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, msg_id TEXT NOT NULL,
    role TEXT, message_created_at_ms INTEGER NOT NULL, asset_index INTEGER NOT NULL,
    asset_key TEXT NOT NULL, source_tag TEXT NOT NULL, path TEXT NOT NULL, data_json TEXT NOT NULL
  );
  CREATE TABLE local_runtime_session_agent_definitions (
    session_id TEXT PRIMARY KEY, definition_json TEXT NOT NULL
  );
`;

/**
 * Whether the SQLite this runtime bundles has FTS5.
 *
 * Not a property of the Node version: measured, it is present from 22.19.0 and
 * 24.0.0 but absent in 22.13.0–22.18.x and throughout 23.x. Fixtures therefore ask
 * rather than assume, and a runtime without it builds a projection minus the index.
 */
export function fixtureHasFts5() {
  const probe = new DatabaseSync(':memory:');
  try {
    return ftsModuleAvailable(probe);
  } finally {
    probe.close();
  }
}

/** Encode text the way the runtime's FTS index stores it: `c<hex codepoint>`. */
export function encodeFtsTerms(text) {
  return [...String(text)].map((ch) => `c${ch.codePointAt(0).toString(16)}`).join(' ');
}

/**
 * Create `<dataDir>/v2/sqlite/runtime-state.sqlite` with empty tables.
 *
 * @returns {Promise<{file: string, db: object, hasFts: boolean, session: Function,
 *   row: Function, task: Function, fts: Function, close: Function}>}
 */
export async function createFixtureProjection(dataDir) {
  await mkdir(path.join(dataDir, 'v2', 'sqlite'), { recursive: true });
  await mkdir(path.join(dataDir, 'background-tasks'), { recursive: true });
  const file = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const db = new DatabaseSync(file);
  const hasFts = fixtureHasFts5();
  db.exec(SCHEMA);
  if (hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE local_runtime_sessions_fts USING fts5(
        session_id UNINDEXED, session_id_terms, agent_name_terms, title_terms,
        workspace_dir_terms, purpose_terms, status_terms, session_type_terms,
        tokenize = 'unicode61'
      );
    `);
  }

  const session = ({ id, title, agent = 'mavis', updatedAtMs, parent = null, workspaceDir = FIXTURE_WORKSPACE, status = 'idle' }) => {
    db.prepare(`
      INSERT INTO local_runtime_sessions
        (session_id, record_json, updated_at_ms, agent_name, status, session_kind, title,
         created_at_ms, parent_session_id, workspace_dir)
      VALUES (?, '{}', ?, ?, ?, 'conversation', ?, ?, ?, ?)
    `).run(id, updatedAtMs, agent, status, title, updatedAtMs - 1000, parent, workspaceDir);
    if (hasFts) {
      db.prepare(`
        INSERT INTO local_runtime_sessions_fts
          (session_id, session_id_terms, agent_name_terms, title_terms, workspace_dir_terms,
           purpose_terms, status_terms, session_type_terms)
        VALUES (?, ?, ?, ?, ?, '', ?, 'conversation')
      `).run(id, encodeFtsTerms(id), encodeFtsTerms(agent), encodeFtsTerms(title), encodeFtsTerms(workspaceDir), status);
    }
  };

  const row = ({ sessionId, msgId, role, turnId, createdAtMs, data, source = null }) => {
    db.prepare(`
      INSERT INTO local_runtime_message_rows
        (session_id, msg_id, role, turn_id, created_at_ms, data_json, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, msgId, role, turnId, createdAtMs, JSON.stringify(data), data.source ?? source);
  };

  const task = ({ taskId, sessionId, kind = 'bash', status = 'completed', createdAtMs, endedAtMs, record }) => {
    db.prepare(`
      INSERT INTO local_runtime_background_tasks
        (task_id, owner_session_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, sessionId, kind, status, createdAtMs, endedAtMs, endedAtMs, JSON.stringify(record));
  };

  /**
   * An agent definition for a session.
   *
   * This helper exists because its absence cost two review rounds. The table has been
   * in this fixture's schema since it was written, but nothing ever put a row in it,
   * so every consumer — the domain tests, the protocol test that spawns the real MCP
   * server, and the panel harness — ran with `getAgentDefinition() === null`. The
   * `/api/overview` defect that a populated definition triggers was unreachable from
   * all three, and a stub store is the only thing that can express that shape at all.
   *
   * `systemPrompt` defaults to a non-empty string, because an empty one takes the
   * same branch-skipping path as a null definition: a fixture that cannot reach the
   * code it exists to cover is not a fixture.
   */
  const agent = ({ sessionId, ownerName = 'mavis', systemPrompt = 'You are a fixture agent.', tools = ['read', 'bash'] } = {}) => {
    db.prepare(`
      INSERT INTO local_runtime_session_agent_definitions (session_id, definition_json)
      VALUES (?, ?)
    `).run(sessionId, JSON.stringify({
      definitionVersion: 2,
      exactOwnerName: ownerName,
      model: { providerId: 'minimax', modelId: 'MiniMax-M3', variant: 'thinking', contextWindow: 512000, maxOutputTokens: 128000 },
      project: { workspaceDir: FIXTURE_WORKSPACE },
      systemPrompt,
      capabilities: { tools, disallowedTools: [], mcpServers: [], skills: [], extensionSkills: [] },
    }));
  };

  return {
    file,
    db,
    hasFts,
    session,
    row,
    task,
    agent,
    close: () => db.close(),
  };
}
