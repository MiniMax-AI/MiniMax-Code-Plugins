/**
 * Data layer facade.
 *
 * The `Store` class owns the connection, the probed column sets, the warning log
 * and the two LRU caches, then delegates every read to a focused domain module:
 *
 *   config / json / sqlite / fsutil   — foundations (bounds, values, driver, fs)
 *   redact / git                      — supporting services
 *   sessions / stats / tasks / events / search / jsonl — domain reads
 *   store (this file)                 — the facade consumers import
 *
 * Domain functions take the store as their first argument and read state through
 * it, so the layer graph stays a DAG with no sibling imports beyond the natural
 * events -> tasks join.
 *
 * Primary source: the local runtime SQLite projection at
 *   <dataDir>/v2/sqlite/runtime-state.sqlite
 * opened strictly read-only. Fallback source for sessions the projection has not
 * indexed: <dataDir>/v2/sessions/YYYY/MM/DD/<stamp>-<sessionId>/messages.jsonl
 */

import { tableColumns, tableExists, ftsModuleAvailable, openReadOnlyProjection, resolveSqliteFile } from './sqlite.mjs';
import { resolveDataDir, CACHE_ENTRIES, WARNINGS_MAX } from './config.mjs';
import { resolveSessionsRoot } from './fsutil.mjs';
import * as sessions from './sessions.mjs';
import * as stats from './stats.mjs';
import * as tasks from './tasks.mjs';
import * as events from './events.mjs';
import * as search from './search.mjs';
import * as jsonl from './jsonl.mjs';

export class Store {
  constructor({ dataDir, db = null, warnings = [] }) {
    this.dataDir = dataDir;
    this.db = db;
    this.warnings = warnings;
    this.warningsDropped = 0;
    this.columns = {
      sessions: db ? tableColumns(db, 'local_runtime_sessions') : new Set(),
      rows: db ? tableColumns(db, 'local_runtime_message_rows') : new Set(),
      tasks: db ? tableColumns(db, 'local_runtime_background_tasks') : new Set(),
      assets: db ? tableColumns(db, 'local_runtime_session_assets') : new Set(),
    };
    // FTS5 is a compile-time module of the SQLite the runtime bundles, not a
    // property of the Node version: it is present from 22.19.0 and 24.0.0 but
    // absent in 22.13.0–22.18.x and throughout 23.x. The virtual table exists in
    // `sqlite_master` either way, so probing the table alone would claim search
    // works and then fail on the first MATCH.
    this.hasFts = Boolean(db) && tableExists(db, 'local_runtime_sessions_fts') && ftsModuleAvailable(db);
    if (db && !this.hasFts) {
      this.warn('fts5_unavailable:trajectory_search will return no matches on this Node runtime');
    }
    // Resolved once, because the session-artifact root is a different relative path
    // on some builds and every JSONL fallback read needs the one that really exists.
    const sessionsRoot = resolveSessionsRoot(dataDir);
    this.sessionsRoot = sessionsRoot.dir;
    if (sessionsRoot.discovered) this.warn(`sessions_root_discovered:${sessionsRoot.dir}`);
    // Filled by openStore; kept here so a directly constructed Store still has it.
    this.sqliteFile = null;
    // A finished session never changes, so its folded totals are cached against the
    // session's own updated_at_ms. Revisiting a session — by far the common case when
    // browsing — then costs nothing, and the first visit is the only one that scans.
    this.statsCache = new Map();
    this.turnsCache = new Map();
    // The timeline and the task index are per-session folds of data that only changes
    // when the session does, and both were recomputed on every single request: the
    // timeline is 7 `json_extract`s over up to 6,000 rows (78 ms measured), and the
    // task index is a full scan of the task table with no index on `owner_session_id`
    // (12.7 ms at 5k tasks), paid on every page of every event read.
    this.timelineCache = new Map();
    this.tasksCache = new Map();
  }

  /**
   * Record a diagnostic, keeping the list bounded.
   *
   * One warning is appended per failed read, and an MCP server lives for a whole
   * session, so an unbounded list is a slow leak that is then echoed in full on
   * every `trajectory_list`. Dropping the oldest is reported through
   * `warningsDropped` rather than passing silently.
   */
  warn(message) {
    this.warnings.push(message);
    const overflow = this.warnings.length - WARNINGS_MAX;
    if (overflow > 0) {
      this.warnings.splice(0, overflow);
      this.warningsDropped += overflow;
    }
  }

  /** LRU: refresh recency on a hit, evict the oldest entry on an insert. */
  cached(map, key, compute) {
    if (map.has(key)) {
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    }
    const value = compute();
    map.set(key, value);
    if (map.size > CACHE_ENTRIES) map.delete(map.keys().next().value);
    return value;
  }

  invalidateSession(sessionId) {
    for (const key of [...this.statsCache.keys()]) {
      if (key.startsWith(`${sessionId}|`)) this.statsCache.delete(key);
    }
    for (const map of [this.turnsCache, this.timelineCache, this.tasksCache]) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(`${sessionId}|`)) map.delete(key);
      }
    }
  }

  close() {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
  }

  has(scope, column) {
    return this.columns[scope].has(column);
  }

  /* ------------------------------------------------------------ sessions -- */

  listSessions(options) { return sessions.listSessions(this, options); }

  getSession(sessionId) { return sessions.getSession(this, sessionId); }

  listAgents() { return sessions.listAgents(this); }

  annotateWorkspaces(list) { return sessions.annotateWorkspaces(this, list); }

  getAgentDefinition(sessionId) { return sessions.getAgentDefinition(this, sessionId); }

  listChildSessions(parentSessionId, options) { return sessions.listChildSessions(this, parentSessionId, options); }

  /* --------------------------------------------------------------- stats -- */

  getStats(sessionId) { return stats.getStats(this, sessionId); }

  /* --------------------------------------------------------------- tasks -- */

  listBackgroundTasks(sessionId, options) { return tasks.listBackgroundTasks(this, sessionId, options); }
  countBackgroundTasks(sessionId, options) { return tasks.countBackgroundTasks(this, sessionId, options); }

  readTaskOutput(taskId, options) { return tasks.readTaskOutput(this, taskId, options); }

  /* -------------------------------------------------------------- events -- */

  getEvents(options) { return events.getEvents(this, options); }

  getTurnSummaries(sessionId) { return events.getTurnSummaries(this, sessionId); }

  getTimeline(sessionId, options) { return events.getTimeline(this, sessionId, options); }

  /* -------------------------------------------------------------- search -- */

  searchSessions(options) { return search.searchSessions(this, options); }

  /* ------------------------------------------------------ jsonl fallback -- */

  findSessionDir(sessionId) { return jsonl.findSessionDir(this, sessionId); }

  readJsonlEvents(options) { return jsonl.readJsonlEvents(this, options); }
}

/**
 * Open the SQLite projection read-only. Failure is not fatal: the Store degrades
 * to the JSONL fallback so a schema change in a future runtime cannot break the
 * Plugin outright.
 */
export function openStore({ dataDir, warnings = [] } = {}) {
  const dir = dataDir || resolveDataDir();
  const projection = resolveSqliteFile(dir);
  const { db, error } = openReadOnlyProjection(projection.file);
  const store = new Store({ dataDir: dir, db, warnings });
  if (error) store.warn(`sqlite_unavailable:${error}`);
  else if (projection.discovered) store.warn(`sqlite_discovered:${projection.file}`);
  store.sqliteFile = projection.file;
  return store;
}

// Re-exported so consumers can import the whole data surface from one module.
export { resolveDataDir, resolveHomeDir, sqlitePath, sessionsRoot } from './config.mjs';
export { SESSION_KINDS } from './sessions.mjs';
export { encodeFtsQuery } from './search.mjs';
export { classifyInput } from './events.mjs';
