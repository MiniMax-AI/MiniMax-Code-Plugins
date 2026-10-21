// webui/server/lib/acp-client.js
// ACP client singleton + command/session cache.
// Does NOT replace acp.mjs (which is the JSON-RPC transport).
// Wraps it with caching/lifecycle for webui use.

import { McodeAcpClient } from "../../acp.mjs";
import { DEFAULT_WORKSPACE, MCODE_RUNTIME_DB } from "./config.js";
import { deleteMcodeSessionFromDb } from "./db.js";

// v0.5.bu: 拉 mcode 真实 session 列表（mcode acp session/list 协议）
// 数据源：mcode TUI 自己的 session 存储（不是 webui 的 .webui-sessions.json）
// 按 cwd 过滤（mcode 每个 session 都有 cwd 字段，匹配 cs.workspace.dir 才显示）
let mcodeSessionsCache = { ws: null, sessions: [], fetchedAt: 0 };

// v0.5.bx-19: mcode acp client 单例后台常驻 — 之前每次 getMcodeSessionsForWorkspace cache miss 都
//   new McodeAcpClient + start + list + stop, 切 session 频繁触发, 2-3 个 mcode 子进程并发, CPU 高
//   单例常驻后, 切 session 只走 30s cache hit, 0 spawn
let _mcodeAcpSingleton = null;
let _mcodeAcpInitPromise = null; // 防止并发 init 同一个 client

export async function getMcodeAcpClient() {
  if (_mcodeAcpSingleton && _mcodeAcpSingleton.alive) return _mcodeAcpSingleton;
  if (_mcodeAcpInitPromise) return _mcodeAcpInitPromise;
  _mcodeAcpInitPromise = (async () => {
    const client = new McodeAcpClient({ debug: false });
    try {
      await client.start();
      _mcodeAcpSingleton = client;
      console.log(`[acp] singleton client started pid=${client.pid || "?"}`);
      return client;
    } catch (e) {
      console.warn(`[acp] singleton start failed: ${e.message}`);
      try {
        client.stop();
      } catch {}
      return null;
    } finally {
      _mcodeAcpInitPromise = null;
    }
  })();
  return _mcodeAcpInitPromise;
}

// v0.5.bx-19 (改 #2): 列出所有 mcode session (跨 workspace), 不做 cwd 过滤
//   之前 getMcodeSessionsForWorkspace 内部用同一个 cache, 但 cleanup 需要列所有
//   这函数绕过 cwd 过滤, 走 mcode acp 直接拿 raw 列表
export async function listAllMcodeSessions() {
  const client = await getMcodeAcpClient();
  if (!client) return [];
  try {
    const r = await client.listSessions();
    return r && Array.isArray(r.sessions) ? r.sessions : [];
  } catch (e) {
    console.warn(`[acp] listAllMcodeSessions failed: ${e.message}`);
    if (_mcodeAcpSingleton === client) _mcodeAcpSingleton = null;
    return [];
  }
}

export async function getMcodeSessionsForWorkspace(workspace) {
  const STALE_MS = 30 * 1000; // 30s — 比 commands 的 5min 短，因为 prompt 后要立即刷新
  const now = Date.now();
  if (
    mcodeSessionsCache.ws === workspace &&
    now - mcodeSessionsCache.fetchedAt < STALE_MS
  ) {
    return mcodeSessionsCache.sessions;
  }
  const all = await listAllMcodeSessions();
  // 按 cwd 过滤（normalize path — windows 大小写不敏感 + 去尾斜杠）
  const norm = (p) =>
    (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const target = norm(workspace);
  const filtered = target ? all.filter((s) => norm(s.cwd) === target) : all;
  mcodeSessionsCache = { ws: workspace, sessions: filtered, fetchedAt: now };
  return filtered;
}

// v0.5.bx-31: 同步读 cache, 给 pushStateFor 用 (pushStateFor 是同步, 不能 await getMcodeSessionsForWorkspace)
//   命中: 返 array; miss 或 workspace 不匹配: 返 null (caller 自己决定 fallback [] 或 fire-and-forget 拉)
export function getMcodeSessionsCacheSync(workspace) {
  const now = Date.now();
  if (
    mcodeSessionsCache.ws === workspace &&
    now - mcodeSessionsCache.fetchedAt < 30 * 1000
  ) {
    return mcodeSessionsCache.sessions;
  }
  return null;
}

// v1.0: 过期但同 workspace 的缓存 — 返回过期列表 (宁推旧值不推空);
//   之前 TTL 一过 caller 直接推空占位, 侧栏闪跌十来条再弹回 (删除/广播都触发)
export function getMcodeSessionsStaleSync(workspace) {
  if (mcodeSessionsCache.ws === workspace && mcodeSessionsCache.ws !== null) {
    return mcodeSessionsCache.sessions;
  }
  return null;
}

// v0.5.bx: prompt 完成后用 mcodeSessionId 反查 mcode 真实 title
// 数据源：mcode TUI 自己的 session 存储（不是 webui 的）
// 用途：替换 webui "New session" / 截断首句 → 用 mcode 自动生成的标题
export async function getMcodeSessionTitle(mcodeSessionId) {
  if (!mcodeSessionId) return null;
  const client = await getMcodeAcpClient();
  if (!client) return null;
  try {
    const r = await client.listSessions();
    const all = r && Array.isArray(r.sessions) ? r.sessions : [];
    const hit = all.find((s) => s.sessionId === mcodeSessionId);
    return hit && hit.title ? hit.title : null;
  } catch (e) {
    console.warn(`[acp] getMcodeSessionTitle failed: ${e.message}`);
    if (_mcodeAcpSingleton === client) _mcodeAcpSingleton = null;
    return null;
  }
}

// v0.5.bx-19: 软失效 — 只让 TTL 立即过期, 保留 cached sessions (这样切 session 不阻塞)
export function invalidateMcodeSessionsCache() {
  mcodeSessionsCache = { ...mcodeSessionsCache, fetchedAt: 0 };
}

// v1.0: 硬剔除 — 把指定 sid 从 cached 数组里移除 (删除会话后立即从侧栏消失, 不等 30s TTL)
export function dropMcodeSessionFromCache(sid) {
  if (!sid) return;
  mcodeSessionsCache = {
    ...mcodeSessionsCache,
    sessions: mcodeSessionsCache.sessions.filter((s) => s.sessionId !== sid),
  };
}

// v0.5.bx-19: 进程退出时关掉 singleton mcode acp (避免僵尸)
export function shutdownMcodeAcpSingleton() {
  if (_mcodeAcpSingleton) {
    try {
      _mcodeAcpSingleton.stop();
    } catch {}
    _mcodeAcpSingleton = null;
  }
}

// v0.5.by: 暴露 mcode acp initialize 响应 (含 agentInfo) 给能力探测
//  - 用于 GET /api/protocol/capabilities 返回动态 mcode version (不 hardcode)
//  - 不暴露 _mcodeAcpSingleton 内部,只读 agentInfo
//  - mcode 0.1.5 acp initialize 返 { protocolVersion, agentCapabilities, agentInfo: { name, title, version } }
export function getMcodeServerInfo() {
  if (!_mcodeAcpSingleton || !_mcodeAcpSingleton.capabilities) return null;
  return _mcodeAcpSingleton.capabilities.agentInfo || null;
}

// ============================================================
// v0.5.ak: mcode 真实命令缓存（不套预设）
// 用一个长寿命 McodeAcpClient lazy init 拉 available_commands_update
// /help 读这里，不用 hardcode 列表
// ============================================================
let cachedMcodeCommands = {
  mcode: [],
  webui: [],
  fetchedAt: 0,
  source: "none",
};
export const WEBUI_LOCAL_COMMANDS = [
  { name: "new", desc: "新建会话" },
  { name: "clear", desc: "清空当前对话" },
  { name: "status", desc: "查看状态" },
  { name: "sessions", desc: "最近会话列表" },
  { name: "usage", desc: "套餐用量" },
  { name: "help", desc: "可用命令" },
  { name: "stop", desc: "停止当前任务" },
];
let mcodeCommandsClient = null; // long-lived McodeAcpClient
let mcodeCommandsPromise = null; // 去重 lazy init

export function getCachedMcodeCommands() {
  return cachedMcodeCommands;
}

export async function ensureMcodeCommands({
  forceRefresh = false,
  onRefresh,
} = {}) {
  // v1.0: 5min → 24h — 这个函数靠 newSession 触发 available_commands_update,
  //   而 newSession 是真实持久化的 (db 里留 mvs_ 会话, 侧栏堆积 "Mcode session")。
  //   5min TTL 下每次过期都新建一个; 命令列表只在 mcode 升级时变, 每次进程启动刷一次足够
  const STALE_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedMcodeCommands.mcode.length > 0 &&
    now - cachedMcodeCommands.fetchedAt < STALE_MS
  ) {
    return cachedMcodeCommands;
  }
  // 去重：如果已经在 fetch，复用
  if (mcodeCommandsPromise) return mcodeCommandsPromise;
  mcodeCommandsPromise = (async () => {
    // v1.0: 记下探测会话 sid, 拉完命令后清掉 (否则侧栏每次启动多一个 "Mcode session")
    let probeSid = null;
    try {
      // 关掉旧 client（refresh 时）
      if (mcodeCommandsClient) {
        try {
          mcodeCommandsClient.stop();
        } catch {}
        mcodeCommandsClient = null;
      }
      const client = new McodeAcpClient({ debug: false });
      mcodeCommandsClient = client;
      // v0.5.ak fix: available_commands_update 是在 session/new 之后才发的，不是 initialize 之后
      // 所以要：start → newSession → listen event
      const got = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error("mcode acp available_commands_update timeout 8s")),
          8000,
        );
        client.on("available_commands_update", (u) => {
          // payload 形态待定：{commands: [...]} 或 [...string] 或其他
          const cmds = (u && (u.commands || u.availableCommands || u)) || [];
          const list = Array.isArray(cmds) ? cmds : [];
          clearTimeout(timer);
          resolve(list);
        });
        client
          .start()
          .then(() => client.newSession(DEFAULT_WORKSPACE))
          .then((r) => {
            probeSid = r && r.sessionId ? r.sessionId : null;
          })
          .catch((e) => {
            clearTimeout(timer);
            reject(e);
          });
      });
      const list = await got;
      cachedMcodeCommands = {
        mcode: list,
        webui: WEBUI_LOCAL_COMMANDS,
        fetchedAt: Date.now(),
        source: "mcode.acp.available_commands_update",
      };
      console.log(
        `[webui] cachedMcodeCommands refreshed: ${list.length} mcode commands`,
      );
      if (typeof onRefresh === "function") onRefresh();
      return cachedMcodeCommands;
    } catch (e) {
      console.warn(`[webui] ensureMcodeCommands failed: ${e.message}`);
      cachedMcodeCommands = {
        mcode: [],
        webui: WEBUI_LOCAL_COMMANDS,
        fetchedAt: 0,
        source: `error: ${e.message}`,
      };
      return cachedMcodeCommands;
    } finally {
      mcodeCommandsPromise = null;
      // 关掉 client（保持长寿命的话别 stop，但 mcode acp 闲置 5min 后可能 hang，先关掉按需重启）
      if (mcodeCommandsClient) {
        try {
          mcodeCommandsClient.stop();
        } catch {}
        mcodeCommandsClient = null;
      }
      // v1.0: 清理探测会话 — 探测 client 已 stop (无回写源), 再 SQL 删 + 缓存剔除该 sid。
      //   不整体作废缓存 (会让侧栏闪跌后复原); TTL 自然过期后新子进程重读即可
      if (probeSid) {
        try {
          shutdownMcodeAcpSingleton();
        } catch {}
        try {
          const del = deleteMcodeSessionFromDb(probeSid, { MCODE_RUNTIME_DB });
          console.log(
            `[webui] commands probe session cleaned: ${probeSid.substring(0, 12)}… ok=${del.ok}`,
          );
        } catch {}
        dropMcodeSessionFromCache(probeSid);
      }
    }
  })();
  return mcodeCommandsPromise;
}
