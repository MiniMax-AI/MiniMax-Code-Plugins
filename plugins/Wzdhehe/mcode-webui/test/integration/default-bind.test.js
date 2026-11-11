// webui/test/integration/default-bind.test.js
// v2 security fix (PR #55 review point 2) — live-boot proof that the
// default bind is loopback and that LAN exposure is an explicit opt-in:
//
//   1. no env HOST, no settings.json → server listens on 127.0.0.1
//   2. persisted lanBind:true in settings.json → server listens on 0.0.0.0
//   3. env HOST=0.0.0.0 (explicit deploy config) → respected, zero surprise
//
// Asserts on the real server.js stdout "listening on http://<host>:<port>"
// line — the same signal test/server-startup.test.js gates on.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverJsPath = join(__dirname, "..", "..", "server.js");

// Port allocation: 19701/19702/19703 — disjoint from router-boot (19500s)
// and C08 (18080s). Each case gets its OWN deterministic port and the
// helper only resolves after the child process has fully exited: on
// Linux, resolving at the listening line and immediately binding the
// next case raced the dying listener into EADDRINUSE (SIGTERM → close
// is asynchronous; TIME_WAIT/lingering proc held 0.0.0.0:<port>).

function bootOnce({ port, envOverrides = {}, settingsJson } = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "mcode-webui-bind-"));
  const env = {
    ...process.env,
    PORT: String(port),
    MCODE_WEBUI_SETTINGS_PATH: join(tmpDir, "settings.json"),
    MCODE_WEBUI_EVENTS_PATH: join(tmpDir, "events.ndjson"),
    MCODE_WEBUI_UPLOAD_DIR: join(tmpDir, "uploads"),
    MCODE_WEBUI_SESSIONS_DB: join(tmpDir, "sessions.json"),
    TOKEN: "",
    MCODE_WEBUI_TOKEN_STDOUT: "0",
    ...envOverrides,
  };
  delete env.HOST; // default unless an override re-adds it
  if (envOverrides.HOST !== undefined) env.HOST = envOverrides.HOST;
  if (settingsJson !== undefined) {
    writeFileSync(env.MCODE_WEBUI_SETTINGS_PATH, JSON.stringify(settingsJson), "utf8");
  }
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [serverJsPath], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: join(__dirname, "..", ".."),
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const bail = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error(`no listening line within 4s. stdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 4000);
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      if (!settled && /listening on/.test(stdout)) {
        settled = true;
        clearTimeout(bail);
        // Tear the listener down COMPLETELY before resolving so the
        // next case's bind on its own port cannot collide with a
        // lingering socket: SIGTERM, escalate to SIGKILL if close
        // stalls, await the exit event, then clean the tmp dir.
        const exited = new Promise((r) => proc.once("exit", r));
        proc.kill("SIGTERM");
        const hardKill = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
        }, 1500);
        void exited.then(() => {
          clearTimeout(hardKill);
          try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
          resolve({ stdout, port });
        });
      }
    });
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(bail);
      reject(e);
    });
    proc.on("exit", () => {
      // Died before printing the listening line → startup failure.
      if (!settled) {
        settled = true;
        clearTimeout(bail);
        reject(new Error(`server exited before listening. stdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
  });
}

test("default bind: no env HOST + no settings file → listening on 127.0.0.1", async () => {
  const { stdout, port } = await bootOnce({ port: 19701 });
  assert.match(
    stdout,
    new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`),
    `default bind must be loopback (PR #55 review point 2). stdout:\n${stdout}`,
  );
});

test("LAN opt-in: persisted lanBind:true → listening on 0.0.0.0", async () => {
  const { stdout, port } = await bootOnce({ port: 19702, settingsJson: { lanBind: true } });
  assert.match(
    stdout,
    new RegExp(`listening on http://0\\.0\\.0\\.0:${port}`),
    `persisted lanBind opt-in must bind all interfaces. stdout:\n${stdout}`,
  );
});

test("explicit env HOST=0.0.0.0 keeps winning over the persisted setting", async () => {
  // lanBind:false on disk + env HOST set → env must own the bind.
  const { stdout, port } = await bootOnce({
    port: 19703,
    envOverrides: { HOST: "0.0.0.0" },
    settingsJson: { lanBind: false },
  });
  assert.match(
    stdout,
    new RegExp(`listening on http://0\\.0\\.0\\.0:${port}`),
    `explicit deploy config must be respected (upgrading users zero surprise). stdout:\n${stdout}`,
  );
});
