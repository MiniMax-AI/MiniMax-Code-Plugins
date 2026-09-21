// webui/server/routes/usage.js
// POST /api/usage, POST /api/usage-trigger, GET /api/usage-real,
// POST /api/refresh, GET /api/usage/forecast
//
// C07 patch: appended recordSnapshotFromCs(ctx.cs) after runUsageQuery
// so each /api/usage call appends one NDJSON line to
// ~/.mcode-webui/usage-history.ndjson for the quota forecast. Also
// added handleForecast which exposes the prediction to the UI.

import { existsSync } from "node:fs";
import { runUsageQuery } from "../lib/usage.js";
import {
  getMavisTokenUsage,
  getMavisTokenUsageModel,
} from "../lib/mavis-usage.js";
import { pushStateFor } from "../lib/state-bus.js";
import { getMcodeModelLimit } from "../lib/models.js";
import { MAVIS_DB_PATH } from "../lib/config.js";
// C07: quota exhaustion forecast (linear LS on usage history)
//   readHistory + forecastExhaustion + recordSnapshotFromCs.
//   Pure module — no state-bus / settings coupling, just FS + math.
import {
  readHistory,
  forecastExhaustion,
  recordSnapshotFromCs,
} from "../lib/quota-forecast.js";

// POST /api/usage & /api/usage-trigger
export async function handleUsage(_req, res, ctx) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true }));
  await runUsageQuery(ctx.cs, ctx.cid);
  // C07: best-effort append one snapshot row to usage-history. The
  //   forecast is best-effort — failure here must not break the
  //   response. recordSnapshotFromCs returns false silently on error.
  try {
    recordSnapshotFromCs(ctx.cs);
  } catch {
    /* swallow — see comment above */
  }
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

// C07: GET /api/usage/forecast — predict quota exhaustion time.
//   Reads ~/.mcode-webui/usage-history.ndjson, runs forecastExhaustion,
//   and returns the JSON payload documented in CAPABILITIES.md §8.
//   Best-effort: if the file is missing or empty, returns
//   { ok: true, forecast: { ... reason: "no_history" } } so the UI
//   can render a "collecting data…" placeholder instead of erroring.
export async function handleForecast(_req, res, _ctx) {
  let history = [];
  try {
    history = readHistory();
  } catch {
    // readHistory already swallows FS errors; this catch is just a
    // belt-and-braces guard so a buggy extension never breaks the
    // endpoint.
    history = [];
  }
  const forecast = forecastExhaustion(history);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      forecast,
    }),
  );
}
