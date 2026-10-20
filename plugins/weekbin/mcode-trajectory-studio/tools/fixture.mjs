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
    parent_session_id TEXT, workspace_dir TEXT, title TEXT, created_at_ms INTEGER,
    error_message TEXT
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
    asset_key TEXT NOT NULL, source_tag TEXT NOT NULL, path TEXT NOT NULL, name TEXT,
    asset_type TEXT, artifact_id TEXT, drive_node_id TEXT, data_json TEXT NOT NULL,
    created_at_ms INTEGER, updated_at_ms INTEGER
  );
  CREATE TABLE local_runtime_session_agent_definitions (
    session_id TEXT PRIMARY KEY, definition_json TEXT NOT NULL
  );
  CREATE TABLE local_runtime_turn_diffs (
    change_set_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    assistant_message_id TEXT, workspace_dir TEXT NOT NULL, captured_at_ms INTEGER NOT NULL,
    status TEXT NOT NULL, file_changes_json TEXT NOT NULL, raw_diff TEXT, reverted_at_ms INTEGER,
    agent_name TEXT, undo_json TEXT NOT NULL DEFAULT '[]',
    undoable INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER,
    UNIQUE(session_id, turn_id)
  );
  CREATE TABLE local_runtime_thread_goals (
    goal_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, objective TEXT NOT NULL,
    status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
    tokens_used INTEGER, time_used_seconds INTEGER, token_budget INTEGER,
    kickoff_attachments_json TEXT NOT NULL DEFAULT '[]', kickoff_state TEXT,
    turns_used INTEGER, reply_fingerprint TEXT, no_progress_streak INTEGER,
    last_verification TEXT, status_reason TEXT, last_worker_proposal TEXT,
    execution_wait_reason TEXT, execution_wait_since_ms INTEGER, execution_wait_epoch INTEGER,
    objective_resources_json TEXT NOT NULL DEFAULT '[]', no_tool_streak INTEGER
  );
  CREATE TABLE local_runtime_turn_ingress (
    turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source TEXT NOT NULL,
    client_request_id TEXT, claim_id TEXT, claim_source TEXT,
    queue_item_ids_json TEXT NOT NULL DEFAULT '[]', input_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL, accepted_at_ms INTEGER NOT NULL, accepted_sequence INTEGER,
    completed_at_ms INTEGER, queue_acknowledged_at_ms INTEGER, input_digest TEXT,
    input_metadata_json TEXT NOT NULL DEFAULT '{}'
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

/**
 * Encode text the way the runtime's FTS index stores it: `c<hex codepoint>`.
 *
 * The lowercase is not cosmetic — it is what makes this a usable stand-in for the
 * real index. Verified against the live 633-session projection: `title =
 * "Spec review PR #520"` is stored as `c73 c70 c65 c63 c20 ...`, so the runtime
 * lowercases the source text before encoding, and the `unicode61` tokenizer does
 * no case folding of its own (`c`-prefixed hex tokens contain no uppercase
 * letter to fold). This helper used to keep the original case, so the fixture
 * index was case-sensitive in a way no real index is: every search test passed
 * against a shape the runtime never produces, and a lowercase-versus-mixed-case
 * bug was invisible here while silently zeroing real searches.
 */
export function encodeFtsTerms(text) {
  return [...String(text).toLowerCase()].map((ch) => `c${ch.codePointAt(0).toString(16)}`).join(' ');
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

  // `archived` and `visibility` are settable because the population a count describes is
  // the thing several read paths have to agree on: a fixture where every session is live
  // cannot tell a filter that respects them from one that ignores them, because the two
  // agree on every row.
  //
  // `errorMessage` is settable for the same class of reason, and its absence cost a
  // review round of its own: the column was not in this schema at all, so no fixture
  // could produce a session that *failed*, and the whole path — a run that stopped with
  // a reason on it — had no coverage anywhere. That is why `trajectory_summary` could
  // republish `status: 'error'` and drop the message that says what the error was, and
  // nothing noticed. The same lesson as the `agent` helper below.
  //
  // `error_code` exists on the real table and is deliberately *not* added: nothing in the
  // Plugin reads it, and a fixture column no code path can reach is the shape this file
  // exists to avoid.
  //
  // `purpose` is the other one, and it was settable-by-accident here for a long time: the
  // FTS row took `''` in this column's place, so **no fixture could ever produce a
  // searchable dispatch objective** — while the tool description promises exactly that, in
  // the strongest terms it has: a sub-agent's objective is indexed "so a word from it
  // matches a session whose title never mentions it". On the machine this was found on,
  // 439 of 633 sessions carry a purpose, so it is two thirds of the corpus and not an edge
  // case. The promise was tested only as a *constant* (`SEARCHABLE_COLUMNS` contains the
  // column name), which is the half that rots silently: the capability working and the
  // name being printed are separate facts, and only the second was ever checked.
  const session = ({ id, title, agent = 'mavis', updatedAtMs, parent = null, workspaceDir = FIXTURE_WORKSPACE, status = 'idle', archived = 0, visibility = 'visible', errorMessage = null, purpose = '' }) => {
    db.prepare(`
      INSERT INTO local_runtime_sessions
        (session_id, record_json, updated_at_ms, agent_name, status, session_kind, title,
         created_at_ms, parent_session_id, workspace_dir, archived, visibility, error_message)
      VALUES (?, '{}', ?, ?, ?, 'conversation', ?, ?, ?, ?, ?, ?, ?)
    `).run(id, updatedAtMs, agent, status, title, updatedAtMs - 1000, parent, workspaceDir, archived ? 1 : 0, visibility, errorMessage);
    if (hasFts) {
      db.prepare(`
        INSERT INTO local_runtime_sessions_fts
          (session_id, session_id_terms, agent_name_terms, title_terms, workspace_dir_terms,
           purpose_terms, status_terms, session_type_terms)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'conversation')
      `).run(id, encodeFtsTerms(id), encodeFtsTerms(agent), encodeFtsTerms(title),
        encodeFtsTerms(workspaceDir), encodeFtsTerms(purpose), encodeFtsTerms(status));
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

  /**
   * A delivered file, recorded the way the runtime records one.
   *
   * The same lesson as `agent` above, one table over: the assets table was in this
   * fixture's schema from the start and no row ever went into it, so the only
   * coverage of it was the count in `trajectory_summary` — which cannot see a null
   * `name`, a null `asset_type` or an un-folded path. Those are precisely the fields a
   * reader of the list depends on.
   *
   * `name` and `assetType` default to null rather than to a plausible value, because
   * `asset_type` is null for 571 of 746 rows on a real machine: a fixture that always
   * filled it would let a reader infer a contract the data does not honour.
   */
  const asset = ({
    sessionId, msgId = 'm1', role = 'assistant', createdAtMs = 1_700_000_000_000,
    assetIndex = 0, sourceTag = 'deliver-assets', path, name = null, assetType = null,
    artifactId = null, driveNodeId = null,
  }) => {
    db.prepare(`
      INSERT INTO local_runtime_session_assets
        (session_id, msg_id, role, message_created_at_ms, asset_index, asset_key,
         source_tag, path, name, asset_type, artifact_id, drive_node_id, data_json,
         created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
    `).run(sessionId, msgId, role, createdAtMs, assetIndex, path, sourceTag, path,
      name, assetType, artifactId, driveNodeId, createdAtMs, createdAtMs);
  };

  /**
   * The objective a session was kicked off with.
   *
   * Seeded only from the real table's own columns. On the machine this table was read
   * from, 15 rows across 15 sessions, one each — and its `objective` shared almost no
   * vocabulary with the session's `title` in 13 of 15, so a fixture that invented a
   * paraphrasing title would have reproduced the one shape that does not occur.
   */
  const goal = ({
    sessionId, objective, status = 'complete', createdAtMs = 1_700_000_000_000,
    updatedAtMs = createdAtMs + 1000, tokensUsed = 0, timeUsedSeconds = 0,
    goalId = `tg_${sessionId}`, kickoffState = 'consumed',
  }) => {
    db.prepare(`
      INSERT INTO local_runtime_thread_goals
        (goal_id, session_id, objective, status, created_at_ms, updated_at_ms,
         tokens_used, time_used_seconds, token_budget, kickoff_attachments_json,
         kickoff_state, turns_used, no_progress_streak, objective_resources_json, no_tool_streak)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?, 0, 0, '[]', 0)
    `).run(goalId, sessionId, objective, status, createdAtMs, updatedAtMs,
      tokensUsed, timeUsedSeconds, kickoffState);
  };

  /**
   * A turn the runtime accepted, and what became of it.
   *
   * Seeded with the columns the real rows carry. `status` is the field the whole tool
   * exists for: on the machine this was read from, 56 ingress turns are `failed` and 64
   * `aborted`, and **14 of those 120 appear in no message row at all** — the session
   * reads as a clean run with the deaths nowhere in it. A fixture that only seeded
   * `completed` would have reproduced the one shape that does not occur.
   */
  const ingress = ({
    sessionId, turnId, status = 'completed', source = 'turn', claimSource = null,
    acceptedAtMs = 1_700_000_000_000, completedAtMs = acceptedAtMs + 1000,
    queueAcknowledgedAtMs = acceptedAtMs, attachmentCount = 0,
  }) => {
    db.prepare(`
      INSERT INTO local_runtime_turn_ingress
        (turn_id, session_id, source, client_request_id, claim_id, claim_source,
         queue_item_ids_json, input_json, status, accepted_at_ms, accepted_sequence,
         completed_at_ms, queue_acknowledged_at_ms, input_digest, input_metadata_json)
      VALUES (?, ?, ?, NULL, ?, ?, '[]', '{}', ?, ?, 1, ?, ?, 'sha256:fixture',
              json_object('attachmentCount', ?, 'hasContent', 1))
    `).run(turnId, sessionId, source, `claim_${turnId}`, claimSource, status,
      acceptedAtMs, completedAtMs, queueAcknowledgedAtMs, attachmentCount);
  };

  const turnDiff = ({
    sessionId, turnId, workspaceDir, capturedAtMs = 1_700_000_000_000, status = 'active',
    files = [], undoable = 0, revertedAtMs = null, agentName = null, rawDiff = null,
  }) => {
    db.prepare(`
      INSERT INTO local_runtime_turn_diffs
        (change_set_id, session_id, turn_id, workspace_dir, captured_at_ms, status,
         file_changes_json, raw_diff, reverted_at_ms, agent_name, undo_json, undoable, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
    `).run(`${sessionId}:${turnId}`, sessionId, turnId, workspaceDir, capturedAtMs, status,
      JSON.stringify(files), rawDiff, revertedAtMs, agentName, undoable, capturedAtMs);
  };

  return {
    file,
    db,
    hasFts,
    session,
    row,
    task,
    agent,
    asset,
    goal,
    ingress,
    turnDiff,
    close: () => db.close(),
  };
}

/**
 * Run something against a projection file with the handle closed afterwards.
 *
 * Fixtures need a second connection to the same SQLite file — to drop a table a case
 * wants missing, or to insert the row the read under test depends on. Written as
 * `new DatabaseSync(p).exec(...)` it reads cleanly and leaves the handle **open**, which
 * POSIX tolerates: you may unlink a file that is still open. Windows does not, so every
 * such fixture fails there with `EBUSY` at teardown — an error that names a temporary
 * directory, points at no assertion, and cannot be reproduced on the machine that wrote
 * the fixture. 23 of the 40 Windows failures were this one line.
 *
 * Closing is not optional politeness here; it is the difference between a suite that
 * runs where it is developed and one that only runs where files can be unlinked at any
 * moment.
 *
 * @param {string} dbPath
 * @param {(db: import('node:sqlite').DatabaseSync) => unknown} fn
 * @returns {unknown} whatever `fn` returned
 */
export function withProjectionDb(dbPath, fn) {
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Drop a table from a projection, with the handle closed afterwards. */
export function dropProjectionTable(dbPath, table) {
  withProjectionDb(dbPath, (db) => db.exec(`DROP TABLE ${table}`));
}
