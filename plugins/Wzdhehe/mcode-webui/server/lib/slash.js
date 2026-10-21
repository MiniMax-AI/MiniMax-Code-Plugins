// webui/server/lib/slash.js
// Slash-command inline handlers used by /api/send (webui-level, no mcode exec).

import { randomUUID } from "node:crypto";
import {
  loadSessions,
  saveSessions,
  persistCurrentChat,
  resetContext,
} from "./sessions.js";
import { ensureMcodeCommands } from "./acp-client.js";
import { runUsageQuery } from "./usage.js";
import { pushStateFor } from "./state-bus.js";

// 列出 webui 支持的 slash 命令前缀（字母数字 + 连字符）
const SLASH_REGEX = /^\/([a-zA-Z][\w-]*)\b\s*(.*)/;

export function matchSlash(content) {
  const m = content.match(SLASH_REGEX);
  if (!m) return null;
  return { cmd: m[1], rest: m[2] || "" };
}

// 处理 webui 端 slash 命令（不发 mcode）。
// 返回 true 表示已处理（路由就 return；不继续 mcode 调用）
// 返回 false 表示不是 webui 命令，继续走 mcode
export async function handleLocalSlash(content, cs, cid) {
  const m = matchSlash(content);
  if (!m) return false;
  const { cmd, rest } = m;

  // v0.5.bx-15: /goal <text> — webui 端设 goal + 改写 content 让 mcode 真收到
  // v0.5.bx-22 (改): 不要 return — 改写 content 为 goal text, 让 mcode 真正收到并开始执行
  if (cmd === "goal") {
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
    // v0.5.bx-22: 改写 content 为 goal text, 继续走 mcode 调用 (不 return!)
    return { handled: true, continueMcode: true, rewriteContent: goalText };
  }

  // v0.5.bx-15: /goal-done 或 /goal-blocked — 手动标 goal 状态
  if (cmd === "goal-done" || cmd === "goal-blocked") {
    if (!cs.goal || !cs.goal.active) {
      const t = `● 当前没有 active 目标, 用 /goal <内容> 先设一个`;
      cs.chat = [...(cs.chat || []), t];
      pushStateFor(cid);
      persistCurrentChat(cs);
      return { handled: true, continueMcode: false };
    }
    const newStatus = cmd === "goal-done" ? "complete" : "blocked";
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

  if (cmd === "clear" || cmd === "new") {
    if (cmd === "new") {
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
    } else {
      cs.chat = [];
      persistCurrentChat(cs);
    }
    cs.chat = [];
    cs.usage = {
      ...cs.usage,
      sessionInput: 0,
      sessionOutput: 0,
      sessionTotal: 0,
    };
    if (cmd === "new") {
      cs.mcodeSessionId = null;
      cs.sessionTitle = "New session";
    } else {
      cs.mcodeSessionId = null;
      cs.sessionTitle = "Untitled";
    }
    resetContext(cs);
    pushStateFor(cid);
    return { handled: true, continueMcode: false };
  }

  if (cmd === "status") {
    const t = `● 当前 model=${cs.model.name}\n  workspace=${cs.workspace.dir}\n  权限=${cs.permissions}`;
    cs.chat = [...cs.chat, t];
    pushStateFor(cid);
    return { handled: true, continueMcode: false };
  }

  if (cmd === "usage" || cmd === "help") {
    if (cmd === "help") {
      const cmds = await ensureMcodeCommands();
      const lines = ["● 可用命令："];
      for (const c of cmds.webui) lines.push(`  /${c.name} — ${c.desc}`);
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
      const t = lines.join("\n");
      cs.chat = [...cs.chat, `› /help`, t];
      pushStateFor(cid);
      persistCurrentChat(cs);
      return { handled: true, continueMcode: false };
    }
    if (cmd === "usage") {
      await runUsageQuery(cs, cid);
      return { handled: true, continueMcode: false };
    }
  }

  // 其他命令走 mcode exec
  return { handled: false, continueMcode: true };
}

// 处理 /api/cmd 端的命令（前端 button 触发）
export async function handleCmdCommand(cmd, cs, cid) {
  if (cmd === "/new") {
    // v0.5.ak: mcode 还在跑时禁止清空 chat
    if (cs.running && cs.running.active) {
      cs.chat = [
        ...(cs.chat || []),
        `! [warn] AI 还在回复中，先停止当前任务再新建会话`,
      ];
      pushStateFor(cid);
      return { handled: true };
    }
    // v0.5.ak: 避免 0 对话下无限新建
    const isEmpty = !cs.chat || cs.chat.length === 0;
    const isDefaultTitle =
      !cs.sessionTitle ||
      cs.sessionTitle === "Untitled" ||
      cs.sessionTitle === "New session";
    if (cs.sessionId && isEmpty && isDefaultTitle) {
      pushStateFor(cid);
      return { handled: true };
    }
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
    cs.mcodeSessionId = null;
    cs.sessionTitle = item.title;
    cs.chat = [];
    cs.usage = {
      ...cs.usage,
      sessionInput: 0,
      sessionOutput: 0,
      sessionTotal: 0,
    };
    resetContext(cs);
    pushStateFor(cid);
    return { handled: true };
  }
  if (cmd === "/status") {
    const t = `● 当前 model=${cs.model.name}\n  workspace=${cs.workspace.dir}\n  权限=${cs.permissions}`;
    cs.chat = [...(cs.chat || []), `› /status`, t];
    pushStateFor(cid);
    persistCurrentChat(cs);
    return { handled: true };
  }
  if (cmd === "/clear") {
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
    return { handled: true };
  }
  if (cmd === "/sessions") {
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
    return { handled: true };
  }
  if (cmd === "/help") {
    const cmds = await ensureMcodeCommands();
    const lines = ["● 可用命令："];
    for (const c of cmds.webui) lines.push(`  /${c.name} — ${c.desc}`);
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
      lines.push(`  (mcode 命令待拉取，第一次 /help 时已触发…)`);
    }
    const t = lines.join("\n");
    cs.chat = [...(cs.chat || []), `› /help`, t];
    pushStateFor(cid);
    persistCurrentChat(cs);
    return { handled: true };
  }
  if (cmd === "/usage") {
    await runUsageQuery(cs, cid);
    return { handled: true };
  }
  if (cmd === "/stop") {
    const { getActiveChild } = await import("./state-bus.js");
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
  return { handled: false };
}
