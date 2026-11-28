// SessionStart 钩子 —— 把 <repo>/.agents/guardrails.json（优先）或
// <repo>/.minimax/guardrails.json 的 context 注入上下文。
//
// 补的是这个缺口：MiniMax Code 的**项目级 hooks 要在「设置 → 钩子 → 项目」里手动打开**，
// 而且改动声明会把它重新关掉 —— 项目想自带行为约束，门槛很高。
// 这个用户级插件代替项目级钩子去读项目里的声明文件，于是「项目说了算」重新成立。
//
// 与用户级全局黑名单的分工：
//   全局兜底  = 对所有项目一样的灾难性命令黑名单
//   本插件    = 项目级增量规则（只在这个项目里生效）
// 两者叠加，互不冲突：additionalContext 是累积的，permissionDecision 取最严。

import { readStdinAsync, field, emitContext, emitPass } from "../lib/io.mjs";
import { resolveProject } from "../lib/project.mjs";
import { loadGuardrails } from "../lib/guard.mjs";

const payload = await readStdinAsync();

if (field(payload, "hook_event_name", "hookEventName") !== "SessionStart") emitPass();

const cwd = field(payload, "cwd") || process.cwd();
let ctx;
try {
  ctx = resolveProject(cwd);
} catch {
  emitPass();
}
if (ctx.isHome) emitPass(); // home 不是项目

const g = loadGuardrails(ctx.root);
if (!g || g.context.length === 0) emitPass();

const body = g.context.map((s) => `- ${s.trim()}`).join("\n");
emitContext("SessionStart", `[guardrails] Project conventions (${g.path}):\n${body}`);
