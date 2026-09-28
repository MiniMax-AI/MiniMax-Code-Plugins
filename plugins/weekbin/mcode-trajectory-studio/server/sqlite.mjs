/**
 * The SQLite projection driver.
 *
 * Opening the runtime database read-only, and probing which optional tables and
 * columns this particular runtime build actually has. Every table and column here
 * is an internal implementation detail, so nothing is assumed: each probe degrades
 * to "absent" rather than throwing.
 *
 * `node:sqlite` is loaded lazily through `createRequire` rather than a static
 * import. A static import of a module that does not exist is evaluated before any
 * of this file's code runs, so on a Node older than the floor the process would die
 * inside the module loader with `ERR_UNKNOWN_BUILTIN_MODULE` and no way to say
 * anything useful. Loading it here turns that into the Plugin's own error path —
 * and lets `main.mjs` print the real reason first.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

import { sqliteCandidates } from './config.mjs';

const require = createRequire(import.meta.url);

let cached = null;

/** The built-in SQLite driver, or null when this runtime does not have it. */
function loadDriver() {
  if (cached) return cached;
  try {
    cached = require('node:sqlite').DatabaseSync;
  } catch {
    cached = null;
  }
  return cached;
}

/** Whether this runtime can read the projection at all. */
export function sqliteDriverAvailable() {
  return typeof loadDriver() === 'function';
}

/**
 * Find the runtime projection on this machine.
 *
 * The canonical location is tried first. A hit on any other candidate means this
 * build lays its data out differently, which the caller surfaces as a warning
 * rather than letting it pass silently — a quiet fallback is how a stale or wrong
 * database would go unnoticed.
 *
 * @returns {{file: string, discovered: boolean, found: boolean}}
 */
export function resolveSqliteFile(dataDir) {
  const candidates = sqliteCandidates(dataDir);
  for (const [index, file] of candidates.entries()) {
    if (existsSync(file)) return { file, discovered: index > 0, found: true };
  }
  return { file: candidates[0], discovered: false, found: false };
}

/** Columns present on a table, or an empty set when the table is absent. */
export function tableColumns(db, table) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

/** Whether a table or view exists, without throwing on a locked or odd schema. */
export function tableExists(db, table) {
  try {
    return Boolean(db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
    ).get(table));
  } catch {
    return false;
  }
}

/**
 * Whether the SQLite this runtime bundles was compiled with FTS5.
 *
 * A virtual table exists in `sqlite_master` whether or not the module behind it is
 * present, so `tableExists` is not enough: the failure only shows up on the first
 * `MATCH`, as `no such module: fts5`. Measured across releases, the bundled SQLite
 * has FTS5 from Node 22.19.0 and 24.0.0 but not in 22.13.0–22.18.x or any 23.x, so
 * this has to be probed rather than inferred from the version.
 */
export function ftsModuleAvailable(db) {
  if (!db) return false;
  try {
    const rows = db.prepare('PRAGMA compile_options').all();
    return rows.some((row) => Object.values(row).some((value) => /FTS5/u.test(String(value))));
  } catch {
    return false;
  }
}

/**
 * Open the projection strictly read-only and confirm the one table the Plugin
 * cannot work without.
 *
 * Failure is not fatal: a missing table, an unreadable file, a data directory that
 * cannot host WAL's shared-memory file, or a runtime without `node:sqlite` all
 * return null with a reason, so the caller degrades to the JSONL fallback instead
 * of crashing.
 *
 * @returns {{db: object|null, error: string|null}}
 */
export function openReadOnlyProjection(file) {
  const DatabaseSync = loadDriver();
  if (!DatabaseSync) {
    return { db: null, error: 'node:sqlite is unavailable on this Node runtime' };
  }
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.prepare('SELECT 1 AS ok FROM local_runtime_sessions LIMIT 1').get();
    return { db, error: null };
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    return { db: null, error: error instanceof Error ? error.message : String(error) };
  }
}
