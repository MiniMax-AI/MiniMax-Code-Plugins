// webui/server/routes/debug.js
// POST /api/debug/inject, GET /api/debug/state (DEBUG_INJECT=1 gated)

import { pushStateFor } from "../lib/state-bus.js";

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
}

// POST /api/debug/inject — mock state 字段给浏览器测 UI 渲染
export async function handleDebugInject(req, res, ctx) {
  if (process.env.DEBUG_INJECT !== "1") {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        ok: false,
        error: "DEBUG_INJECT not enabled (set DEBUG_INJECT=1 env to use)",
      }),
    );
  }
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  const applied = {};
  if (payload.goal && typeof payload.goal === "object") {
    cs.goal = { ...cs.goal, ...payload.goal };
    applied.goal = true;
  }
  if (Array.isArray(payload.todo)) {
    cs.todo = payload.todo;
    applied.todoCount = cs.todo.length;
  }
  if (payload.ask && typeof payload.ask === "object") {
    cs.ask = { ...cs.ask, ...payload.ask };
    applied.ask = true;
  }
  if (payload.plan && typeof payload.plan === "object") {
    cs.plan = { ...cs.plan, ...payload.plan };
    applied.plan = true;
  }
  if (payload.enterPlanMode && typeof payload.enterPlanMode === "object") {
    cs.enterPlanMode = { ...cs.enterPlanMode, ...payload.enterPlanMode };
    applied.enterPlanMode = true;
  }
  if (Array.isArray(payload.appendChat)) {
    cs.chat = [...(cs.chat || []), ...payload.appendChat];
    applied.appendedChatLines = payload.appendChat.length;
  }
  pushStateFor(cid);
  res.writeHead(200, { "Content-Type": "application/json" });
  return res.end(JSON.stringify({ ok: true, applied, cid }));
}

// GET /api/debug/state
export function handleDebugState(_req, res, ctx) {
  if (process.env.DEBUG_INJECT !== "1") {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({ ok: false, error: "DEBUG_INJECT not enabled" }),
    );
  }
  const cs = ctx.cs;
  res.writeHead(200, { "Content-Type": "application/json" });
  return res.end(
    JSON.stringify({
      ok: true,
      goal: cs.goal,
      todoCount: (cs.todo || []).length,
      ask: cs.ask,
      plan: cs.plan,
      enterPlanMode: cs.enterPlanMode,
      chatLast5: (cs.chat || []).slice(-5),
    }),
  );
}
