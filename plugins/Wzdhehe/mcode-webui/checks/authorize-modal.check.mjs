// webui/checks/authorize-modal.check.mjs
// Mocked check for the v2 per-request authorization FRONTEND wiring.
//
// Why this test exists (2026-09-20 webui-manual-audit): the server half
// of the authorize gate was complete — server/lib/authorize.js blocks
// gated actions on a 5-minute fail-closed promise, state-bus.js pushes
// `needs_authorization` / `authorization_decided` SSE frames, and
// POST /api/auth/decision is routed — but public/ had ZERO wiring. Every
// gated action (delete / export / cross-workspace search / /clear / /new /
// token reset) hung silently for 5 minutes and then declined. A
// regression here means either user deadlock (modal never opens) or
// accidental destruction (an approve firing without a click).
//
// Coverage:
//   • state.js SSE listeners: needs_authorization enqueues (dedup on
//     reconnect replay; malformed frames ignored); authorization_decided
//     removes exactly that requestId (unknown ids no-op).
//   • submitAuthDecision POST shape: {requestId, approve} with strict
//     boolean approve for both true and false; 200/404 clear the queue,
//     500 keeps it for retry.
//   • events.js attachModalEvents wiring: Approve click disables BOTH
//     buttons while the POST is in flight and posts the head request's
//     id; a second click in flight is ignored; network failure surfaces
//     inside the modal and re-enables.
//   • render.js helpers: formatAuthCountdown math; authActionLabel
//     whitelist mapping + unknown fallback; ctx list DOM construction.
//   • Static source guards (test/render-static.test.js precedent):
//     modal construction is DOM-only (CodeQL js/xss-through-dom), the
//     countdown tick is visual-only (cannot decide anything), and the
//     i18n dictionaries carry every auth_* key in BOTH zh and en.
//
// How the real modules load under node:test: public/app/state.js pulls
// the whole render/events/util/i18n cluster, which touches DOM globals
// at module-eval time (window / localStorage / document / EventSource).
// We install minimal fakes BEFORE the dynamic import — the same globals
// the browser provides for free. No t.mock.module needed: the modules
// under test are the REAL frontend files, imported unmocked.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, "..");
const appPath = (rel) => pathToFileURL(resolve(PLUGIN_ROOT, "public", "app", rel)).href;

// ---------- minimal DOM / global fakes ----------

function makeEl(id) {
  return {
    id,
    children: [],
    handlers: {},
    style: {},
    dataset: {},
    textContent: "",
    hidden: false,
    disabled: false,
    className: "",
    appendChild(c) { this.children.push(c); return c },
    addEventListener(ev, fn) {
      if (!this.handlers[ev]) this.handlers[ev] = [];
      this.handlers[ev].push(fn);
    },
    setAttribute(k, v) { this.dataset[k] = String(v) },
    querySelector() { return null },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

// Only the auth-modal surface is stubbed; every other getElementById
// (ask-modal, plan-modal, …) returns null — the real modules' module-eval
// and attachModalEvents null-guards tolerate that (v0.5.bx-27 pattern).
const AUTH_MODAL_IDS = [
  "auth-modal", "auth-modal-position", "auth-modal-action", "auth-modal-ctx",
  "auth-modal-countdown", "auth-modal-error", "auth-modal-approve",
  "auth-modal-deny",
];
const _els = {};
const _fetchCalls = [];
let _fetchImpl = null; // per-test override; default 200 {ok:true}

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  close() { this.closed = true }
  fire(name, data) {
    for (const fn of this.listeners.get(name) || []) fn({ data });
  }
}

function installGlobals() {
  globalThis.window = {
    location: { search: "", pathname: "/", hash: "" },
    history: { replaceState() {} },
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
  };
  globalThis.localStorage = (() => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  })();
  globalThis.EventSource = FakeEventSource;
  globalThis.document = {
    getElementById: (id) => _els[id] || null,
    createElement: (tag) => makeEl(tag),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  // Node exposes `navigator` as a getter-only global — a plain
  // assignment throws (which is exactly what the first run of this
  // check hit), so define it as a configurable own property.
  try {
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: true }, configurable: true, writable: true,
    });
  } catch {}
  globalThis.fetch = async (url, init) => {
    _fetchCalls.push({ url: String(url), init });
    if (_fetchImpl) return _fetchImpl(url, init);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
}

// ---------- SUT handles (filled in before()) ----------

let stateMod, renderMod, eventsMod, es;

before(async (t) => {
  installGlobals();
  for (const id of AUTH_MODAL_IDS) _els[id] = makeEl(id);
  // Real frontend modules, imported AFTER the globals exist.
  stateMod = await import(appPath("state.js"));
  renderMod = await import(appPath("render.js"));
  eventsMod = await import(appPath("events.js"));
  // Wire the real attachModalEvents once (its $()/on() null-guards skip
  // every missing element; our auth-modal stubs capture the handlers).
  eventsMod.attachModalEvents();
  // connect() schedules a 2s /api/refresh setTimeout + a 60s interval
  // with REAL timers — under node --test those handles would outlive
  // the assertions (and the interval pins the process open). Swap in
  // mock timers just for the connect() call so the scheduled refreshes
  // simply never fire, then restore the real timers. (Node 26's
  // MockTimers surface has no disable() — reset() is the restore.)
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    stateMod.connect();
  } finally {
    t.mock.timers.reset();
  }
  es = stateMod.es;
  assert.ok(es instanceof FakeEventSource, "connect() must use our fake EventSource");
});

beforeEach(() => {
  _fetchCalls.length = 0;
  _fetchImpl = null;
  stateMod.getPendingAuthRequests().splice(0);
  renderMod.AUTH_MODAL_STATE.decidingRequestId = null;
  // Stops any live countdown interval and hides the modal (render.js
  // restarts both on the next renderAuthModal).
  renderMod.closeAuthModal();
  for (const id of AUTH_MODAL_IDS) {
    const el = _els[id];
    el.textContent = "";
    el.disabled = false;
    el.hidden = false;
    el.style = {};
    el.children.length = 0;
    // NOTE: handlers are NOT reset — attachModalEvents binds once in
    // before() and the stubs must keep those bindings.
  }
});

after(() => {
  // Belt-and-braces: never leave a countdown interval running. Guarded
  // so a failed before() (modules never imported) does not mask the
  // original error with a second one.
  if (renderMod) renderMod.closeAuthModal();
});

// ---------- helpers ----------

function pushAuthFrame({ requestId, action = "slash.clear", ctx = {}, expiresAt = Date.now() + 300_000 }) {
  es.fire("needs_authorization", JSON.stringify({ requestId, action, ctx, expiresAt }));
}
function fireDecided(requestId, approved = true, decidedBy = "user") {
  es.fire("authorization_decided", JSON.stringify({ requestId, approved, decidedBy }));
}

// ============================================================
// state.js SSE listeners — queue add/remove
// ============================================================

describe("state.js SSE listeners — pending queue", () => {
  test("needs_authorization enqueues the parsed frame and opens the modal", () => {
    pushAuthFrame({
      requestId: "rid-1",
      action: "session.delete",
      ctx: { cid: "c1", targetSessionId: "mvs_abc", matchKind: "mcodeSessionId", isOrphan: false, chatLen: 42 },
    });
    const q = stateMod.getPendingAuthRequests();
    assert.equal(q.length, 1);
    assert.equal(q[0].requestId, "rid-1");
    assert.equal(q[0].action, "session.delete");
    assert.equal(q[0].ctx.targetSessionId, "mvs_abc");
    assert.ok(q[0].expiresAt > Date.now(), "expiresAt must survive parsing");
    // modal opened on the head request
    assert.equal(_els["auth-modal"].style.display, "flex");
    assert.equal(_els["auth-modal-action"].textContent, "Delete session");
    assert.match(_els["auth-modal-countdown"].textContent, /^\d{2}:\d{2}$/);
    // single pending request → no position indicator
    assert.equal(_els["auth-modal-position"].textContent, "");
  });

  test("duplicate frame (SSE reconnect replay) does not double-queue", () => {
    pushAuthFrame({ requestId: "rid-dup", action: "token.reset" });
    pushAuthFrame({ requestId: "rid-dup", action: "token.reset" });
    assert.equal(stateMod.getPendingAuthRequests().length, 1);
  });

  test("multiple pending: queue order preserved, position indicator 1/2", () => {
    pushAuthFrame({ requestId: "rid-a", action: "session.delete" });
    pushAuthFrame({ requestId: "rid-b", action: "token.reset" });
    const q = stateMod.getPendingAuthRequests();
    assert.equal(q.length, 2);
    assert.equal(q[0].requestId, "rid-a", "arrival order — first in, first displayed");
    // head still rid-a; indicator shows 1/2 (default en dictionary)
    assert.equal(_els["auth-modal-action"].textContent, "Delete session");
    assert.equal(_els["auth-modal-position"].textContent, "pending 1/2");
  });

  test("authorization_decided removes exactly that request and closes the empty modal", () => {
    pushAuthFrame({ requestId: "rid-close" });
    fireDecided("rid-close");
    assert.equal(stateMod.getPendingAuthRequests().length, 0);
    assert.equal(_els["auth-modal"].style.display, "none");
    assert.equal(renderMod.AUTH_MODAL_STATE.countdownTimer, null, "countdown interval must be cleaned up on close");
  });

  test("authorization_decided (timeout resolution) advances to the next queued request", () => {
    pushAuthFrame({ requestId: "rid-t1", action: "session.delete" });
    pushAuthFrame({ requestId: "rid-t2", action: "token.reset" });
    fireDecided("rid-t1", false, "timeout");
    const q = stateMod.getPendingAuthRequests();
    assert.equal(q.length, 1);
    assert.equal(q[0].requestId, "rid-t2");
    assert.equal(_els["auth-modal"].style.display, "flex", "modal stays open for the next request");
    assert.equal(_els["auth-modal-action"].textContent, "Reset access token");
    assert.equal(_els["auth-modal-position"].textContent, "");
  });

  test("authorization_decided for an unknown id is a no-op", () => {
    pushAuthFrame({ requestId: "rid-keep" });
    fireDecided("no-such-id");
    assert.equal(stateMod.getPendingAuthRequests().length, 1);
    assert.equal(_els["auth-modal"].style.display, "flex");
  });

  test("malformed frames are ignored without throwing", () => {
    pushAuthFrame({ requestId: "rid-m" });
    es.fire("needs_authorization", "not json at all");
    es.fire("authorization_decided", "");
    es.fire("needs_authorization", JSON.stringify({ noRequestId: true }));
    const q = stateMod.getPendingAuthRequests();
    assert.equal(q.length, 1);
    assert.equal(q[0].requestId, "rid-m");
  });
});

// ============================================================
// submitAuthDecision — POST /api/auth/decision body shape
// ============================================================

describe("submitAuthDecision — decision POST contract", () => {
  test("approve:true posts strict-boolean JSON and clears the queue on 200", async () => {
    pushAuthFrame({ requestId: "rid-ok" });
    const r = await stateMod.submitAuthDecision("rid-ok", true);
    assert.equal(r.ok, true);
    assert.equal(_fetchCalls.length, 1);
    const call = _fetchCalls[0];
    assert.ok(call.url.startsWith("/api/auth/decision"), `unexpected url ${call.url}`);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers["Content-Type"], "application/json");
    const body = JSON.parse(call.init.body);
    assert.deepEqual(Object.keys(body).sort(), ["approve", "requestId"]);
    assert.equal(body.requestId, "rid-ok");
    assert.equal(body.approve, true);
    assert.strictEqual(body.approve, true, "approve must be the literal boolean true");
    assert.equal(stateMod.getPendingAuthRequests().length, 0, "200 must remove the request locally");
  });

  test("approve:false posts approve===false — a deny is a real decision, not an absent one", async () => {
    pushAuthFrame({ requestId: "rid-no" });
    await stateMod.submitAuthDecision("rid-no", false);
    assert.equal(_fetchCalls.length, 1);
    const body = JSON.parse(_fetchCalls[0].init.body);
    assert.equal(body.requestId, "rid-no");
    assert.strictEqual(body.approve, false);
    assert.equal(stateMod.getPendingAuthRequests().length, 0);
  });

  test("404 (already decided elsewhere / server timeout evicted) also clears the queue", async () => {
    _fetchImpl = () => ({
      ok: false, status: 404,
      json: async () => ({ ok: false, error: "no pending request with that id" }),
    });
    pushAuthFrame({ requestId: "rid-404" });
    const r = await stateMod.submitAuthDecision("rid-404", true);
    assert.equal(r.status, 404);
    assert.equal(stateMod.getPendingAuthRequests().length, 0, "the request is finished — modal must not hang on a lost SSE frame");
  });

  test("500 keeps the request queued so the user can retry", async () => {
    _fetchImpl = () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: "boom" }) });
    pushAuthFrame({ requestId: "rid-500" });
    const r = await stateMod.submitAuthDecision("rid-500", true);
    assert.equal(r.status, 500);
    assert.equal(stateMod.getPendingAuthRequests().length, 1);
  });

  test("network error rejects (caller surfaces it) and keeps the request", async () => {
    _fetchImpl = async () => { throw new Error("network down") };
    pushAuthFrame({ requestId: "rid-net0" });
    await assert.rejects(() => stateMod.submitAuthDecision("rid-net0", true), /network down/);
    assert.equal(stateMod.getPendingAuthRequests().length, 1);
  });
});

// ============================================================
// events.js attachModalEvents — Approve/Deny wiring
// ============================================================

describe("events.js attachModalEvents — Approve/Deny wiring", () => {
  test("Approve click posts the head request's decision and disables both buttons in flight", async () => {
    pushAuthFrame({ requestId: "rid-click" });
    const approve = _els["auth-modal-approve"];
    const deny = _els["auth-modal-deny"];
    let release;
    _fetchImpl = () => new Promise((res) => {
      release = () => res({ ok: true, status: 200, json: async () => ({ ok: true }) });
    });
    const p = approve.handlers.click[0]();
    // decideAuth ran synchronously up to the awaited fetch: buttons are
    // already disabled and exactly one POST is in flight.
    assert.equal(approve.disabled, true);
    assert.equal(deny.disabled, true);
    assert.equal(_fetchCalls.length, 1);
    const body = JSON.parse(_fetchCalls[0].init.body);
    assert.equal(body.requestId, "rid-click");
    assert.equal(body.approve, true);
    release();
    await p;
    assert.equal(stateMod.getPendingAuthRequests().length, 0);
  });

  test("a second click while a decision is in flight is ignored (one decision per request)", async () => {
    pushAuthFrame({ requestId: "rid-2x" });
    const approve = _els["auth-modal-approve"];
    const deny = _els["auth-modal-deny"];
    let release;
    _fetchImpl = () => new Promise((res) => {
      release = () => res({ ok: true, status: 200, json: async () => ({ ok: true }) });
    });
    const p1 = approve.handlers.click[0]();
    const p2 = deny.handlers.click[0](); // must be a no-op — POST already in flight
    release();
    await p1;
    await p2;
    assert.equal(_fetchCalls.length, 1, "exactly one decision POST per request");
  });

  test("after a resolved request, the next queued request can still be decided (no stale decidingRequestId)", async () => {
    pushAuthFrame({ requestId: "rid-b1", action: "session.delete" });
    pushAuthFrame({ requestId: "rid-b2", action: "token.reset" });
    const approve = _els["auth-modal-approve"];
    // decide rid-b1 successfully
    await approve.handlers.click[0]();
    assert.equal(_fetchCalls.length, 1);
    assert.equal(JSON.parse(_fetchCalls[0].init.body).requestId, "rid-b1");
    // head is now rid-b2 — the buttons must be usable again (a stale
    // decidingRequestId from rid-b1 must not block rid-b2's decision)
    assert.equal(approve.disabled, false);
    await approve.handlers.click[0]();
    assert.equal(_fetchCalls.length, 2);
    assert.equal(JSON.parse(_fetchCalls[1].init.body).requestId, "rid-b2");
    assert.equal(stateMod.getPendingAuthRequests().length, 0);
  });

  test("Deny click posts approve:false", async () => {
    pushAuthFrame({ requestId: "rid-deny" });
    const deny = _els["auth-modal-deny"];
    await deny.handlers.click[0]();
    assert.equal(_fetchCalls.length, 1);
    const body = JSON.parse(_fetchCalls[0].init.body);
    assert.equal(body.requestId, "rid-deny");
    assert.strictEqual(body.approve, false);
  });

  test("network failure shows the error inside the modal and re-enables both buttons", async () => {
    pushAuthFrame({ requestId: "rid-fail" });
    const approve = _els["auth-modal-approve"];
    const deny = _els["auth-modal-deny"];
    const err = _els["auth-modal-error"];
    _fetchImpl = async () => { throw new Error("network down") };
    await approve.handlers.click[0]();
    assert.equal(approve.disabled, false, "failed POST must re-enable for retry");
    assert.equal(deny.disabled, false);
    assert.equal(err.hidden, false, "error must be visible inside the modal");
    assert.match(err.textContent, /network down/);
    assert.equal(stateMod.getPendingAuthRequests().length, 1, "failed POST keeps the request queued");
  });

  test("re-render while a decision is in flight does NOT re-enable the buttons", async () => {
    pushAuthFrame({ requestId: "rid-rr" });
    pushAuthFrame({ requestId: "rid-rr2" });
    const approve = _els["auth-modal-approve"];
    let release;
    _fetchImpl = () => new Promise((res) => {
      release = () => res({ ok: true, status: 200, json: async () => ({ ok: true }) });
    });
    const p = approve.handlers.click[0]();
    // some unrelated state push re-renders the modal mid-flight
    renderMod.renderAuthModal();
    assert.equal(approve.disabled, true, "decidingRequestId must survive re-renders");
    release();
    await p;
  });
});

// ============================================================
// render.js helpers
// ============================================================

describe("render.js helpers", () => {
  test("formatAuthCountdown — mm:ss, ceil, clamped at zero", () => {
    assert.equal(renderMod.formatAuthCountdown(0), "00:00");
    assert.equal(renderMod.formatAuthCountdown(-5000), "00:00");
    assert.equal(renderMod.formatAuthCountdown(1), "00:01");
    assert.equal(renderMod.formatAuthCountdown(2999), "00:03"); // ceil, not floor
    assert.equal(renderMod.formatAuthCountdown(65000), "01:05");
    assert.equal(renderMod.formatAuthCountdown(300_000), "05:00");
    assert.equal(renderMod.formatAuthCountdown("junk"), "00:00");
    assert.equal(renderMod.formatAuthCountdown(undefined), "00:00");
  });

  test("authActionLabel maps all 8 whitelist actions; unknown falls back to raw", () => {
    const whitelist = [
      "session.delete", "sessions.cleanup-orphans", "session.cleanup-all",
      "session.export", "session.search", "token.reset", "slash.clear",
      "startup.cleanup",
    ];
    for (const a of whitelist) {
      const s = renderMod.authActionLabel(a);
      assert.ok(s && s !== a, `action ${a} should map to a human label, got ${JSON.stringify(s)}`);
    }
    assert.equal(renderMod.authActionLabel("totally.unknown"), "totally.unknown");
    assert.equal(renderMod.authActionLabel(""), "");
  });

  test("ctx list: known fields labeled, cid skipped, unknown fields generic — DOM construction", () => {
    pushAuthFrame({
      requestId: "rid-ctx",
      action: "session.delete",
      ctx: { cid: "c1", targetSessionId: "mvs_abc", isOrphan: true, chatLen: 7, weirdField: "<img src=x onerror=alert(1)>" },
    });
    const list = _els["auth-modal-ctx"].children[0];
    assert.ok(list, "ctx list must be appended to #auth-modal-ctx");
    assert.equal(list.className, "auth-modal-ctx");
    const rows = list.children;
    assert.equal(rows.length, 4, "cid must be skipped as a routing field");
    const kv = rows.map((r) => [r.children[0].textContent, r.children[1].textContent]);
    assert.deepEqual(kv, [
      ["target session", "mvs_abc"],
      ["orphan", "true"],
      ["chat lines", "7"],
      ["weirdField", "<img src=x onerror=alert(1)>"], // generic fallback, raw key + textContent value
    ]);
  });

  test("ctx list: object/array values are JSON-stringified (orphanIds)", () => {
    pushAuthFrame({
      requestId: "rid-arr",
      action: "sessions.cleanup-orphans",
      ctx: { orphanCount: 2, orphanIds: ["a", "b"] },
    });
    const list = _els["auth-modal-ctx"].children[0];
    const kv = list.children.map((r) => [r.children[0].textContent, r.children[1].textContent]);
    assert.deepEqual(kv, [
      ["orphan count", "2"],
      ["orphan ids", '["a","b"]'],
    ]);
  });
});

// ============================================================
// Static source guards (test/render-static.test.js precedent)
// ============================================================

describe("static source guards", () => {
  const RENDER_SRC = readFileSync(resolve(PLUGIN_ROOT, "public", "app", "render.js"), "utf8");
  const EVENTS_SRC = readFileSync(resolve(PLUGIN_ROOT, "public", "app", "events.js"), "utf8");
  const INDEX_SRC = readFileSync(resolve(PLUGIN_ROOT, "public", "index.html"), "utf8");
  const I18N_SRC = readFileSync(resolve(PLUGIN_ROOT, "public", "app", "i18n.js"), "utf8");

  function slice(src, startMarker, endMarker) {
    const s = src.indexOf(startMarker);
    assert.ok(s !== -1, `start marker not found: ${startMarker}`);
    const e = src.indexOf(endMarker, s);
    assert.ok(e !== -1, `end marker not found after start: ${endMarker}`);
    return src.slice(s, e + endMarker.length);
  }

  test("authorize-modal section builds DOM only — zero innerHTML (CodeQL js/xss-through-dom)", () => {
    const block = slice(
      RENDER_SRC,
      "// v2 (2026-09-20 webui-manual-audit): authorize modal — begin auth-modal",
      "// v2 (2026-09-20 webui-manual-audit): authorize modal — end auth-modal",
    );
    assert.equal(
      /\.innerHTML\s*=/.test(block), false,
      "authorize modal must not assign innerHTML — requestId/action/ctx are untrusted SSE wire data",
    );
    assert.match(block, /createElement\(\s*['"]div['"]\s*\)/);
    assert.match(block, /createElement\(\s*['"]span['"]\s*\)/);
    assert.match(block, /\.textContent\s*=/);
  });

  test("countdown tick is visual-only — it cannot decide anything", () => {
    // _startAuthCountdown sits between _stopAuthCountdown and
    // buildAuthCtxList in render.js (declaration order), so slice to
    // the next function to capture the whole ticking block.
    const block = slice(RENDER_SRC, "function _startAuthCountdown(", "function buildAuthCtxList(");
    assert.ok(!block.includes("submitAuthDecision"), "countdown must never post a decision");
    assert.ok(!block.includes("fetch("), "countdown must never fetch");
    assert.ok(!/approve\s*[:=]\s*true/.test(block), "countdown must never approve");
  });

  test("events.js wiring has no timer-driven decision (never auto-approves)", () => {
    const block = slice(
      EVENTS_SRC,
      "v2 (2026-09-20 webui-manual-audit): authorize modal Approve/Deny",
      "if (authApproveBtn) authApproveBtn.addEventListener",
    );
    assert.ok(!/setInterval|setTimeout/.test(block), "decisions may only come from a click, never a timer");
  });

  test("index.html carries the #auth-modal mount with Approve/Deny and NO dismiss affordance", () => {
    const block = slice(
      INDEX_SRC,
      '<!-- v2 (2026-09-20 webui-manual-audit): per-request authorization modal',
      '<!-- v0.5.ab: MD 渲染',
    );
    assert.match(block, /id="auth-modal"/);
    assert.match(block, /id="auth-modal-approve"/);
    assert.match(block, /id="auth-modal-deny"/);
    assert.ok(!block.includes("auth-modal-close"), "no close button — a dismiss would strand the request until timeout");
    // and the wiring never binds the backdrop to a dismiss
    assert.ok(!EVENTS_SRC.includes("auth-modal-backdrop"), "backdrop must not be a dismiss path");
  });

  test("i18n completeness — every auth_* key exists in BOTH zh and en dictionaries", () => {
    const keys = [
      "auth_title", "auth_queue_pos", "auth_expires_in", "auth_approve", "auth_deny",
      "auth_decision_failed",
      "auth_action_session_delete", "auth_action_sessions_cleanup_orphans",
      "auth_action_session_cleanup_all", "auth_action_session_export",
      "auth_action_session_search", "auth_action_token_reset",
      "auth_action_slash_clear", "auth_action_startup_cleanup",
      "auth_ctx_targetSessionId", "auth_ctx_matchKind", "auth_ctx_isMcodeSid",
      "auth_ctx_isOrphan", "auth_ctx_chatLen", "auth_ctx_q", "auth_ctx_workspace",
      "auth_ctx_limit", "auth_ctx_format", "auth_ctx_download",
      "auth_ctx_orphanCount", "auth_ctx_orphanIds", "auth_ctx_cmd",
      "auth_ctx_sessionId", "auth_ctx_mcodeSessionId", "auth_ctx_source",
    ];
    for (const k of keys) {
      const n = (I18N_SRC.match(new RegExp(`\\b${k}\\s*:`, "g")) || []).length;
      assert.ok(
        n >= 2,
        `i18n key ${k} must be defined in both the zh and the en dictionary (found ${n})`,
      );
    }
  });
});
