// webui/server/routes/usage.js
// POST /api/usage, POST /api/usage-trigger, GET /api/usage-real, POST /api/refresh

import { existsSync } from "node:fs";
import { runUsageQuery } from "../lib/usage.js";
import {
  getMavisTokenUsage,
  getMavisTokenUsageModel,
} from "../lib/mavis-usage.js";
import { pushStateFor } from "../lib/state-bus.js";
import { getMcodeModelLimit } from "../lib/models.js";
import { MAVIS_DB_PATH } from "../lib/config.js";

// POST /api/usage & /api/usage-trigger
export async function handleUsage(_req, res, ctx) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true }));
  await runUsageQuery(ctx.cs, ctx.cid);
}

// POST /api/refresh — noop (we already push state on demand)
export function handleRefresh(_req, res, ctx) {
  pushStateFor(ctx.cid);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ok: true }));
}

// GET /api/usage-real — 手动从 mavis db 拉真实 token usage
export async function handleUsageReal(req, res, ctx) {
  const cs = ctx.cs;
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const sid = cs.mcodeSessionId || url.searchParams.get("sid") || null;
  if (!sid) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({
        ok: true,
        found: false,
        reason: "no mcode session id yet",
      }),
    );
  }
  const usage = await getMavisTokenUsage(sid);
  const model = await getMavisTokenUsageModel(sid);
  if (!usage) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({
        ok: true,
        found: false,
        sid,
        dbPath: MAVIS_DB_PATH,
        dbExists: existsSync(MAVIS_DB_PATH),
      }),
    );
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      found: true,
      sid,
      rows: usage.rows,
      totalInput: usage.totalInput,
      totalOutput: usage.totalOutput,
      totalCacheRead: usage.totalCacheRead,
      totalCacheWrite: usage.totalCacheWrite,
      totalReasoning: usage.totalReasoning,
      // v0.5.bx-10 fix: context 实际是 input + output + reasoning (cache 是 input 子集)
      contextUsed: usage.totalInput + usage.totalOutput + usage.totalReasoning,
      model: (model && model.model) || null,
      modelLimit: getMcodeModelLimit(cs.model && cs.model.name),
      firstTs: usage.firstTs,
      lastTs: usage.lastTs,
      dbPath: MAVIS_DB_PATH,
    }),
  );
}
