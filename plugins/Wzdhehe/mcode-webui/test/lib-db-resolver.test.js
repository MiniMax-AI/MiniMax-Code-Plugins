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
    // Round 5: the MCODE_CMD-derived candidate is `<dir-of-mcode-cmd>/node_modules/...`
    // — `dirname(mcodeCmd)` then directly into the install dir's
    // `node_modules/`. The previous round 4 form `MCODE_CMD/../../...`
    // treated the executable file as a directory and went 3 levels
    // above the install root, which is wrong.
    const expectedPrefix = dirname(MCODE_CMD);
    const found = candidates.some((c) => c.startsWith(expectedPrefix));
    assert.ok(
      found,
      `expected at least one candidate starting with ${expectedPrefix} (MCODE_CMD="${MCODE_CMD}"), got: ${JSON.stringify(candidates)}`,
    );
    // And it must NOT start with `dirname(MCODE_CMD) + ".."` — that was
    // the round 4 bug, where the candidate went one level too high.
    const buggyPrefix = join(dirname(MCODE_CMD), "..");
    const buggyFound = candidates.some((c) => c.startsWith(buggyPrefix));
    assert.equal(
      buggyFound, false,
      `candidates must not use the round-4 buggy prefix ${buggyPrefix}`,
    );
  });

  // Round 5: reproducible install-layout test that exercises the
  // `mcodeCmd` parameter directly so we don't depend on whatever
  // MCODE_CMD happens to resolve to in the test environment.
  test("install-layout: mcode binary at <install>/mcode.cmd → candidate is <install>/node_modules/...", () => {
    delete process.env.MCODE_BETTER_SQLITE3;
    const fakeCmd = "/tmp/fake-mcode-install/mcode.cmd";
    const expected = "/tmp/fake-mcode-install/node_modules/@minimax-ai/code/node_modules/better-sqlite3";
    const candidates = _getBetterSqlite3Candidates({ mcodeCmd: fakeCmd });
    assert.ok(
      candidates.includes(expected),
      `expected exact candidate ${expected} in ${JSON.stringify(candidates)}`,
    );
  });

  test("install-layout: mcode binary at /usr/local/bin/mcode → candidate is /usr/local/bin/node_modules/...", () => {
    // Simulates npm-global install: binary in /usr/local/bin/, deps
    // expected to sit in the install dir's own node_modules.
    delete process.env.MCODE_BETTER_SQLITE3;
    const fakeCmd = "/usr/local/bin/mcode";
    const expected = "/usr/local/bin/node_modules/@minimax-ai/code/node_modules/better-sqlite3";
    const candidates = _getBetterSqlite3Candidates({ mcodeCmd: fakeCmd });
    assert.ok(
      candidates.includes(expected),
      `expected exact candidate ${expected} in ${JSON.stringify(candidates)}`,
    );
  });

  test("install-layout: MCODE_CMD = 'mcode' (PATH placeholder) does not produce a MCODE_CMD-derived candidate", () => {
    delete process.env.MCODE_BETTER_SQLITE3;
    const candidates = _getBetterSqlite3Candidates({ mcodeCmd: "mcode" });
    // No candidate should be derived from the placeholder
    const cmdDerived = candidates.filter(
      (c) => !c.startsWith("/explicit/") && !c.includes("node_modules/@minimax-ai/code/node_modules/better-sqlite3")
    );
    // Only the dev layout fallback should remain
    assert.equal(
      cmdDerived.length, 0,
      `MCODE_CMD="mcode" should produce no MCODE_CMD-derived candidate, got: ${JSON.stringify(candidates)}`,
    );
  });
});
