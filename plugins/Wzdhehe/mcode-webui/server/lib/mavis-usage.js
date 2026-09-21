// webui/server/lib/mavis-usage.js
// Pull real token usage from mavis runtime-state.sqlite (per-turn + cumulative).
//
// G03: prefer Node's builtin `node:sqlite` (Node 22.5+) over spawning the
//   `sqlite3` CLI binary. The CLI binary is not always installed on Linux
//   (Ubuntu's libsqlite3-0 ships the .so but NOT the sqlite3 CLI — apt install
//   sqlite3 is an extra step; CI runners / slim images / distroless containers
//   routinely skip it). The spawn was also a needless process context switch
//   for what is a single-row read. `node:sqlite` is faster, dependency-free,
//   and works on every supported Node version (engines `>=22.19` covers 22.5+).
//   Falls back to spawning the sqlite3 CLI if the builtin is missing —
//   defensive for future runtime drift, not reachable today given the engines
//   constraint. If both paths fail, returns null and the caller falls back
//   to estimation (existing graceful-degradation behaviour, unchanged).

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { MAVIS_DB_PATH, SQLITE3_BIN } from "./config.js";

// G03: node:sqlite capability cache. Dynamic import may throw on Node <22.5.
//   Tri-state: `undefined` (not yet probed), `false` (probed, unavailable),
//   or the module namespace (probed, available).
let _nodeSqliteMod = undefined;
async function _getNodeSqliteMod() {
  if (_nodeSqliteMod !== undefined) return _nodeSqliteMod || null;
  try {
    _nodeSqliteMod = await import("node:sqlite");
  } catch {
    _nodeSqliteMod = false; // probed: not available
  }
  return _nodeSqliteMod || null;
}

// G03: SQL is parameterised via `?` placeholders. node:sqlite binds natively;
//   the spawn fallback substitutes the single known-safe hex string (the
//   regex check below guarantees only [a-f0-9] chars reach the substitution,
//   so this is safe by construction). Parameterised queries are the right
//   shape for both paths going forward — the spawn fallback uses SQL with
//   no string literals, so `?` substitution cannot collide with content.
//   13 fields — 5 totals + rows + last_ts + first_ts + 5 last-turn values.
const MAVIS_TOKEN_USAGE_SQL_PARAMS = `
  SELECT
    COALESCE(SUM(input_tokens),0) AS total_input,
    COALESCE(SUM(output_tokens),0) AS total_output,
    COALESCE(SUM(cache_read_tokens),0) AS total_cache_read,
    COALESCE(SUM(cache_write_tokens),0) AS total_cache_write,
    COALESCE(SUM(reasoning_tokens),0) AS total_reasoning,
    COUNT(*) AS rows,
    COALESCE(MAX(ts),0) AS last_ts,
    COALESCE(MIN(ts),0) AS first_ts,
    (SELECT input_tokens FROM local_runtime_token_usage WHERE session_id = ? ORDER BY ts DESC LIMIT 1) AS last_input,
    (SELECT output_tokens FROM local_runtime_token_usage WHERE session_id = ? ORDER BY ts DESC LIMIT 1) AS last_output,
    (SELECT cache_read_tokens FROM local_runtime_token_usage WHERE session_id = ? ORDER BY ts DESC LIMIT 1) AS last_cache_read,
    (SELECT cache_write_tokens FROM local_runtime_token_usage WHERE session_id = ? ORDER BY ts DESC LIMIT 1) AS last_cache_write,
    (SELECT reasoning_tokens FROM local_runtime_token_usage WHERE session_id = ? ORDER BY ts DESC LIMIT 1) AS last_reasoning
  FROM local_runtime_token_usage WHERE session_id = ?
`;

const MAVIS_TOKEN_MODEL_SQL_PARAMS = `
  SELECT model, input_tokens, output_tokens, cache_read_tokens, ts
  FROM local_runtime_token_usage
  WHERE session_id = ? AND model IS NOT NULL AND model != ''
  ORDER BY ts DESC LIMIT 1
`;

// Substitutes `?` placeholders with a single-quoted mvsSessionId for the
//   spawn path. mvsSessionId is hex-only (regex enforced in the caller) —
//   the only chars that could need escaping are `'` (none in hex) so this
//   is safe by construction. Kept separate from the SQL constant so we
//   don't risk replacing `?` inside a future string literal.
function _interpolateMavisSessionId(sql, mvsSessionId) {
  return sql.replace(/\?/g, () => `'${mvsSessionId}'`);
}

// G03: build the canonical usage-result object from either an object row
//   (node:sqlite: `{ total_input, ..., last_reasoning }`, JS null for NULL cols)
//   or a string[] row (spawn: `["0", "1", ..., "500"]`, empty string for NULL cols).
//   Returns null on missing/empty rows (matches existing 0-rows contract).
function _buildUsageResult(row) {
  let ti, to, tcr, tcw, tr, rows;
  let lastIn, lastOut, lastCr, lastCw, lastReasoning;
  let firstTs, lastTs;
  if (Array.isArray(row)) {
    // spawn path: pipe-delimited string[], need at least 13 fields
    if (row.length < 13) return null;
    const [tiS, tiO, tiCr, tiCrW, tiR, rowsS] = row.map(Number);
    ti = tiS; to = tiO; tcr = tiCr; tcw = tiCrW; tr = tiR; rows = rowsS;
    // v0.5.bx-20: per-turn fields (parts[8..12]).
    // v0.5.bx-30 (修): `lastContextTokens` → `lastTurnContextTokens` — 旧名跟 reader
    //   (applyMavisUsageToCs: cs.context.tokens = mavisUsage.lastTurnContextTokens)
    //   不一致, exit handler 抛 ReferenceError, resolve 永远不调, consumer 永远 await 不出真值
    lastIn = Number(row[8]);
    lastOut = Number(row[9]);
    lastCr = Number(row[10]);
    lastCw = Number(row[11]);
    // `Number("")` is 0 in JS; `|| 0` also defends against "NULL" / NaN.
    lastReasoning = Number(row[12]) || 0;
    lastTs = Number(row[6]);
    firstTs = Number(row[7]);
  } else if (row && typeof row === "object") {
    // node:sqlite path: named columns, JS null for NULL cells (Number(null) === 0)
    rows = Number(row.rows) || 0;
    ti = Number(row.total_input) || 0;
    to = Number(row.total_output) || 0;
    tcr = Number(row.total_cache_read) || 0;
    tcw = Number(row.total_cache_write) || 0;
    tr = Number(row.total_reasoning) || 0;
    lastIn = Number(row.last_input) || 0;
    lastOut = Number(row.last_output) || 0;
    lastCr = Number(row.last_cache_read) || 0;
    lastCw = Number(row.last_cache_write) || 0;
    lastReasoning = Number(row.last_reasoning) || 0;
    lastTs = Number(row.last_ts) || 0;
    firstTs = Number(row.first_ts) || 0;
  } else {
    return null;
  }
  if (!rows) return null;
  // v0.5.bx-20: per-turn cache 命中率 = cache_read / (input + cache_read + cache_write)
  //   反映最近一轮 prompt 的 cache 复用, 累计算跟 context limit 矛盾
  // v0.5.by: per-turn context 占用 = input + output + reasoning (cache_read 是 input 子集, 不重算)
  const lastTurnContextTokens = lastIn + lastOut + lastReasoning;
  const lastTotal = lastIn + lastCr + lastCw;
  const cacheHitRate = lastTotal > 0 ? lastCr / lastTotal : 0;
  return {
    rows,
    totalInput: ti,
    totalOutput: to,
    totalCacheRead: tcr,
    totalCacheWrite: tcw,
    totalReasoning: tr,
    firstTs,
    lastTs,
    cacheHitRate,
    // v0.5.by: per-turn 原始值 (调试/显示用, 给 F12 排查方便)
    lastTurnInput: lastIn,
    lastTurnOutput: lastOut,
    lastTurnCacheRead: lastCr,
    lastTurnCacheWrite: lastCw,
    lastTurnReasoning: lastReasoning,
    lastTurnContextTokens, // applyMavisUsageToCs 用这个当 context.used
  };
}

// G03: node:sqlite path — synchronous query, no process overhead.
//   Returns parsed object or null on failure / 0 rows / exception.
function _queryMavisUsageViaNodeSqlite(DatabaseSync, mvsSessionId) {
  let db;
  try {
    db = new DatabaseSync(MAVIS_DB_PATH, { readOnly: true });
    const row = db.prepare(MAVIS_TOKEN_USAGE_SQL_PARAMS).get(
      mvsSessionId, mvsSessionId, mvsSessionId, mvsSessionId, mvsSessionId,
      mvsSessionId,
    );
    return _buildUsageResult(row);
  } catch {
    return null;
  } finally {
    if (db) try { db.close(); } catch {}
  }
}

// G03: spawn fallback — pipe-delimited output, identical shape.
//   Returns parsed object or null on failure / 0 rows / missing binary.
async function _queryMavisUsageViaSpawn(mvsSessionId) {
  return await new Promise((resolve) => {
    const sql = _interpolateMavisSessionId(MAVIS_TOKEN_USAGE_SQL_PARAMS, mvsSessionId);
    const child = spawn(SQLITE3_BIN, [MAVIS_DB_PATH, "-readonly", sql], {
      windowsHide: true,
    });
    let stdout = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, 5000);
    child.stdout?.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const parts = stdout
        .trim()
        .split("|")
        .map((s) => s.trim());
      resolve(_buildUsageResult(parts));
    });
  });
}

// G03: same dual-path shape for the model lookup.
function _queryMavisModelViaNodeSqlite(DatabaseSync, mvsSessionId) {
  let db;
  try {
    db = new DatabaseSync(MAVIS_DB_PATH, { readOnly: true });
    const row = db.prepare(MAVIS_TOKEN_MODEL_SQL_PARAMS).get(mvsSessionId);
    if (!row) return null;
    return {
      model: row.model,
      input: Number(row.input_tokens) || 0,
      output: Number(row.output_tokens) || 0,
      cacheRead: Number(row.cache_read_tokens) || 0,
      ts: Number(row.ts) || 0,
    };
  } catch {
    return null;
  } finally {
    if (db) try { db.close(); } catch {}
  }
}

async function _queryMavisModelViaSpawn(mvsSessionId) {
  return await new Promise((resolve) => {
    const sql = _interpolateMavisSessionId(MAVIS_TOKEN_MODEL_SQL_PARAMS, mvsSessionId);
    const child = spawn(SQLITE3_BIN, [MAVIS_DB_PATH, "-readonly", sql], {
      windowsHide: true,
    });
    let stdout = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, 5000);
    child.stdout?.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const parts = stdout.trim().split("|");
      if (parts.length < 5) {
        resolve(null);
        return;
      }
      resolve({
        model: parts[0],
        input: Number(parts[1]),
        output: Number(parts[2]),
        cacheRead: Number(parts[3]),
        ts: Number(parts[4]),
      });
    });
  });
}

// v0.5.bx-10: 从 mavis 桌面端 sqlite 读 mcode acp session 的真实 token usage
//   数据源：MAVIS_DB_PATH (=~/.minimax/v2/sqlite/runtime-state.sqlite) 的 local_runtime_token_usage 表
//   mavis hook 自动写入所有 mcode 调用 (framework_type='pi-agent')
//   返回 { totalInput, totalOutput, totalCacheRead, totalCacheWrite, count, byModel: {model: {input,output,...}} }
//   失败（db 不存在 / 查不到 / 0 条 / node:sqlite 抛错 / spawn ENOENT）时返回 null，调用方 fallback 估算
export async function getMavisTokenUsage(mvsSessionId) {
  if (!mvsSessionId || !existsSync(MAVIS_DB_PATH)) return null;
  // sql 注入防护：mvsSessionId 必须 mvs_ 前缀
  if (!/^mvs_[a-f0-9]{16,}$/i.test(mvsSessionId)) return null;
  // G03: prefer node:sqlite (Node 22.5+, works on Linux without sqlite3 CLI).
  //   If the builtin is unavailable, fall through to the spawn path.
  //   If node:sqlite returns null (0 rows OR table-missing OR db-corrupt),
  //   we DO NOT fall through to spawn — both paths would resolve null for
  //   those cases, so the extra spawn is wasteful. (Same applies to the
  //   0-rows case — spawning to confirm "still 0 rows" is pure waste.)
  const nodeSqlite = await _getNodeSqliteMod();
  if (nodeSqlite && nodeSqlite.DatabaseSync) {
    return _queryMavisUsageViaNodeSqlite(nodeSqlite.DatabaseSync, mvsSessionId);
  }
  // Fallback: spawn sqlite3 CLI binary (the original G02-era path).
  return await _queryMavisUsageViaSpawn(mvsSessionId);
}

// v0.5.bx-10: 用 mavis db 拿最近一条 row 的 model 字段（拿不到 model id 就算了）
export async function getMavisTokenUsageModel(mvsSessionId) {
  if (!mvsSessionId || !existsSync(MAVIS_DB_PATH)) return null;
  if (!/^mvs_[a-f0-9]{16,}$/i.test(mvsSessionId)) return null;
  // G03: same dual-path pattern as getMavisTokenUsage.
  const nodeSqlite = await _getNodeSqliteMod();
  if (nodeSqlite && nodeSqlite.DatabaseSync) {
    return _queryMavisModelViaNodeSqlite(nodeSqlite.DatabaseSync, mvsSessionId);
  }
  return await _queryMavisModelViaSpawn(mvsSessionId);
}

// Apply mavis token usage to cs.context + cs.usage (with cache_hit_rate + model).
// Caller is responsible for pushing state after this returns.
export async function applyMavisUsageToCs(
  cs,
  mvsSessionId,
  { getMcodeModelLimit },
) {
  const mavisUsage = await getMavisTokenUsage(mvsSessionId);
  if (!mavisUsage || mavisUsage.rows === 0) return false;
  // v0.5.by fix (改自 v0.5.bx-10): context 数字改用 per-turn, 不是累计
  //   之前 newTokens = totalInput + totalOutput + totalReasoning (SUM 累计, 13 轮可到 566k)
  //   改 lastTurnContextTokens = 最近一轮 input + output + reasoning (per-turn, 永远 ≤ limit)
  //   累计值仍保留在 cs.usage.sessionInput/Output/Total, 供 "总成本" 展示用
  const newTokens = mavisUsage.lastTurnContextTokens;
  cs.context.tokens = newTokens;
  cs.context.used = newTokens;
  // v0.5.bx-10: 按 model 查真实 context limit (mcode cli.js 硬编码: MiniMax-M3=512k, M2.7*=200k)
  const modelName = (cs.model && cs.model.name) || "";
  if (typeof getMcodeModelLimit === "function") {
    const realLimit = getMcodeModelLimit(modelName);
    if (realLimit) cs.context.limit = realLimit;
  }
  cs.context.percent = cs.context.limit
    ? Math.round((newTokens / cs.context.limit) * 100)
    : 0;
  cs.context.estimated = false; // 真值
  cs.context.usageSource = "mavis-db"; // 标记数据源
  cs.usage.sessionInput = mavisUsage.totalInput;
  cs.usage.sessionOutput = mavisUsage.totalOutput;
  cs.usage.sessionCacheRead = mavisUsage.totalCacheRead;
  cs.usage.sessionCacheWrite = mavisUsage.totalCacheWrite;
  cs.usage.sessionReasoning = mavisUsage.totalReasoning;
  cs.usage.sessionTotal = mavisUsage.totalInput + mavisUsage.totalOutput;
  // v0.5.bx-20: 真实 cache 命中率 — 累计 cache_read / (input + cache_read)
  cs.usage.sessionCacheHitRate = mavisUsage.cacheHitRate || 0;
  cs.usage.lastMavisUpdate = Date.now();
  // Try to also pull model name (best-effort)
  const m = await getMavisTokenUsageModel(mvsSessionId).catch(() => null);
  if (m && m.model) {
    cs.usage.mavisModel = m.model;
    cs.usage.mavisModelAt = Date.now();
  }
  return true;
}