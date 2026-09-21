// webui/server/routes/sessions.js
// GET/POST /api/sessions, POST /api/sessions/switch, DELETE /api/sessions/:id,
// GET /api/acp-sessions, GET /api/acp-session-title,
// GET /api/sessions/search (Lease C05 — cross-workspace fuzzy match)
// (v0.5.bx-33: 删 POST /api/sessions/cleanup-orphans — Wzdhehe 不要这个 UI,API 一起删)

import { randomUUID } from "node:crypto";
import { loadSessions, saveSessions, resetContext } from "../lib/sessions.js";
import { deleteMcodeSessionFromDb } from "../lib/db.js";
import {
  getMcodeSessionTitle,
  getMcodeSessionsForWorkspace,
  getMcodeSessionsCacheSync,
  getMcodeSessionsStaleSync,
  shutdownMcodeAcpSingleton,
  dropMcodeSessionFromCache,
} from "../lib/acp-client.js";
// v2 (2026-09-20 webui-manual-audit): switch-path transcript backfill —
// load mcode session history from the runtime DB so switching to an mvs_
// session with no webui wrapper shows real chat instead of "No messages yet".
import { loadTranscriptChatLines } from "../lib/transcript.js";
import { applyMavisUsageToCs } from "../lib/mavis-usage.js";
import { getMcodeModelLimit } from "../lib/models.js";
import { pushStateFor, clients } from "../lib/state-bus.js";
import { MCODE_RUNTIME_DB } from "../lib/config.js";
import { authorize } from "../lib/authorize.js";
import { pushAlert } from "../lib/alerts.js";
// B01: append session lifecycle events to the hash chain.
import { append as _eventsAppend } from "../lib/events.js";

// _auditFail — shared failure sink for audit writes (fail-closed,
// 2026-09-20 rigor fix). events.js#append THROWS on write failure; a
// governance action must not complete with a missing audit trail, so
// every route-level append is wrapped and lands here: HTTP 5xx + one
// alert on the anomaly channel. `what` names the flow for the operator.
function _auditFail(res, e, what) {
  try {
    pushAlert({
      level: "error",
      msg: `audit write failed (${what}): ${e && e.message ? e.message : String(e)}`,
      src: "sessions",
    });
  } catch {}
  console.error(`[webui] audit write failed (${what}):`, e);
  if (res && !res.headersSent) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: false,
      error: "audit write failed",
      detail: what,
    }));
  }
  return undefined;
}

// v1.0: 防"删了又出现" — webui 常驻的 mcode acp 子进程内存里还持有该 session,
//   且会把注册表回写 db (删除后 local_runtime_sessions 行被重建 + session/list 仍返回)。
//   真删前必须: 1) 杀掉常驻子进程 (停掉回写源)  2) 再 SQL 删  3) 从推送缓存只剔除该 sid。
//   v1.0 (改): 不再整体作废缓存 — 之前 invalidate 后紧跟的推送带空占位 mcodeSessions,
//   侧栏从 42 条闪跌到 16 条 (只剩 webui 本地条目), 几秒后重拉又回 42, 像"删了又回来"。
//   现在: 缓存剔除该 sid 后仍视为新鲜, 即时推送带 41 条; TTL 自然过期后新子进程重读 db, 依旧 41。
function killMcodeSessionResurrection(mcodeSid) {
  try {
    shutdownMcodeAcpSingleton();
  } catch {}
  dropMcodeSessionFromCache(mcodeSid);
}

// 读 body helper
async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
}

// v2 (2026-09-20 webui-manual-audit): title fast path — resolve an mvs_
// session's title from the in-memory walked-session cache (the same cache
// behind GET /api/acp-sessions via getMcodeSessionsForWorkspace) BEFORE
// ever awaiting getMcodeSessionTitle. The fallback boots the ACP child;
// with a missing/broken mcode binary that measured ~2.17s end-to-end AND
// degraded the title to the "Mcode session" placeholder even though the
// cache already held the real title. Cache getters are sync and spawn
// nothing, so a hit keeps the switch hot path at zero ACP cost.
//
// Cross-workspace matching within what the module exposes: the cache holds
// ONE workspace's list, keyed by ws. We probe the client's current ws with
// both the fresh (30s TTL) and stale (same-ws, TTL-expired) readers, plus
// the "" key — getMcodeSessionsForWorkspace("") caches the UNFILTERED list,
// so a cache walked without a workspace still answers. A miss returns null
// and the caller falls back to getMcodeSessionTitle (original behavior).
function _lookupCachedMcodeTitle(mcodeSessionId, ws) {
  if (!mcodeSessionId) return null;
  const keys = [ws || "", ""];
  for (const wsKey of keys) {
    for (const getter of [getMcodeSessionsCacheSync, getMcodeSessionsStaleSync]) {
      let sessions = null;
      try {
        sessions = getter(wsKey);
      } catch {
        sessions = null;
      }
      if (!Array.isArray(sessions)) continue;
      const hit = sessions.find(
        (s) => s && s.sessionId === mcodeSessionId && s.title,
      );
      if (hit && hit.title) return hit.title;
    }
  }
  return null;
}

// GET /api/sessions — list
export function handleListSessions(_req, res) {
  const all = loadSessions();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ok: true, sessions: all }));
}

// POST /api/sessions — new (accepts body.workspace)
export async function handleNewSession(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  const all = loadSessions();
  const id = randomUUID();
  // v0.5.ar: 记录 session 所属工作区
  // v0.5.bl: DEFAULT_WORKSPACE 可能是 null — fallback 到空串
  const rawWs =
    payload.workspace || (cs && cs.workspace && cs.workspace.dir) || "";
  const sessionWs = (rawWs || "").trim();
  const item = {
    id,
    title: "New session",
    workspace: sessionWs,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chat: [],
  };
  all.unshift(item);
  saveSessions(all);
  // v0.5.ar: 如果指定了不同的工作区，先切 cs.workspace.dir
  if (cs.workspace.dir !== sessionWs) {
    cs.workspace = { dir: sessionWs, branch: null, tree: null };
  }
  cs.sessionId = id;
  cs.mcodeSessionId = null; // 新建 webui session 同时开新 mcode 上下文
  cs.sessionTitle = item.title;
  cs.chat = [];
  cs.usage = {
    ...cs.usage,
    sessionInput: 0,
    sessionOutput: 0,
    sessionTotal: 0,
  };
  resetContext(cs);
  // B01: session creation is a state-changing action; record it.
  // We log the webui session id + title + workspace — these are not
  // sensitive (the id is a randomUUID, title is user-visible). mcode
  // session id is null at create time so it's omitted from data.
  // Fail-closed: if the audit write fails we 5xx instead of claiming
  // success with an unaudited mutation (no rollback — the JSON store
  // write already happened; the alert carries the mismatch).
  try {
    _eventsAppend("session.create", {
      target: id,
      cid,
      actor: "user",
      payload: {
        title: item.title,
        workspace: sessionWs,
      },
    });
  } catch (e) {
    return _auditFail(res, e, "session.create");
  }
  pushStateFor(cid);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ok: true, session: item }));
}

// POST /api/sessions/switch — switch to session by webui id or mvs_xxx
export async function handleSwitchSession(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  const id = (payload.id || "").trim();
  if (!id) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "id required" }));
  }
  const all = loadSessions();
  console.log(
    `[switch] cid=${cid} incoming id=${id.substring(0, 12)}… isMcodeSid=${/^mvs_[a-f0-9]{32}$/.test(id)} allTotal=${all.length}`,
  );
  // 优先按 mcode session id 找（v0.5.bv: 1:1 关联）
  let target = all.find((s) => s.mcodeSessionId === id);
  let matchKind = target ? "mcodeSessionId" : null;
  if (!target) {
    target = all.find((s) => s.id === id);
    if (target) matchKind = "webuiId";
  }
  console.log(
    `[switch] cid=${cid} match=${matchKind || "NONE"} target.id=${target ? target.id.substring(0, 8) : "null"}… target.mcodeSid=${target && target.mcodeSessionId ? target.mcodeSessionId.substring(0, 12) : "null"}… target.chatLen=${target ? (target.chat ? target.chat.length : 0) : 0} target.title="${target ? (target.title || "").substring(0, 30) : ""}"`,
  );
  if (!target) {
    const isMcodeSid = /^mvs_[a-f0-9]{32}$/.test(id);
    if (isMcodeSid) {
      // v2 (2026-09-20 webui-manual-audit): cache-first title — the walked
      // session cache usually already holds the real title (the sidebar just
      // rendered it). Only a total cache miss pays the getMcodeSessionTitle
      // cost, which boots the ACP child (~2.17s measured with a broken
      // mcode binary) and used to degrade every first switch to the
      // "Mcode session" placeholder.
      const ws = (cs.workspace && cs.workspace.dir) || "";
      let title = _lookupCachedMcodeTitle(id, ws);
      let titleSource = title ? "cache" : "acp";
      if (!title) {
        title = (await getMcodeSessionTitle(id)) || "Mcode session";
      }
      target = {
        id: randomUUID(),
        mcodeSessionId: id,
        title,
        workspace: ws,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        chat: [],
      };
      all.unshift(target);
      saveSessions(all);
      console.log(
        `[switch] cid=${cid} created new webui session ${target.id.substring(0, 8)}… for mcode ${id.substring(0, 12)}… title="${title}" titleSource=${titleSource}`,
      );
    } else {
      console.log(
        `[switch] cid=${cid} 404 id=${id} not found and not mcode sid`,
      );
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "session not found" }));
    }
  } else if (
    // v2 (2026-09-20 webui-manual-audit): placeholder refresh — wrappers
    // created by the branch above during the broken-title era carry the
    // "Mcode session" placeholder forever. If the walked cache now has the
    // real title, repair the stored wrapper. Cache-only (sync, no ACP
    // boot): an existing wrapper must never make the hot path slower.
    target.title === "Mcode session" &&
    target.mcodeSessionId &&
    /^mvs_[a-f0-9]{32}$/.test(target.mcodeSessionId)
  ) {
    const cachedTitle = _lookupCachedMcodeTitle(
      target.mcodeSessionId,
      (cs.workspace && cs.workspace.dir) || "",
    );
    if (cachedTitle) {
      target.title = cachedTitle;
      target.updatedAt = Date.now();
      saveSessions(all);
      console.log(
        `[switch] cid=${cid} refreshed placeholder title for ${target.id.substring(0, 8)}… → "${cachedTitle}"`,
      );
    }
  }
  // v2 (2026-09-20 webui-manual-audit): transcript backfill — when the
  // resolved target has NO webui chat yet but IS a real mvs_ session, load
  // the mcode transcript from the runtime DB (read-only) and map it into
  // the webui chat-line grammar BEFORE responding, so response session.chat
  // and cs.chat carry history. Caps inside (last 400 lines / 200KB) keep
  // the SSE state push bounded; a 1000+-message session must not balloon
  // it. FAILURE MUST NOT BREAK SWITCHING: any error logs and continues
  // with chat: [] — the switch itself always succeeds.
  if (
    target.mcodeSessionId &&
    /^mvs_[a-f0-9]{32}$/.test(target.mcodeSessionId) &&
    (!Array.isArray(target.chat) || target.chat.length === 0)
  ) {
    try {
      const r = loadTranscriptChatLines(target.mcodeSessionId, {
        dbPath: MCODE_RUNTIME_DB,
      });
      if (r.ok && r.lines.length > 0) {
        target.chat = r.lines;
        target.updatedAt = Date.now();
        saveSessions(all); // persist the populated wrapper (updatedAt bumped)
        console.log(
          `[switch] cid=${cid} transcript backfill ${target.id.substring(0, 8)}… mcode=${target.mcodeSessionId.substring(0, 12)}… lines=${r.lines.length} msgs=${r.messageCount} probe=${r.probe}${r.truncated ? " (capped)" : ""}`,
        );
      } else if (!r.ok) {
        console.log(
          `[switch] cid=${cid} transcript unavailable for ${target.mcodeSessionId.substring(0, 12)}… reason=${r.reason || "unknown"}`,
        );
      }
    } catch (e) {
      console.warn(
        `[switch] cid=${cid} transcript backfill failed for ${target.mcodeSessionId.substring(0, 12)}… (continuing with empty chat):`,
        e && e.message ? e.message : e,
      );
    }
  }
  const prevSid = cs.sessionId;
  cs.sessionId = target.id;
  cs.mcodeSessionId = target.mcodeSessionId || null; // 切到有 mcodeSessionId 的就绑上
  cs.sessionTitle = target.title || "Untitled";
  cs.chat = Array.isArray(target.chat) ? target.chat : [];
  cs.usage = {
    ...cs.usage,
    sessionInput: 0,
    sessionOutput: 0,
    sessionTotal: 0,
  };
  // v0.5.bx-31: 切 session 不再同步 cs.workspace.dir (回退 v0.5.ar)
  //   之前: 切到 b 工作区的 session → cs.workspace.dir 改成 b → sidebar 排序 currentWs=b → b 工作区组永远置顶
  //   现在: 只写 lastUsedWorkspace 字段,state.workspace.dir 保持不变 (chip-workspace 跟它无关,workspace 切换走专门路径)
  //   排序: client renderSessions 用 lastUsedWorkspace 作 currentWs,子分类按 updatedAt 排序
  //
  // v0.5.bx-32: 切 session 不再写 lastUsedWorkspace
  //   Wzdhehe 反馈: '点击 c 区任意对话 (不发消息),c 区就自动置顶了,我想的是发消息才置顶'
  //   切 session 只是浏览,不算'发消息',所以 lastUsedWorkspace 只在 send prompt 时写
  //   之前的逻辑导致用户点哪个工作区的对话,那个工作区就置顶 — 体验不对
  //
  // const targetWs = (target.workspace || '').trim()
  // cs.lastUsedWorkspace = targetWs || null   // 删: 切 session 不写
  resetContext(cs);
  // v0.5.bx-10: 切到历史 session 时立即从 mavis db 拉真实 token usage
  if (cs.mcodeSessionId) {
    const switchedSid = cs.mcodeSessionId;
    applyMavisUsageToCs(cs, switchedSid, { getMcodeModelLimit })
      .then(() => pushStateFor(cid))
      .catch((e) => {
        if (process.env.MCODE_USAGE_DEBUG)
          console.warn(`[switch.mavis] cid=${cid} error: ${e.message}`);
      });
  }
  // B01: session switch — record which session was activated and from
  // which prior session. matchKind tells us whether we matched by
  // mcodeSessionId or webuiId (useful when debugging "why did this
  // resolve to session X"). prevSid is the prior session id (or "" if
  // this was the first switch). Fail-closed → 5xx + alert.
  try {
    _eventsAppend("session.switch", {
      target: cs.sessionId,
      cid,
      actor: "user",
      payload: {
        from: prevSid || "",
        matchKind: matchKind || "new_from_mcode",
        mcodeSessionId: cs.mcodeSessionId || "",
        title: cs.sessionTitle,
      },
    });
  } catch (e) {
    return _auditFail(res, e, "session.switch");
  }
  pushStateFor(cid);
  console.log(
    `[switch] cid=${cid} OK prev.sessionId=${prevSid ? prevSid.substring(0, 8) : "null"}… → new.sessionId=${cs.sessionId.substring(0, 8)}… title="${cs.sessionTitle}" chatLen=${cs.chat.length}`,
  );
  res.writeHead(200, { "Content-Type": "application/json" });
  return res.end(
    JSON.stringify({
      ok: true,
      session: {
        id: target.id,
        mcodeSessionId: cs.mcodeSessionId,
        title: cs.sessionTitle,
        chat: cs.chat,
      },
    }),
  );
}

// DELETE /api/sessions/:id — 删一个 session
// v0.5.bx 系列:支持 ?dryRun=true 走预览路径 (mcode-plugin-guide red-lines.md §"写操作/破坏性操作")
//   dryRun=true 时,函数走 readonly SQL 路径,只统计每个表的行数,不修改任何数据
//   行为:true 删除路径不变
//   v2 (B03): real-delete path is async because it awaits authorize()
export async function handleDeleteSession(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const id = ctx.pathname.slice("/api/sessions/".length);
  if (!id) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "id required" }));
  }
  // Parse ?dryRun=true|false from req.url
  let dryRun = false;
  try {
    const qIdx = (req.url || "").indexOf("?");
    if (qIdx >= 0) {
      const params = new URLSearchParams(req.url.slice(qIdx + 1));
      dryRun = params.get("dryRun") === "true";
    }
  } catch {}
  console.log(
    `[delete] cid=${cid} incoming id=${id.substring(0, 12)}… isMcodeSid=${/^mvs_[a-f0-9]{32}$/.test(id)} dryRun=${dryRun}`,
  );
  const all = loadSessions();
  let idx = all.findIndex((s) => s.id === id);
  let matchKind = idx >= 0 ? "webuiId" : null;
  if (idx < 0) {
    idx = all.findIndex((s) => s.mcodeSessionId === id);
    if (idx >= 0) matchKind = "mcodeSessionId";
  }
  // B03: real-delete path must pass per-request authorize() before
  //   mutating db / saveSessions / killMcodeSessionResurrection.
  //   dryRun=true bypasses (preview only — no side effects to gate).
  if (!dryRun) {
    const authResult = await authorize("session.delete", {
      cid,
      targetSessionId: id,
      matchKind: matchKind || (idx < 0 ? "unknown" : "webuiId"),
      isMcodeSid: /^mvs_[a-f0-9]{32}$/.test(id),
      isOrphan: idx < 0,
      chatLen: idx >= 0 && all[idx] && Array.isArray(all[idx].chat) ? all[idx].chat.length : 0,
    });
    if (!authResult.approved) {
      console.log(
        `[delete] cid=${cid} DECLINED id=${id.substring(0, 12)}… reason=${authResult.decidedBy}`,
      );
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        ok: false,
        error: "authorize declined",
        decidedBy: authResult.decidedBy,
        decidedAt: authResult.decidedAt,
      }));
    }
    // Write-ahead audit (2026-09-20 rigor fix): the destructive intent
    // MUST be durably recorded BEFORE any persistent mutation (db rows,
    // sessions store, subprocess kill). If this append fails we abort
    // the delete entirely — an unaudited destructive action is the one
    // failure mode this gate exists to prevent. The matching outcome
    // event (kind "session.delete") is written after the mutation.
    try {
      _eventsAppend("session.delete.intent", {
        target: id,
        cid,
        actor: "user",
        payload: {
          matchKind: matchKind || "unknown",
          isOrphan: idx < 0,
          chatLen: idx >= 0 && all[idx] && Array.isArray(all[idx].chat) ? all[idx].chat.length : 0,
          decidedBy: authResult.decidedBy,
        },
      });
    } catch (e) {
      return _auditFail(res, e, "session.delete.intent");
    }
  }
  // v0.5.bx-19: 兜底 — webui session db 找不到, 但 id 是 mvs_xxx → 当孤儿 mcode session 直接 SQL 删
  if (idx < 0) {
    if (/^mvs_[a-f0-9]{32}$/.test(id)) {
      if (!dryRun) killMcodeSessionResurrection(id); // 先杀常驻子进程(回写源)再删 db 行
      const mcodeDbDel = deleteMcodeSessionFromDb(id, { MCODE_RUNTIME_DB, dryRun });
      console.log(
        `[delete] cid=${cid} ORPHAN mcode session sid=${id.substring(0, 12)}… ok=${mcodeDbDel.ok}` +
          (mcodeDbDel.ok
            ? ` log=[${(mcodeDbDel.log || []).join(",")}]`
            : ` reason=${mcodeDbDel.reason || "-"} error=${mcodeDbDel.error || "-"}`),
      );
      if (mcodeDbDel.ok) {
        if (cs.mcodeSessionId === id) {
          cs.mcodeSessionId = null;
          cs.sessionId = null;
          cs.sessionTitle = "Untitled";
          cs.chat = [];
          resetContext(cs);
          pushStateFor(cid);
        }
        // B01: orphan mcode session deletion (no webui session row).
        // Outcome event; the intent line was written before the gate
        // fan-out above. Failure → 5xx + alert (rows are already gone;
        // the operator must see the audit gap, not a silent success).
        try {
          _eventsAppend("session.delete", {
            target: id,
            cid,
            actor: "user",
            payload: {
              matchKind: "orphan_mcode",
              dryRun,
              rowsAffected: (mcodeDbDel.log || []).length,
            },
          });
        } catch (e) {
          return _auditFail(res, e, "session.delete(orphan_mcode)");
        }
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        return res.end(
          JSON.stringify({
            ok: true,
            deleted: id,
            matchKind: "orphan_mcode",
            dryRun,
            mcodeDbDel,
          }),
        );
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          ok: false,
          error: "orphan mcode delete failed",
          mcodeDbDel,
        }),
      );
    }
    console.log(`[delete] cid=${cid} 404 id=${id.substring(0, 12)}… not found`);
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "session not found" }));
  }
  // dryRun: 不真删 webui session entry,只预览 mcode db 影响
  if (dryRun) {
    const mcodeSid = all[idx].mcodeSessionId;
    const mcodeDbDel = mcodeSid
      ? deleteMcodeSessionFromDb(mcodeSid, { MCODE_RUNTIME_DB, dryRun: true })
      : { ok: true, dryRun: true, log: [], totalRows: 0 };
    console.log(
      `[delete] cid=${cid} DRYRUN id=${id.substring(0, 12)}… mcodeDbDel=${JSON.stringify(mcodeDbDel)}`,
    );
    // B01: dryRun is itself a state-touching action — the operator
    // is previewing a delete, so record the preview but never the
    // actual session content. dryRun:true marker lets verify / audit
    // distinguish "actually deleted" from "previewed delete".
    // Fail-closed → 5xx + alert (preview didn't mutate, but an
    // unaudited preview still misleads the operator's audit view).
    try {
      _eventsAppend("session.delete", {
        target: id,
        cid,
        actor: "user",
        payload: {
          matchKind,
          dryRun: true,
          previewedRows: mcodeDbDel.totalRows || 0,
        },
      });
    } catch (e) {
      return _auditFail(res, e, "session.delete(dryRun)");
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
    });
    return res.end(
      JSON.stringify({
        ok: true,
        dryRun: true,
        matchKind,
        mcodeDbDel,
        webuiEntryWouldBeDeleted: {
          id: all[idx].id,
          title: all[idx].title,
          mcodeSessionId: mcodeSid,
        },
      }),
    );
  }
  const deletedItem = all[idx];
  all.splice(idx, 1);
  saveSessions(all);
  // v0.5.bx-19: 同步删 mcode 端 session
  const mcodeSid = deletedItem.mcodeSessionId;
  let mcodeDbDel = null;
  if (mcodeSid) {
    killMcodeSessionResurrection(mcodeSid); // 先杀常驻子进程(回写源)再删 db 行
    mcodeDbDel = deleteMcodeSessionFromDb(mcodeSid, { MCODE_RUNTIME_DB });
    console.log(
      `[delete] cid=${cid} mcode db delete sid=${mcodeSid.substring(0, 12)}… ok=${mcodeDbDel.ok}` +
        (mcodeDbDel.ok
          ? ` log=[${(mcodeDbDel.log || []).join(",")}]`
          : ` reason=${mcodeDbDel.reason || "-"} error=${mcodeDbDel.error || "-"}`),
    );
  }
  // v0.5.bx-5 + v1.0: 当前会话可能是被删的 webui session，也可能是它的 mcode sibling
  //   v1.0 扩展到所有 client — 其他 tab 把该 session 当"当前会话"时也要清,
  //   否则那个 tab 的下次交互 (switch/chat) 会为同一 mvs sid 自动重建 webui 条目
  let touchedCids = [];
  for (const [c, ccs] of clients) {
    if (ccs.sessionId === deletedItem.id || ccs.mcodeSessionId === id) {
      ccs.sessionId = null;
      ccs.mcodeSessionId = null;
      ccs.sessionTitle = "Untitled";
      ccs.chat = [];
      ccs.usage = {
        ...ccs.usage,
        sessionInput: 0,
        sessionOutput: 0,
        sessionTotal: 0,
      };
      resetContext(ccs);
      touchedCids.push(c);
    }
  }
  if (touchedCids.length === 0) touchedCids = [cid];
  for (const c of touchedCids) pushStateFor(c);
  // B01: real session delete (the dangerous one). Record which webui
  // session was deleted, what the match kind was, how many cids had
  // their active session cleared (this is the "fan-out" effect that
  // surprised users historically), and the mcode db deltas. Title
  // is logged (not sensitive — it was user-visible in the sidebar).
  // Outcome event; failure → 5xx + alert. The deletion itself already
  // happened — we do NOT paper over it with a 200, the operator must
  // see both the response failure and the alert.
  try {
    _eventsAppend("session.delete", {
      target: id,
      cid,
      actor: "user",
      payload: {
        matchKind,
        dryRun: false,
        remaining: all.length,
        touchedCids: touchedCids.length,
        mcodeRowsAffected: mcodeDbDel && mcodeDbDel.log ? mcodeDbDel.log.length : 0,
        title: deletedItem.title,
      },
    });
  } catch (e) {
    return _auditFail(res, e, "session.delete");
  }
  console.log(
    `[delete] cid=${cid} OK match=${matchKind} deleted.webuiId=${deletedItem.id.substring(0, 8)}… remaining=${all.length}`,
  );
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      deleted: id,
      matchKind,
      dryRun: false,
      remaining: all.length,
      mcodeDbDel,
    }),
  );
}

// GET /api/acp-sessions?cwd=... — mcode acp session/list
export async function handleAcpSessions(req, res, ctx) {
  const cs = ctx.cs;
  const url = new URL(req.url, "http://localhost");
  const cwd =
    url.searchParams.get("cwd") || (cs.workspace && cs.workspace.dir) || "";
  const sessions = await getMcodeSessionsForWorkspace(cwd);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ok: true, cwd, sessions }));
}

// GET /api/acp-session-title?sessionId=...
export async function handleAcpSessionTitle(req, res, _ctx) {
  const url = new URL(req.url, "http://localhost");
  const sid = url.searchParams.get("sessionId") || "";
  if (!sid) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "sessionId required" }));
  }
  const title = await getMcodeSessionTitle(sid);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({ ok: true, sessionId: sid, title: title || null }),
  );
}

// Lease C05: GET /api/sessions/search?q=<text>&workspace=<path>&limit=<n>
//   Cross-workspace session search. The prior sidebar search
//   (renderSessions in public/app/render.js) only filtered the
//   already-loaded list — it could not surface sessions stored under
//   a different `workspace` field. This endpoint walks the persisted
//   sessions JSON so typing into the sidebar box can show matches
//   across all workspaces the user has touched.
//
//   Query params:
//     q          fuzzy substring match on session.title (case-insensitive).
//                Required for the search to return anything; empty q
//                returns [] (use GET /api/sessions for "list all").
//     workspace  optional exact workspace path filter. Empty = all
//                workspaces. When set, the dedup-by-workspace rule
//                below is a no-op (every result already shares the
//                same workspace).
//     limit      default 20, max 100, min 1. Out-of-range is clamped.
//
//   Response: [Array<{id, title, workspace, updatedAt, matchScore}>]
//     matchScore is a deterministic 0-100 integer that the client can
//     use to sort results. Higher = better match:
//       100  exact title == q
//        50  title startsWith q
//        10  title contains q (case-insensitive)
//         1  chat-tail fallback (rare; old sessions without titles)
//         0  no title but id contains q
//
//   Dedup rule: "同名 workspace 的 session 只保留最近一条". For each
//   unique workspace path that produced a match, we keep only the
//   session with the highest matchScore; on tie, the most recent
//   updatedAt wins. This collapses repeated search hits in one
//   workspace to a single representative row.
//
//   Gate (B03 / integration touchpoint): cross-workspace search
//   exposes titles from workspaces the user may have left open. We
//   gate with authorize("session.search", ctx). The new action name
//   is appended to AUTHORIZE_ACTIONS in server/lib/authorize.js so
//   the whitelist check accepts it. In production this pops the same
//   needs_authorization SSE modal as session.delete / session.export;
//   tests drive the decision via test/_setup.js#withDecisions (the
//   execArgv auto-approve was removed in the 2026-09-20 rigor fix).
//
//   Audit (B01): the search itself is non-destructive so we do NOT
//   append a session.search event by default. The authorize call
//   already writes auth.pending / auth.approve / auth.reject events
//   to the same chain, which is enough for audit purposes.
export async function handleSearchSessions(req, res, ctx) {
  const cid = (ctx && ctx.cid) || "";
  const url = new URL(req.url, "http://localhost");
  const q = (url.searchParams.get("q") || "").trim();
  const workspaceParam = (url.searchParams.get("workspace") || "").trim();
  let limit = parseInt(url.searchParams.get("limit") || "20", 10);
  if (!Number.isFinite(limit)) limit = 20;
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;
  // B03 gate: cross-workspace reads surface titles from workspaces
  //   the user is not currently in. Gate the same way session.delete
  //   / session.export are gated. Tests drive the real decision path
  //   via test/_setup.js#withDecisions.
  const authResult = await authorize("session.search", {
    cid,
    q,
    workspace: workspaceParam,
    limit,
  });
  if (!authResult.approved) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: false,
      error: "authorize declined",
      decidedBy: authResult.decidedBy,
      decidedAt: authResult.decidedAt,
    }));
  }
  // q empty: by spec, search is a no-op (not a list-all endpoint).
  //   Returning [] keeps the client UX simple — empty box == empty
  //   result, and the existing renderSessions path handles "no
  //   search" with the full list.
  if (!q) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, results: [] }));
  }
  const all = loadSessions();
  const qLower = q.toLowerCase();
  // Per-session score: deterministic 0-100 integer.
  //   We score on title first (it's the user-visible label); id is
  //   a secondary fallback so typing part of a session id still
  //   finds it.
  function scoreSession(s) {
    const title = (s && s.title ? String(s.title) : "").trim();
    const titleLower = title.toLowerCase();
    if (titleLower && titleLower === qLower) return 100;
    if (titleLower && titleLower.startsWith(qLower)) return 50;
    if (titleLower && titleLower.includes(qLower)) return 10;
    const id = (s && s.id ? String(s.id) : "").toLowerCase();
    if (id && id.includes(qLower)) return 1;
    return 0;
  }
  // Filter by workspace if requested, then by score > 0.
  const scored = [];
  for (const s of all) {
    if (!s || typeof s !== "object") continue;
    if (workspaceParam) {
      const ws = (s.workspace || "").trim();
      if (ws !== workspaceParam) continue;
    }
    const score = scoreSession(s);
    if (score <= 0) continue;
    scored.push({
      id: s.id || "",
      title: (s.title || "").toString(),
      workspace: (s.workspace || "").toString(),
      updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
      matchScore: score,
    });
  }
  // Dedup by workspace: keep the best match per workspace path.
  //   Empty-string workspace (legacy / unset) is its own bucket — it
  //   still gets one representative row.
  const bestByWs = new Map();
  for (const item of scored) {
    const wsKey = item.workspace || "";
    const prev = bestByWs.get(wsKey);
    if (!prev) {
      bestByWs.set(wsKey, item);
      continue;
    }
    if (item.matchScore > prev.matchScore) {
      bestByWs.set(wsKey, item);
    } else if (
      item.matchScore === prev.matchScore &&
      item.updatedAt > prev.updatedAt
    ) {
      bestByWs.set(wsKey, item);
    }
  }
  // Sort: score desc, then updatedAt desc, then workspace asc (stable).
  const results = [...bestByWs.values()];
  results.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return (a.workspace || "").localeCompare(b.workspace || "");
  });
  const limited = results.slice(0, limit);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ok: true, results: limited }));
}

// B03 + AP11 fix: POST /api/sessions/cleanup-orphans
//   Wires the missing endpoint that ANTI-PATTERNS-FIX-PLAN §AP11 noted
//   as documented-but-unimplemented. The endpoint:
//     1) dryRun=true  → preview only (count + would-be-deleted ids).
//                       Skips authorize() because no side effects occur.
//     2) dryRun=false (or absent) → real delete path. Must pass
//                       authorize('sessions.cleanup-orphans', ctx) first.
//                       Each session is fed through handleDeleteSession's
//                       real-delete branch so the audit trail / mcode
//                       db cleanup / cross-tab fan-out stay consistent.
//   The cleanup targets: default-named webui sessions (New session /
//   Untitled / 对话 N) whose chat is empty AND whose updatedAt is older
//   than 24h — same rule as cleanupEmptyDefaultSessions() in lib/sessions.js.
import { existsSync, readFileSync } from "node:fs";
import { SESSIONS_DB } from "../lib/config.js";

const ORPHAN_STALE_MS = 24 * 60 * 60 * 1000;

function _findOrphanIds() {
  if (!existsSync(SESSIONS_DB)) return [];
  let all;
  try {
    let raw = readFileSync(SESSIONS_DB, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 剥 BOM
    all = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(all) || all.length === 0) return [];
  const now = Date.now();
  return all
    .filter((s) => {
      if (!s || !s.id) return false;
      const hasChat = Array.isArray(s.chat) && s.chat.length > 0;
      if (hasChat) return false;
      const t = (s.title || "").trim();
      const isDefault =
        t === "New session" || t === "Untitled" || /^对话 \d+$/.test(t);
      if (!isDefault) return false;
      if (s.updatedAt && now - s.updatedAt < ORPHAN_STALE_MS) return false;
      return true;
    })
    .map((s) => s.id);
}

export async function handleCleanupOrphans(req, res, ctx) {
  const cid = (ctx && ctx.cid) || "";
  let dryRun = false;
  try {
    const qIdx = (req.url || "").indexOf("?");
    if (qIdx >= 0) {
      const params = new URLSearchParams(req.url.slice(qIdx + 1));
      dryRun = params.get("dryRun") === "true";
    }
  } catch {}
  const targetIds = _findOrphanIds();
  // Preview path: no authorize gate (no side effects).
  if (dryRun) {
    console.log(
      `[cleanup-orphans] cid=${cid} DRYRUN would-delete=${targetIds.length}`,
    );
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: true,
      dryRun: true,
      count: targetIds.length,
      ids: targetIds,
    }));
  }
  // Real path: gate with authorize() before touching any session.
  if (targetIds.length === 0) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, dryRun: false, deleted: 0, ids: [] }));
  }
  const authResult = await authorize("sessions.cleanup-orphans", {
    cid,
    orphanCount: targetIds.length,
    orphanIds: targetIds.slice(0, 32), // truncated for log hygiene
  });
  if (!authResult.approved) {
    console.log(
      `[cleanup-orphans] cid=${cid} DECLINED count=${targetIds.length} reason=${authResult.decidedBy}`,
    );
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: false,
      error: "authorize declined",
      decidedBy: authResult.decidedBy,
      decidedAt: authResult.decidedAt,
    }));
  }
  // Write-ahead audit: record the sweep intent BEFORE any per-session
  // delete runs (each delegated delete writes its own
  // session.delete.intent / session.delete pair). Failure aborts the
  // whole sweep — orphan deletion is destructive and must not proceed
  // unaudited.
  try {
    _eventsAppend("sessions.cleanup-orphans.intent", {
      target: "sessions.cleanup-orphans",
      cid,
      actor: "user",
      payload: {
        orphanCount: targetIds.length,
        orphanIds: targetIds.slice(0, 32),
        decidedBy: authResult.decidedBy,
      },
    });
  } catch (e) {
    return _auditFail(res, e, "sessions.cleanup-orphans.intent");
  }
  // Approved: delegate each delete to handleDeleteSession so the
  //   existing fan-out / mcode db cleanup / cross-tab reset logic
  //   stays in one place. We synthesize a minimal `req` with the
  //   target id so the handler can route as if it came from HTTP.
  const deleted = [];
  const failed = [];
  for (const id of targetIds) {
    try {
      const fakeReq = {
        url: `/api/sessions/${encodeURIComponent(id)}`,
      };
      const fakeRes = {
        _status: 200,
        _body: "{}",
        writeHead(s, _h) { this._status = s; },
        end(b) { this._body = b ? String(b) : "{}"; },
      };
      await handleDeleteSession(fakeReq, fakeRes, ctx);
      // handleDeleteSession already wrote authorize-gated session.delete
      // events. Parse its result for our summary.
      let summary = {};
      try { summary = JSON.parse(fakeRes._body || "{}"); } catch {}
      if (fakeRes._status === 200 && summary.ok) deleted.push(id);
      else failed.push({ id, status: fakeRes._status, reason: summary.error || "unknown" });
    } catch (e) {
      failed.push({ id, error: e && e.message ? e.message : String(e) });
    }
  }
  console.log(
    `[cleanup-orphans] cid=${cid} OK deleted=${deleted.length} failed=${failed.length}`,
  );
  // Outcome event for the sweep as a whole. Failure → 5xx + alert:
  // some or all deletes already ran, so the operator must see the
  // audit gap rather than a silent 200.
  try {
    _eventsAppend("sessions.cleanup-orphans.done", {
      target: "sessions.cleanup-orphans",
      cid,
      actor: "user",
      payload: {
        deleted: deleted.length,
        failed: failed.length,
        decidedBy: authResult.decidedBy,
      },
    });
  } catch (e) {
    return _auditFail(res, e, "sessions.cleanup-orphans.done");
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({
    ok: true,
    dryRun: false,
    deleted: deleted.length,
    failed: failed.length,
    deletedIds: deleted,
    failedItems: failed,
    decidedBy: authResult.decidedBy,
    decidedAt: authResult.decidedAt,
  }));
}
