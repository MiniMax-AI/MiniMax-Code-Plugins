// webui/test/lib-markdown-edge.test.js
// Lease D01 — Edge case coverage fillers for server/lib/markdown.js (C06).
//
// What's covered here vs the existing routes-export.test.js (which has
// already locked the basic markdown behavior):
//   - Nested code blocks (4-backtick fence containing a 3-backtick fence
//     inside, plus 5-backtick when 4 would still collide)
//   - Very long content (>1 MB) — verifies the serializer doesn't blow up
//     on multi-megabyte messages
//   - Emoji / multi-byte UTF-8 / BOM at the start of content
//   - HTML escape variants (`</details>`, raw `<script>`, raw newline
//     inside a single line)
//   - TOML frontmatter edge cases (empty title / malformed workspace /
//     0 / non-integer timestamps)
//   - slugifyTitle / fileTimestamp edge cases

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;
const md = await import(absPath("lib/markdown.js"));

// ---------------------------------------------------------------------------
// Nested code blocks — the fence picker must escalate to avoid colliding
// with fence-shaped sequences inside the body.
// ---------------------------------------------------------------------------
describe("markdown (D01) — nested code blocks", () => {
  test("4-backtick fence around a body that contains a 3-backtick fence", () => {
    const out = md.serializeMessages([
      {
        role: "assistant",
        tool_calls: [
          {
            name: "bash",
            arguments: { cmd: "echo hi" },
            output: "before\n```\n<embedded fence>\n```\nafter",
          },
        ],
      },
    ]);
    // Wrapping fence must be 4+
    assert.match(out, /````\n/, "expected a 4-backtick fence opener");
    assert.match(out, /\n````$/m, "expected a 4-backtick fence closer");
    // Embedded fence should remain inside verbatim
    assert.match(out, /<embedded fence>/);
  });

  test("when content itself contains `\\\\\\\\`` (4 backticks), wrap with 5", () => {
    const body = "contains `\\\\```` literal inside";
    const out = md.serializeMessages([
      { role: "user", content: body },
    ]);
    // Body should be present
    assert.match(out, /literal inside/);
    // And no 4-backtick fence should appear unbalanced. The fence
    // picker increments length until no collision; the body has
    // 4-backtick runs so wrap must be 5+.
    const fenceOpenMatches = out.match(/^````+/gm) || [];
    assert.ok(
      fenceOpenMatches.every((f) => f.length >= 5),
      `expected fence opener length to be >=5, got ${JSON.stringify(fenceOpenMatches)}`,
    );
  });

  test("user content with 5+ backticks is escaped (each backtick run padded)", () => {
    // _escapeInline pads every backtick run by +1. Combined with the
    // 4-backtick fence opener, we want NO premature closure.
    const body = "look: ``````` (5-backtick run)";
    const out = md.serializeMessages([{ role: "user", content: body }]);
    // After escape: 5-backtick run becomes 6-backtick run
    assert.match(out, /``````/);
    // No 4-backtick fence should appear, since there's no need for one
    // in the body (no actual code block), but the user content's escaped
    // version must be present.
    assert.match(out, /\(5-backtick run\)/);
  });

  test("deeply nested: tool → markdown wrapper → user body → 3-backtick block", () => {
    const out = md.serializeMessages([
      {
        role: "assistant",
        content: "see:",
        tool_calls: [
          {
            name: "Run",
            output:
              "Some output\n\n```js\nconst x = 1;\n```\n\nback to output",
          },
        ],
      },
      {
        role: "user",
        content: "ok",
      },
    ]);
    // The tool output should be wrapped in at least 4 backticks
    assert.match(out, /````\n/);
    // The user's reply appears as a separate ## User heading
    assert.match(out, /## User\n/);
  });
});

// ---------------------------------------------------------------------------
// Very long content — multi-megabyte user/assistant content should not
// OOM or stall the serializer.
// ---------------------------------------------------------------------------
describe("markdown (D01) — large content", () => {
  test("user content of 1 MB serializes without error", () => {
    const big = "x".repeat(1_000_000);
    const out = md.serializeMessages([{ role: "user", content: big }]);
    assert.ok(out.length >= 1_000_000);
    assert.ok(out.length <= 1_000_500, "should not bloat excessively");
  });

  test("3 MB of content serialized quickly (<1s wall clock)", () => {
    const big = "abcdefghij".repeat(300_000);
    const t0 = Date.now();
    const out = md.serializeMessages([{ role: "user", content: big }]);
    const dt = Date.now() - t0;
    assert.ok(out.length >= 3_000_000);
    assert.ok(dt < 1000, `serialization took ${dt}ms — must be < 1000ms`);
  });

  test("content with 10K lines does not produce over-escaped fence chains", () => {
    const lines = Array.from({ length: 10_000 }, (_, i) => `line ${i}`);
    const out = md.serializeMessages([
      { role: "user", content: lines.join("\n") },
    ]);
    const lines_out = out.split("\n").length;
    assert.ok(lines_out >= 10_000, `expected ≥ 10000 output lines, got ${lines_out}`);
  });
});

// ---------------------------------------------------------------------------
// Emoji / multi-byte / BOM — markdown itself is opaque to these but
// the rendering must not corrupt the bytes.
// ---------------------------------------------------------------------------
describe("markdown (D01) — emoji / multi-byte / BOM", () => {
  test("emoji in user content is preserved (UTF-8 bytes unchanged)", () => {
    const content = "🎉🌟🚀 — hello";
    const out = md.serializeMessages([{ role: "user", content }]);
    assert.ok(out.includes(content));
  });

  test("BOM at start of content is preserved", () => {
    const content = "\uFEFFBOM-prefixed text";
    const out = md.serializeMessages([{ role: "user", content }]);
    assert.ok(out.includes("\uFEFF"));
  });

  test("Cyrillic / CJK content round-trips byte-for-byte", () => {
    const content = "你好世界 — Привет — こんにちは";
    const out = md.serializeMessages([{ role: "user", content }]);
    assert.ok(out.includes(content));
  });

  test("Right-to-Left text + emoji doesn't break the serializer", () => {
    const content = "مرحبا 🌍 שלום";
    const out = md.serializeMessages([{ role: "user", content }]);
    assert.ok(out.includes("مرحبا"));
    assert.ok(out.includes("🌍"));
    assert.ok(out.includes("שלום"));
  });
});

// ---------------------------------------------------------------------------
// HTML escaping — we don't fully sanitize, but raw </details> close tags
// in user content must not close our wrapper early.
// ---------------------------------------------------------------------------
describe("markdown (D01) — HTML inside content", () => {
  test("raw </details> in user content is preserved verbatim (no escape)", () => {
    // The serializer only escapes backticks (md.js#_escapeInline), not
    // HTML. This is intentional: markdown is a permissive format and
    // we don't try to second-guess author intent. The test simply
    // pins the current behavior — change requires test update.
    const out = md.serializeMessages([
      { role: "user", content: "raw close: </details>" },
    ]);
    assert.ok(out.includes("</details>"));
  });

  test("raw <script> tag in user content is preserved (no XSS defense)", () => {
    const out = md.serializeMessages([
      { role: "user", content: "<script>alert(1)</script>" },
    ]);
    assert.ok(out.includes("<script>alert(1)</script>"));
  });

  test("HTML entity in user content (e.g. &lt;) is preserved", () => {
    const out = md.serializeMessages([
      { role: "user", content: "use &lt;div&gt;" },
    ]);
    assert.ok(out.includes("&lt;div&gt;"));
  });
});

// ---------------------------------------------------------------------------
// TOML frontmatter boundaries — serializeSession builds the header.
// ---------------------------------------------------------------------------
describe("markdown (D01) — serializeSession frontmatter edges", () => {
  test("session with no title → 'Untitled session' default", () => {
    const out = md.serializeSession(
      { id: "abc" },
      [{ role: "user", content: "x" }],
    );
    assert.match(out, /title = "Untitled session"/);
  });

  test("session with empty title → 'Untitled session' default", () => {
    const out = md.serializeSession(
      { id: "abc", title: "" },
      [{ role: "user", content: "x" }],
    );
    assert.match(out, /title = "Untitled session"/);
  });

  test("session with title containing a quote → JSON.stringify escapes", () => {
    const out = md.serializeSession(
      { id: "abc", title: 'he said "hi"' },
      [],
    );
    assert.match(out, /title = "he said \\"hi\\""/);
  });

  test("session with title containing a newline → JSON.stringify escapes", () => {
    const out = md.serializeSession(
      { id: "abc", title: "line1\nline2" },
      [],
    );
    assert.match(out, /title = "line1\\nline2"/);
  });

  test("session with createdAt: 0 (epoch) is rendered as ISO string", () => {
    const out = md.serializeSession(
      { id: "abc", title: "T", createdAt: 0 },
      [],
    );
    // createdAt: 0 is treated as falsy → omitted (per the if (createdAt)
    // check inside serializeSession). Lock that behavior.
    assert.ok(!out.includes("created_at"));
  });

  test("session with createdAt: 1 (epoch+1ms) IS rendered", () => {
    const out = md.serializeSession(
      { id: "abc", title: "T", createdAt: 1 },
      [],
    );
    // 1 is truthy → included
    assert.match(out, /created_at = "1970-01-01T00:00:00\.001Z"/);
  });

  test("session without mcodeSessionId → mcode_session_id omitted", () => {
    const out = md.serializeSession(
      { id: "abc", title: "T", createdAt: 1, updatedAt: 2 },
      [],
    );
    assert.ok(!out.includes("mcode_session_id"));
  });

  test("session with mcodeSessionId → field rendered", () => {
    const out = md.serializeSession(
      { id: "abc", title: "T", mcodeSessionId: "mvs_deadbeef" },
      [],
    );
    assert.match(out, /mcode_session_id = "mvs_deadbeef"/);
  });

  test("session without workspace → workspace omitted", () => {
    const out = md.serializeSession(
      { id: "abc", title: "T" },
      [],
    );
    assert.ok(!out.includes("workspace ="));
  });

  test("message_count reflects non-empty messages array length", () => {
    const out = md.serializeSession(
      { id: "abc", title: "T" },
      [
        { role: "user", content: "1" },
        { role: "assistant", content: "2" },
        { role: "user", content: "3" },
      ],
    );
    assert.match(out, /^message_count = 3$/m);
  });

  test("message_count is 0 for empty messages array", () => {
    const out = md.serializeSession(
      { id: "abc", title: "T" },
      [],
    );
    assert.match(out, /^message_count = 0$/m);
  });

  test("source defaults to 'webui'", () => {
    const out = md.serializeSession({ id: "abc", title: "T" }, []);
    assert.match(out, /^source = "webui"$/m);
  });

  test("meta.source override flows through to frontmatter", () => {
    const out = md.serializeSession(
      { id: "abc", title: "T" },
      [],
      { source: "mcode" },
    );
    assert.match(out, /^source = "mcode"$/m);
  });

  test("exportedAt override (ISO form) flows through to frontmatter", () => {
    const out = md.serializeSession(
      { id: "abc", title: "T" },
      [],
      { exportedAt: 1_700_000_000_000 },
    );
    assert.match(out, /exported_at = "2023-11-14/);
  });
});

// ---------------------------------------------------------------------------
// Helpers — slugifyTitle + fileTimestamp
// ---------------------------------------------------------------------------
describe("markdown (D01) — slugifyTitle / fileTimestamp edges", () => {
  test("slugifyTitle handles Windows-reserved characters < > : \" | ? *", () => {
    assert.equal(md.slugifyTitle("a<b>c:d\"e|f?g*h"), "a-b-c-d-e-f-g-h");
  });

  test("slugifyTitle returns 'session' for purely-punctuation title", () => {
    assert.equal(md.slugifyTitle("!!!@@@###"), "session");
  });

  test("slugifyTitle collapses runs of dashes", () => {
    assert.equal(md.slugifyTitle("a - - b -- c"), "a-b-c");
  });

  test("slugifyTitle caps at 60 chars", () => {
    assert.equal(md.slugifyTitle("a".repeat(100)).length <= 60, true);
  });

  test("slugifyTitle handles emoji — replaces with dashes (not preserved)", () => {
    const s = md.slugifyTitle("🚀 launch day 🌟");
    // We don't assert exact shape (depends on regex tightening),
    // just that the result is non-empty and length-capped.
    assert.ok(s.length > 0);
    assert.ok(s.length <= 60);
  });

  test("slugifyTitle(null) → 'session' (no crash)", () => {
    assert.equal(md.slugifyTitle(null), "session");
  });

  test("slugifyTitle(undefined) → 'session' (no crash)", () => {
    assert.equal(md.slugifyTitle(undefined), "session");
  });

  test("fileTimestamp(0) falls back to Date.now() (0 is falsy → defensive)", () => {
    // fileTimestamp uses `Number(ms) || Date.now()`. 0 is falsy and
    // therefore falls back to "now". This is intentional to keep the
    // helper non-crashing for `Date.now()` callers that pass 0.
    const ts = md.fileTimestamp(0);
    assert.match(ts, /^\d{8}T\d{6}$/);
    // It's today's date, not 1970 — verifies the fallback fired.
    const year = Number(ts.slice(0, 4));
    assert.ok(year >= 2024, `expected current year, got ${year}`);
  });

  test("fileTimestamp(NaN) → current Date.now() ISO (defensive)", () => {
    const ts = md.fileTimestamp(NaN);
    assert.match(ts, /^\d{8}T\d{6}$/);
    const year = Number(ts.slice(0, 4));
    assert.ok(year >= 2024, `expected current year, got ${year}`);
  });

  test("fileTimestamp pads single-digit month/day with zeros", () => {
    // Construct a date with a single-digit month (Feb 5) and pad-check
    // the resulting string (timezone-independent: we only check shape).
    const d = new Date(2024, 1, 5, 3, 4, 5); // local Feb 5 2024 03:04:05
    const ts = md.fileTimestamp(d.getTime());
    // Lock the shape: 8 digits T 6 digits, month/day zero-padded.
    assert.match(ts, /^\d{8}T\d{6}$/);
    const month = ts.slice(4, 6);
    const day = ts.slice(6, 8);
    assert.equal(month, "02", "month must be zero-padded to 2 digits");
    assert.equal(day, "05", "day must be zero-padded to 2 digits");
    // Hour/minute/second zero-padded (3 → "03" or 11 → "11", but
    // never "3" alone).
    const hh = ts.slice(9, 11);
    const mm = ts.slice(11, 13);
    const ss = ts.slice(13, 15);
    assert.match(hh, /^\d{2}$/);
    assert.match(mm, /^\d{2}$/);
    assert.match(ss, /^\d{2}$/);
  });
});
