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

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverJsPath = join(__dirname, "..", "server.js");

test("server.js bootstrap does not throw ESM load-time error", async () => {
  const proc = spawn("node", [serverJsPath], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: join(__dirname, ".."),
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
