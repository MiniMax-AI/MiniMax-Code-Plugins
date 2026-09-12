// webui/server/lib/mavis-usage.js
// Pull real token usage from mavis runtime-state.sqlite (per-turn + cumulative).

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { MAVIS_DB_PATH, SQLITE3_BIN } from "./config.js";

// v0.5.bx-10: 从 mavis 桌面端 sqlite 读 mcode acp session 的真实 token usage
//   数据源：MAVIS_DB_PATH (=~/.minimax/v2/sqlite/runtime-state.sqlite) 的 local_runtime_token_usage 表
//   mavis hook 自动写入所有 mcode 调用 (framework_type='pi-agent')
//   返回 { totalInput, totalOutput, totalCacheRead, totalCacheWrite, count, byModel: {model: {input,output,...}} }
//   失败（db 不存在 / 查不到 / 0 条）时返回 null，调用方 fallback 估算
export async function getMavisTokenUsage(mvsSessionId) {
  if (!mvsSessionId || !existsSync(MAVIS_DB_PATH)) return null;
  // sql 注入防护：mvsSessionId 必须 mvs_ 前缀
  if (!/^mvs_[a-f0-9]{16,}$/i.test(mvsSessionId)) return null;
  return await new Promise((resolve) => {
    // v0.5.bx-20 (改): 用 per-turn 命中率 (最近一行的 cache_read / total input)
    //   之前算的是累计 (SUM(cache_read) / SUM(input + cache_read)) — 但 context limit 只有 512k,
    //   累计 cache_read 13 轮能到 6519.5k, 跟 "上下文一共最高才 512k" 矛盾 (Wzdhehe 反馈)
    //   per-turn 反映"当前一轮 prompt" 的 cache 复用 — 这才是 user 关心的"当前 context 命中率"
    //   稳态 session per-turn 95-100%, 早期/大 input session 低一些 (因为新加 input 多, cache miss 多)
    // v0.5.by: 改 SQL 拿最近一行的全部字段 (input/output/cache_read/cache_write/reasoning)
    //   之前只拿 cache_read/input/cache_write, context 用 totalInput+totalOutput+totalReasoning (累计),
    //   导致 13 轮累计能到 566k / 512k — Wzdhehe 反馈 "我最大才 512, 确定没有统计错误吗"
    //   改 per-turn 后, context 数字 = 最近一轮 LLM 调用的 input + output + reasoning, 永远不会超 limit
    const sql = `SELECT
      COALESCE(SUM(input_tokens),0) AS total_input,
      COALESCE(SUM(output_tokens),0) AS total_output,
      COALESCE(SUM(cache_read_tokens),0) AS total_cache_read,
      COALESCE(SUM(cache_write_tokens),0) AS total_cache_write,
      COALESCE(SUM(reasoning_tokens),0) AS total_reasoning,
      COUNT(*) AS rows,
      COALESCE(MAX(ts),0) AS last_ts,
      COALESCE(MIN(ts),0) AS first_ts,
      (SELECT input_tokens FROM local_runtime_token_usage WHERE session_id = '${mvsSessionId}' ORDER BY ts DESC LIMIT 1) AS last_input,
      (SELECT output_tokens FROM local_runtime_token_usage WHERE session_id = '${mvsSessionId}' ORDER BY ts DESC LIMIT 1) AS last_output,
      (SELECT cache_read_tokens FROM local_runtime_token_usage WHERE session_id = '${mvsSessionId}' ORDER BY ts DESC LIMIT 1) AS last_cache_read,
      (SELECT cache_write_tokens FROM local_runtime_token_usage WHERE session_id = '${mvsSessionId}' ORDER BY ts DESC LIMIT 1) AS last_cache_write,
      (SELECT reasoning_tokens FROM local_runtime_token_usage WHERE session_id = '${mvsSessionId}' ORDER BY ts DESC LIMIT 1) AS last_reasoning
    FROM local_runtime_token_usage WHERE session_id = '${mvsSessionId}'`;
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
      // 解析: 13 字段 — total_i/o/cr/cw/r + rows + last_ts + first_ts + last_i/o/cr/cw/r
      //   索引: 0=ti 1=to 2=tcr 3=tcw 4=tr 5=rows 6=last_ts 7=first_ts
      //        8=last_input 9=last_output 10=last_cache_read 11=last_cache_write 12=last_reasoning
      const parts = stdout
        .trim()
        .split("|")
        .map((s) => s.trim());
      if (parts.length < 13) {
        resolve(null);
        return;
      }
      const [ti, to, tcr, tcw, tr, rows] = parts.map(Number);
      if (rows === 0) {
        resolve(null);
        return;
      }
      // v0.5.bx-20: per-turn cache 命中率 — 基于最近一行的 input + cache_read + cache_write
      //   公式: cache_read / (input + cache_read + cache_write)
      //   这反映最近一轮 prompt 的 cache 复用, 累计算跟 context limit 矛盾
      // v0.5.by: parts[8..12] 是 last 5 字段 (input/output/cache_read/cache_write/reasoning)
      const lastIn = Number(parts[8]);
      const lastOut = Number(parts[9]);
      const lastCr = Number(parts[10]);
      const lastCw = Number(parts[11]);
      const lastReasoning = Number(parts[12]) || 0;
      // per-turn context 占用: input + output + reasoning (cache_read 是 input 子集, 不重算)
      // v0.5.bx-30 (修): 之前叫 `lastContextTokens`,但 L84 的 shorthand 写的是 `lastTurnContextTokens`,
      //   applyMavisUsageToCs 也读 `mavisUsage.lastTurnContextTokens` — 三处名字不一致导致 child process
      //   exit handler 抛 ReferenceError, resolve 永远不调, applyMavisUsageToCs 永远 await 不出真值
      //   改: 变量名跟 shorthand 跟 reader 三处都对齐成 `lastTurnContextTokens`
      const lastTurnContextTokens = lastIn + lastOut + lastReasoning;
      const lastTotal = lastIn + lastCr + lastCw;
      const cacheHitRate = lastTotal > 0 ? lastCr / lastTotal : 0;
      resolve({
        rows,
        totalInput: ti,
        totalOutput: to,
        totalCacheRead: tcr,
        totalCacheWrite: tcw,
        totalReasoning: tr,
        firstTs: Number(parts[6]),
        lastTs: Number(parts[7]),
        cacheHitRate,
        // v0.5.by: per-turn 原始值 (调试/显示用, 给 F12 排查方便)
        lastTurnInput: lastIn,
        lastTurnOutput: lastOut,
        lastTurnCacheRead: lastCr,
        lastTurnCacheWrite: lastCw,
        lastTurnReasoning: lastReasoning,
        lastTurnContextTokens, // applyMavisUsageToCs 用这个当 context.used
      });
    });
  });
}

// v0.5.bx-10: 用 mavis db 拿最近一条 row 的 model 字段（拿不到 model id 就算了）
export async function getMavisTokenUsageModel(mvsSessionId) {
  if (!mvsSessionId || !existsSync(MAVIS_DB_PATH)) return null;
  if (!/^mvs_[a-f0-9]{16,}$/i.test(mvsSessionId)) return null;
  return await new Promise((resolve) => {
    const sql = `SELECT model, input_tokens, output_tokens, cache_read_tokens, ts FROM local_runtime_token_usage WHERE session_id = '${mvsSessionId}' AND model IS NOT NULL AND model != '' ORDER BY ts DESC LIMIT 1`;
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
