// webui/test/routes-protocol.test.js
// Unit tests for server/routes/protocol.js — HTTP status code mapping for
// mcode acp protocol endpoints (set-mode, set-config-option, cancel,
// load-session, activate-session, list-sessions, capabilities).
//
// Why this test exists: routes/protocol.js maps mcode acp's `code` field
// to an HTTP status code:
//   - "unsupported" → 501 (mcode 0.1.5 doesn't implement this method)
//   - "no_client"   → 503 (mcode acp client not running)
//   - /not.found|invalid/ → 404
//   - /conflict|policy/  → 409
//   - other → 500
// Plus 400 for input validation (missing sessionId/mode/key).
// Bugs here = the front-end gets a 500 instead of a 501 and shows the user
// a generic "something broke" instead of "this feature is not available".
//
// Test strategy: USE setupMocks to mock mcode-rpc.js. We can control the
// returned code per test to verify each branch of the status-code mapping.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { setupMocks, absPath } from "./_setup.js";

let protoRoute;
before(async (t) => {
  await setupMocks(t, {});
  protoRoute = await import(absPath("routes/protocol.js"));
});

function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body || {}), "utf8")]);
}
function fakeRes() {
  const res = {
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
  return res;
}
function fakeCs() {
  return {
    workspace: { dir: "/ws-X", branch: null, tree: null },
    permissions: "Full access",
    planMode: false,
  };
}

describe("handleSetMode — /api/protocol/set-mode", () => {
  test("400 when sessionId is missing", async () => {
    const res = fakeRes();
    await protoRoute.handleSetMode(
      fakeReq({ mode: "plan_mode" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 400);
  });

  test("400 when mode is missing", async () => {
    const res = fakeRes();
    await protoRoute.handleSetMode(
      fakeReq({ sessionId: "mvs_aaa" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 400);
  });

  test("501 when mcode acp returns {ok:false, code:'unsupported'}", async () => {
    // The default mock returns {ok:false, code:'unsupported'} for setMode
    const res = fakeRes();
    await protoRoute.handleSetMode(
      fakeReq({ sessionId: "mvs_aaa", mode: "plan_mode" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 501);
    const body = JSON.parse(res._body);
    assert.equal(body.code, "unsupported");
    assert.equal(body.fallback, "send_plan_as_prompt");
  });
});

describe("handleSetConfigOption — /api/protocol/set-config-option", () => {
  test("400 when sessionId is missing", async () => {
    const res = fakeRes();
    await protoRoute.handleSetConfigOption(
      fakeReq({ key: "permissionMode", value: "auto" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 400);
  });

  test("400 when key is missing", async () => {
    const res = fakeRes();
    await protoRoute.handleSetConfigOption(
      fakeReq({ sessionId: "mvs_aaa", value: "auto" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 400);
  });

  test("501 when mcode acp returns code:'unsupported'", async () => {
    const res = fakeRes();
    await protoRoute.handleSetConfigOption(
      fakeReq({ sessionId: "mvs_aaa", key: "permissionMode", value: "auto" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 501);
  });
});

describe("handleCancel — /api/protocol/cancel", () => {
  test("400 when sessionId is missing", async () => {
    const res = fakeRes();
    await protoRoute.handleCancel(fakeReq({}), res, { cs: fakeCs(), cid: "cid-1" });
    assert.equal(res._status, 400);
  });

  test("200 with cancelled:false when mcode returns unsupported (mcode 0.1.5)", async () => {
    // handleCancel is lenient: it returns 200 even when cancel fails,
    // because the user intent is "cancel" and the server will hard-kill as fallback.
    const res = fakeRes();
    await protoRoute.handleCancel(
      fakeReq({ sessionId: "mvs_aaa" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.cancelled, false, "mcode 0.1.5 acp returns cancelled:false");
    assert.equal(body.fallback, "hard_kill");
  });
});

describe("handleLoadSession — /api/protocol/load-session", () => {
  test("400 when sessionId is missing", async () => {
    const res = fakeRes();
    await protoRoute.handleLoadSession(fakeReq({}), res, { cs: fakeCs(), cid: "cid-1" });
    assert.equal(res._status, 400);
  });

  test("500 when mcode acp returns code:'unsupported' (handleLoadSession has DIFFERENT mapping than setMode)", async () => {
    // handleLoadSession does NOT have 501 in its status code mapping.
    // It maps: no_client → 503, /not.found|invalid/ → 404, OTHER → 500.
    // 'unsupported' falls through to 500.
    const res = fakeRes();
    await protoRoute.handleLoadSession(
      fakeReq({ sessionId: "mvs_aaa", cwd: "/ws-X" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 500);
  });
});

describe("handleActivateSession — /api/protocol/activate-session", () => {
  test("400 when sessionId is missing", async () => {
    const res = fakeRes();
    await protoRoute.handleActivateSession(fakeReq({}), res, {
      cs: fakeCs(),
      cid: "cid-1",
    });
    assert.equal(res._status, 400);
  });

  test("501 when mcode acp returns code:'unsupported'", async () => {
    const res = fakeRes();
    await protoRoute.handleActivateSession(
      fakeReq({ sessionId: "mvs_aaa" }),
      res,
      { cs: fakeCs(), cid: "cid-1" },
    );
    assert.equal(res._status, 501);
  });
});

describe("handleListSessions — /api/protocol/list-sessions", () => {
  // Note: the real listSessions returns an array (not {sessions: [...]}).
  // We need to override the default mock to return [].
  before(async () => {
    const { registerAcpMock } = await import("./_setup.js");
    registerAcpMock({ listSessions: async () => [] });
  });

  test("returns 200 + sessions array (no cwd filter)", async () => {
    const req = { url: "/api/protocol/list-sessions" };
    const res = fakeRes();
    await protoRoute.handleListSessions(req, res, { cs: fakeCs(), cid: "cid-1" });
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.sessions));
  });

  test("returns 200 + filtered sessions when cwd query is provided", async () => {
    const req = { url: "/api/protocol/list-sessions?cwd=/ws-X" };
    const res = fakeRes();
    await protoRoute.handleListSessions(req, res, { cs: fakeCs(), cid: "cid-1" });
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.cwd, "/ws-X");
  });
});

describe("handleCapabilities — /api/protocol/capabilities", () => {
  test("returns 200 + mcodeVersion + capabilities map + notes", async () => {
    const res = fakeRes();
    await protoRoute.handleCapabilities(null, res);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(typeof body.mcodeVersion, "string");
    assert.equal(typeof body.capabilities, "object");
    assert.equal(typeof body.notes, "object");
  });
});
