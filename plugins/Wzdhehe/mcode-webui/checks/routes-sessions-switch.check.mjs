// webui/checks/routes-sessions-switch.check.mjs
// Mocked tests for POST /api/sessions/switch (handleSwitchSession) —
// v2 (2026-09-20 webui-manual-audit) fixes:
//
//   (a) title fast path — an mvs_ switch resolves the title from the
//       in-memory walked-session cache FIRST and NEVER awaits
//       getMcodeSessionTitle on a cache hit (that fallback boots the ACP
//       child; ~2.17s measured with a broken mcode binary, and it used to
//       degrade every first switch to the "Mcode session" placeholder).
//       Placeholder wrappers ("Mcode session") get their title repaired
//       from the cache too — also without spawning ACP.
//   (b) transcript backfill — switching to an mvs_ session with an empty
//       webui chat loads the mcode transcript from the runtime DB and maps
//       it into the webui chat-line grammar. The lines must round-trip
//       through export.js's _parseChatLines (the canonical server-side
//       parser) — verified end-to-end by exporting the backfilled session.
//   (c) transcript failure never breaks switching — a broken better-sqlite3
//       yields chat: [] and a 200.
//
// Test strategy: setupMocks for the webui module surface; lib/db.js is
// mocked with a FAKE better-sqlite3 class keyed by SQL string — legacy
// probe SQLs always throw (mirroring the real DB's schema drift), the v2
// data_json probe returns fixture rows. That same property doubles as the
// "export.js behavior unchanged" guard: export's legacy-only probe set
// still reports mcode_unavailable against this fake, exactly as it does
// against the real DB today.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setupMocks,
  absPath,
  registerSessionsStore,
  getSessionsStore,
  registerAcpMock,
  withDecisions,
} from "../test/_setup.js";

// The v2 probe SQL from lib/transcript.js (keyed lookup in the fake Db).
const V2_SQL =
  "SELECT role, data_json FROM local_runtime_message_rows WHERE session_id = ? ORDER BY created_at_ms ASC, rowid ASC";

// Fake better-sqlite3: prepare() throws for any SQL not in rowsBySql (like
// a real prepare on a missing column), serves sid-filtered rows otherwise.
function makeFakeDb({ rowsBySql = {}, constructThrows = false } = {}) {
  return class FakeDb {
    constructor(path, opts) {
      if (constructThrows) throw new Error("fake better-sqlite3: boom");
      this.path = path;
      this.opts = opts;
    }
    prepare(sql) {
      const bySid = rowsBySql[sql];
      if (!bySid) throw new Error(`fake db: no such column (${sql.slice(0, 52)}…)`);
      return { all: (sid) => (bySid[sid] || []).slice() };
    }
    close() {}
  };
}

const MVS_T = "mvs_aaaa1111222233334444555566667777"; // title fast-path sid
const MVS_R = "mvs_bbbb1111222233334444555566668888"; // round-trip / backfill sid
const MVS_F = "mvs_cccc1111222233334444555566669999"; // failure sid

let handleSwitchSession;
let handleExport;
let makeClientState;
let clients;

// Mutable per-test knobs (the db.js mock reads these at call time).
let _fakeDbOpts = {};
let _acpTitleCalls = 0;

// Isolate the audit stream — switch + export append hash-chain events that
// must never land in the operator's real ~/.mcode-webui/events.ndjson.
// v2 (2026-09-20 fork-preview fix): ALSO pin MCODE_RUNTIME_DB to a scratch
//   file this check CREATES. readMcodeTranscript gates on existsSync(dbPath)
//   BEFORE better-sqlite3 is ever consulted (reason "mcode_db_not_found"),
//   and sessions.js passes dbPath from config.js's MCODE_RUNTIME_DB — which
//   defaults to join(homedir(), ".minimax", "v2", "sqlite", "runtime-state
//   .sqlite"). A windows-latest CI runner has no such file, so the v2 probe
//   never ran and every backfill test saw [] — the suite was green locally
//   ONLY because the dev machine happens to have a real runtime DB there.
//   The placeholder's CONTENT is irrelevant (better-sqlite3 is module-mocked
//   below; the fake never reads the file) — existsSync just needs it to
//   exist. Must be set BEFORE the first SUT import: config.js evaluates
//   MCODE_RUNTIME_DB at module-load time.
let _tmpEventsDir;
let _tmpDbDir;
before(async (t) => {
  _tmpEventsDir = mkdtempSync(join(tmpdir(), "webui-switch-test-events-"));
  process.env.MCODE_WEBUI_EVENTS_PATH = join(_tmpEventsDir, "events.ndjson");
  _tmpDbDir = mkdtempSync(join(tmpdir(), "webui-switch-test-db-"));
  process.env.MCODE_RUNTIME_DB = join(_tmpDbDir, "runtime-state.sqlite");
  writeFileSync(process.env.MCODE_RUNTIME_DB, "");

  await setupMocks(t, {
    mavis: { applyMavisUsageToCs: async () => {} }, // no spawn in switch path
  });
  // lib/db.js fake: legacy probes always miss, v2 probe serves _fakeDbOpts.
  // sessions.js (deleteMcodeSessionFromDb) + transcript.js
  // (getMcodeBetterSqlite3) both import from here — one mock covers both.
  t.mock.module(absPath("lib/db.js"), {
    namedExports: {
      getMcodeBetterSqlite3: () => makeFakeDb(_fakeDbOpts),
      deleteMcodeSessionFromDb: () => ({ ok: false, reason: "test_mock" }),
      _getBetterSqlite3Candidates: () => [],
      MCODE_SESSION_DELETE_TABLES: [],
    },
  });
  const sb = await import(absPath("lib/state-bus.js"));
  makeClientState = sb.makeClientState;
  clients = sb.clients;
  const sessionsMod = await import(absPath("routes/sessions.js"));
  handleSwitchSession = sessionsMod.handleSwitchSession;
  const exportMod = await import(absPath("routes/export.js"));
  handleExport = exportMod.handleExport;
});

after(() => {
  delete process.env.MCODE_WEBUI_EVENTS_PATH;
  delete process.env.MCODE_RUNTIME_DB;
  if (_tmpEventsDir) {
    try { rmSync(_tmpEventsDir, { recursive: true, force: true }); } catch {}
  }
  if (_tmpDbDir) {
    try { rmSync(_tmpDbDir, { recursive: true, force: true }); } catch {}
  }
});

function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}
function fakeGetReq(url) {
  return { url, method: "GET", headers: {} };
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

function newCs(ws = "/ws-A") {
  const cs = makeClientState();
  cs.workspace = { dir: ws, branch: null, tree: null };
  return cs;
}

async function doSwitch(id, cs, cid = "cid-1") {
  const res = fakeRes();
  await handleSwitchSession(fakeReq({ id }), res, { cs, cid, pathname: "" });
  return { res, body: res._body ? JSON.parse(res._body) : null };
}

beforeEach(() => {
  clients.clear();
  _fakeDbOpts = {};
  _acpTitleCalls = 0;
  registerAcpMock({
    getMcodeSessionsCacheSync: () => null,
    getMcodeSessionsStaleSync: () => null,
    getMcodeSessionTitle: async () => {
      _acpTitleCalls++;
      return null;
    },
  });
  registerSessionsStore({ initial: [] });
});

// ============================================================
// (a) title fast path
// ============================================================
describe("handleSwitchSession — v2 title fast path", () => {
  test("cache hit: real title used, getMcodeSessionTitle NEVER awaited", async () => {
    registerAcpMock({
      getMcodeSessionsCacheSync: () => [{ sessionId: MVS_T, title: "Cached real title" }],
      getMcodeSessionTitle: async () => {
        _acpTitleCalls++;
        return "ACP TITLE";
      },
    });
    const cs = newCs();
    const { res, body } = await doSwitch(MVS_T, cs);
    assert.equal(res._status, 200);
    assert.equal(body.session.title, "Cached real title");
    assert.equal(cs.sessionTitle, "Cached real title");
    assert.equal(_acpTitleCalls, 0, "cache hit must never spawn/await the ACP title path");
  });

  test("stale cache hit also satisfies the fast path (TTL-expired, same ws)", async () => {
    registerAcpMock({
      getMcodeSessionsStaleSync: () => [{ sessionId: MVS_T, title: "Stale real title" }],
      getMcodeSessionTitle: async () => {
        _acpTitleCalls++;
        return "ACP TITLE";
      },
    });
    const cs = newCs();
    const { body } = await doSwitch(MVS_T, cs);
    assert.equal(body.session.title, "Stale real title");
    assert.equal(_acpTitleCalls, 0);
  });

  test("cache miss falls back to getMcodeSessionTitle (original behavior kept)", async () => {
    registerAcpMock({
      getMcodeSessionTitle: async () => {
        _acpTitleCalls++;
        return "From ACP";
      },
    });
    const cs = newCs();
    const { body } = await doSwitch(MVS_T, cs);
    assert.equal(body.session.title, "From ACP");
    assert.equal(_acpTitleCalls, 1);
  });

  test("total miss keeps the 'Mcode session' placeholder", async () => {
    const cs = newCs();
    const { body } = await doSwitch(MVS_T, cs);
    assert.equal(body.session.title, "Mcode session");
    assert.equal(_acpTitleCalls, 1);
  });

  test("placeholder wrapper gets its title repaired from cache, no ACP boot", async () => {
    registerSessionsStore({
      initial: [
        {
          id: "webui-ph",
          mcodeSessionId: MVS_T,
          title: "Mcode session", // placeholder created by the broken-title era
          workspace: "/ws-A",
          createdAt: 1,
          updatedAt: 1,
          chat: ["● existing history"],
        },
      ],
    });
    registerAcpMock({
      getMcodeSessionsCacheSync: () => [{ sessionId: MVS_T, title: "Repaired title" }],
      getMcodeSessionTitle: async () => {
        _acpTitleCalls++;
        return "ACP TITLE";
      },
    });
    const cs = newCs();
    const { body } = await doSwitch(MVS_T, cs);
    assert.equal(body.session.title, "Repaired title");
    assert.equal(cs.sessionTitle, "Repaired title");
    assert.equal(_acpTitleCalls, 0, "existing wrapper refresh is cache-only — never spawns ACP");
    // persisted wrapper repaired too
    const saved = getSessionsStore().find((s) => s.id === "webui-ph");
    assert.equal(saved.title, "Repaired title");
    assert.ok(saved.updatedAt > 1, "updatedAt bumped on repair");
    // non-empty chat untouched by the backfill path
    assert.deepEqual(saved.chat, ["● existing history"]);
  });
});

// ============================================================
// (b) transcript backfill + parseChatLines round-trip
// ============================================================
describe("handleSwitchSession — v2 transcript backfill", () => {
  function seedTranscript(sid) {
    _fakeDbOpts = {
      rowsBySql: {
        [V2_SQL]: {
          [sid]: [
            { role: "user", data_json: JSON.stringify({ role: "user", msg_type: 1, msg_content: "调研市面上 AI 小说工具" }) },
            {
              role: "assistant",
              data_json: JSON.stringify({
                role: "assistant",
                msg_type: 2,
                msg_content: "我先看看",
                thinking_content: "先搜索",
                tool_calls: [
                  {
                    tool_name: "bash",
                    tool_call_id: "c1",
                    tool_call_status: 2,
                    tool_call_args: '{"command":"ls"}',
                    tool_call_result_data: '{"content":[{"type":"text","text":"file1\\nfile2"}]}',
                  },
                ],
              }),
            },
            { role: "assistant", data_json: JSON.stringify({ role: "assistant", msg_content: "最终结论在这里" }) },
          ],
        },
      },
    };
  }

  test("mvs_ switch with empty chat backfills mapped history into cs.chat + response + store", async () => {
    seedTranscript(MVS_R);
    const cs = newCs();
    const { res, body } = await doSwitch(MVS_R, cs);
    assert.equal(res._status, 200);
    const expected = [
      "› 调研市面上 AI 小说工具",
      "▲ 先搜索",
      "● 我先看看",
      "→ bash  {\"command\":\"ls\"}",
      "  [completed]",
      "  file1",
      "  file2",
      "● 最终结论在这里",
    ];
    assert.deepEqual(cs.chat, expected, "cs.chat carries the mapped transcript");
    assert.deepEqual(body.session.chat, expected, "response session.chat carries it too");
    // persisted via saveSessions with updatedAt bumped
    const saved = getSessionsStore()[0];
    assert.equal(saved.mcodeSessionId, MVS_R);
    assert.deepEqual(saved.chat, expected);
    assert.ok(saved.updatedAt >= saved.createdAt, "updatedAt bumped on backfill");
  });

  test("existing empty-chat wrapper is backfilled too (webuiId match path)", async () => {
    seedTranscript(MVS_R);
    registerSessionsStore({
      initial: [
        {
          id: "webui-empty",
          mcodeSessionId: MVS_R,
          title: "Has mcode sid, no chat",
          workspace: "/ws-A",
          createdAt: 1,
          updatedAt: 1,
          chat: [],
        },
      ],
    });
    const cs = newCs();
    const { body } = await doSwitch("webui-empty", cs);
    assert.equal(body.session.id, "webui-empty");
    assert.ok(cs.chat.length >= 6, `backfilled lines, got ${cs.chat.length}`);
    assert.ok(cs.chat[0].startsWith("› "), "first line is a user line");
    assert.ok(getSessionsStore()[0].chat.length >= 6, "wrapper persisted with chat");
  });

  test("NON-empty chat is never overwritten by the backfill", async () => {
    seedTranscript(MVS_R);
    registerSessionsStore({
      initial: [
        {
          id: "webui-keep",
          mcodeSessionId: MVS_R,
          title: "Keep my chat",
          workspace: "/ws-A",
          createdAt: 1,
          updatedAt: 1,
          chat: ["● mine already"],
        },
      ],
    });
    const cs = newCs();
    await doSwitch("webui-keep", cs);
    assert.deepEqual(cs.chat, ["● mine already"]);
  });

  test("(b) round-trip: backfilled lines re-parse via export.js#_parseChatLines", async () => {
    // The canonical server-side parser lives in handleExport — export the
    // backfilled session as JSON and assert the structured messages match
    // the source transcript. With this fake DB the legacy probes throw, so
    // export reports mcode_unavailable and the messages are PURELY the
    // parsed webui lines — the exact round-trip under test.
    seedTranscript(MVS_R);
    const cs = newCs();
    const { body } = await doSwitch(MVS_R, cs);
    const wrapperId = body.session.id;

    const res2 = fakeRes();
    await withDecisions(
      () =>
        handleExport(
          fakeGetReq(`/api/sessions/${wrapperId}/export?format=json`),
          res2,
          { cid: "cid-1", pathname: `/api/sessions/${wrapperId}/export` },
        ),
      { approve: true },
    );
    assert.equal(res2._status, 200, `export failed: ${res2._body}`);
    const exported = JSON.parse(res2._body);
    assert.equal(exported.ok, true);
    assert.equal(exported._meta.mcode_unavailable, true, "legacy-only export probes still miss (behavior unchanged)");

    const roles = exported.messages.map((m) => m.role);
    assert.deepEqual(roles, ["user", "thinking", "assistant", "tool", "assistant"]);
    // user round-trips with the collapsed text
    assert.equal(exported.messages[0].content, "调研市面上 AI 小说工具");
    // thinking round-trips
    assert.equal(exported.messages[1].content, "先搜索");
    // first assistant turn
    assert.equal(exported.messages[2].content, "我先看看");
    // tool call round-trips name + arguments + status + output
    const tool = exported.messages[3];
    assert.equal(tool.role, "tool");
    assert.equal(tool.name, "bash");
    assert.equal(tool.arguments, '{"command":"ls"}');
    assert.equal(tool.status, "completed");
    assert.equal(tool.output, "file1\nfile2");
    // final assistant turn
    assert.equal(exported.messages[4].content, "最终结论在这里");
  });
});

// ============================================================
// (c) transcript failure never breaks switching
// ============================================================
describe("handleSwitchSession — v2 transcript failure containment", () => {
  test("better-sqlite3 constructor throws → switch still 200 with empty chat", async () => {
    _fakeDbOpts = { constructThrows: true };
    const cs = newCs();
    const { res, body } = await doSwitch(MVS_F, cs);
    assert.equal(res._status, 200, "switch MUST succeed when the transcript load fails");
    assert.equal(body.ok, true);
    assert.deepEqual(body.session.chat, []);
    assert.deepEqual(cs.chat, []);
    assert.equal(cs.mcodeSessionId, MVS_F, "mcode binding still applied");
  });

  test("no matching table (schema drift) → 200, empty chat, wrapper still created", async () => {
    _fakeDbOpts = {}; // every prepare throws → no_matching_table
    const cs = newCs();
    const { res, body } = await doSwitch(MVS_F, cs);
    assert.equal(res._status, 200);
    assert.deepEqual(body.session.chat, []);
    assert.equal(getSessionsStore().length, 1, "wrapper persisted even without transcript");
    assert.deepEqual(getSessionsStore()[0].chat, []);
  });
});
