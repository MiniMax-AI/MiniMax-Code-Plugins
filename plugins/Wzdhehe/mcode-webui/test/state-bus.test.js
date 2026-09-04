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
  // v2026-08-28 modacker: Token Plan mock mutators, used in the
  //   quota-fields regression describe block at the bottom of the file.
  setQuotaEnabled,
  setTokenPlanApiKey,
  // v2026-08-28 modacker (A+C): external key source mutators, used
  //   in the priority-chain + source-field regression block.
  setEnvTokenPlanKey,
  setFileTokenPlanKey,
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

// ============================================================
// v2026-08-28 modacker: Token Plan (套餐用量) 推送字段回归
//   pushStateFor / pushOnlineCount / ensureMcodeSessionsFetchedAndPush
//   三个推送点的 snapshot 都必须带 quotaEnabled / hasTokenPlanKey /
//   tokenPlanApiKeyMasked. 之前只走 settings.snapshot (one-shot
//   loadLanInfo), SSE 整包替换 state 后 quotaEnabled 被冲掉,
//   "启用套餐用量" toggle 视觉上无反应 — btn-usage 一直 hidden.
// ============================================================
describe("v2026-08-28 modacker: Token Plan fields — 每次 SSE 推送必须带 quota 三件", () => {
  test("pushStateFor (单播) 带 quotaEnabled / hasTokenPlanKey / tokenPlanApiKeyMasked", () => {
    setQuotaEnabled(true);
    setTokenPlanApiKey("eyJhbGciOiJIUzI1NiJ9.payload.signature");
    const cid = "q-cid-1";
    const cs = makeClientState();
    cs.workspace.dir = "/w";
    clients.set(cid, cs);
    sseByCid.set(cid, fakeSse());
    pushStateFor(cid);
    const payload = JSON.parse(sseByCid.get(cid).writes[0].slice(6));
    assert.equal(payload.quotaEnabled, true, "回归: 该字段缺失则 SSE 替换 state 后 toggle 失效");
    assert.equal(payload.hasTokenPlanKey, true);
    assert.equal(payload.tokenPlanApiKeyMasked, "sk-cp-...ture",
      "masked 形如 sk-cp-...XXXX, 不能回传原始 key");
    // 反向: 关掉时三件同步更新
    setQuotaEnabled(false);
    sseByCid.get(cid).writes.length = 0;
    pushStateFor(cid);
    const p2 = JSON.parse(sseByCid.get(cid).writes[0].slice(6));
    assert.equal(p2.quotaEnabled, false);
    assert.equal(p2.hasTokenPlanKey, false,
      "setQuotaEnabled(false) 应当清空 key, hasTokenPlanKey 必须反映");
    assert.equal(p2.tokenPlanApiKeyMasked, "");
    // reset for next test
    setQuotaEnabled(false);
    setTokenPlanApiKey("");
  });

  test("pushStateFor (__broadcast__) 也带 quota 三件 — 推给所有 client", () => {
    setQuotaEnabled(true);
    setTokenPlanApiKey("abcdefghij");
    const cidA = "q-A", cidB = "q-B";
    clients.set(cidA, makeClientState());
    clients.set(cidB, makeClientState());
    sseByCid.set(cidA, fakeSse());
    sseByCid.set(cidB, fakeSse());
    pushStateFor("__broadcast__");
    for (const cid of [cidA, cidB]) {
      const payload = JSON.parse(sseByCid.get(cid).writes[0].slice(6));
      assert.equal(payload.quotaEnabled, true, `client ${cid} 收到 broadcast 必须带 quotaEnabled`);
      assert.equal(payload.hasTokenPlanKey, true);
      assert.equal(payload.tokenPlanApiKeyMasked, "sk-cp-...ghij");
    }
    setQuotaEnabled(false);
    setTokenPlanApiKey("");
  });

  test("pushOnlineCount 带 quota 三件 — 在线数变化那次推送不能冲掉", () => {
    setQuotaEnabled(true);
    setTokenPlanApiKey("1234567890");
    const cid = "q-online";
    const cs = makeClientState();
    cs.workspace.dir = "/w";
    clients.set(cid, cs);
    sseByCid.set(cid, fakeSse());
    pushOnlineCount(true);
    const payload = JSON.parse(sseByCid.get(cid).writes[0].slice(6));
    assert.equal(payload.quotaEnabled, true,
      "回归: 之前 pushOnlineCount 不带此字段, 多 tab 打开/关闭时 toggle 被打回");
    assert.equal(payload.hasTokenPlanKey, true);
    assert.equal(payload.tokenPlanApiKeyMasked, "sk-cp-...7890");
    setQuotaEnabled(false);
    setTokenPlanApiKey("");
  });
});

// ============================================================
// v2026-08-28 modacker (A+C): 外部 key 源优先级链 + source 字段
//   getTokenPlanApiKey() 优先级: env > file > settings.json
//   每次 SSE 推送必须带 tokenPlanApiKeySource + tokenPlanApiKeyFilePath
//   这两个新字段, webui 据此隐藏 "delete" 按钮 + 显示来源标签。
//   这些测试同时也是 _setup.js mock 跟真实实现行为一致的契约。
// ============================================================
describe("v2026-08-28 modacker (A+C): external key source 优先级 + SSE 字段", () => {
  function snapshotOf(cid) {
    return JSON.parse(sseByCid.get(cid).writes[0].slice(6));
  }

  test("settings.json 路径: source = 'settings', 无 file path", () => {
    setQuotaEnabled(true);
    setTokenPlanApiKey("settings-key-1234");
    const cid = "src-1";
    clients.set(cid, makeClientState());
    sseByCid.set(cid, fakeSse());
    pushStateFor(cid);
    const p = snapshotOf(cid);
    assert.equal(p.tokenPlanApiKeySource, "settings");
    assert.equal(p.tokenPlanApiKeyFilePath, "");
    assert.equal(p.hasTokenPlanKey, true);
    assert.equal(p.tokenPlanApiKeyMasked, "sk-cp-...1234");
    setTokenPlanApiKey("");
    setQuotaEnabled(false);
  });

  test("file 路径: source = 'file', 带 file path, 屏蔽 settings.json", () => {
    setQuotaEnabled(true);
    setTokenPlanApiKey("settings-key-1234");
    setFileTokenPlanKey("file-key-5678", "/tmp/token-plan.json");
    const cid = "src-2";
    clients.set(cid, makeClientState());
    sseByCid.set(cid, fakeSse());
    pushStateFor(cid);
    const p = snapshotOf(cid);
    assert.equal(p.tokenPlanApiKeySource, "file",
      "file 路径应当胜过 settings.json (env 缺席时)");
    assert.equal(p.tokenPlanApiKeyFilePath, "/tmp/token-plan.json");
    assert.equal(p.hasTokenPlanKey, true);
    assert.equal(p.tokenPlanApiKeyMasked, "sk-cp-...5678",
      "masked 用 file key 算, 不是 settings key");
    // reset
    setFileTokenPlanKey("", "");
    setTokenPlanApiKey("");
    setQuotaEnabled(false);
  });

  test("env 路径: source = 'env', 屏蔽 file + settings.json", () => {
    setQuotaEnabled(true);
    setTokenPlanApiKey("settings-key-1234");
    setFileTokenPlanKey("file-key-5678", "/tmp/token-plan.json");
    setEnvTokenPlanKey("env-key-9999");
    const cid = "src-3";
    clients.set(cid, makeClientState());
    sseByCid.set(cid, fakeSse());
    pushStateFor(cid);
    const p = snapshotOf(cid);
    assert.equal(p.tokenPlanApiKeySource, "env",
      "env 应当胜过 file + settings.json, 是最高优先级");
    assert.equal(p.hasTokenPlanKey, true);
    assert.equal(p.tokenPlanApiKeyMasked, "sk-cp-...9999",
      "masked 用 env key 算, 不是 file/settings");
    // reset
    setEnvTokenPlanKey("");
    setFileTokenPlanKey("", "");
    setTokenPlanApiKey("");
    setQuotaEnabled(false);
  });

  test("env 清空 → 自动降级到 file → 再降级到 settings.json", () => {
    setQuotaEnabled(true);
    setTokenPlanApiKey("settings-key-1234");
    setFileTokenPlanKey("file-key-5678", "/tmp/token-plan.json");
    setEnvTokenPlanKey("env-key-9999");
    const cid = "src-4";
    clients.set(cid, makeClientState());
    sseByCid.set(cid, fakeSse());
    // initial: env
    pushStateFor(cid);
    assert.equal(snapshotOf(cid).tokenPlanApiKeySource, "env");
    // 清 env — file 顶上
    sseByCid.get(cid).writes.length = 0;
    setEnvTokenPlanKey("");
    pushStateFor(cid);
    assert.equal(snapshotOf(cid).tokenPlanApiKeySource, "file",
      "env 取消后, file 自动顶上 — 优先级链实时");
    // 清 file — settings 顶上
    sseByCid.get(cid).writes.length = 0;
    setFileTokenPlanKey("", "");
    pushStateFor(cid);
    assert.equal(snapshotOf(cid).tokenPlanApiKeySource, "settings",
      "file 也取消后, settings.json 顶上");
    // reset
    setTokenPlanApiKey("");
    setQuotaEnabled(false);
  });

  test("broadcast (pushStateFor __broadcast__) 同样带 source + file path", () => {
    setQuotaEnabled(true);
    setFileTokenPlanKey("file-key-aaaa", "/etc/webui/key.json");
    const cidA = "src-A", cidB = "src-B";
    clients.set(cidA, makeClientState());
    clients.set(cidB, makeClientState());
    sseByCid.set(cidA, fakeSse());
    sseByCid.set(cidB, fakeSse());
    pushStateFor("__broadcast__");
    for (const cid of [cidA, cidB]) {
      const p = snapshotOf(cid);
      assert.equal(p.tokenPlanApiKeySource, "file");
      assert.equal(p.tokenPlanApiKeyFilePath, "/etc/webui/key.json");
    }
    setFileTokenPlanKey("", "");
    setQuotaEnabled(false);
  });

  test("无任何 key 时 source = '', hasTokenPlanKey = false", () => {
    // explicit reset
    setTokenPlanApiKey("");
    setFileTokenPlanKey("", "");
    setEnvTokenPlanKey("");
    setQuotaEnabled(false);
    const cid = "src-empty";
    clients.set(cid, makeClientState());
    sseByCid.set(cid, fakeSse());
    pushStateFor(cid);
    const p = snapshotOf(cid);
    assert.equal(p.tokenPlanApiKeySource, "");
    assert.equal(p.hasTokenPlanKey, false);
    assert.equal(p.tokenPlanApiKeyMasked, "");
    assert.equal(p.quotaEnabled, false);
  });
});
