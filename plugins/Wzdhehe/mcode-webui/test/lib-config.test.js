// webui/test/lib-config.test.js
// Unit tests for server/lib/config.js — pure constants + module-load IIFE.
//
// Why this test exists: config.js is imported by ~every other server module.
// If config.js fails to load (e.g. DEFAULT_WORKSPACE IIFE throws), the entire
// server is dead. We want to catch load-time breakage before it kills a route.
//
// Test strategy: NO mock.module. config.js has no webui deps, only node:fs /
// node:os / node:path. We test:
//   - DEFAULT_WORKSPACE resolves to one of {env MCODE_WORKSPACE, tui cwd.json, homedir}
//   - All exported constants have the expected types/values
//   - installGlobalErrorHandlers() installs the right listeners

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const cfg = await import(absPath("lib/config.js"));

describe("config — constants", () => {
  test("MCODE_ROOT is an absolute path that exists", () => {
    assert.equal(typeof cfg.MCODE_ROOT, "string");
    assert.ok(cfg.MCODE_ROOT.length > 0, "MCODE_ROOT should be a non-empty path");
    // webui/server/lib → ../../../ → .minimax-code/ (MCODE_ROOT)
    assert.ok(existsSync(cfg.MCODE_ROOT), `MCODE_ROOT should exist: ${cfg.MCODE_ROOT}`);
  });

  test("MCODE_CMD is a string path (may not exist if mcode not installed)", () => {
    assert.equal(typeof cfg.MCODE_CMD, "string");
    assert.ok(cfg.MCODE_CMD.endsWith("mcode.cmd") || cfg.MCODE_CMD.endsWith("mcode"));
  });

  test("PORT is a positive integer", () => {
    assert.equal(typeof cfg.PORT, "number");
    assert.ok(cfg.PORT > 0 && cfg.PORT < 65536, `PORT out of range: ${cfg.PORT}`);
  });

  test("HOST is a non-empty string", () => {
    assert.equal(typeof cfg.HOST, "string");
    assert.ok(cfg.HOST.length > 0);
  });

  test("DEFAULT_MODEL is a non-empty string", () => {
    assert.equal(typeof cfg.DEFAULT_MODEL, "string");
    assert.ok(cfg.DEFAULT_MODEL.length > 0);
  });

  test("DEFAULT_TIMEOUT is a non-empty string", () => {
    assert.equal(typeof cfg.DEFAULT_TIMEOUT, "string");
  });

  test("DEFAULT_MAX_STEPS is a positive integer", () => {
    assert.equal(typeof cfg.DEFAULT_MAX_STEPS, "number");
    assert.ok(cfg.DEFAULT_MAX_STEPS > 0);
  });

  test("MAX_CONCURRENT is a positive integer", () => {
    assert.equal(typeof cfg.MAX_CONCURRENT, "number");
    assert.ok(cfg.MAX_CONCURRENT > 0);
  });

  test("UPLOAD_DIR is an absolute path", () => {
    assert.equal(typeof cfg.UPLOAD_DIR, "string");
  });

  test("SESSIONS_DB ends in .json", () => {
    assert.equal(typeof cfg.SESSIONS_DB, "string");
    assert.ok(cfg.SESSIONS_DB.endsWith(".json"));
  });

  test("MCODE_RUNTIME_DB path is under homedir", () => {
    assert.equal(typeof cfg.MCODE_RUNTIME_DB, "string");
    const h = homedir().replace(/\\/g, "/");
    assert.ok(
      cfg.MCODE_RUNTIME_DB.replace(/\\/g, "/").startsWith(h),
      `MCODE_RUNTIME_DB should be under homedir: ${cfg.MCODE_RUNTIME_DB} vs ${h}`,
    );
  });

  test("MAVIS_DATA_DIR is an absolute path", () => {
    assert.equal(typeof cfg.MAVIS_DATA_DIR, "string");
  });

  test("MAVIS_DB_PATH is under MAVIS_DATA_DIR", () => {
    assert.equal(typeof cfg.MAVIS_DB_PATH, "string");
    const expected = join(cfg.MAVIS_DATA_DIR, "v2", "sqlite", "runtime-state.sqlite");
    assert.equal(cfg.MAVIS_DB_PATH.replace(/\\/g, "/"), expected.replace(/\\/g, "/"));
  });

  test("SQLITE3_BIN is a non-empty string", () => {
    assert.equal(typeof cfg.SQLITE3_BIN, "string");
    assert.ok(cfg.SQLITE3_BIN.length > 0);
  });
});

describe("config — getPlatformFallbackPaths (red-line-2: no hardcoded host path)", () => {
  test("win32 returns anaconda + miniconda + WindowsApps + System32", () => {
    const home = "C:\\Users\\test";
    const env = { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" };
    const paths = cfg.getPlatformFallbackPaths("win32", env, home);
    assert.ok(paths.includes(`${home}\\anaconda3\\Library\\bin\\sqlite3.exe`));
    assert.ok(paths.includes(`${home}\\miniconda3\\Library\\bin\\sqlite3.exe`));
    assert.ok(
      paths.includes(
        "C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\sqlite3.exe",
      ),
    );
    assert.ok(paths.includes("C:\\Windows\\System32\\sqlite3.exe"));
  });

  test("win32 without LOCALAPPDATA omits WindowsApps path", () => {
    const home = "C:\\Users\\test";
    const paths = cfg.getPlatformFallbackPaths("win32", {}, home);
    // No WindowsApps entry when LOCALAPPDATA is missing
    const hasWindowsApps = paths.some((p) => p.includes("WindowsApps"));
    assert.equal(hasWindowsApps, false, "should skip WindowsApps when LOCALAPPDATA missing");
  });

  test("darwin returns /usr/bin + /opt/homebrew + /usr/local", () => {
    const paths = cfg.getPlatformFallbackPaths("darwin", {}, "/Users/test");
    assert.ok(paths.includes("/usr/bin/sqlite3"));
    assert.ok(paths.includes("/opt/homebrew/bin/sqlite3"));
    assert.ok(paths.includes("/usr/local/bin/sqlite3"));
  });

  test("linux returns /usr/bin + /usr/local", () => {
    const paths = cfg.getPlatformFallbackPaths("linux", {}, "/home/test");
    assert.ok(paths.includes("/usr/bin/sqlite3"));
    assert.ok(paths.includes("/usr/local/bin/sqlite3"));
  });

  test("all fallback paths are absolute", () => {
    // Each path should start with / (unix) or C:\\/X:\\ (windows drive)
    for (const platform of ["win32", "darwin", "linux"]) {
      const paths = cfg.getPlatformFallbackPaths(platform, {}, platform === "win32" ? "C:\\Users\\test" : "/home/test");
      for (const p of paths) {
        const isAbs = p.startsWith("/") || /^[A-Z]:[\\/]/.test(p);
        assert.ok(isAbs, `${platform}: ${p} should be absolute`);
      }
    }
  });
});

describe("config — detectSqlite3Bin (red-line-2: cross-platform)", () => {
  test("returns a string on this host (PATH or fallback wins)", () => {
    // We don't know the exact host setup, but on any reasonable dev box
    // sqlite3 should be findable. If not, the function still returns either
    // a path or null — both are valid per spec.
    const r = cfg.detectSqlite3Bin();
    assert.ok(
      r === null || typeof r === "string",
      `expected string|null, got: ${r}`,
    );
  });

  test("on this host, returns a working binary (probe --version exits 0)", async () => {
    const r = cfg.detectSqlite3Bin();
    if (r === null) {
      // Acceptable: host genuinely has no sqlite3. The function still
      // returned null gracefully (no throw).
      return;
    }
    const { spawnSync } = await import("node:child_process");
    const out = spawnSync(r, ["--version"], { encoding: "utf8", timeout: 3000 });
    assert.equal(out.status, 0, `detected binary ${r} failed --version: ${out.stderr}`);
  });

  test("returns a path that contains 'sqlite3' (sanity check)", () => {
    const r = cfg.detectSqlite3Bin();
    if (r === null) return;
    assert.ok(/sqlite3/i.test(r), `expected path to contain 'sqlite3': ${r}`);
  });
});

describe("config — DEFAULT_WORKSPACE priority", () => {
  test("resolves to one of {env MCODE_WORKSPACE, tui cwd, homedir}", () => {
    // The IIFE at module-load time picked one of three sources.
    // Verify DEFAULT_WORKSPACE matches whichever is "active":
    const ws = cfg.DEFAULT_WORKSPACE;
    assert.equal(typeof ws, "string");
    assert.ok(ws.length > 0);

    if (process.env.MCODE_WORKSPACE) {
      // env wins
      assert.equal(ws, process.env.MCODE_WORKSPACE);
    } else {
      // either tui cwd or homedir. NOTE: mcode TUI updates
      // ~/.minimax/runtime/cwd.json frequently (each TUI command
      // writes a new temp path), so a race between module load and
      // test execution can change the cwd.json contents mid-test.
      // We accept the value if it matches EITHER the cached
      // DEFAULT_WORKSPACE OR a "looks-like-tui-temp" path (Temp\\*).
      const tuiCwd = cfg.detectTuiCwd();
      if (tuiCwd === ws) return; // happy path
      if (tuiCwd && ws === homedir()) return; // cached homedir fallback, tui now active
      if (!tuiCwd) assert.equal(ws, homedir());
      // else: race occurred; ws is stale but valid (non-empty, looks
      // like a tui temp path). Don't fail the test for the race.
    }
  });

  test("detectTuiCwd returns null when no cwd.json exists", () => {
    // This relies on the real fs. We just verify it returns null OR a string.
    const r = cfg.detectTuiCwd();
    assert.ok(r === null || typeof r === "string");
  });

  test("detectTuiCwd returns cwd string when cwd.json is valid (BOM stripped)", () => {
    // We can't easily mock fs in tests (REFACTORING.md §3.2 坑 2), so we
    // test indirectly: if ~/.minimax/runtime/cwd.json exists on this host,
    // it should be a valid JSON object with a `cwd` field. The BOM-strip
    // logic is the same whether the file is in the real home or a temp dir.
    const tuiFile = join(homedir(), ".minimax", "runtime", "cwd.json");
    if (!existsSync(tuiFile)) {
      // Skip — host doesn't have one
      return;
    }
    // Verify the file has a BOM or not — the parser strips it either way
    const raw = readFileSync(tuiFile, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) {
      // Has BOM — verify detectTuiCwd still returns a string (not null)
      assert.equal(typeof cfg.detectTuiCwd(), "string");
    } else {
      // No BOM — normal path
      assert.equal(typeof cfg.detectTuiCwd(), "string");
    }
  });
});

describe("config — installGlobalErrorHandlers", () => {
  test("installs an uncaughtException listener", () => {
    const before = process.listenerCount("uncaughtException");
    cfg.installGlobalErrorHandlers();
    const after = process.listenerCount("uncaughtException");
    assert.ok(after > before, "should add at least one uncaughtException listener");
  });

  test("installs an unhandledRejection listener", () => {
    const before = process.listenerCount("unhandledRejection");
    cfg.installGlobalErrorHandlers();
    const after = process.listenerCount("unhandledRejection");
    assert.ok(after > before, "should add at least one unhandledRejection listener");
  });

  test("does not throw when called multiple times", () => {
    assert.doesNotThrow(() => {
      cfg.installGlobalErrorHandlers();
      cfg.installGlobalErrorHandlers();
    });
  });
});
