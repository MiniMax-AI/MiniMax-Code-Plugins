// webui/test/routes-debug.test.js
// Unit tests for server/routes/debug.js — handleDebugInject + handleDebugState.
//
// Why this test exists: /api/debug/* is gated by DEBUG_INJECT=1 env. When
// enabled, the browser can inject mock state (goal / todo / ask / plan /
// appendChat) to test UI rendering without running real mcode. Bugs here
// = debug tool doesn't work, or accidentally enabled in prod.
//
// Test strategy: USE setupMocks to mock lib/acp-client.js. Without this mock,
// pushStateFor (called inside handleDebugInject) would trigger a real mcode
// acp client spawn via getMcodeSessionsForWorkspace on cache miss, hanging
// the test.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { setupMocks, absPath } from "./_setup.js";

let debug;
before(async (t) => {
  await setupMocks(t, {
    acp: {
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => [],
      getCachedMcodeCommands: () => ({ mcode: [], webui: [], fetchedAt: 0, source: "test" }),
    },
  });
  debug = await import(absPath("routes/debug.js"));
});

function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
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
    goal: { active: false, text: null, status: null, duration: null },
    todo: [],
    ask: { active: false, total: 0, answered: 0, currentIdx: 0, question: "", options: [] },
    plan: { active: false, title: null, summary: "", options: [] },
    chat: [],
  };
}

describe("handleDebugInject — gate", () => {
  let prevEnv;
  before(() => {
    prevEnv = process.env.DEBUG_INJECT;
  });
  after(() => {
    if (prevEnv === undefined) delete process.env.DEBUG_INJECT;
    else process.env.DEBUG_INJECT = prevEnv;
  });
  beforeEach(() => {
    delete process.env.DEBUG_INJECT;
  });

  test("returns 403 when DEBUG_INJECT is not '1'", async () => {
    process.env.DEBUG_INJECT = "0";
    const res = fakeRes();
    await debug.handleDebugInject(fakeReq({}), res, { cs: fakeCs(), cid: "cid-1" });
    assert.equal(res._status, 403);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.match(body.error, /DEBUG_INJECT/);
  });

  test("returns 403 when DEBUG_INJECT is unset", async () => {
    delete process.env.DEBUG_INJECT;
    const res = fakeRes();
    await debug.handleDebugInject(fakeReq({}), res, { cs: fakeCs(), cid: "cid-1" });
    assert.equal(res._status, 403);
  });
});

describe("handleDebugInject — payload types (DEBUG_INJECT=1)", () => {
  let prevEnv;
  before(() => {
    prevEnv = process.env.DEBUG_INJECT;
    process.env.DEBUG_INJECT = "1";
  });
  after(() => {
    if (prevEnv === undefined) delete process.env.DEBUG_INJECT;
    else process.env.DEBUG_INJECT = prevEnv;
  });

  test("applies goal payload to cs.goal", async () => {
    const cs = fakeCs();
    const res = fakeRes();
    await debug.handleDebugInject(
      fakeReq({ goal: { active: true, text: "test goal" } }),
      res,
      { cs, cid: "cid-1" },
    );
    assert.equal(res._status, 200);
    assert.equal(cs.goal.active, true);
    assert.equal(cs.goal.text, "test goal");
    const body = JSON.parse(res._body);
    assert.equal(body.applied.goal, true);
  });

  test("applies todo array to cs.todo", async () => {
    const cs = fakeCs();
    const res = fakeRes();
    await debug.handleDebugInject(
      fakeReq({ todo: [{ text: "task1" }, { text: "task2" }] }),
      res,
      { cs, cid: "cid-1" },
    );
    assert.equal(cs.todo.length, 2);
    const body = JSON.parse(res._body);
    assert.equal(body.applied.todoCount, 2);
  });

  test("applies ask payload to cs.ask", async () => {
    const cs = fakeCs();
    const res = fakeRes();
    await debug.handleDebugInject(
      fakeReq({ ask: { active: true, question: "which?", options: ["a", "b"] } }),
      res,
      { cs, cid: "cid-1" },
    );
    assert.equal(cs.ask.active, true);
    assert.equal(cs.ask.question, "which?");
    assert.deepEqual(cs.ask.options, ["a", "b"]);
  });

  test("applies plan payload to cs.plan", async () => {
    const cs = fakeCs();
    const res = fakeRes();
    await debug.handleDebugInject(
      fakeReq({ plan: { active: true, title: "test plan" } }),
      res,
      { cs, cid: "cid-1" },
    );
    assert.equal(cs.plan.active, true);
    assert.equal(cs.plan.title, "test plan");
  });

  test("appends to cs.chat when appendChat is an array", async () => {
    const cs = fakeCs();
    cs.chat = ["existing line"];
    const res = fakeRes();
    await debug.handleDebugInject(
      fakeReq({ appendChat: ["new line 1", "new line 2"] }),
      res,
      { cs, cid: "cid-1" },
    );
    assert.equal(cs.chat.length, 3);
    assert.equal(cs.chat[0], "existing line");
    assert.equal(cs.chat[1], "new line 1");
    assert.equal(cs.chat[2], "new line 2");
    const body = JSON.parse(res._body);
    assert.equal(body.applied.appendedChatLines, 2);
  });

  test("response includes applied status for each payload type", async () => {
    const cs = fakeCs();
    const res = fakeRes();
    await debug.handleDebugInject(
      fakeReq({
        goal: { active: true },
        todo: [{ text: "t" }],
        ask: { active: true },
        plan: { active: true },
        appendChat: ["x"],
      }),
      res,
      { cs, cid: "cid-1" },
    );
    const body = JSON.parse(res._body);
    assert.equal(body.applied.goal, true);
    assert.equal(body.applied.todoCount, 1);
    assert.equal(body.applied.ask, true);
    assert.equal(body.applied.plan, true);
    assert.equal(body.applied.appendedChatLines, 1);
  });
});

describe("handleDebugState — gate", () => {
  let prevEnv;
  before(() => {
    prevEnv = process.env.DEBUG_INJECT;
  });
  after(() => {
    if (prevEnv === undefined) delete process.env.DEBUG_INJECT;
    else process.env.DEBUG_INJECT = prevEnv;
  });
  beforeEach(() => {
    delete process.env.DEBUG_INJECT;
  });

  test("returns 403 when DEBUG_INJECT is not '1'", () => {
    const res = fakeRes();
    debug.handleDebugState(null, res, { cs: fakeCs(), cid: "cid-1" });
    assert.equal(res._status, 403);
  });
});

describe("handleDebugState — returns cs state snapshot (DEBUG_INJECT=1)", () => {
  let prevEnv;
  before(() => {
    prevEnv = process.env.DEBUG_INJECT;
    process.env.DEBUG_INJECT = "1";
  });
  after(() => {
    if (prevEnv === undefined) delete process.env.DEBUG_INJECT;
    else process.env.DEBUG_INJECT = prevEnv;
  });

  test("returns goal / todoCount / ask / plan / chatLast5", () => {
    const cs = fakeCs();
    cs.goal = { active: true, text: "test", status: "in_progress" };
    cs.todo = [{ text: "t1" }, { text: "t2" }];
    cs.chat = ["line1", "line2", "line3", "line4", "line5", "line6"];
    const res = fakeRes();
    debug.handleDebugState(null, res, { cs, cid: "cid-1" });
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.goal.text, "test");
    assert.equal(body.todoCount, 2);
    assert.deepEqual(body.chatLast5, ["line2", "line3", "line4", "line5", "line6"]);
  });

  test("handles missing chat array gracefully", () => {
    const cs = fakeCs();
    delete cs.chat; // missing chat
    const res = fakeRes();
    debug.handleDebugState(null, res, { cs, cid: "cid-1" });
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    // Should not throw, should default to empty
    assert.deepEqual(body.chatLast5, []);
  });
});
