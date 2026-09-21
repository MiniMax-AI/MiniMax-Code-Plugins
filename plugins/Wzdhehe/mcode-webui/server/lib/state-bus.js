// webui/server/lib/state-bus.js
// Per-cid state + SSE channel management.

import { DEFAULT_WORKSPACE, DEFAULT_MODEL } from "./config.js";
import { isFirstRun } from "./auth.js";
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

// v2.0 (lease B02): pushAlert re-export — chokepoint-friendly alias.
//   Routes that need to surface a system signal (chat errors,
//   subprocess crash, token expiry, etc.) call this rather than
//   importing alerts.js directly. The chokepoint pattern (only
//   state-bus touches per-cid state) extends naturally: only
//   state-bus touches the alert bus too. alerts.js remains the
//   pure module; state-bus is the wire.
export { pushAlert } from "./alerts.js";

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
      // v2 (Lease C04): route through 60Hz coalescer — multiple authoritative
      // pushes within STATE_PUSH_THROTTLE_MS collapse to one write per cid.
      _schedulePush(c, JSON.stringify(snapshot), res);
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
      // v2 (Lease C04): coalesced write — N broadcasts within the throttle
      // window collapse to ONE write per cid (last call's snapshot wins).
      _schedulePush(c, JSON.stringify(snapshot), res);
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
  // v2 (Lease C04): 60Hz coalescing — multiple pushStateFor() calls for
  // the same cid within STATE_PUSH_THROTTLE_MS collapse to ONE SSE write.
  // Diff mode: if the payload is byte-identical to the last write, the
  // client receives nothing (no full-state replace, no DOM thrash).
  _schedulePush(cid, payload, res);
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

// ============================================================
// v2 (Lease C04) — 60Hz SSE coalescing + diff mode
//
// What this adds:
//   - _schedulePush(cid, payloadStr, res): routes an SSE write through
//     a per-cid diff gate. The diff gate compares the incoming payload
//     against the last written payload for this cid (byte-identical
//     JSON). If identical, the write is suppressed — no full-state
//     JSON goes out, the client doesn't render() against identical
//     bytes, no DOM thrash. This is the "diff 模式 — 不复位整个 state"
//     half of the lease spec.
//   - 60Hz coalescing: when STATE_PUSH_THROTTLE_MS > 0, the diff gate
//     is gated by a time window as well. Subsequent pushes within the
//     window are stored as "pending" — when the window expires, the
//     LAST pending payload is written (last-call-wins). The first push
//     in any window writes synchronously (preserves the existing
//     sync-write contract that callers like runUsageQuery rely on).
//     The 16ms default targets 60Hz, matching common display refresh
//     rates so the client render loop never starves.
//   - STATE_PUSH_THROTTLE_MS env var: configurable throttle window.
//     Default 16ms per lease spec. Set to 0 to disable the time-based
//     throttle (every push writes synchronously — useful for tests
//     that depend on the pre-coalescer contract, and for low-latency
//     debugging). The diff gate is always active regardless.
//   - resetCoalesceState() / flushPendingPushes() / peekLastPushed() /
//     peekLastWriteTs(): test escape hatches.
//
// What this does NOT change:
//   - Named SSE events (auth.token_rotated / token.first_run /
//     needs_authorization / authorization_decided) keep their
//     immediate-write path. They're low-frequency and benefit from
//     minimum latency. Coalescing is only applied to the `state`
//     stream (the full snapshot replacement path).
//   - Wire format: client still receives full state, not diffs. The
//     diff check is purely a "should I emit this byte?" decision; the
//     payload structure is unchanged. This keeps state.js#connect()
//     compatible without touching the client.
// ============================================================

export const STATE_PUSH_THROTTLE_MS = Math.max(
    0,
    Number(process.env.STATE_PUSH_THROTTLE_MS) || 0,
);

// cid -> { payloadStr, res, timer? }
//   - payloadStr: pending JSON payload (last-call-wins within window)
//   - res: SSE response object to write to
//   - timer: setTimeout to flush pending when window expires (absent if
//            the pending is being flushed right now)
const _pendingByCid = new Map();
// cid -> setTimeout handle for the pending flush
const _flushTimers = new Map();
// cid -> millisecond timestamp of the last successful write
const _lastWriteTsByCid = new Map();
// cid -> JSON string of the last payload that was successfully written
const _lastPushedByCid = new Map();
// cid -> res reference of the last successful write. Used to detect
//   "this cid got a fresh SSE response (re-connect / test reset)"
//   — when the res changes, we MUST write unconditionally regardless
//   of throttle/diff state. Tests that do `sseByCid.set(cid, fakeSse())`
//   directly create a new fakeSse each time, so this naturally resets.
const _lastPushedResByCid = new Map();

function _writeNow(cid, payloadStr, res) {
    _lastWriteTsByCid.set(cid, Date.now());
    _lastPushedByCid.set(cid, payloadStr);
    _lastPushedResByCid.set(cid, res);
    try {
        res.write(`data: ${payloadStr}\n\n`);
    } catch {}
}

function _schedulePush(cid, payloadStr, res) {
    if (!res) return; // no client to write to (cid without SSE)

    // Fresh-client detection: if the cid's stored res differs from
    // the current res, treat as a brand-new SSE connection. The
    // previous writes went to a different res (or no res at all if
    // this is the first connection), so the diff cache must be
    // discarded — otherwise the new client would silently miss its
    // very first state. Tests that re-bind a cid's res between cases
    // hit this branch automatically.
    const cachedRes = _lastPushedResByCid.get(cid);
    if (cachedRes !== res) {
        // Drop any pending push + timer for this cid — they're stale
        // (would go to the wrong res or never get scheduled right).
        const oldTimer = _flushTimers.get(cid);
        if (oldTimer) {
            try {
                clearTimeout(oldTimer);
            } catch {}
            _flushTimers.delete(cid);
        }
        _pendingByCid.delete(cid);
        _lastWriteTsByCid.delete(cid);
        _lastPushedByCid.delete(cid);
        // Write immediately, unconditionally. This restores the
        // pre-coalescer sync-write contract: after pushStateFor(cid)
        // returns, the data is on the wire to the (new) client.
        _writeNow(cid, payloadStr, res);
        return;
    }

    // Diff: skip the write if the payload is byte-identical to the
    // last successful write for this cid. This is the "不复位整个 state"
    // half of the lease spec — the client doesn't receive a redundant
    // full-state replace that would force a render() + DOM rebuild.
    if (_lastPushedByCid.get(cid) === payloadStr) return;

    // Throttle disabled (env = 0) — write synchronously every push.
    if (STATE_PUSH_THROTTLE_MS <= 0) {
        _writeNow(cid, payloadStr, res);
        return;
    }

    const now = Date.now();
    const lastTs = _lastWriteTsByCid.get(cid) || 0;
    const elapsed = now - lastTs;
    if (elapsed >= STATE_PUSH_THROTTLE_MS) {
        // Outside throttle window — write immediately (preserves
        // the original sync-write contract for the first push in any
        // new window). Calls like runUsageQuery depend on the write
        // being observable to the client by the time the call returns.
        _writeNow(cid, payloadStr, res);
        return;
    }
    // Inside throttle window — store as pending. Last call within
    // the window wins; the timer's flush emits the freshest payload.
    _pendingByCid.set(cid, { payloadStr, res });
    if (!_flushTimers.has(cid)) {
        const delay = STATE_PUSH_THROTTLE_MS - elapsed;
        const timer = setTimeout(() => _flushPending(cid), delay);
        if (typeof timer.unref === "function") timer.unref();
        _flushTimers.set(cid, timer);
    }
}

function _flushPending(cid) {
    _flushTimers.delete(cid);
    const pending = _pendingByCid.get(cid);
    if (!pending) return;
    _pendingByCid.delete(cid);
    // Re-check diff in case the timer fired late (another write
    // happened in the meantime and already wrote this payload).
    if (_lastPushedByCid.get(cid) === pending.payloadStr) return;
    // Re-check res in case the client disconnected/reconnected.
    if (_lastPushedResByCid.get(cid) !== pending.res) return;
    _writeNow(cid, pending.payloadStr, pending.res);
}

// Test-only: clear pending timers + diff cache + last-write timestamps.
// Production code never calls this — production throttles stay "live"
// for the process lifetime. Exported so test/lib-state-bus.test.js can
// deterministically reset between cases.
export function resetCoalesceState() {
    for (const [, timer] of _flushTimers) {
        try {
            clearTimeout(timer);
        } catch {}
    }
    _flushTimers.clear();
    _pendingByCid.clear();
    _lastWriteTsByCid.clear();
    _lastPushedByCid.clear();
    _lastPushedResByCid.clear();
}

// Test-only: force-flush all pending pushes immediately (without
// waiting for the throttle window to expire). Returns the number of
// cids flushed. Used in test/lib-state-bus.test.js to assert "within
// a coalesce window, exactly N writes went out" without dealing with
// real timer timing.
export function flushPendingPushes() {
    const cids = Array.from(_pendingByCid.keys());
    for (const cid of cids) _flushPending(cid);
    return cids.length;
}

// Test-only: peek at the last-written payload for cid. Used to assert
// "after coalescing, this cid's wire frame contains this data".
export function peekLastPushed(cid) {
    return _lastPushedByCid.get(cid);
}

// Test-only: peek at the last-write timestamp for cid. Used to assert
// throttle-window arithmetic.
export function peekLastWriteTs(cid) {
    return _lastWriteTsByCid.get(cid);
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
    // v2 (Lease C04): coalesced write — multiple pushOnlineCount() calls
    // within the throttle window collapse to ONE write per cid.
    _schedulePush(c, JSON.stringify(snapshot), res);
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
  // v2 (Lease C04): when an SSE client (re)connects, the previous
  // diff cache + throttle timestamps are stale — the new client
  // hasn't seen the prior writes, so "diff against last push" is
  // wrong (would skip the very first push this client should receive).
  // Reset coalesce state for this cid so the next pushStateFor emits
  // the full snapshot unconditionally.
  const timer = _flushTimers.get(cid);
  if (timer) {
    try {
      clearTimeout(timer);
    } catch {}
    _flushTimers.delete(cid);
  }
  _pendingByCid.delete(cid);
  _lastWriteTsByCid.delete(cid);
  _lastPushedByCid.delete(cid);
}

export function endSseClient(cid, res) {
  // Only clear the map entry if it still points at the same res (avoid races)
  if (sseByCid.get(cid) === res) sseByCid.delete(cid);
  // v2 (Lease C04): drop the coalesce state for this cid too — the
  // client disconnected, no point in keeping pending pushes around
  // (they'd flush to a dead res anyway and the `try/catch` would
  // silently swallow it). Cleanup keeps the map bounded for long-lived
  // processes that see many transient clients.
  const timer = _flushTimers.get(cid);
  if (timer) {
    try {
      clearTimeout(timer);
    } catch {}
    _flushTimers.delete(cid);
  }
  _pendingByCid.delete(cid);
  _lastWriteTsByCid.delete(cid);
  _lastPushedByCid.delete(cid);
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

// v2 (Lease C08) — pushTokenFirstRun
//
// Fires the `token.first_run` SSE event exactly once per process
// lifetime. server.js calls this from inside `initSettings({printToken})`
// when settings.js has just generated a fresh token (no settings.json
// on disk + no TOKEN env). The UI listens for this event and pops the
// onboarding modal — keeping the raw token off stdout (shell history,
// Docker logs, systemd journal, screen shares).
//
// Rotation uses the existing `auth.token_rotated` event above — we
// don't re-fire `token.first_run` after the first boot, even if the
// token is rotated before the operator clicked acknowledge. See
// ANTI-PATTERNS-FIX-PLAN §AP1 for the security rationale.
//
// `isFirstRun()` (auth.js) is the re-send guard. Once the client
// closes the modal and POSTs `/api/settings {acknowledgeToken: true}`,
// auth.js#markFirstRunNotified flips the guard so a second boot that
// loads the same persisted token will NOT re-fire.
export function pushTokenFirstRun({ token, persistPath }) {
  if (!isFirstRun()) return; // one-shot: never re-fire after first push
  if (typeof token !== "string" || !token) return;
  const payload = JSON.stringify({
    token,
    persistPath: typeof persistPath === "string" ? persistPath : "",
    ts: Date.now(),
  });
  const frame = `event: token.first_run\ndata: ${payload}\n\n`;
  for (const [, res] of sseByCid) {
    try {
      res.write(frame);
    } catch {}
  }
}

// ============================================================
// v2 (Lease B03) — Per-request authorization SSE channel
//
// authorize.js (server/lib/authorize.js) gates destructive actions
// behind a user-confirmation modal. The frontend listens for
// `needs_authorization` events on its /api/events stream and pops a
// confirmation; the user accepts or declines and the server resolves
// the pending request via POST /api/auth/decision.
//
// pushAuthRequest — fire a `needs_authorization` SSE frame to the
// target cid (or every connected client if cid is empty). Body is the
// pending request payload {requestId, action, ctx, expiresAt}.
//
// pushAuthDecision — broadcast the resolution so other tabs /
// listeners (e.g. devtools, audit dashboards) can mirror the modal
// state. Body is {requestId, approved, decidedBy}.
//
// The SSE channel is the SAME /api/events stream the client already
// opened — no new connection needed. The frame is a named SSE event
// so it won't be confused with `state`/`chat`/`delta` payloads.
// ============================================================

function _writeAuthFrame(targetCid, frame) {
  if (targetCid) {
    const res = sseByCid.get(targetCid);
    if (res) {
      try {
        res.write(frame);
      } catch {}
    }
    return;
  }
  // broadcast (empty / undefined targetCid)
  for (const [, res] of sseByCid) {
    try {
      res.write(frame);
    } catch {}
  }
}

export function pushAuthRequest({ requestId, action, ctx, expiresAt }) {
  if (!requestId || !action) return;
  const payload = JSON.stringify({
    requestId: String(requestId).slice(0, 128),
    action: String(action).slice(0, 64),
    ctx: ctx && typeof ctx === "object" ? ctx : {},
    expiresAt: Number(expiresAt) || 0,
  });
  const frame = `event: needs_authorization\ndata: ${payload}\n\n`;
  const targetCid = ctx && typeof ctx.cid === "string" ? ctx.cid : "";
  _writeAuthFrame(targetCid, frame);
}

export function pushAuthDecision({ requestId, approved, decidedBy }) {
  if (!requestId) return;
  const payload = JSON.stringify({
    requestId: String(requestId).slice(0, 128),
    approved: !!approved,
    decidedBy: decidedBy ? String(decidedBy).slice(0, 32) : "user",
  });
  const frame = `event: authorization_decided\ndata: ${payload}\n\n`;
  // broadcast — every connected tab should mirror modal close
  _writeAuthFrame("", frame);
}
