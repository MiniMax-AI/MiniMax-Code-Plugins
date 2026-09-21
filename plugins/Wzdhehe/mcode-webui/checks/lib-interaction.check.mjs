// webui/test/lib-interaction.test.js
// Unit tests for server/lib/interaction/* — the 4 modules split out
// of slash.js per BORROW-dsh-deepseek-harness-2026-08-28 § 3:
//   - commands.js          (matchSlash + handleLocalSlash + handleCmdCommand)
//   - permission-presets.js
//   - tool-ask-user.js
//   - user-questions.js
//
// Why this test exists: the legacy test (lib-slash.test.js) only
// covered matchSlash via the _setup.js mock. With the split, each
// module owns a specific concern and gets its own test surface.
//
// MOCKING STRATEGY: we set up our own t.mock.module registrations
// (not setupMocks) so we can add ensureMcodeCommands to the acp-client
// mock — _setup.js's default namedExports list omits it. See also
// test/lib-acp-cache.test.js which follows the same pattern.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(TEST_DIR, "..", "server");
const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href;

// In-memory sessions store — mirrors the _setup.js mock for sessions.
let _sessionsStore = [];
function _save(arr) { _sessionsStore = [...arr]; }
function _load() { return [..._sessionsStore]; }
function _reset() {
  cs._persistedToId = undefined;
}

let cs;

let commands, presets, askUser, questions;
before(async (t) => {
  // Mock lib/sessions.js — only the bits interaction/commands.js uses.
  t.mock.module(absPath("lib/sessions.js"), {
    namedExports: {
      loadSessions: () => _load(),
      saveSessions: (arr) => _save(arr),
      resetContext: (c) => {
        if (c && c.context) {
          c.context.tokens = 0;
          c.context.used = 0;
          c.context.percent = 0;
        }
      },
      persistCurrentChat: (c) => { cs._persistedToId = c && c.sessionId; },
      streamUpdateLine: (chat, prefix, text) => {
        if (Array.isArray(chat)) chat.push(prefix + " " + text);
        return text;
      },
      cleanupEmptyDefaultSessions: () => {},
    },
  });

  // Mock lib/acp-client.js — include ensureMcodeCommands (the bit
  // _setup.js's default namedExports omits but commands.js needs).
  t.mock.module(absPath("lib/acp-client.js"), {
    namedExports: {
      ensureMcodeCommands: async () => ({
        mcode: [{ name: "exec", description: "exec" }],
        webui: [
          { name: "new", desc: "新建会话" },
          { name: "clear", desc: "清空当前对话" },
          { name: "status", desc: "查看当前状态" },
          { name: "sessions", desc: "查看最近会话" },
          { name: "help", desc: "可用命令" },
          { name: "usage", desc: "查询用量" },
          { name: "stop", desc: "停止当前任务" },
        ],
        fetchedAt: 1,
        source: "test-stub",
      }),
      getCachedMcodeCommands: () => ({
        mcode: [],
        webui: [],
        fetchedAt: 0,
        source: "none",
      }),
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => [],
      getMcodeSessionsStaleSync: () => null,
      getMcodeSessionTitle: async () => null,
      deleteMcodeSessionFromDb: () => ({ ok: true }),
      getMcodeAcpClient: async () => null,
      listAllMcodeSessions: async () => [],
      getMcodeServerInfo: () => null,
      invalidateMcodeSessionsCache: () => {},
      shutdownMcodeAcpSingleton: () => {},
      dropMcodeSessionFromCache: () => {},
    },
  });

  // Mock lib/usage.js so /usage slash path doesn't try the network.
  t.mock.module(absPath("lib/usage.js"), {
    namedExports: {
      runUsageQuery: async () => ({ ok: true }),
      parseTokenPlanResponse: () => ({ ok: true }),
    },
  });

  // Mock lib/config.js so state-bus's IIFE imports don't fail.
  t.mock.module(absPath("lib/config.js"), {
    namedExports: {
      MCODE_ROOT: "/tmp", MCODE_CMD: "mcode", PORT: 8080, HOST: "127.0.0.1",
      TOKEN: "", DEFAULT_MODEL: "minimax_api/MiniMax-M3",
      DEFAULT_TIMEOUT: 0, DEFAULT_MAX_STEPS: 0, MAX_CONCURRENT: 4,
      UPLOAD_DIR: "/tmp", SESSIONS_DB: "/tmp/.webui-sessions.json",
      MCODE_RUNTIME_DB: "/tmp", MAVIS_DATA_DIR: "/tmp",
      MAVIS_DB_PATH: "/tmp/db", SQLITE3_BIN: "sqlite3",
      DEFAULT_WORKSPACE: "/tmp",
      getPlatformFallbackPaths: () => ({}),
      detectSqlite3Bin: () => "sqlite3",
      detectTuiCwd: () => "/tmp",
      installGlobalErrorHandlers: () => {},
    },
  });

  // Mock lib/settings.js — state-bus.js reads these.
  t.mock.module(absPath("lib/settings.js"), {
    namedExports: {
      getLanBroadcast: () => false,
      getReadOnly: () => false,
      getTokenEnabled: () => true,
      getCurrentToken: () => "",
      getTokenRotatedAt: () => 0,
      getTokenAcknowledged: () => false,
      getAllowedInterfaces: () => [],
      getQuotaEnabled: () => false,
      getTokenPlanApiKey: () => "",
      getTokenPlanApiKeySource: () => "",
      getTokenPlanApiKeyFilePath: () => "",
      maskTokenPlanKey: () => "",
    },
  });

  commands = await import(absPath("lib/interaction/commands.js"));
  presets = await import(absPath("lib/interaction/permission-presets.js"));
  askUser = await import(absPath("lib/interaction/tool-ask-user.js"));
  questions = await import(absPath("lib/interaction/user-questions.js"));
});

function fakeCs(modelName = "minimax_api/MiniMax-M3") {
  return {
    model: { name: modelName, thinking: "On", ctx: "512k" },
    permissions: "Full access",
    workspace: { dir: "/tmp", branch: null, tree: null },
    goal: { active: false, text: null, status: null, duration: null },
    chat: [],
    sessionTitle: "Untitled",
    sessionId: null,
    mcodeSessionId: null,
    usage: { sessionInput: 0, sessionOutput: 0, sessionTotal: 0 },
    context: {},
    running: { active: false },
  };
}

beforeEach(() => {
  _sessionsStore = [];
  cs = fakeCs();
});

// ---------------------------------------------------------------------
// commands.js — matchSlash
// ---------------------------------------------------------------------
describe("commands.matchSlash — pure parser", () => {
  test("null for non-slash input", () => {
    assert.equal(commands.matchSlash("hello world"), null);
  });
  test("parses simple /cmd", () => {
    const r = commands.matchSlash("/clear");
    assert.deepEqual(r, { cmd: "clear", rest: "" });
  });
  test("parses /goal with spaces in rest", () => {
    const r = commands.matchSlash("/goal write a poem");
    assert.deepEqual(r, { cmd: "goal", rest: "write a poem" });
  });
  test("rejects /1 (must start with letter)", () => {
    assert.equal(commands.matchSlash("/1invalid"), null);
  });
});

// ---------------------------------------------------------------------
// commands.js — handleLocalSlash (text-typed path)
// ---------------------------------------------------------------------
describe("commands.handleLocalSlash — text-typed slash", () => {
  test("non-slash input falls through to mcode", async () => {
    const r = await commands.handleLocalSlash("plain message", cs, "cid-1");
    // handleLocalSlash returns bare `false` (not an object) for non-slash
    // input — caller treats it as falsy and forwards to mcode.
    assert.equal(r, false);
  });

  test("/goal with empty rest shows usage hint, no mcode call", async () => {
    const r = await commands.handleLocalSlash("/goal", cs, "cid-1");
    assert.equal(r.handled, true);
    assert.equal(r.continueMcode, false);
    assert.ok(cs.chat.some((line) => line.includes("用法")));
  });

  test("/goal with text sets goal and rewrites content for mcode", async () => {
    cs.chat = [`› /goal do the thing`];
    const r = await commands.handleLocalSlash("/goal do the thing", cs, "cid-1");
    assert.equal(r.handled, true);
    assert.equal(r.continueMcode, true);
    assert.equal(r.rewriteContent, "do the thing");
    assert.equal(cs.goal.active, true);
    assert.equal(cs.goal.text, "do the thing");
    assert.equal(cs.goal.status, "in_progress");
    assert.ok(cs.chat.includes("› do the thing"));
  });

  test("/goal-done with no active goal prints warning", async () => {
    const r = await commands.handleLocalSlash("/goal-done", cs, "cid-1");
    assert.equal(r.handled, true);
    assert.ok(cs.chat.some((l) => l.includes("没有 active 目标")));
  });

  test("/goal-done with active goal marks complete + duration", async () => {
    cs.goal = { active: true, text: "do X", startTs: Date.now() - 5000 };
    const r = await commands.handleLocalSlash("/goal-done", cs, "cid-1");
    assert.equal(r.handled, true);
    assert.equal(cs.goal.active, false);
    assert.equal(cs.goal.status, "complete");
    assert.ok(cs.goal.duration >= 5000);
  });

  test("/clear empties chat + resets usage", async () => {
    cs.chat = ["a", "b", "c"];
    cs.usage.sessionInput = 100;
    const r = await commands.handleLocalSlash("/clear", cs, "cid-1");
    assert.equal(r.handled, true);
    assert.deepEqual(cs.chat, []);
    assert.equal(cs.usage.sessionInput, 0);
    assert.equal(cs.sessionTitle, "Untitled");
  });

  test("/status appends a status line", async () => {
    const r = await commands.handleLocalSlash("/status", cs, "cid-1");
    assert.equal(r.handled, true);
    assert.ok(cs.chat.some((l) => l.includes("当前 model=")));
  });

  test("/help calls ensureMcodeCommands and lists both webui + mcode cmds", async () => {
    const r = await commands.handleLocalSlash("/help", cs, "cid-1");
    assert.equal(r.handled, true);
    const joined = cs.chat.join("\n");
    assert.ok(joined.includes("/new"));
    assert.ok(joined.includes("/exec"));
  });

  test("unknown /cmd falls through to mcode", async () => {
    const r = await commands.handleLocalSlash("/not_a_cmd", cs, "cid-1");
    assert.equal(r.handled, false);
    assert.equal(r.continueMcode, true);
  });
});

// ---------------------------------------------------------------------
// commands.js — handleCmdCommand (button-driven path)
// ---------------------------------------------------------------------
describe("commands.handleCmdCommand — button-driven slash", () => {
  test("/new while AI running prints warn instead of creating", async () => {
    cs.running.active = true;
    const r = await commands.handleCmdCommand("/new", cs, "cid-1");
    assert.equal(r.handled, true);
    assert.ok(cs.chat.some((l) => l.includes("AI 还在回复中")));
  });

  test("/new on empty + default title is a no-op (avoid infinite creation)", async () => {
    cs.sessionId = "existing-id";
    const r = await commands.handleCmdCommand("/new", cs, "cid-1");
    assert.equal(r.handled, true);
    assert.equal(cs.sessionId, "existing-id");
  });

  test("/new otherwise creates a new session entry", async () => {
    cs.sessionId = "old-id";
    cs.chat = ["prev"];
    const r = await commands.handleCmdCommand("/new", cs, "cid-1");
    assert.equal(r.handled, true);
    assert.notEqual(cs.sessionId, "old-id");
    assert.deepEqual(cs.chat, []);
    assert.ok(_sessionsStore.some((s) => s.id === cs.sessionId));
  });

  test("/clear empties chat and resets mcodeSessionId", async () => {
    cs.mcodeSessionId = "mvs-1";
    cs.chat = ["x"];
    const r = await commands.handleCmdCommand("/clear", cs, "cid-1");
    assert.equal(r.handled, true);
    assert.equal(cs.mcodeSessionId, null);
  });

  test("/sessions lists the stored sessions", async () => {
    _sessionsStore = [
      { id: "a-1", title: "First", createdAt: 1, updatedAt: 1, chat: [] },
      { id: "b-2", title: "Second", createdAt: 2, updatedAt: 2, chat: [] },
    ];
    const r = await commands.handleCmdCommand("/sessions", cs, "cid-1");
    assert.equal(r.handled, true);
    const joined = cs.chat.join("\n");
    assert.ok(joined.includes("First"));
    assert.ok(joined.includes("Second"));
  });

  test("unknown cmd returns handled:false", async () => {
    const r = await commands.handleCmdCommand("/does_not_exist", cs, "cid-1");
    assert.equal(r.handled, false);
  });
});

// ---------------------------------------------------------------------
// permission-presets.js
// ---------------------------------------------------------------------
describe("permission-presets — named presets seam", () => {
  test("PERMISSION_PRESETS has 5 entries with id+label+mcodeValue", () => {
    assert.ok(Array.isArray(presets.PERMISSION_PRESETS));
    assert.equal(presets.PERMISSION_PRESETS.length, 5);
    for (const p of presets.PERMISSION_PRESETS) {
      assert.ok(p.id && p.label && p.mcodeValue);
    }
  });

  test("getPermissionPreset is case-insensitive", () => {
    assert.equal(presets.getPermissionPreset("ASK").label, "Ask");
    assert.equal(presets.getPermissionPreset("full").label, "Full access");
    assert.equal(presets.getPermissionPreset("nope"), undefined);
  });

  test("webuiModeToLabel preserves the byte-identical mapping", () => {
    assert.equal(presets.webuiModeToLabel("ask"), "Ask");
    assert.equal(presets.webuiModeToLabel("auto"), "Auto");
    assert.equal(presets.webuiModeToLabel("read"), "Read");
    assert.equal(presets.webuiModeToLabel("off"), "Off");
    assert.equal(presets.webuiModeToLabel("anything-else"), "Full access");
    assert.equal(presets.webuiModeToLabel(""), "Full access");
  });

  test("applyPermissionPreset mutates cs and returns label", () => {
    const label = presets.applyPermissionPreset(cs, "cid-1", "read");
    assert.equal(label, "Read");
    assert.equal(cs.permissions, "Read");
  });

  test("applyPermissionPreset returns null on unknown id", () => {
    const before = cs.permissions;
    const label = presets.applyPermissionPreset(cs, "cid-1", "nope");
    assert.equal(label, null);
    assert.equal(cs.permissions, before);
  });
});

// ---------------------------------------------------------------------
// tool-ask-user.js
// ---------------------------------------------------------------------
describe("tool-ask-user — ask modal state seam", () => {
  test("makeAskState returns the canonical shape", () => {
    const s = askUser.makeAskState();
    assert.deepEqual(Object.keys(s).sort(), [
      "active", "answered", "currentIdx", "options", "question", "total",
    ]);
    assert.equal(s.active, false);
    assert.equal(s.total, 0);
  });

  test("setAskPending populates cs.ask from payload", () => {
    const ok = askUser.setAskPending(cs, "cid-1", {
      questions: [{ question: "ok?", options: ["yes", "no"], multiSelect: false }],
    });
    assert.equal(ok, true);
    assert.equal(cs.ask.active, true);
    assert.equal(cs.ask.total, 1);
    assert.equal(cs.ask.question, "ok?");
  });

  test("setAskPending returns false on empty payload", () => {
    assert.equal(askUser.setAskPending(cs, "cid-1", {}), false);
    assert.equal(askUser.setAskPending(cs, "cid-1", { questions: [] }), false);
  });

  test("clearAskPending toggles active off", () => {
    askUser.setAskPending(cs, "cid-1", { questions: [{ question: "?" }] });
    askUser.clearAskPending(cs, "cid-1");
    assert.equal(cs.ask.active, false);
  });

  test("recordAskProgress advances idx and tallies answered", () => {
    askUser.setAskPending(cs, "cid-1", {
      questions: [{ question: "q1" }, { question: "q2" }, { question: "q3" }],
    });
    const next1 = askUser.recordAskProgress(cs);
    assert.equal(next1, 1);
    assert.equal(cs.ask.answered, 1);
    askUser.recordAskProgress(cs);
    const last = askUser.recordAskProgress(cs);
    assert.equal(last, 3);
    assert.equal(cs.ask.active, false);
  });
});

// ---------------------------------------------------------------------
// user-questions.js
// ---------------------------------------------------------------------
describe("user-questions — typed question normalization", () => {
  test("inferKind: text when no options", () => {
    assert.equal(questions.inferKind({ question: "?" }), "text");
  });
  test("inferKind: confirm for yes/no pair", () => {
    assert.equal(questions.inferKind({ options: ["yes", "no"] }), "confirm");
    assert.equal(questions.inferKind({ options: ["确认", "取消"] }), "confirm");
  });
  test("inferKind: choice for 2+ non-yes/no options", () => {
    assert.equal(questions.inferKind({ options: ["x", "y", "z"] }), "choice");
  });

  test("normalizeQuestions accepts both array and {questions:[...]}", () => {
    const a = questions.normalizeQuestions([{ question: "q" }]);
    const b = questions.normalizeQuestions({ questions: [{ question: "q" }] });
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0].question, "q");
  });

  test("validateAnswer: text rejects empty", () => {
    const q = { kind: "text" };
    assert.equal(questions.validateAnswer(q, "").ok, false);
    assert.equal(questions.validateAnswer(q, "hi").ok, true);
  });

  test("validateAnswer: choice must be in options", () => {
    const q = { kind: "choice", options: [{ label: "a" }, { label: "b" }] };
    assert.equal(questions.validateAnswer(q, "a").ok, true);
    assert.equal(questions.validateAnswer(q, "z").ok, false);
  });

  test("validateAnswer: confirm accepts true/false/yes/no", () => {
    const q = { kind: "confirm" };
    assert.equal(questions.validateAnswer(q, true).ok, true);
    assert.equal(questions.validateAnswer(q, "yes").ok, true);
    assert.equal(questions.validateAnswer(q, "maybe").ok, false);
  });

  test("formatAnswerForChat renders choices + confirm", () => {
    assert.equal(questions.formatAnswerForChat({ kind: "choice" }, "a"), "「a」");
    assert.equal(questions.formatAnswerForChat({ kind: "confirm" }, true), "✅ 是");
  });
});