// webui/server/lib/interaction/commands.js
// Slash command registry + dispatcher. Mirrors BORROW-dsh-deepseek-
// harness-2026-08-28 § 3 ("interaction/commands"). Owns the inline
// handlers used by /api/send (handleLocalSlash) and /api/cmd
// (handleCmdCommand); each handler mutates `cs` and routes through
// state-bus.pushStateFor (no direct SSE writes).
//
// Why a single file: the dispatcher stays small (one switch) and the
// bodies are private functions — external callers only need the two
// exported entry points. The commands module is the ONLY place that
// references loadSessions/saveSessions/persistCurrentChat/resetContext
// for slash purposes; future seaming (Borrow 3 hook seam) can
// intercept here without scattering changes across routes.

import { randomUUID } from "node:crypto";
import {
  loadSessions,
  saveSessions,
  persistCurrentChat,
  resetContext,
} from "../sessions.js";
import { ensureMcodeCommands } from "../acp-client.js";
import { runUsageQuery } from "../usage.js";
import { pushStateFor, getActiveChild } from "../state-bus.js";

// 列出 webui 支持的 slash 命令前缀（字母数字 + 连字符 + 下划线）
const SLASH_REGEX = /^\/([a-zA-Z][\w-]*)\b\s*(.*)/;

export function matchSlash(content) {
  const m = content.match(SLASH_REGEX);
  if (!m) return null;
  return { cmd: m[1], rest: m[2] || "" };
}

// webui-local commands shown in /help. Source of truth lives in
// lib/acp-client.js#WEBUI_LOCAL_COMMANDS — this array is the
// fallback when ensureMcodeCommands() hasn't returned yet (first
// /help race). Kept as a private constant because the canonical
// list is owned by acp-client.js.
const LOCAL_HELP_FALLBACK = [
  { name: "new", desc: "新建会话" },
  { name: "clear", desc: "清空当前对话" },
  { name: "status", desc: "查看当前状态" },
  { name: "sessions", desc: "查看最近会话" },
  { name: "help", desc: "可用命令" },
  { name: "usage", desc: "查询用量" },
  { name: "stop", desc: "停止当前任务" },
];

// ----- private body functions: each takes (cs, cid, rest) -----

function bodyGoal(cs, cid, content, rest) {
  const goalText = rest.trim();
  if (!goalText) {
    const t = `● 用法: /goal <目标内容> — 在右栏 "目标" 区设一个目标, 后续用 /goal-done 或 /goal-blocked 标记完成状态`;
    cs.chat = [...(cs.chat || []), t];
    pushStateFor(cid);
    persistCurrentChat(cs);
    return { handled: true, continueMcode: false };
  }
  cs.goal = {
    active: true,
    text: goalText,
    status: "in_progress",
    duration: null,
    startTs: Date.now(),
  };
  // pre-slash 之前加了 '› /goal ${goalText}' 行,这里替换成 '› ${goalText}' (跟 mcode 实际收到的对齐)
  if (Array.isArray(cs.chat) && cs.chat.length > 0) {
    const last = cs.chat[cs.chat.length - 1];
    if (
      last === `› /goal ${goalText}` ||
      last === `› /goal ${rest}` ||
      last === `› ${content}`
    ) {
      cs.chat = [...cs.chat.slice(0, -1), `› ${goalText}`];
    }
  }
  cs.chat = [
    ...(cs.chat || []),
    `● 已设目标: ${goalText} — 转发给 mcode 触发执行, 完成后用 /goal-done 标记 ✅`,
  ];
  pushStateFor(cid);
  persistCurrentChat(cs);
  if (process.env.MCODE_USAGE_DEBUG)
    console.log(`[goal.set] cid=${cid} text="${goalText}"`);
  return { handled: true, continueMcode: true, rewriteContent: goalText };
}

function bodyGoalClose(cs, cid, kind /* "done" | "blocked" */) {
  if (!cs.goal || !cs.goal.active) {
    const t = `● 当前没有 active 目标, 用 /goal <内容> 先设一个`;
    cs.chat = [...(cs.chat || []), t];
    pushStateFor(cid);
    persistCurrentChat(cs);
    return { handled: true, continueMcode: false };
  }
  const newStatus = kind === "done" ? "complete" : "blocked";
  cs.goal = {
    ...cs.goal,
    active: false,
    status: newStatus,
    duration: cs.goal.startTs ? Date.now() - cs.goal.startTs : null,
  };
  cs.chat = [
    ...(cs.chat || []),
    `● 目标已标 ${newStatus === "complete" ? "完成 ✅" : "阻塞 ⛔"}: ${cs.goal.text || ""}`,
  ];
  pushStateFor(cid);
  persistCurrentChat(cs);
  if (process.env.MCODE_USAGE_DEBUG)
    console.log(`[goal.${newStatus}] cid=${cid}`);
  return { handled: true, continueMcode: false };
}

function bodyClear(cs, cid) {
  cs.chat = [];
  cs.usage = {
    ...cs.usage,
    sessionInput: 0,
    sessionOutput: 0,
    sessionTotal: 0,
  };
  cs.mcodeSessionId = null;
  cs.sessionTitle = "Untitled";
  resetContext(cs);
  persistCurrentChat(cs);
  pushStateFor(cid);
  return { handled: true, continueMcode: false };
}

function bodyNew(cs, cid) {
  const all = loadSessions();
  const id = randomUUID();
  const item = {
    id,
    title: "New session",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chat: [],
  };
  all.unshift(item);
  saveSessions(all);
  cs.sessionId = id;
  cs.sessionTitle = item.title;
  cs.chat = [];
  cs.usage = {
    ...cs.usage,
    sessionInput: 0,
    sessionOutput: 0,
    sessionTotal: 0,
  };
  cs.mcodeSessionId = null;
  resetContext(cs);
  pushStateFor(cid);
  return { handled: true, continueMcode: false };
}

function bodyStatus(cs, cid) {
  const t = `● 当前 model=${cs.model.name}\n  workspace=${cs.workspace.dir}\n  权限=${cs.permissions}`;
  cs.chat = [...(cs.chat || []), `› /status`, t];
  pushStateFor(cid);
  persistCurrentChat(cs);
  return { handled: true, continueMcode: false };
}

async function bodyHelp(cs, cid) {
  const cmds = await ensureMcodeCommands();
  const webui = (cmds && Array.isArray(cmds.webui) && cmds.webui.length > 0)
    ? cmds.webui
    : LOCAL_HELP_FALLBACK;
  const lines = ["● 可用命令："];
  for (const c of webui) lines.push(`  /${c.name} — ${c.desc}`);
  if (Array.isArray(cmds.mcode) && cmds.mcode.length > 0) {
    for (const c of cmds.mcode) {
      if (typeof c === "string") lines.push(`  /${c}`);
      else if (c && c.name)
        lines.push(
          `  /${c.name}${c.description ? " — " + c.description : ""}`,
        );
    }
  } else if (cmds.source && cmds.source.startsWith("error")) {
    lines.push(`  (mcode 命令拉取失败：${cmds.source.slice(7)})`);
  } else {
    lines.push(`  (mcode 命令待拉取…)`);
  }
  cs.chat = [...(cs.chat || []), `› /help`, lines.join("\n")];
  pushStateFor(cid);
  persistCurrentChat(cs);
  return { handled: true, continueMcode: false };
}

function bodySessions(cs, cid) {
  const all = loadSessions();
  const t =
    `● 最近 ${all.length} 个会话：\n` +
    all
      .slice(0, 8)
      .map((s, i) => `  ${i + 1}. ${s.title} (${s.id.substring(0, 8)}…)`)
      .join("\n");
  cs.chat = [...(cs.chat || []), `› /sessions`, t];
  pushStateFor(cid);
  persistCurrentChat(cs);
  return { handled: true, continueMcode: false };
}

async function bodyUsage(cs, cid) {
  await runUsageQuery(cs, cid);
  return { handled: true, continueMcode: false };
}

async function bodyStop(cs, cid) {
  const child = getActiveChild(cid);
  const wasRunning = !!child;
  if (child) {
    try {
      child.kill();
    } catch {}
  }
  const t = wasRunning ? `● 已发送停止信号` : `● 没有正在运行的任务`;
  cs.chat = [...(cs.chat || []), `› /stop`, t];
  pushStateFor(cid);
  persistCurrentChat(cs);
  return { handled: true };
}

// ----- public dispatchers -----

// handleLocalSlash: /api/send path (user typed /cmd in chat input).
// Returns { handled, continueMcode, rewriteContent? }. If handled and
// continueMcode=false, caller returns immediately. If handled and
// continueMcode=true with rewriteContent, caller forwards the rewritten
// content to mcode (used by /goal). If not handled, caller falls
// through to mcode.
export async function handleLocalSlash(content, cs, cid) {
  const m = matchSlash(content);
  if (!m) return false;
  const { cmd, rest } = m;
  switch (cmd) {
    case "goal":
      return bodyGoal(cs, cid, content, rest);
    case "goal-done":
      return bodyGoalClose(cs, cid, "done");
    case "goal-blocked":
      return bodyGoalClose(cs, cid, "blocked");
    case "clear":
      return bodyClear(cs, cid);
    case "new":
      return bodyNew(cs, cid);
    case "status":
      return bodyStatus(cs, cid);
    case "help":
      return await bodyHelp(cs, cid);
    case "usage":
      return await bodyUsage(cs, cid);
    default:
      return { handled: false, continueMcode: true };
  }
}

// handleCmdCommand: /api/cmd path (button-driven; cmd includes leading /).
// Returns { handled: true } for matched cmds, { handled: false } otherwise.
// /new has extra guards not present in the text-typed path (running check
// + noop-empty for repeated clicks).
export async function handleCmdCommand(cmd, cs, cid) {
  if (typeof cmd !== "string" || cmd.length === 0)
    return { handled: false };
  const name = cmd.startsWith("/") ? cmd.slice(1) : cmd;

  if (name === "new") {
    if (cs.running && cs.running.active) {
      cs.chat = [
        ...(cs.chat || []),
        `! [warn] AI 还在回复中，先停止当前任务再新建会话`,
      ];
      pushStateFor(cid);
      return { handled: true };
    }
    const isEmpty = !cs.chat || cs.chat.length === 0;
    const isDefaultTitle =
      !cs.sessionTitle ||
      cs.sessionTitle === "Untitled" ||
      cs.sessionTitle === "New session";
    if (cs.sessionId && isEmpty && isDefaultTitle) {
      pushStateFor(cid);
      return { handled: true };
    }
    return bodyNew(cs, cid);
  }

  switch (name) {
    case "status":
      return bodyStatus(cs, cid);
    case "clear":
      return bodyClear(cs, cid);
    case "sessions":
      return bodySessions(cs, cid);
    case "help":
      return await bodyHelp(cs, cid);
    case "usage":
      return await bodyUsage(cs, cid);
    case "stop":
      return await bodyStop(cs, cid);
    default:
      return { handled: false };
  }
}