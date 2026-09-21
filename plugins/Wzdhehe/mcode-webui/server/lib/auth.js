// webui/server/lib/auth.js
// TOKEN-based authentication middleware.
//
// Implements the contract documented in
// plugins/Wzdhehe/mcode-webui/references/SECURITY-NOTES.md §"Inbound auth":
//
//   - Local request (isLocalRequest === true) is always allowed (LAN card
//     switch + first page load without token).
//   - Non-local request requires a token when TOKEN auth is enabled:
//       * `?token=<value>` query string (for SSE EventSource — browsers
//         can't set custom headers on EventSource).
//       * `Authorization: Bearer <value>` header (for fetch / programmatic
//         callers; preferred to avoid URL-bar / referer / history leaks).
//   - Token auth can be turned off (tokenEnabled = false) at runtime via
//     the settings card; this is the "opt-in" escape hatch.
//   - Static files (HTML/CSS/JS/images) and OPTIONS preflight are always
//     public so the SPA can bootstrap; only `/api/*` and SSE are gated.
//
// v2 security note (PR #55 review point 1): the local bypass below is a
// SOCKET-identity fact (the connection originated on this machine), not
// a browser-origin fact. It must never double as a cross-origin
// exemption: a page on evil.com targeting http://127.0.0.1:<port> also
// arrives over a loopback socket. The browser boundary is enforced
// separately and EARLIER by router.js Gate 1b (mutating requests with
// an untrusted Origin header are 403'd before this module runs, local
// or not) plus Gate 1's trusted-origin-only CORS reflection.
//
// Token resolution priority on each request:
//   1. process.env.TOKEN (env wins, always — deploys / docker)
//   2. In-memory `expectedToken` (synced from settings.js after rotation)
//   3. Static TOKEN from config.js (fallback for tests)
//
// If tokenEnabled is false (set via settings.js setter) AND process.env.TOKEN
// is empty AND the in-memory expectedToken is also empty, no auth is enforced
// (backwards-compatible "loopback-only" / "trusted LAN" deployment).

import { isLocalRequest } from "./lan.js";
import { TOKEN } from "./config.js";

// In-memory expected token. setExpectedToken() from settings.js writes
// this after init / rotation. The process.env.TOKEN path always wins —
// see getExpectedToken() below.
let expectedToken = "";

// Token auth master switch. When false, requests bypass the token check
// even if a token is set (LAN-only deployment). Default true.
let tokenAuthOn = true;

export function setExpectedToken(v) {
  expectedToken = (typeof v === "string") ? v : "";
}

export function setTokenAuthEnabled(v) {
  tokenAuthOn = !!v;
}

// The expected token. Resolved per-request (rather than once at module
// load) so that:
//   - tests can use t.mock.module() to swap config.js and re-import
//     without rebooting the process;
//   - admins who set TOKEN via a process supervisor (no restart) see
//     the new value on the next request after the env var changes;
//   - settings.js's rotateToken() can swap the in-memory value without
//     touching the environment.
function getExpectedToken() {
  // env always wins (back-compat escape hatch)
  if (process.env.TOKEN) return process.env.TOKEN.toString();
  return expectedToken || TOKEN || "";
}

// Pull a token candidate out of a request. Tries the header first
// (preferred), then the URL query string (for SSE / EventSource).
// Returns "" if no token candidate is present. Caps length to defend
// against unbounded `?token=...` allocations (e.g. 10 MB blob).
const MAX_TOKEN_LEN = 256;

function clip(s) {
  if (typeof s !== "string") return "";
  if (s.length > MAX_TOKEN_LEN) return s.slice(0, MAX_TOKEN_LEN);
  return s;
}

export function extractToken(req) {
  // EventSource / fetch with custom headers can use `Authorization: Bearer`.
  const auth = req.headers && req.headers.authorization;
  if (auth) {
    // v2 security fix (PR #55 / CodeQL): the old `^Bearer\s+(.+)$` paired
    // an overlapping `\s+`/`.+` — polynomial backtracking on hostile
    // headers. `[ \t]+` then `(\S.*)` use disjoint character classes, so
    // the match is linear. Whitespace other than SP/HTAB after "Bearer"
    // now fails closed (falls through to the query-string path).
    const m = /^Bearer[ \t]+(\S.*)$/i.exec(String(auth));
    if (m) return clip(m[1].trim());
  }
  // URL query fallback (also covers EventSource on browsers that strip
  // custom headers). Safe-ish because we only use it for equality
  // comparison, never log it.
  try {
    const u = new URL(req.url, "http://x");
    const q = u.searchParams.get("token");
    if (q) return clip(q);
  } catch {
    // ignore — bad URL means no token
  }
  return "";
}

// Constant-time-ish string compare. Avoids length-only early exit by
// XORing the lengths first.
export function safeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) {
    // still consume b's bytes to keep timing roughly constant
    for (let i = 0; i < b.length; i++) {
      // mod a.length so we never read past `a`'s bounds; result unused
      a.charCodeAt(i % a.length) ^ b.charCodeAt(i);
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// True if the request is allowed without further auth checks.
export function isRequestAuthorized(req) {
  if (isLocalRequest(req)) return true;
  if (!tokenAuthOn) return true;
  const expected = getExpectedToken();
  if (!expected) return true; // no token configured = no enforcement
  const supplied = extractToken(req);
  return safeEquals(supplied, expected);
}

// Reject with 401. Sends a small JSON body (or a plain string for
// EventSource which prefers text/event-stream). The response never
// echoes the supplied token or the expected token.
export function writeAuthRequired(res) {
  if (!res.headersSent) {
    try {
      res.writeHead(401, {
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate": 'Bearer realm="webui"',
      });
      res.end(JSON.stringify({ ok: false, error: "auth required" }));
      return true;
    } catch {
      // fall through
    }
  }
  try {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("auth required");
  } catch {}
  return true;
}

// For tests / debugging: returns whether auth is currently enforced.
// (Local requests still bypass; this only reflects "is a TOKEN set" + "is
// tokenAuthOn".)
export function isAuthEnforced() {
  if (!tokenAuthOn) return false;
  return Boolean(getExpectedToken());
}

// ============================================================
// v2 (Lease C08) — First-run notification flag
//
// Background (ANTI-PATTERNS-FIX-PLAN §AP1):
//   server.js used to print a 14-line ASCII box containing the raw
//   token to stdout on first-ever boot. That leaked into shell
//   history / Docker logs / systemd journal / screen shares. The fix
//   pushes the token via SSE `token.first_run` so the UI can show it
//   in a modal instead. Rotation uses `auth.token_rotated` (already in
//   state-bus.js since v1.0.1).
//
// Surface:
//   - isFirstRun() — true iff this process has NOT yet pushed a
//     `token.first_run` SSE event in its lifetime. Used by
//     state-bus.js#pushTokenFirstRun as a re-send guard.
//   - markFirstRunNotified(token) — flip the in-memory flag. Called
//     from the HTTP ack handler after the client closes the modal,
//     or directly by tests. Async because it lazily imports
//     settings.js to also persist the canonical `tokenAcknowledged`
//     field (settings.json).
//
// Settings.js owns the persistent `tokenAcknowledged`; auth.js's
// `_firstRunNotified` is the parallel in-memory mirror used to gate
// the SSE re-send. The two stay in sync via this helper.
// ============================================================

let _firstRunNotified = false;

export function isFirstRun() {
  return !_firstRunNotified;
}

export async function markFirstRunNotified(token) {
  _firstRunNotified = true;
  // Lazy-import settings.js to avoid the static circular dep:
  //   settings.js  →  auth.js  (setExpectedToken)
  //   auth.js (this file) must NOT statically import settings.js back.
  // Dynamic import resolves AFTER both modules finish loading, so this
  // is safe. settings.js#setTokenAcknowledged persists to disk and
  // emits an audit event.
  try {
    const m = await import("./settings.js");
    // Sanity check: if caller passed a token, it must match the
    // currently active one. Stale tokens (e.g. ack from a previous
    // generation that didn't get a rotation broadcast) should NOT
    // flip the canonical flag — they'd hide a token the operator
    // never actually saw.
    if (typeof token === "string" && token.length > 0) {
      const current =
        typeof m.getCurrentToken === "function" ? m.getCurrentToken() : "";
      if (current && current !== token) return;
    }
    if (typeof m.setTokenAcknowledged === "function") {
      m.setTokenAcknowledged(true);
    }
  } catch {
    // settings.js not yet ready (boot race) or setTokenAcknowledged
    // missing — silent no-op. The HTTP ack handler in
    // routes/settings.js calls setTokenAcknowledged directly, so the
    // canonical flag will still flip on the next user action.
  }
}
