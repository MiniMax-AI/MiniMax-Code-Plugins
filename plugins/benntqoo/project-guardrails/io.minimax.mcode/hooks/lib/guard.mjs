// 项目级约束的读取与匹配。
//
// 规则来源：<repo>/.agents/guardrails.json（优先）或 <repo>/.minimax/guardrails.json
//
// 为什么不用工作区级 hooks 直接表达：MiniMax Code 的**项目级 hooks 要用户在
// 「设置 → 钩子 → 项目」里手动打开**，而且改动 hook 的事件 / matcher / 命令 / 超时
// 会把它重新关掉 —— 逐仓库、逐次都要过这道闸，门槛很高。
// 用户级插件钩子则直接派发、不过这道闸。所以「项目自带行为约束」用用户级插件代理读取。
//
// 为什么首选 `.agents/`：`.minimax/` 常常不在仓库的 .gitignore 里，但它是
// MiniMax 私有的工作区目录；`.agents/` 是跨 agent 共享目录，更适合承载「随仓库走」的
// 协议。两者都保留（前者优先），零破坏。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 项目声明的候选落点，**按序取第一个存在且可解析的**。
 * `.agents/` 在前（可入库、跨 agent 共享），`.minimax/` 回退。
 */
export const RULES_RELS = [".agents/guardrails.json", ".minimax/guardrails.json"];

/**
 * 读文本并去掉 BOM。
 *
 * 为什么必须去：BOM 会让 JSON.parse 直接抛错（Unexpected token \uFEFF），
 * 于是配置被**静默忽略** —— 用户明明写了规则却看不到任何拦截。
 * Windows 上 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 默认就写 BOM，
 * 这是最容易踩到的一条，所以这里统一剥掉。
 */
function readTextSafe(path) {
  try {
    return readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

/**
 * 找并解析项目配置文件。找不到 → null。
 *
 * 用 `continue` 而非 `return`：`.agents/` 存在但 JSON 坏时，仍应回退试 `.minimax/`。
 * 两处都坏也不算错 —— fail-open 是刻意的（见 loadGuardrails）。
 */
export function readGuardrailsFile(root) {
  for (const rel of RULES_RELS) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;

    const raw = readTextSafe(path);
    if (!raw.trim()) continue;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    return { parsed, path, rel };
  }
  return null;
}

/**
 * 读并规范化规则文件。
 * 文件不存在 / JSON 坏 / 字段非法 → 返回 null，调用方一律放行（fail-open）。
 *
 * 为什么 fail-open：这是**用户自己写的项目配置**，不是安全边界。
 * 读不到就当没配，绝不能因为配置写错而把整个会话卡死。
 */
export function loadGuardrails(root) {
  const found = readGuardrailsFile(root);
  if (!found) return null;
  const { parsed, path } = found;

  const context = Array.isArray(parsed.context)
    ? parsed.context.filter((s) => typeof s === "string" && s.trim())
    : [];

  const rules = [];
  if (Array.isArray(parsed.rules)) {
    for (const r of parsed.rules) {
      if (!r || typeof r !== "object") continue;
      const pattern = typeof r.pattern === "string" ? r.pattern : "";
      if (!pattern) continue;

      const action = r.action === "deny" ? "deny" : r.action === "ask" ? "ask" : null;
      if (!action) continue; // 只认 deny / ask，其它一律忽略

      let re;
      try {
        // 默认加 i：路径与命令的大小写不该决定规则是否命中。
        // 用 r.ignoreCase === false 显式关掉。
        re = new RegExp(pattern, r.ignoreCase === false ? "" : "i");
        re.test(""); // 立即触发一次，坏正则（如未闭合的组）在这里就暴露
      } catch {
        continue;
      }

      rules.push({
        tool: typeof r.tool === "string" && r.tool.trim() ? r.tool.trim() : "*",
        re,
        action,
        reason:
          typeof r.reason === "string" && r.reason.trim()
            ? r.reason.trim()
            : `Project rule matched: ${pattern}`,
      });
    }
  }

  return { version: parsed.version ?? 1, context, rules, path };
}

// 单次匹配的文本上限。超长内容既拖慢正则，也给 ReDoS 留了空间。
const MAX_MATCH_CHARS = 20000;

/** 从 tool_input 里拼出「用来匹配规则的文本」。 */
export function matchText(toolName, input) {
  if (!input || typeof input !== "object") return "";
  const KEYS = [
    "command",
    "file_path",
    "filePath",
    "path",
    "pattern",
    "url",
    "query",
    "content",
    "new_string",
    "newString",
    "old_string",
    "oldString",
    "prompt",
    "description",
  ];
  const parts = [];
  for (const k of KEYS) {
    const v = input[k];
    if (typeof v === "string" && v) parts.push(v);
  }
  if (parts.length === 0) {
    try {
      parts.push(JSON.stringify(input));
    } catch {
      // 循环引用等，忽略
    }
  }
  return parts.join("\n").slice(0, MAX_MATCH_CHARS);
}

/** 工具名匹配：大小写不敏感；`*` 匹配全部，也支持 `Bash|Write`。 */
function toolMatches(ruleTool, toolName) {
  if (ruleTool === "*") return true;
  if (!toolName) return false;
  const t = toolName.toLowerCase();
  return ruleTool
    .split("|")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(t);
}

/**
 * 评估规则，返回命中的**最严**一条：deny > ask。
 * 单条正则运行期出错不影响其它条。
 */
export function evaluate(guardrails, toolName, text) {
  if (!guardrails || !guardrails.rules || guardrails.rules.length === 0) return null;
  let askHit = null;
  for (const rule of guardrails.rules) {
    if (!toolMatches(rule.tool, toolName)) continue;
    let matched = false;
    try {
      matched = rule.re.test(text);
    } catch {
      matched = false;
    }
    if (!matched) continue;
    if (rule.action === "deny") return rule; // 最严，无需再找
    if (!askHit) askHit = rule;
  }
  return askHit;
}
