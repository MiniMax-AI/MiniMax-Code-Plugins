// Stop 钩子 —— 自产「记忆候选」并按项目落盘。
//
// 设计要点：
//  - **候选就地产生**：判断与落盘在同一进程里完成，候选直接写进当前项目的
//    candidates.jsonl。没有全局中转文件，也没有"消费游标"——候选本来就是按项目分的。
//  - **纯副作用，不注入上下文**。在 Stop 上注入文本会干扰模型对当轮回复的收尾。
//  - **同步执行**：状态必须落盘完成才返回（实测远低于 5 秒上限）。
//  - **去重靠内容指纹**：同一段内容不重复落盘。
//  - **home 不是项目**：cwd 落在 home 时一律跳过，否则「项目专属」会变成「全局」。

import { join } from "node:path";
import { readStdinAsync, field, emitPass } from "../lib/io.mjs";
import { resolveProject } from "../lib/project.mjs";
import { appendJsonl, fingerprint, readJsonl } from "../lib/store.mjs";

const payload = await readStdinAsync();

// 闸 1：只处理 Stop，被错配到其他事件时放行。
if (field(payload, "hook_event_name", "hookEventName") !== "Stop") emitPass();

// 闸 2：防递归。stop_hook_active=true 表示这是钩子自己请求的继续，别重复触发。
// （MiniMax 规定：此时必须放行，否则一次 Stop 最多能把模型逼成连跑 8 轮。）
if (field(payload, "stop_hook_active", "stopHookActive") === true) emitPass();

const message = field(payload, "last_assistant_message", "lastAssistantMessage") || "";
const cwd = field(payload, "cwd") || "";
const sessionId = field(payload, "session_id", "sessionId") || "";

// 空/极短回复不处理
if (message.trim().length < 20) emitPass();

// ---- 启发式信号 ----
// 文件改动信号：含"已修改/created/wrote/fixed/修复/实现"+ 文件路径特征
// 注意：中文不加 \b（CJK 不属于 \w，\b 在中文边界处不生效，会漏匹配）
const CHANGE_SIGNALS = [
  /(?:已(?:修改|创建|删除|更新|修复|实现|重构)|created|wrote|updated|fixed\b|修复了?|实现了?|重构了?|新增了?)/i,
];

// 决策信号：含"决定/decision/采用 X 方案/选择 X"
const DECISION_SIGNALS = [
  /(?:决定|最终(?:选择|采用)|decision[:：]|采用.*?方案|选择.*?(?:而非|而不是))/i,
];

// 文件路径特征（启发式：看起来像路径的字符串）
const PATH_RE = /(?:[\w./-]+\/[\w./-]+\.[a-zA-Z]{1,6}|src\/[^\s，,。.]+|lib\/[^\s，,。.]+)/;

const hasChange = CHANGE_SIGNALS.some((re) => re.test(message));
const hasDecision = DECISION_SIGNALS.some((re) => re.test(message));
const hasPath = PATH_RE.test(message);

// 必须同时有"动作信号 + 具体对象"，避免"我修复了"(无对象)这种泛泛之谈
const isCandidate = (hasChange && hasPath) || hasDecision;

if (!isCandidate) emitPass();

// ---- 落点：当前项目的记忆目录 ----
let ctx;
try {
  ctx = resolveProject(cwd || process.cwd());
} catch {
  emitPass();
}
if (ctx.isHome) emitPass(); // home 不是项目

// ---- 提取候选摘要：取 message 的前 ~400 字 + 信号类型 ----
const summary = message.slice(0, 400).replace(/\s+/g, " ").trim();
const signals = [];
if (hasChange) signals.push("file change");
if (hasDecision) signals.push("decision");
if (hasPath) signals.push("concrete file path");

const record = {
  ts: new Date().toISOString(),
  session_id: sessionId,
  cwd,
  signals: signals.join("+"),
  summary,
};

// ---- 去重后落盘 ----
const target = join(ctx.memoryDir, "candidates.jsonl");
const seen = new Set(readJsonl(target).map(fingerprint));
const fp = fingerprint(record);
if (seen.has(fp)) emitPass(); // 同一段内容不重复落盘

appendJsonl(target, [{ ...record, collectedAt: new Date().toISOString() }]);

// 纯副作用：不输出任何上下文。
emitPass();
