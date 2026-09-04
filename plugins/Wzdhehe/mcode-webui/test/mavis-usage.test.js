// webui/test/mavis-usage.test.js
// Unit tests for server/lib/mavis-usage.js — getMavisTokenUsage()
//
// Why this test exists: v0.5.bx-30 typo — variable `lastContextTokens` did not
// match the shorthand key `lastTurnContextTokens`, so the child-process 'exit'
// handler threw `ReferenceError: lastContextTokens is not defined`. The
// promise never resolved, every consumer awaiting applyMavisUsageToCs hung
// forever, and "context shows estimate instead of real value" only surfaced
// when users reported the symptom. This test pins the resolve object's shape
// so a similar typo would fail `node --test` before commit.
//
// Test strategy: use a real sqlite3 fixture DB (test/fixtures/v2/sqlite/
// runtime-state.sqlite) instead of mocking node:child_process. Reason:
// Node 24.14's --experimental-test-module-mocks does NOT reliably
// intercept `node:child_process.spawn` — the mock module is registered
// (visible via toString) but the SUT actually calls the real spawn.
// Mocking node:fs.existsSync also has issues: mock.module replaces
// the entire namespace, so un-listed exports (readFileSync used by
// config.js's DEFAULT_WORKSPACE IIFE) become undefined → SUT import
// hangs. We rely on the real fs (the fixture DB exists, the cwd.json
// exists).
//
// Tests that need to exercise spawn failure paths (exit non-zero,
// < 13 columns, child error) are NOT covered here — see REFACTORING.md.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setupMocks, absPath } from "./_setup.js";

// Point config.js's MAVIS_DATA_DIR at our fixture dir BEFORE mavis-usage.js
// is imported. config.js reads process.env.MAVIS_DATA_DIR at module-load
// time, so the env var must be set before the dynamic import below.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
process.env.MAVIS_DATA_DIR = resolve(TEST_DIR, "fixtures");

// Fixture session IDs (created by test/fixtures/create-test-db.mjs).
// MUST match /mvs_[a-f0-9]{16,}/i — only hex chars allowed (no 'l', 'u' etc).
//   mvs_feeddead... — 3 rows, varied (happy path + per-turn fields)
//   mvs_d0de0000... — 1 row with all zero tokens (cache hit rate = 0)
//   mvs_faceface... — 1 row where reasoning_tokens is NULL (default 0 path)
const SID_FULL = "mvs_feeddead0000000000000000000aaaa";
const SID_DIVZERO = "mvs_d0de0000000000000000000000abcdef";
const SID_NULL_REASONING = "mvs_facefacefacefacefacefacefaceface";
const SID_NONEXISTENT = "mvs_none0000000000000000000000000abcde";

let getMavisTokenUsage;
before(async (t) => {
  await setupMocks(t);
  ({ getMavisTokenUsage } = await import(absPath("lib/mavis-usage.js")));
});

describe("getMavisTokenUsage — input validation (no DB read)", () => {
  test("returns null for empty mvsSessionId", async () => {
    assert.equal(await getMavisTokenUsage(""), null);
  });

  test("returns null for null mvsSessionId", async () => {
    assert.equal(await getMavisTokenUsage(null), null);
  });

  test("returns null for malformed mvsSessionId (sql injection guard)", async () => {
    assert.equal(await getMavisTokenUsage("mvs_'; DROP TABLE x;--"), null);
  });

  test("returns null for short mvsSessionId (regex requires 16+ hex)", async () => {
    assert.equal(await getMavisTokenUsage("mvs_abc"), null);
  });

  test("returns null for mvsSessionId with non-hex chars (l, u etc)", async () => {
    // 'l' and 'u' are NOT in [a-f0-9] — must be rejected
    assert.equal(
      await getMavisTokenUsage("mvs_full1111aaaa2222bbbb3333cccc4444"),
      null,
    );
  });
});

describe("getMavisTokenUsage — happy path (real sqlite3)", () => {
  test("returns null when session has 0 rows", async () => {
    // SESSION_NONEXISTENT → COUNT(*) = 0 → resolve(null)
    const r = await getMavisTokenUsage(SID_NONEXISTENT);
    assert.equal(r, null);
  });

  // ===== v0.5.bx-30 regression test =====
  test("REGRESSION: resolves with lastTurnContextTokens (bx-30 typo fix)", async () => {
    // SESSION_FULL last row (highest ts): li=5000, lo=1000, lr=500
    const r = await getMavisTokenUsage(SID_FULL);
    assert.ok(r, "resolve() must produce a value, not hang (bx-30 bug)");
    assert.equal(
      r.lastTurnContextTokens,
      5000 + 1000 + 500,
      "lastTurnContextTokens = li + lo + lr",
    );
  });

  test("full happy path: cumulative + per-turn + cache hit rate", async () => {
    const r = await getMavisTokenUsage(SID_FULL);
    assert.ok(r);
    // cumulative across all 3 rows
    assert.equal(r.totalInput, 1000 + 2000 + 5000); // 8000
    assert.equal(r.totalOutput, 500 + 1000 + 1000); // 2500
    assert.equal(r.totalCacheRead, 200 + 1500 + 4000); // 5700
    assert.equal(r.totalCacheWrite, 50 + 100 + 200); // 350
    assert.equal(r.totalReasoning, 100 + 200 + 500); // 800
    assert.equal(r.rows, 3);
    // per-turn = row with highest ts (5000/1000/4000/200/500)
    assert.equal(r.lastTurnInput, 5000);
    assert.equal(r.lastTurnOutput, 1000);
    assert.equal(r.lastTurnCacheRead, 4000);
    assert.equal(r.lastTurnCacheWrite, 200);
    assert.equal(r.lastTurnReasoning, 500);
    assert.equal(r.lastTurnContextTokens, 5000 + 1000 + 500);
    // cache hit rate = lcr / (li + lcr + lcw) = 4000 / (5000 + 4000 + 200)
    const expectedRate = 4000 / (5000 + 4000 + 200);
    assert.ok(Math.abs(r.cacheHitRate - expectedRate) < 1e-9);
  });

  test("cache hit rate is 0 when last turn has all zero tokens (avoid div/0)", async () => {
    const r = await getMavisTokenUsage(SID_DIVZERO);
    assert.ok(r);
    assert.equal(r.lastTurnInput, 0);
    assert.equal(r.cacheHitRate, 0);
  });

  test("lastTurnReasoning defaults to 0 when sqlite returns NULL", async () => {
    // SESSION_NULL_REASONING has reasoning_tokens=NULL for the row.
    // Number(null) === 0, and the explicit `|| 0` in the SUT also defends
    // against NaN.
    const r = await getMavisTokenUsage(SID_NULL_REASONING);
    assert.ok(r);
    assert.equal(r.lastTurnReasoning, 0);
  });
});

// Tests that require mocking node:child_process.spawn are SKIPPED here
// because Node 24.14 --experimental-test-module-mocks does not
// intercept that builtin. See REFACTORING.md.
//
// describe.skip('getMavisTokenUsage — spawn error paths (require spawn mock)', () => {
//   test('returns null when sqlite exits non-zero')
//   test('returns null when sqlite stdout has fewer than 13 columns')
//   test('returns null when child emits error event (spawn ENOENT)')
// })
