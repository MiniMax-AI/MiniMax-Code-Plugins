// webui/test/util.test.js
// Unit tests for public/app/util.js (REFACTORING.md batch 4 step 1).
//
// Why this test exists: util.js is the leaf module of the frontend — pure
// formatting / date helpers with zero app-state dependencies. They were
// extracted from main.js so they CAN be unit-tested in node without a
// browser environment. If we don't cover them, every "next reset time"
// bug report becomes a manual F12 hunt.
//
// Test strategy: stub `globalThis.window` and `globalThis.document` before
// the dynamic import so util.js's top-level `window.__DBG = ...` /
// `window.addEventListener(...)` / `document.addEventListener(...)` calls
// don't throw. We do NOT exercise the DOM-dependent code paths (showToast,
// __DBG.flush, MODE_ICONS) — those require a real DOM.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const absPath = (rel) => pathToFileURL(resolve(HERE, "..", rel)).href;

let util;

before(async () => {
  // Stub DOM globals — util.js's top-level code references window/document.
  // We provide just enough for module evaluation to succeed.
  globalThis.window = {
    addEventListener: () => {},
    location: { search: "" },
  };
  globalThis.document = { addEventListener: () => {} };
  util = await import(absPath("public/app/util.js"));
});

// -----------------------------------------------------------------------
// escapeHtml — used by parseMarkdown fallback + render code
// -----------------------------------------------------------------------
describe("util.escapeHtml", () => {
  test("escapes < > & \" '", () => {
    assert.equal(
      util.escapeHtml(`<a href="x">&'</a>`),
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });

  test("escapes <script> tag to neutral text", () => {
    assert.equal(
      util.escapeHtml("<script>alert(1)</script>"),
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  test("returns empty string for empty input", () => {
    assert.equal(util.escapeHtml(""), "");
  });

  test("coerces non-string to string before escaping", () => {
    assert.equal(util.escapeHtml(42), "42");
    assert.equal(util.escapeHtml(null), "null");
    assert.equal(util.escapeHtml(undefined), "undefined");
  });

  test("passes through safe text unchanged", () => {
    assert.equal(util.escapeHtml("hello world"), "hello world");
    assert.equal(util.escapeHtml("中文 + emoji 🎉"), "中文 + emoji 🎉");
  });
});

// -----------------------------------------------------------------------
// formatNumber — usage panel / token counter
// -----------------------------------------------------------------------
describe("util.formatNumber", () => {
  test("null/undefined → em dash", () => {
    assert.equal(util.formatNumber(null), "—");
    assert.equal(util.formatNumber(undefined), "—");
  });

  test("0–999 → integer", () => {
    assert.equal(util.formatNumber(0), "0");
    assert.equal(util.formatNumber(1), "1");
    assert.equal(util.formatNumber(500), "500");
    assert.equal(util.formatNumber(999.4), "999");
    assert.equal(util.formatNumber(999.6), "1000"); // Math.round(999.6)=1000
  });

  test("1k–999k → one decimal in k", () => {
    assert.equal(util.formatNumber(1000), "1.0k");
    assert.equal(util.formatNumber(1500), "1.5k");
    assert.equal(util.formatNumber(12345), "12.3k");
    assert.equal(util.formatNumber(999999), "1000.0k");
  });

  test("1M+ → two decimals in M", () => {
    assert.equal(util.formatNumber(1000000), "1.00M");
    assert.equal(util.formatNumber(1500000), "1.50M");
    assert.equal(util.formatNumber(12345678), "12.35M");
  });
});

// -----------------------------------------------------------------------
// FIVE_HOUR_BOUNDARIES — const list
// -----------------------------------------------------------------------
describe("util.FIVE_HOUR_BOUNDARIES", () => {
  test("is [5, 10, 15, 20, 24]", () => {
    assert.deepEqual(util.FIVE_HOUR_BOUNDARIES, [5, 10, 15, 20, 24]);
  });
});

// -----------------------------------------------------------------------
// nextFiveHourReset — 5h quota window math
// -----------------------------------------------------------------------
describe("util.nextFiveHourReset", () => {
  test("00:00 → 05:00 same day", () => {
    const now = new Date(2026, 7, 21, 0, 0, 0);
    const t = util.nextFiveHourReset(now);
    assert.equal(t.getHours(), 5);
    assert.equal(t.getDate(), 21);
  });

  test("03:30 → 05:00 same day (before first boundary)", () => {
    const now = new Date(2026, 7, 21, 3, 30, 0);
    const t = util.nextFiveHourReset(now);
    assert.equal(t.getHours(), 5);
    assert.equal(t.getMinutes(), 0);
  });

  test("07:15 → 10:00 same day", () => {
    const now = new Date(2026, 7, 21, 7, 15, 0);
    const t = util.nextFiveHourReset(now);
    assert.equal(t.getHours(), 10);
  });

  test("12:00 → 15:00 same day", () => {
    const now = new Date(2026, 7, 21, 12, 0, 0);
    const t = util.nextFiveHourReset(now);
    assert.equal(t.getHours(), 15);
  });

  test("22:30 (in 20→24 window) → next day 00:00 (the b=24 boundary)", () => {
    // Boundaries are [5, 10, 15, 20, 24]. h=22 < 24 → t.setHours(24,0,0,0)
    // → setHours(24) clamps to next-day 00:00.
    const now = new Date(2026, 7, 21, 22, 30, 0);
    const t = util.nextFiveHourReset(now);
    assert.equal(t.getDate(), 22);
    assert.equal(t.getHours(), 0);
    assert.equal(t.getMinutes(), 0);
  });

  test("20:00 exactly → next day 00:00 (h < 24 wins because h=20 not >=24)", () => {
    const now = new Date(2026, 7, 21, 20, 0, 0);
    const t = util.nextFiveHourReset(now);
    assert.equal(t.getDate(), 22);
    assert.equal(t.getHours(), 0);
  });
});

// -----------------------------------------------------------------------
// nextWeeklyReset — weekly quota window (Sunday 00:00)
// -----------------------------------------------------------------------
describe("util.nextWeeklyReset", () => {
  test("Wednesday → this coming Sunday 00:00 (4 days)", () => {
    // 2026-08-19 is a Wednesday
    const now = new Date(2026, 7, 19, 12, 0, 0);
    const t = util.nextWeeklyReset(now);
    assert.equal(t.getDay(), 0); // Sunday
    assert.equal(t.getDate(), 23);
    assert.equal(t.getHours(), 0);
    assert.equal(t.getMinutes(), 0);
  });

  test("Saturday → tomorrow Sunday 00:00 (1 day)", () => {
    // 2026-08-22 is a Saturday
    const now = new Date(2026, 7, 22, 12, 0, 0);
    const t = util.nextWeeklyReset(now);
    assert.equal(t.getDay(), 0);
    assert.equal(t.getDate(), 23);
  });

  test("Sunday 14:00 → next Sunday 00:00 (7 days)", () => {
    // 2026-08-23 is a Sunday — already past 00:00
    const now = new Date(2026, 7, 23, 14, 0, 0);
    const t = util.nextWeeklyReset(now);
    assert.equal(t.getDay(), 0);
    assert.equal(t.getDate(), 30);
  });

  test("Sunday exactly 00:00 → today 00:00 (the current reset moment)", () => {
    // Edge case: today is the reset moment itself
    const now = new Date(2026, 7, 23, 0, 0, 0);
    const t = util.nextWeeklyReset(now);
    assert.equal(t.getDate(), 23);
    assert.equal(t.getHours(), 0);
  });
});

// -----------------------------------------------------------------------
// formatTimeUntil — countdown text
// -----------------------------------------------------------------------
describe("util.formatTimeUntil", () => {
  test("past target → 现在", () => {
    const now = new Date(2026, 7, 21, 12, 0, 0);
    const past = new Date(2026, 7, 21, 11, 0, 0);
    assert.equal(util.formatTimeUntil(past, now), "现在");
  });

  test("target == now → 现在 (ms<=0 branch)", () => {
    const now = new Date(2026, 7, 21, 12, 0, 0);
    assert.equal(util.formatTimeUntil(now, now), "现在");
  });

  test("30 min from now → '30分 后重置'", () => {
    const now = new Date(2026, 7, 21, 12, 0, 0);
    const target = new Date(2026, 7, 21, 12, 30, 0);
    assert.equal(util.formatTimeUntil(target, now), "30分 后重置");
  });

  test("2 days 3 hours 15 min from now", () => {
    const now = new Date(2026, 7, 21, 0, 0, 0);
    const target = new Date(2026, 7, 23, 3, 15, 0);
    assert.equal(util.formatTimeUntil(target, now), "2天 3小时 15分 后重置");
  });

  test("1 hour exactly → '1小时 0分 后重置'", () => {
    // Note: code says `if (m > 0 || parts.length === 0) parts.push` —
    // 0 min only shows if d=0 and h=0 (parts.length===0).
    const now = new Date(2026, 7, 21, 0, 0, 0);
    const target = new Date(2026, 7, 21, 1, 0, 0);
    assert.equal(util.formatTimeUntil(target, now), "1小时 后重置");
  });

  test("5 min from now → '5分 后重置' (no day/hour parts)", () => {
    const now = new Date(2026, 7, 21, 0, 0, 0);
    const target = new Date(2026, 7, 21, 0, 5, 0);
    assert.equal(util.formatTimeUntil(target, now), "5分 后重置");
  });
});

// -----------------------------------------------------------------------
// formatResetTime — absolute time (e.g. "15:00" or "周日 00:00")
// -----------------------------------------------------------------------
describe("util.formatResetTime", () => {
  test("returns HH:MM with zero-padded minutes", () => {
    const target = new Date(2026, 7, 21, 5, 0, 0);
    // Non-Sunday → just HH:MM
    // 2026-08-21 is a Friday
    assert.equal(util.formatResetTime(target), "05:00");
  });

  test("returns '周日 HH:MM' for Sunday target", () => {
    const target = new Date(2026, 7, 23, 0, 0, 0);
    // 2026-08-23 is a Sunday
    assert.equal(util.formatResetTime(target), "周日 00:00");
  });

  test("pads single-digit hour", () => {
    const target = new Date(2026, 7, 21, 5, 0, 0);
    // Friday 5:00
    const out = util.formatResetTime(target);
    assert.equal(out, "05:00");
  });
});
