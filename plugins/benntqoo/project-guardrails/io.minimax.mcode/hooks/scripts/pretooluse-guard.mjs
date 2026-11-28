// PreToolUse 钩子 —— 执行 <repo>/.agents/guardrails.json（优先）或
// <repo>/.minimax/guardrails.json 里的工具规则。
//
// matcher 在 hooks.json 里**故意省略**（= 匹配所有工具），因为规则可以针对任意工具。
// 代价是每次工具调用都会 spawn 一次本进程。实际顺序：读 stdin → 认事件 → 就近定位
// 项目根（逐级 existsSync）→ loadGuardrails 里才做规则文件存在性检查 —— 没有规则
// 文件就立刻退出，总开销 ≈ node 启动 + 一次目录上行。
//
// 输出：hookSpecificOutput.permissionDecision = "deny" | "ask"。
// 多方决策合并规则是 deny > ask > 其它；「放行」= 空输出，绝不显式发 allow。
//
// ⚠️ 工具名用 MiniMax 的**原生小写名**（bash / read / write / edit / task）。
// 配置文件里写 "Bash" 或 "Write" 也能命中 —— 匹配时两边都会转小写。

import { readStdinAsync, field, emitPermission, emitPass } from "../lib/io.mjs";
import { resolveProject } from "../lib/project.mjs";
import { evaluate, loadGuardrails, matchText } from "../lib/guard.mjs";

const payload = await readStdinAsync();

// 闸 1：只处理 PreToolUse
if (field(payload, "hook_event_name", "hookEventName") !== "PreToolUse") emitPass();

const cwd = field(payload, "cwd") || process.cwd();
let ctx;
try {
  ctx = resolveProject(cwd);
} catch {
  emitPass();
}
if (ctx.isHome) emitPass(); // home 不是项目 —— 否则规则会全局生效

// 闸 2：快速路径。没有规则文件就没有意见。
const g = loadGuardrails(ctx.root);
if (!g || g.rules.length === 0) emitPass();

const toolName = field(payload, "tool_name", "toolName") || "";
const toolInput = field(payload, "tool_input", "toolInput") || {};
const text = matchText(toolName, toolInput);
if (!text) emitPass();

const hit = evaluate(g, toolName, text);
if (!hit) emitPass(); // 没命中任何规则 → 放行

emitPermission(hit.action, `[guardrails] ${hit.reason}`);
