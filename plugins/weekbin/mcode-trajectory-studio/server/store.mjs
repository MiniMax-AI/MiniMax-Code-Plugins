/**
 * Data layer facade.
 *
 * The `Store` class owns the connection, the probed column sets, the warning log
 * and the two LRU caches, then delegates every read to a focused domain module:
 *
 *   config / json / sqlite / fsutil   — foundations (bounds, values, driver, fs)
 *   redact / git                      — supporting services
 *   sessions / stats / tasks / events / search / jsonl / changes — domain reads
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

import { num } from './json.mjs';
import { tableColumns, tableExists, ftsModuleAvailable, openReadOnlyProjection, resolveSqliteFile } from './sqlite.mjs';
import { resolveDataDir, CACHE_ENTRIES, WARNINGS_MAX } from './config.mjs';
import { resolveSessionsRoot } from './fsutil.mjs';
import * as sessions from './sessions.mjs';
import * as stats from './stats.mjs';
import * as tasks from './tasks.mjs';
import * as events from './events.mjs';
import * as search from './search.mjs';
import * as jsonl from './jsonl.mjs';
import * as changes from './changes.mjs';
import * as ingress from './ingress.mjs';

export class Store {
  constructor({ dataDir, db = null, warnings = [] }) {
    this.dataDir = dataDir;
    this.db = db;
    this.warnings = warnings;
    this.warningsDropped = 0;
    this.columns = {
      sessions: db ? tableColumns(db, 'local_runtime_sessions') : new Set(),
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
    // The table existing is not the same as it indexing the fields a match names.
    // A build with a differently-shaped table would otherwise answer every search
    // with `failed: true` from a query-time "no such column", which reads as a
    // broken index rather than a different schema — so the shape is probed once
    // here, next to the FTS5 probe it belongs with.
    this.searchable = search.hasSearchableColumns(this);
    if (this.hasFts && !this.searchable) {
      this.warn('search_columns_missing:trajectory_search needs fields this runtime does not index');
    }
    // Same kind of fact, same place. A projection with no background-task table cannot
    // answer "did this session dispatch anything", and an unanswered question is not the
    // answer "no" — the task reads returned `[]` and a count of `0`, which is the shape
    // of a session that genuinely dispatched nothing. Warned once here rather than in
    // the two guards that hit it, so the ring does not fill with the same line.
    this.hasTasks = Boolean(db) && tableExists(db, 'local_runtime_background_tasks');
    if (db && !this.hasTasks) {
      this.warn('task_table_missing:this runtime\'s projection has no background-task table, so an empty task list and total=0 mean "not counted"');
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

  /**
   * A cheap signature of the rows a per-session fold reads.
   *
   * The four per-session folds — statistics, turn summaries, timeline, task index —
   * are cached, and they were all keyed on the session row's `updated_at_ms`. That
   * column does not move when a *message* row is inserted or a *task* row changes
   * state, which is every write the runtime actually makes while a session is live:
   * the rows being indexed are exactly the rows the folds read, and they are written
   * by a different process. So a session that gained a record kept serving the
   * statistics, the turn summaries, the timeline and the task index it had before —
   * `invalidateSession` existed to break exactly that and was never called from
   * anywhere, which is the kind of thing that reads as protection and is not.
   *
   * The signature is derived from the folded tables instead. It is a count and a
   * high-water mark, which is one cheap aggregate: an insert moves the count, a
   * delete moves the count, and a background task moving from running to completed
   * moves `updated_at_ms`. None of them needs the payload parsed, which is the part
   * the fold spends its time on.
   *
   * The one write this cannot see is an in-place update of an existing message row at
   * an unchanged id. The projection is append-only — a message row is written once,
   * when the runtime emits the message — and that assumption is now written down here
   * instead of being an unstated hope behind a cache.
   */
  messageSignature(sessionId) {
    if (!this.db) return 'none';
    try {
      const row = this.db.prepare(
        'SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS top FROM local_runtime_message_rows WHERE session_id = ?',
      ).get(sessionId);
      return `${num(row?.n) ?? 0}:${num(row?.top) ?? 0}`;
    } catch {
      return 'error';
    }
  }

  /**
   * The same shape as `messageSignature`, over change sets rather than message rows.
   *
   * `getStats` reports `changedTurns`, so its cache key has to move when a change set
   * lands — and it does not, because a change set is written *after* the message rows of
   * the turn it belongs to. Measured: on a machine with 351 sessions carrying change
   * records, **320 of them (91%) have their last change set written after that session's
   * last message row**, with a median lag of 422 ms and a worst case of 135 seconds. The
   * window is not a rare interleaving, it is the normal shape of a run finishing — and it
   * is precisely when someone asks what the session just did.
   *
   * With only the message signature in the key, a summary computed during that window
   * kept saying `changedTurns: 0` for as long as the process lived. A count read
   * through a cache has to carry everything the cache is allowed to forget about.
   */
  changeSignature(sessionId) {
    if (!this.db) return 'none';
    try {
      const row = this.db.prepare(
        'SELECT COUNT(*) AS n, COALESCE(MAX(captured_at_ms), 0) AS top FROM local_runtime_turn_diffs WHERE session_id = ?',
      ).get(sessionId);
      return `${num(row?.n) ?? 0}:${num(row?.top) ?? 0}`;
    } catch {
      // A runtime without the table, or a query that threw. Either way it is a different
      // key from the last one that succeeded, so the cached `available: false` cannot be
      // served forever by a key that looks unchanged.
      return 'error';
    }
  }

  /**
   * How many message rows the projection holds for one session, or `null` if it could
   * not be counted.
   *
   * Separate from `messageSignature` because the two answer different questions. The
   * signature is a cache key — it only has to *change* when the rows change, so it
   * folds the count together with a high-water mark. This one is read as a count in its
   * own right, by the surfaces that have to tell "this session has no records" from
   * "I could not look": `null` is the third answer, and a caller that folded a failed
   * count into `0` would report a session's records as unreadable when the truth is
   * that the Plugin never established how many there are.
   */
  messageRowCount(sessionId) {
    if (!this.db) return null;
    try {
      const row = this.db.prepare(
        'SELECT COUNT(*) AS n FROM local_runtime_message_rows WHERE session_id = ?',
      ).get(sessionId);
      return num(row?.n) ?? 0;
    } catch {
      return null;
    }
  }

  /** As `messageSignature`, over the task table the task index folds. */
  taskSignature(sessionId) {
    if (!this.db) return 'none';
    try {
      const row = this.db.prepare(
        'SELECT COUNT(*) AS n, COALESCE(MAX(updated_at_ms), 0) AS top FROM local_runtime_background_tasks WHERE owner_session_id = ?',
      ).get(sessionId);
      return `${num(row?.n) ?? 0}:${num(row?.top) ?? 0}`;
    } catch {
      return 'error';
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

  countSessions(options) { return sessions.countSessions(this, options); }

  getSession(sessionId) { return sessions.getSession(this, sessionId); }

  listAgents(options) { return sessions.listAgents(this, options); }

  annotateWorkspaces(list) { return sessions.annotateWorkspaces(this, list); }

  getAgentDefinition(sessionId) { return sessions.getAgentDefinition(this, sessionId); }

  /* --------------------------------------------------------------- stats -- */

  getStats(sessionId) { return stats.getStats(this, sessionId); }

  listSessionAssets(sessionId, options) { return stats.listSessionAssets(this, sessionId, options); }

  /* ------------------------------------------------------------- changes -- */

  listTurnChanges(sessionId, options) { return changes.listTurnChanges(this, sessionId, options); }

  /**
   * A cache key part that moves when the session's intake records move.
   *
   * Separate from `messageSignature` for the same reason `changeSignature` is: a turn
   * that fails at intake writes no message row and does not touch the session row, so
   * neither of those moves when one dies. Measured on the machine this was written for,
   * **14 failed-or-aborted turns across 7 sessions appear in no message row at all** — so
   * a summary computed before such a failure kept reporting `turnsFailedOrAborted: 0`
   * for as long as the process lived, which is the clean bill of health that field
   * exists to withhold.
   *
   * Count plus the latest completion, so a turn that is accepted and then fails moves the
   * key as well as one that fails on acceptance.
   */
  ingressSignature(sessionId) {
    if (!this.db) return 'none';
    try {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS n, COALESCE(MAX(accepted_at_ms), 0) AS top,
                COALESCE(MAX(COALESCE(completed_at_ms, 0)), 0) AS done
         FROM local_runtime_turn_ingress WHERE session_id = ?`,
      ).get(sessionId);
      return `${num(row?.n) ?? 0}:${num(row?.top) ?? 0}:${num(row?.done) ?? 0}`;
    } catch {
      // A runtime without the table, or a query that threw. Either way it is a different
      // key from the last one that succeeded, so a cached `ingressAvailable: false`
      // cannot be served forever by a key that looks unchanged.
      return 'error';
    }
  }

  listIngressTurns(sessionId, options) { return ingress.listIngressTurns(this, sessionId, options); }

  /* --------------------------------------------------------------- tasks -- */

  listBackgroundTasks(sessionId, options) { return tasks.listBackgroundTasks(this, sessionId, options); }
  countBackgroundTasks(sessionId, options) { return tasks.countBackgroundTasks(this, sessionId, options); }

  readTaskOutput(taskId, options) { return tasks.readTaskOutput(this, taskId, options); }

  /* -------------------------------------------------------------- events -- */

  getEvents(options) { return events.getEvents(this, options); }

  findEvents(options) { return events.findEvents(this, options); }

  getTurnSummaries(sessionId) { return events.getTurnSummaries(this, sessionId); }

  getTimeline(sessionId, options) { return events.getTimeline(this, sessionId, options); }

  /* -------------------------------------------------------------- search -- */

  searchSessions(options) { return search.searchSessions(this, options); }

  /* ------------------------------------------------------ jsonl fallback -- */

  findSessionDir(sessionId) { return jsonl.findSessionDir(this, sessionId); }

  readJsonlEvents(options) { return jsonl.readJsonlEvents(this, options); }
  findJsonlEvents(options) { return jsonl.findJsonlEvents(this, options); }
  readJsonlTurnSummaries(options) { return jsonl.readJsonlTurnSummaries(this, options); }
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
export { resolveDataDir, resolveHomeDir } from './config.mjs';
export { SESSION_KINDS } from './sessions.mjs';
export { encodeFtsQuery } from './search.mjs';
export { classifyInput } from './events.mjs';
