// webui/test/lib-mcode-exec.test.js
// Unit tests for server/lib/mcode-exec.js — mcode CLI resolution +
// exec argv assembly.
//
// Security context (PR #55 / CodeQL): mcode-exec used to route the
// environment/PATH-resolved MCODE_CMD through a Windows shell
// trampoline (`/c <MCODE_CMD> ...`) on every platform. It now
// resolves the CLI itself and spawns it directly. These tests pin
// that contract:
//   - a .cmd shim resolves to process.execPath + the sibling
//     node_modules/@minimax-ai/code/cli.js entry, never a shell;
//   - shim file-name matching is case-insensitive (PATHEXT casing is
//     not guaranteed — case-sensitive Linux CI broke on that before);
//   - nothing resolvable => throws (fail-closed), no fallback;
//   - buildExecArgs keeps the exec flag surface unchanged.
//
// Fixtures are plain fake files in tmpdirs; nothing real is spawned.
// `platform`/`env` are injected so the win32 probing branches are
// exercised deterministically on any host OS.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const absPath = (rel) => pathToFileURL(join(TEST_DIR, "..", "server", rel)).href;

const mcodeExec = await import(absPath("lib/mcode-exec.js"));
const { resolveMcodeSpawn, buildExecArgs } = mcodeExec;

// Fixture factory: a fake install dir containing <shimName> plus the
// sibling node_modules/@minimax-ai/code/cli.js entry that real mcode
// shims live next to. Returns absolute paths for both.
function makeFakeInstall(shimName = "mcode.cmd") {
  const root = mkdtempSync(join(tmpdir(), "mcode-exec-test-"));
  writeFileSync(join(root, shimName), "@echo off\r\nrem fake shim\r\n");
  const entry = join(root, "node_modules", "@minimax-ai", "code", "cli.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, "// fake cli entry\n");
  return { root, shim: join(root, shimName), entry };
}

// The invariant under test everywhere below: the resolved spawn spec
// must run Node directly on the cli.js entry — a shell binary or a
// `/c` flag anywhere in it is a regression of the PR #55 fix.
function assertNoShell(r) {
  assert.notEqual(r.command.toLowerCase(), "cmd.exe");
  assert.notEqual(r.command.toLowerCase(), "cmd");
  assert.equal(r.args.includes("/c"), false);
  assert.equal(r.args.includes("/C"), false);
}

// --- resolveMcodeSpawn: .cmd shim -----------------------------------------

describe("resolveMcodeSpawn — .cmd shim on PATH (win32 probing)", () => {
  test("bare name + PATHEXT resolves to execPath + sibling cli.js", () => {
    const { root, entry } = makeFakeInstall("mcode.cmd");
    const r = resolveMcodeSpawn("mcode", {
      platform: "win32",
      env: { PATH: root, PATHEXT: ".EXE;.CMD" },
    });
    assert.equal(r.command, process.execPath);
    assert.equal(r.args.length, 1);
    assert.ok(isAbsolute(r.args[0]), "entry must be an absolute path");
    assert.equal(r.args[0], entry);
    assertNoShell(r);
  });

  test("default PATHEXT list applies when env omits PATHEXT", () => {
    const { root, entry } = makeFakeInstall("mcode.cmd");
    const r = resolveMcodeSpawn("mcode", {
      platform: "win32",
      env: { PATH: root },
    });
    assert.equal(r.command, process.execPath);
    assert.equal(r.args[0], entry);
    assertNoShell(r);
  });

  test("PATHEXT casing differs from on-disk casing — shim still matches", () => {
    // Disk has lowercase mcode.cmd; PATHEXT only offers uppercase .CMD.
    // Case-insensitive probing must bridge the two (the Linux-CI trap).
    const { root, entry } = makeFakeInstall("mcode.cmd");
    const r = resolveMcodeSpawn("mcode", {
      platform: "win32",
      env: { PATH: root, PATHEXT: ".COM;.EXE;.CMD" },
    });
    assert.equal(r.command, process.execPath);
    assert.equal(r.args[0], entry);
    assertNoShell(r);
  });

  test("uppercase shim file on disk matches lowercase PATHEXT entry", () => {
    const { root, entry } = makeFakeInstall("MCODE.CMD");
    const r = resolveMcodeSpawn("mcode", {
      platform: "win32",
      env: { PATH: root, PATHEXT: ".cmd;.bat" },
    });
    assert.equal(r.command, process.execPath);
    assert.equal(r.args[0], entry);
    assertNoShell(r);
  });

  test(".bat shim is treated the same as .cmd", () => {
    const { root, entry } = makeFakeInstall("mcode.bat");
    const r = resolveMcodeSpawn("mcode", {
      platform: "win32",
      env: { PATH: root, PATHEXT: ".CMD;.BAT" },
    });
    assert.equal(r.command, process.execPath);
    assert.equal(r.args[0], entry);
    assertNoShell(r);
  });
});

describe("resolveMcodeSpawn — direct paths (config.js layouts)", () => {
  test("absolute path to a .cmd shim resolves to execPath + cli.js", () => {
    // config.js supplies absolute MCODE_CMD values from the repo /
    // home layouts — those must bypass PATH probing and land on Node.
    const { shim, entry } = makeFakeInstall("mcode.cmd");
    const r = resolveMcodeSpawn(shim, { platform: "win32", env: {} });
    assert.equal(r.command, process.execPath);
    assert.equal(r.args[0], entry);
    assertNoShell(r);
  });

  test("absolute path to a plain (non-shim) binary spawns it directly", () => {
    const root = mkdtempSync(join(tmpdir(), "mcode-exec-plain-"));
    const bin = join(root, "mcode");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    const r = resolveMcodeSpawn(bin, { platform: "linux", env: {} });
    assert.equal(r.command, bin);
    assert.equal(r.args.length, 0);
    assertNoShell(r);
  });
});

describe("resolveMcodeSpawn — POSIX bare name", () => {
  test("resolves to the PATH file itself, no entry rewriting", () => {
    const root = mkdtempSync(join(tmpdir(), "mcode-exec-posix-"));
    writeFileSync(join(root, "mcode"), "#!/bin/sh\nexec node entry \"$@\"\n");
    // U5 (fork-preview run 35495306680): resolveMcodeSpawn splits PATH on
    // the HOST delimiter when the injected platform is not win32, so the
    // fixture must join entries with node:path's delimiter — a hardcoded
    // ":" never matches on a win32 host (";" there) and the probe dies
    // with cannot-resolve before the no-entry-rewriting assertion.
    const r = resolveMcodeSpawn("mcode", {
      platform: "linux",
      env: { PATH: "/nonexistent-first" + delimiter + root },
    });
    assert.equal(r.command, join(root, "mcode"));
    assert.equal(r.args.length, 0);
    assertNoShell(r);
  });
});

// --- resolveMcodeSpawn: fail-closed ---------------------------------------

describe("resolveMcodeSpawn — fail-closed", () => {
  test("bare name not on PATH throws (no shell fallback)", () => {
    const empty = mkdtempSync(join(tmpdir(), "mcode-exec-empty-"));
    assert.throws(
      () =>
        resolveMcodeSpawn("mcode", { platform: "linux", env: { PATH: empty } }),
      /cannot resolve mcode CLI/,
    );
  });

  test("empty MCODE_CMD throws", () => {
    assert.throws(
      () => resolveMcodeSpawn("", { platform: "linux", env: {} }),
      /MCODE_CMD is empty/,
    );
  });

  test(".cmd shim without sibling cli.js throws (broken install)", () => {
    const root = mkdtempSync(join(tmpdir(), "mcode-exec-nosibling-"));
    writeFileSync(join(root, "mcode.cmd"), "@echo off\r\n");
    assert.throws(
      () => resolveMcodeSpawn(join(root, "mcode.cmd"), { platform: "win32", env: {} }),
      /is missing/,
    );
  });

  test("win32 bare name with nothing on PATH throws", () => {
    const empty = mkdtempSync(join(tmpdir(), "mcode-exec-emptywin-"));
    assert.throws(
      () =>
        resolveMcodeSpawn("mcode", {
          platform: "win32",
          env: { PATH: empty, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        }),
      /cannot resolve mcode CLI/,
    );
  });
});

// --- buildExecArgs: exec flag surface (regression pin) ---------------------

describe("buildExecArgs — exec flag surface", () => {
  test("assembles the documented flag order with explicit values", () => {
    assert.deepEqual(
      buildExecArgs({
        workspace: "/tmp/ws",
        model: "minimax_api/MiniMax-M3",
        timeout: "120s",
        maxSteps: 6,
        permission: "ask",
        sessionId: null,
      }),
      [
        "exec",
        "--input",
        "-",
        "--input-format",
        "text",
        "--cwd",
        "/tmp/ws",
        "--permission",
        "ask",
        "--timeout",
        "120s",
        "--output-format",
        "stream-json",
        "--max-steps",
        "6",
        "--model",
        "minimax_api/MiniMax-M3",
      ],
    );
  });

  test("sessionId appends --session <id> at the tail", () => {
    const a = buildExecArgs({ sessionId: "sid-123" });
    assert.deepEqual(a.slice(-2), ["--session", "sid-123"]);
    assert.equal(a.filter((x) => x === "--session").length, 1);
  });

  test("falsy sessionId omits --session entirely", () => {
    const a = buildExecArgs({ sessionId: null });
    assert.equal(a.includes("--session"), false);
  });

  test("numeric maxSteps is stringified", () => {
    const a = buildExecArgs({ maxSteps: 12 });
    assert.equal(a[a.indexOf("--max-steps") + 1], "12");
  });

  test("defaults keep every exec flag present", () => {
    const a = buildExecArgs({});
    for (const flag of [
      "--input",
      "--input-format",
      "--cwd",
      "--permission",
      "--timeout",
      "--output-format",
      "--max-steps",
      "--model",
    ]) {
      assert.ok(a.includes(flag), `missing ${flag}`);
    }
    assert.equal(a[0], "exec");
  });
});

// --- source-level invariant: no shell trampoline in mcode-exec.js ---------

describe("mcode-exec source — shell eradication", () => {
  const src = readFileSync(fileURLToPath(absPath("lib/mcode-exec.js")), "utf8");

  test("no cmd.exe / shell spawn literal anywhere in the module", () => {
    assert.equal(
      src.toLowerCase().includes("cmd.exe"),
      false,
      "mcode-exec.js must not mention or spawn cmd.exe (F4 grep invariant)",
    );
    assert.equal(src.includes('spawn("cmd'), false);
    assert.equal(src.includes("spawn('cmd"), false);
    assert.equal(src.includes('spawn("shell'), false);
  });

  test("spawn call sites pass a resolved command, never a shell flag prefix", () => {
    // The only spawn in the module must use resolved.command with the
    // resolved.args prefix (no hardcoded first arg).
    assert.match(src, /spawn\(resolved\.command,\s*args,/);
  });
});
