// webui/test/sessions.test.js
// Unit tests for server/routes/sessions.js — handleSwitchSession
//
// Why this test exists: v0.5.bx-32 — handleSwitchSession must NOT
// write cs.lastUsedWorkspace. Wzdhehe's feedback: "点 c 区任意对话
// (不发消息),c 区就自动置顶了,我想的是发消息才置顶". Switching
// session is browsing, not sending, so lastUsedWorkspace is only
// written by handleSend.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { setupMocks, absPath, registerSessionsStore, getSessionsStore, registerAcpMock } from "./_setup.js";

let deleteMcodeSessionFromDb, SQLITE3_BIN;

// Helper: build a fake IncomingMessage that readJson() can consume
function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}
function fakeRes() {
  const res = {
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
  return res;
}

let handleSwitchSession, handleNewSession;
let handleDeleteSession, handleListSessions, handleAcpSessions, handleAcpSessionTitle;
let makeClientState, clients;
let initialSessions;

before(async (t) => {
  await setupMocks(t, {
    // Mock mavis-usage to avoid loading the real one (which would re-import
    // node:child_process in the test context — Node 24 mock.module +
    // builtin interplay can stall the import).
    mavis: {
      applyMavisUsageToCs: async () => {}, // no-op
    },
  });
  const sb = await import(absPath("lib/state-bus.js"));
  makeClientState = sb.makeClientState;
  clients = sb.clients;
  const mod = await import(absPath("routes/sessions.js"));
  handleSwitchSession = mod.handleSwitchSession;
  handleNewSession = mod.handleNewSession;
  handleDeleteSession = mod.handleDeleteSession;
  handleListSessions = mod.handleListSessions;
  handleAcpSessions = mod.handleAcpSessions;
  handleAcpSessionTitle = mod.handleAcpSessionTitle;
  // Load db.js for the new dryRun tests (Batch D, mcode-plugin-guide red-lines §1)
  const dbMod = await import(absPath("lib/db.js"));
  deleteMcodeSessionFromDb = dbMod.deleteMcodeSessionFromDb;
  // Load config.js for SQLITE3_BIN
  const cfgMod = await import(absPath("lib/config.js"));
  SQLITE3_BIN = cfgMod.SQLITE3_BIN;
});

beforeEach(() => {
  clients.clear();
  // Two pre-existing sessions on different workspaces
  initialSessions = [
    {
      id: "webui-A",
      title: "A on ws-A",
      workspace: "/ws-A",
      createdAt: 1,
      updatedAt: 1,
      chat: ["● hi from A"],
    },
    {
      id: "webui-B",
      title: "B on ws-B",
      workspace: "/ws-B",
      createdAt: 2,
      updatedAt: 2,
      chat: ["● hi from B"],
    },
  ];
  registerSessionsStore({ initial: initialSessions });
});

describe("handleSwitchSession — v0.5.bx-32 lastUsedWorkspace contract", () => {
  test("switching to a different workspace does NOT write lastUsedWorkspace", async () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    cs.lastUsedWorkspace = null; // initial state
    clients.set(cid, cs);

    const ctx = { cs, cid, pathname: "" };
    const res = fakeRes();
    await handleSwitchSession(fakeReq({ id: "webui-B" }), res, ctx);

    assert.equal(res._status, 200, "switch should succeed");
    // The cs is mutated, but lastUsedWorkspace must still be null
    assert.equal(
      cs.lastUsedWorkspace,
      null,
      "switching sessions must not write lastUsedWorkspace (v0.5.bx-32)",
    );
  });

  test("switching to the same workspace does NOT write lastUsedWorkspace", async () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    cs.lastUsedWorkspace = "previous-value"; // pretend user sent earlier
    clients.set(cid, cs);

    const ctx = { cs, cid, pathname: "" };
    const res = fakeRes();
    await handleSwitchSession(fakeReq({ id: "webui-A" }), res, ctx);

    assert.equal(res._status, 200);
    // lastUsedWorkspace unchanged — only handleSend should touch it
    assert.equal(
      cs.lastUsedWorkspace,
      "previous-value",
      "lastUsedWorkspace must not be touched by switch (v0.5.bx-32)",
    );
  });

  test("switch updates sessionId, mcodeSessionId, sessionTitle, chat", async () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    clients.set(cid, cs);

    const ctx = { cs, cid, pathname: "" };
    const res = fakeRes();
    await handleSwitchSession(fakeReq({ id: "webui-B" }), res, ctx);

    assert.equal(cs.sessionId, "webui-B");
    assert.equal(cs.sessionTitle, "B on ws-B");
    assert.deepEqual(cs.chat, ["● hi from B"]);
  });
});

describe("handleNewSession", () => {
  test("creates a new session entry on disk and assigns cs.sessionId", async () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-NEW", branch: null, tree: null };
    clients.set(cid, cs);

    const ctx = { cs, cid, pathname: "" };
    const res = fakeRes();
    await handleNewSession(fakeReq({}), res, ctx);
    assert.equal(res._status, 200);
    assert.ok(cs.sessionId, "should assign a new sessionId");
    assert.equal(cs.chat.length, 0);
  });
});

// ============================================================
// 批次 C 扩展: 错误路径 + 缺失的 handler 覆盖
// ============================================================

describe("handleSwitchSession — error paths", () => {
  test("returns 400 when id is missing", async () => {
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    const cid = "cid-1";
    clients.set(cid, cs);
    const res = fakeRes();
    await handleSwitchSession(fakeReq({}), res, { cs, cid, pathname: "" });
    assert.equal(res._status, 400);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.match(body.error, /id required/);
  });

  test("returns 400 when id is empty string", async () => {
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    const cid = "cid-1";
    clients.set(cid, cs);
    const res = fakeRes();
    await handleSwitchSession(fakeReq({ id: "   " }), res, { cs, cid, pathname: "" });
    assert.equal(res._status, 400);
  });

  test("returns 404 when id not found and not a valid mvs_xxx", async () => {
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    const cid = "cid-1";
    clients.set(cid, cs);
    const res = fakeRes();
    await handleSwitchSession(
      fakeReq({ id: "nonexistent-id" }),
      res,
      { cs, cid, pathname: "" },
    );
    assert.equal(res._status, 404);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.match(body.error, /session not found/);
  });

  test("creates a new webui entry when mvs_xxx id not in store", async () => {
    // mvs_xxx that doesn't exist in store, but the title-fetcher returns null
    // → default title "Mcode session"
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    const cid = "cid-1";
    clients.set(cid, cs);
    const res = fakeRes();
    // Mock getMcodeSessionTitle via the existing _acpMock override
    const { registerAcpMock } = await import("./_setup.js");
    registerAcpMock({ getMcodeSessionTitle: async () => null });
    await handleSwitchSession(
      fakeReq({ id: "mvs_deadbeef00000000000000000000aaaa" }),
      res,
      { cs, cid, pathname: "" },
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    // cs.mcodeSessionId should be set
    assert.equal(cs.mcodeSessionId, "mvs_deadbeef00000000000000000000aaaa");
  });

  test("mcodeSessionId hit: switches to that session (mcode sid priority)", async () => {
    // Add a session with mcodeSessionId set
    registerSessionsStore({
      initial: [
        ...initialSessions,
        {
          id: "webui-mvs",
          mcodeSessionId: "mvs_aaaa1111222233334444555566667777",
          title: "Mcode-target",
          workspace: "/ws-A",
          createdAt: 3,
          updatedAt: 3,
          chat: ["● from mcode sid"],
        },
      ],
    });
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    const cid = "cid-1";
    clients.set(cid, cs);
    const res = fakeRes();
    await handleSwitchSession(
      fakeReq({ id: "mvs_aaaa1111222233334444555566667777" }),
      res,
      { cs, cid, pathname: "" },
    );
    assert.equal(res._status, 200);
    assert.equal(cs.sessionId, "webui-mvs");
    assert.equal(cs.mcodeSessionId, "mvs_aaaa1111222233334444555566667777");
    assert.equal(cs.sessionTitle, "Mcode-target");
  });
});

describe("handleDeleteSession", () => {
  test("deletes a webui session by id and returns ok", async () => {
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    const cid = "cid-1";
    clients.set(cid, cs);
    const res = fakeRes();
    const ctx = { cs, cid, pathname: "/api/sessions/webui-A" };
    await handleDeleteSession(fakeReq({}), res, ctx);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.deleted, "webui-A");
  });

  test("deletes a mcode session by mcodeSessionId", async () => {
    registerSessionsStore({
      initial: [
        ...initialSessions,
        {
          id: "webui-mvs-del",
          mcodeSessionId: "mvs_bbbb1111222233334444555566667777",
          title: "Mcode-del",
          workspace: "/ws-A",
          createdAt: 3,
          updatedAt: 3,
          chat: [],
        },
      ],
    });
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    const cid = "cid-1";
    clients.set(cid, cs);
    const res = fakeRes();
    const ctx = { cs, cid, pathname: "/api/sessions/mvs_bbbb1111222233334444555566667777" };
    await handleDeleteSession(fakeReq({}), res, ctx);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.matchKind, "mcodeSessionId");
  });

  test("returns 404 when id not found and not a mvs_xxx", async () => {
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    const cid = "cid-1";
    clients.set(cid, cs);
    const res = fakeRes();
    const ctx = { cs, cid, pathname: "/api/sessions/nonexistent" };
    await handleDeleteSession(fakeReq({}), res, ctx);
    assert.equal(res._status, 404);
  });

  test("resets cs when the deleted session is the current one", async () => {
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    cs.sessionId = "webui-A"; // current is the one we'll delete
    cs.mcodeSessionId = null;
    cs.sessionTitle = "A on ws-A";
    cs.chat = ["existing"];
    const cid = "cid-1";
    clients.set(cid, cs);
    const res = fakeRes();
    const ctx = { cs, cid, pathname: "/api/sessions/webui-A" };
    await handleDeleteSession(fakeReq({}), res, ctx);
    assert.equal(res._status, 200);
    // cs should be reset
    assert.equal(cs.sessionId, null);
    assert.equal(cs.sessionTitle, "Untitled");
    assert.deepEqual(cs.chat, []);
  });

  test("?dryRun=true returns preview without deleting the webui entry", async () => {
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    // Pretend the target session IS the current one, so we can verify
    // dryRun does NOT reset it.
    cs.sessionId = "webui-A";
    cs.sessionTitle = "A on ws-A";
    cs.chat = ["existing"];
    const cid = "cid-1";
    clients.set(cid, cs);
    const before = getSessionsStore().length;
    const res = fakeRes();
    const ctx = { cs, cid, pathname: "/api/sessions/webui-A" };
    // Pass ?dryRun=true in req.url
    const req = { url: "/api/sessions/webui-A?dryRun=true" };
    await handleDeleteSession(req, res, ctx);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.dryRun, true);
    // webui entry should NOT be deleted
    assert.equal(getSessionsStore().length, before, "session store should be unchanged");
    // cs should NOT be reset (preserved as the current session)
    assert.equal(cs.sessionId, "webui-A", "cs.sessionId should be preserved in dry-run");
    assert.equal(cs.sessionTitle, "A on ws-A");
    assert.deepEqual(cs.chat, ["existing"]);
  });
});

describe("handleDeleteSession — dry-run (db-level preview)", () => {
  test("deleteMcodeSessionFromDb with dryRun=true returns rows per table without modifying", async () => {
    // Use a temp sqlite db, set MCODE_RUNTIME_DB to it, populate rows,
    // call dryRun, then verify rows are still there.
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "webui-dryrun-"));
    const dbPath = join(dir, "runtime-state.sqlite");
    // Create tables with one row for our sid
    const { spawnSync } = await import("node:child_process");
    const sql = `
      CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE local_runtime_session_assets (session_id TEXT);
      INSERT INTO local_runtime_sessions (session_id, data) VALUES ('mvs_aaaa000000000000000000000000bbbb', 'x');
      INSERT INTO local_runtime_session_assets (session_id) VALUES ('mvs_aaaa000000000000000000000000bbbb');
    `;
    const r = spawnSync(SQLITE3_BIN, [dbPath, sql], { encoding: "utf8" });
    assert.equal(r.status, 0, `sqlite3 create failed: ${r.stderr}`);

    const SID = "mvs_aaaa000000000000000000000000bbbb";
    const dry = deleteMcodeSessionFromDb(SID, { MCODE_RUNTIME_DB: dbPath, dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.ok(Array.isArray(dry.log));
    assert.ok(dry.totalRows >= 2, `should count >= 2 rows, got ${dry.totalRows}`);

    // Verify rows are STILL there
    const check = spawnSync(
      SQLITE3_BIN,
      [dbPath, `SELECT COUNT(*) FROM local_runtime_sessions WHERE session_id='${SID}'`],
      { encoding: "utf8" },
    );
    assert.equal(check.stdout.trim(), "1", "row should NOT be deleted in dry-run");
  });

  test("deleteMcodeSessionFromDb without dryRun actually deletes (sanity)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "webui-real-del-"));
    const dbPath = join(dir, "runtime-state.sqlite");
    const { spawnSync } = await import("node:child_process");
    spawnSync(
      SQLITE3_BIN,
      [dbPath, `CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, data TEXT); INSERT INTO local_runtime_sessions (session_id, data) VALUES ('mvs_real00000000000000000000bbbb', 'x');`],
      { encoding: "utf8" },
    );
    const SID = "mvs_bbbb000000000000000000000000cccc";
    const r = deleteMcodeSessionFromDb(SID, { MCODE_RUNTIME_DB: dbPath });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, undefined, "default path should NOT have dryRun flag");
    const check = spawnSync(
      SQLITE3_BIN,
      [dbPath, `SELECT COUNT(*) FROM local_runtime_sessions WHERE session_id='${SID}'`],
      { encoding: "utf8" },
    );
    assert.equal(check.stdout.trim(), "0", "row SHOULD be deleted in normal path");
  });
});

describe("handleListSessions", () => {
  test("returns ok + sessions array", () => {
    const res = fakeRes();
    handleListSessions(null, res);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.sessions));
    assert.equal(body.sessions.length, 2);
  });
});

describe("handleAcpSessions", () => {
  test("returns cwd + sessions for the current workspace", async () => {
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    const req = { url: "/api/acp-sessions?cwd=/ws-A" };
    const res = fakeRes();
    await handleAcpSessions(req, res, { cs, cid: "cid-1", pathname: "/api/acp-sessions" });
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.cwd, "/ws-A");
    assert.ok(Array.isArray(body.sessions));
  });

  test("falls back to cs.workspace.dir when cwd query param is missing", async () => {
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-from-cs", branch: null, tree: null };
    const req = { url: "/api/acp-sessions" };
    const res = fakeRes();
    await handleAcpSessions(req, res, { cs, cid: "cid-1", pathname: "/api/acp-sessions" });
    const body = JSON.parse(res._body);
    assert.equal(body.cwd, "/ws-from-cs");
  });
});

describe("handleAcpSessionTitle", () => {
  test("returns 400 when sessionId query param is missing", async () => {
    const req = { url: "/api/acp-session-title" };
    const res = fakeRes();
    await handleAcpSessionTitle(req, res, {});
    assert.equal(res._status, 400);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.match(body.error, /sessionId required/);
  });

  test("returns ok + title when sessionId is provided", async () => {
    const { registerAcpMock } = await import("./_setup.js");
    registerAcpMock({ getMcodeSessionTitle: async () => "My Title" });
    const req = { url: "/api/acp-session-title?sessionId=mvs_aaa" };
    const res = fakeRes();
    await handleAcpSessionTitle(req, res, {});
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.title, "My Title");
  });
});

// ============================================================
// v1.0: 删除防复活 (killMcodeSessionResurrection) — 常驻 acp 子进程内存里
// 持有 session 且会回写 db, 真删前必须先杀子进程 + 从推送缓存剔除 sid。
// 这里断言路由正确调用了这两步, 以及 dryRun 不触发。
// ============================================================
describe("handleDeleteSession — v1.0 anti-resurrection", () => {
  const MVS_SID = "mvs_aaaa1111222233334444555566667777";

  function trackAntiResurrection() {
    const calls = { shutdown: 0, drop: [] };
    registerAcpMock({
      shutdownMcodeAcpSingleton: () => {
        calls.shutdown++;
      },
      dropMcodeSessionFromCache: (sid) => {
        calls.drop.push(sid);
      },
    });
    return calls;
  }

  test("real delete with mcodeSessionId kills acp singleton + drops sid from cache", async () => {
    const calls = trackAntiResurrection();
    registerSessionsStore({
      initial: [
        ...initialSessions,
        {
          id: "webui-ar",
          mcodeSessionId: MVS_SID,
          title: "AR target",
          workspace: "/ws-A",
          createdAt: 9,
          updatedAt: 9,
          chat: [],
        },
      ],
    });
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    const cid = "cid-1";
    clients.set(cid, cs);
    const res = fakeRes();
    const ctx = { cs, cid, pathname: "/api/sessions/" + MVS_SID };
    await handleDeleteSession(fakeReq({}), res, ctx);
    assert.equal(res._status, 200);
    assert.equal(calls.shutdown, 1, "singleton must be killed exactly once before db delete");
    assert.deepEqual(calls.drop, [MVS_SID], "deleted sid must be dropped from push cache");
  });

  test("dryRun does NOT kill singleton or drop cache (readonly preview)", async () => {
    const calls = trackAntiResurrection();
    registerSessionsStore({
      initial: [
        ...initialSessions,
        {
          id: "webui-ar2",
          mcodeSessionId: MVS_SID,
          title: "AR dry",
          workspace: "/ws-A",
          createdAt: 9,
          updatedAt: 9,
          chat: [],
        },
      ],
    });
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    const cid = "cid-1";
    clients.set(cid, cs);
    const res = fakeRes();
    const req = { url: "/api/sessions/" + MVS_SID + "?dryRun=true" };
    const ctx = { cs, cid, pathname: "/api/sessions/" + MVS_SID };
    await handleDeleteSession(req, res, ctx);
    assert.equal(res._status, 200);
    assert.equal(JSON.parse(res._body).dryRun, true);
    assert.equal(calls.shutdown, 0, "dryRun must not kill the singleton");
    assert.equal(calls.drop.length, 0, "dryRun must not touch the push cache");
  });

  test("resets EVERY client referencing the deleted sid (multi-tab)", async () => {
    trackAntiResurrection();
    registerSessionsStore({
      initial: [
        ...initialSessions,
        {
          id: "webui-mc",
          mcodeSessionId: MVS_SID,
          title: "MC target",
          workspace: "/ws-A",
          createdAt: 9,
          updatedAt: 9,
          chat: [],
        },
      ],
    });
    // tab-1: 当前会话就是目标 (by sessionId)
    const cs1 = makeClientState();
    cs1.sessionId = "webui-mc";
    cs1.mcodeSessionId = MVS_SID;
    cs1.chat = ["x"];
    clients.set("tab-1", cs1);
    // tab-2: 另一个 client 挂着同一个 mcode sid
    const cs2 = makeClientState();
    cs2.mcodeSessionId = MVS_SID;
    cs2.chat = ["y"];
    clients.set("tab-2", cs2);
    // tab-3: 无关 client, 不应被动
    const cs3 = makeClientState();
    cs3.sessionId = "webui-B";
    cs3.chat = ["keep"];
    clients.set("tab-3", cs3);

    const res = fakeRes();
    const ctx = { cs: cs1, cid: "tab-1", pathname: "/api/sessions/" + MVS_SID };
    await handleDeleteSession(fakeReq({}), res, ctx);
    assert.equal(res._status, 200);
    assert.equal(cs1.sessionId, null, "tab-1 reset");
    assert.equal(cs1.mcodeSessionId, null);
    assert.deepEqual(cs1.chat, []);
    assert.equal(cs2.mcodeSessionId, null, "tab-2 (other client, same sid) reset");
    assert.deepEqual(cs2.chat, []);
    assert.equal(cs3.sessionId, "webui-B", "unrelated client untouched");
    assert.deepEqual(cs3.chat, ["keep"]);
  });
});
