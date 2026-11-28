// Hook — stop-skill-nudge.mjs  (Stop, 无 matcher)
//
// 作用：每轮结束时判断「本轮值不值得沉淀成 skill，而 agent 又没沉淀」。
// 命中则用 decision:block 推模型继续一轮，让它写 skill 或说明为何不写。
//
// 防打扰三道闸（缺一不可）：
//   1. stop_hook_active === true → 放行（这是因 block 而继续的那一轮，防震荡）
//   2. 每个 session 最多推 1 次（状态文件节流）
//   3. 信号保守：必须同时命中「完成动作 + 经验信号 + 具体路径」，且回复里没提到 SKILL.md
//
// 设计取舍：不做静默沉淀。Stop block 会让模型多跑一整轮，用户要等、token 要烧。
// 所以这里只兜底，主要驱动力放在 skill-forge 技能本身（MiniMax 每轮注入技能清单，
// 模型按 description 语义触发）。
//
// ⚠️ MiniMax 规定：stop_hook_active=true 时必须放行，否则一次 Stop 最多能把模型
// 逼成连跑 8 轮。本文件第 1 道闸就是为这条规则服务的。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStdinAsync, field, emitPass, emitBlockStop, pluginDataDir } from "../lib/io.mjs";
import { resolveSkillTarget } from "../lib/project.mjs";

const payload = await readStdinAsync();
const eventName = field(payload, "hook_event_name", "hookEventName");

if (eventName !== "Stop") {
  emitPass();
}

// 闸 1：因 Stop block 而继续的那一轮，不再重复推
if (field(payload, "stop_hook_active", "stopHookActive") === true) {
  emitPass();
}

const message = field(payload, "last_assistant_message", "lastAssistantMessage") || "";
const sessionId = field(payload, "session_id", "sessionId") || "unknown";

if (message.trim().length < 80) {
  emitPass();
}

// 闸 3 之一：已经在沉淀了就不再推
if (/SKILL\.md|\.minimax[\\/]skills|skills[\\/][a-z0-9-]+[\\/]/i.test(message)) {
  emitPass();
}

// ---- 信号 ----
// 注意：中文不加 \b —— CJK 不属于 \w，\b 在中文边界不生效，会漏匹配
// 中英文并列：只认中文动词会让英文会话里的提醒永不触发。
const DONE_RE =
  /(?:已(?:完成|实现|修复|配置|跑通|接入|部署|创建|重构)|跑通了?|搞定了?|worked|wrote|implemented|configured|completed|finished|fixed|refactored|got it working)/i;

const LESSON_RE =
  /(?:坑|踩坑|陷阱|注意[:：]|教训|关键点|要点|根因|绕(?:过|开)|而不是|正确的是|必须用|不能用|gotcha|pitfall|root cause|caveat|note:|beware|must not|should not|instead of)/i;

const PATH_RE = /(?:[\w.-]+[\\/][\w.-]+[\\/][\w.-]+|[\w-]+\.(?:js|ts|kt|py|json|md|toml|ya?ml|gradle|exe))/;

if (!(DONE_RE.test(message) && LESSON_RE.test(message) && PATH_RE.test(message))) {
  emitPass();
}

// ---- 落点：写进当前项目，不是全局库 ----
// 插件是全局安装的，任何工作区都会跑这个钩子，所以路径必须按本次会话的 cwd 现算。
// 保护：工作区就是 home 时，项目级落点与用户级位置语义重合 —— 直接放行。
const target = resolveSkillTarget(field(payload, "cwd"));

if (target.isUserLevel) {
  emitPass();
}

const skillsDirForMsg = target.skillsDir.replace(/\\/g, "/");

// 闸 2：每 session 最多推 1 次
// 状态落在插件数据目录（PLUGIN_DATA），宿主托管的可写位置。
const statePath = join(pluginDataDir(), "nudge-state.json");

// 状态文件只增不减会长大 —— 只保留最近这么多个会话
const MAX_TRACKED = 200;

let state = {};
try {
  if (existsSync(statePath)) {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
    state = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }
} catch {
  state = {};
}

if ((state[sessionId] || 0) >= 1) {
  emitPass();
}

// 记账（先写再输出，避免写失败导致重复推送）
state[sessionId] = (state[sessionId] || 0) + 1;

// 剪枝：对象键保持插入序，所以砍头部就是砍最老的会话
const tracked = Object.keys(state);
if (tracked.length > MAX_TRACKED) {
  for (const k of tracked.slice(0, tracked.length - MAX_TRACKED)) delete state[k];
}

try {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state), "utf-8");
} catch {
  // 记账失败不阻塞
}

emitBlockStop(
  [
    "This turn looks like it worked out a non-obvious procedure (a completion action, an",
    "experience signal, and a concrete path were detected).",
    "",
    "Before you finish, make one distillation decision — pick exactly one:",
    "",
    "A. There is something reusable → write it to `" + skillsDirForMsg + "/<kebab-name>/SKILL.md`,",
    "   the skill directory of **this project**. Never the user-level skills directory — that",
    "   is a global library and would leak into every project.",
    "   The frontmatter needs at least name / description; the description states WHEN to use",
    "   it (trigger conditions first).",
    "   Report the path in one line when you are done.",
    "",
    "B. There is genuinely nothing reusable (a one-off operation / a project-specific detail /",
    "   already covered by another skill) → just say \"nothing to distill this turn, because: ...\"",
    "   and do not write any file.",
    "",
    "Do not write a low-quality skill just because you were pushed — every skill costs budget",
    "in the per-turn skill list.",
  ].join("\n")
);
