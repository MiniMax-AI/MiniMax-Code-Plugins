// webui/server/router.js
// Central HTTP request dispatcher.
//
// Order of gates (top-to-bottom):
//   1. CORS headers (always)
//   2. LAN reject (non-local + LAN off)
//   3. Token auth (non-local + token enabled + token set)
//   4. Read-only gate (non-local + readOnly + non-GET/OPTIONS)
//   5. Route dispatch
//
// Local requests (loopback + this host's LAN_IP) bypass (2)(3)(4).
// `/api/settings` is exempted from (2) so users can flip the LAN switch
// back on from a remote device.

import { isLocalRequest } from "./lib/lan.js";
import {
  getLanBroadcast,
  getReadOnly,
  rejectLan,
} from "./lib/settings.js";
import { getClient, getCidFromReq } from "./lib/state-bus.js";
import { serveStatic, serveIndex } from "./lib/static.js";
import { isRequestAuthorized, writeAuthRequired } from "./lib/auth.js";

import * as healthRoute from "./routes/health.js";
import * as stateRoute from "./routes/state.js";
import * as sessionsRoute from "./routes/sessions.js";
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

// v1.0.1 round 8 (CSRF / bootstrap-token-disclosure fix):
//   CORS is no longer `Access-Control-Allow-Origin: *`. That blanket
//   wildcard lets any cross-origin page (e.g. https://evil.example)
//   read responses from this server via fetch() — which was the leak
//   vector for the bootstrap token (hetaoBackend report 2026-09-01).
//
//   New behavior:
//     - If the request has no Origin header (server-to-server callers,
//       curl, etc.): no CORS response headers are set (they're not
//       needed — browsers aren't involved).
//     - If Origin matches `http(s)://<Host>` (same-origin browser
//       request): echo Origin + Vary (browsers don't enforce CORS for
//       same-origin, but echoing lets the SPA's fetch-with-credentials
//       pattern keep working if it's ever added).
//     - If Origin is in the env allowlist `MCODE_WEBUI_ALLOWED_ORIGINS`
//       (comma-separated, e.g. "https://app.example.com,https://staging.example.com"):
//       echo Origin + Vary (allow that origin to read responses).
//     - Otherwise: omit CORS response headers entirely. Browsers will
//       block the cross-origin reader from reading the response body
//       (the request still reaches the server, but the response is
//       unreadable to the cross-origin page).
//
//   This is a deliberate trade-off: the convenience of `*` is replaced
//   by an explicit allowlist (env var) + same-origin default. The CSRF
//   PoC at /Users/moc/workspaces/Mcode-webui-sync/poc-csrf.mjs and the
//   test/csrf-token-disclosure.test.js integration test both verify
//   that cross-origin reads from https://evil.example no longer succeed.
function setCorsHeaders(req, res) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return; // server-to-server / curl — CORS not relevant
  const host = (req.headers && req.headers.host) || "";
  const sameOrigin = origin === `http://${host}` || origin === `https://${host}`;
  if (sameOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return;
  }
  const allowList = (process.env.MCODE_WEBUI_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowList.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  // else: cross-origin and not allowlisted — omit CORS headers, browser blocks.
}

export async function handleRequest(req, res) {
  // Gate 1: CORS (per-origin, see setCorsHeaders above).
  setCorsHeaders(req, res);

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

  // Gate 4: read-only mode (v1.0.1)
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
    if (!route.match(pathname)) continue;
    try {
      const handled = await route.handler(req, res, ctx, pathname);
      // If handler returned false (e.g. static returned false), continue trying other routes
      if (handled === false) continue;
      return;
    } catch (e) {
      console.error(`[router] ${req.method} ${pathname} threw:`, e);
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
