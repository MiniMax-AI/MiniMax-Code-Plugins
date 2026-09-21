// webui/server/lib/mcode-rpc.js
// v0.5.by: 干净的 mcode acp 协议 RPC wrapper
//
// mcode acp 0.1.5 server 实际支持的方法 (从 probes/probe-mcode-rpc-v2.mjs 实测):
//   ✅ initialize / session/list / session/new / session/load / session/close / session/prompt
//   ❌ session/set_mode / set_config_option / cancel / activate / fork / resume / delete
//      (Method not found — mcode 0.1.5 协议层根本没暴露)
//
// 设计: 调不支持的方法不 throw,返 {ok:false, error, code:'unsupported'}
//   路由层能据此给前端 501 Not Implemented 错,而不是 500 Internal Server Error
//   前端可以降级处理 (比如用 slash command 代替 RPC,或提示用户升级 mcode)

import { getMcodeAcpClient, listAllMcodeSessions } from "./acp-client.js";

function ok(data) {
  return { ok: true, data };
}
// Sanitize mcode 端返的错误 message:
//   - 截断 200 字符 (避免吐一坨 stack 给前端)
//   - 换行/CR 替换成空格 (jsonrpc error message 经常含换行, 会破坏响应 JSON)
//   - 去掉控制字符 (避免 log 注入)
function sanitizeError(e) {
  let msg;
  if (e && typeof e.message === "string") msg = e.message;
  else if (e && typeof e === "string") msg = e;
  else msg = String(e?.message || e);
  msg = msg
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  if (msg.length > 200) msg = msg.slice(0, 200) + "…";
  return msg;
}
function fail(error, code) {
  return { ok: false, error: sanitizeError(error), code: code || "rpc_error" };
}

// mcode 0.1.5 acp 不支持的方法 (实探测得, 2026-08-20)
const UNSUPPORTED = new Set([
  "session/set_mode",
  "session/set_config_option",
  "session/cancel",
  "session/activate",
  "session/fork",
  "session/resume",
  "session/delete",
]);

async function callRpc(method, params) {
  if (UNSUPPORTED.has(method)) {
    return fail(
      `mcode 0.1.5 acp does not implement ${method} (server returns "Method not found")`,
      "unsupported",
    );
  }
  const client = await getMcodeAcpClient();
  if (!client)
    return fail(new Error("mcode acp client unavailable"), "no_client");
  try {
    const r = await client.request(method, params);
    return ok(r);
  } catch (e) {
    if (e && e.data && typeof e.data.code === "string")
      return fail(e, e.data.code);
    return fail(e);
  }
}

// ============================================================
// session/set_mode  — ❌ mcode 0.1.5 不支持
//   webui 想进 plan/goal mode 的实际可行路径: 发送 "/plan <text>" 或 "/goal <text>" 作为普通 prompt
//   mcode 会在 server 端解析 slash command,自动切到对应 mode
// ============================================================
export async function setMode(_sessionId, _mode) {
  return callRpc("session/set_mode", { sessionId: _sessionId, mode: _mode });
}

// ============================================================
// session/set_config_option  — ❌ mcode 0.1.5 不支持
//   webui 想设 permissionMode 的实际可行路径: 启动 mcode 时用 --permission 标志
//   mcode 0.1.5 不支持 mid-stream permission mode 切换
// ============================================================
export async function setConfigOption(_sessionId, _key, _value) {
  return callRpc("session/set_config_option", {
    sessionId: _sessionId,
    key: _key,
    value: _value,
  });
}

// ============================================================
// session/cancel  — ❌ mcode 0.1.5 不支持
//   webui 想取消正在跑 prompt 的唯一路径: 杀 mcode acp 子进程 (SIGKILL)
//   不温和但有效
// ============================================================
export async function cancelSession(_sessionId) {
  return callRpc("session/cancel", { sessionId: _sessionId });
}

// ============================================================
// session/load  — ✅ mcode 0.1.5 支持
//   加载任意 mcode session (含 TUI 跑的)。远控 TUI 的基础能力
// ============================================================
export async function loadSession(sessionId, cwd) {
  if (!sessionId)
    return fail(new Error("sessionId required"), "missing_session");
  const client = await getMcodeAcpClient();
  if (!client)
    return fail(new Error("mcode acp client unavailable"), "no_client");
  try {
    const r = await client.request("session/load", {
      sessionId,
      cwd: cwd || "",
      mcpServers: [],
    });
    return ok(r);
  } catch (e) {
    if (e && e.data && typeof e.data.code === "string")
      return fail(e, e.data.code);
    return fail(e);
  }
}

// ============================================================
// session/activate  — ❌ mcode 0.1.5 不支持
//   单 acp client 一次只能 active 一个 session (cli.js state: activeSessionId 唯一)
//   但 activate 不是 JSON-RPC 公开方法, webui 走 "load 不同 session" 即可切换
// ============================================================
export async function activateSession(_sessionId) {
  return callRpc("session/activate", { sessionId: _sessionId });
}

// ============================================================
// session/close  — ✅ mcode 0.1.5 支持
// ============================================================
export async function closeSession(sessionId) {
  if (!sessionId)
    return fail(new Error("sessionId required"), "missing_session");
  const client = await getMcodeAcpClient();
  if (!client)
    return fail(new Error("mcode acp client unavailable"), "no_client");
  try {
    const r = await client.request("session/close", { sessionId });
    return ok(r);
  } catch (e) {
    if (e && e.data && typeof e.data.code === "string")
      return fail(e, e.data.code);
    return fail(e);
  }
}

// ============================================================
// session/list  — ✅ mcode 0.1.5 支持
//   简单 wrap for route 层
// ============================================================
export async function listSessions() {
  return listAllMcodeSessions();
}

// ============================================================
// mcode 0.1.5 acp 接受的能力清单 (供前端 capability detection)
// ============================================================
export const MCODE_ACP_CAPABILITIES = {
  set_mode: false,
  set_config_option: false,
  cancel: false,
  activate: false,
  fork: false,
  resume: false,
  delete: false,
  load: true,
  close: true,
  list: true,
  new: true,
  prompt: true,
};

// 权限 mode 合法值 — cli.js 0.1.5 配置 schema 里有这 6 个, 但 session/set_config_option
// 调不通, 所以这些值暂时只能用 mcode 启动 --permission 标志传, 不能 mid-session 改
export const PERMISSION_MODES = [
  "default",
  "bypassPermissions",
  "auto",
  "off",
  "read",
  "full",
];

// webui UI label → mcode 配置值 (仅供参考, mid-session 切换不可用)
const WEBUI_TO_MCODE_PERMISSION = {
  ask: "default",
  full: "bypassPermissions",
  auto: "auto",
  read: "read",
  default: "default",
  bypassPermissions: "bypassPermissions",
  off: "off",
};
export function webuiPermissionToMcode(webuiMode) {
  return WEBUI_TO_MCODE_PERMISSION[webuiMode] || null;
}

const MCODE_TO_WEBUI_PERMISSION = {
  default: "Ask",
  bypassPermissions: "Full access",
  auto: "Auto",
  off: "Off",
  read: "Read",
  full: "Full access",
};
export function mcodePermissionToWebui(mcodeMode) {
  return MCODE_TO_WEBUI_PERMISSION[mcodeMode] || mcodeMode || "Full access";
}
