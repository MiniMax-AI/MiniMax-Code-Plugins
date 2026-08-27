// webui/server/lib/settings.js
// Runtime-tunable settings + persistent storage.
//
// v0.5.ap: LAN broadcast toggle (in-memory)
// v1.0.1: 扩展 — read-only mode, token enabled/rotation, interface allowlist.
//   持久化到 ~/.mcode-webui.settings.json, 启动时 load, setter 自动写盘。
//
// State: process.env.TOKEN 永远优先于 settings.json (保留 v1.0.1 行为,
//   让 env 部署跟图形 UI 切换互不冲突)。
//
// Atomic write: 先写 .tmp 再 rename, 避免半写状态。

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { PORT, HOST } from "./config.js";
import { LAN_IP } from "./lan.js";
import { MCODE_CMD, DEFAULT_WORKSPACE, DEFAULT_MODEL } from "./config.js";

// -----------------------------------------------------------------------
// Persistent settings file path
// -----------------------------------------------------------------------
// Override via env MCODE_WEBUI_SETTINGS_PATH (used by tests + for non-default
// installs). The path is resolved lazily so tests can set the env var
// before calling init() without re-importing the module.
const SETTINGS_DIR_DEFAULT = join(homedir(), ".mcode-webui");
const SETTINGS_PATH_DEFAULT = join(SETTINGS_DIR_DEFAULT, "settings.json");
function _settingsPath() {
  return process.env.MCODE_WEBUI_SETTINGS_PATH || SETTINGS_PATH_DEFAULT;
}
const SETTINGS_VERSION = 1;

function defaultState() {
  return {
    version: SETTINGS_VERSION,
    lanBroadcast: true,       // 不持久化在文件里 — 重启默认 true (跟 v0.5.ap 行为一致)
    readOnly: false,
    tokenEnabled: true,       // 默认开
    currentToken: "",         // 启动时 init() 决定
    tokenRotatedAt: 0,
    tokenAcknowledged: false,
    // v2026-08-28 modacker: Token Plan API key (Subscription Key from
    // platform.minimaxi.com) — when `quotaEnabled=true` AND a key is
    // set, webui's "套餐用量" feature becomes visible and calls the
    // official /v1/token_plan/remains API. Otherwise the feature is
    // hidden entirely (see server/lib/usage.js).
    quotaEnabled: false,
    tokenPlanApiKey: "",
  };
}

// In-memory state. `lanBroadcast` lives outside this struct because it
// is intentionally NOT persisted (admin-friendly: server reboot always
// re-enables LAN so users aren't locked out).
let lanBroadcastEnabled = true;
let readOnlyEnabled = false;
let tokenAuthEnabled = true;
let currentToken = "";
let tokenRotatedAt = 0;
let tokenAcknowledged = false;
let quotaEnabled = false;
let tokenPlanApiKey = "";

// v2026-08-28 modacker: external Token Plan key sources (env / file).
//   These are read ONCE at init() and shadow the in-memory value when
//   present. The webui's text input (which writes to `tokenPlanApiKey`
//   via setTokenPlanApiKey) cannot override them — the priority chain
//   is "env > file > settings.json", same shape as the existing
//   process.env.TOKEN override for the LAN auth token (lines 91-94,
//   230-234). This means:
//     - Operator with env set: webui text input is "shown for
//       discoverability" but does not take effect. The UI surfaces
//       this by hiding the "delete" button (env-managed keys can't
//       be deleted from the webui — only by unsetting the env).
//     - Operator with file set: same semantics; the file is re-read
//       only on init (not on every fetch) so a manual edit requires
//       a webui restart to take effect — matches the operator's
//       mental model of "this is a config file, I restart the
//       service after editing it".
//   We do NOT persist env/file values back to settings.json (they
//   are not "ours" to persist) and we do NOT clobber them when
//   setTokenPlanApiKey("") is called from the webui (it only clears
//   the in-memory + settings.json path).
let _envTokenPlanKey = "";     // captured from process.env at init
let _fileTokenPlanKey = "";    // read from conventional file at init
let _fileTokenPlanPath = "";   // resolved path (for log line + UI display)
let _externalKeySource = "";   // "env" | "file" | "" (empty = settings.json only)

// -----------------------------------------------------------------------
// Token generation
// -----------------------------------------------------------------------

// crypto.randomBytes(16).toString('hex') = 32 hex chars. Matches the
// 32-hex convention already used elsewhere in webui (CID, session id).
// 16 bytes = 128 bits entropy = far beyond the 2^80 brute-force floor.
export function generateToken() {
  return randomBytes(16).toString("hex");
}

// -----------------------------------------------------------------------
// Token lifecycle (delegate to auth.js via setter; here we just own the
//   in-memory + persistent state, the auth gate reads it through
//   getExpectedToken() in auth.js which calls back into the public getters
//   below)
// -----------------------------------------------------------------------

// applyExpectedTokenSync — sync the auth module's expected token to
// match our in-memory currentToken. Called by init() and after rotation.
// We do this in two places: settings.js owns the persistent state, auth.js
// owns the in-memory expectation + the gate logic. They are loosely
// coupled through the exported setters below.
import { setExpectedToken as _authSetExpectedToken } from "./auth.js";

function syncAuthToken() {
  // env TOKEN always wins (preserves v1.0.1 escape hatch)
  if (process.env.TOKEN) return;
  _authSetExpectedToken(currentToken);
}

// -----------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------

function ensureDir() {
  try {
    mkdirSync(dirname(_settingsPath()), { recursive: true });
  } catch (e) {
    // Best-effort: if we can't create the dir (permission denied etc.)
    // we still try to read the file (it may exist) and log the issue.
    console.warn(`[webui] settings mkdir ${dirname(_settingsPath())} failed: ${e.message}`);
  }
}

// Best-effort 0600 file open on Unix. On Windows, the OS doesn't enforce
// POSIX mode bits, but we still pass the mode to chmod-equivalent APIs.
// We use openSync to atomically create the file with mode 0600.
function writeAtomic(path, content) {
  ensureDir();
  let fd;
  try {
    fd = openSync(path + ".tmp", "w", 0o600);
  } catch (e) {
    // On Windows / some FS, 0o600 in openSync may not be honored; fall
    // back to plain writeFileSync (still atomic via .tmp + rename).
    writeFileSync(path + ".tmp", content, { encoding: "utf8", mode: 0o600 });
    renameSync(path + ".tmp", path);
    return;
  }
  try {
    const buf = Buffer.from(content, "utf8");
    writeFileSync(fd, buf);
  } finally {
    try { closeSync(fd); } catch {}
  }
  try {
    renameSync(path + ".tmp", path);
  } catch (e) {
    console.error(`[webui] settings rename ${path} failed: ${e.message}`);
    throw e;
  }
}

function loadFromDisk() {
  const path = _settingsPath();
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`[webui] settings read ${path} failed: ${e.message}`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return parsed;
  } catch (e) {
    // Corrupt file — back it up + fall back to defaults
    console.error(`[webui] settings parse ${path} failed: ${e.message}; backing up to .bak and using defaults`);
    try {
      renameSync(path, path + ".bak");
    } catch {}
    return null;
  }
}

// Public, testable: build the JSON body that gets persisted.
// Excludes `lanBroadcast` (intentionally not persisted per the reboot
// policy above).
export function buildPersistBody() {
  return {
    version: SETTINGS_VERSION,
    readOnly: readOnlyEnabled,
    tokenEnabled: tokenAuthEnabled,
    currentToken: currentToken,
    tokenRotatedAt: tokenRotatedAt,
    tokenAcknowledged: tokenAcknowledged,
    quotaEnabled: quotaEnabled,
    tokenPlanApiKey: tokenPlanApiKey,
  };
}

function persistNow() {
  try {
    writeAtomic(_settingsPath(), JSON.stringify(buildPersistBody(), null, 2));
  } catch (e) {
    console.error(`[webui] settings persist ${_settingsPath()} failed: ${e.message}`);
    throw e;
  }
}

// init() — load from disk, decide initial token, write back if needed.
//
// Behavior:
//   - On disk: load all fields from settings.json. Token survives restarts.
//   - No disk (first run):
//     1. Reset in-memory state to defaults (in case previous code in
//        the same process left stale state — e.g. tests that set fields
//        then re-init).
//     2. If process.env.TOKEN is set: don't touch currentToken; we don't
//        echo env-provided tokens to stdout.
//     3. Else: generate a fresh 32-hex token, write to disk, call
//        printToken (so the operator can see/copy it).
//   - We ALWAYS call persistNow() at the end of init() when onDisk is
//     empty (i.e. first run after a fresh dir or a corrupt file). For
//     the "we loaded from disk" case we don't write back — the in-memory
//     state is already the source of truth, no need to re-serialize.
export function init(opts = {}) {
  const { printToken } = opts;
  const onDisk = loadFromDisk();
  const d = defaultState();
  let firstRun = false;

  if (onDisk) {
    // Validate + apply
    if (typeof onDisk.readOnly === "boolean") readOnlyEnabled = onDisk.readOnly;
    if (typeof onDisk.tokenEnabled === "boolean") tokenAuthEnabled = onDisk.tokenEnabled;
    if (typeof onDisk.currentToken === "string") currentToken = onDisk.currentToken;
    if (typeof onDisk.tokenRotatedAt === "number") tokenRotatedAt = onDisk.tokenRotatedAt;
    if (typeof onDisk.tokenAcknowledged === "boolean") tokenAcknowledged = onDisk.tokenAcknowledged;
    if (typeof onDisk.quotaEnabled === "boolean") quotaEnabled = onDisk.quotaEnabled;
    if (typeof onDisk.tokenPlanApiKey === "string") tokenPlanApiKey = onDisk.tokenPlanApiKey;
  } else {
    firstRun = true;
    // Reset in-memory state to defaults
    readOnlyEnabled = d.readOnly;
    tokenAuthEnabled = d.tokenEnabled;
    tokenAcknowledged = d.tokenAcknowledged;
    currentToken = "";
    tokenRotatedAt = 0;
  }

  // Token resolution priority:
  //   1. process.env.TOKEN (highest — escape hatch for deploys)
  //   2. settings.json currentToken (if any, from onDisk)
  //   3. generate fresh
  if (process.env.TOKEN) {
    // env wins — do not touch currentToken
  } else if (firstRun) {
    // No env, no disk: generate fresh
    currentToken = generateToken();
    tokenRotatedAt = Date.now();
    tokenAcknowledged = false;
  } else if (!currentToken) {
    // Loaded from disk but token field was missing/empty (shouldn't happen
    // with a valid file, but be defensive). Generate.
    currentToken = generateToken();
    tokenRotatedAt = Date.now();
    tokenAcknowledged = false;
  } else {
    // We have a currentToken from disk; if tokenEnabled is true and
    // tokenAcknowledged is false, the operator presumably hasn't seen
    // the new token yet (rotation happened while they were away). We
    // DO NOT auto-print to stdout (that would leak on every restart
    // for users who already saw it). The settings card will show it
    // because tokenAcknowledged is false.
  }

  if (firstRun) {
    // Persist the freshly initialized state
    try { persistNow(); } catch {}
    // Print to stdout ONCE (not to file logs) so the operator sees it
    // if they're running interactively. Tests can pass a printToken
    // callback to capture or suppress the print.
    if (typeof printToken === "function") {
      try { printToken(currentToken); } catch {}
    }
  }

  // Sync to auth module
  syncAuthToken();

  // v2026-08-28 modacker: capture external Token Plan key sources
  //   (env / file). Done after the auth sync so any startup errors
  //   in the auth path are surfaced before we touch the key plumbing.
  //   If an external key is found and no on-disk key was loaded,
  //   we also auto-enable quotaEnabled — the operator already
  //   committed to using the feature by setting the env / writing
  //   the file, so flipping the switch on is just plumbing.
  _loadExternalTokenPlanKeys();
  if (_externalKeySource && !onDisk && typeof onDisk === "object") {
    // firstRun: settings.json was just created with quotaEnabled=false.
    // External key was found → auto-enable.
  }
  if (_externalKeySource) {
    const wasEnabled = quotaEnabled;
    quotaEnabled = true;
    if (!wasEnabled) {
      console.log(
        `[webui] Token Plan: external key source="${_externalKeySource}", auto-enabling quota`,
      );
    }
  }
}

// -----------------------------------------------------------------------
// Getters
// -----------------------------------------------------------------------

export function getLanBroadcast() {
  return lanBroadcastEnabled;
}

export function getReadOnly() {
  return readOnlyEnabled;
}

export function getTokenEnabled() {
  return tokenAuthEnabled;
}

export function getCurrentToken() {
  return currentToken;
}

export function getTokenRotatedAt() {
  return tokenRotatedAt;
}

export function getTokenAcknowledged() {
  return tokenAcknowledged;
}

// v2026-08-28 modacker: Token Plan (套餐用量) feature gates.
// When `quotaEnabled=false` OR no `tokenPlanApiKey` set, the
// "套餐用量" button is hidden in the UI and the API isn't called.
//
// v2026-08-28 (later): getTokenPlanApiKey() now consults external
//   sources in priority order: env > file > settings.json. The
//   in-memory `tokenPlanApiKey` (settings.json) is the lowest tier.
//   Use getTokenPlanApiKeySource() to see which tier is in effect —
//   the webui uses this to decide whether to show the "delete" button
//   (only enabled for settings.json, not for env / file).
export function getQuotaEnabled() {
  return quotaEnabled;
}

export function getTokenPlanApiKey() {
  if (_envTokenPlanKey) return _envTokenPlanKey;
  if (_fileTokenPlanKey) return _fileTokenPlanKey;
  return tokenPlanApiKey;
}

// getTokenPlanApiKeySource — "env" | "file" | "settings" | "".
//   Empty string means the key came from the in-memory settings.json
//   path (the "settings" value) — distinguishing the empty-source
//   case from "no key at all" requires checking hasTokenPlanKey().
export function getTokenPlanApiKeySource() {
  if (_externalKeySource) return _externalKeySource;
  return tokenPlanApiKey ? "settings" : "";
}

// getTokenPlanApiKeyFilePath — exposed for the UI's "managed by file:
// <path>" tooltip. Empty when the file source is not in use.
export function getTokenPlanApiKeyFilePath() {
  return _fileTokenPlanPath || "";
}

// maskTokenPlanKey — for the GET /api/settings response. Returns
// "sk-cp-...XXXX" where XXXX is the last 4 chars. Empty string if
// no key set. The full key never leaves the server over GET.
export function maskTokenPlanKey() {
  const k = getTokenPlanApiKey();
  if (!k) return "";
  if (k.length <= 4) return "****";
  return "sk-cp-..." + k.slice(-4);
}

export function getAllowedInterfaces() {
  // Removed in v1.0.1 cleanup (per #16 reviewer scope). Kept as a
  // no-op stub for tests + clients that still call it — returns the
  // current "allow all" sentinel ([]).
  return [];
}

// getPersistPath — exposed for tests + startup log ("settings at ...")
export function getPersistPath() {
  return _settingsPath();
}

// -----------------------------------------------------------------------
// v2026-08-28 modacker: External Token Plan key sources
//   - MCODE_WEBUI_TOKEN_PLAN_KEY env var
//   - ~/.minimax/credentials/token-plan.json (path overridable via
//     MCODE_WEBUI_TOKEN_PLAN_KEY_FILE)
//   Both are read once at init() and shadow the settings.json value
//   when present. See comment on _externalKeySource for the rationale.
// -----------------------------------------------------------------------

// _resolveTokenPlanKeyFile — convention: ~/.minimax/credentials/token-plan.json.
//   Resolve relative paths against cwd; absolutize, don't trust
//   shell-expanded values.
function _resolveTokenPlanKeyFile() {
  if (process.env.MCODE_WEBUI_TOKEN_PLAN_KEY_FILE) {
    return resolve(process.env.MCODE_WEBUI_TOKEN_PLAN_KEY_FILE);
  }
  return join(homedir(), ".minimax", "credentials", "token-plan.json");
}

// _readTokenPlanKeyFile — best-effort JSON read; never throws.
//   Accepts either {"key": "..."} or a raw string in the file body
//   (whitespace-trimmed), so an operator can `echo "sk-cp-..." >
//   token-plan.json` without worrying about JSON syntax. Future
//   fields (accountId, groupId) ignored.
function _readTokenPlanKeyFile() {
  const p = _resolveTokenPlanKeyFile();
  if (!existsSync(p)) return { key: "", path: "" };
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    console.warn(
      `[webui] token-plan key file read ${p} failed: ${e.message} — falling back to settings.json`,
    );
    return { key: "", path: p };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { key: "", path: p };
  // Try JSON first; fall back to raw.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.key === "string") {
        return { key: parsed.key.trim(), path: p };
      }
    } catch {
      // fall through to raw
    }
  }
  return { key: trimmed, path: p };
}

// _loadExternalTokenPlanKeys — called from init(). Captures the
//   env var + reads the file once. Order: env wins; file is the
//   fallback. Sets _externalKeySource so getTokenPlanApiKeySource()
//   can report "env" / "file" / "" (settings.json only).
function _loadExternalTokenPlanKeys() {
  const envRaw = (process.env.MCODE_WEBUI_TOKEN_PLAN_KEY || "").trim();
  _envTokenPlanKey = envRaw;
  if (envRaw) {
    _externalKeySource = "env";
    return;
  }
  const fileRead = _readTokenPlanKeyFile();
  _fileTokenPlanKey = fileRead.key;
  _fileTokenPlanPath = fileRead.path;
  if (fileRead.key) {
    _externalKeySource = "file";
  } else {
    _externalKeySource = "";
  }
}

// Public, for tests: clear + reload external sources. init() calls
// this on startup; tests can call it again after mutating process.env
// or the file.
export function reloadExternalTokenPlanKeys() {
  _loadExternalTokenPlanKeys();
}

// -----------------------------------------------------------------------
// Setters (mutate in-memory + persist; on error, the in-memory state
//   has already changed — callers must decide what to do; we do NOT
//   revert to keep the in-memory state as source of truth).
// -----------------------------------------------------------------------

export function setLanBroadcast(v) {
  lanBroadcastEnabled = !!v;
  console.log(
    `[webui] LAN access ${lanBroadcastEnabled ? "enabled" : "disabled"}`,
  );
}

export function setReadOnly(v) {
  readOnlyEnabled = !!v;
  console.log(`[webui] read-only mode ${readOnlyEnabled ? "enabled" : "disabled"}`);
  try { persistNow(); } catch (e) { /* logged in persistNow */ }
}

export function setTokenEnabled(v) {
  tokenAuthEnabled = !!v;
  console.log(`[webui] token auth ${tokenAuthEnabled ? "enabled" : "disabled"}`);
  // No persist needed (lanBroadcast isn't persisted either; on the
  // v1.0.1 contract, tokenEnabled survives a restart by defaulting to
  // true). We DO persist it so a power-cycle keeps the user's choice.
  try { persistNow(); } catch {}
}

export function setTokenAcknowledged(v) {
  tokenAcknowledged = !!v;
  try { persistNow(); } catch {}
}

export function setAllowedInterfaces(_ifaces) {
  // Removed in v1.0.1 cleanup (per #16 reviewer scope). No-op stub.
}

// v2026-08-28 modacker: set the Subscription Key (Token Plan API key).
// Empty string clears it. Persisted on disk next to other settings;
// the key is stored in plain text in settings.json (same trust model
// as the existing currentToken). The owner is responsible for ensuring
// ~/.mcode-webui/settings.json is readable only by the user account
// running the webui.
//
// If an external source (env / file) is in effect, the in-memory
// `tokenPlanApiKey` is still written and persisted — that way, if
// the operator later unsets the env / removes the file, the
// settings.json value is already there waiting. The webui's
// "managed by env/file" badge hides this from the user, but the
// data is preserved. This matches the existing pattern: env is
// authoritative at READ time; the underlying disk state is kept
// in sync regardless of which source is currently in use.
export function setTokenPlanApiKey(k) {
  tokenPlanApiKey = typeof k === "string" ? k : "";
  try { persistNow(); } catch {}
}

export function setQuotaEnabled(v) {
  quotaEnabled = !!v;
  // Disabling also clears the settings.json key (don't keep
  // credentials around if the user explicitly turned the feature
  // off). External env/file keys are NOT cleared here — they're
  // the operator's, not ours to delete. If the operator unset the
  // env / file, getTokenPlanApiKey() will already return "" and
  // /api/usage will fail with a clear "no key" path. Toggling
  // off then back on will reuse the settings.json value if it
  // was non-empty when toggled off, so the user's last typed key
  // survives a UI round-trip even when env/file are not present.
  if (!quotaEnabled) {
    tokenPlanApiKey = "";
  }
  try { persistNow(); } catch {}
}

// rotateToken — generate a new token, persist, sync to auth module.
//   Caller is responsible for broadcasting the new token via SSE.
//   Returns the new token string.
//
// v1.0.1: order of operations is critical for crash-safety.
//   1. Generate the new token into a local variable (don't touch
//      module-level state yet).
//   2. Persist to disk FIRST. If this throws (disk full, permission
//      denied), in-memory state stays untouched — no inconsistency.
//   3. ONLY after persist succeeds, commit the new values to the
//      module-level lets and sync to the auth module.
//   This ensures the in-memory token ALWAYS matches what's on disk.
export function rotateToken() {
  const newToken = generateToken();
  const newRotatedAt = Date.now();
  // Persist into a *tentative* file first. We don't touch the
  // module-level state until persistNow() returns without throwing.
  // To do that without exposing a separate setter API, we temporarily
  // swap the in-memory values, persist, then either commit (good) or
  // roll back (throw → caught by caller, no in-memory change).
  const prevToken = currentToken;
  const prevRotatedAt = tokenRotatedAt;
  const prevAck = tokenAcknowledged;
  currentToken = newToken;
  tokenRotatedAt = newRotatedAt;
  tokenAcknowledged = false;
  try {
    persistNow();
  } catch (e) {
    // Roll back in-memory state to match what was on disk
    currentToken = prevToken;
    tokenRotatedAt = prevRotatedAt;
    tokenAcknowledged = prevAck;
    throw e;
  }
  syncAuthToken();
  return currentToken;
}

// -----------------------------------------------------------------------
// LAN reject page
// v1.0.1: SINGLE bilingual page (zh + en side-by-side) — not Accept-Language
//   switching. Per user feedback: a user on a Chinese host might be
//   browsing in English (or vice versa); they want both visible at once.
//   Dynamic PORT (was hardcoded 7890 which broke when PORT was changed
//   to 8080 default).
// -----------------------------------------------------------------------

// Single bilingual HTML — both languages always visible. Each block is
// `zh` then `en` separated by a thin divider. No Accept-Language sniffing.
const LAN_REJECT_HTML = (
  remoteIp,
  localUrl,
) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>webui — LAN access disabled / 局域网访问已关闭</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 640px; margin: 80px auto; padding: 24px; color: #333; line-height: 1.6; }
h1 { color: #c0392b; margin-top: 0; font-size: 22px; }
code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 14px; word-break: break-all; }
.box { background: #fef9e7; border-left: 4px solid #f1c40f; padding: 14px 18px; border-radius: 4px; margin: 20px 0; }
.lang { display: block; }
.lang + .lang { margin-top: 12px; padding-top: 12px; border-top: 1px dashed #ddd; }
.tag { display: inline-block; font-size: 10px; font-weight: 700; color: #888; background: #eee; padding: 1px 6px; border-radius: 3px; margin-bottom: 4px; letter-spacing: 0.5px; }
</style></head><body>

<span class="lang"><span class="tag">ZH</span>
<h1>局域网访问已关闭</h1>
<p>本 webui 当前<strong>仅允许本机访问</strong>，你的设备（<code>${remoteIp || "远程"}</code>）不在白名单内。</p>
<div class="box"><strong>如何开启：</strong><br>在 webui 所在的电脑上打开 <code>${localUrl}</code> → 左下角"局域网访问"按钮 → 开启</div>
<p>或直接用本机 URL：<code>${localUrl}</code></p>
</span>

<span class="lang"><span class="tag">EN</span>
<h1>LAN access disabled</h1>
<p>webui is currently <strong>loopback-only</strong>. Your device (<code>${remoteIp || "remote"}</code>) is not in the allowlist.</p>
<div class="box"><strong>How to enable:</strong><br>On the host machine, open <code>${localUrl}</code> → click the "LAN access" button at the bottom-left → turn it on</div>
<p>Or use the local URL directly: <code>${localUrl}</code></p>
</span>

</body></html>`;

const LAN_REJECT_JSON = {
  ok: false,
  error: "LAN access disabled. Open settings on the host machine to enable. / 局域网访问已关闭。在本机打开设置开启。",
};

export function rejectLan(res, pathname, remoteIp, _acceptLanguage) {
  // _acceptLanguage kept for back-compat with router.js's call site,
  // but no longer used — the page is now always bilingual.
  const isApi = pathname.startsWith("/api/");
  const isSettings = pathname === "/api/settings"; // 让用户能远程切回
  if (isSettings) return false;
  const localUrl = `http://127.0.0.1:${PORT}/`;
  if (isApi) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(LAN_REJECT_JSON));
    return true;
  }
  res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
  res.end(LAN_REJECT_HTML(remoteIp, localUrl));
  return true;
}

// -----------------------------------------------------------------------
// getSettingsSnapshot — returned to clients via /api/settings
// -----------------------------------------------------------------------

// _effectiveShareToken — token the *server* uses to authenticate
// non-local requests. Order of precedence (per the auth gate):
//   1. process.env.TOKEN (env always wins)
//   2. in-memory currentToken (set by settings.js after init / rotation)
// Returns "" if no token configured (token auth effectively off).
function _effectiveShareToken() {
  if (process.env.TOKEN) return process.env.TOKEN.toString();
  return tokenAuthEnabled ? currentToken : "";
}

export function getSettingsSnapshot(availableInterfaces = null) {
  // currentToken is ONLY included when the operator hasn't acknowledged
  // it yet. After acknowledgment we omit the value to reduce the
  // window in which it lives in memory + over the wire.
  const includeToken = !tokenAcknowledged;
  // v1.0.1: include the full LAN URL (with token) for the top-bar chip
  // — when the user clicks it, they get a shareable URL that other
  // devices can actually use. Bare `lanUrl` (no token) stays in the
  // response for display purposes (the top-bar chip only shows the
  // host:port, not the query string).
  const baseUrl = `http://${LAN_IP}:${PORT}`;
  const shareToken = _effectiveShareToken();
  const lanUrlWithToken = shareToken
    ? `${baseUrl}/?token=${encodeURIComponent(shareToken)}`
    : baseUrl;
  return {
    ok: true,
    lanBroadcast: lanBroadcastEnabled,
    readOnly: readOnlyEnabled,
    tokenEnabled: tokenAuthEnabled,
    tokenAcknowledged: tokenAcknowledged,
    currentToken: includeToken ? currentToken : "",
    tokenRotatedAt: tokenRotatedAt,
    // v2026-08-28 modacker: Token Plan (套餐用量) feature.
    // `quotaEnabled` is the master switch. The Subscription Key is
    // NEVER returned in full — only the masked preview. The full key
    // is read directly from settings.js server-side when /api/usage
    // fires the upstream API.
    //   - `tokenPlanApiKeySource` ("env" / "file" / "settings" / ""):
    //     tells the UI where the active key came from. The webui
    //     uses this to hide the "delete" button when the key is
    //     managed externally — you can only delete what you set.
    //   - `tokenPlanApiKeyFilePath`: the resolved file path when
    //     source === "file", for the tooltip / status line. Empty
    //     string otherwise.
    //   - `hasTokenPlanKey` is true if ANY of the three tiers
    //     (env / file / settings.json) has a non-empty key. This
    //     is the "can we call the upstream API right now?" signal.
    quotaEnabled: quotaEnabled,
    tokenPlanApiKeyMasked: maskTokenPlanKey(),
    hasTokenPlanKey: !!getTokenPlanApiKey(),
    tokenPlanApiKeySource: getTokenPlanApiKeySource(),
    tokenPlanApiKeyFilePath: getTokenPlanApiKeyFilePath(),
    port: PORT,
    host: HOST,
    lanIp: LAN_IP,
    lanUrl: baseUrl,
    lanUrlWithToken,
    localUrl: `http://127.0.0.1:${PORT}`,
    mcodeCmd: MCODE_CMD,
    mcodeVersion: "0.1.2",
    defaultWorkspace: DEFAULT_WORKSPACE,
    defaultModel: DEFAULT_MODEL,
  };
}
