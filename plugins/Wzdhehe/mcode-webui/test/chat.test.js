// webui/test/chat.test.js
// Unit tests for server/routes/chat.js �?handleSend
//
// Why this test exists: v0.5.bx-32 �?handleSend must write
// cs.lastUsedWorkspace when a real user message is sent, and must
// NOT write it for ask_user answers. This is the inverse of
// handleSwitchSession's contract.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { setupMocks, absPath, registerSessionsStore } from "./_setup.js";

function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}
function fakeRes() {
  return {
    _status: 200,
    _headers: {},
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

let handleSend;
let makeClientState, clients;

before(async (t) => {
  await setupMocks(t, {
    mavis: { applyMavisUsageToCs: async () => {} },
  });
  const sb = await import(absPath("lib/state-bus.js"));
  makeClientState = sb.makeClientState;
  clients = sb.clients;
  const mod = await import(absPath("routes/chat.js"));
  handleSend = mod.handleSend;
});

beforeEach(() => {
  clients.clear();
  registerSessionsStore({ initial: [] });
});

describe("handleSend �?v0.5.bx-32 lastUsedWorkspace contract", () => {
  test("writing a real message sets cs.lastUsedWorkspace to current workspace.dir", async () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-X", branch: null, tree: null };
    cs.lastUsedWorkspace = null;
    cs.chat = [];
    clients.set(cid, cs);

    const ctx = { cs, cid };
    const res = fakeRes();
    await handleSend(fakeReq({ content: "hello world" }), res, ctx);

    assert.equal(
      cs.lastUsedWorkspace,
      "/ws-X",
      "real message should set lastUsedWorkspace to current workspace",
    );
  });

  test("ask_user answer does NOT write lastUsedWorkspace", async () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-X", branch: null, tree: null };
    cs.lastUsedWorkspace = null;
    cs.chat = [];
    clients.set(cid, cs);

    const ctx = { cs, cid };
    const res = fakeRes();
    await handleSend(
      fakeReq({ content: "my answer", isAskAnswer: true }),
      res,
      ctx,
    );

    assert.equal(
      cs.lastUsedWorkspace,
      null,
      "ask_user answer should NOT set lastUsedWorkspace (v0.5.bx-32)",
    );
  });

  test("empty content returns 400 without modifying cs", async () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-X", branch: null, tree: null };
    cs.lastUsedWorkspace = null;
    clients.set(cid, cs);

    const ctx = { cs, cid };
    const res = fakeRes();
    await handleSend(fakeReq({ content: "" }), res, ctx);

    assert.equal(res._status, 400);
    assert.equal(cs.lastUsedWorkspace, null);
    assert.equal(cs.chat.length, 0);
  });
});

// ============================================================
// 批次 C 扩展: 错误路径 + handleStop + handleCmd
// ============================================================

describe("handleSend — edge cases", () => {
  test("whitespace-only content returns 400", async () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-X", branch: null, tree: null };
    cs.lastUsedWorkspace = null;
    cs.chat = [];
    clients.set(cid, cs);

    const ctx = { cs, cid };
    const res = fakeRes();
    await handleSend(fakeReq({ content: "   \n\t  " }), res, ctx);
    assert.equal(res._status, 400);
  });
});

describe("handleStop", () => {
  test("no active child: wasRunning=false, cancelled=false, hardKilled=false", async () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-X", branch: null, tree: null };
    cs.mcodeSessionId = null;
    clients.set(cid, cs);
    const { getActiveChild } = await import(absPath("lib/state-bus.js"));
    // Ensure no child registered
    getActiveChild(cid);

    const res = fakeRes();
    const { handleStop } = await import(absPath("routes/chat.js"));
    await handleStop(null, res, { cs, cid });
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.wasRunning, false);
    assert.equal(body.cancelled, false);
    assert.equal(body.hardKilled, false);
  });

  test("mcode acp unsupported cancel: hardKilled=true, note='hard kill'", async () => {
    // The default mock for mcode-rpc.cancelSession returns {ok:false, code:'unsupported'}
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-X", branch: null, tree: null };
    cs.mcodeSessionId = "mvs_aabb000000000000000000000000abcd";
    clients.set(cid, cs);

    // Register a fake active child
    const { setActiveChild, getActiveChild } = await import(absPath("lib/state-bus.js"));
    const fakeChild = {
      child: { killed: false, exitCode: null },
      kill: () => { fakeChild.child.killed = true; },
    };
    setActiveChild(cid, fakeChild);
    assert.ok(getActiveChild(cid));

    const res = fakeRes();
    const { handleStop } = await import(absPath("routes/chat.js"));
    await handleStop(null, res, { cs, cid });
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.wasRunning, true);
    assert.equal(body.cancelled, false, "mcode acp unsupported → not cancelled");
    assert.equal(body.hardKilled, true, "fallback hard kill should fire");
    assert.match(body.note, /hard kill/);
  });
});

describe("handleCmd", () => {
  test("returns 200 with ok:true for any cmd (delegates to handleCmdCommand)", async () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-X", branch: null, tree: null };
    cs.sessionTitle = "Untitled";
    cs.chat = [];
    clients.set(cid, cs);

    const { handleCmd } = await import(absPath("routes/chat.js"));
    const res = fakeRes();
    await handleCmd(fakeReq({ cmd: "/status" }), res, { cs, cid });
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
  });
});
