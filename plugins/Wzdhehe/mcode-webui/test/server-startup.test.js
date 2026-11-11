// webui/test/server-startup.test.js
// Smoke test for server.js bootstrap. Catches ESM load-time blockers
// like the one the reviewer found: server.js imported setTokenAuthEnabled
// from auth.js, but auth.js didn't export it. Unit tests don't catch this
// because they import individual modules in isolation — the real
// server.js bootstrap (which exercises the full import graph) is never
// tested.
//
// Strategy: spawn `node server.js`, wait briefly, then SIGTERM. If
// startup failed, the node process will exit early with an ESM error
// BEFORE our kill — we see it in stderr. If startup succeeded, the
// process is still listening and our SIGTERM gives a clean exit.
//
// v2 (Lease C08, ANTI-PATTERNS-FIX-PLAN §AP1): additional sub-tests
// assert that the 14-line ASCII token box is GONE from stdout on
// first-ever boot (settings.json absent + no TOKEN env). The SSE
// `token.first_run` event is what the UI now uses — see state-bus.js
// + auth.js#markFirstRunNotified. The `MCODE_WEBUI_TOKEN_STDOUT=1`
// fallback is verified to print a single neutral line that contains
// the persist path but NEVER the raw 32-hex token.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverJsPath = join(__dirname, "..", "server.js");

// C08 helper: spawn server.js with a fresh settings.json path so
// init() takes the "first run" branch (generate + persist + printToken).
// Waits up to 2s for startup, returns { stdout, stderr, ok }.
//
// Uses PORT=18080 + 18081 to avoid colliding with the default 8080
// (which is often already taken on dev machines running a real webui
// or another test's lingering process). The port stays in the kernel
// "high enough" range to avoid root-privileged port surprises.
async function _spawnFirstRun({ tokenStdout, port } = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "mcode-webui-c08-"));
  const settingsPath = join(tmpDir, "settings.json");
  // Defensive: file must NOT pre-exist. mkdtempSync creates the dir
  // only; we never write settings.json here, init() does that.
  assert.equal(existsSync(settingsPath), false, "fresh tmpDir should have no settings.json");
  // Two tests run sequentially so pick distinct ports to avoid the
  // TIME_WAIT race that hits even after SIGTERM. Picked in the
  // high (root-safe) range. If a port is also busy on this machine
  // the test will fail loudly with EADDRINUSE — that's the desired
  // signal, not a silent skip.
  const usePort = port || 18080;
  const env = {
    ...process.env,
    TOKEN: "",
    MCODE_WEBUI_SETTINGS_PATH: settingsPath,
    // U1 (2026-09-20 rigor fix): the first-run sub-tests booted the real
    // server.js without redirecting the upload dir / events path — same
    // stray-.webui-uploads pollution the bootstrap sub-test above already
    // redirects. All three land in the per-test tmpDir, which is rmSync'd
    // at the end of this helper.
    MCODE_WEBUI_UPLOAD_DIR: join(tmpDir, "uploads"),
    MCODE_WEBUI_EVENTS_PATH: join(tmpDir, "events.ndjson"),
    MCODE_WEBUI_SESSIONS_DB: join(tmpDir, "sessions.json"),
    PORT: String(usePort),
  };
  if (tokenStdout !== undefined) env.MCODE_WEBUI_TOKEN_STDOUT = tokenStdout;
  // Belt-and-braces: some test runners set TOKEN=... in their env;
  // make sure first-run branch is reached by explicitly unsetting it.
  delete env.TOKEN;
  const proc = spawn("node", [serverJsPath], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: join(__dirname, ".."),
    env,
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => (stdout += d.toString()));
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  const exited = new Promise((resolve) => {
    proc.on("exit", (code, signal) => resolve({ code, signal }));
  });
  const earlyExit = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
  ]);
  let ok = true;
  let failReason = "";
  if (earlyExit !== null) {
    ok = false;
    failReason = `server.js exited early: code=${earlyExit.code} signal=${earlyExit.signal}\nstdout: ${stdout}\nstderr: ${stderr}`;
  }
  // Read the persisted settings.json so callers can inspect the token
  // (which MUST NOT appear in stdout).
  let persistedToken = "";
  try {
    const body = JSON.parse(readFileSync(settingsPath, "utf8"));
    persistedToken = body && typeof body.currentToken === "string" ? body.currentToken : "";
  } catch {}
  // SIGTERM and wait for clean exit before returning.
  if (ok) {
    proc.kill("SIGTERM");
    await exited;
  } else {
    try { proc.kill("SIGKILL"); } catch {}
  }
  // Best-effort tmp cleanup. mkdtempSync left a settings.json behind;
  // rmSync recursive is safe.
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  return { stdout, stderr, ok, failReason, persistedToken };
}

test("server.js bootstrap does not throw ESM load-time error", async () => {
  // G03: pin to a high port so the bootstrap test doesn't conflict with
  //   port 8080 (default in config.js) when some other process already
  //   holds it — common on shared CI runners and any machine that has
  //   another webui instance running. The test's intent is "server.js
  //   imports succeed and the process reaches 'listening on'", not
  //   "listens on 8080 specifically". 18082 keeps the high-port
  //   convention used by the C08 sub-tests (18080 / 18081) so a single
  //   operator can see the pattern at a glance.
  const proc = spawn("node", [serverJsPath], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: "18082",
      TOKEN: "",
      // Redirect upload dir away from MCODE_ROOT — otherwise server.js
      // mkdirSync(UPLOAD_DIR, {recursive: true}) creates a stray
      // .webui-uploads/ inside the plugin tree that survives `git status
      // --ignored` and breaks marketplace validate.mjs on tar+siinfer CI.
      MCODE_WEBUI_UPLOAD_DIR: "/tmp/mcode-webui-test-uploads",
      MCODE_WEBUI_SETTINGS_PATH: "/tmp/mcode-webui-test-settings.json",
      MCODE_WEBUI_EVENTS_PATH: "/tmp/mcode-webui-test-events.ndjson",
    },
  });

  let stderr = "";
  let stdout = "";
  proc.stdout.on("data", (d) => (stdout += d.toString()));
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  const exited = new Promise((resolve) => {
    proc.on("exit", (code, signal) => resolve({ code, signal }));
  });

  // Wait up to 2s — if the process exits on its own before then,
  // it almost certainly failed at load time.
  const earlyExit = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
  ]);

  if (earlyExit !== null) {
    // Process died before we could kill it — startup failure.
    assert.fail(
      `server.js exited early (code=${earlyExit.code}, signal=${earlyExit.signal}). ` +
        `stderr:\n${stderr}\nstdout:\n${stdout}`
    );
  }

  // Still running after 2s → server is listening. Kill it cleanly.
  proc.kill("SIGTERM");
  await exited;

  // After kill, expect SIGTERM (signal='SIGTERM' or code=null/143).
  // We don't assert on the kill exit code (CI noise), only that stderr
  // has no ESM errors and stdout shows the listening message.
  assert.ok(
    !/Cannot find module|MODULE_NOT_FOUND|SyntaxError/.test(stderr),
    `server.js stderr contains load-time errors:\n${stderr}`
  );
  assert.ok(
    /listening on/.test(stdout),
    `server.js did not reach "listening on" within 2s. stdout:\n${stdout}\nstderr:\n${stderr}`
  );
});

// ============================================================
// C08 §AP1: first-run does NOT print the 14-line ASCII box
// ============================================================

test("C08: first-run does not print 14-line ASCII token box to stdout", async () => {
  const { stdout, stderr, ok, failReason, persistedToken } = await _spawnFirstRun({
    tokenStdout: undefined, // default: TOKEN_STDOUT=0 (silent)
    port: 18080,
  });
  assert.ok(ok, failReason);
  // No stderr errors
  assert.ok(
    !/Cannot find module|MODULE_NOT_FOUND|SyntaxError/.test(stderr),
    `first-run stderr contains load-time errors:\n${stderr}`
  );
  // The 14-line ASCII box sentinels must NOT appear in stdout.
  assert.ok(
    !/webui 首次启动/.test(stdout),
    `first-run stdout should not contain "webui 首次启动" (SSE ` +
      `token.first_run is the new path; the box is gone). Got:\n${stdout}`
  );
  // The raw token must NEVER appear in stdout (32 hex chars).
  if (persistedToken) {
    assert.ok(
      !stdout.includes(persistedToken),
      `first-run stdout should NOT contain the raw token. ` +
        `Token length=${persistedToken.length}; stdout:\n${stdout}`
    );
  }
  // The ASCII separator line `===...===` must not appear.
  // (only line 60-65 chars wide to match the original box header).
  assert.ok(
    !/={20,}/.test(stdout),
    `first-run stdout should not contain ASCII separator ` +
      `(the old box border). Got:\n${stdout}`
  );
  // The "提示:" hint line must not appear either.
  assert.ok(
    !/提示:/.test(stdout),
    `first-run stdout should not contain the old "提示:" hint line. ` +
      `Got:\n${stdout}`
  );
});

test("C08: first-run with TOKEN_STDOUT=1 prints single neutral line + NO raw token", async () => {
  const { stdout, stderr, ok, failReason, persistedToken } = await _spawnFirstRun({
    tokenStdout: "1",
    port: 18081,
  });
  assert.ok(ok, failReason);
  // Should print exactly the neutral line.
  assert.ok(
    /token persisted to:/.test(stdout),
    `TOKEN_STDOUT=1 stdout should contain the neutral ` +
      `"token persisted to: <path>" line. Got:\n${stdout}`
  );
  // But the raw token must NEVER appear even with TOKEN_STDOUT=1.
  if (persistedToken) {
    assert.ok(
      !stdout.includes(persistedToken),
      `TOKEN_STDOUT=1 stdout should NOT contain the raw token ` +
      `(defence-in-depth: even with the fallback, the raw value is ` +
      `never echoed). Token length=${persistedToken.length}; stdout:\n${stdout}`
    );
  }
  // And the old box markers must be gone even in fallback mode.
  assert.ok(
    !/webui 首次启动/.test(stdout),
    `TOKEN_STDOUT=1 stdout should not contain the old "webui 首次启动" line. ` +
      `Got:\n${stdout}`
  );
  assert.ok(
    !/={20,}/.test(stdout),
    `TOKEN_STDOUT=1 stdout should not contain ASCII separator ` +
      `(the old box border). Got:\n${stdout}`
  );
});
