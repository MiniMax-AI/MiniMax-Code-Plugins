// webui/test/state-bus.test.js
// Unit tests for server/lib/state-bus.js — pushStateFor + ensureMcodeSessionsFetchedAndPush
//
// Why this test exists: v0.5.bx-31 broadcast bug — when the first SSE
// connection is established and mcodeSessions cache is empty, the
// SUT must fire-and-forget fetch the sessions and then push to all
// connected SSE clients. The dedup test ensures a second call with
// the same workspace is a no-op while the first is in flight.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setupMocks,
  absPath,
  registerAcpMock,
  registerSessionsStore,
} from "./_setup.js";

let pushStateFor, mcodeSessionsSnapshotFields;
let clients, sseByCid, makeClientState;
let acpFetchCalls, cachedByWs;

before(async (t) => {
  await setupMocks(t);
  const mod = await import(absPath("lib/state-bus.js"));
  pushStateFor = mod.pushStateFor;
  mcodeSessionsSnapshotFields = mod.mcodeSessionsSnapshotFields;
  clients = mod.clients;
  sseByCid = mod.sseByCid;
  makeClientState = mod.makeClientState;
});

// Mock acp-client to track fetch calls and serve cache from in-memory map
beforeEach(async () => {
  acpFetchCalls = [];
  cachedByWs = new Map();
  registerAcpMock({
    getMcodeSessionsForWorkspace: async (ws) => {
      acpFetchCalls.push(ws);
      return [{ id: "mock-" + ws, workspace: ws }];
    },
    getMcodeSessionsCacheSync: (ws) =>
      cachedByWs.has(ws) ? cachedByWs.get(ws) : null,
    getMcodeSessionsStaleSync: () => null,
  });
  // Clear clients / sseByCid between tests
  clients.clear();
  sseByCid.clear();
  registerSessionsStore({
    initial: [
      {
        id: "sess-1",
        title: "old",
        workspace: "/w",
        createdAt: 1,
        updatedAt: 1,
        chat: [],
      },
    ],
  });
});

function fakeSse() {
  const writes = [];
  return {
    writes,
    write: (chunk) => {
      writes.push(chunk);
    },
  };
}

describe("pushStateFor", () => {
  test("uses opts.mcodeSessions when provided (skips cache lookup)", () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace.dir = "/w";
    clients.set(cid, cs);
    sseByCid.set(cid, fakeSse());
    const sessions = [{ id: "direct-1" }];
    pushStateFor(cid, { mcodeSessions: sessions });
    const payload = JSON.parse(sseByCid.get(cid).writes[0].slice(6));
    assert.deepEqual(payload.mcodeSessions, sessions);
  });

  test("reads from cache when available (no fire-and-forget fetch)", () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace.dir = "/cached-ws";
    clients.set(cid, cs);
    sseByCid.set(cid, fakeSse());
    cachedByWs.set("/cached-ws", [{ id: "cached-1" }]);
    pushStateFor(cid);
    const payload = JSON.parse(sseByCid.get(cid).writes[0].slice(6));
    assert.deepEqual(payload.mcodeSessions, [{ id: "cached-1" }]);
    // No fetch should have been triggered
    assert.equal(acpFetchCalls.length, 0);
  });

  test("falls back to [] + fire-and-forget fetch on cache miss", () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace.dir = "/uncached-ws";
    clients.set(cid, cs);
    sseByCid.set(cid, fakeSse());
    pushStateFor(cid);
    const payload = JSON.parse(sseByCid.get(cid).writes[0].slice(6));
    // Immediately sees [] (cache miss → empty placeholder)
    assert.deepEqual(payload.mcodeSessions, []);
  });
});

describe('pushStateFor "__broadcast__"', () => {
  test("iterates all connected SSE clients", () => {
    const a = fakeSse(),
      b = fakeSse();
    clients.set("a", makeClientState());
    sseByCid.set("a", a);
    clients.set("b", makeClientState());
    sseByCid.set("b", b);
    pushStateFor("__broadcast__", { mcodeSessions: [{ id: "bcast" }] });
    assert.equal(a.writes.length, 1);
    assert.equal(b.writes.length, 1);
    const pa = JSON.parse(a.writes[0].slice(6));
    const pb = JSON.parse(b.writes[0].slice(6));
    assert.deepEqual(pa.mcodeSessions, [{ id: "bcast" }]);
    assert.deepEqual(pb.mcodeSessions, [{ id: "bcast" }]);
  });
});

// ============================================================
// 批次 D 扩展: 覆盖 SSE 频道管理 + active child 管理
// ============================================================

let pushOnlineCount, setActiveChild, getActiveChild, clearActiveChild;
let getCidsByMcodeSession, getSseClient, setSseClient, endSseClient;
let getClient, getCidFromReq;

before(async () => {
  const sb = await import(absPath("lib/state-bus.js"));
  pushOnlineCount = sb.pushOnlineCount;
  setActiveChild = sb.setActiveChild;
  getActiveChild = sb.getActiveChild;
  clearActiveChild = sb.clearActiveChild;
  getCidsByMcodeSession = sb.getCidsByMcodeSession;
  getSseClient = sb.getSseClient;
  setSseClient = sb.setSseClient;
  endSseClient = sb.endSseClient;
  getClient = sb.getClient;
  getCidFromReq = sb.getCidFromReq;
});

describe("pushOnlineCount", () => {
  test("broadcasts online count to all connected SSE clients", () => {
    const a = fakeSse(),
      b = fakeSse();
    clients.set("a", makeClientState());
    sseByCid.set("a", a);
    clients.set("b", makeClientState());
    sseByCid.set("b", b);
    pushOnlineCount(false);
    assert.equal(a.writes.length, 1);
    assert.equal(b.writes.length, 1);
    // payload should have onlineCount=2
    const pa = JSON.parse(a.writes[0].slice(6));
    assert.equal(pa.onlineCount, 2);
  });

  test("does not throw when no SSE clients connected", () => {
    sseByCid.clear();
    assert.doesNotThrow(() => pushOnlineCount(false));
  });
});

describe("active child management", () => {
  test("setActiveChild + getActiveChild + clearActiveChild", () => {
    const cid = "cid-active-1";
    assert.equal(getActiveChild(cid), null, "should be null initially");
    const fakeChild = { id: "child-1" };
    setActiveChild(cid, fakeChild);
    assert.strictEqual(getActiveChild(cid), fakeChild);
    clearActiveChild(cid);
    assert.equal(getActiveChild(cid), null);
  });

  test("clearActiveChild on unregistered cid is a no-op (no throw)", () => {
    assert.doesNotThrow(() => clearActiveChild("never-set-cid"));
  });

  test("setActiveChild overwrites previous child for same cid", () => {
    const cid = "cid-active-2";
    const c1 = { id: "c1" };
    const c2 = { id: "c2" };
    setActiveChild(cid, c1);
    setActiveChild(cid, c2);
    assert.strictEqual(getActiveChild(cid), c2, "should be overwritten");
    clearActiveChild(cid);
  });
});

describe("getCidsByMcodeSession", () => {
  test("empty sid returns []", () => {
    assert.deepEqual(getCidsByMcodeSession(""), []);
  });

  test("null sid returns []", () => {
    assert.deepEqual(getCidsByMcodeSession(null), []);
  });

  test("no matches returns []", () => {
    clients.clear();
    assert.deepEqual(getCidsByMcodeSession("mvs_nonexistent"), []);
  });

  test("matches one cid", () => {
    clients.clear();
    const cs = makeClientState();
    cs.mcodeSessionId = "mvs_match_one_aaaa0000000000000000";
    clients.set("cid-match-1", cs);
    const out = getCidsByMcodeSession("mvs_match_one_aaaa0000000000000000");
    assert.equal(out.length, 1);
    assert.equal(out[0].cid, "cid-match-1");
  });

  test("matches multiple cids (same mcode session open in multiple tabs)", () => {
    clients.clear();
    const cs1 = makeClientState();
    cs1.mcodeSessionId = "mvs_shared_bbbb0000000000000000";
    const cs2 = makeClientState();
    cs2.mcodeSessionId = "mvs_shared_bbbb0000000000000000";
    clients.set("cid-tab-1", cs1);
    clients.set("cid-tab-2", cs2);
    const out = getCidsByMcodeSession("mvs_shared_bbbb0000000000000000");
    assert.equal(out.length, 2);
  });
});

describe("SSE channel helpers", () => {
  test("getSseClient returns null for unregistered cid", () => {
    assert.equal(getSseClient("never-set"), null);
  });

  test("setSseClient + getSseClient round-trip", () => {
    const cid = "cid-sse-1";
    const res = fakeSse();
    setSseClient(cid, res);
    assert.strictEqual(getSseClient(cid), res);
  });

  test("setSseClient for same cid overwrites previous", () => {
    const cid = "cid-sse-2";
    const a = fakeSse();
    const b = fakeSse();
    setSseClient(cid, a);
    setSseClient(cid, b);
    assert.strictEqual(getSseClient(cid), b, "should overwrite");
  });

  test("endSseClient clears the map entry", () => {
    const cid = "cid-sse-3";
    const res = fakeSse();
    setSseClient(cid, res);
    endSseClient(cid, res);
    assert.equal(getSseClient(cid), null);
  });

  test("endSseClient with mismatched res does NOT clear (race-safe)", () => {
    const cid = "cid-sse-4";
    const a = fakeSse();
    const b = fakeSse();
    setSseClient(cid, a);
    // Caller passes a different res (stale)
    endSseClient(cid, b);
    assert.strictEqual(getSseClient(cid), a, "should still be a, not cleared");
  });
});

describe("getClient + getCidFromReq", () => {
  test("getClient creates a fresh state for unknown cid", () => {
    const cid = "cid-fresh-1";
    const cs = getClient(cid);
    assert.ok(cs);
    assert.equal(cs.sessionId, null);
    assert.ok(cs.workspace);
  });

  test("getClient returns same state for same cid (singleton per cid)", () => {
    const cid = "cid-fresh-2";
    const a = getClient(cid);
    const b = getClient(cid);
    assert.strictEqual(a, b);
  });

  test("getClient with empty cid returns 'default' client", () => {
    const a = getClient("");
    assert.ok(a);
  });

  test("getCidFromReq parses cid from query string", () => {
    const req = { url: "/api/state?cid=my-cid-123" };
    assert.equal(getCidFromReq(req), "my-cid-123");
  });

  test("getCidFromReq returns '' when no cid param", () => {
    const req = { url: "/api/state" };
    assert.equal(getCidFromReq(req), "");
  });

  test("getCidFromReq returns '' on malformed URL", () => {
    const req = { url: "not-a-valid-url" };
    // URL constructor will throw on bad input → caught → return ""
    assert.equal(getCidFromReq(req), "");
  });
});

// ============================================================
// v1.0 推送字段回归 — 侧栏闪跌三连修:
//   1) pushOnlineCount / SSE 首推曾不带 mcodeSessions → 客户端 undefined 闪跌
//   2) 缓存过期时曾推空占位 → 闪跌后弹回
//   3) 统一走 mcodeSessionsSnapshotFields, 过期推旧值 (pending=true)
// ============================================================
describe("v1.0 push fields — mcodeSessions 永不缺失、永不空占位", () => {
  test("pushOnlineCount 的推送必须带 mcodeSessions 字段 (fresh cache)", () => {
    cachedByWs.set("/w", [{ id: "s1" }]);
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace.dir = "/w";
    clients.set(cid, cs);
    sseByCid.set(cid, fakeSse());
    pushOnlineCount(true);
    const payload = JSON.parse(sseByCid.get(cid).writes[0].slice(6));
    assert.ok(Array.isArray(payload.mcodeSessions),
      "回归: pushOnlineCount 曾不带该字段, 客户端整包替换后 undefined → 侧栏闪跌");
    assert.equal(payload.mcodeSessions.length, 1);
    assert.equal(payload.mcodeSessionsPending, false);
  });

  test("pushOnlineCount 缓存过期时推过期列表, 不推空占位", () => {
    // fresh miss (cachedByWs 空) + stale hit → 旧值 + pending
    registerAcpMock({ getMcodeSessionsStaleSync: () => [{ id: "stale-1" }, { id: "stale-2" }] });
    const cid = "cid-2";
    const cs = makeClientState();
    cs.workspace.dir = "/w";
    clients.set(cid, cs);
    sseByCid.set(cid, fakeSse());
    pushOnlineCount(true);
    const payload = JSON.parse(sseByCid.get(cid).writes[0].slice(6));
    assert.ok(Array.isArray(payload.mcodeSessions));
    assert.equal(payload.mcodeSessions.length, 2, "过期值好过空值 — 不允许闪跌到空列表");
    assert.equal(payload.mcodeSessionsPending, true);
  });

  test("mcodeSessionsSnapshotFields: fresh / stale / 全miss 三态", () => {
    // fresh
    cachedByWs.set("/w", [{ id: "f" }]);
    assert.deepEqual(mcodeSessionsSnapshotFields("/w"),
      { mcodeSessions: [{ id: "f" }], mcodeSessionsPending: false });
    // stale (fresh miss, stale hit)
    cachedByWs.delete("/w");
    registerAcpMock({ getMcodeSessionsStaleSync: () => [{ id: "s" }] });
    assert.deepEqual(mcodeSessionsSnapshotFields("/w"),
      { mcodeSessions: [{ id: "s" }], mcodeSessionsPending: true });
    // 全 miss → 空占位 + 触发后台拉取
    registerAcpMock({ getMcodeSessionsStaleSync: () => null });
    acpFetchCalls.length = 0;
    const fields = mcodeSessionsSnapshotFields("/other-ws");
    assert.deepEqual(fields, { mcodeSessions: [], mcodeSessionsPending: true });
    assert.ok(acpFetchCalls.includes("/other-ws"), "miss 时必须 fire-and-forget 拉取");
  });

  test("pushStateFor (单播) 在 stale 缓存下带 pending 标记且列表非空", () => {
    registerAcpMock({ getMcodeSessionsStaleSync: () => [{ id: "stale-x" }] });
    const cid = "cid-3";
    const cs = makeClientState();
    cs.workspace.dir = "/w";
    clients.set(cid, cs);
    sseByCid.set(cid, fakeSse());
    pushStateFor(cid);
    const payload = JSON.parse(sseByCid.get(cid).writes[0].slice(6));
    assert.ok(Array.isArray(payload.mcodeSessions));
    assert.equal(payload.mcodeSessions.length, 1);
    assert.equal(payload.mcodeSessionsPending, true);
  });
});
