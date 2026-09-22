// webui/server/routes/protocol.js
// v0.5.by: mcode acp 协议 RPC 路由层
// 每个端点对应一个 mcode-rpc.js 函数,做参数校验 + 状态更新 + push state
//
// 端点清单:
//   POST /api/protocol/set-mode           — plan_mode / goal_mode / 默认
//   POST /api/protocol/set-config-option  — 通用 (permissionMode / model 等)
//   POST /api/protocol/cancel             — 取消正在跑的 prompt (温和版, 替 child.kill())
//   POST /api/protocol/load-session       — 加载任意 mcode session (含 TUI 跑的)
//   POST /api/protocol/activate-session   — 切到指定 session
//   GET  /api/protocol/list-sessions      — 拉 mcode session 列表 (TUI 远控入口)
//
// 设计原则: 永远不 throw, 永远返 {ok, data?, error?, code?}; 状态变化后 pushStateFor(cid).

import {
  setMode,
  setConfigOption,
  cancelSession,
  loadSession,
  activateSession,
  listSessions,
  mcodePermissionToWebui,
} from "../lib/mcode-rpc.js";
import { loadSessions, saveSessions, resetContext } from "../lib/sessions.js";
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

function respond(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

// ============================================================
// POST /api/protocol/set-mode  { sessionId, mode }
// ============================================================
export async function handleSetMode(req, res, ctx) {
  const { sessionId, mode } = await readJson(req);
  if (!sessionId)
    return respond(res, 400, { ok: false, error: "sessionId required" });
  if (!mode) return respond(res, 400, { ok: false, error: "mode required" });
  let r;
  try {
    r = await setMode(sessionId, mode);
  } catch (e) {
    // mcode acp 客户端炸了 (例如 session 未知导致底层 jsonrpc 抛)
    // 避免 500 — 包成 fail 让前端能看
    console.warn(`[protocol.set-mode] caught throw: ${e.message || e}`);
    r = { ok: false, error: e.message || String(e), code: "client_throw" };
  }
  if (!r.ok) {
    // mcode 0.1.5 不支持 set_mode — 返 501, 让前端走降级路径 (用 /plan slash command 代替)
    const httpCode =
      r.code === "unsupported"
        ? 501
        : r.code === "no_client"
          ? 503
          : r.code && /not.found|invalid/i.test(r.code)
            ? 404
            : r.code && /conflict|policy/i.test(r.code)
              ? 409
              : 502;
    return respond(res, httpCode, {
      ok: false,
      error: r.error,
      code: r.code,
      fallback: "send_plan_as_prompt",
    });
  }
  // 同步本地 state.planMode 标志 (前端某些 UI 还读这个)
  // set-mode 端点只接 plan_mode 类的 mode 名, 不接 permission 类的 'off'/'default'
  //   (off 是 permission mode, 不是 plan mode 退出值 — 误用会让 mcode 看着像"退出 plan"
  //    实际是给 permissionMode 赋值, 后续 set_config_option 一调会引发灵异 bug)
  if (ctx && ctx.cs) {
    if (mode === "plan_mode" || mode === "plan") ctx.cs.planMode = true;
    else if (mode === "default" || mode === "normal") ctx.cs.planMode = false;
    // 其他 mode (goal_mode / 自定义) 不动 planMode
  }
  if (ctx && ctx.cid) pushStateFor(ctx.cid);
  return respond(res, 200, { ok: true, mode, data: r.data });
}

// ============================================================
// POST /api/protocol/set-config-option  { sessionId, key, value }
// 通用配置选项。permissionMode / model / 等都走这里
// ============================================================
export async function handleSetConfigOption(req, res, ctx) {
  const { sessionId, key, value } = await readJson(req);
  if (!sessionId)
    return respond(res, 400, { ok: false, error: "sessionId required" });
  if (!key) return respond(res, 400, { ok: false, error: "key required" });
  const r = await setConfigOption(sessionId, key, value);
  if (!r.ok) {
    const httpCode =
      r.code === "unsupported"
        ? 501
        : r.code === "no_client"
          ? 503
          : r.code && /not.found|invalid/i.test(r.code)
            ? 404
            : r.code && /conflict|policy/i.test(r.code)
              ? 409
              : 500;
    return respond(res, httpCode, { ok: false, error: r.error, code: r.code });
  }
  // 权限 mode 同步到 webui cs.permissions (供前端 icon/label 显示)
  if (key === "permissionMode" && ctx && ctx.cs) {
    ctx.cs.permissions = mcodePermissionToWebui(value);
  }
  if (ctx && ctx.cid) pushStateFor(ctx.cid);
  return respond(res, 200, { ok: true, key, value, data: r.data });
}

// ============================================================
// POST /api/protocol/cancel  { sessionId }
// 取消正在跑的 prompt。比 child.kill() 温和: 让 mcode 走完 finalize,而不是直接 SIGKILL
// ============================================================
export async function handleCancel(req, res, ctx) {
  const { sessionId } = await readJson(req);
  if (!sessionId)
    return respond(res, 400, { ok: false, error: "sessionId required" });
  const r = await cancelSession(sessionId);
  // 即便 mcode 返错 (例如 session 已结束 或 unsupported), 也算"用户意图取消"
  // mcode 0.1.5 不支持 session/cancel — 返 cancelled:false + 提示, 让上层走 hard kill fallback
  if (!r.ok) {
    return respond(res, 200, {
      ok: true,
      cancelled: false,
      warning: r.error,
      code: r.code,
      fallback: "hard_kill",
    });
  }
  if (ctx && ctx.cid) pushStateFor(ctx.cid);
  return respond(res, 200, { ok: true, cancelled: true, data: r.data });
}

// ============================================================
// POST /api/protocol/load-session  { sessionId, cwd?, createWebuiEntry? }
// 加载任意 mcode session (含 TUI 跑的)。
//  - 默认: 仅在 mcode 端 load, 不动 webui session
//  - createWebuiEntry=true: 同时在 webui session db 创建 entry (用于 sidebar 显示)
// ============================================================
export async function handleLoadSession(req, res, ctx) {
  const { sessionId, cwd, createWebuiEntry } = await readJson(req);
  if (!sessionId)
    return respond(res, 400, { ok: false, error: "sessionId required" });
  const r = await loadSession(sessionId, cwd || ctx?.cs?.workspace?.dir || "");
  if (!r.ok) {
    const httpCode =
      r.code === "no_client"
        ? 503
        : r.code && /not.found|invalid/i.test(r.code)
          ? 404
          : 500;
    // mcode acp "Resource not found" 返 404 的子情况, code 是 -32004 / 'resource_not_found'
    //   给前端更可读的 code
    const outCode =
      r.code && /not.found|resource/i.test(r.code)
        ? "session_not_found"
        : r.code;
    return respond(res, httpCode, { ok: false, error: r.error, code: outCode });
  }
  let webuiEntry = null;
  if (createWebuiEntry && ctx && ctx.cs) {
    // 在 webui session db 创建 entry, 让 sidebar 1:1 看到这个 mcode session
    const all = loadSessions();
    const existing = all.find((s) => s.mcodeSessionId === sessionId);
    if (existing) {
      webuiEntry = existing;
    } else {
      const { randomUUID } = await import("node:crypto");
      webuiEntry = {
        id: randomUUID(),
        mcodeSessionId: sessionId,
        title: "Mcode session",
        workspace: cwd || ctx.cs.workspace?.dir || "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        chat: [],
      };
      all.unshift(webuiEntry);
      saveSessions(all);
    }
    // 不自动切到 webui 当前 session (调用方决定)
  }
  if (ctx && ctx.cid) pushStateFor(ctx.cid);
  return respond(res, 200, { ok: true, sessionId, webuiEntry });
}

// ============================================================
// POST /api/protocol/activate-session  { sessionId }
// 切到指定 mcode session
// ============================================================
export async function handleActivateSession(req, res, ctx) {
  const { sessionId } = await readJson(req);
  if (!sessionId)
    return respond(res, 400, { ok: false, error: "sessionId required" });
  const r = await activateSession(sessionId);
  if (!r.ok) {
    // 与 set-mode / set-config-option 对齐: unsupported → 501 (mcode 0.1.5 不支持)
    const httpCode =
      r.code === "unsupported"
        ? 501
        : r.code === "no_client"
          ? 503
          : r.code && /not.found|invalid/i.test(r.code)
            ? 404
            : 500;
    return respond(res, httpCode, { ok: false, error: r.error, code: r.code });
  }
  if (ctx && ctx.cs) {
    ctx.cs.mcodeSessionId = sessionId;
    resetContext(ctx.cs);
  }
  if (ctx && ctx.cid) pushStateFor(ctx.cid);
  return respond(res, 200, {
    ok: true,
    activeSessionId: sessionId,
    data: r.data,
  });
}

// ============================================================
// GET /api/protocol/list-sessions?cwd=...
// 列 mcode session, 供前端 "远控 TUI" UI 用
// ============================================================
export async function handleListSessions(req, res, ctx) {
  const url = new URL(req.url, "http://localhost");
  const cwd = url.searchParams.get("cwd") || ctx?.cs?.workspace?.dir || "";
  const all = await listSessions();
  if (!cwd) return respond(res, 200, { ok: true, sessions: all });
  // 按 cwd 过滤 (norm 路径对齐)
  const norm = (p) =>
    (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const target = norm(cwd);
  const filtered = target ? all.filter((s) => norm(s.cwd) === target) : all;
  return respond(res, 200, { ok: true, sessions: filtered, cwd });
}

// ============================================================
// GET /api/protocol/capabilities
// 列出 mcode acp 实际支持的能力 — 供前端 capability detection,
//   决定按钮是否 disable / 降级路径
// mcode version 动态从 acp client initialize 响应读 (不再 hardcode)
// ============================================================
export async function handleCapabilities(_req, res) {
  const { MCODE_ACP_CAPABILITIES } = await import("../lib/mcode-rpc.js");
  const { getMcodeServerInfo } = await import("../lib/acp-client.js");
  // mcode 0.1.5 acp initialize 返 agentInfo: { name, title, version } (实测, 不是 serverInfo)
  const agentInfo = getMcodeServerInfo();
  const mcodeVersion = (agentInfo && agentInfo.version) || "unknown";
  return respond(res, 200, {
    ok: true,
    mcodeVersion,
    mcodeName: (agentInfo && agentInfo.name) || null,
    mcodeTitle: (agentInfo && agentInfo.title) || null,
    capabilities: MCODE_ACP_CAPABILITIES,
    notes: {
      set_mode:
        'send "/plan <text>" or "/goal <text>" as a regular session/prompt — mcode parses the slash command',
      set_config_option:
        "permission mode is set at mcode startup via --permission flag, not mid-session",
      cancel: "no graceful cancel in mcode 0.1.5; use child.kill() as fallback",
      activate:
        "single-session per acp client; load() a different session to switch",
      fork: "use listSessions() to find a session, then loadSession() to take over",
    },
  });
}
