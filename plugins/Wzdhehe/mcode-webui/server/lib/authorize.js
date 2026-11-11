// webui/server/lib/authorize.js
// Per-request authorization helper (Lease B03, mcode-webui v2).
//
// Design (MATH-skeleton-webui-v2 §1.3 + BORROW-harness-v2 §3):
//   • `authorize(action, ctx, opts)` blocks on user confirmation; the
//     UI pops a modal listening for the `needs_authorization` SSE event.
//     The user accepts or declines; the server resolves the pending
//     promise via POST /api/auth/decision.
//
//   • Default timeout = 5 minutes. Timeout = reject (fail-closed; see
//     ANTI-PATTERNS-FIX-PLAN §AP6 + §AP10 rationale — silent fallback
//     to "approved" is the root cause of accidental destructive
//     actions).
//
//   • Audit trail (Lease B01 dependency): every approve / reject /
//     timeout writes one NDJSON event via the static import of
//     `server/lib/events.js` (fail-closed since the 2026-09-20 rigor
//     fix). The DECISION-OUTCOME audit write (auth.approve/reject/
//     timeout/cancelled) is loud-but-non-blocking: on write failure we
//     pushAlert + console.error and still resolve the user's decision,
//     because a click in the modal is irreversible — throwing away the
//     user's explicit choice to spite a broken disk would turn one
//     failure into two. The destructive action itself is separately
//     guarded by the route-level write-ahead intent events (see
//     routes/sessions.js etc.), which DO fail closed.
//
//   • Pure module: no fs / spawn / router side-effects on import. The
//     `handleAuthDecision` HTTP handler is exported for the router
//     (wiring is owned by Lease C03 / main reconciliation).
//
// Action whitelist:
//   session.delete          DELETE /api/sessions/:id (destructive)
//   sessions.cleanup-orphans POST /api/sessions/cleanup-orphans
//   session.cleanup-all     bulk delete (extension hook)
//   session.export          GET /api/sessions/:id/export (C06 — non-destructive
//                           but exposes conversation history; same gate class
//                           as session.delete)
//   session.search          GET /api/sessions/search (C05 — non-destructive
//                           but surfaces titles across workspaces the user
//                           is not currently in; same gate class as export)
//   token.reset             rotate the LAN auth token
//   slash.clear             /clear and /new on the chat stream
//   startup.cleanup         boot-time orphan sweep

import { randomUUID } from "node:crypto";
import { pushAuthRequest, pushAuthDecision } from "./state-bus.js";
import { pushAlert } from "./alerts.js";
import { append as _eventsAppend } from "./events.js";

// ---------- action whitelist ----------

export const AUTHORIZE_ACTIONS = Object.freeze([
  "session.delete",
  "sessions.cleanup-orphans",
  "session.cleanup-all",
  // C06: session export is non-destructive but reveals chat history.
  // Added here as the natural integration touchpoint between the C06
  // lease (which is the first consumer) and the B03 authorize gate.
  "session.export",
  // C05: cross-workspace session search is non-destructive but
  //   surfaces titles from workspaces the user is not currently in.
  //   Same gate class as session.export — added as the natural
  //   integration touchpoint between C05 (consumer) and B03.
  "session.search",
  "token.reset",
  "slash.clear",
  "startup.cleanup",
]);

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function _isValidAction(action) {
  return AUTHORIZE_ACTIONS.includes(action);
}

// ---------- pending request registry ----------

// requestId → { resolve, timer, action, ctx, requestedAt, expiresAt }
const _pending = new Map();

// ---------- audit (B01 events.js) ----------

// _tryWriteEvent — synchronous, loud-but-non-blocking audit write.
// events.js#append is fail-closed (throws) since the 2026-09-20 rigor
// fix; authorize deliberately does NOT propagate that throw:
//   - For decision-OUTCOME events (auth.approve / auth.reject /
//     auth.timeout / auth.cancelled) the user's click already
//     happened and is irreversible. Swallowing the DECISION would
//     deadlock the modal on a broken audit disk AND lose the user's
//     explicit choice; the destructive mutation downstream is guarded
//     by the route-level write-ahead intent events, which do fail
//     closed. So: record the miss on the anomaly channel (pushAlert)
//     + stderr, then continue.
//   - For auth.pending / auth.bypass the same loud-continue applies:
//     these are observability lines, not the enforcement line.
function _tryWriteEvent(evt) {
  try {
    // Normalize to the events.js#append(kind, fields) signature. The
    // old dynamic-import caller passed the whole object as `kind`,
    // which events.js stringified into `"[object Object]"` — four such
    // corrupted lines exist in real audit chains (2026-09-20 audit).
    // `data` → `payload` because append() only accepts the payload via
    // the explicit `payload` key when meta keys (target/cid/actor) are
    // present.
    _eventsAppend(evt.kind, {
      target: evt.target || "",
      cid: evt.cid || "",
      actor: evt.actor || "system",
      payload: evt.data && typeof evt.data === "object" ? evt.data : {},
    });
  } catch (e) {
    try {
      pushAlert({
        level: "error",
        msg: `auth audit write failed (kind=${evt && evt.kind}): ${e.message}`,
        src: "authorize",
      });
    } catch {}
    console.error(
      `[webui] authorize audit write failed (kind=${evt && evt.kind}): ${e.message}`,
    );
  }
}

// ---------- core API ----------

  // authorize(action, ctx, opts) → Promise<{approved, decidedBy, decidedAt}>
  //   action: one of AUTHORIZE_ACTIONS (throws on invalid)
  //   ctx:    { cid: string, [any extra context] } — cid is optional;
  //           empty cid = broadcast to all SSE clients
  //   opts:   { timeoutMs?: number, metadata?: object, bypass?: boolean }
  //           bypass=true skips the user gate (only for trusted internal
  //           callers — e.g. LAN token rotation triggered by C08 modal
  //           that already presented its own confirmation UI).
  //
  // NOTE (2026-09-20 rigor fix): there is deliberately NO test-mode
  //   auto-approve. The old branch inspected Node's runtime flag vector
  //   for --test / --experimental-test-module-mocks and approved every
  //   gated action without a user decision — which meant no test ever
  //   exercised the real decision path, and any future flag confusion
  //   in the production flag vector would silently disable the gate.
  //   Tests now drive the REAL path via test/_setup.js#withDecisions
  //   (in process) or SSE + POST /api/auth/decision (integration).
  //
  // Returns:
  //   { approved: true,  decidedBy: 'user',   decidedAt: ms }
  //   { approved: false, decidedBy: 'user',   decidedAt: ms }   (user declined)
  //   { approved: false, decidedBy: 'timeout',decidedAt: ms }   (default fail-closed)
export function authorize(action, ctx = {}, opts = {}) {
  if (!_isValidAction(action)) {
    return Promise.resolve({
      approved: false,
      decidedBy: "rejected",
      decidedAt: Date.now(),
      reason: `invalid action: ${action}`,
    });
  }
  if (opts.bypass === true) {
    // trusted internal caller — record audit but skip user gate
    _tryWriteEvent({
      kind: "auth.bypass",
      target: action,
      cid: (ctx && ctx.cid) || null,
      data: opts.metadata || null,
    });
    return Promise.resolve({
      approved: true,
      decidedBy: "bypass",
      decidedAt: Date.now(),
    });
  }
  const cid = (ctx && typeof ctx.cid === "string") ? ctx.cid : "";
  const requestId = randomUUID();
  const requestedAt = Date.now();
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const expiresAt = requestedAt + timeoutMs;
  const safeCtx = ctx && typeof ctx === "object" ? ctx : {};

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const entry = _pending.get(requestId);
      if (!entry) return;
      _pending.delete(requestId);
      const decidedAt = Date.now();
      _tryWriteEvent({
        kind: "auth.timeout",
        target: action,
        cid: cid || null,
        data: {
          requestId,
          requestedAt,
          expiresAt,
          metadata: opts.metadata || null,
        },
      });
      // Mirror the resolution over SSE so other tabs close the modal
      try {
        pushAuthDecision({ requestId, approved: false, decidedBy: "timeout" });
      } catch {}
      resolve({ approved: false, decidedBy: "timeout", decidedAt });
    }, timeoutMs);
    // Allow process to exit even if a request is pending (unref).
    if (typeof timer.unref === "function") timer.unref();

    _pending.set(requestId, {
      resolve,
      timer,
      action,
      ctx: safeCtx,
      requestedAt,
      expiresAt,
    });

    // Push the request to the target cid (or broadcast if cid is empty).
    try {
      pushAuthRequest({
        requestId,
        action,
        ctx: safeCtx,
        expiresAt,
      });
    } catch {}
    // Audit the pending request itself (best-effort).
    _tryWriteEvent({
      kind: "auth.pending",
      target: action,
      cid: cid || null,
      data: {
        requestId,
        requestedAt,
        expiresAt,
        timeoutMs,
        metadata: opts.metadata || null,
      },
    });
  });
}

// ---------- HTTP handler (wired by C03 / main reconciliation) ----------

// handleAuthDecision — POST /api/auth/decision
//   body: { requestId: string, approve: boolean }
//   responses:
//     200 { ok: true, approved, decidedBy }   (resolved)
//     400 { ok: false, error }              (bad request)
//     404 { ok: false, error: 'not found' }  (no such pending request)
//     410 { ok: false, error: 'already decided' } (idempotency guard)
export async function handleAuthDecision(req, res) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    body = {};
  }
  const requestId = body && typeof body.requestId === "string" ? body.requestId : "";
  const approve = !!(body && body.approve === true);
  if (!requestId) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: false, error: "requestId required" }));
  }
  const entry = _pending.get(requestId);
  if (!entry) {
    // Either already decided, expired, or never existed.
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: false, error: "no pending request with that id" }));
  }
  _pending.delete(requestId);
  if (entry.timer) clearTimeout(entry.timer);
  const decidedAt = Date.now();
  const decidedBy = "user";
  const cid = (entry.ctx && entry.ctx.cid) || null;
  _tryWriteEvent({
    kind: approve ? "auth.approve" : "auth.reject",
    target: entry.action,
    cid,
    data: {
      requestId,
      requestedAt: entry.requestedAt,
      decidedAt,
      durationMs: decidedAt - entry.requestedAt,
    },
  });
  try {
    pushAuthDecision({ requestId, approved: approve, decidedBy });
  } catch {}
  entry.resolve({ approved: approve, decidedBy, decidedAt });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ok: true, approved: approve, decidedBy, decidedAt }));
}

// ---------- test-only / diagnostics ----------

export function getPendingCount() {
  return _pending.size;
}

export function getPendingRequestIds() {
  return Array.from(_pending.keys());
}

export function _resetForTests() {
  // Resolve every pending request as "reset" so any awaiting test
  // does not hang; clear timers and the registry.
  for (const [id, entry] of _pending) {
    if (entry.timer) clearTimeout(entry.timer);
    try {
      entry.resolve({ approved: false, decidedBy: "reset", decidedAt: Date.now() });
    } catch {}
  }
  _pending.clear();
}

// Resolve a pending request without going through HTTP. Used by tests
// (and could be used by internal flows that already have a different
// confirmation path — e.g. C08 token modal).
export function _decideForTests(requestId, approve) {
  const entry = _pending.get(requestId);
  if (!entry) return false;
  _pending.delete(requestId);
  if (entry.timer) clearTimeout(entry.timer);
  const decidedAt = Date.now();
  _tryWriteEvent({
    kind: approve ? "auth.approve" : "auth.reject",
    target: entry.action,
    cid: (entry.ctx && entry.ctx.cid) || null,
    data: { requestId, decidedAt },
  });
  try {
    pushAuthDecision({ requestId, approved: approve, decidedBy: "user" });
  } catch {}
  entry.resolve({ approved: approve, decidedBy: "user", decidedAt });
  return true;
}

// Drop every pending request belonging to a cid (e.g. on tab close).
// Each request resolves as `decidedBy: 'cancelled'`, decidedAt set;
// kind: 'auth.cancelled' is appended to the audit trail.
export function clearPendingForCid(cid, reason = "cid closed") {
  if (!cid) return 0;
  let n = 0;
  for (const [id, entry] of _pending) {
    if (!entry.ctx || entry.ctx.cid !== cid) continue;
    _pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    const decidedAt = Date.now();
    _tryWriteEvent({
      kind: "auth.cancelled",
      target: entry.action,
      cid,
      data: { requestId: id, decidedAt, reason },
    });
    try {
      entry.resolve({ approved: false, decidedBy: "cancelled", decidedAt });
    } catch {}
    n++;
  }
  return n;
}