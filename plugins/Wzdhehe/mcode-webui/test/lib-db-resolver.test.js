// webui/test/lib-db-resolver.test.js
// Tests for the better-sqlite3 candidate path resolver added in
// v1.0.1 round 4. Reviewer (modacker) found the hard-coded
// `__dirname/../../../node_modules/...` path only works in the
// canonical dev layout (<mcode-root>/webui/server/lib/). Round 4
// adds a candidates list with priority: env override > MCODE_CMD
// derived > dev layout fallback.
//
// We only test the *shape* of the candidate list here, not the
// actual sqlite3 load (that requires a real binary + mcode install
// state and is covered by the existing integration tests).

import { test, describe, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { _getBetterSqlite3Candidates } from "../server/lib/db.js";
import { MCODE_CMD } from "../server/lib/config.js";

describe("db.js — better-sqlite3 resolver candidates (v1.0.1 round 4)", () => {
  let savedEnv;

  before(() => {
    savedEnv = process.env.MCODE_BETTER_SQLITE3;
  });
  after(() => {
    if (savedEnv === undefined) {
      delete process.env.MCODE_BETTER_SQLITE3;
    } else {
      process.env.MCODE_BETTER_SQLITE3 = savedEnv;
    }
  });

  test("MCODE_BETTER_SQLITE3 env override appears first", () => {
    process.env.MCODE_BETTER_SQLITE3 = "/explicit/override/better-sqlite3";
    const candidates = _getBetterSqlite3Candidates();
    assert.equal(
      candidates[0],
      "/explicit/override/better-sqlite3",
      "env override must be the FIRST candidate tried",
    );
  });

  test("dev layout fallback is always present as the last candidate", () => {
    delete process.env.MCODE_BETTER_SQLITE3;
    const candidates = _getBetterSqlite3Candidates();
    assert.ok(candidates.length >= 1, "must have at least the dev layout fallback");
    const last = candidates[candidates.length - 1];
    // Compare path segments (not string) to be cross-platform (`\` vs `/`).
    const lastSegments = last.split(/[\\/]/).slice(-5);
    assert.deepEqual(
      lastSegments,
      ["node_modules", "@minimax-ai", "code", "node_modules", "better-sqlite3"],
      `dev layout fallback should end with the better-sqlite3 path, got segments: ${lastSegments.join("/")}`,
    );
  });

  test("env override + dev layout both present, env first", () => {
    process.env.MCODE_BETTER_SQLITE3 = "/env/override";
    const candidates = _getBetterSqlite3Candidates();
    assert.equal(candidates[0], "/env/override", "env must be first");
    const last = candidates[candidates.length - 1];
    const lastSegments = last.split(/[\\/]/).slice(-5);
    assert.deepEqual(
      lastSegments,
      ["node_modules", "@minimax-ai", "code", "node_modules", "better-sqlite3"],
      "dev layout fallback must still be present as the last resort",
    );
  });

  test("candidates count: env (1) + MCODE_CMD (0 or 1) + dev layout (1) = 1, 2, or 3", () => {
    // Without env, the count is 1 (dev layout only) when MCODE_CMD is "mcode"
    // (the placeholder fallback in config.js), or 2 when MCODE_CMD is a
    // real path. With env, add 1.
    delete process.env.MCODE_BETTER_SQLITE3;
    const noEnv = _getBetterSqlite3Candidates().length;
    process.env.MCODE_BETTER_SQLITE3 = "/env/override";
    const withEnv = _getBetterSqlite3Candidates().length;
    assert.ok(
      withEnv === noEnv + 1,
      `withEnv (${withEnv}) should be noEnv (${noEnv}) + 1 — env adds exactly 1 candidate at the front`,
    );
  });

  test("MCODE_CMD-derived candidate is present when MCODE_CMD is a real path", () => {
    // MCODE_CMD is a module-level constant in config.js (resolved at
    // import time). If env was unset during import and mcode was
    // auto-detected, MCODE_CMD points to the real binary. The
    // placeholder "mcode" means no candidate should be generated from
    // MCODE_CMD.
    if (MCODE_CMD === "mcode") {
      // Skip: env had no MCODE_CMD and mcode not found, so the
      // MCODE_CMD branch is correctly skipped.
      return;
    }
    delete process.env.MCODE_BETTER_SQLITE3;
    const candidates = _getBetterSqlite3Candidates();
    // The MCODE_CMD-derived candidate starts with `dirname(MCODE_CMD)`,
    // then `..`, then node_modules/... The candidate goes up 2 levels
    // from MCODE_CMD itself (which points to the mcode binary file, not
    // its parent dir) to reach npm's root node_modules.
    const expectedPrefix = join(dirname(MCODE_CMD), "..");
    const found = candidates.some((c) => c.startsWith(expectedPrefix));
    assert.ok(
      found,
      `expected at least one candidate starting with ${expectedPrefix} (MCODE_CMD="${MCODE_CMD}"), got: ${JSON.stringify(candidates)}`,
    );
  });
});
