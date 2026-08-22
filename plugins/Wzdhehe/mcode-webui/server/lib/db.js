// webui/server/lib/db.js
// SQLite helpers — lazy require mcode's better-sqlite3 (so we don't break if missing).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const _webuiRequire = createRequire(import.meta.url);

// v0.5.bx-19: 用 mcode 自带的 better-sqlite3 直接操作 mcode session db
//   mcode 0.1.4 acp `session/delete` 返回 "Method not found" (协议层注册但没实现)
//   真删 mcode session 只能 SQL 删 local_runtime_sessions 等关联表
//   lazy init — 只在第一次调用时 require
let _McodeBetterSqlite3 = null;
let _McodeBetterSqlite3Failed = false;

export function getMcodeBetterSqlite3({ MCODE_RUNTIME_DB: _ignored } = {}) {
  if (_McodeBetterSqlite3) return _McodeBetterSqlite3;
  if (_McodeBetterSqlite3Failed) return null;
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const __cfg = join(__dirname, "..", "..", ".."); // webui/server/lib → ../.. → .minimax-code
    _McodeBetterSqlite3 = _webuiRequire(
      join(
        __cfg,
        "node_modules",
        "@minimax-ai",
        "code",
        "node_modules",
        "better-sqlite3",
      ),
    );
    return _McodeBetterSqlite3;
  } catch (e) {
    console.warn("[webui] cannot load better-sqlite3 from mcode:", e.message);
    _McodeBetterSqlite3Failed = true;
    return null;
  }
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

export function deleteMcodeSessionFromDb(
  sid,
  { MCODE_RUNTIME_DB, dryRun = false } = {},
) {
  if (!/^mvs_[a-f0-9]{32}$/.test(sid))
    return { ok: false, reason: "not_mcode_sid" };
  const Db = getMcodeBetterSqlite3();
  if (!Db) return { ok: false, reason: "better_sqlite3_not_loaded" };
  if (!MCODE_RUNTIME_DB || !existsSync(MCODE_RUNTIME_DB))
    return { ok: false, reason: "mcode_db_not_found" };

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
        } catch {
          // 表可能不存在 (mcode 不同版本 schema 略不同), 跳过
        }
      }
      db.close();
      const totalRows = log.reduce((s, e) => s + Number(e.split(":")[1]), 0);
      return { ok: true, dryRun: true, log, totalRows };
    } catch (e) {
      if (db) try { db.close(); } catch {}
      return { ok: false, error: e.message };
    }
  }

  let db;
  try {
    db = new Db(MCODE_RUNTIME_DB, { readonly: false });
    db.pragma("busy_timeout = 5000"); // mcode 端可能在写, 最多等 5s
    const log = [];
    const tx = db.transaction((sid) => {
      for (const t of MCODE_SESSION_DELETE_TABLES) {
        try {
          const r = db
            .prepare(`DELETE FROM ${t} WHERE session_id = ?`)
            .run(sid);
          if (r.changes > 0) log.push(`${t}:${r.changes}`);
        } catch (e) {
          // 表可能不存在 (mcode 不同版本 schema 略不同), 跳过
        }
      }
    });
    tx(sid);
    db.close();
    return { ok: true, log };
  } catch (e) {
    if (db)
      try {
        db.close();
      } catch {}
    return { ok: false, error: e.message };
  }
}
