// webui/server/routes/state.js
// GET /api/events (SSE) + GET /api/state

import {
  getClient,
  getCidFromReq,
  pushStateFor,
  pushOnlineCount,
  mcodeSessionsSnapshotFields,
  getSseClient,
  setSseClient,
  endSseClient,
} from "../lib/state-bus.js";
import { loadSessions } from "../lib/sessions.js";
import {
  getMcodeSessionsForWorkspace,
  getCachedMcodeCommands,
} from "../lib/acp-client.js";
import { getLanBroadcast } from "../lib/settings.js";
import { applyMavisUsageToCs } from "../lib/mavis-usage.js";
import { getMcodeModelLimit } from "../lib/models.js";

export async function handleEvents(req, res, ctx) {
  const cid = getCidFromReq(req);
  const cs = getClient(cid);
  // 关掉旧 SSE（避免同一个 cid 有多个挂起连接）
  const old = getSseClient(cid);
  if (old) {
    try {
      old.end();
    } catch {}
  }
  res.writeHead(200, SSE_HEADERS);
  // v1.0: 首推也必须带 mcodeSessions 字段 (之前缺, 侧栏先渲染 webui 本地条目再闪回全量)
  const snapshot = {
    ...cs,
    sessions: loadSessions(),
    ...mcodeSessionsSnapshotFields((cs.workspace && cs.workspace.dir) || ""),
  };
  res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  setSseClient(cid, res);
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {}
  }, 20000);
  req.on("close", () => {
    clearInterval(ping);
    endSseClient(cid, res);
    pushOnlineCount(getLanBroadcast()); // v0.5.ak: 客户端断开时广播在线数
  });
  pushOnlineCount(getLanBroadcast()); // v0.5.ak: 客户端新连接时广播在线数

  // v0.5.bx-29: SSE 连接时主动 hydrate mavis db 真值
  //   修: 之前只在 finalize() 里查 mavis db, 只更新发起 prompt 的那个 cid
  //        其它 CID (比如手机开了同一 session 但没发消息) 永远只看估算
  //   现在: 新 SSE 连接建立时, 如果该 cid 已经绑定了 mcodeSessionId, 立刻查 mavis db
  //         有真值就 pushStateFor 让该 cid 看到真值, 没有就保留估算
  //   fire-and-forget, 不阻塞 SSE 响应
  if (cs.mcodeSessionId) {
    const sid = cs.mcodeSessionId;
    Promise.resolve().then(() => {
      applyMavisUsageToCs(cs, sid, { getMcodeModelLimit })
        .then((applied) => {
          if (applied) pushStateFor(cid);
        })
        .catch(() => {
          /* swallow — keep estimate */
        });
    });
  }
  return true;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export async function handleState(req, res, ctx) {
  const cs = getClient(ctx.cid);
  const mcodeSessions = await getMcodeSessionsForWorkspace(
    cs.workspace && cs.workspace.dir,
  );
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  // v0.5.bx-29: /api/state 也尝试 hydrate mavis db 真值 (best-effort)
  //   SSE 客户端 (EventSource) 也会调这个端点, 所以 hydrate 也能发生在 reconnect 时
  if (cs.mcodeSessionId) {
    try {
      await applyMavisUsageToCs(cs, cs.mcodeSessionId, { getMcodeModelLimit });
    } catch {
      /* keep estimate */
    }
  }
  return res.end(
    JSON.stringify({
      ...cs,
      sessions: loadSessions(),
      mcodeSessions,
      availableCommands: getCachedMcodeCommands(),
      lanBroadcast: getLanBroadcast(),
    }),
  );
}
