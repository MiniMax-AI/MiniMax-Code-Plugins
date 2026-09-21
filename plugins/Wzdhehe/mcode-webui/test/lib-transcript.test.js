// webui/test/lib-transcript.test.js
// Unit tests for server/lib/transcript.js — the mcode runtime-DB transcript
// reader extracted from routes/export.js (v2 2026-09-20 webui-manual-audit)
// plus the messages→chat-lines inverse mapper used by the switch backfill.
//
// Coverage contract (from the manual-audit fix):
//   1. readMcodeTranscript gate order + legacy probe behavior is IDENTICAL
//      to the code that lived inline in export.js (same reasons, same row
//      mapping) — export.js must not change behavior by the extraction.
//   2. the v2 data_json probe (the schema the real runtime DB carries
//      today) normalizes rows into the legacy message shape.
//   3. messagesToChatLines emits ONLY line shapes both parsers
//      (export.js#_parseChatLines / public/app/render.js#parseChatLines)
//      round-trip; ambiguous content is skipped, never re-encoded.
//   4. caps: last 400 lines / 200KB total, whichever binds first; a single
//      oversized line gets an explicit truncation marker instead of a
//      silent drop; a front-truncation never leaves orphan indented lines.
//
// Test strategy: NO mock.module — transcript.js takes getDb / dbPath /
// probes as options, so a fake better-sqlite3 class keyed by SQL string is
// injected directly (same technique as the MCODE_WEBUI_RESOLVER_JSON fake
// DBs in lib-db*.test.js, minus the real native module).

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const {
  readMcodeTranscript,
  messagesToChatLines,
  loadTranscriptChatLines,
  LEGACY_TRANSCRIPT_PROBES,
  V2_DATA_JSON_PROBES,
} = await import(absPath("lib/transcript.js"));

// ---------------------------------------------------------------------------
// Fake better-sqlite3: prepare(sql) succeeds ONLY for SQL keys present in
// rowsBySql (each entry: sid → rows); everything else throws, exactly like
// a real prepare() on a missing table / missing column.
// ---------------------------------------------------------------------------
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
      return {
        all: (sid) => (bySid[sid] || []).slice(),
      };
    }
    close() {
      this.closed = true;
    }
  };
}

// Real file on disk so the existsSync gate passes (content never read —
// the fake Db ignores the path).
let _tmpDir;
function realDbPath(name = "runtime-state.sqlite") {
  if (!_tmpDir) _tmpDir = mkdtempSync(join(tmpdir(), "webui-transcript-test-"));
  const p = join(_tmpDir, name);
  if (!existsSync(p)) writeFileSync(p, "sqlite fixture placeholder");
  return p;
}
after(() => {
  if (_tmpDir) {
    try { rmSync(_tmpDir, { recursive: true, force: true }); } catch {}
  }
});

const SID = "mvs_0123456789abcdef0123456789abcdef"; // 32 hex chars

describe("readMcodeTranscript — gate order (must match export.js exactly)", () => {
  test("no sid → no_mcode_sid", () => {
    const r = readMcodeTranscript("", { dbPath: realDbPath(), getDb: () => makeFakeDb() });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_mcode_sid");
  });

  test("non-mvs sid → bad_mcode_sid", () => {
    const r = readMcodeTranscript("not-a-sid", { dbPath: realDbPath(), getDb: () => makeFakeDb() });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "bad_mcode_sid");
  });

  test("missing db file → mcode_db_not_found (checked BEFORE better-sqlite3)", () => {
    const missing = join(tmpdir(), "webui-no-such-" + Date.now(), "x.sqlite");
    const r = readMcodeTranscript(SID, { dbPath: missing, getDb: () => null });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "mcode_db_not_found");
  });

  test("better-sqlite3 not loadable → better_sqlite3_not_loaded", () => {
    const r = readMcodeTranscript(SID, { dbPath: realDbPath(), getDb: () => null });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "better_sqlite3_not_loaded");
  });

  test("constructor throw → db_error with message", () => {
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => makeFakeDb({ constructThrows: true }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "db_error");
    assert.match(r.error, /boom/);
  });

  test("no probe matches → no_matching_table", () => {
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => makeFakeDb({ rowsBySql: {} }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_matching_table");
  });
});

describe("readMcodeTranscript — legacy probes (extraction is behavior-preserving)", () => {
  const legacySql0 = LEGACY_TRANSCRIPT_PROBES[0].sql;

  test("first legacy probe hit: role lowercased, content coerced, tool_calls_json parsed", () => {
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => makeFakeDb({
        rowsBySql: {
          [legacySql0]: {
            [SID]: [
              { role: "USER", content: "hi", tool_calls_json: null },
              { role: "assistant", content: "", tool_calls_json: '[{"function":{"name":"web_search","arguments":"{\\"q\\":\\"x\\"}"}}]' },
            ],
          },
        },
      }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.source, "local_runtime_message_rows");
    assert.equal(r.probe, "legacy-cols");
    assert.deepEqual(r.messages, [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "web_search", arguments: '{"q":"x"}' } }],
      },
    ]);
  });

  test("probe 1 misses (schema drift) → probe 2 table fallback", () => {
    const legacySql1 = LEGACY_TRANSCRIPT_PROBES[1].sql;
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => makeFakeDb({
        rowsBySql: {
          [legacySql1]: { [SID]: [{ role: "user", content: "from table 2" }] },
        },
      }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.source, "local_runtime_messages");
    assert.deepEqual(r.messages, [{ role: "user", content: "from table 2" }]);
  });

  test("role default under legacy mapper is 'system' (export.js parity)", () => {
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => makeFakeDb({
        rowsBySql: { [legacySql0]: { [SID]: [{ role: null, content: "anon" }] } },
      }),
    });
    assert.deepEqual(r.messages, [{ role: "system", content: "anon" }]);
  });
});

describe("readMcodeTranscript — v2 data_json probe (real runtime schema)", () => {
  const v2Sql = V2_DATA_JSON_PROBES[0].sql;

  function v2Db(rows) {
    return makeFakeDb({
      // legacy SQLs intentionally absent → they throw, v2 hits (mirrors the
      // real DB where all three legacy probes fail with "no such column").
      rowsBySql: { [v2Sql]: { [SID]: rows } },
    });
  }

  test("normalizes msg_content / thinking_content / tool_calls", () => {
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => v2Db([
        {
          role: "user",
          data_json: JSON.stringify({ role: "user", msg_type: 1, msg_content: "调研一下" }),
        },
        {
          role: "assistant",
          data_json: JSON.stringify({
            role: "assistant",
            msg_type: 2,
            msg_content: "我先看看",
            thinking_content: "想一下",
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
      ]),
      probes: [...LEGACY_TRANSCRIPT_PROBES, ...V2_DATA_JSON_PROBES],
    });
    assert.equal(r.ok, true);
    assert.equal(r.probe, "v2-data-json");
    assert.deepEqual(r.messages, [
      { role: "user", content: "调研一下" },
      {
        role: "assistant",
        content: "我先看看",
        thinking: "想一下",
        tool_calls: [
          {
            name: "bash",
            arguments: '{"command":"ls"}',
            status: "completed",
            result: "file1\nfile2",
          },
        ],
      },
    ]);
  });

  test("tool_call_status 3 → 'failed'; unknown ints → null (never invent a verdict)", () => {
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => v2Db([
        {
          role: "assistant",
          data_json: JSON.stringify({
            role: "assistant",
            msg_content: "",
            tool_calls: [
              { tool_name: "edit", tool_call_status: 3, tool_call_args: "{}", tool_call_result_data: null },
              { tool_name: "read", tool_call_status: 99, tool_call_args: "{}", tool_call_result_data: null },
            ],
          }),
        },
      ]),
      probes: V2_DATA_JSON_PROBES,
    });
    assert.equal(r.messages[0].tool_calls[0].status, "failed");
    assert.equal(r.messages[0].tool_calls[1].status, null);
  });

  test("drops unrecognized roles and malformed data_json rows", () => {
    const r = readMcodeTranscript(SID, {
      dbPath: realDbPath(),
      getDb: () => v2Db([
        { role: "tool_executor", data_json: JSON.stringify({ role: "tool_executor", msg_content: "x" }) },
        { role: "", data_json: "{not json" },
        { role: "system", data_json: JSON.stringify({ role: "system", msg_content: "sys" }) },
      ]),
      probes: V2_DATA_JSON_PROBES,
    });
    assert.deepEqual(r.messages, [{ role: "system", content: "sys" }]);
  });
});

describe("messagesToChatLines — inverse line grammar", () => {
  test("user / thinking / assistant / system / tool shapes", () => {
    const { lines, skipped } = messagesToChatLines([
      { role: "user", content: "hello\nmulti\nline" },
      {
        role: "assistant",
        thinking: "hmm\ndeep",
        content: "answer **here**",
        tool_calls: [
          {
            name: "bash",
            arguments: '{"command":"ls"}',
            status: "completed",
            result: "file1\nfile2",
          },
          { name: "read_file", arguments: "", status: "failed", result: "" },
        ],
      },
      { role: "system", content: "sys msg" },
      { role: "mystery", content: "skip me" },
    ]);
    assert.deepEqual(lines, [
      "› hello multi line",
      "▲ hmm deep",
      "● answer **here**",
      "→ bash  {\"command\":\"ls\"}",
      "  [completed]",
      "  file1",
      "  file2",
      "→ read_file",
      "  [failed]",
      "○ sys msg",
    ]);
    assert.equal(skipped, 1, "unknown-role message contributes nothing");
  });

  test("OpenAI-ish tool_calls (legacy tool_calls_json shape) map via function.name", () => {
    const { lines } = messagesToChatLines([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "web_search", arguments: '{"q":"x"}' } }],
      },
    ]);
    assert.deepEqual(lines, ['→ web_search  {"q":"x"}']);
  });

  test("ambiguous result lines are skipped, not re-encoded", () => {
    // A result line that IS a full "[…]" would re-parse as a status line;
    // "! x" as an error; "@ /p" as a location. Skipping keeps the render
    // honest instead of silently re-classifying content.
    const { lines } = messagesToChatLines([
      {
        role: "assistant",
        tool_calls: [
          {
            name: "t",
            arguments: "",
            status: "completed",
            result: "[completed]\n! danger\n@ /path\nkeep me\n\n  ",
          },
        ],
      },
    ]);
    assert.deepEqual(lines, ["→ t", "  [completed]", "  keep me"]);
  });

  test("tool call without a name is skipped (cannot build a header)", () => {
    const { lines } = messagesToChatLines([
      { role: "assistant", tool_calls: [{ arguments: "{}" }, { name: "ok", arguments: "{}" }] },
    ]);
    assert.deepEqual(lines, ["→ ok  {}"]);
  });

  test("unknown status emits NO status line (frontend default 'pending')", () => {
    const { lines } = messagesToChatLines([
      { role: "assistant", tool_calls: [{ name: "t", arguments: "", status: "weird", result: "out" }] },
    ]);
    assert.deepEqual(lines, ["→ t", "  out"]);
  });
});

describe("messagesToChatLines — caps (400 lines / 200KB)", () => {
  const MAX_BYTES = 200 * 1024;

  test("line cap keeps the LAST 400 lines", () => {
    const msgs = [];
    for (let i = 0; i < 500; i++) msgs.push({ role: "user", content: `msg ${i}` });
    const { lines, truncated } = messagesToChatLines(msgs);
    assert.equal(lines.length, 400);
    assert.equal(lines[0], "› msg 100", "tail kept — line 0 is message #100");
    assert.equal(lines[399], "› msg 499");
    assert.equal(truncated, true);
  });

  test("byte cap drops from the front while over 200KB", () => {
    // 3 user lines of ~90KB each = ~270KB raw → front lines dropped until
    // the total fits; the LAST message must always survive.
    const big = "x".repeat(90 * 1024);
    const msgs = [
      { role: "user", content: big },
      { role: "user", content: big },
      { role: "user", content: big },
      { role: "user", content: "final short" },
    ];
    const { lines } = messagesToChatLines(msgs);
    const total = lines.reduce((s, l) => s + Buffer.byteLength(l, "utf8"), 0);
    assert.ok(total <= MAX_BYTES, `total ${total} must be <= ${MAX_BYTES}`);
    assert.equal(lines.length, 3, "exactly one oversized line dropped from the front");
    assert.equal(lines[lines.length - 1], "› final short");
  });

  test("a single oversized line is marker-truncated, never silently emptied", () => {
    const { lines, truncated } = messagesToChatLines([
      { role: "assistant", content: "y".repeat(300 * 1024) },
    ]);
    assert.equal(lines.length, 1);
    const total = Buffer.byteLength(lines[0], "utf8");
    assert.ok(total <= MAX_BYTES, `total ${total} must be <= ${MAX_BYTES}`);
    assert.match(lines[0], / …\[truncated\]$/, "explicit truncation marker");
    assert.equal(truncated, true);
  });

  test("front-truncation never leaves orphan indented tool-output lines", () => {
    // One tool block with many output lines, then user messages; cap the
    // lines so the slice boundary falls INSIDE the tool block. The first
    // emitted line must not be an indented orphan (its → header was cut).
    const toolCall = {
      name: "bash",
      arguments: "{}",
      status: "completed",
      result: Array.from({ length: 30 }, (_, i) => `out ${i}`).join("\n"),
    };
    const msgs = [{ role: "assistant", tool_calls: [toolCall] }];
    for (let i = 0; i < 30; i++) msgs.push({ role: "user", content: `u ${i}` });
    const { lines } = messagesToChatLines(msgs, { maxLines: 20 });
    assert.equal(lines.length <= 20, true);
    assert.ok(!/^\s{2,}\S/.test(lines[0]), `first line must not be an orphan: ${JSON.stringify(lines[0])}`);
  });
});

describe("loadTranscriptChatLines — read + map composition", () => {
  test("legacy + v2 probes by default; failure lands as ok:false, never throws", () => {
    // All probes miss → ok:false with reason (the switch path continues
    // with chat: [] on this outcome).
    const r = loadTranscriptChatLines(SID, {
      dbPath: realDbPath(),
      getDb: () => makeFakeDb({}),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_matching_table");
    assert.deepEqual(r.lines, []);
  });

  test("happy path: v2 rows → capped chat lines", () => {
    const v2Sql = V2_DATA_JSON_PROBES[0].sql;
    const rows = [
      {
        role: "user",
        data_json: JSON.stringify({ role: "user", msg_content: "q" }),
      },
      {
        role: "assistant",
        data_json: JSON.stringify({
          role: "assistant",
          msg_content: "a",
          tool_calls: [
            {
              tool_name: "bash",
              tool_call_status: 2,
              tool_call_args: '{"command":"ls"}',
              tool_call_result_data: '{"content":[{"type":"text","text":"o1"}]}',
            },
          ],
        }),
      },
    ];
    const r = loadTranscriptChatLines(SID, {
      dbPath: realDbPath(),
      getDb: () => makeFakeDb({ rowsBySql: { [v2Sql]: { [SID]: rows } } }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.probe, "v2-data-json");
    assert.equal(r.messageCount, 2);
    assert.deepEqual(r.lines, [
      "› q",
      "● a",
      "→ bash  {\"command\":\"ls\"}",
      "  [completed]",
      "  o1",
    ]);
  });

  test("sid gate still applies in the composed path", () => {
    const r = loadTranscriptChatLines("junk");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "bad_mcode_sid");
  });
});
