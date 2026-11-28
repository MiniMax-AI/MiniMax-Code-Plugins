// MiniMax Code hook 共享 I/O（每个插件自带一份，不要跨插件 import）。
//
// 为什么自带一份：插件不应该 import 用户目录下的任何文件 —— 那会造成隐式依赖，
// 用户改自己的文件会把插件搞坏，且插件分发出去后那个路径根本不存在。
//
// 契约来源：MiniMax Code 本地插件 Hook 规范（plugin-creator/references/local-plugin-hooks.md）
//   stdin   一个 JSON 对象（snake_case 为主，兼容 camelCase）
//   stdout  结构化 JSON。本文件只产出三种形态：
//            hookSpecificOutput.additionalContext   —— 往上下文里推一段文字
//            hookSpecificOutput.permissionDecision —— PreToolUse 的 deny / ask
//            decision:"block" + reason             —— Stop 请求再跑一轮
//   退出码  0 = 放行（其它退出码要么 fail-open 要么被记为失败）
//
// 原则：任何异常都不应阻塞主会话 —— 解析失败 / 输出失败一律静默 exit 0。

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * 异步读取 stdin（Windows 管道必需）。失败返回 {}。
 *
 * 注意：不要先试 readFileSync(0) 再回退 —— Windows 上同步读 fd 0 可能返回空
 * 且消耗/锁定流，导致后续异步读也读不到。直接用异步流最稳。
 */
export async function readStdinAsync() {
  let raw = "";
  try {
    for await (const chunk of process.stdin) {
      raw += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    }
  } catch {
    raw = "";
  }
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return safeObject(JSON.parse(trimmed));
  } catch {
    return {};
  }
}

/** 取 payload 字段：优先 snake_case，回退 camelCase。 */
export function field(payload, snake, camel) {
  if (payload == null || typeof payload !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(payload, snake)) return payload[snake];
  if (camel && Object.prototype.hasOwnProperty.call(payload, camel)) return payload[camel];
  return undefined;
}

/** 往会话上下文里推一段文字（SessionStart / PostToolUse / SubagentStart 等）。 */
export function emitContext(eventName, text) {
  if (!text) return emitPass();
  write({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: text,
    },
  });
}

/**
 * PreToolUse 专用：deny / ask（不显式发 allow —— 那会盖掉别的 hook 的决策）。
 *
 * 同时给出两种已被文档化的决策形状，让不同运行时都能识别：
 *   - 顶层 `decision` + `reason` —— 社区仓库的便携契约（PreToolUse 认 deny / allow）
 *   - `hookSpecificOutput.permissionDecision` —— MiniMax Code 本地插件契约（认 deny / ask / allow）
 *
 * 两者内容一致，运行时取其一即可；互不覆盖。
 */
export function emitPermission(decision, reason) {
  write({
    decision,
    reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
}

/**
 * Stop：请求模型再跑一轮（decision:block）。
 *
 * 用顶层 decision + reason —— 这是 MiniMax 侧明确支持的形状。
 * 注意 MiniMax 规定：stop_hook_active 为 true 时必须放行，否则一次 Stop 最多能
 * 把模型逼成连跑 8 轮。调用方必须自己做一次性节流（见 stop-skill-nudge.mjs）。
 */
export function emitBlockStop(reason) {
  if (!reason) return emitPass();
  write({ decision: "block", reason });
}

// ---------------------------------------------------------------------------
// 钩子遥测（单人使用时唯一的故障可见性）
//
// fail-open 的代价是故障不可见：这里把每次输出 / 放行同步记一行。
// 落点用 MiniMax 注入的 PLUGIN_DATA（宿主托管的可写目录），不写进用户 home。
// 三条硬约束：同步写（exit 前落盘）、自带轮转（512KB / 2000 行）、失败绝不影响钩子。
// 关闭：PLUGIN_TELEMETRY=off（CI 自动关）。
// ---------------------------------------------------------------------------
const T0 = Date.now();
const TELEMETRY_PLUGIN = telemetryPluginName(fileURLToPath(import.meta.url));

/**
 * 从 io 模块路径推插件名：向上找到 hooks 目录，再取它的上一级目录名。
 * 仓库布局 plugins/<名>/hooks/lib/io.mjs → hooks 的上一级即插件名；
 * 安装布局 <dataDir>/plugins/<名>/hooks/lib/io.mjs → 同样是 <名>。
 */
export function telemetryPluginName(modulePath) {
  let dir = dirname(String(modulePath));
  while (basename(dir) !== "hooks" && dirname(dir) !== dir) dir = dirname(dir);
  if (basename(dir) !== "hooks") return "unknown";
  return basename(dirname(dir));
}

/** 插件可写状态目录：优先 PLUGIN_DATA（宿主注入），退回临时目录。 */
export function pluginDataDir() {
  const fromEnv = process.env.PLUGIN_DATA || process.env.MINIMAX_PLUGIN_DATA;
  const dir = fromEnv && fromEnv.trim() ? fromEnv.trim() : join(tmpdir(), "minimax-plugin-data");
  return resolve(dir);
}

function recordTelemetry(outcome, event) {
  try {
    if (process.env.PLUGIN_TELEMETRY === "off" || process.env.CI) return;
    const dir = pluginDataDir();
    const file = resolve(dir, "telemetry.jsonl");
    try {
      if (existsSync(file) && statSync(file).size > 512 * 1024) {
        const lines = readFileSync(file, "utf-8").trimEnd().split("\n");
        writeFileSync(file, lines.slice(-2000).join("\n") + "\n", "utf-8");
      }
    } catch {}
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      file,
      JSON.stringify({
        ts: new Date().toISOString(),
        plugin: TELEMETRY_PLUGIN,
        event: event ?? null,
        outcome,
        ms: Date.now() - T0,
      }) + "\n",
    );
  } catch {}
}

/** 放行 = 空输出 + exit 0。不要显式发 allow。 */
export function emitPass() {
  recordTelemetry("pass");
  process.exit(0);
}

// ---- 内部助手 ----

function write(obj) {
  try {
    // 用 writeSync(1) 而不是 process.stdout.write + process.exit：
    // 管道上的 stdout 写入在 Node 里是异步的，紧跟一个 process.exit(0)
    // 理论上会在数据刷出前终止进程（Windows 尤甚）。同步写完 fd 1 才返回。
    const out = obj?.hookSpecificOutput;
    const outcome = obj?.decision === "block" ? "block" : (out?.permissionDecision ?? "context");
    recordTelemetry(outcome, out?.hookEventName ?? null);
    writeSync(1, JSON.stringify(obj));
  } catch {
    // 输出失败也不阻塞会话。
  }
  process.exit(0);
}

function safeObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
