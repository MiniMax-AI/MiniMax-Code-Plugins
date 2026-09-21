// webui/test/lib-authorize.test.js → webui/checks/lib-authorize.check.mjs
// Unit tests for server/lib/authorize.js — per-request authorization helper.
//
// [2026-09-20 webui-rigor-fix M1] Migrated with the 22-suite batch:
// this file mocks state-bus.js via t.mock.module, which needs
// --experimental-test-module-mocks — the flagless marketplace root
// gate (node --test at the repo root) executed it under test/ and
// TypeErrored. It was discovered as a 23rd flag-dependent file during
// M1 verification (the batch checklist enumerated 22); the move is
// purely mechanical — zero test-logic change.
//
// Why this test exists: authorize() is the core safety gate for
// destructive operations (AP6 + AP10 root cause fix). A bug here means
// either:
//   • accidental destruction (approve fires when it shouldn't), OR
//   • user deadlock (deny fires when it shouldn't, modal never
//     resolves, request hangs).
// Both classes are unrecoverable from the UI without server restart.
//
// Test strategy: node:test + direct dynamic import. No _setup.js
// because authorize.js is a self-contained module that doesn't reach
// into settings / sessions / db. The only dep is state-bus.js, and
// state-bus.js needs its own mock to avoid a real mcode spawn.
//
// We mock state-bus.js so pushAuthRequest / pushAuthDecision push
// into a captured `_sseFrames` array, letting tests assert what was
// emitted to the client.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, "..", "server");
const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href;

// ----- state-bus mock state (read by the registered module mock) -----
let _sseFrames = [];
let _subscribers = new Map(); // cid -> Set<fakeRes>

function _installStateBusMock(t) {
  t.mock.module(absPath("lib/state-bus.js"), {
    namedExports: {
      // chokepoint exports that authorize.js does NOT need but
      // _setup.js-style modules might pull transitively in future
      // patches — keep names so any accidental dep resolves.
      getClient: () => ({}),
      getCidFromReq: () => "",
      pushStateFor: () => {},
      pushOnlineCount: () => {},
      clients: new Map(),
      sseByCid: _subscribers,
      activeChildByCid: new Map(),
      SSE_HEADERS: {},
      mcodeSessionsSnapshotFields: () => ({
        mcodeSessions: [],
        mcodeSessionsPending: false,
      }),
      setActiveChild: () => {},
      getActiveChild: () => null,
      clearActiveChild: () => {},
      getCidsByMcodeSession: () => [],
      getSseClient: (cid) => _subscribers.get(cid) || null,
      setSseClient: (cid, res) => {
        if (!_subscribers.has(cid)) _subscribers.set(cid, new Set());
        _subscribers.get(cid).add(res);
      },
      endSseClient: (cid, res) => {
        const set = _subscribers.get(cid);
        if (set) {
          set.delete(res);
          if (set.size === 0) _subscribers.delete(cid);
        }
      },
      broadcastTokenRotated: () => {},
      // ---- the B03 helpers under test ----
      pushAuthRequest: ({ requestId, action, ctx, expiresAt }) => {
        _sseFrames.push({
          event: "needs_authorization",
          requestId,
          action,
          ctx,
          expiresAt,
        });
      },
      pushAuthDecision: ({ requestId, approved, decidedBy }) => {
        _sseFrames.push({
          event: "authorization_decided",
          requestId,
          approved,
          decidedBy,
        });
      },
    },
  });
}

// ----- read body helper (mirrors sessions.js pattern) -----
function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}
function fakeRes() {
  return {
    _status: null,
    _headers: null,
    _body: null,
    writeHead(s, h) {
      this._status = s;
      if (h) this._headers = h;
    },
    end(b) {
      this._body = b;
    },
  };
}

let authorize, handleAuthDecision, AUTHORIZE_ACTIONS, DEFAULT_TIMEOUT_MS,
  getPendingCount, getPendingRequestIds, _resetForTests, _decideForTests,
  clearPendingForCid;

before(async (t) => {
  _installStateBusMock(t);
  const mod = await import(absPath("lib/authorize.js"));
  authorize = mod.authorize;
  handleAuthDecision = mod.handleAuthDecision;
  AUTHORIZE_ACTIONS = mod.AUTHORIZE_ACTIONS;
  DEFAULT_TIMEOUT_MS = mod.DEFAULT_TIMEOUT_MS;
  getPendingCount = mod.getPendingCount;
  getPendingRequestIds = mod.getPendingRequestIds;
  _resetForTests = mod._resetForTests;
  _decideForTests = mod._decideForTests;
  clearPendingForCid = mod.clearPendingForCid;
});

beforeEach(() => {
  _sseFrames = [];
  _subscribers = new Map();
  _resetForTests();
});

// ============================================================
// Action whitelist
// ============================================================
describe("AUTHORIZE_ACTIONS whitelist", () => {
  test("contains all six documented actions", () => {
    assert.ok(AUTHORIZE_ACTIONS.includes("session.delete"));
    assert.ok(AUTHORIZE_ACTIONS.includes("sessions.cleanup-orphans"));
    assert.ok(AUTHORIZE_ACTIONS.includes("session.cleanup-all"));
    assert.ok(AUTHORIZE_ACTIONS.includes("token.reset"));
    assert.ok(AUTHORIZE_ACTIONS.includes("slash.clear"));
    assert.ok(AUTHORIZE_ACTIONS.includes("startup.cleanup"));
  });

  test("DEFAULT_TIMEOUT_MS is 5 minutes (300_000 ms)", () => {
    assert.equal(DEFAULT_TIMEOUT_MS, 5 * 60 * 1000);
  });
});

// ============================================================
// authorize() — happy paths
// ============================================================
describe("authorize — happy paths", () => {
  test("approve resolves with approved:true, decidedBy:'user'", async () => {
    const p = authorize("slash.clear", { cid: "tab-1" }, {});
    assert.equal(getPendingCount(), 1);
    const [requestId] = getPendingRequestIds();
    assert.ok(requestId);
    // SSE event was emitted on push
    assert.equal(_sseFrames.length, 1);
    assert.equal(_sseFrames[0].event, "needs_authorization");
    assert.equal(_sseFrames[0].action, "slash.clear");
    assert.equal(_sseFrames[0].ctx.cid, "tab-1");
    assert.equal(_sseFrames[0].requestId, requestId);
    assert.ok(_sseFrames[0].expiresAt > Date.now());
    // Resolve via the test helper
    const ok = _decideForTests(requestId, true);
    assert.equal(ok, true);
    const r = await p;
    assert.deepEqual(r, {
      approved: true,
      decidedBy: "user",
      decidedAt: r.decidedAt,
    });
    assert.ok(typeof r.decidedAt === "number");
    assert.equal(getPendingCount(), 0);
  });

  test("reject resolves with approved:false, decidedBy:'user'", async () => {
    const p = authorize("token.reset", { cid: "tab-2" }, {});
    const [rid] = getPendingRequestIds();
    _decideForTests(rid, false);
    const r = await p;
    assert.equal(r.approved, false);
    assert.equal(r.decidedBy, "user");
  });

  test("bypass:true returns approved:true, decidedBy:'bypass' immediately", async () => {
    const r = await authorize("token.reset", { cid: "tab-bypass" }, { bypass: true });
    assert.equal(r.approved, true);
    assert.equal(r.decidedBy, "bypass");
    assert.equal(getPendingCount(), 0);
    assert.equal(_sseFrames.length, 0, "bypass must NOT push needs_authorization SSE");
  });
});

// ============================================================
// authorize() — invalid action / missing ctx
// ============================================================
describe("authorize — invalid action", () => {
  test("invalid action resolves immediately to approved:false", async () => {
    const r = await authorize("unknown.action", { cid: "tab-x" });
    assert.equal(r.approved, false);
    assert.equal(r.decidedBy, "rejected");
    assert.match(r.reason, /invalid action/);
    assert.equal(getPendingCount(), 0);
    assert.equal(_sseFrames.length, 0);
  });

  test("empty action resolves immediately to approved:false", async () => {
    const r = await authorize("", { cid: "tab-x" });
    assert.equal(r.approved, false);
  });
});

// ============================================================
// authorize() — timeout (fail-closed)
// ============================================================
describe("authorize — 5-minute default timeout (fail-closed)", () => {
  test("respects custom timeoutMs option and resolves with decidedBy:'timeout'", async () => {
    const p = authorize("session.delete", { cid: "tab-t" }, { timeoutMs: 25 });
    assert.equal(getPendingCount(), 1);
    // Windows event-loop liveness fix (fork preview run 35493384574):
    // authorize()'s timeout timer is unref()'d — production-correct,
    // a pending auth request must never block process exit. But a bare
    // `await p` leaves the event loop with zero ref'd handles, so on
    // windows-latest the loop drains before the 25 ms timer can fire
    // and node:test reports "Promise resolution is still pending but
    // the event loop has already resolved" (POSIX passed only because
    // IO/scheduling noise held the loop). Hold the loop open with a
    // REF'd watchdog and release it the moment authorize settles —
    // liveness only, zero assertion change.
    const watchdog = setTimeout(() => {}, 5000);
    let r;
    try {
      r = await p;
    } finally {
      clearTimeout(watchdog);
    }
    assert.equal(r.approved, false);
    assert.equal(r.decidedBy, "timeout");
    // SSE mirror for other tabs
    assert.ok(
      _sseFrames.some((f) => f.event === "authorization_decided" &&
        f.approved === false && f.decidedBy === "timeout"),
      "timeout must broadcast authorization_decided SSE",
    );
  });

  test("custom timeoutMs of 0 falls back to 5-minute default", () => {
    const p = authorize("session.delete", { cid: "tab-def" }, { timeoutMs: 0 });
    assert.ok(p instanceof Promise);
    // We don't actually wait 5 min; just confirm it was queued.
    assert.equal(getPendingCount(), 1);
    // Clean up so other tests aren't blocked
    _resetForTests();
  });
});

// ============================================================
// handleAuthDecision — POST /api/auth/decision
// ============================================================
describe("handleAuthDecision — HTTP handler", () => {
  test("200 + ok:true on approve", async () => {
    const p = authorize("slash.clear", { cid: "tab-h1" }, {});
    const [rid] = getPendingRequestIds();
    const req = fakeReq({ requestId: rid, approve: true });
    const res = fakeRes();
    await handleAuthDecision(req, res);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.approved, true);
    assert.equal(body.decidedBy, "user");
    assert.equal(getPendingCount(), 0);
    const r = await p;
    assert.equal(r.approved, true);
  });

  test("200 + approved:false on decline", async () => {
    const p = authorize("slash.clear", { cid: "tab-h2" }, {});
    const [rid] = getPendingRequestIds();
    const res = fakeRes();
    await handleAuthDecision(fakeReq({ requestId: rid, approve: false }), res);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.approved, false);
    const r = await p;
    assert.equal(r.approved, false);
    assert.equal(r.decidedBy, "user");
  });

  test("400 on missing requestId", async () => {
    const res = fakeRes();
    await handleAuthDecision(fakeReq({ approve: true }), res);
    assert.equal(res._status, 400);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.match(body.error, /requestId required/);
  });

  test("404 on unknown requestId", async () => {
    const res = fakeRes();
    await handleAuthDecision(
      fakeReq({ requestId: "no-such-rid", approve: true }),
      res,
    );
    assert.equal(res._status, 404);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.match(body.error, /no pending request/);
  });

  test("404 on second decision for the same requestId (idempotency)", async () => {
    const p = authorize("slash.clear", { cid: "tab-h3" }, {});
    const [rid] = getPendingRequestIds();
    const first = fakeRes();
    await handleAuthDecision(fakeReq({ requestId: rid, approve: true }), first);
    assert.equal(first._status, 200);
    const second = fakeRes();
    await handleAuthDecision(fakeReq({ requestId: rid, approve: true }), second);
    assert.equal(second._status, 404,
      "second decision for the same requestId must NOT re-resolve");
    const r = await p;
    assert.equal(r.approved, true, "first resolution stands");
  });

  test("approve=false (truthy check) — only the literal true counts", async () => {
    const p = authorize("slash.clear", { cid: "tab-h4" }, {});
    const [rid] = getPendingRequestIds();
    const res = fakeRes();
    await handleAuthDecision(fakeReq({ requestId: rid, approve: "true" }), res);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.approved, false,
      "string 'true' must NOT coerce — strict boolean check");
    const r = await p;
    assert.equal(r.approved, false);
  });
});

// ============================================================
// clearPendingForCid — tab-close cleanup
// ============================================================
describe("clearPendingForCid — tab-close cleanup", () => {
  test("resolves all pending requests for the given cid as cancelled", async () => {
    const p1 = authorize("slash.clear", { cid: "tab-c" }, {});
    const p2 = authorize("token.reset", { cid: "tab-c" }, {});
    authorize("session.delete", { cid: "tab-other" }, {});
    assert.equal(getPendingCount(), 3);
    const n = clearPendingForCid("tab-c");
    assert.equal(n, 2);
    assert.equal(getPendingCount(), 1);
    const r1 = await p1;
    const r2 = await p2;
    assert.equal(r1.approved, false);
    assert.equal(r1.decidedBy, "cancelled");
    assert.equal(r2.approved, false);
    assert.equal(r2.decidedBy, "cancelled");
    // Other cid is untouched; clean up so the test process can exit.
    _resetForTests();
  });

  test("clearPendingForCid with no matching cid is a no-op", () => {
    authorize("slash.clear", { cid: "tab-x" }, {});
    const n = clearPendingForCid("tab-y");
    assert.equal(n, 0);
    assert.equal(getPendingCount(), 1);
    _resetForTests();
  });
});

// ============================================================
// Static guard (2026-09-20 rigor fix): no test-mode auto-approve.
// The old branch inspected process.execArgv for --test /
// --experimental-test-module-mocks and approved every gated action
// without a user decision. It is removed; this source-level
// assertion keeps it removed (mirrors the F4 mechanical grep).
// ============================================================
describe("authorize — no test-mode auto-approve (static guard)", () => {
  test("source contains no execArgv probe and no testMode option", async () => {
    const { readFileSync: rfs } = await import("node:fs");
    const src = rfs(resolve(__dirname, "..", "server", "lib", "authorize.js"), "utf8");
    assert.ok(!src.includes("execArgv"),
      "authorize.js must not inspect process.execArgv (test-mode auto-approve removed)");
    assert.ok(!/\btestMode\b/.test(src),
      "authorize.js must not accept an opts.testMode escape hatch");
    assert.ok(!src.includes("auto-test"),
      "the decidedBy:'auto-test' resolution is gone");
  });
});

// ============================================================
// SSE emission contract
// ============================================================
describe("pushAuthRequest / pushAuthDecision — SSE contracts", () => {
  test("authorize emits exactly one needs_authorization frame per call", () => {
    authorize("slash.clear", { cid: "tab-s1" }, {});
    assert.equal(_sseFrames.length, 1);
    assert.equal(_sseFrames[0].event, "needs_authorization");
    assert.equal(_sseFrames[0].action, "slash.clear");
    assert.equal(_sseFrames[0].ctx.cid, "tab-s1");
    _resetForTests();
  });

  test("resolution via HTTP emits one authorization_decided frame", async () => {
    const p = authorize("token.reset", { cid: "tab-s2" }, {});
    const [rid] = getPendingRequestIds();
    await handleAuthDecision(fakeReq({ requestId: rid, approve: true }), fakeRes());
    const decided = _sseFrames.find((f) => f.event === "authorization_decided");
    assert.ok(decided);
    assert.equal(decided.requestId, rid);
    assert.equal(decided.approved, true);
    assert.equal(decided.decidedBy, "user");
    await p;
  });

  test("empty cid in ctx → request still queues (broadcast semantics owned by state-bus)", () => {
    authorize("startup.cleanup", { cid: "" }, {});
    const f = _sseFrames[0];
    assert.ok(f);
    // authorize.js does NOT filter by cid — that's state-bus's job
    assert.equal(f.ctx.cid, "");
    _resetForTests();
  });
});