// webui/server/router.js
// Central HTTP request dispatcher.
//
// Order of gates (top-to-bottom):
//   1. CORS headers — trusted-origin reflection only (v2, PR #55 review
//      point 1); untrusted/absent Origin gets no CORS headers at all
//   1b. Browser Origin/CSRF gate — mutating request with an untrusted
//      Origin is 403'd BEFORE any other gate (local requests included)
//   2. LAN reject (non-local + LAN off)
//   3. Token auth (non-local + token enabled + token set)
//   4. Rate limit (per-{IP,token}; /api/* minus /api/health; OPTIONS exempt)
//   5. Read-only gate (non-local + readOnly + non-GET/OPTIONS)
//   6. Route dispatch
//
// Local requests (loopback + this host's LAN_IP) bypass (2)(3)(4)(5) —
// but NEVER (1b): socket locality is an identity fact about the client
// machine, not about the browser page that initiated the request, so
// the loopback token bypass does not extend to cross-origin pages.
// `/api/settings` is exempted from (2) so users can flip the LAN switch
// back on from a remote device.

import { PORT } from "./lib/config.js";
import {
  isLocalRequest,
  buildTrustedOrigins,
  normalizeOriginHeader,
} from "./lib/lan.js";
import {
  getLanBroadcast,
  getReadOnly,
  getTrustedOrigins,
  rejectLan,
} from "./lib/settings.js";
import { getClient, getCidFromReq } from "./lib/state-bus.js";
import { serveStatic, serveIndex } from "./lib/static.js";
import { isRequestAuthorized, writeAuthRequired } from "./lib/auth.js";
// v2.0 (lease C03): per-{IP,token} fixed-window rate limiter. See
// server/lib/rate-limit.js for the algorithm + tunables.
import { rateLimitMiddleware } from "./lib/rate-limit.js";
// v2.0 (reconcile §6.1): POST /api/auth/decision handler. Per-request
// authorize() in server/lib/authorize.js (B03) needs a route to receive
// the client's {requestId, approve} reply; without this binding the
// authorize() Promise hangs forever.
import * as authorizeRoute from "./lib/authorize.js";

import * as healthRoute from "./routes/health.js";
import * as stateRoute from "./routes/state.js";
// v2.0 (lease B02): independent anomaly channel — bell icon data feed
import * as alertsRoute from "./routes/alerts.js";
import * as sessionsRoute from "./routes/sessions.js";
// v2.0 (lease C06): session export (Markdown / JSON)
import * as exportRoute from "./routes/export.js";
import * as chatRoute from "./routes/chat.js";
import * as usageRoute from "./routes/usage.js";
import * as workspaceRoute from "./routes/workspace.js";
import * as settingsRoute from "./routes/settings.js";
import * as uploadRoute from "./routes/upload.js";
import * as modelRoute from "./routes/model.js";
import * as debugRoute from "./routes/debug.js";
// v0.5.by: mcode acp 协议 RPC 路由 (set_mode / set_config_option / cancel / load / activate)
import * as protocolRoute from "./routes/protocol.js";

function rejectReadOnly(res, _pathname) {
  if (!res.headersSent) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "read-only mode" }));
  }
  return true;
}

// Route table: pattern → handler. Patterns are tested in declaration order; first match wins.
// Each entry: { method, match(pathname) → boolean, handler(req, res, ctx) }
const ROUTES = [
  // Static + HTML
  {
    method: "GET",
    match: (p) => p === "/" || p === "/index.html",
    handler: (_req, res) => {
      if (serveIndex(res) === false) {
        res.writeHead(404);
        res.end("not found");
      }
      return true;
    },
  },
  {
    method: "GET",
    match: (p) => !!p && p !== "/" && p.includes("."),
    handler: (_req, res, _ctx, pathname) => {
      if (serveStatic(pathname, res) !== false) return true;
      return false; // not handled — fall through
    },
  },

  // OPTIONS (CORS preflight) — short-circuit before anything else
  {
    method: "OPTIONS",
    match: () => true,
    handler: (_req, res) => {
      res.writeHead(204);
      res.end();
      return true;
    },
  },

  // Health
  {
    method: "GET",
    match: (p) => p === "/api/health",
    handler: healthRoute.handleHealth,
  },

  // State + SSE
  {
    method: "GET",
    match: (p) => p === "/api/events",
    handler: stateRoute.handleEvents,
  },
  {
    method: "GET",
    match: (p) => p === "/api/state",
    handler: stateRoute.handleState,
  },

  // v2.0 (lease B02): anomaly / system-signal SSE channel
  {
    method: "GET",
    match: (p) => p === "/api/alerts",
    handler: alertsRoute.handleAlerts,
  },

  // ACP session endpoints
  {
    method: "GET",
    match: (p) => p === "/api/acp-sessions",
    handler: sessionsRoute.handleAcpSessions,
  },
  {
    method: "GET",
    match: (p) => p === "/api/acp-session-title",
    handler: sessionsRoute.handleAcpSessionTitle,
  },

  // Sessions CRUD
  {
    method: "GET",
    match: (p) => p === "/api/sessions",
    handler: sessionsRoute.handleListSessions,
  },
  {
    method: "POST",
    match: (p) => p === "/api/sessions",
    handler: sessionsRoute.handleNewSession,
  },
  {
    method: "POST",
    match: (p) => p === "/api/sessions/switch",
    handler: sessionsRoute.handleSwitchSession,
  },
  // v2.0 (lease C06): GET /api/sessions/:id/export?format=md|json[&download=true]
  //   Registers before the DELETE match so a future change to that
  //   catch-all doesn't accidentally swallow GETs for /export. The
  //   DELETE match is method-gated, so this is defensive — both
  //   orderings work today.
  {
    method: "GET",
    match: (p) => /^\/api\/sessions\/[^\/]+\/export$/.test(p),
    handler: exportRoute.handleExport,
  },
  // Lease C05: GET /api/sessions/search?q=...&workspace=...&limit=...
  //   Cross-workspace session search. Registered as an exact match
  //   before the DELETE catch-all (which is method-gated anyway, so
  //   order is defensive — same rationale as the export route above).
  {
    method: "GET",
    match: (p) => p === "/api/sessions/search",
    handler: sessionsRoute.handleSearchSessions,
  },
  // v2.0 (reconcile §6.1): wire handleCleanupOrphans. Was exported by
  // server/routes/sessions.js (B03) but never bound to a route — docs/API.md
  // has documented POST /api/sessions/cleanup-orphans since v0.5.bx-19 and
  // check-docs-alignment §6 caught the drift. Method-gated POST + method-only
  // path match, so it doesn't collide with the DELETE catch-all below.
  {
    method: "POST",
    match: (p) => p === "/api/sessions/cleanup-orphans",
    handler: sessionsRoute.handleCleanupOrphans,
  },
  {
    method: "DELETE",
    match: (p) =>
      p.startsWith("/api/sessions/") && p.length > "/api/sessions/".length,
    handler: sessionsRoute.handleDeleteSession,
  },

  // Chat
  {
    method: "POST",
    match: (p) => p === "/api/send",
    handler: chatRoute.handleSend,
  },
  {
    method: "POST",
    match: (p) => p === "/api/stop",
    handler: chatRoute.handleStop,
  },
  {
    method: "POST",
    match: (p) => p === "/api/cmd",
    handler: chatRoute.handleCmd,
  },

  // Usage
  {
    method: "POST",
    match: (p) => p === "/api/usage" || p === "/api/usage-trigger",
    handler: usageRoute.handleUsage,
  },
  {
    method: "GET",
    match: (p) => p === "/api/usage-real",
    handler: usageRoute.handleUsageReal,
  },
  {
    method: "POST",
    match: (p) => p === "/api/refresh",
    handler: usageRoute.handleRefresh,
  },
  // C07: quota exhaustion forecast (linear LS on usage history)
  //   GET returns { ok: true, forecast: { hoursUntilExhaustion5h, ... } }
  //   pure read-only endpoint — no quota key required, just history.
  {
    method: "GET",
    match: (p) => p === "/api/usage/forecast",
    handler: usageRoute.handleForecast,
  },

  // Workspace
  {
    method: "POST",
    match: (p) => p === "/api/workspace",
    handler: workspaceRoute.handleWorkspace,
  },
  {
    method: "GET",
    match: (p) => p === "/api/workspace/browse",
    handler: workspaceRoute.handleWorkspaceBrowse,
  },

  // Settings
  {
    method: "GET",
    match: (p) => p === "/api/settings",
    handler: settingsRoute.handleGetSettings,
  },
  {
    method: "POST",
    match: (p) => p === "/api/settings",
    handler: settingsRoute.handlePostSettings,
  },
  // v2.0 (reconcile §6.1): POST /api/auth/decision — the SSE-driven
  // authorize gate close path. Was exported by server/lib/authorize.js
  // (B03) but never bound to a route. Client posts {requestId, approve}
  // to resolve the per-request authorize() Promise. Method-gated POST,
  // exact path match, before the catch-all.
  {
    method: "POST",
    match: (p) => p === "/api/auth/decision",
    handler: authorizeRoute.handleAuthDecision,
  },

  // Upload
  {
    method: "POST",
    match: (p) => p === "/api/upload",
    handler: uploadRoute.handleUpload,
  },

  // Model / permissions
  {
    method: "GET",
    match: (p) => p === "/api/models",
    handler: modelRoute.handleGetModels,
  },
  {
    method: "POST",
    match: (p) => p === "/api/set-model",
    handler: modelRoute.handleSetModel,
  },
  {
    method: "POST",
    match: (p) => p === "/api/permissions",
    handler: modelRoute.handleSetPermissions,
  },
  {
    method: "GET",
    match: (p) => p === "/api/permissions-modes",
    handler: modelRoute.handleListPermissionModes,
  },
  {
    method: "POST",
    match: (p) => p === "/api/answer",
    handler: modelRoute.handleAnswer,
  },

  // Debug (gated by DEBUG_INJECT=1)
  {
    method: "POST",
    match: (p) => p === "/api/debug/inject",
    handler: debugRoute.handleDebugInject,
  },
  {
    method: "GET",
    match: (p) => p === "/api/debug/state",
    handler: debugRoute.handleDebugState,
  },

  // v0.5.by: mcode acp 协议 RPC (plan/goal mode, permission, cancel, load TUI session)
  {
    method: "POST",
    match: (p) => p === "/api/protocol/set-mode",
    handler: protocolRoute.handleSetMode,
  },
  {
    method: "POST",
    match: (p) => p === "/api/protocol/set-config-option",
    handler: protocolRoute.handleSetConfigOption,
  },
  {
    method: "POST",
    match: (p) => p === "/api/protocol/cancel",
    handler: protocolRoute.handleCancel,
  },
  {
    method: "POST",
    match: (p) => p === "/api/protocol/load-session",
    handler: protocolRoute.handleLoadSession,
  },
  {
    method: "POST",
    match: (p) => p === "/api/protocol/activate-session",
    handler: protocolRoute.handleActivateSession,
  },
  {
    method: "GET",
    match: (p) => p === "/api/protocol/list-sessions",
    handler: protocolRoute.handleListSessions,
  },
  {
    method: "GET",
    match: (p) => p === "/api/protocol/capabilities",
    handler: protocolRoute.handleCapabilities,
  },
];

export async function handleRequest(req, res) {
  // Gate 1: CORS headers (trusted-origin reflection, v2 security fix —
  //   PR #55 review point 1).
  //   Was: an unconditional `Access-Control-Allow-Origin: *` on every
  //   response. Combined with the local-request token bypass
  //   (auth.js#isRequestAuthorized → lan.js#isLocalRequest) that let
  //   ANY web page read API responses by simply targeting
  //   http://127.0.0.1:<port> — the browser dialed loopback, the server
  //   saw a "local" socket, and the wildcard let the page read the
  //   body (incl. GET /api/settings' token-bearing share URL).
  //   Now: only origins we actually serve — loopback/localhost (+ the
  //   LAN address while LAN sharing is on) — plus the explicit
  //   trustedOrigins allowlist from settings get CORS headers, and the
  //   caller's own Origin is reflected verbatim, never a wildcard.
  //   Untrusted origins receive NO Access-Control-* headers on ANY
  //   response, including the OPTIONS preflight short-circuit below
  //   (preflight and actual response stay consistent), so browsers
  //   cannot read the body even though the request itself may execute.
  //   Clients that send no Origin header (curl, MCP, CLI, tests) get
  //   no CORS headers — they never needed them; zero regression.
  const originHeader = normalizeOriginHeader(req.headers.origin);
  const trustedOrigins = buildTrustedOrigins({
    port: PORT,
    lanBroadcast: getLanBroadcast(),
    extra: getTrustedOrigins(),
  });
  const originTrusted = originHeader !== "" && trustedOrigins.has(originHeader);
  // The response varies by request Origin whether or not this branch
  // reflects — caches must key on it either way.
  res.setHeader("Vary", "Origin");
  if (originTrusted) {
    res.setHeader("Access-Control-Allow-Origin", originHeader);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  // Gate 1b: browser Origin / CSRF boundary (v2 security fix — PR #55
  //   review point 1, the second half of the wildcard × local-bypass
  //   hole). Browsers attach an Origin header to non-GET requests
  //   (same- and cross-origin alike). If one is present and is NOT in
  //   the trusted set, the mutating request dies here with 403 —
  //   BEFORE the token gate, and CRUCIALLY without the local-request
  //   exemption: a malicious page targeting 127.0.0.1 arrives from a
  //   loopback socket, is "local", would bypass the token — and is
  //   still rejected, because its Origin is not ours. Origin-less
  //   clients (curl / MCP / CLI) pass through unchanged.
  if (
    originHeader !== "" &&
    !originTrusted &&
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    req.method !== "OPTIONS"
  ) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: false,
      error: "cross-origin request rejected",
    }));
    return;
  }

  const pathname = (req.url || "/").split("?")[0];
  const cid = getCidFromReq(req);
  const local = isLocalRequest(req);

  // Gate 2: LAN reject (only for non-local requests; /api/settings is the exception that lets users turn LAN back on)
  if (!local && !getLanBroadcast()) {
    if (rejectLan(res, pathname, req.socket.remoteAddress, req.headers["accept-language"])) return;
  }

  // Gate 3: token auth (v1.0.1).
  //   - Local request: always allowed.
  //   - /api/* routes (incl. SSE /api/events): gated when TOKEN auth enabled.
  //   - OPTIONS preflight: always allowed (browsers cannot attach
  //     Authorization to a preflight; CORS spec says server must respond
  //     to OPTIONS with the negotiated CORS headers, not 401).
  //     The OPTIONS short-circuit further down returns 204 with the
  //     CORS headers set here in Gate 1.
  //   - Static files (HTML/CSS/JS/images): always public so the SPA can
  //     bootstrap (load index.html, fetch app/main.js).
  //   - The SPA reads ?token= from the URL (browser) and stores it in
  //     localStorage; subsequent fetch + EventSource attach it as
  //     Authorization: Bearer / ?token=.
  if (
    pathname.startsWith("/api/") &&
    req.method !== "OPTIONS" &&
    !isRequestAuthorized(req) &&
    writeAuthRequired(res)
  ) {
    return;
  }

  // Gate 4: rate limit (v2.0, lease C03).
  //   - Loopback requests bypass entirely (isLocalRequest).
  //   - `/` and `/api/health` are never throttled — health must answer
  //     for orchestrators (k8s liveness probes), and `/` is a static
  //     file that goes through serveStatic, not the /api/* tree.
  //   - OPTIONS preflight bypasses so cross-origin clients can complete
  //     their handshake before they hit the limiter.
  //   - Token holders get 2x budget (see rate-limit.js); the multiplier
  //     is transparent here — we just call middleware().
  if (
    !local &&
    pathname.startsWith("/api/") &&
    pathname !== "/api/health" &&
    req.method !== "OPTIONS" &&
    req.method !== "HEAD"
  ) {
    const rl = rateLimitMiddleware(req, res);
    if (rl.blocked) {
      if (!res.headersSent) {
        res.writeHead(rl.status || 429, rl.headers || {});
        res.end(JSON.stringify(rl.body));
      }
      return;
    }
  }

  // Gate 5: read-only mode (v1.0.1)
  //   - Local request: always allowed (admin should never get locked out)
  //   - OPTIONS preflight: always allowed
  //   - Non-GET (POST/PUT/DELETE): 403
  //   - /api/settings: allowed (so the user can flip the switch back off)
  if (
    !local &&
    pathname.startsWith("/api/") &&
    pathname !== "/api/settings" &&
    req.method !== "GET" &&
    req.method !== "OPTIONS" &&
    req.method !== "HEAD" &&
    getReadOnly() &&
    rejectReadOnly(res, pathname)
  ) {
    return;
  }

  const cs = getClient(cid);
  const ctx = { cid, cs, pathname };

  // Try static files first (any path with a dot — handles /public/*, /lib/*, brand-logo.png, etc.)
  // If served, we're done.
  if (req.method === "GET" && pathname !== "/" && pathname.includes(".")) {
    if (serveStatic(pathname, res) !== false) return;
    // fall through to API routes (e.g. /api/foo.bar) — but those would have no dot, skip
  }

  for (const route of ROUTES) {
    if (route.method !== req.method) continue;
    // CodeQL js/regex-injection 是名字面伪报：以 pathname 为实参调用
    // route 的 match 谓词时，CodeQL 按 String.prototype.match(pattern)
    // 建模，把污染 pathname 当成了正则模式。实况是 ROUTES 全部 match
    // 实现均为静态谓词（=== / startsWith / includes / 唯一一条预编译
    // 正则字面量 .test(p)），pathname 只作被检主体、从不进模式位。
    // 经局部变量调用消除该名字面汇点，匹配语义不变。
    const matchesPath = route.match;
    if (!matchesPath(pathname)) continue;
    try {
      const handled = await route.handler(req, res, ctx, pathname);
      // If handler returned false (e.g. static returned false), continue trying other routes
      if (handled === false) continue;
      return;
    } catch (e) {
      console.error("[router] %s %s threw:", req.method, pathname, e);
      try {
        if (!res.headersSent) {
          res.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      } catch {}
      return;
    }
  }

  // No route matched
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}
