// webui/test/lib-db-resolver.test.js
// Tests for the better-sqlite3 candidate path resolver added in
// v1.0.1 round 4. Reviewer (modacker) found the hard-coded
// `__dirname/../../../node_modules/...` path only works in the
// canonical dev layout (<mcode-root>/webui/server/lib/). Round 4
// adds a candidates list with priority: env override > MCODE_CMD
// derived > dev layout fallback.
// C01 (round 7): add 3 install-layout scenarios covering the new
// `~/.mcode-webui/db-resolver.json` user-pinned tier + per-tier
// ordering assertions for macOS / Linux / Windows install shapes.
//
// We only test the *shape* of the candidate list here, not the
// actual sqlite3 load (that requires a real binary + mcode install
// state and is covered by the existing integration tests).

import { test, describe, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    rmSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import {
    _getBetterSqlite3Candidates,
    _loadUserResolverConfig,
} from "../server/lib/db.js";
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
    // U5 (fork-preview run 35495306680): build the expected candidate with
    // the host path module — the resolver joins with host separators, so a
    // forward-slash literal only holds on POSIX.
    const expected = join(
      dirname(fakeCmd),
      "node_modules", "@minimax-ai", "code", "node_modules", "better-sqlite3",
    );
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
    // U5: host-path construction — see the mcode.cmd test above.
    const expected = join(
      dirname(fakeCmd),
      "node_modules", "@minimax-ai", "code", "node_modules", "better-sqlite3",
    );
    const candidates = _getBetterSqlite3Candidates({ mcodeCmd: fakeCmd });
    assert.ok(
      candidates.includes(expected),
      `expected exact candidate ${expected} in ${JSON.stringify(candidates)}`,
    );
  });

  test("install-layout: MCODE_CMD = 'mcode' (PATH placeholder) does not produce a MCODE_CMD-derived candidate", () => {
    delete process.env.MCODE_BETTER_SQLITE3;
    const candidates = _getBetterSqlite3Candidates({ mcodeCmd: "mcode" });
    // U5: compare path segments, not forward-slash substrings — the
    // resolver emits host-separator paths, so a "node_modules/@..."-
    // substring test misses them on win32 (2 !== 0 in the fork-preview
    // run). Same semantics: every remaining candidate must be a
    // layout-shaped better-sqlite3 path, nothing MCODE_CMD-derived.
    const BSQLITE3_TAIL = [
      "node_modules", "@minimax-ai", "code", "node_modules", "better-sqlite3",
    ];
    const endsWithSqlite3Tail = (c) => {
      const segs = c.split(/[\\/]/);
      const off = segs.length - BSQLITE3_TAIL.length;
      return off >= 0 && BSQLITE3_TAIL.every((s, i) => segs[off + i] === s);
    };
    const cmdDerived = candidates.filter(
      (c) => !c.startsWith("/explicit/") && !endsWithSqlite3Tail(c),
    );
    // Only the built-in layout-shaped candidates should remain
    assert.equal(
      cmdDerived.length, 0,
      `MCODE_CMD="mcode" should produce no MCODE_CMD-derived candidate, got: ${JSON.stringify(candidates)}`,
    );
  });

  // Round 6: standard install location candidate (the one that
  // actually fires on macOS dev boxes where ~/.minimax-code/lib/
  // holds mcode's bundled deps).
  test("install-layout: standard ~/.minimax-code/lib/node_modules/... is always tried", () => {
    delete process.env.MCODE_BETTER_SQLITE3;
    const home = "/Users/example";
    const candidates = _getBetterSqlite3Candidates({ home });
    // U5: host-path construction — mirrors the resolver's own tier-4a join.
    const expected = join(
      home, ".minimax-code", "lib",
      "node_modules", "@minimax-ai", "code", "node_modules", "better-sqlite3",
    );
    assert.ok(
      candidates.includes(expected),
      `expected standard install candidate ${expected} in ${JSON.stringify(candidates)}`,
    );
  });

  test("install-layout: mcode at <root>/bin/mcode emits BOTH npm-style and flat candidates", () => {
    delete process.env.MCODE_BETTER_SQLITE3;
    const fakeCmd = "/opt/mcode/bin/mcode";
    const candidates = _getBetterSqlite3Candidates({ mcodeCmd: fakeCmd });
    // U5: mirror the resolver's own construction (host separators) —
    // forward-slash literals only hold on POSIX.
    // npm-style: <root>/lib/node_modules/...
    const npmStyle = join(
      dirname(fakeCmd), "..", "lib",
      "node_modules", "@minimax-ai", "code", "node_modules", "better-sqlite3",
    );
    // flat: <root>/node_modules/...
    const flat = join(
      dirname(fakeCmd),
      "node_modules", "@minimax-ai", "code", "node_modules", "better-sqlite3",
    );
    assert.ok(
      candidates.includes(npmStyle),
      `expected npm-style candidate ${npmStyle} in ${JSON.stringify(candidates)}`,
    );
    assert.ok(
      candidates.includes(flat),
      `expected flat candidate ${flat} in ${JSON.stringify(candidates)}`,
    );
  });
});

// C01 (round 7): 3 install-layout scenarios covering the new
// `~/.mcode-webui/db-resolver.json` user-pinned tier and the
// cross-platform priority assertions (macOS default, Linux with
// MCODE_CMD, Windows with $MCODE_BETTER_SQLITE3 env override).
//
// Each test uses a tmp dir to write a real db-resolver.json file so
// we exercise the readFileSync + JSON.parse code path, not just the
// `home` parameter. After the test, tmp dirs are rmSync'd to keep
// the test environment clean.
describe("db.js — C01 install-layout scenarios (user resolver config + tier ordering)", () => {
  let savedEnvPath;
  let savedResolverEnv;
  let tmpHome;

  before(() => {
    savedEnvPath = process.env.MCODE_BETTER_SQLITE3;
    savedResolverEnv = process.env.MCODE_WEBUI_RESOLVER_JSON;
  });
  after(() => {
    if (savedEnvPath === undefined) delete process.env.MCODE_BETTER_SQLITE3;
    else process.env.MCODE_BETTER_SQLITE3 = savedEnvPath;
    if (savedResolverEnv === undefined) delete process.env.MCODE_WEBUI_RESOLVER_JSON;
    else process.env.MCODE_WEBUI_RESOLVER_JSON = savedResolverEnv;
    if (tmpHome) {
      try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
      tmpHome = null;
    }
  });

  // — Scenario 1: macOS default —
  // ~/.mcode-webui/ is writable; user has written a db-resolver.json
  // pointing at a known-good path. Tier 3 must pick that path up.
  test("macOS default: ~/.mcode-webui/db-resolver.json is loaded (tier 3)", () => {
    delete process.env.MCODE_BETTER_SQLITE3;
    delete process.env.MCODE_WEBUI_RESOLVER_JSON;
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = mkdtempSync(join(tmpdir(), "mcode-resolver-mac-"));
    // Real fs write: ~/<tmp>/.mcode-webui/db-resolver.json
    const cfgDir = join(tmpHome, ".mcode-webui");
    mkdirSync(cfgDir, { recursive: true });
    const cfgPath = join(cfgDir, "db-resolver.json");
    const userPinnedPath = "/Users/dev/.local/share/better-sqlite3/better-sqlite3";
    writeFileSync(
      cfgPath,
      JSON.stringify({ better_sqlite3_candidates: [userPinnedPath] }),
    );
    const candidates = _getBetterSqlite3Candidates({ home: tmpHome });
    assert.ok(
      candidates.includes(userPinnedPath),
      `expected user-pinned path ${userPinnedPath} in tier 3 candidates: ${JSON.stringify(candidates)}`,
    );
    // Sanity: tier 3 sits BEFORE the built-in home layout, but AFTER
    // any MCODE_CMD-derived tier. Verify by index ordering.
    const idx = candidates.indexOf(userPinnedPath);
    // home layout candidate is the LAST-but-one entry (dev layout
    // comes after). user-pinned must precede the home layout.
    const homeLayoutCandidate = join(
      tmpHome, ".minimax-code", "lib",
      "node_modules", "@minimax-ai", "code", "node_modules", "better-sqlite3",
    );
    const homeIdx = candidates.indexOf(homeLayoutCandidate);
    assert.ok(
      idx >= 0 && homeIdx >= 0 && idx < homeIdx,
      `user-pinned path must appear before home layout in candidate list, got user@${idx} home@${homeIdx}: ${JSON.stringify(candidates)}`,
    );
  });

  // — Scenario 2: Linux with MCODE_CMD —
  // /usr/local/bin/mcode is the npm-global install. Tier 2 must
  // reverse-derive BOTH the npm-style (../lib/node_modules/...) and
  // the flat (sibling node_modules/...) variants.
  test("Linux npm-global: /usr/local/bin/mcode reverse-derives BOTH npm-style + flat (tier 2)", () => {
    delete process.env.MCODE_BETTER_SQLITE3;
    delete process.env.MCODE_WEBUI_RESOLVER_JSON;
    const fakeCmd = "/usr/local/bin/mcode";
    // U5: mirror the resolver's own construction (host separators) —
    // forward-slash literals only hold on POSIX.
    // npm-style: dirname(/usr/local/bin/mcode) + .. + lib + ...
    const npmStyle = join(
      dirname(fakeCmd), "..", "lib",
      "node_modules", "@minimax-ai", "code", "node_modules", "better-sqlite3",
    );
    // flat: dirname(/usr/local/bin/mcode) + node_modules/...
    const flat = join(
      dirname(fakeCmd),
      "node_modules", "@minimax-ai", "code", "node_modules", "better-sqlite3",
    );
    const candidates = _getBetterSqlite3Candidates({ mcodeCmd: fakeCmd });
    assert.ok(
      candidates.includes(npmStyle),
      `expected Linux npm-style candidate ${npmStyle} in: ${JSON.stringify(candidates)}`,
    );
    assert.ok(
      candidates.includes(flat),
      `expected Linux flat candidate ${flat} in: ${JSON.stringify(candidates)}`,
    );
    // Tier 2 entries must come BEFORE any built-in tier 4 entry.
    // Use real homedir() so the home-layout candidate is predictable.
    const npmStyleIdx = candidates.indexOf(npmStyle);
    const homeLayout = join(
      homedir(), ".minimax-code", "lib",
      "node_modules", "@minimax-ai", "code", "node_modules", "better-sqlite3",
    );
    const homeIdx = candidates.indexOf(homeLayout);
    assert.ok(
      npmStyleIdx >= 0 && homeIdx >= 0 && npmStyleIdx < homeIdx,
      `tier 2 candidate must precede built-in home layout (npmStyle@${npmStyleIdx} home@${homeIdx})`,
    );
  });

  // — Scenario 3: Windows with $MCODE_BETTER_SQLITE3 env —
  // env override must win over every other tier regardless of MCODE_CMD
  // shape or any user resolver config that might also be present.
  test("Windows: $MCODE_BETTER_SQLITE3 env wins over MCODE_CMD + user resolver (tier 1)", () => {
    // Inject a user resolver config too, to prove env beats it.
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = mkdtempSync(join(tmpdir(), "mcode-resolver-win-"));
    const cfgDir = join(tmpHome, ".mcode-webui");
    mkdirSync(cfgDir, { recursive: true });
    // The user-pinned path lives inside tmpHome so the resolver.json
    // lookup succeeds regardless of platform.
    const userPinned = join(tmpHome, "user-pinned-better-sqlite3");
    writeFileSync(
      join(cfgDir, "db-resolver.json"),
      JSON.stringify({ better_sqlite3_candidates: [userPinned] }),
    );
    // Windows-shaped env + mcodeCmd paths. The candidate list uses
    // backslashes verbatim (no normalization) so the assertions are
    // platform-independent.
    const envPath = "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\better-sqlite3\\better-sqlite3";
    process.env.MCODE_BETTER_SQLITE3 = envPath;
    delete process.env.MCODE_WEBUI_RESOLVER_JSON;
    const candidates = _getBetterSqlite3Candidates({
      mcodeCmd: "C:\\Users\\dev\\AppData\\Roaming\\npm\\mcode.cmd",
      home: tmpHome, // point home at the tmp dir so the resolver.json is found
    });
    assert.equal(
      candidates[0], envPath,
      `env override must be the FIRST candidate, got: ${JSON.stringify(candidates)}`,
    );
    // The user resolver entry must STILL be present (env didn't replace
    // it; it just precedes it). Verifies env is prepended, not exclusive.
    assert.ok(
      candidates.includes(userPinned),
      `user resolver entry should still be tried (after env): ${JSON.stringify(candidates)}`,
    );
  });

  // — Scenario 4 (bonus): _loadUserResolverConfig reads real json —
  // Sanity test on the helper itself: missing file → [], valid file → paths,
  // malformed JSON → []. This isn't strictly required but covers the
  // "fail open" semantics of the loader.
  test("_loadUserResolverConfig: missing file → [], valid → paths, malformed → []", () => {
    // Missing: fresh tmp home with no .mcode-webui
    const freshHome = mkdtempSync(join(tmpdir(), "mcode-resolver-empty-"));
    try {
      assert.deepEqual(
        _loadUserResolverConfig({ home: freshHome }),
        [],
        "missing db-resolver.json should yield empty array",
      );
    } finally {
      rmSync(freshHome, { recursive: true, force: true });
    }
    // Valid: write a json with 2 entries
    const cfgHome = mkdtempSync(join(tmpdir(), "mcode-resolver-valid-"));
    try {
      mkdirSync(join(cfgHome, ".mcode-webui"), { recursive: true });
      writeFileSync(
        join(cfgHome, ".mcode-webui", "db-resolver.json"),
        JSON.stringify({
          better_sqlite3_candidates: ["/path/a", "/path/b", 42, null, ""],
        }),
      );
      const out = _loadUserResolverConfig({ home: cfgHome });
      assert.deepEqual(
        out,
        ["/path/a", "/path/b"],
        "should keep strings, drop non-strings and empties",
      );
    } finally {
      rmSync(cfgHome, { recursive: true, force: true });
    }
    // Malformed: bad JSON
    const badHome = mkdtempSync(join(tmpdir(), "mcode-resolver-bad-"));
    try {
      mkdirSync(join(badHome, ".mcode-webui"), { recursive: true });
      writeFileSync(
        join(badHome, ".mcode-webui", "db-resolver.json"),
        "{ not valid json :::",
      );
      assert.deepEqual(
        _loadUserResolverConfig({ home: badHome }),
        [],
        "malformed JSON should fail open to []",
      );
    } finally {
      rmSync(badHome, { recursive: true, force: true });
    }
  });
});
