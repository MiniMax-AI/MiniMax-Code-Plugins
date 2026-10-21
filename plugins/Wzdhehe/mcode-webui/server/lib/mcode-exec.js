// webui/server/lib/mcode-exec.js
// Spawn mcode exec subprocess (mcode.cmd exec --input - --output-format stream-json)
// + parse stream-json events + accumulate result.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  MCODE_CMD,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_STEPS,
  DEFAULT_MODEL,
} from "./config.js";
import { streamUpdateLine } from "./sessions.js";
import { setActiveChild, clearActiveChild, pushStateFor } from "./state-bus.js";

// ============================================================
// v2 security fix (PR #55 / CodeQL js/shell-command-injection):
// the old implementation spawned a Windows shell trampoline
// (`/c <MCODE_CMD> exec ...`) on every platform, handing an
// environment/PATH-resolved string to a full shell — an injection
// surface. The trampoline is removed entirely: we resolve the mcode
// entry ourselves (zero deps, sync) and spawn it directly.
// Resolution rules, fail-closed at every step:
//   1. MCODE_CMD containing a path separator is taken as a direct
//      path (config.js supplies absolute repo/home-layout values).
//   2. A bare name is probed against PATH. On win32 PATHEXT
//      extensions are probed too; shim file names are matched
//      case-insensitively — PATHEXT casing is not guaranteed and a
//      case-sensitive filesystem (Linux CI) must not miss the shim.
//   3. A .cmd/.bat shim is never executed through a shell. We use
//      the sibling node_modules/@minimax-ai/code/cli.js and run it
//      under the current Node binary (process.execPath).
//   4. Anything unresolvable throws. There is no shell fallback.
// ============================================================

const CODE_ENTRY = ["node_modules", "@minimax-ai", "code", "cli.js"];

// Case-insensitive file probe. existsSync covers case-insensitive
// filesystems (win32, default macOS); the directory-listing fallback
// covers case-sensitive ones (Linux) where probed casing may differ
// from the file on disk. Returns the on-disk path or null.
function probeFile(p) {
  if (existsSync(p)) return p;
  try {
    const dir = dirname(p);
    const want = p.toLowerCase();
    for (const name of readdirSync(dir)) {
      const hit = join(dir, name);
      if (hit.toLowerCase() === want) return hit;
    }
  } catch {}
  return null;
}

// Resolve MCODE_CMD to a directly spawnable { command, args } prefix:
//   - shim on disk  -> { command: process.execPath, args: [cliEntry] }
//   - plain binary  -> { command: <absolute path>, args: [] }
// Throws (fail-closed) when nothing resolves — never falls back to a
// shell. `env`/`platform` are injectable for unit tests.
export function resolveMcodeSpawn(
  cmd = MCODE_CMD,
  { env = process.env, platform = process.platform } = {},
) {
  if (typeof cmd !== "string" || !cmd) {
    throw new Error(
      "[mcode-exec] MCODE_CMD is empty; set it to the mcode CLI path (fail-closed, no shell fallback).",
    );
  }
  const win = platform === "win32";
  const direct = /[\\/]/.test(cmd);
  const dirs = direct
    ? [""]
    : String(env.PATH ?? env.Path ?? "")
        .split(win ? ";" : delimiter)
        .filter(Boolean);
  // An extensionless bare name on win32 only resolves through PATHEXT;
  // a name already carrying an extension (mcode.cmd / pwsh.exe) is
  // probed as-is. POSIX keeps the bare name as the only form.
  const dotted = /\.[a-z0-9]+$/i.test(cmd);
  const exts =
    win && !dotted && !direct
      ? String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
      : [""];
  let found = null;
  outer: for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = resolve(direct ? cmd + ext : join(dir, cmd + ext));
      const hit = probeFile(candidate);
      if (hit) {
        found = hit;
        break outer;
      }
    }
  }
  if (!found) {
    throw new Error(
      `[mcode-exec] cannot resolve mcode CLI "${cmd}" (no match on PATH); ` +
        `set MCODE_CMD to the mcode launcher path or its cli.js entry ` +
        `(fail-closed, no shell fallback).`,
    );
  }
  // A .cmd/.bat shim cannot be spawned directly by Node and must not be
  // handed to a shell — run its sibling cli.js under this Node instead.
  if (/\.(cmd|bat)$/i.test(found)) {
    const entry = resolve(dirname(found), ...CODE_ENTRY);
    if (!existsSync(entry)) {
      throw new Error(
        `[mcode-exec] mcode shim "${found}" resolved, but sibling entry ` +
          `"${entry}" is missing; reinstall the mcode CLI or point ` +
          `MCODE_CMD at its cli.js (fail-closed, no shell fallback).`,
      );
    }
    return { command: process.execPath, args: [entry] };
  }
  return { command: found, args: [] };
}

// Assemble the mcode exec argv (everything after the resolved binary /
// entry). Exported for unit tests; flags and order mirror the pre-v2
// spawn argv minus the removed `/c <MCODE_CMD>` shell prefix.
export function buildExecArgs({
  workspace = "",
  model = DEFAULT_MODEL,
  timeout = DEFAULT_TIMEOUT,
  maxSteps = DEFAULT_MAX_STEPS,
  permission = "full",
  sessionId = null,
} = {}) {
  const args = [
    "exec",
    "--input",
    "-",
    "--input-format",
    "text",
    "--cwd",
    workspace,
    "--permission",
    permission,
    "--timeout",
    timeout,
    "--output-format",
    "stream-json",
    "--max-steps",
    String(maxSteps),
    "--model",
    model,
  ];
  if (sessionId) args.push("--session", sessionId);
  return args;
}

export function runMcodeExec(prompt, opts = {}) {
  const workspace =
    opts.workspace ||
    (opts.cs && opts.cs.workspace && opts.cs.workspace.dir) ||
    "";
  const model = opts.model || DEFAULT_MODEL;
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const maxSteps = opts.maxSteps || DEFAULT_MAX_STEPS;
  const label = opts.label || "prompt";
  // 续接已有 session（多轮对话上下文）— 由 collectExecResult 写回的 mcode exec.sessionId
  const sessionId = opts.sessionId || null;
  const cs = opts.cs; // v0.5.ai: per-cid state
  const cid = opts.cid;

  // v0.5.bx-19: webui 端 permission 模式同步到 mcode — 之前硬编码 'full' 导致 "始终询问" 不生效
  //   webui 'Ask' → mcode 'ask' / 'Auto' → 'auto' / 'Read' → 'read' / 'Full access' → 'full'
  const webuiMode = (cs && cs.permissions) || "Full access";
  const mcodePermission =
    webuiMode === "Ask"
      ? "ask"
      : webuiMode === "Auto"
        ? "auto"
        : webuiMode === "Read"
          ? "read"
          : "full";

  // v2 security fix (PR #55): resolve the CLI ourselves and spawn it
  // directly — the old Windows-shell `/c` trampoline is gone. A missing
  // CLI throws here (fail-closed) instead of reaching a shell.
  const resolved = resolveMcodeSpawn(MCODE_CMD);
  const args = [
    ...resolved.args,
    ...buildExecArgs({
      workspace,
      model,
      timeout,
      maxSteps,
      permission: mcodePermission,
      sessionId,
    }),
  ];
  const child = spawn(resolved.command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.write(prompt, "utf8");
  child.stdin.end();
  // v0.5.ai: per-cid child tracker（/api/stop 按 cid 找 child）
  setActiveChild(cid, child);
  return { child, args, label, model, workspace, sessionId, cs, cid };
}

// collectExecResult: 解析 stream-json + 累加 result。
// 完成后会 pushStateFor(cid)，调用方不需要再 push。
export function collectExecResult(childPromise) {
  // Wraps runMcodeExec and accumulates a result object
  return new Promise((resolve) => {
    const r = {
      answer: null,
      thinking: null,
      status: "unknown",
      error: null,
      usage: null,
      sessionId: null,
      durationMs: null,
      tps: null,
    };
    let buf = "";
    const t0 = Date.now();
    const { child, label, model, cs, cid } = childPromise;
    cs.running = {
      active: true,
      prompt: label,
      pid: child.pid,
      startedAt: t0,
      model,
      sessionId: null,
      lastDeltaAt: t0,
      tps: 0,
    };
    cs.context.thinkingStatus = label === "/usage" ? "Loading" : "Running";
    pushStateFor(cid);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m.type === "delta") {
            if (typeof m.thinking === "string") {
              r.thinking = (r.thinking || "") + m.thinking;
              const oneLine = r.thinking.replace(/\n+/g, " ").trim();
              streamUpdateLine(cs.chat, "▲", oneLine);
            }
            if (typeof m.content === "string") {
              r.answer = (r.answer || "") + m.content;
              const oneLine = r.answer.replace(/\n+/g, " ").trim();
              streamUpdateLine(cs.chat, "●", oneLine);
            }
            const now = Date.now();
            if (cs.running.lastDeltaAt) {
              const dt = (now - cs.running.lastDeltaAt) / 1000;
              if (dt > 0) cs.running.tps = Math.round(1 / dt);
            }
            cs.running.lastDeltaAt = now;
            cs.context.tps = cs.running.tps;
            pushStateFor(cid);
          } else if (m.type === "message" && m.message) {
            if (m.message.usage) r.usage = m.message.usage;
            if (typeof m.message.content === "string" && !r.answer)
              r.answer = m.message.content;
            if (typeof m.message.thinking === "string" && !r.thinking)
              r.thinking = m.message.thinking;
          } else if (m.type === "exec.result") {
            if (m.sessionId) r.sessionId = m.sessionId;
            if (typeof m.durationMs === "number") r.durationMs = m.durationMs;
            if (m.answer) r.answer = m.answer;
            r.status = m.status || "unknown";
            if (m.error) r.error = m.error;
            finalize();
          }
        } catch {}
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {}); // swallow; usage stats can land here

    const safetyTimeout = setTimeout(() => {
      if (r.status === "unknown") {
        r.status = "timeout";
        r.error = { message: "mcode exec did not produce exec.result in 90s" };
        try {
          child.kill();
        } catch {}
        finalize();
      }
    }, 90000);

    function finalize() {
      if (r._finalized) return;
      r._finalized = true;
      clearTimeout(safetyTimeout);
      const dt = Date.now() - t0;
      r.durationMs = r.durationMs || dt;
      if (r._stopped) r.status = "stopped";
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
      if (r.usage) {
        cs.context.tokens =
          (cs.context.tokens || 0) + (r.usage.totalTokens || 0);
        cs.context.used = cs.context.tokens;
        cs.context.percent = cs.context.limit
          ? Math.round((cs.context.tokens / cs.context.limit) * 100)
          : 0;
        cs.context.estimated = false; // mcode 0.1.5+ 返真实值
        cs.context.lastUsageAt = Date.now();
        cs.usage.sessionInput =
          (cs.usage.sessionInput || 0) + (r.usage.inputTokens || 0);
        cs.usage.sessionOutput =
          (cs.usage.sessionOutput || 0) + (r.usage.outputTokens || 0);
        cs.usage.sessionTotal = cs.usage.sessionInput + cs.usage.sessionOutput;
      } else if (r.answer || r.thinking) {
        // v0.5.bx-9: mcode 0.1.4 acp 不返 usage / 不发 usage_update, 用 thinking + answer 长度粗略估算 token
        //   估算系数: ~3 字符/token (中英文混合经验值, GPT tokenizer ~4 字符/token, 中文偏密 ~1.5 字符/token)
        //   注意: input 算 user prompt + 上文, 我们没访问 — 只能估 output (thinking+answer) + 累加 user input
        //   mcode 0.1.5+ 暴露真值后, r.usage 分支会优先, 估算自动失效
        const outText = (r.thinking || "") + (r.answer || "");
        const estOutTokens = Math.ceil(outText.length / 3);
        // 估算 user input 长度 — 我们能从 cs.chat 知道上一次 user prompt 长度
        const lastUserLine = [...(cs.chat || [])]
          .reverse()
          .find((l) => typeof l === "string" && l.startsWith("› "));
        const userLen = lastUserLine ? lastUserLine.length : 0;
        const estInTokens = Math.ceil(userLen / 3);
        const estTotal = estOutTokens + estInTokens;
        cs.context.tokens = (cs.context.tokens || 0) + estTotal;
        cs.context.used = cs.context.tokens;
        cs.context.estimated = true; // 标记是估算的 (mcode 0.1.4 限制)
        cs.context.percent = cs.context.limit
          ? Math.round((cs.context.tokens / cs.context.limit) * 100)
          : 0;
        cs.context.lastUsageAt = Date.now();
        cs.usage.sessionInput = (cs.usage.sessionInput || 0) + estInTokens;
        cs.usage.sessionOutput = (cs.usage.sessionOutput || 0) + estOutTokens;
        cs.usage.sessionTotal = cs.usage.sessionInput + cs.usage.sessionOutput;
        if (process.env.MCODE_USAGE_DEBUG) {
          console.log(
            `[usage.estimate] outLen=${outText.length} estOut=${estOutTokens} userLen=${userLen} estIn=${estInTokens} total=${estTotal} (mcode 0.1.4 不返 usage, 用估算)`,
          );
        }
      }
      if (r.sessionId) cs.mcodeSessionId = r.sessionId;
      pushStateFor(cid);
      resolve(r);
      try {
        child.kill();
      } catch {}
    }

    child.stdout.on("end", finalize);
    child.on("exit", finalize);
    child.on("error", (e) => {
      r.status = "error";
      r.error = { message: e.message };
      finalize();
    });
  });
}
