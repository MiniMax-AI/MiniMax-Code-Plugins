// webui/server/lib/sessions.js
// Sessions JSON persistence + chat helpers.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { SESSIONS_DB } from "./config.js";

// -----------------------------------------------------------------------
// v2 hardening (PR #55 review point 5): persistence boundaries.
// 之前 saveSessions 直接 writeFileSync 整文件重写 — 非原子（写一半崩溃/
// 磁盘满 → 截断 JSON），loadSessions 把 parse 失败静默当空库（调用方随后
// 一次 load-modify-save 就把真数据整体抹掉 = 数据消失），写层面没有任何
// 并发保障。现在三道保障：
//
//   1. 原子写：先写同目录临时文件 SESSIONS_DB+".tmp"，再 renameSync 原子
//      替换（同目录 → 同文件系统 → rename 原子性成立）。任意时刻磁盘上的
//      主文件要么是旧的完整内容、要么是新的完整内容；写中途失败只可能残
//      留 .tmp（本函数失败路径即清理，下一次保存也会覆盖），主文件永不被
//      截断成半写状态。
//
//   2. 并发写串行化：server.js 以单 Node 进程装配（无 cluster/fork/
//      worker，见 server.js），Node 单线程事件循环里同步 fs 调用"运行至
//      完成" — 两个 saveSessions 不可能在 syscall 层交叉执行，本模块全
//      部使用同步 fs 调用，即进程内锁的等价物且更强（无等待、无重入）。
//      跨进程写者不存在：该 DB 只有本进程读写（无第二实例假设；若运维
//      真跑双实例，rename 原子性仍保证不撕裂，仅最后写者胜出）。
//
//   3. 损坏显式化：parse 失败不再静默当空库 — 先把损坏字节隔离到
//      SESSIONS_DB+".corrupted-<时间戳>"（原文件保持原样不动），打可行动
//      错误日志（指出隔离副本与恢复方法），再按空库返回（调用方契约不
//      变）。下一次 saveSessions 落新库时，旧数据仍完整保留在隔离副本里
//      可回填 — "损坏 → 空库 → 覆盖保存"的数据消失链被斩断。
//      隔离与报错按 (mtime, size) 备忘去重：同一损坏态重复 load 不重复
//      隔离刷屏；文件被修复（哪怕 mtime/size 恰好未变）后照常重新 parse。
// -----------------------------------------------------------------------

// 损坏态备忘（只记"已隔离+已报错"这件事，不缓存正常数据 — 正常路径每次
// 照实重读，零行为变化）。
let _corruptionMemo = null; // { mtimeMs, size } | null

function reportCorruptedSessionsDb(st, err) {
  const alreadyReported =
    _corruptionMemo !== null &&
    _corruptionMemo.mtimeMs === st.mtimeMs &&
    _corruptionMemo.size === st.size;
  if (alreadyReported) return;
  const quarantine = `${SESSIONS_DB}.corrupted-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}`;
  let quarantined = false;
  try {
    copyFileSync(SESSIONS_DB, quarantine);
    quarantined = true;
  } catch {}
  _corruptionMemo = { mtimeMs: st.mtimeMs, size: st.size };
  console.error(
    `[webui] sessions DB 损坏: ${err.message}。原文件已保留未动` +
      (quarantined
        ? `，隔离副本: ${quarantine}`
        : "（隔离副本创建失败 — 请立即手动备份原文件）") +
      `。恢复: 修复 ${SESSIONS_DB} 的 JSON，或用隔离副本回填；` +
      `在此之前会话列表按空库处理。`,
  );
}

// Sessions store (file-backed JSON; minimal)
// v0.5.bx-5: 剥 UTF-8 BOM — 之前直接 JSON.parse 在 ﻿ 上抛 syntax error，try/catch 静默吞掉返 []
//   结果：所有 session 查找都查不到，delete/switch 都 404 "session not found"（用户报"删除不掉对话"）
// v2 hardening: parse 失败/根非数组不再静默 — 隔离副本 + 可行动错误（见文件头 §3）
export function loadSessions() {
  if (!existsSync(SESSIONS_DB)) return [];
  let st;
  try {
    st = statSync(SESSIONS_DB);
  } catch {
    return [];
  }
  let raw;
  try {
    raw = readFileSync(SESSIONS_DB, "utf8");
  } catch {
    return [];
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 剥 BOM
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    reportCorruptedSessionsDb(st, e);
    return [];
  }
  if (!Array.isArray(parsed)) {
    // 根不是数组同样按损坏处置 — 透传非数组只会让调用方 .find/.push 崩
    reportCorruptedSessionsDb(st, new Error("root value is not a JSON array"));
    return [];
  }
  return parsed;
}

export function saveSessions(s) {
  const payload = JSON.stringify(s, null, 2);
  // JSON.stringify 抛出（如循环引用）时 tmp 尚未创建，主文件不受影响
  const tmp = `${SESSIONS_DB}.tmp`;
  try {
    writeFileSync(tmp, payload, "utf8"); // 同目录 tmp → 同文件系统
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
  try {
    renameSync(tmp, SESSIONS_DB); // 原子替换（见文件头 §1/§2）
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
  // 主文件已换代 — 损坏备忘失效（新文件若再损坏属新状态，重新隔离）
  _corruptionMemo = null;
}

// 重置所有 context 字段（不只是 tokens/used；percent/spent/tps 之前漏了导致切完仍显示旧的 %）
// v2 (2026-09-20 webui-manual-audit): ALSO reset the two "a run is in
//   progress" claim fields — cs.running + cs.context.thinkingStatus.
//   Before this, resetContext cleared only the counters: a mid-run
//   switch/create/new left running.active=true + thinkingStatus="Running"
//   parked in the client state, so the footer/context panel showed 思考中
//   forever and the send button stayed a stop button for a run the user
//   had navigated away from. The claim only healed if the in-flight
//   run's finalize() later fired — runs that die in their start phase
//   never heal. The idle shape is byte-mirrored from the runners'
//   finalize() (mcode-acp.js / mcode-exec.js) and chat.js's
//   resetThinkingClaim(), so switch and normal end-of-turn converge on
//   the same at-rest state. Callers (sessions.js switch/create/delete,
//   protocol.js activate-session, commands.js /clear + /new) all treat
//   cs as "no longer the session that run belongs to" — none needs the
//   claim preserved. Two deliberate boundaries:
//   (1) NO ▍ cursor stripping here — unlike chat.js's resetThinkingClaim
//       (same session, terminal failure), every resetContext caller has
//       either already replaced cs.chat with the TARGET session's chat
//       (switch: stripping would corrupt lines that belong to a
//       different, possibly live, run) or is about to clear it
//       (new/clear/delete). Chat ownership stays with the caller.
//   (2) lastUsageAt still goes null — this is a session-CHANGE path:
//       the target session has no observed usage yet, and carrying the
//       old session's freshness datum over zeroed counters would lie.
//       (resetThinkingClaim keeps it because THERE the session is the
//       same one; finalize() keeps it for the same reason.)
export function resetContext(cs) {
  cs.running = {
    active: false,
    prompt: null,
    pid: null,
    startedAt: null,
    model: null,
    sessionId: null,
    lastDeltaAt: null,
    tps: 0,
  };
  cs.context.thinkingStatus = "Idle";
  cs.context.tokens = 0;
  cs.context.used = 0;
  cs.context.percent = 0;
  cs.context.spent = 0;
  cs.context.tps = 0;
  cs.context.thinkingDuration = null;
  cs.context.assistantLast = null;
  cs.context.assistantAt = null;
  cs.context.lastUsageAt = null;
}

// v0.5.x: 把当前 state.chat 写回 db 里对应 session 的 chat 字段
// 切 session 时从这个字段加载历史（之前 db 只存 {id,title,createdAt}，导致切过去看不到聊天）
export function persistCurrentChat(cs) {
  if (!cs.sessionId) return;
  const all = loadSessions();
  const item = all.find((s) => s.id === cs.sessionId);
  if (!item) return;
  item.chat = cs.chat || [];
  item.updatedAt = Date.now();
  saveSessions(all);
}

// v0.5.ad: 流式更新 chat 数组 — 同 prefix 最后一行就地替换，否则追加
export function streamUpdateLine(chat, prefix, text) {
  const target = `${prefix} `;
  // fix: 新行开始流式前，先清掉其他行的 ▍ —— 思考(▲)→正文(●)切换时思考块不再残留闪烁光标
  for (let i = 0; i < chat.length; i++) {
    if (typeof chat[i] === "string" && chat[i].endsWith(" ▍")) {
      chat[i] = chat[i].slice(0, -2);
    }
  }
  const last = chat[chat.length - 1];
  if (last && last.startsWith(target)) {
    chat[chat.length - 1] = `${target}${text} ▍`;
  } else {
    chat.push(`${target}${text} ▍`);
  }
}

// v0.5.ak: 启动时清理空 chat + 默认标题的 session（用户点了"新建会话"但没发消息的残留）
// 保留：有 chat 内容的；或标题是用户手打的中文/英文（不是 New session/Untitled/对话 N 这种默认名）
// 额外保护：updatedAt 距离现在 > 24h 的才清掉（避免把刚 + 按钮创建的 session 也干掉）
// v2 hardening: 改走 loadSessions() — 损坏库被隔离并按空库返回时，这里
//   all.length === 0 提前返回，绝不会用空数组覆盖隔离中的损坏文件。
export function cleanupEmptyDefaultSessions() {
  const all = loadSessions();
  if (!Array.isArray(all) || all.length === 0) return;
  const before = all.length;
  const now = Date.now();
  const STALE_MS = 24 * 60 * 60 * 1000;
  const kept = all.filter((s) => {
    if (!s || !s.id) return false;
    const hasChat = Array.isArray(s.chat) && s.chat.length > 0;
    if (hasChat) return true; // 有消息就保留
    const t = (s.title || "").trim();
    // 真实标题（非默认名）也保留
    const isDefault =
      t === "New session" || t === "Untitled" || /^对话 \d+$/.test(t);
    if (!isDefault) return true;
    // 默认名 + 24h 内刚建的：保留（刚 + 按钮创建的，别误删）
    if (s.updatedAt && now - s.updatedAt < STALE_MS) return true;
    return false; // 默认名 + 老于 24h：清理
  });
  if (kept.length !== before) {
    saveSessions(kept);
    console.log(
      `[webui] cleanup: removed ${before - kept.length} empty/default sessions, ${kept.length} kept`,
    );
  }
}
