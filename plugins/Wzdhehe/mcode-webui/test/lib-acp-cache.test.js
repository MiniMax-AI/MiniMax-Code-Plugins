// webui/test/lib-acp-cache.test.js
// v1.0: acp-client 会话缓存语义 — 侧栏防闪跌三件套的单测。
//
//   getMcodeSessionsCacheSync    fresh hit (30s TTL 内同 ws)
//   getMcodeSessionsStaleSync    同 ws 过期列表可用 (过期值好过空值)
//   dropMcodeSessionFromCache    只剔除被删 sid, 缓存整体仍可用 (不清空/不作废)
//   invalidateMcodeSessionsCache 软失效 — fresh miss 但 stale 仍有
//
// 这四个语义共同保证: 任何 SSE 推送都不会因为删会话/缓存过期而携带空列表。
// 隔离方式: mock acp.mjs 的 McodeAcpClient (不 spawn 真实 mcode 子进程),
// 不走 setupMocks (它会把 SUT lib/acp-client.js 整个换掉)。

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { absPath } from "./_setup.js";

let currentFakeSessions = [];
let listCalls = 0;

class FakeAcpClient {
  constructor() {
    this.alive = true;
  }
  async start() {
    return { protocolVersion: 1 };
  }
  async listSessions() {
    listCalls++;
    return { sessions: currentFakeSessions };
  }
  stop() {}
}

let getMcodeSessionsForWorkspace;
let getMcodeSessionsCacheSync;
let getMcodeSessionsStaleSync;
let dropMcodeSessionFromCache;
let invalidateMcodeSessionsCache;

before(async (t) => {
  t.mock.module(absPath("../acp.mjs"), {
    namedExports: { McodeAcpClient: FakeAcpClient },
  });
  const mod = await import(absPath("lib/acp-client.js"));
  getMcodeSessionsForWorkspace = mod.getMcodeSessionsForWorkspace;
  getMcodeSessionsCacheSync = mod.getMcodeSessionsCacheSync;
  getMcodeSessionsStaleSync = mod.getMcodeSessionsStaleSync;
  dropMcodeSessionFromCache = mod.dropMcodeSessionFromCache;
  invalidateMcodeSessionsCache = mod.invalidateMcodeSessionsCache;
});

describe("mcodeSessionsCache — v1.0 防闪跌语义", () => {
  test("fetch 后 fresh 与 stale 同步命中 (同 ws); 其他 ws miss", async () => {
    currentFakeSessions = [
      { sessionId: "mvs_a", cwd: "C:\\w", title: "A" },
      { sessionId: "mvs_b", cwd: "C:\\w", title: "B" },
      { sessionId: "mvs_c", cwd: "D:\\other", title: "C" },
    ];
    const filtered = await getMcodeSessionsForWorkspace("C:\\w");
    assert.equal(filtered.length, 2, "按 cwd 过滤");
    assert.deepEqual(
      getMcodeSessionsCacheSync("C:\\w").map((s) => s.sessionId),
      ["mvs_a", "mvs_b"],
      "fresh cache hit",
    );
    assert.deepEqual(
      getMcodeSessionsStaleSync("C:\\w").map((s) => s.sessionId),
      ["mvs_a", "mvs_b"],
      "stale 同步命中 (无论 TTL)",
    );
    assert.equal(getMcodeSessionsCacheSync("D:\\other"), null, "fresh: 其他 ws miss");
    assert.equal(getMcodeSessionsStaleSync("D:\\other"), null, "stale: 其他 ws miss");
  });

  test("drop 只剔除该 sid — 删除会话后缓存仍可用, 不清空 (防闪跌核心)", async () => {
    dropMcodeSessionFromCache("mvs_a");
    assert.deepEqual(
      getMcodeSessionsCacheSync("C:\\w").map((s) => s.sessionId),
      ["mvs_b"],
      "fresh cache 剔除后仍非空 — 删除不产生空列表推送",
    );
    assert.deepEqual(
      getMcodeSessionsStaleSync("C:\\w").map((s) => s.sessionId),
      ["mvs_b"],
    );
  });

  test("invalidate 软失效: fresh miss 但 stale 仍供推送兜底", () => {
    invalidateMcodeSessionsCache();
    assert.equal(getMcodeSessionsCacheSync("C:\\w"), null, "fresh 失效");
    assert.deepEqual(
      getMcodeSessionsStaleSync("C:\\w").map((s) => s.sessionId),
      ["mvs_b"],
      "stale 保留 — 过期值好过空值",
    );
  });

  test("缓存未过期时重复读不触发新 list (TTL 命中, 0 spawn)", async () => {
    const before = listCalls;
    await getMcodeSessionsForWorkspace("C:\\w"); // invalidate 后重新拉一次
    const afterFetch = listCalls;
    assert.equal(afterFetch, before + 1, "TTL 过期后重新 fetch");
    await getMcodeSessionsForWorkspace("C:\\w");
    await getMcodeSessionsCacheSync("C:\\w");
    assert.equal(listCalls, afterFetch, "TTL 内重复读 0 次新 list");
  });
});
