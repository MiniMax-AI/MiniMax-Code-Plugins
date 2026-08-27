// webui/server/lib/state-bus.js
// Per-cid state + SSE channel management.

import { DEFAULT_WORKSPACE, DEFAULT_MODEL } from "./config.js";
import { loadSessions } from "./sessions.js";
import {
  getCachedMcodeCommands,
  getMcodeSessionsForWorkspace,
  getMcodeSessionsCacheSync,
  getMcodeSessionsStaleSync,
} from "./acp-client.js";
import {
  getCurrentToken,
  getLanBroadcast,
  getQuotaEnabled,
  getReadOnly,
  getTokenAcknowledged,
  getTokenEnabled,
  getTokenPlanApiKey,
  getTokenPlanApiKeyFilePath,
  getTokenPlanApiKeySource,
  getTokenRotatedAt,
  maskTokenPlanKey,
} from "./settings.js";

// v0.5.ai: A2 per-client 架构
// 每个 webui tab 一个 client (cid = localStorage webui_cid)
// 每个 client 独立：state (chat/mcodeSessionId/context/usage/running), activeChild, SSE connection
// 缺 cid 的请求 fallback 到 'default' client (兼容老 client)

// v0.5.ai: 每个 webui tab 一个独立 state。
export function makeClientState() {
  return {
    version: "1.0", // v1.0: 首次公开发布版本 (顶栏显示 "v" + version)
    workspace: { dir: DEFAULT_WORKSPACE, branch: null, tree: null }, // v0.5.bb: 默认 null（之前是 MCODE_ROOT）
    model: { name: DEFAULT_MODEL, thinking: "On", ctx: "512k" },
    sessionId: null, // webui 侧边栏 session id (randomUUID)
    mcodeSessionId: null, // mcode acp/exec 自己的 session id (mvs_xxx)
    sessionTitle: "Untitled",
    // v0.5.bx-31: "最近 active session 所属工作区" — 独立于 state.workspace.dir
    //   之前切 session 会同步改 state.workspace.dir (v0.5.ar),导致 sidebar 排序时该工作区组永远置顶
    //   现在切 session 改 lastUsedWorkspace,不再动 workspace.dir (chip-workspace 跟它无关)
    lastUsedWorkspace: null,
    context: {
      tokens: 0,
      used: 0,
      percent: 0,
      limit: 512000,
      tps: 0,
      thinkingStatus: "Idle",
      thinkingDuration: null,
      lastUsageAt: null,
    },
    usage: {
      plan: null,
      expires: null,
      credits: null,
      fiveHourPercent: null,
      fiveHourReset: null,
      weekly: null,
      sessionInput: 0,
      sessionOutput: 0,
      sessionTotal: 0,
      raw: null,
      fetchedAt: null,
      error: null,
    },
    permissions: "Full access",
    chat: [],
    sessions: [],
    goal: { active: false, text: null, status: null, duration: null },
    todo: [],
    ask: {
      active: false,
      total: 0,
      answered: 0,
      currentIdx: 0,
      question: "",
      options: [],
    },
    plan: { active: false, title: null, summary: "", options: [] },
    running: {
      active: false,
      prompt: null,
      pid: null,
      startedAt: null,
      model: null,
      sessionId: null,
      lastDeltaAt: null,
      tps: 0,
    },
  };
}

export const clients = new Map(); // cid -> clientState
export const sseByCid = new Map(); // cid -> SSE response
export const activeChildByCid = new Map(); // cid -> child process

export function getClient(cid) {
  if (!cid) cid = "default";
  if (!clients.has(cid)) clients.set(cid, makeClientState());
  return clients.get(cid);
}

export function getCidFromReq(req) {
  try {
    const u = new URL(req.url, "http://x");
    return u.searchParams.get("cid") || "";
  } catch {
    return "";
  }
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

// pushStateFor: 推 state 给指定 cid（或 '__broadcast__' 推给所有）
//   opts.lanBroadcast: 当前 LAN 广播状态（从 settings.js 注入）
//   opts.mcodeSessions: 已过滤的 mcode sessions 数组（从 acp-client.js 注入）
// v0.5.bx-31: cache miss 时 fire-and-forget 拉一次, 拉完自动 push 给所有 SSE 客户端
// v1.0: 推送带 mcodeSessionsPending 标记 — 占位推送 (cache miss 空数组) 为 true, 权威推送为 false;
//   fetch 失败也要推终态 (否则 client 侧栏 ready 门控永远等不到权威值, loading 卡死)
const _mcodeSessionsFetchPending = new Set(); // workspace keys currently being fetched
function ensureMcodeSessionsFetchedAndPush(workspace) {
  if (_mcodeSessionsFetchPending.has(workspace)) return;
  _mcodeSessionsFetchPending.add(workspace);
  const pushAuthoritative = () => {
    for (const [c, res] of sseByCid) {
        const ccs = clients.get(c) || makeClientState();
        const cws = (ccs.workspace && ccs.workspace.dir) || "";
        // v1.0: 权威推送优先 fresh cache, 退而求其次 stale (同 ws 过期列表), 避免空列表闪跌
        const cached =
          getMcodeSessionsCacheSync(cws) ??
          getMcodeSessionsStaleSync(cws) ??
          [];
      const snapshot = {
        ...ccs,
        sessions: loadSessions(),
        mcodeSessions: cached,
        mcodeSessionsPending: false,
        availableCommands: getCachedMcodeCommands(),
        onlineCount: sseByCid.size,
        lanBroadcast: getLanBroadcast(),
        readOnly: getReadOnly(),
        tokenEnabled: getTokenEnabled(),
        // v1.0.1: 下发 currentToken 仅在未 acknowledge 时 (减少密钥暴露窗口)
        currentToken: getTokenAcknowledged() ? "" : getCurrentToken(),
        tokenAcknowledged: getTokenAcknowledged(),
        tokenRotatedAt: getTokenRotatedAt(),
        // v2026-08-28 modacker: Token Plan (套餐用量) feature fields.
        //   Previously these were only synced via the one-shot
        //   /api/settings fetch in loadLanInfo(); the SSE replace-state
        //   pattern (state = JSON.parse(ev.data)) then clobbered them
        //   on the next push, so toggling the switch appeared to do
        //   nothing — the usage button stayed hidden. Including them
        //   in the snapshot makes the client single-source-of-truth
        //   for everything it shows. The masked key never includes
        //   the full Subscription Key, only "sk-cp-...XXXX".
        quotaEnabled: getQuotaEnabled(),
        hasTokenPlanKey: getTokenPlanApiKey().length > 0,
        tokenPlanApiKeyMasked: maskTokenPlanKey(),
        // v2026-08-28 modacker (A+C): external key source surface.
        //   Webui uses this to hide the "delete" button when the
        //   key is managed by env / file (the operator would have
        //   to remove it there, not in the UI).
        tokenPlanApiKeySource: getTokenPlanApiKeySource(),
        tokenPlanApiKeyFilePath: getTokenPlanApiKeyFilePath(),
      };
      try {
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      } catch {}
    }
  };
  getMcodeSessionsForWorkspace(workspace)
    .then(() => {
      _mcodeSessionsFetchPending.delete(workspace);
      pushAuthoritative();
    })
    .catch((e) => {
      _mcodeSessionsFetchPending.delete(workspace);
      console.warn(
        `[webui] ensureMcodeSessionsFetchedAndPush failed: ${e.message}`,
      );
      pushAuthoritative(); // v1.0: 失败也推终态 (用当前 cache 值, 可能是空数组 — 合法)
    });
}

export function pushStateFor(cid, opts = {}) {
  const lanBroadcast =
    opts.lanBroadcast !== undefined ? opts.lanBroadcast : getLanBroadcast();
  const cachedCmds = getCachedMcodeCommands();

  if (cid === "__broadcast__") {
    for (const [c, res] of sseByCid) {
      const ccs = clients.get(c) || makeClientState();
      const cws = (ccs.workspace && ccs.workspace.dir) || "";
      const fields =
        opts.mcodeSessions !== undefined
          ? { mcodeSessions: opts.mcodeSessions, mcodeSessionsPending: false }
          : mcodeSessionsSnapshotFields(cws);
      const snapshot = {
        ...ccs,
        sessions: loadSessions(),
        ...fields,
        availableCommands: cachedCmds,
        onlineCount: sseByCid.size,
        lanBroadcast,
        readOnly: getReadOnly(),
        tokenEnabled: getTokenEnabled(),
        currentToken: getTokenAcknowledged() ? "" : getCurrentToken(),
        tokenAcknowledged: getTokenAcknowledged(),
        tokenRotatedAt: getTokenRotatedAt(),
        // v2026-08-28 modacker: Token Plan (套餐用量) feature fields —
        //   see note on the per-cid-branch snapshot below. Same fields,
        //   same rationale. This is the broadcast path that fires
        //   after /api/settings mutations (and on the second client
        //   connect in the test we just ran), so any push without
        //   these clobbers state.quotaEnabled and re-hides the button.
        quotaEnabled: getQuotaEnabled(),
        hasTokenPlanKey: getTokenPlanApiKey().length > 0,
        tokenPlanApiKeyMasked: maskTokenPlanKey(),
        // v2026-08-28 modacker (A+C): external key source surface.
        //   Webui uses this to hide the "delete" button when the
        //   key is managed by env / file (the operator would have
        //   to remove it there, not in the UI).
        tokenPlanApiKeySource: getTokenPlanApiKeySource(),
        tokenPlanApiKeyFilePath: getTokenPlanApiKeyFilePath(),
      };
      try {
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      } catch {}
    }
    return;
  }
  const cs = getClient(cid);
  // v1.0: 统一走 mcodeSessionsSnapshotFields — 过期缓存推旧值 (pending=true), 不推空占位
  const fields =
    opts.mcodeSessions !== undefined
      ? { mcodeSessions: opts.mcodeSessions, mcodeSessionsPending: false }
      : mcodeSessionsSnapshotFields((cs.workspace && cs.workspace.dir) || "");
  // 注入 sessions 列表（来自磁盘 db）— 让 webui 侧边栏 "最近会话" 不被 SSE 推送覆盖
  // v0.5.bv: 同步带 mcodeSessions（cache 命中，0 cost；cache miss 才 await）
  const snapshot = {
    ...cs,
    sessions: loadSessions(),
    ...fields,
    availableCommands: cachedCmds,
    onlineCount: sseByCid.size,
    lanBroadcast,
    readOnly: getReadOnly(),
    tokenEnabled: getTokenEnabled(),
    currentToken: getTokenAcknowledged() ? "" : getCurrentToken(),
    tokenAcknowledged: getTokenAcknowledged(),
    tokenRotatedAt: getTokenRotatedAt(),
    // v2026-08-28 modacker: Token Plan (套餐用量) feature fields —
    //   see note on the broadcast-branch snapshot above. Same fields,
    //   same rationale. Without these the per-cid SSE push also
    //   clobbers the local `state.quotaEnabled` and the usage button
    //   hides itself right after the user toggles it on.
    quotaEnabled: getQuotaEnabled(),
    hasTokenPlanKey: getTokenPlanApiKey().length > 0,
    tokenPlanApiKeyMasked: maskTokenPlanKey(),
    // v2026-08-28 modacker (A+C): external key source surface — see
    //   the broadcast-branch snapshot above for rationale.
    tokenPlanApiKeySource: getTokenPlanApiKeySource(),
    tokenPlanApiKeyFilePath: getTokenPlanApiKeyFilePath(),
  };
  const payload = JSON.stringify(snapshot);
  const res = sseByCid.get(cid);
  if (res) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {}
  }
}

// v1.0: 统一的 mcodeSessions 快照字段构造 — 所有 SSE 推送点必须带这两个字段。
//   之前 pushOnlineCount / SSE 首推不带, 客户端整包替换 state 后 mcodeSessions 变 undefined,
//   侧栏随机从 ~36 条闪跌到 ~16 条 (只剩 webui 本地条目), 下次完整推送又弹回。
//   v1.0 (改): 缓存过期但同 workspace 时推过期列表 (pending=true), 不再推空占位 —
//   过期值好过空值, 权威值到达前侧栏不闪跌
export function mcodeSessionsSnapshotFields(workspace) {
  const ws = workspace || "";
  const cached = getMcodeSessionsCacheSync(ws);
  if (cached !== null) {
    return { mcodeSessions: cached, mcodeSessionsPending: false };
  }
  ensureMcodeSessionsFetchedAndPush(ws);
  const stale = getMcodeSessionsStaleSync(ws);
  if (stale !== null) {
    return { mcodeSessions: stale, mcodeSessionsPending: true };
  }
  return { mcodeSessions: [], mcodeSessionsPending: true };
}

// v0.5.ak: SSE 客户端数变化时广播（让所有 tab 实时看到 onlineCount）
export function pushOnlineCount(lanBroadcast) {
  const cachedCmds = getCachedMcodeCommands();
  for (const [c, res] of sseByCid) {
    const cs = clients.get(c) || makeClientState();
    const snapshot = {
      ...cs,
      sessions: loadSessions(),
      ...mcodeSessionsSnapshotFields((cs.workspace && cs.workspace.dir) || ""),
      availableCommands: cachedCmds,
      onlineCount: sseByCid.size,
      lanBroadcast,
      readOnly: getReadOnly(),
      tokenEnabled: getTokenEnabled(),
      currentToken: getTokenAcknowledged() ? "" : getCurrentToken(),
      tokenAcknowledged: getTokenAcknowledged(),
      tokenRotatedAt: getTokenRotatedAt(),
      // v2026-08-28 modacker: Token Plan (套餐用量) feature fields —
      //   see pushStateFor above. pushOnlineCount fires on every SSE
      //   client connect/disconnect, so without these the next push
      //   after a tab opens would also clobber quotaEnabled.
      quotaEnabled: getQuotaEnabled(),
      hasTokenPlanKey: getTokenPlanApiKey().length > 0,
      tokenPlanApiKeyMasked: maskTokenPlanKey(),
      // v2026-08-28 modacker (A+C): external key source surface — see
      //   the broadcast-branch snapshot above for rationale.
      tokenPlanApiKeySource: getTokenPlanApiKeySource(),
      tokenPlanApiKeyFilePath: getTokenPlanApiKeyFilePath(),
    };
    try {
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    } catch {}
  }
}

// 把当前 cid 的 child 设为 active（acp client / exec child 都用同一个 map）
export function setActiveChild(cid, child) {
  if (cid) activeChildByCid.set(cid, child);
}

export function getActiveChild(cid) {
  return activeChildByCid.get(cid) || null;
}

export function clearActiveChild(cid) {
  if (cid) activeChildByCid.delete(cid);
}

// v0.5.bx-29: 找出所有绑定了同一个 mcodeSessionId 的 cid
//   用于 mavis db 真值更新后, 通知其它同 session 的 cid (手机 + 电脑开同一 session)
//   返回 [{cid, cs}, ...] 数组
export function getCidsByMcodeSession(mvsSessionId) {
  if (!mvsSessionId) return [];
  const out = [];
  for (const [cid, cs] of clients) {
    if (cs && cs.mcodeSessionId === mvsSessionId) {
      out.push({ cid, cs });
    }
  }
  return out;
}

// SSE channel helpers — only state-bus.js should touch sseByCid directly.
export function getSseClient(cid) {
  return sseByCid.get(cid) || null;
}

export function setSseClient(cid, res) {
  sseByCid.set(cid, res);
}

export function endSseClient(cid, res) {
  // Only clear the map entry if it still points at the same res (avoid races)
  if (sseByCid.get(cid) === res) sseByCid.delete(cid);
}

// v1.0.1: broadcastTokenRotated — push a named SSE event so all
// already-authenticated clients can update their HEADERS + localStorage
// without waiting for the periodic state push. Body is the new token
// (raw string, not JSON, to make it obvious in logs / devtools that
// this is sensitive — never log it).
//
// IMPORTANT: the token is sent in cleartext over the SSE channel. The
// connection is already authenticated (caller must have presented a
// valid token to reach the rotation handler), and SSE is in-band
// with the existing /api/events stream which the client already
// authorized. So this is no worse than the periodic state push that
// also includes currentToken in the same channel.
export function broadcastTokenRotated(token) {
  if (!token) return;
  // SSE custom event format:
  //   event: <name>\n
  //   data: <payload>\n
  //   \n
  const frame = `event: auth.token_rotated\ndata: ${token}\n\n`;
  for (const [, res] of sseByCid) {
    try {
      res.write(frame);
    } catch {}
  }
}
