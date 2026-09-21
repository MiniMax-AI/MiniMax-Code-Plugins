// webui/server/lib/config.js
// Pure configuration constants. No side effects.

import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname here = webui/server/lib/. We need webui/ as root, so go up 3 levels.
// But config.js is imported by router.js which lives at webui/server/. The expected
// pattern: MCODE_ROOT = webui/.., i.e. the project root that contains mcode.cmd.
// Original behavior: server.js at webui/, MCODE_ROOT = resolve(__dirname, '..').
// Since config.js is at webui/server/lib/, we resolve up 3 levels to land at .minimax-code/.

// v0.5.z: workspace 优先级 — env MCODE_WORKSPACE > mcode TUI 写的 ~/.minimax/runtime/cwd.json > MCODE_ROOT fallback
// v0.5.bn: mcode 写的 cwd.json 开头有 UTF-8 BOM（\ufeff），JSON.parse 不认会抛 — 这里剥掉再 parse
function detectTuiCwd() {
  const f = join(homedir(), ".minimax", "runtime", "cwd.json");
  if (!existsSync(f)) return null;
  try {
    let raw = readFileSync(f, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 剥 BOM
    const o = JSON.parse(raw);
    if (o && typeof o.cwd === "string" && o.cwd) return o.cwd;
  } catch (e) {
    console.warn(`[webui] detectTuiCwd: ${f} parse failed: ${e.message}`);
  }
  return null;
}

export const MCODE_ROOT = resolve(__dirname, "..", "..", ".."); // webui/server/lib → ../../../ → .minimax-code
// v1.0: mcode.cmd 检测链 — 之前只有 MCODE_ROOT 相对路径一种, 插件装到其他位置时启动即 fatal。
//   优先级: env MCODE_CMD > 仓库/开发布局 (MCODE_ROOT) > 用户安装布局 (~/.minimax-code) > PATH 裸名
export const MCODE_CMD = (() => {
  if (process.env.MCODE_CMD) return process.env.MCODE_CMD;
  const repoLayout = join(MCODE_ROOT, "mcode.cmd");
  if (existsSync(repoLayout)) return repoLayout;
  const homeLayout = join(homedir(), ".minimax-code", "mcode.cmd");
  if (existsSync(homeLayout)) return homeLayout;
  return "mcode"; // PATH fallback
})();
// v0.5.bx-38: 默认端口 8080 — 之前 7890 太常被 desktop / mavis 桌面端占, 端口冲突频繁
//   8080 是常见 HTTP alt, 也跟 web UI 语义对得上 (web = 80, 8080 = alt)
//   仍可被 process.env.PORT 覆盖 (比如临时用 7890 跑测试)
export const PORT = Number(process.env.PORT) || 8080;
// v2 security fix (PR #55 review point 2): default bind is now loopback.
//   v0.5.ao 默认 0.0.0.0（"浏览器/手机/局域网访问是主场景"），但本服务是
//   高权限面（agent / filesystem / session 控制），网络可达必须是运营者
//   显式选择而不是缺省。LAN 暴露的显式 opt-in 有两条，均继续受尊重：
//     1. env HOST（部署/docker 既有通道，永远最优先）
//     2. settings.json 持久化 lanBind=true（v2 新增设置项，见
//        server/lib/settings.js；重启后生效）
//   两者皆无 → 127.0.0.1。升级用户只要没写过显式配置就落到新默认（评审
//   正是要求如此）；写过的零惊扰。
export const HOST = resolveBindHost(process.env.HOST, readPersistedLanBind());

// Pure resolution rule for the boot bind. Exported for tests.
//   env HOST (trimmed, non-empty) > lanBind===true ? "0.0.0.0" : loopback
export function resolveBindHost(envHost, lanBind) {
  const env = typeof envHost === "string" ? envHost.trim() : "";
  if (env) return env;
  if (lanBind === true) return "0.0.0.0";
  return "127.0.0.1";
}

// Best-effort read of the persisted `lanBind` flag straight from
// settings.json. Duplicates the path resolution of settings.js#_settingsPath
// on purpose: config.js must not import settings.js (settings.js imports
// config.js — a cycle would pin initialization order). Fail-closed: any
// missing/corrupt file resolves to false (loopback).
function readPersistedLanBind() {
  try {
    const p =
      process.env.MCODE_WEBUI_SETTINGS_PATH ||
      join(homedir(), ".mcode-webui", "settings.json");
    if (!existsSync(p)) return false;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed && parsed.lanBind === true;
  } catch {
    return false;
  }
}
// v1.0.1: optional auth token for non-local requests. When set, all
// /api/* and SSE requests must carry either `?token=<value>` or
// `Authorization: Bearer <value>`. Local requests always bypass. See
// plugins/Wzdhehe/mcode-webui/references/SECURITY-NOTES.md §2.
export const TOKEN = process.env.TOKEN || "";
// v2 (lease C08): TOKEN_STDOUT — escape hatch for docker / no-UI
//   environments where the operator has no SSE client to receive the
//   `token.first_run` modal. When "1", server.js prints a single
//   NEUTRAL line ("token persisted to: <path>") — the raw token is
//   NEVER echoed. Default off: production operators use the web UI
//   modal that the SSE event drives. See ANTI-PATTERNS-FIX-PLAN §AP1.
export const TOKEN_STDOUT = process.env.MCODE_WEBUI_TOKEN_STDOUT === "1";
export const DEFAULT_MODEL =
  process.env.MCODE_MODEL || "minimax_api/MiniMax-M3";
export const DEFAULT_TIMEOUT = process.env.MCODE_TIMEOUT || "120s";
export const DEFAULT_MAX_STEPS = Number(process.env.MCODE_MAX_STEPS) || 6;
export const MAX_CONCURRENT = Number(process.env.MCODE_MAX_CONCURRENT) || 3;
export const UPLOAD_DIR =
  process.env.MCODE_WEBUI_UPLOAD_DIR || join(MCODE_ROOT, ".webui-uploads");
export const SESSIONS_DB =
  process.env.MCODE_WEBUI_SESSIONS_DB ||
  join(MCODE_ROOT, ".webui-sessions.json");
// v0.5.bx-19: mcode session 物理存储位置
// v1.0: 支持 MCODE_RUNTIME_DB 环境变量覆盖 — E2E 测试用真实库副本跑真删路径, 不碰真库
export const MCODE_RUNTIME_DB =
  process.env.MCODE_RUNTIME_DB ||
  join(
    homedir(),
    ".minimax",
    "v2",
    "sqlite",
    "runtime-state.sqlite",
  );
// v0.5.bx-10: mavis 桌面端 sqlite db — local_runtime_token_usage 表存真实 token usage
export const MAVIS_DATA_DIR =
  process.env.MAVIS_DATA_DIR || join(homedir(), ".minimax");
export const MAVIS_DB_PATH = join(
  MAVIS_DATA_DIR,
  "v2",
  "sqlite",
  "runtime-state.sqlite",
);
export const SQLITE3_BIN =
  detectSqlite3Bin() ?? "sqlite3"; // fallback: rely on PATH (spawn will ENOENT gracefully if missing)

// v2.0 (lease C03): per-{IP,token} rate limiter knobs.
//   - MCODE_WEBUI_RATE_LIMIT      : steady-state allowance per 60s (default 60)
//   - MCODE_WEBUI_RATE_LIMIT_BURST: hard ceiling within one window (default 100)
// Token holders get a 2x multiplier on both (see server/lib/rate-limit.js).
export const RATE_LIMIT_PER_MIN = Number(process.env.MCODE_WEBUI_RATE_LIMIT || 60);
export const RATE_LIMIT_BURST = Number(process.env.MCODE_WEBUI_RATE_LIMIT_BURST || 100);

// v2.0 (reconcile §6.2): re-export the four SECURITY-NOTES env vars that
// scripts/check-docs-alignment.mjs requires as direct `export const` of the
// same name. Each is already consumed inline by the code that follows
// (UPLOAD_DIR reads MCODE_WEBUI_UPLOAD_DIR; db.js reads MCODE_BETTER_SQLITE3;
// settings.js reads MCODE_WEBUI_SETTINGS_PATH; debug/inject reads DEBUG_INJECT).
// Exposing the raw env value keeps doc-aligned introspection simple without
// touching the consumer-side resolution.
export const MCODE_WEBUI_UPLOAD_DIR = process.env.MCODE_WEBUI_UPLOAD_DIR || null;
export const MCODE_WEBUI_SETTINGS_PATH = process.env.MCODE_WEBUI_SETTINGS_PATH || null;
export const MCODE_BETTER_SQLITE3 = process.env.MCODE_BETTER_SQLITE3 || null;
export const DEBUG_INJECT = process.env.DEBUG_INJECT || null;

// v0.5.bx-44 (red-line-2): platform-specific fallback paths to try when
//   probing for sqlite3 binary. Pure function for testability — no FS /
//   process side effects. mcode-plugin-guide red-lines.md §"测试可复现性"
//   forbids hardcoding host-specific paths in shipped source.
export function getPlatformFallbackPaths(
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  const paths = [];
  if (platform === "win32") {
    // Anaconda / Miniconda (commonly ship sqlite3.exe on Windows dev machines)
    paths.push(`${home}\\anaconda3\\Library\\bin\\sqlite3.exe`);
    paths.push(`${home}\\Anaconda3\\Library\\bin\\sqlite3.exe`);
    paths.push(`${home}\\miniconda3\\Library\\bin\\sqlite3.exe`);
    paths.push(`${home}\\Miniconda3\\Library\\bin\\sqlite3.exe`);
    // WindowsApps (scoop / winget install there)
    const local = env && env.LOCALAPPDATA;
    if (local) paths.push(`${local}\\Microsoft\\WindowsApps\\sqlite3.exe`);
    // System32 (rare but possible)
    paths.push("C:\\Windows\\System32\\sqlite3.exe");
  } else if (platform === "darwin") {
    paths.push("/usr/bin/sqlite3");
    paths.push("/opt/homebrew/bin/sqlite3"); // Apple Silicon Homebrew
    paths.push("/usr/local/bin/sqlite3"); // Intel Homebrew / manual install
  } else {
    // linux + other unix
    paths.push("/usr/bin/sqlite3");
    paths.push("/usr/local/bin/sqlite3");
  }
  return paths;
}

// Probe a single binary: returns true if it works (`--version` exits 0).
//   Uses spawnSync with stdio:ignore so it doesn't pollute output.
//   2s timeout — sqlite3 --version is instant on any sane system.
function probeBinary(cmd) {
  try {
    const r = spawnSync(cmd, ["--version"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 2000,
    });
    return r.status === 0 && !r.error;
  } catch {
    return false;
  }
}

// Resolve sqlite3 binary path. Order:
//   1. process.env.SQLITE3_BIN (explicit override; must actually work)
//   2. "sqlite3" on PATH (probe --version)
//   3. Platform-specific fallback list (first that works)
//   4. null (caller should degrade gracefully — mavis-usage.js returns null
//          on spawn ENOENT, same as today)
export function detectSqlite3Bin() {
  const envBin = process.env.SQLITE3_BIN;
  if (envBin && probeBinary(envBin)) return envBin;
  if (probeBinary("sqlite3")) return "sqlite3";
  for (const p of getPlatformFallbackPaths()) {
    if (probeBinary(p)) return p;
  }
  return null;
}

// v0.5.bn: 默认工作区必须有真实路径，否则 mcode acp session/new 报 "Invalid params"
//   之前的 null 设计是想要"用户没选就不发"语义，但 acp 必须传 cwd
//   优先级：env MCODE_WORKSPACE > mcode TUI 的 cwd.json > 用户家目录（兜底）
export const DEFAULT_WORKSPACE = (() => {
  if (process.env.MCODE_WORKSPACE) {
    console.log(
      `[webui] workspace: env MCODE_WORKSPACE=${process.env.MCODE_WORKSPACE}`,
    );
    return process.env.MCODE_WORKSPACE;
  }
  const tui = detectTuiCwd();
  if (tui) {
    console.log(`[webui] workspace: tui cwd.json=${tui}`);
    return tui;
  }
  const home = homedir();
  console.log(`[webui] workspace: homedir fallback=${home}`);
  return home;
})();

// re-export detectTuiCwd for workspace route
export { detectTuiCwd };

// v0.5.bl: 全局未捕获错误处理（server 崩了不静默，至少打日志 + 写 .server.err）
export function installGlobalErrorHandlers() {
  process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
    try {
      import("node:fs").then(({ appendFileSync }) => {
        const logFile = join(MCODE_ROOT, ".server.err");
        appendFileSync(
          logFile,
          `\n[uncaughtException ${new Date().toISOString()}] ${err.stack || err.message}\n`,
        );
      });
    } catch {}
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
    try {
      import("node:fs").then(({ appendFileSync }) => {
        const logFile = join(MCODE_ROOT, ".server.err");
        appendFileSync(
          logFile,
          `\n[unhandledRejection ${new Date().toISOString()}] ${reason && reason.stack ? reason.stack : String(reason)}\n`,
        );
      });
    } catch {}
  });
}
