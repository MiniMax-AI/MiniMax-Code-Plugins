// webui/server/routes/chat.js
// POST /api/send — main chat entry
// POST /api/stop — kill running child for cid
// POST /api/cmd — webui button-driven commands

import { randomUUID } from "node:crypto";
import {
  loadSessions,
  saveSessions,
  persistCurrentChat,
} from "../lib/sessions.js";
import { pushStateFor, getActiveChild } from "../lib/state-bus.js";
import { handleLocalSlash, handleCmdCommand } from "../lib/slash.js";
import { runMcodeAcp } from "../lib/mcode-acp.js";
import { collectExecResult, runMcodeExec } from "../lib/mcode-exec.js";
import { DEFAULT_MODEL } from "../lib/config.js";

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
}

// POST /api/send — main chat entry, fire-and-forget (response = ack; output via /api/events SSE)
export async function handleSend(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  let content = (payload.content || "").trim();
  if (!content) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "content required" }));
  }
  // v0.5.bx-13: ask_user 弹窗答案 — 不当 user message 加到 chat
  const isAskAnswer = payload.isAskAnswer === true;
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true }));

  // v0.5.ai: per-cid — 操作 cs (ask 答案跳过, chat 保持干净)
  if (!isAskAnswer) {
    cs.chat = [...(cs.chat || []), `› ${content}`];
    // v0.5.bx-32: 真正发消息时记 lastUsedWorkspace — sidebar 排序时该工作区置顶
    //   之前切 session 也写,用户点 c 区对话 (不发消息) c 区就自动置顶了 — 体验不对
    //   切 session 不算发消息,所以切 session 时不写 (在 routes/sessions.js handleSwitchSession 已删)
    //   ask_user 答案不算发消息,也不写
    cs.lastUsedWorkspace = (cs.workspace && cs.workspace.dir) || null;
    pushStateFor(cid);
    persistCurrentChat(cs);
  }

  // v0.5.ak: 发首条消息时如果 cs.sessionId 为空，先建一个 webui session entry
  if (!cs.sessionId) {
    const all = loadSessions();
    const id = randomUUID();
    const item = {
      id,
      title: "New session",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      chat: cs.chat || [],
    };
    all.unshift(item);
    saveSessions(all);
    cs.sessionId = id;
  }

  // Detect slash commands that we can satisfy without spawning mcode
  const slashResult = await handleLocalSlash(content, cs, cid);
  if (slashResult.handled) {
    if (slashResult.continueMcode && slashResult.rewriteContent !== undefined) {
      content = slashResult.rewriteContent;
      // fall through to mcode call
    } else {
      return;
    }
  }

  // v0.5.ah: 走 mcode acp 协议（默认）— MCODE_USE_ACP=0 切回 mcode exec 逃生
  const modelToUse = (cs && cs.model && cs.model.name) || DEFAULT_MODEL;
  console.log(
    `[send] cid=${cid} content=${JSON.stringify(content.slice(0, 80))} model=${modelToUse} sessionId=${cs.mcodeSessionId} workspace=${(cs && cs.workspace && cs.workspace.dir) || "null"}`,
  );
  const t0 = Date.now();
  const r =
    process.env.MCODE_USE_ACP === "0"
      ? await collectExecResult(
          runMcodeExec(content, {
            label: "prompt",
            sessionId: cs.mcodeSessionId,
            model: modelToUse,
            cs,
            cid,
          }),
        )
      : await runMcodeAcp(content, {
          label: "prompt",
          sessionId: cs.mcodeSessionId,
          model: modelToUse,
          cs,
          cid,
        });
  console.log(
    `[send] result ${Date.now() - t0}ms:`,
    JSON.stringify({
      status: r.status,
      error: r.error,
      answer: r.answer && r.answer.slice(0, 80),
      sessionId: r.sessionId,
    }).slice(0, 500),
  );
  if (r.status === "succeeded" && r.answer) {
    // v0.5.bx-4: 流式输出已经在 streamAcpPrompt/streamUpdateLine 里把 ▲ 和 ● 行写进 chat 了
    const oneLine = r.answer.replace(/\n+/g, " ").trim();
    let lastAnsIdx = -1;
    for (let i = cs.chat.length - 1; i >= 0; i--) {
      if (typeof cs.chat[i] === "string" && cs.chat[i].startsWith("● ")) {
        lastAnsIdx = i;
        break;
      }
    }
    if (lastAnsIdx >= 0) {
      cs.chat[lastAnsIdx] = `● ${oneLine}`;
    } else {
      cs.chat = [...cs.chat, `● ${oneLine}`];
    }
    cs.context.assistantLast = oneLine;
    cs.context.assistantAt = Date.now();
  } else if (r.status === "failed" || r.error) {
    const rawMsg = (r.error?.message || r.status).replace(/\n+/g, " ");
    let oneLine = rawMsg;
    let hint = "";
    if (/Questionnaire|user input/i.test(rawMsg)) {
      hint = " (Ask 工具在 webui/exec 模式不可用，请直接用输入框发问)";
    } else if (/requires.*input|interactive/i.test(rawMsg)) {
      hint = " (此工具需要交互模式，webui 暂不支持)";
    }
    cs.chat = [...cs.chat, `! [error] ${oneLine}${hint}`];
    cs.context.assistantLast = `[error] ${oneLine}`;
    cs.context.assistantAt = Date.now();
  }
  persistCurrentChat(cs);
  pushStateFor(cid);
}

// POST /api/stop — 中断正在跑的 prompt
// v0.5.by: 优先走 mcode acp session/cancel RPC (温和取消 — 让 mcode 走 finalize),
//   走不通再 hard kill child process (兜底)
// 注意: mcode 0.1.5 acp 不支持 session/cancel (probe 实测 "Method not found"),
//   所以 cancelled 永远是 false, 直接走 hard kill
// 旧实现: 永远 child.kill() — 太粗暴,会让 mcode acp 进程直接 SIGKILL,
//   同进程里的 background task 也会被 runtime-shutdown 杀 (子 agent 跑不完的根因之一)
export async function handleStop(_req, res, ctx) {
  const cid = ctx.cid;
  const cs = ctx.cs;
  const child = getActiveChild(cid);
  const wasRunning = !!child;
  let cancelled = false;
  let hardKilled = false;
  // 1. 温和路径: 调 session/cancel RPC
  //    mcode 0.1.5 不支持 — r.ok=false, code='unsupported'
  if (cs && cs.mcodeSessionId) {
    try {
      const { cancelSession } = await import("../lib/mcode-rpc.js");
      const r = await cancelSession(cs.mcodeSessionId);
      if (r.ok) cancelled = true;
      else if (r.code !== "unsupported") {
        // 真错 (不是不支持) — 记下来排查
        console.warn(
          `[stop] session/cancel failed cid=${cid}: ${r.error} (code=${r.code})`,
        );
      }
    } catch (e) {
      console.warn(`[stop] session/cancel threw cid=${cid}: ${e.message}`);
    }
  }
  // 2. 兜底路径: hard kill child (RPC 不支持或失败)
  if (child && !cancelled) {
    try {
      child.kill();
    } catch {}
    hardKilled = true;
  }
  // 3. 兜底路径 2: 设个 2s timeout, 如果 mcode acp 没通过 cancel 退出, 也强 kill
  //    (避免 mcode 还在 prompt 不响应时 webui 显示 "已停止" 但实际还在跑)
  //    缓存 child.child 引用, 因为 2s 后 child.stop() 可能已经把它置 null
  if (child) {
    const rawChild = child.child; // 缓存 node child_process 实例
    setTimeout(() => {
      try {
        if (rawChild && !rawChild.killed && rawChild.exitCode === null) {
          console.log(
            `[stop] cid=${cid} child still alive 2s after stop, force-killing`,
          );
          child.kill();
        }
      } catch {}
    }, 2000).unref();
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      wasRunning,
      cancelled,
      hardKilled,
      note: cancelled
        ? "gentle cancel"
        : "hard kill (mcode 0.1.5 acp 不支持 session/cancel)",
    }),
  );
}

// POST /api/cmd — webui button-driven commands
export async function handleCmd(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  const cmd = (payload.cmd || "").trim();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true }));
  await handleCmdCommand(cmd, cs, cid);
}
