// webui/server/lib/db.js
// SQLite helpers — lazy require mcode's better-sqlite3 (so we don't break if missing).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { MCODE_CMD } from "./config.js";
// B01: append-only audit for mcode-side session deletes. The audit
// fires AFTER the SQL transaction succeeds (so a rolled-back delete
// has no event). dryRun previews are also audited (with dryRun:true)
// so an operator can answer "who ran this preview yesterday?" from
// the event stream alone. Static import (top of file) is fine here:
// events.js has no dep on db.js, so no cycle exists. The lazy
// resolver pattern below is defensive against future refactors.
import { append as _eventsAppend } from "./events.js";

const _webuiRequire = createRequire(import.meta.url);

// v0.5.bx-19: 用 mcode 自带的 better-sqlite3 直接操作 mcode session db
//   mcode 0.1.4 acp `session/delete` 返回 "Method not found" (协议层注册但没实现)
//   真删 mcode session 只能 SQL 删 local_runtime_sessions 等关联表
//   lazy init — 只在第一次调用时 require
// v1.0.1 round 4: try multiple candidate paths so we work in non-canonical
//   install layouts (registry install, npm-global mcode, etc.). The hard-coded
//   `__dirname/../../../node_modules/...` path only works in the dev layout
//   where webui lives at `<mcode-root>/webui/`.
// C01 (round 7): resolver hardening — 4-tier probe with explicit failure log.
//   (1) Adds `~/.mcode-webui/db-resolver.json` user-pinned candidate list
//       between MCODE_CMD-derived and built-in tiers, so power users can
//       point at a known-good path without per-session env vars.
//   (2) Adds `_probeCandidate(path) → {path, exists, error}` that NEVER
//       throws, so all-failed case can list every attempt's outcome
//       (missing path vs NODE_MODULE_VERSION mismatch vs other require
//       error). Operator sees the difference in the warning log without
//       having to re-run with strace.
let _McodeBetterSqlite3 = null;
let _McodeBetterSqlite3Failed = false;
// C01: remember the per-candidate failure log so we can emit a single
// consolidated warning listing every attempt instead of one terse line.
let _McodeBetterSqlite3Failures = null;

// Probe a single better-sqlite3 candidate. NEVER throws.
// Returns {path, exists, error}:
//   path   — resolved filesystem path attempted
//   exists — existsSync(path) result (true/false)
//   error  — null on success; otherwise:
//            * "path not found" — path doesn't exist
//            * require() error message — path exists but the module can't
//              be loaded (e.g. NODE_MODULE_VERSION mismatch, missing
//              native binding, ABI drift).
// Side-effect on success: caches the require result so the caller's
// follow-up `_webuiRequire(path)` is a cached no-op.
function _probeCandidate(path) {
    let exists = false;
    try {
        exists = existsSync(path);
    } catch {
        exists = false;
    }
    if (!exists) return { path, exists: false, error: "path not found" };
    try {
        _webuiRequire(path);
        return { path, exists: true, error: null };
    } catch (e) {
        return {
            path,
            exists: true,
            error: e && e.message ? e.message : String(e),
        };
    }
}

// C01: read `~/.mcode-webui/db-resolver.json` for user-pinned candidate
// paths. Schema (all fields optional):
//   { "better_sqlite3_candidates": [ "/abs/path/to/better-sqlite3", ... ] }
// Returns string[] of pinned paths. Silently returns [] on:
//   - missing file (default case — user hasn't pinned anything)
//   - bad JSON / non-array field
//   - non-string entries (filtered out)
// Tests inject a temp file via `MCODE_WEBUI_RESOLVER_JSON` env override
// so we don't pollute the real `~/.mcode-webui/` during unit tests.
export function _loadUserResolverConfig({ home = homedir() } = {}) {
    const envOverride = process.env.MCODE_WEBUI_RESOLVER_JSON;
    const candidatesPath =
        envOverride || join(home, ".mcode-webui", "db-resolver.json");
    if (!existsSync(candidatesPath)) return [];
    try {
        const raw = readFileSync(candidatesPath, "utf8");
        const cfg = JSON.parse(raw);
        if (!cfg || !Array.isArray(cfg.better_sqlite3_candidates)) return [];
        return cfg.better_sqlite3_candidates.filter(
            (p) => typeof p === "string" && p.length > 0,
        );
    } catch {
        // malformed JSON or unreadable — fail open (no candidates)
        return [];
    }
}

// Resolution priority for better-sqlite3 (4 tiers, reliability descending):
//   1. $MCODE_BETTER_SQLITE3 (explicit env override — highest)
//   2. <MCODE_CMD>/...node_modules/... (mcode binary → bundled deps,
//      emits BOTH npm-style `<dir>/../lib/...` AND flat `<dir>/...`
//      to cover both registry and npm-global layouts)
//   3. ~/.mcode-webui/db-resolver.json (user persistent config — power
//      user pinning, no per-session env needed)
//   4. Built-in fallback (lowest): <home>/.minimax-code/lib/... standard
//      install + <__dirname>/../../../node_modules/... dev layout
//
// Exported (underscore prefix = test-only) so install-layout tests can
// assert the candidate list without actually loading better-sqlite3.
// `mcodeCmd` and `home` are parameterized so tests can simulate any
// install layout without mutating module-level constants.
export function _getBetterSqlite3Candidates({ mcodeCmd = MCODE_CMD, home = homedir() } = {}) {
  const candidates = [];
  if (process.env.MCODE_BETTER_SQLITE3) {
    candidates.push(process.env.MCODE_BETTER_SQLITE3);
  }
  if (mcodeCmd && mcodeCmd !== "mcode") {
    // mcodeCmd is the mcode executable file path (e.g.
    // ~/.minimax-code/bin/mcode on macOS, or ~/.minimax-code/mcode.cmd
    // on Windows, or /usr/local/bin/mcode for npm-global). The mcode
    // package's node_modules/ lives in a sibling of the binary's dir,
    // depending on the install layout:
    //
    //   • npm-style install (macOS default): binary at <root>/bin/mcode,
    //     package at <root>/lib/, deps at <root>/lib/node_modules/...
    //     → up 1 from the binary's dir, then down to "lib/node_modules/".
    //   • flat install (some Linux): binary at <root>/mcode, package at
    //     <root>/, deps at <root>/node_modules/...
    //     → same dir as the binary.
    //
    // Round 4 used `MCODE_CMD/../../` which treated the executable
    // file as a directory and went 3 levels above the install root.
    // Round 5 picked one of the two layouts; round 6 emits BOTH so the
    // candidate list works for either install style.
    candidates.push(
      join(
        dirname(mcodeCmd), "..", "lib",
        "node_modules", "@minimax-ai", "code", "node_modules",
        "better-sqlite3",
      ),
    );
    candidates.push(
      join(
        dirname(mcodeCmd),
        "node_modules", "@minimax-ai", "code", "node_modules",
        "better-sqlite3",
      ),
    );
  }
  // Tier 3: user persistent resolver config (~/.mcode-webui/db-resolver.json).
  //   Emitted even when MCODE_CMD is the "mcode" PATH-placeholder, because
  //   the user's pinned path is independent of the mcode binary location.
  candidates.push(..._loadUserResolverConfig({ home }));
  // Tier 4a: standard install location: <home>/.minimax-code/lib/node_modules/...
  // Emitted unconditionally so we work even when MCODE_CMD is the
  // PATH-placeholder "mcode" (config.js can't find a mcode.cmd on
  // macOS where the binary is just "mcode").
  candidates.push(
    join(
      home, ".minimax-code", "lib",
      "node_modules", "@minimax-ai", "code", "node_modules",
      "better-sqlite3",
    ),
  );
  // Dev layout fallback — webui source tree at <mcode-root>/webui/server/lib/
  candidates.push(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "..", "..",
      "node_modules", "@minimax-ai", "code", "node_modules",
      "better-sqlite3",
    ),
  );
  return candidates;
}

export function getMcodeBetterSqlite3({ MCODE_RUNTIME_DB: _ignored } = {}) {
  if (_McodeBetterSqlite3) return _McodeBetterSqlite3;
  if (_McodeBetterSqlite3Failed) return null;
  // C01: probe every candidate with `_probeCandidate` (no-throw tuple),
  // then on success re-require (cached no-op) to grab the module export.
  // On all-fail, emit one console.warn per attempt + one summary so the
  // operator can tell "missing path" from "NODE_MODULE_VERSION mismatch"
  // without re-running with strace.
  const candidates = _getBetterSqlite3Candidates();
  const failures = [];
  for (const c of candidates) {
    const result = _probeCandidate(c);
    if (result.error === null && result.exists) {
      _McodeBetterSqlite3 = _webuiRequire(c);
      return _McodeBetterSqlite3;
    }
    failures.push(result);
  }
  _McodeBetterSqlite3Failures = failures;
  _McodeBetterSqlite3Failed = true;
  // Per-attempt log: one line per failed candidate.
  for (const f of failures) {
    console.warn(
      `[webui] better-sqlite3 candidate: ${f.path} → ${f.error}`,
    );
  }
  // Summary line with remediation hints (3 ways to fix).
  console.warn(
    `[webui] cannot load better-sqlite3 from any of ${failures.length} candidate(s). ` +
      `Fix by (a) setting $MCODE_BETTER_SQLITE3 to an absolute path, ` +
      `(b) writing ~/.mcode-webui/db-resolver.json with ` +
      `{"better_sqlite3_candidates":["/abs/path/..."]}, or ` +
      `(c) running \`npm rebuild better-sqlite3\` to repair the native binding.`,
  );
  return null;
}

// 删 mcode session 涉及的所有关联表 (含 FTS5 external content + 各种 state 表)
//   ON DELETE CASCADE 需要 PRAGMA foreign_keys=ON 才生效 (SQLite 默认 OFF), 这里不用 cascade, 全手动删
// v1.0: 覆盖面对齐真实 schema — 实测 ~/.minimax/v2/sqlite 里有 28 张 session_id 键控表,
//   旧清单只删 9 张, 会把 message_rows(消息本体)/token_usage/pi_history 等大量数据留成孤儿行。
//   现按 "local_runtime_* 前缀 + PRAGMA 确认有 session_id 列" 全量收录;
//   questionnaire_requests 无 local_runtime 前缀、归属不明, 暂不删 (缺失表由调用处 try/catch 跳过)。
export const MCODE_SESSION_DELETE_TABLES = [
  // — 会话本体与索引 —
  "local_runtime_sessions",
  "local_runtime_sessions_fts", // external content FTS5 (会话标题搜索)
  "local_runtime_session_fts_keys",
  "local_runtime_session_locks",
  "local_runtime_session_projection_watermarks",
  "local_runtime_session_asset_index_state",
  "local_runtime_session_agent_state",
  "local_runtime_workspace_indexing_sessions",
  "local_runtime_workspace_indexing_revisions",
  "local_runtime_session_assets",
  // — 消息本体 (v1.0 补) —
  "local_runtime_messages",
  "local_runtime_message_rows",
  "local_runtime_message_row_migrations",
  "local_runtime_pi_history_rows",
  "local_runtime_pi_history_row_migrations",
  "local_runtime_pi_history_file_migrations",
  // — turn / 队列 (v1.0 补) —
  "local_runtime_turn_ingress",
  "local_runtime_turn_ingress_client_requests",
  "local_runtime_turn_diffs",
  "local_runtime_turn_diff_journal",
  "local_runtime_turn_diff_rewind_operations",
  "local_runtime_queues",
  "local_runtime_queue_items",
  "local_runtime_queue_row_migrations",
  "local_runtime_queue_migration_quarantine",
  // — 用量与账目 (v1.0 补) —
  "local_runtime_token_usage",
  "local_runtime_ledger_watermarks",
  // — 关联实体 (v1.0 补) —
  "local_runtime_thread_goals",
  "local_runtime_cron_session_history",
  "local_runtime_v2_cron_runs",
  "local_runtime_file_api_uploads",
  "local_runtime_query_view_states",
];

// PR#55 review pt 4 (2026-09-21): per-table error CLASSIFICATION.
// The old code caught every per-table error as if the table were merely
// absent and still returned ok:true — a lock conflict, a prepare/run
// failure, a schema anomaly, or an IO error was indistinguishable from
// "mcode version without this table", so real failures reported success.
// Only a CONFIRMED missing table is skippable now; everything else
// rethrows so better-sqlite3 rolls the transaction back and the caller
// gets {ok:false} with a classified reason.
function _sqliteErrorMessage(e) {
  return e && e.message ? String(e.message) : "";
}

// Confirmed missing table = (a) the error text is SQLite's
// "no such table" shape AND (b) the schema catalog read on THIS
// connection agrees the table truly does not exist. A "no such table"
// message while sqlite_schema still lists the table (torn state,
// shadow-table weirdness) is NOT confirmed → surfaces as a real error.
function _isConfirmedMissingTable(db, table, e) {
  if (!/^no such table:\s*\S+/i.test(_sqliteErrorMessage(e))) return false;
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c FROM sqlite_schema WHERE type = 'table' AND name = ?",
      )
      .get(table);
    return !!row && row.c === 0;
  } catch {
    return false; // catalog unreadable → cannot confirm → real error
  }
}

// Confirmed unsupported schema = the error is SQLite's "no such column"
// shape naming the exact column our DELETE/SELECT filters on
// (session_id), AND table_info() agrees the table exists but lacks
// that column. The delete list is curated for session_id-keyed tables,
// so a present-but-keyless table means this mcode version's schema is
// not one we know how to delete from — reported as
// {ok:false, reason:"unsupported_schema"}, never as success.
function _isConfirmedUnsupportedSchema(db, table, e) {
  const m = /^no such column:\s*(\S+)/i.exec(_sqliteErrorMessage(e));
  if (!m) return false;
  const col = m[1].split(".").pop(); // strip db.table.col qualification
  if (col !== "session_id") return false;
  try {
    const rows = db.pragma(`table_info(${table})`);
    return (
      Array.isArray(rows) &&
      rows.length > 0 &&
      rows.every((r) => !r || r.name !== "session_id")
    );
  } catch {
    return false;
  }
}

// Shared per-table classifier for the dry-run (COUNT) and real-delete
// (DELETE) loops. Verdicts: "absent" (confirmed missing table — benign
// skip), "unsupported_schema" (confirmed keyless table — labelled
// abort), "error" (lock / prepare / run / IO / anything else — abort).
function _classifyTableError(db, table, e) {
  if (_isConfirmedMissingTable(db, table, e)) return "absent";
  if (_isConfirmedUnsupportedSchema(db, table, e)) return "unsupported_schema";
  return "error";
}

// Tagged error for the unsupported-schema verdict. The outer catch
// reads .unsupportedSchema/.table to shape the failure return without
// string-matching the message again.
function _schemaError(table, e) {
  const err = new Error(
    `unsupported schema: table ${table} exists without a session_id column`,
  );
  if (e && e.code) err.code = e.code;
  err.table = table;
  err.unsupportedSchema = true;
  return err;
}

export function deleteMcodeSessionFromDb(
  sid,
  { MCODE_RUNTIME_DB, dryRun = false } = {},
) {
  if (!/^mvs_[a-f0-9]{32}$/.test(sid))
    return { ok: false, reason: "not_mcode_sid" };
  // Check db path BEFORE loading better-sqlite3 so callers get the most
  // specific failure first. Round 4 had these reversed: callers passing
  // a missing MCODE_RUNTIME_DB got `better_sqlite3_not_loaded` even when
  // the db path was the actual problem. lib-db.test.js already
  // documents the expected order: `mcode_db_not_found` must win.
  if (!MCODE_RUNTIME_DB || !existsSync(MCODE_RUNTIME_DB))
    return { ok: false, reason: "mcode_db_not_found" };
  const Db = getMcodeBetterSqlite3();
  if (!Db) return { ok: false, reason: "better_sqlite3_not_loaded" };

  // dry-run path: open readonly, count rows per table, do NOT modify.
  // Satisfies mcode-plugin-guide red-lines.md §"写操作/破坏性操作":
  // callers (CLI / API) can preview what would be deleted before committing.
  if (dryRun) {
    let db;
    try {
      db = new Db(MCODE_RUNTIME_DB, { readonly: true });
      const log = [];
      for (const t of MCODE_SESSION_DELETE_TABLES) {
        try {
          const r = db
            .prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE session_id = ?`)
            .get(sid);
          if (r && r.c > 0) log.push(`${t}:${r.c}`);
        } catch (e) {
          // PR#55 review pt 4: skip ONLY a confirmed missing table
          // (mcode versions differ in schema — absence is benign).
          // Lock/prepare/run/schema/IO errors rethrow → the outer
          // catch reports {ok:false}; a preview must not fake success
          // by silently undercounting either.
          const verdict = _classifyTableError(db, t, e);
          if (verdict === "absent") continue;
          throw verdict === "unsupported_schema" ? _schemaError(t, e) : e;
        }
      }
      db.close();
      const totalRows = log.reduce((s, e) => s + Number(e.split(":")[1]), 0);
      // B01: dry-run previews are state-touching actions. Record
      // what would have been deleted. dryRun:true marker lets the
      // audit distinguish "actually deleted" from "previewed".
      // Fail-closed (2026-09-20): a failed preview audit surfaces as
      // {ok:false} instead of being swallowed.
      try {
        _eventsAppend("session.delete", {
          target: sid,
          actor: "user",
          payload: {
            matchKind: "dryRun_db",
            dryRun: true,
            previewedRows: totalRows,
            tables: log.length,
          },
        });
      } catch (e) {
        return { ok: false, reason: "audit_write_failed", error: e.message };
      }
      return { ok: true, dryRun: true, log, totalRows };
    } catch (e) {
      if (db) try { db.close(); } catch {}
      return { ok: false, error: e.message };
    }
  }

  let db;
  try {
    // Write-ahead audit (2026-09-20 rigor fix): the intent line must
    // land BEFORE the transaction opens. Failure → {ok:false} and the
    // caller aborts; the db is untouched.
    try {
      _eventsAppend("session.delete.intent", {
        target: sid,
        actor: "user",
        payload: {
          matchKind: "db",
          dryRun: false,
        },
      });
    } catch (e) {
      return { ok: false, reason: "audit_write_failed", error: e.message };
    }
    db = new Db(MCODE_RUNTIME_DB, { readonly: false });
    db.pragma("busy_timeout = 5000"); // mcode 端可能在写, 最多等 5s
    const log = [];
    const tablesAbsent = [];
    // PR#55 review pt 4: the delete runs as ONE explicit transaction —
    // any non-absent per-table error throws out of the tx body so
    // better-sqlite3 issues ROLLBACK (partial deletes never commit)
    // and the outer catch shapes a classified failure return.
    const tx = db.transaction((sid) => {
      for (const t of MCODE_SESSION_DELETE_TABLES) {
        try {
          const r = db
            .prepare(`DELETE FROM ${t} WHERE session_id = ?`)
            .run(sid);
          if (r.changes > 0) log.push(`${t}:${r.changes}`);
        } catch (e) {
          // Skip ONLY a confirmed missing table (already-absent signal).
          // Lock conflicts (SQLITE_BUSY/LOCKED), prepare/run failures,
          // schema anomalies, IO errors — all rethrow → rollback →
          // {ok:false}. The old code swallowed every per-table error
          // here and still returned ok:true: fake success on failure.
          const verdict = _classifyTableError(db, t, e);
          if (verdict === "absent") {
            tablesAbsent.push(t);
            continue;
          }
          throw verdict === "unsupported_schema" ? _schemaError(t, e) : e;
        }
      }
    });
    tx(sid);
    db.close();
    // B01: real mcode-side delete. We log AFTER tx() succeeds (no
    // event on rollback). log.length is the number of tables that
    // actually had rows for this sid — useful for "did this delete
    // touch anything?" debugging. We do NOT log the rows themselves
    // (privacy + volume).
    // Fail-closed: if the OUTCOME write fails we still report
    // {ok:false, reason:"audit_write_failed"} — the rows are gone but
    // the operator must see the audit gap, never a clean ok:true.
    const totalRowsDeleted = log.reduce(
      (s, e) => s + Number((e.split(":")[1] || "0")),
      0,
    );
    // PR#55 review pt 4: explicit outcome enumeration. Success is
    // "deleted" (rows removed) or "already_absent" (transaction
    // committed, nothing matched — whether the tables were absent or
    // simply held no rows for this sid). Anything else is {ok:false}.
    const outcome = totalRowsDeleted > 0 ? "deleted" : "already_absent";
    try {
      _eventsAppend("session.delete", {
        target: sid,
        actor: "user",
        payload: {
          matchKind: "db",
          dryRun: false,
          outcome,
          tablesAffected: log.length,
          tablesAbsent: tablesAbsent.length,
          totalRowsDeleted,
        },
      });
    } catch (e) {
      return { ok: false, reason: "audit_write_failed", error: e.message };
    }
    return {
      ok: true,
      outcome,
      log,
      totalRowsDeleted,
      tablesAbsent: tablesAbsent.length,
    };
  } catch (e) {
    if (db)
      try {
        db.close();
      } catch {}
    // tx body threw → better-sqlite3 already issued ROLLBACK (no
    // partial delete commits). Surface a classified failure — the old
    // code could not reach this branch for per-table errors at all,
    // which is exactly the fake-success bug PR#55 review pt 4 names.
    if (e && e.unsupportedSchema) {
      return {
        ok: false,
        reason: "unsupported_schema",
        table: e.table,
        error: e.message,
      };
    }
    return {
      ok: false,
      reason: "db_error",
      error: e && e.message ? e.message : String(e),
      code: e && e.code ? e.code : undefined,
    };
  }
}
