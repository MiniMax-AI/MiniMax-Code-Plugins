// webui/test/routes-export.test.js
// Unit tests for server/routes/export.js (handleExport) +
// server/lib/markdown.js (serializeMessages / serializeSession).
//
// Lease C06 verification:
//   1. GET /api/sessions/:id/export?format=md|json
//   2. ?download=true → Content-Disposition: attachment; filename="..."
//   3. 404 when session not found
//   4. 400 on unsupported format
//   5. mcode sqlite unavailable → _meta.mcode_unavailable: true, still serves
//   6. markdown serializer: 4-backtick fence, <details> tool calls, role H2
//   7. authorize gate — the real decision path is driven via
//      test/_setup.js#withDecisions (approve for happy paths, an
//      explicit decline test for the 403)
//
// Test strategy:
//   - Use setupMocks to mock lib/sessions.js (webui chat store) and
//     lib/db.js (mcode better-sqlite3 unavailable). lib/authorize.js is
//     NOT mocked — decisions are injected through its real pending
//     registry (see exportApproved / exportDeclined below).
//   - Override MCODE_WEBUI_EVENTS_PATH so the audit append doesn't touch
//     the user's real events file.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupMocks, absPath, registerSessionsStore, withDecisions } from "../test/_setup.js";

let exportRoute;
let markdown;

// Every handleExport call that passes format validation crosses the
// authorize("session.export") gate. Drive the real decision path
// (2026-09-20 rigor fix — no auto-approve): exportApproved injects a
// user approval, exportDeclined a user rejection.
async function exportApproved(...args) {
  return withDecisions(() => exportRoute.handleExport(...args), { approve: true });
}
async function exportDeclined(...args) {
  return withDecisions(() => exportRoute.handleExport(...args), { approve: false });
}

before(async (t) => {
  await setupMocks(t, {
    acp: {
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => [],
      getCachedMcodeCommands: () => ({ mcode: [], webui: [], fetchedAt: 0, source: "test" }),
    },
  });
  // Mock lib/db.js so getMcodeBetterSqlite3 returns null (mcode db
  // unavailable in tests). This is the realistic scenario — the
  // production environment may or may not have better-sqlite3 installed
  // in the expected location, and the export route must continue to
  // serve when it doesn't.
  t.mock.module(absPath("lib/db.js"), {
    namedExports: {
      getMcodeBetterSqlite3: () => null,
      deleteMcodeSessionFromDb: () => ({ ok: false, reason: "test_mock" }),
      _getBetterSqlite3Candidates: () => [],
      MCODE_SESSION_DELETE_TABLES: [],
    },
  });
  exportRoute = await import(absPath("routes/export.js"));
  markdown = await import(absPath("lib/markdown.js"));
});

let tmpDir;
let tmpEventsPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "webui-export-test-"));
  tmpEventsPath = join(tmpDir, "events.ndjson");
  process.env.MCODE_WEBUI_EVENTS_PATH = tmpEventsPath;
});

after(() => {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
  delete process.env.MCODE_WEBUI_EVENTS_PATH;
});

function fakeReq(url) {
  return { url, method: "GET", headers: {} };
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
function fakeCtx(overrides = {}) {
  return { cid: "cid-test", pathname: overrides.pathname || "", cs: {} };
}

// ============================================================================
// markdown.serializeMessages — pure serializer unit tests
// ============================================================================

describe("markdown.serializeMessages — empty input", () => {
  test("returns empty string for non-array input", () => {
    assert.equal(markdown.serializeMessages(null), "");
    assert.equal(markdown.serializeMessages(undefined), "");
    assert.equal(markdown.serializeMessages("not an array"), "");
  });

  test("returns empty string for empty array", () => {
    assert.equal(markdown.serializeMessages([]), "");
  });
});

describe("markdown.serializeMessages — role headings", () => {
  test("User role → ## User", () => {
    const out = markdown.serializeMessages([{ role: "user", content: "hi" }]);
    assert.match(out, /^## User\n/);
  });

  test("Assistant role → ## Assistant", () => {
    const out = markdown.serializeMessages([{ role: "assistant", content: "hello" }]);
    assert.match(out, /^## Assistant\n/);
  });

  test("System / Thinking / Tool roles all get H2 headings", () => {
    const out = markdown.serializeMessages([
      { role: "system", content: "sys" },
      { role: "thinking", content: "thought" },
      { role: "tool", content: "out" },
    ]);
    assert.match(out, /## System/);
    assert.match(out, /## Thinking/);
    assert.match(out, /## Tool/);
  });

  test("Unknown role capitalises (e.g. 'custom' → 'Custom')", () => {
    const out = markdown.serializeMessages([{ role: "custom", content: "x" }]);
    assert.match(out, /## Custom/);
  });
});

describe("markdown.serializeMessages — code blocks", () => {
  test("uses 4-backtick fence for tool_call arguments/output", () => {
    // Realistic case: an assistant message invokes a Bash tool with
    // multi-line output that itself contains a 3-backtick fence. The
    // wrapping fence must be 4+ backticks to be unambiguous.
    const out = markdown.serializeMessages([
      {
        role: "assistant",
        content: "running it",
        tool_calls: [
          {
            name: "Bash",
            arguments: "ls -la",
            status: "completed",
            output: "```js\nfoo()\n```",
          },
        ],
      },
    ]);
    // 4-backtick open present
    assert.match(out, /^````/m);
    // Inner 3-backtick fence escaped to 4
    assert.ok(out.includes("````js") || out.includes("````\nfoo"));
  });

  test("escapes embedded 3-backtick fences in inline user content", () => {
    const out = markdown.serializeMessages([
      { role: "user", content: "look:\n```js\nfoo()\n```\nend" },
    ]);
    // The 3-backtick fence in user content gets padded to 4 so any
    // downstream renderer doesn't try to close it early.
    assert.ok(out.includes("````js") || out.includes("````\nfoo"));
    // We chose a 4-backtick fence whose opening and closing don't appear
    // in the user content after padding; verify the opening fence starts
    // at the beginning of the body (heading line excluded) — meaning
    // padding did its job.
    assert.match(out, /^````/m);
  });

  test("does NOT collide with embedded 3-backtick fences in user content", () => {
    const content = "before\n```js\nfoo()\n```\nafter";
    const out = markdown.serializeMessages([{ role: "user", content }]);
    const fenceOpens = (out.match(/^````/gm) || []).length;
    assert.ok(fenceOpens >= 1, "expected at least one 4-backtick fence");
  });

  test("preserves the inner code verbatim inside the fence", () => {
    const out = markdown.serializeMessages([
      {
        role: "assistant",
        content: "x",
        tool_calls: [{ name: "Bash", arguments: "echo hi", output: "hi\nthere" }],
      },
    ]);
    assert.ok(out.includes("hi\nthere"));
  });
});

describe("markdown.serializeMessages — tool calls", () => {
  test("renders tool_calls as <details><summary> collapsible blocks", () => {
    const out = markdown.serializeMessages([
      {
        role: "assistant",
        content: "running it",
        tool_calls: [
          {
            name: "Bash",
            arguments: "ls -la",
            status: "completed",
            output: "file1\nfile2",
          },
        ],
      },
    ]);
    assert.match(out, /<details>/);
    assert.match(out, /<summary>tool: Bash/);
    assert.match(out, /<\/details>/);
    assert.match(out, /\*\*Arguments\*\*/);
    assert.match(out, /\*\*Output\*\*/);
  });

  test("tool_call without arguments still renders cleanly", () => {
    const out = markdown.serializeMessages([
      {
        role: "assistant",
        content: "no args",
        tool_calls: [{ name: "Read", output: "contents" }],
      },
    ]);
    assert.match(out, /<summary>tool: Read/);
    assert.match(out, /\*\*Output\*\*/);
    // No "Arguments" section when arguments are missing
    assert.ok(!out.includes("**Arguments**"));
  });

  test("tool_call with no output shows placeholder", () => {
    const out = markdown.serializeMessages([
      {
        role: "assistant",
        content: "x",
        tool_calls: [{ name: "Test" }],
      },
    ]);
    assert.match(out, /\(no output\)/);
  });

  test("tool status badge in summary when provided", () => {
    const out = markdown.serializeMessages([
      {
        role: "assistant",
        content: "x",
        tool_calls: [{ name: "Bash", status: "failed", arguments: "x", output: "y" }],
      },
    ]);
    assert.match(out, /<summary>tool: Bash \[failed\]<\/summary>/);
  });
});

describe("markdown.serializeMessages — empty / edge cases", () => {
  test("message with empty content but tool_calls still renders tool block", () => {
    const out = markdown.serializeMessages([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ name: "X", output: "y" }],
      },
    ]);
    assert.match(out, /<summary>tool: X/);
  });

  test("multiple messages separated by blank lines", () => {
    const out = markdown.serializeMessages([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    // Each role block is its own H2 group
    const headings = out.match(/^## /gm) || [];
    assert.equal(headings.length, 2);
  });
});

// ============================================================================
// markdown.serializeSession — full session document
// ============================================================================

describe("markdown.serializeSession — TOML frontmatter + H1", () => {
  test("produces TOML frontmatter with title / session_id / timestamps", () => {
    const session = {
      id: "abc-123",
      title: "My session",
      workspace: "/tmp/ws",
      createdAt: 1700000000000,
      updatedAt: 1700000999000,
      mcodeSessionId: "mvs_deadbeefcafebabe1234567890abcdef",
    };
    const out = markdown.serializeSession(session, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    assert.match(out, /^---\n/);
    assert.match(out, /\n---\n/);
    assert.match(out, /title = "My session"/);
    assert.match(out, /session_id = "abc-123"/);
    assert.match(out, /mcode_session_id = "mvs_deadbeef/);
    assert.match(out, /workspace = "\/tmp\/ws"/);
    assert.match(out, /exported_at = /);
    assert.match(out, /message_count = 2/);
    // The H1 appears AFTER the closing frontmatter fence
    assert.match(out, /\n---\n\n# Session: My session\n/);
  });

  test("omits mcode_session_id / workspace when empty", () => {
    const out = markdown.serializeSession(
      { id: "x", title: "T", createdAt: 1, updatedAt: 2 },
      [],
    );
    assert.ok(!out.includes("mcode_session_id = "));
    assert.ok(!out.includes("workspace = "));
    assert.match(out, /message_count = 0/);
  });
});

describe("markdown.slugifyTitle + fileTimestamp", () => {
  test("slugifyTitle strips path separators and limits length", () => {
    assert.equal(markdown.slugifyTitle("hello world"), "hello-world");
    assert.equal(markdown.slugifyTitle("/etc/passwd"), "etc-passwd");
    assert.equal(markdown.slugifyTitle("a".repeat(100)).length <= 60, true);
  });

  test("fileTimestamp produces YYYYMMDDTHHMMSS shape", () => {
    const ts = markdown.fileTimestamp(1700000000000);
    assert.match(ts, /^\d{8}T\d{6}$/);
  });
});

// ============================================================================
// export.handleExport — HTTP handler tests
// ============================================================================

describe("handleExport — error paths", () => {
  test("403 + no export when the user declines the authorize gate", async () => {
    // New coverage (2026-09-20 rigor fix): the gate must actually
    // block the export on a user decline — no auto-approve exists.
    registerSessionsStore({
      initial: [
        { id: "s-decline", title: "Secret", workspace: "", createdAt: 1, updatedAt: 2, chat: ["› private"] },
      ],
    });
    const res = fakeRes();
    await exportDeclined(
      fakeReq("/api/sessions/s-decline/export?format=md"),
      res,
      fakeCtx({ pathname: "/api/sessions/s-decline/export" }),
    );
    assert.equal(res._status, 403);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.match(body.error, /authorize declined/);
    assert.equal(body.decidedBy, "user");
    // No session.export outcome event may exist for a declined request
    // (only auth.pending / auth.reject from authorize itself).
    if (existsSync(tmpEventsPath)) {
      const parsed = readFileSync(tmpEventsPath, "utf8")
        .split("\n").filter((l) => l.length > 0)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } });
      const leaked = parsed.filter((l) => l && l.kind === "session.export");
      assert.equal(leaked.length, 0, "declined export must not write an outcome event");
    }
  });

  test("404 when session id not found", async () => {
    registerSessionsStore({ initial: [] });
    const res = fakeRes();
    await exportApproved(
      fakeReq("/api/sessions/nonexistent-id/export?format=md"),
      res,
      fakeCtx({ pathname: "/api/sessions/nonexistent-id/export" }),
    );
    assert.equal(res._status, 404);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.match(body.error, /session not found/);
  });

  test("400 on unsupported format", async () => {
    registerSessionsStore({
      initial: [{ id: "s1", title: "T", workspace: "", createdAt: 1, updatedAt: 2, chat: [] }],
    });
    const res = fakeRes();
    await exportApproved(
      fakeReq("/api/sessions/s1/export?format=xml"),
      res,
      fakeCtx({ pathname: "/api/sessions/s1/export" }),
    );
    assert.equal(res._status, 400);
    const body = JSON.parse(res._body);
    assert.match(body.error, /unsupported format/);
    assert.deepEqual(body.allowed, ["md", "json"]);
  });

  test("400 on missing id (empty path tail)", async () => {
    const res = fakeRes();
    await exportApproved(
      fakeReq("/api/sessions//export"),
      res,
      fakeCtx({ pathname: "/api/sessions//export" }),
    );
    // The regex in router never lets an empty id reach here (path match
    // requires [^\/]+), but the handler still defends against it.
    assert.equal(res._status, 400);
  });
});

describe("handleExport — JSON format", () => {
  test("returns application/json for an empty session", async () => {
    registerSessionsStore({
      initial: [
        { id: "s-json-empty", title: "Empty", workspace: "", createdAt: 1, updatedAt: 2, chat: [] },
      ],
    });
    const res = fakeRes();
    await exportApproved(
      fakeReq("/api/sessions/s-json-empty/export?format=json"),
      res,
      fakeCtx({ pathname: "/api/sessions/s-json-empty/export" }),
    );
    assert.equal(res._status, 200);
    assert.match(res._headers["Content-Type"], /application\/json/);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.messages.length, 0);
    assert.equal(body.session.id, "s-json-empty");
    assert.equal(body._meta.mcode_unavailable, true);
    // Reason should be set since mcode db is mocked-unavailable
    assert.ok(typeof body._meta.mcode_unavailable_reason === "string");
  });

  test("returns JSON with parsed messages for a populated session", async () => {
    // Realistic single-line chat entries (webui's cs.chat is line-prefix text;
    // streamUpdateLine collapses newlines). Use the ›/●/→ prefixes from
    // real handlers (see server/routes/chat.js + lib/mcode-exec.js).
    registerSessionsStore({
      initial: [
        {
          id: "s-json-pop",
          title: "Populated",
          workspace: "/x",
          createdAt: 1,
          updatedAt: 2,
          chat: [
            "› hello there",
            "● hi! I will list the files",
            "→ Bash  ls -la",
            "  [completed]",
            "  file1",
            "  file2",
          ],
        },
      ],
    });
    const res = fakeRes();
    await exportApproved(
      fakeReq("/api/sessions/s-json-pop/export?format=json"),
      res,
      fakeCtx({ pathname: "/api/sessions/s-json-pop/export" }),
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    // Expect: 1 user + 1 assistant + 1 tool (with 3 output lines folded in)
    assert.equal(body.messages.length, 3);
    assert.equal(body.messages[0].role, "user");
    assert.match(body.messages[0].content, /hello there/);
    assert.equal(body.messages[1].role, "assistant");
    assert.match(body.messages[1].content, /hi! I will list the files/);
    assert.equal(body.messages[2].role, "tool");
    assert.equal(body.messages[2].name, "Bash");
    assert.equal(body.messages[2].status, "completed");
    assert.match(body.messages[2].output, /file1/);
    assert.match(body.messages[2].output, /file2/);
  });
});

describe("handleExport — Markdown format", () => {
  test("returns text/markdown", async () => {
    registerSessionsStore({
      initial: [
        { id: "s-md-1", title: "MD test", workspace: "", createdAt: 1, updatedAt: 2, chat: ["› hi"] },
      ],
    });
    const res = fakeRes();
    await exportApproved(
      fakeReq("/api/sessions/s-md-1/export?format=md"),
      res,
      fakeCtx({ pathname: "/api/sessions/s-md-1/export" }),
    );
    assert.equal(res._status, 200);
    assert.match(res._headers["Content-Type"], /text\/markdown/);
    const body = res._body;
    assert.match(body, /^---\n/);
    assert.match(body, /^---[\s\S]*\n# Session: MD test/m);
    assert.match(body, /## User/);
  });

  test("Markdown body uses 4-backtick fence for tool_call output", async () => {
    // A tool's output that contains a 3-backtick fence should be wrapped
    // in a 4-backtick fence in the markdown output.
    registerSessionsStore({
      initial: [
        {
          id: "s-md-code",
          title: "Code",
          workspace: "",
          createdAt: 1,
          updatedAt: 2,
          chat: [
            "● Running",
            "→ Bash  ls",
            "  [completed]",
            "  ```js",
            "  foo()",
            "  ```",
          ],
        },
      ],
    });
    const res = fakeRes();
    await exportApproved(
      fakeReq("/api/sessions/s-md-code/export?format=md"),
      res,
      fakeCtx({ pathname: "/api/sessions/s-md-code/export" }),
    );
    assert.equal(res._status, 200);
    assert.match(res._body, /^````/m);
  });

  test("Markdown body renders tool calls as <details>", async () => {
    registerSessionsStore({
      initial: [
        {
          id: "s-md-tool",
          title: "Tool",
          workspace: "",
          createdAt: 1,
          updatedAt: 2,
          chat: [
            "● I'll list the files",
            "→ Bash  ls",
            "  [completed]",
            "  a.txt",
            "  b.txt",
          ],
        },
      ],
    });
    const res = fakeRes();
    await exportApproved(
      fakeReq("/api/sessions/s-md-tool/export?format=md"),
      res,
      fakeCtx({ pathname: "/api/sessions/s-md-tool/export" }),
    );
    assert.equal(res._status, 200);
    assert.match(res._body, /<details>/);
    assert.match(res._body, /<summary>tool: Bash/);
    assert.match(res._body, /<\/details>/);
    assert.match(res._body, /a\.txt/);
  });
});

describe("handleExport — download mode", () => {
  test("?download=true → Content-Disposition attachment with sanitized filename", async () => {
    registerSessionsStore({
      initial: [
        {
          id: "s-dl",
          title: "Cool Session 2024!",
          workspace: "",
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          chat: ["› hi"],
        },
      ],
    });
    const res = fakeRes();
    await exportApproved(
      fakeReq("/api/sessions/s-dl/export?format=md&download=true"),
      res,
      fakeCtx({ pathname: "/api/sessions/s-dl/export" }),
    );
    assert.equal(res._status, 200);
    assert.match(res._headers["Content-Type"], /text\/markdown/);
    assert.match(
      res._headers["Content-Disposition"],
      /^attachment; filename="Cool-Session-2024-\d{8}T\d{6}\.md"$/,
    );
  });

  test("JSON download uses .json extension", async () => {
    registerSessionsStore({
      initial: [
        { id: "s-dl-json", title: "X", workspace: "", createdAt: 1, updatedAt: 2, chat: [] },
      ],
    });
    const res = fakeRes();
    await exportApproved(
      fakeReq("/api/sessions/s-dl-json/export?format=json&download=true"),
      res,
      fakeCtx({ pathname: "/api/sessions/s-dl-json/export" }),
    );
    assert.equal(res._status, 200);
    assert.match(
      res._headers["Content-Disposition"],
      /^attachment; filename="X-\d{8}T\d{6}\.json"$/,
    );
  });

  test("download=false (default) → no Content-Disposition header", async () => {
    registerSessionsStore({
      initial: [
        { id: "s-nodl", title: "X", workspace: "", createdAt: 1, updatedAt: 2, chat: [] },
      ],
    });
    const res = fakeRes();
    await exportApproved(
      fakeReq("/api/sessions/s-nodl/export?format=md"),
      res,
      fakeCtx({ pathname: "/api/sessions/s-nodl/export" }),
    );
    assert.equal(res._headers["Content-Disposition"], undefined);
  });
});

describe("handleExport — matchKind (mcodeSessionId vs webuiId)", () => {
  test("resolves via mcodeSessionId", async () => {
    registerSessionsStore({
      initial: [
        {
          id: "webui-id-1",
          mcodeSessionId: "mvs_aabbccddeeff0011223344556677aabb",
          title: "Via mcode id",
          workspace: "",
          createdAt: 1,
          updatedAt: 2,
          chat: ["› hi"],
        },
      ],
    });
    const res = fakeRes();
    await exportApproved(
      fakeReq(
        "/api/sessions/mvs_aabbccddeeff0011223344556677aabb/export?format=json",
      ),
      res,
      fakeCtx({
        pathname: "/api/sessions/mvs_aabbccddeeff0011223344556677aabb/export",
      }),
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.session.id, "webui-id-1");
    // matchKind is recorded in the audit event but not in the response
    // body; we assert the session was found, which is the user-visible
    // success criterion.
  });
});

describe("handleExport — mcode db unavailable", () => {
  test("still returns 200 + _meta.mcode_unavailable: true", async () => {
    registerSessionsStore({
      initial: [
        {
          id: "s-no-mcode",
          mcodeSessionId: "mvs_11111111111111111111111111111111",
          title: "X",
          workspace: "",
          createdAt: 1,
          updatedAt: 2,
          chat: ["› hi"],
        },
      ],
    });
    const res = fakeRes();
    await exportApproved(
      fakeReq("/api/sessions/s-no-mcode/export?format=json"),
      res,
      fakeCtx({ pathname: "/api/sessions/s-no-mcode/export" }),
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body._meta.mcode_unavailable, true);
    assert.ok(body._meta.mcode_unavailable_reason);
  });
});

describe("handleExport — audit event written", () => {
  test("emits one session.export event with the right metadata", async () => {
    registerSessionsStore({
      initial: [
        { id: "s-audit", title: "Audit", workspace: "", createdAt: 1, updatedAt: 2, chat: ["› x"] },
      ],
    });
    const res = fakeRes();
    await exportApproved(
      fakeReq("/api/sessions/s-audit/export?format=md"),
      res,
      fakeCtx({ pathname: "/api/sessions/s-audit/export" }),
    );
    assert.equal(res._status, 200);
    // events.ndjson should have one entry for session.export
    assert.ok(existsSync(tmpEventsPath), `events file missing at ${tmpEventsPath}`);
    const lines = readFileSync(tmpEventsPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    const parsed = lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
    // events.js stores the payload under the `data` key (see events.js
    // _buildLine / append() — payload → data on disk).
    const found = parsed.find((l) => l && l.kind === "session.export");
    assert.ok(found, "expected a session.export event");
    assert.equal(found.target, "s-audit");
    assert.equal(found.data.format, "md");
    assert.equal(found.data.messageCount, 1);
    assert.equal(found.data.mcodeUnavailable, true);
  });
});