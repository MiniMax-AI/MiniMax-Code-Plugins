// webui/test/integration/chat-wiring.test.js
// Extracted from test/chat.test.js by the 2026-09-20 webui-rigor-fix
// M1 migration: the mocked unit half moved to checks/chat.check.mjs
// (needs --experimental-test-module-mocks), while this production
// wiring gate stays under test/ — it runs the REAL server.js as a
// child process with zero module mocks, so it is dual-mode and
// belongs in the flagless marketplace root-gate discovery surface.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { absPath, decideNextAuthorization } from "../_setup.js";

// ============================================================
// 2026-09-20 rigor fix (W2): production wiring surface gate tests.
//
// routes/chat.js must import the gate-bearing lib/slash.js shell, not
// the raw interaction/commands.js dispatcher — otherwise the B03
// authorize("slash.clear") gate and the write-ahead audit are dead
// code in production (the G1 bypass finding). The unit tests above
// exercise handleSend against the _setup.js mock of lib/slash.js, so
// they cannot see the gate. These tests boot the REAL server.js as a
// child process (no module mocks — works identically with and without
// --experimental-test-module-mocks) and drive /clear through the
// production HTTP wire path, deciding the authorize() gate exactly
// like the browser modal does (SSE needs_authorization frame + POST
// /api/auth/decision via the _setup.js decideNextAuthorization
// helper). Same pattern as test/integration/event-chain.test.js.
// ============================================================

// Originally test/chat.test.js sat one level up, so the anchor was
// join(dir, ".."); now that this file lives in test/integration/ the
// plugin root needs two levels — same as event-chain.test.js.
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_JS = join(PLUGIN_ROOT, "server.js");
const GATE_CID = "cid-w2-gate";

describe("chat route production wiring — /clear must pass the slash.js gate", () => {
  let server;

  beforeEach(async () => {
    // Fresh real server per test: isolated settings/events/sessions
    // files (nothing touches ~/.mcode-webui), token auth off, and
    // DEBUG_INJECT=1 so tests can seed cs.chat and read it back
    // without a browser.
    const tmpDir = mkdtempSync(join(tmpdir(), "mcode-webui-w2-gate-"));
    const port = 19800 + Math.floor(Math.random() * 80);
    const env = {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      MCODE_WEBUI_SETTINGS_PATH: join(tmpDir, "settings.json"),
      MCODE_WEBUI_EVENTS_PATH: join(tmpDir, "events.ndjson"),
      MCODE_WEBUI_SESSIONS_DB: join(tmpDir, "sessions.json"),
      // U1 (2026-09-20 rigor fix): redirect upload dir away from
      // MCODE_ROOT — server.js mkdirSync(UPLOAD_DIR) at boot would
      // otherwise create a stray .webui-uploads/ in the plugin tree,
      // which breaks marketplace validate.mjs. Same pattern as the
      // server-startup.test.js bootstrap env. tmpDir is per-test
      // mkdtemp'd and rmSync'd in afterEach below.
      MCODE_WEBUI_UPLOAD_DIR: join(tmpDir, "uploads"),
      TOKEN: "",
      MCODE_WEBUI_TOKEN_STDOUT: "0",
      DEBUG_INJECT: "1",
    };
    const proc = spawn("node", [SERVER_JS], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: PLUGIN_ROOT,
      env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `server.js did not start within 3s on port ${port}\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
      }, 3000);
      const onChunk = () => {
        if (/listening on/.test(stdout)) {
          clearTimeout(timer);
          proc.stdout.off("data", onChunk);
          resolve();
        }
      };
      proc.stdout.on("data", onChunk);
    });
    server = {
      proc,
      port,
      tmpDir,
      eventsPath: join(tmpDir, "events.ndjson"),
    };
  });

  afterEach(async () => {
    if (server && server.proc && server.proc.exitCode === null) {
      try {
        server.proc.kill("SIGTERM");
      } catch {}
      await Promise.race([
        new Promise((r) => server.proc.on("exit", r)),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
      if (server.proc.exitCode === null) {
        try {
          server.proc.kill("SIGKILL");
        } catch {}
      }
    }
    if (server && server.tmpDir) {
      try {
        rmSync(server.tmpDir, { recursive: true, force: true });
      } catch {}
    }
    server = null;
  });

  function postJson(port, path, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body || {});
      const req = http.request(
        {
          method: "POST",
          host: "127.0.0.1",
          port,
          path,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let json;
            try {
              json = JSON.parse(raw);
            } catch {}
            resolve({ status: res.statusCode, body: raw, json });
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  function getJson(port, path) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, body: raw, json });
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
  }

  function readEvents(path) {
    let raw = "";
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  }

  // Seed cs.chat with two lines via the DEBUG_INJECT route so a later
  // /clear has something observable to destroy (no mcode spawn).
  async function seedChat(port) {
    const res = await postJson(port, `/api/debug/inject?cid=${GATE_CID}`, {
      appendChat: ["› seeded question", "● seeded answer"],
    });
    assert.equal(res.status, 200, `debug inject failed: ${res.body}`);
  }

  // Poll the debug state until the chat tail satisfies predicate —
  // /api/send is fire-and-forget (ack precedes the slash dispatch),
  // so the gate's effect lands shortly after the decision.
  async function pollChat(port, predicate, label) {
    const t0 = Date.now();
    for (;;) {
      const r = await getJson(port, `/api/debug/state?cid=${GATE_CID}`);
      assert.equal(r.status, 200, `debug state failed: ${r.body}`);
      const chat = (r.json && r.json.chatLast5) || [];
      if (predicate(chat)) return chat;
      if (Date.now() - t0 > 2000) {
        throw new Error(
          `pollChat timeout waiting for ${label}; last chatLast5: ${JSON.stringify(chat)}`,
        );
      }
      await new Promise((r2) => setTimeout(r2, 50));
    }
  }

  // Fire a gated /clear through the production wire path and drive
  // the decision exactly like the modal (same cid — the
  // needs_authorization frame is pushed to the sender's cid only).
  async function clearWithDecision(port, approve, { viaCmd = false } = {}) {
    const decider = decideNextAuthorization({ port, approve, cid: GATE_CID });
    // Let the decider's SSE subscription register before the gate
    // broadcast fires (frames are not replayed to late subscribers).
    await new Promise((r) => setTimeout(r, 150));
    const post = viaCmd
      ? postJson(port, `/api/cmd?cid=${GATE_CID}`, { cmd: "/clear" })
      : postJson(port, `/api/send?cid=${GATE_CID}`, { content: "/clear" });
    const { decision } = await decider;
    assert.ok(decision, "decision endpoint answered");
    const res = await post;
    assert.equal(res.status, 200, `gated clear ack failed: ${res.body}`);
    assert.equal(res.json && res.json.ok, true);
    return { decision };
  }

  test("declined /clear via /api/send: cs.chat untouched + rejection traces", async () => {
    await seedChat(server.port);
    await clearWithDecision(server.port, false);
    const chat = await pollChat(
      server.port,
      (c) => c.some((l) => typeof l === "string" && l.includes("已取消 /clear")),
      "decline note",
    );
    // NOT cleared: the seeded lines survive...
    assert.ok(
      chat.some((l) => l === "› seeded question"),
      `seeded question must survive a declined clear; chat: ${JSON.stringify(chat)}`,
    );
    assert.ok(
      chat.some((l) => l === "● seeded answer"),
      `seeded answer must survive a declined clear; chat: ${JSON.stringify(chat)}`,
    );
    // ...and the visible decline note names the decision maker.
    assert.ok(
      chat.some((l) => /● 已取消 \/clear \(授权未通过: user\)/.test(l)),
      `decline note with decidedBy=user expected; chat: ${JSON.stringify(chat)}`,
    );
    // Audit: NO clear intent/outcome, but the gate itself left its
    // pending + reject outcome lines.
    await new Promise((r) => setTimeout(r, 50));
    const events = readEvents(server.eventsPath);
    const kinds = events.map((e) => e.kind);
    assert.equal(
      kinds.indexOf("slash.clear.intent"),
      -1,
      "declined clear must not write a slash.clear.intent line",
    );
    assert.equal(
      kinds.indexOf("chat.clear"),
      -1,
      "declined clear must not write a chat.clear line",
    );
    assert.ok(kinds.includes("auth.pending"), "auth.pending recorded");
    assert.ok(kinds.includes("auth.reject"), "auth.reject recorded");
    const { verify } = await import(absPath("lib/events.js"));
    const v = verify({ path: server.eventsPath });
    assert.equal(v.ok, true, `chain must still verify: ${JSON.stringify(v)}`);
  });

  test("approved /clear via /api/send: chat cleared + intent precedes outcome", async () => {
    await seedChat(server.port);
    await clearWithDecision(server.port, true);
    const chat = await pollChat(server.port, (c) => c.length === 0, "cleared chat");
    assert.deepEqual(chat, [], "approved clear must empty cs.chat");
    await new Promise((r) => setTimeout(r, 50));
    const events = readEvents(server.eventsPath);
    const kinds = events.map((e) => e.kind);
    const intentIdx = kinds.indexOf("slash.clear.intent");
    const outcomeIdx = kinds.indexOf("chat.clear");
    assert.ok(intentIdx >= 0, "slash.clear.intent (write-ahead) recorded");
    assert.ok(outcomeIdx > intentIdx, "chat.clear outcome recorded after intent");
    const intent = events[intentIdx];
    assert.equal(intent.data && intent.data.source, "local_slash");
    assert.equal(intent.data && intent.data.cmd, "clear");
    assert.ok(kinds.includes("auth.approve"), "auth.approve recorded");
    const { verify } = await import(absPath("lib/events.js"));
    const v = verify({ path: server.eventsPath });
    assert.equal(v.ok, true, `chain must verify: ${JSON.stringify(v)}`);
    assert.ok(v.count >= 4, `expected >=4 events, got ${v.count}`);
  });

  test("approved /clear via /api/cmd (button path): gated + audited as cmd_button", async () => {
    await seedChat(server.port);
    await clearWithDecision(server.port, true, { viaCmd: true });
    const chat = await pollChat(server.port, (c) => c.length === 0, "cleared chat");
    assert.deepEqual(chat, [], "approved button clear must empty cs.chat");
    await new Promise((r) => setTimeout(r, 50));
    const events = readEvents(server.eventsPath);
    const kinds = events.map((e) => e.kind);
    const intentIdx = kinds.indexOf("slash.clear.intent");
    assert.ok(intentIdx >= 0, "button clear must be gated by the shell (intent recorded)");
    const intent = events[intentIdx];
    assert.equal(intent.data && intent.data.source, "cmd_button");
    assert.ok(kinds.indexOf("chat.clear") > intentIdx, "outcome after intent");
    const { verify } = await import(absPath("lib/events.js"));
    const v = verify({ path: server.eventsPath });
    assert.equal(v.ok, true, `chain must verify: ${JSON.stringify(v)}`);
  });
});
