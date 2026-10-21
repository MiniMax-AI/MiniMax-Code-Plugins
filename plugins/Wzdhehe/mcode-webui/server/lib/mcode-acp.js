// webui/server/lib/mcode-acp.js
// mcode acp protocol streaming — streamAcpPrompt + runMcodeAcp.

import { McodeAcpClient } from "../../acp.mjs";
import { DEFAULT_WORKSPACE, DEFAULT_MODEL } from "./config.js";
import { streamUpdateLine } from "./sessions.js";
import {
  setActiveChild,
  clearActiveChild,
  pushStateFor,
  getCidsByMcodeSession,
} from "./state-bus.js";
import { applyMavisUsageToCs } from "./mavis-usage.js";
import {
  getMcodeSessionTitle,
  invalidateMcodeSessionsCache,
  getMcodeSessionsForWorkspace,
} from "./acp-client.js";
import { getMcodeModelLimit } from "./models.js";
import { loadSessions, saveSessions } from "./sessions.js";

// v0.5.ah: 走 mcode acp 协议 — 替代 mcode exec 的流式
// v0.5.ai: per-cid — opts.cs/cs.cid
// v0.5.al: 读 cs.workspace.dir（per-cid 可改）— 没有时 fallback DEFAULT_WORKSPACE
// v0.5.bx-19: 如果 webui 端 permission 不是 'Full access', mcode acp 协议层没暴露 permission push,
//   fallback 到 mcode exec (支持 --permission ask/full/auto/off 标志)
export async function runMcodeAcp(content, opts = {}) {
  const label = opts.label || "prompt";
  const existingSid = opts.sessionId || null;
  const cs = opts.cs;
  const cid = opts.cid;
  const workspace =
    (cs && cs.workspace && cs.workspace.dir) || DEFAULT_WORKSPACE;
  // v0.5.bx-19: 非 full permission fallback 到 exec (acp 协议不支持 permission push)
  if (cs && cs.permissions && cs.permissions !== "Full access") {
    const modelToUse = (cs.model && cs.model.name) || DEFAULT_MODEL;
    // Note: collectExecResult is imported lazily to avoid circular import
    const { collectExecResult } = await import("./mcode-exec.js");
    const { runMcodeExec } = await import("./mcode-exec.js");
    return await collectExecResult(
      runMcodeExec(content, {
        label: "prompt",
        sessionId: existingSid,
        model: modelToUse,
        cs,
        cid,
      }),
    );
  }
  const client = new McodeAcpClient({ debug: false });
  let sid = existingSid;
  try {
    await client.start();
    if (sid) {
      try {
        await client.loadSession(sid, workspace);
      } catch (e) {
        console.warn(
          `[webui] acp session/load ${sid} failed: ${e.message}; creating new`,
        );
        sid = null;
      }
    }
    if (!sid) {
      const r = await client.newSession(workspace);
      sid = r.sessionId;
    }
    return await streamAcpPrompt(client, sid, content, label, cs, cid);
  } catch (e) {
    return {
      status: "failed",
      error: { message: e.message },
      sessionId: sid,
      answer: null,
      thinking: null,
    };
  } finally {
    clearActiveChild(cid);
    client.stop();
  }
}

// 类似 collectExecResult，但事件源是 acp client 的 prompt callback
// v0.5.ai: per-cid — cs/cs.cid
function streamAcpPrompt(client, sid, content, label, cs, cid) {
  return new Promise((resolve) => {
    const r = {
      answer: null,
      thinking: null,
      status: "unknown",
      error: null,
      usage: null,
      sessionId: sid,
      durationMs: null,
      stopReason: null,
      tps: null,
    };
    const t0 = Date.now();
    cs.running = {
      active: true,
      prompt: label,
      pid: null,
      startedAt: t0,
      model: cs.model.name,
      sessionId: sid,
      lastDeltaAt: t0,
      tps: 0,
    };
    cs.context.thinkingStatus = "Running";
    setActiveChild(cid, client);
    pushStateFor(cid);
    const safetyTimeout = setTimeout(() => {
      if (r.status === "unknown") {
        r.status = "timeout";
        r.error = { message: "mcode acp prompt did not return in 90s" };
        try {
          client.stop();
        } catch {}
        finalize();
      }
    }, 90000);
    function finalize() {
      if (r._finalized) return;
      r._finalized = true;
      clearTimeout(safetyTimeout);
      r.durationMs = r.durationMs || Date.now() - t0;
      clearActiveChild(cid);
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
      cs.context.tps = 0;
      // v0.5.bx: 去掉流式光标 ▍（streamUpdateLine 边推边加，finalize 必须清）
      // 否则 thinking 块/answer 块会被永久 mark 为 streaming，对话结束还闪
      if (Array.isArray(cs.chat)) {
        cs.chat = cs.chat.map((line) =>
          typeof line === "string" && line.endsWith(" ▍")
            ? line.slice(0, -2)
            : line,
        );
      }
      if (r.usage) {
        cs.context.tokens =
          (cs.context.tokens || 0) + (r.usage.totalTokens || 0);
        cs.context.used = cs.context.tokens;
        cs.context.percent = cs.context.limit
          ? Math.round((cs.context.tokens / cs.context.limit) * 100)
          : 0;
        cs.context.lastUsageAt = Date.now();
        cs.usage.sessionInput =
          (cs.usage.sessionInput || 0) + (r.usage.inputTokens || 0);
        cs.usage.sessionOutput =
          (cs.usage.sessionOutput || 0) + (r.usage.outputTokens || 0);
        cs.usage.sessionTotal = cs.usage.sessionInput + cs.usage.sessionOutput;
        cs.context.estimated = false; // mcode 0.1.5+ 真实值
      } else if (r.answer || r.thinking) {
        // v0.5.bx-9: mcode 0.1.4 acp 不返 usage / 不发 usage_update, 用 thinking + answer 长度粗略估算 token
        const outText = (r.thinking || "") + (r.answer || "");
        const estOutTokens = Math.ceil(outText.length / 3);
        const lastUserLine = [...(cs.chat || [])]
          .reverse()
          .find((l) => typeof l === "string" && l.startsWith("› "));
        const userLen = lastUserLine ? lastUserLine.length : 0;
        const estInTokens = Math.ceil(userLen / 3);
        const estTotal = estOutTokens + estInTokens;
        cs.context.tokens = (cs.context.tokens || 0) + estTotal;
        cs.context.used = cs.context.tokens;
        cs.context.estimated = true;
        cs.context.percent = cs.context.limit
          ? Math.round((cs.context.tokens / cs.context.limit) * 100)
          : 0;
        cs.context.lastUsageAt = Date.now();
        cs.usage.sessionInput = (cs.usage.sessionInput || 0) + estInTokens;
        cs.usage.sessionOutput = (cs.usage.sessionOutput || 0) + estOutTokens;
        cs.usage.sessionTotal = cs.usage.sessionInput + cs.usage.sessionOutput;
        if (process.env.MCODE_USAGE_DEBUG) {
          console.log(
            `[usage.estimate.acp] cid=${cid} outLen=${outText.length} estOut=${estOutTokens} userLen=${userLen} estIn=${estInTokens} total=${estTotal} (mcode 0.1.4 不返 usage, 用估算)`,
          );
        }
      }
      // v0.5.bx-7: debug — 看 mcode 0.1.4 实际给的 usage 数据
      if (process.env.MCODE_USAGE_DEBUG) {
        console.log(
          `[finalize.usage] cid=${cid} r.usage=${JSON.stringify(r.usage)} r.answerLen=${(r.answer || "").length} r.thinkingLen=${(r.thinking || "").length}`,
        );
      }
      if (r.sessionId) cs.mcodeSessionId = r.sessionId;
      // v0.5.bx-10: fire-and-forget 从 mavis db 拿真值覆盖估算
      //   mavis hook 在 mcode acp 完成后会写 local_runtime_token_usage row
      //   等 400ms 让 mavis 落盘, 然后查 db 拿真值
      //   如果 mavis db 没有数据 (rows=0), 保留估算 + 标 estimated=true
      //   如果有真值, 用真值覆盖 (estimated=false)
      if (r.sessionId) {
        const mavisSid = r.sessionId;
        setTimeout(() => {
          applyMavisUsageToCs(cs, mavisSid, { getMcodeModelLimit })
            .then((applied) => {
              if (!applied && process.env.MCODE_USAGE_DEBUG)
                console.log(
                  `[usage.mavis] cid=${cid} sid=${mavisSid} no data in db, keep estimate`,
                );
              if (process.env.MCODE_USAGE_DEBUG && applied) {
                console.log(
                  `[usage.mavis] cid=${cid} sid=${mavisSid} (覆盖估算)`,
                );
              }
              pushStateFor(cid);
              // v0.5.bx-29: 同一 mcodeSessionId 的其它 cid (手机 + 电脑开同一 session) 也要更新
              //   修: 之前只有发起 prompt 的 cid 更新 context, 其它 CID 一直看估算
              const others = getCidsByMcodeSession(mavisSid).filter(
                (o) => o.cid !== cid,
              );
              if (process.env.MCODE_USAGE_DEBUG && others.length > 0) {
                console.log(
                  `[usage.mavis.broadcast] sid=${mavisSid} → ${others.length} other cid(s): ${others.map((o) => o.cid).join(",")}`,
                );
              }
              for (const { cid: otherCid, cs: otherCs } of others) {
                applyMavisUsageToCs(otherCs, mavisSid, { getMcodeModelLimit })
                  .then(() => pushStateFor(otherCid))
                  .catch(() => {});
              }
            })
            .catch((e) => {
              if (process.env.MCODE_USAGE_DEBUG)
                console.warn(`[usage.mavis] cid=${cid} error: ${e.message}`);
              pushStateFor(cid);
            });
        }, 400);
      }
      // v0.5.bx: prompt 完成后用 mcodeSessionId 反查 mcode 真实 title
      if (r.sessionId) {
        const finalSid = r.sessionId;
        getMcodeSessionTitle(finalSid)
          .then((title) => {
            if (!title) return;
            // 只在用户没改过（仍是默认标题）时更新
            const isDefault =
              !cs.sessionTitle ||
              cs.sessionTitle === "New session" ||
              cs.sessionTitle === "Untitled";
            if (isDefault && cs.mcodeSessionId === finalSid) {
              cs.sessionTitle = title;
              // 同步到 webui session db（写 mcodeSessionId + title，让 sidebar 能 1:1 找回来）
              if (cs.sessionId) {
                try {
                  const all = loadSessions();
                  const item = all.find((s) => s.id === cs.sessionId);
                  if (item) {
                    item.title = title;
                    item.mcodeSessionId = finalSid;
                    item.updatedAt = Date.now();
                    saveSessions(all);
                  }
                } catch (e) {
                  console.warn(`[bx] save title/mcodeSid failed: ${e.message}`);
                }
              }
              pushStateFor(cid);
            }
          })
          .catch((e) =>
            console.warn(`[bx] getMcodeSessionTitle: ${e.message}`),
          );
        // v0.5.bv: 失效 mcode sessions cache + 异步拉新 list 推给 client
        invalidateMcodeSessionsCache();
        getMcodeSessionsForWorkspace(cs.workspace && cs.workspace.dir)
          .then(() => {
            pushStateFor(cid);
          })
          .catch(() => {});
      }
      pushStateFor(cid);
      resolve(r);
    }
    client
      .prompt(sid, content, (c) => {
        // v0.5.bm: 详细日志 — 看到 mcode acp 返回了什么
        console.log(
          `[acp.cb] kind=${c.kind} text=${JSON.stringify((c.text || "").slice(0, 200))} data=${JSON.stringify(c.data || "").slice(0, 200)}`,
        );
        // v0.5.bm: 处理 error 事件
        if (c.kind === "error" || c.error) {
          r.error = { message: c.text || c.error || JSON.stringify(c) };
          r.status = "failed";
          finalize();
          return;
        }
        if (c.kind === "usage" && c.update) {
          // v0.5.bx: mcode acp usage_update 事件（{used, size, cost} — 当前 session 已用 vs 上限）
          // 字段是累计值，直接覆盖 cs.context
          const u = c.update;
          if (process.env.MCODE_USAGE_DEBUG)
            console.log(`[usage.chunk] cid=${cid} update=${JSON.stringify(u)}`);
          if (typeof u.used === "number") {
            cs.context.used = u.used;
            cs.context.tokens = u.used;
          }
          if (typeof u.size === "number" && u.size > 0) {
            cs.context.limit = u.size;
          }
          if (cs.context.limit) {
            cs.context.percent = Math.round(
              (cs.context.used / cs.context.limit) * 100,
            );
          }
        } else if (c.kind === "thought" && typeof c.text === "string") {
          r.thinking = (r.thinking || "") + c.text;
          const oneLine = r.thinking.replace(/\n+/g, " ").trim();
          streamUpdateLine(cs.chat, "▲", oneLine);
        } else if (c.kind === "message" && typeof c.text === "string") {
          r.answer = (r.answer || "") + c.text;
          const oneLine = r.answer.replace(/\n+/g, " ").trim();
          streamUpdateLine(cs.chat, "●", oneLine);
        } else if (c.kind === "tool_call" && c.update) {
          // v0.5.bs: 工具调用开始 — 写 `→ toolName` 行到 chat
          const u = c.update;
          const name = u.title || u.name || u.toolName || "tool";
          const input = u.rawInput ? JSON.stringify(u.rawInput) : "";
          const line = input ? `→ ${name}  ${input}` : `→ ${name}`;
          cs.chat = [...cs.chat, line];
          // 记下这行在 chat 里的位置（之后 tool_update 用来在它后面插输出）
          if (!r.toolIndexById) r.toolIndexById = new Map();
          r.toolIndexById.set(u.toolCallId, cs.chat.length - 1);
        } else if (c.kind === "tool_update" && c.update) {
          // v0.5.bs: 工具完成 — 在 `→ toolName` 行后插入输出行（`  text` 缩进标识）
          // v0.5.bx-6: 0.1.4+ mcode acp 的 tool_call_update 带 locations: [{path: "..."}]
          //   那些被工具读/写/编辑的本地文件路径 — 显示成 `  @ /path/to/file` 行（@ 前缀方便 client 识别）
          const u = c.update;
          const status = u.status || "completed";
          const rawOutput = u.rawOutput;
          // 抽 rawOutput.content[].text
          const outText =
            rawOutput && Array.isArray(rawOutput.content)
              ? rawOutput.content
                  .filter((c) => c.type === "text")
                  .map((c) => c.text)
                  .join("\n")
              : "";
          const insertAfter =
            (r.toolIndexById && r.toolIndexById.get(u.toolCallId)) ??
            cs.chat.length - 1;
          const newLines = [];
          // status 行（completed / failed / in_progress）
          newLines.push(`  [${status}]`);
          if (outText) {
            // 多行输出，每行都加 `  ` 前缀，跟在 `→ toolName` 后面读起来整齐
            for (const ln of outText.split("\n")) newLines.push("  " + ln);
          }
          // v0.5.bx-6: tool 涉及的本地文件路径
          if (Array.isArray(u.locations) && u.locations.length > 0) {
            const seen = new Set();
            for (const loc of u.locations) {
              const p = loc && loc.path;
              if (typeof p === "string" && p && !seen.has(p)) {
                seen.add(p);
                newLines.push(`  @ ${p}`);
              }
            }
          }
          if (u.error)
            newLines.push(
              `  ! ${typeof u.error === "string" ? u.error : u.error.message || JSON.stringify(u.error)}`,
            );
          // 插到 → 行后面
          cs.chat = [
            ...cs.chat.slice(0, insertAfter + 1),
            ...newLines,
            ...cs.chat.slice(insertAfter + 1),
          ];
          // 后续 tool 行的 index 都要往后挪 newLines.length
          if (r.toolIndexById) {
            for (const [k, v] of r.toolIndexById) {
              if (v > insertAfter) r.toolIndexById.set(k, v + newLines.length);
            }
          }
        } else if (c.kind === "plan_update" && c.update) {
          // v0.5.bx-9: mcode 0.1.5+ 暴露 plan_update 事件
          const u = c.update;
          cs.plan = {
            active: true,
            planId: u.planId || null,
            title: u.title || "",
            summary: u.summary || "",
            options: Array.isArray(u.options)
              ? u.options.map((o) => ({
                  label: o.label || "",
                  desc: o.description || o.desc || "",
                }))
              : [],
          };
          console.log(
            `[plan.update] cid=${cid} planId=${cs.plan.planId} title="${(u.title || "").slice(0, 50)}" options=${cs.plan.options.length}`,
          );
        } else if (c.kind === "plan_removed" && c.update) {
          cs.plan = {
            active: false,
            planId: null,
            title: null,
            summary: "",
            options: [],
          };
          console.log(`[plan.removed] cid=${cid}`);
        } else if (c.kind === "mode_update" && c.update) {
          // v0.5.bx-9: mcode 切模式 (plan/ask/normal)
          const u = c.update;
          const mode = u.mode || u.currentMode || null;
          if (mode === "plan") {
            cs.enterPlanMode = {
              active: true,
              prompt: u.prompt || u.message || null,
            };
          } else {
            cs.enterPlanMode = { active: false, prompt: null };
          }
          console.log(`[mode.update] cid=${cid} mode=${mode}`);
        } else if (c.kind === "goal_update" && c.update) {
          // mcode 0.1.5 acp 协议里 goal_update 实际上不一定发 (cli.js 搜不到此事件 type 字面量)
          // 但保留 handler — 如果未来 mcode 0.1.6+ 加了, 直接用
          const u = c.update;
          cs.goal = {
            active: !!u.active,
            text: u.text || u.description || null,
            status: u.status || null,
            duration: u.duration || null,
          };
          console.log(
            `[goal.update] cid=${cid} active=${cs.goal.active} status=${cs.goal.status}`,
          );
        } else if (c.kind === "config_option_update" && c.update) {
          // v0.5.by: mcode acp 0.1.5 推的 config 变化事件
          // 典型场景: 别的客户端改了 permissionMode / model, webui 同步本地 cs
          const u = c.update;
          if (u && u.key === "permissionMode") {
            // 反向映射 mcode value → webui label
            const label =
              u.value === "bypassPermissions"
                ? "Full access"
                : u.value === "auto"
                  ? "Auto"
                  : u.value === "read"
                    ? "Read"
                    : u.value === "off"
                      ? "Off"
                      : "Ask";
            cs.permissions = label;
            console.log(
              `[config.option] cid=${cid} permissionMode=${u.value} → label=${label}`,
            );
          } else if (u && u.key) {
            console.log(
              `[config.option] cid=${cid} ${u.key}=${JSON.stringify(u.value).slice(0, 80)}`,
            );
          }
        } else if (c.kind === "session_info_update" && c.update) {
          // v0.5.by: mcode acp 0.1.5 推的 session info 变化
          // 字段暂未知 (mcode 0.1.5 文档没列), 收到就 log, 不盲改 cs
          const u = c.update;
          console.log(
            `[session.info] cid=${cid} keys=${JSON.stringify(Object.keys(u || {})).slice(0, 200)}`,
          );
        } else if (c.kind === "other" && c.update) {
          const u = c.update;
          if (u && u.sessionUpdate) {
            console.log(
              `[acp.other.event] sessionUpdate=${u.sessionUpdate} keys=${JSON.stringify(Object.keys(u)).slice(0, 200)}`,
            );
          }
        }
        const now = Date.now();
        if (cs.running.lastDeltaAt) {
          const dt = (now - cs.running.lastDeltaAt) / 1000;
          if (dt > 0) cs.running.tps = Math.round(1 / dt);
        }
        cs.running.lastDeltaAt = now;
        cs.context.tps = cs.running.tps;
        pushStateFor(cid);
      })
      .then((result) => {
        r.answer = result.answer || r.answer;
        r.thinking = result.thinking || r.thinking;
        r.stopReason = result.stopReason;
        // v0.5.bx: 捕获 mcode 返的 usage（totalTokens/inputTokens/outputTokens/thoughtTokens）
        if (result.usage) r.usage = result.usage;
        r.status = "succeeded";
        finalize();
      })
      .catch((e) => {
        r.status = "failed";
        r.error = { message: e.message };
        finalize();
      });
  });
}
