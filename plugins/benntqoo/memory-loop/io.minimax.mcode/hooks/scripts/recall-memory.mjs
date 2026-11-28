// SessionStart 钩子 —— 把项目级蒸馏记忆注入上下文。
//
// 这是「记忆闭环」里唯一真正让记忆**生效**的一步：钩子是外部往上下文里塞内容的
// 唯一入口（技能是按需调用的工具，开场不会自动加载）。
//
// 注入两样东西，都只在有内容时才发：
//  1. <repo>/.agents/memory/MEMORY.md —— 蒸馏后的长期记忆（截断到 MAX_CHARS）
//  2. 一句待办提示 —— 仅当存在未蒸馏候选时

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readStdinAsync, field, emitContext, emitPass } from "../lib/io.mjs";
import { resolveProject } from "../lib/project.mjs";
import { readJsonl, readState } from "../lib/store.mjs";

// 注入越多越占上下文预算，默认 4000 字符。
const MAX_CHARS = Number(process.env.MEMORY_LOOP_MAX_CHARS) || 4000;

const payload = await readStdinAsync();

if (field(payload, "hook_event_name", "hookEventName") !== "SessionStart") emitPass();

const cwd = field(payload, "cwd") || process.cwd();
let ctx;
try {
  ctx = resolveProject(cwd);
} catch {
  emitPass();
}
// home 不是项目 —— 放弃，否则等于把全局目录当项目写。
if (ctx.isHome) emitPass();

const memFile = join(ctx.memoryDir, "MEMORY.md");
const candFile = join(ctx.memoryDir, "candidates.jsonl");
const stateFile = join(ctx.memoryDir, "state.json");

const parts = [];

if (existsSync(memFile)) {
  let mem = "";
  try {
    mem = readFileSync(memFile, "utf-8").trim();
  } catch {
    mem = "";
  }
  if (mem) {
    if (mem.length > MAX_CHARS) {
      mem = `${mem.slice(0, MAX_CHARS)}\n… (truncated; the full content is in ${memFile})`;
    }
    parts.push(`[memory-loop] Project long-term memory (${memFile}):\n${mem}`);
  }
}

// 只有「有新的、还没蒸馏的候选」时才提示，避免每次开会话都唠叨。
const candCount = readJsonl(candFile).length;
const distilled = Number(readState(stateFile, { distilled: 0 }).distilled) || 0;
if (candCount > distilled) {
  parts.push(
    `[memory-loop] ${candCount - distilled} candidate(s) waiting to be distilled (${candCount} in total, ${candFile}).` +
      `Ask me to \"distill the memory\" when you want that — skipping it does not affect the current task.`
  );
}

// 插件根路径随注入一起给出。
//
// 为什么：蒸馏技能要调用本插件的 CLI（status/commit），而 CLI 的位置随安装路径而变 ——
// 插件可能装在任何数据目录里。把绝对路径写死在 SKILL.md 里既不可移植，也会把
// 本机路径泄露进仓库。钩子进程拿得到 PLUGIN_ROOT，在这里告诉模型一次即可。
if (parts.length === 0) emitPass();

const pluginRoot = process.env.PLUGIN_ROOT || process.env.MINIMAX_PLUGIN_ROOT || "";
if (pluginRoot) {
  parts.push(`[memory-loop] Plugin root (the distillation Skill calls the CLI from here): ${pluginRoot}`);
}

emitContext("SessionStart", parts.join("\n\n"));
