// webui/checks/chat-failed-send.check.mjs
// Unit tests for server/routes/chat.js — failed-send terminal state.
//
// Why this test exists (v2 2026-09-20 webui-manual-audit):
//   A send that fails server-side before the stream starts (mcode CLI
//   missing → acp client.start() rejects with `spawn mcode ENOENT`,
//   session/load throw, exec resolveMcodeSpawn fail-closed) never
//   reaches the streaming runners' finalize(). finalize() is the ONLY
//   place that returned cs to its at-rest thinking shape — so the
//   pushed state kept claiming an active run and the context panel's
//   思考中 indicator never cleared.
//
//   The route's failed branch (§AP3, lease B02) must now:
//     1. Reset the thinking claim (running/thinkingStatus/
//        thinkingDuration/tps + strip the ▍ streaming cursor) so the
//        terminal pushStateFor lands an at-rest state.
//     2. Push the error on the anomaly channel (pushAlert) — NOT as a
//        chat line; cs.chat must stay clean of error lines.
//     3. Keep cs.context.assistantLast = "[error] ..." so a follow-up
//        turn can reference the failure in the model context.
//     4. Leave lastUsageAt untouched (it records "when usage was last
//        observed", not an active-run claim — finalize() keeps it too).
//
// Failed results are injected through the mutable _mcodeAcpMock
// (test/_setup.js overrides.mcodeAcp) — mock.module() cannot be
// registered twice for the same specifier, and chat.js binds
// runMcodeAcp at its first dynamic import.

import {
  test,
  describe,
  before,
  beforeEach,
  after,
} from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setupMocks,
  absPath,
  registerSessionsStore,
  registerMcodeAcpMock,
} from "../test/_setup.js";

// alerts.js fire-and-forget audit-writes to events.ndjson via the REAL
// lib/events.js — redirect to a per-file tmp dir so the check never
// touches ~/.mcode-webui (same pattern as checks/lib-alerts.check.mjs).
const _tmpDir = mkdtempSync(join(tmpdir(), "webui-chat-failed-"));
process.env.MCODE_WEBUI_EVENTS_PATH = join(_tmpDir, "events.ndjson");

const ENOENT_MSG = "mcode acp child error: spawn mcode ENOENT";

function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}
function fakeRes() {
  return {
    _status: 200,
    _headers: {},
    _body: null,
    writeHead(s, h) {
      this._status = s;
      if (h) this._headers = h;
    },
    end(b) {
      this._body = b;
    },
  };
}

// Idle shape mirrored from finalize() + makeClientState() — the reset
// target the route must converge to on a terminal failure.
const IDLE_RUNNING = Object.freeze({
  active: false,
  prompt: null,
  pid: null,
  startedAt: null,
  model: null,
  sessionId: null,
  lastDeltaAt: null,
  tps: 0,
});

let handleSend;
let handleStop;
let sb; // state-bus handle
let alerts; // real lib/alerts.js (not mocked by _setup.js)

// Capturing SSE fake — pushStateFor writes `data: <json>` frames.
function makeFakeSse() {
  return {
    frames: [],
    write(s) {
      this.frames.push(String(s));
    },
  };
}
function lastStateFrame(sse) {
  const dataFrames = sse.frames.filter((f) => f.startsWith("data: "));
  assert.ok(dataFrames.length > 0, "expected at least one state frame");
  return JSON.parse(dataFrames[dataFrames.length - 1].replace(/^data: /, ""));
}

before(async (t) => {
  await setupMocks(t, {
    mavis: { applyMavisUsageToCs: async () => {} },
    // The whole point of this file: bind the ENOENT-shaped failure.
    mcodeAcp: {
      runMcodeAcp: async () => ({
        status: "failed",
        error: { message: ENOENT_MSG },
        sessionId: null,
        answer: null,
        thinking: null,
      }),
    },
  });
  sb = await import(absPath("lib/state-bus.js"));
  alerts = await import(absPath("lib/alerts.js"));
  const mod = await import(absPath("routes/chat.js"));
  handleSend = mod.handleSend;
  handleStop = mod.handleStop;
});

beforeEach(() => {
  sb.clients.clear();
  sb.resetCoalesceState();
  registerSessionsStore({ initial: [] });
  alerts._resetForTests();
});

after(() => {
  try {
    rmSync(_tmpDir, { recursive: true, force: true });
  } catch {}
});

// Seed cs exactly as a runner that died before finalize() would have
// left it: active running claim + Running status + a ▍-cursor chat
// line still marked as streaming.
function seedStaleThinkingClaim(cs) {
  cs.running = {
    active: true,
    prompt: "prompt",
    pid: null,
    startedAt: Date.now(),
    model: cs.model.name,
    sessionId: "mvs_stale",
    lastDeltaAt: Date.now(),
    tps: 12,
  };
  cs.context.thinkingStatus = "Running";
  cs.context.thinkingDuration = 4;
  cs.context.tps = 12;
  cs.context.lastUsageAt = 12345; // must survive — not a running claim
  cs.chat = ["› earlier", "▲ partial thought ▍"];
}

describe("handleSend — failed send (§AP3) resets the thinking claim", () => {
  test("stale running claim → idle fields, cursor stripped, alert pushed, chat clean", async () => {
    const cid = "cid-fail-stale";
    const cs = sb.makeClientState();
    cs.workspace = { dir: "/ws-X", branch: null, tree: null };
    seedStaleThinkingClaim(cs);
    sb.clients.set(cid, cs);
    const sse = makeFakeSse();
    sb.setSseClient(cid, sse);

    await handleSend(fakeReq({ content: "hello" }), fakeRes(), { cs, cid });

    // 1. Thinking fields fully idle — the pushed state no longer
    //    claims an active run.
    assert.deepEqual(cs.running, { ...IDLE_RUNNING });
    assert.equal(cs.context.thinkingStatus, "Idle");
    assert.equal(cs.context.thinkingDuration, null);
    assert.equal(cs.context.tps, 0);
    // 2. lastUsageAt preserved (finalize() keeps it; so must this path).
    assert.equal(cs.context.lastUsageAt, 12345);
    // 3. Chat: user line appended, ▍ cursor stripped, NO error line —
    //    §AP3 keeps the chat stream clean of error lines.
    assert.deepEqual(cs.chat, ["› earlier", "▲ partial thought", "› hello"]);
    // 4. Model context keeps the error for follow-up turns.
    assert.equal(cs.context.assistantLast, `[error] ${ENOENT_MSG}`);
    // 5. Anomaly channel got the error, not the chat.
    const recent = alerts.getRecentAlerts();
    const hit = recent.find(
      (a) => a.level === "error" && a.src === "chat.send",
    );
    assert.ok(hit, `expected a chat.send error alert, got: ${JSON.stringify(recent)}`);
    assert.ok(hit.msg.includes(ENOENT_MSG), `alert msg should carry the error: ${hit.msg}`);
    assert.equal(hit.cid, cid);
    // 6. The TERMINAL pushed frame (after the reset) is at-rest — this
    //    is the frame the browser renders 思考中 from.
    const frame = lastStateFrame(sse);
    assert.equal(frame.running.active, false);
    assert.equal(frame.context.thinkingStatus, "Idle");
    assert.equal(frame.context.thinkingDuration, null);
  });

  test("fresh idle state stays idle after a failed send (fresh-boot ENOENT shape)", async () => {
    const cid = "cid-fail-fresh";
    const cs = sb.makeClientState();
    cs.workspace = { dir: "/ws-X", branch: null, tree: null };
    cs.chat = [];
    sb.clients.set(cid, cs);

    await handleSend(fakeReq({ content: "hello" }), fakeRes(), { cs, cid });

    assert.deepEqual(cs.running, { ...IDLE_RUNNING });
    assert.equal(cs.context.thinkingStatus, "Idle");
    assert.deepEqual(cs.chat, ["› hello"]);
    assert.ok(
      alerts
        .getRecentAlerts()
        .some((a) => a.level === "error" && a.src === "chat.send"),
      "failed send must push the anomaly alert even from an idle state",
    );
  });

  test("success path symmetry: no reset side-effects, lastUsageAt kept, ● line written", async () => {
    // The success branch relies on finalize() having already put cs at
    // rest inside runMcodeAcp/collectExecResult — the route adds no
    // reset of its own there. Pin that contract: a successful send
    // must not clobber context bookkeeping (lastUsageAt) and must
    // still write the ● answer line + assistantLast.
    registerMcodeAcpMock({
      runMcodeAcp: async () => ({
        status: "succeeded",
        answer: "all good",
        sessionId: "mvs_ok",
      }),
    });
    try {
      const cid = "cid-ok";
      const cs = sb.makeClientState();
      cs.workspace = { dir: "/ws-X", branch: null, tree: null };
      cs.chat = [];
      cs.context.lastUsageAt = 999;
      sb.clients.set(cid, cs);

      await handleSend(fakeReq({ content: "hello" }), fakeRes(), { cs, cid });

      assert.deepEqual(cs.running, { ...IDLE_RUNNING });
      assert.equal(cs.context.thinkingStatus, "Idle");
      assert.equal(cs.context.lastUsageAt, 999, "success must keep lastUsageAt");
      assert.deepEqual(cs.chat, ["› hello", "● all good"]);
      assert.equal(cs.context.assistantLast, "all good");
      assert.equal(
        alerts.getRecentAlerts().length,
        0,
        "successful send must not raise an anomaly alert",
      );
    } finally {
      // Restore the failed mock for any test registered after this one.
      registerMcodeAcpMock({
        runMcodeAcp: async () => ({
          status: "failed",
          error: { message: ENOENT_MSG },
          sessionId: null,
          answer: null,
          thinking: null,
        }),
      });
    }
  });
});

describe("handleStop — zombie run claim", () => {
  test("no active child but cs claims an active run: claim reset + idle frame pushed", async () => {
    const cid = "cid-stop-zombie";
    const cs = sb.makeClientState();
    cs.workspace = { dir: "/ws-X", branch: null, tree: null };
    cs.mcodeSessionId = null; // skips the gentle-cancel RPC path
    seedStaleThinkingClaim(cs);
    sb.clients.set(cid, cs);
    const sse = makeFakeSse();
    sb.setSseClient(cid, sse);

    const res = fakeRes();
    await handleStop(null, res, { cs, cid });

    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.wasRunning, false, "no child registered → wasRunning=false");
    // The escape hatch: the stuck 思考中 claim is cleared...
    assert.deepEqual(cs.running, { ...IDLE_RUNNING });
    assert.equal(cs.context.thinkingStatus, "Idle");
    assert.equal(cs.context.thinkingDuration, null);
    // ...and the at-rest state actually went out on the wire.
    const frame = lastStateFrame(sse);
    assert.equal(frame.running.active, false);
    assert.equal(frame.context.thinkingStatus, "Idle");
  });

  test("live child present: handleStop does NOT touch cs.running (finalize owns it)", async () => {
    const cid = "cid-stop-live";
    const cs = sb.makeClientState();
    cs.workspace = { dir: "/ws-X", branch: null, tree: null };
    cs.mcodeSessionId = "mvs_aabb000000000000000000000000abcd";
    seedStaleThinkingClaim(cs);
    sb.clients.set(cid, cs);
    const fakeChild = {
      child: { killed: false, exitCode: null },
      kill() {
        fakeChild.child.killed = true;
      },
    };
    sb.setActiveChild(cid, fakeChild);

    const res = fakeRes();
    await handleStop(null, res, { cs, cid });

    const body = JSON.parse(res._body);
    assert.equal(body.hardKilled, true, "live child → hard kill fires");
    // Contract pin: with a live child the kill cascade rejects the
    // in-flight prompt and the runner's own finalize() performs the
    // terminal reset — handleStop must not race it by resetting early.
    assert.equal(
      cs.running.active,
      true,
      "handleStop must leave cs.running to the runner's finalize when a child is live",
    );
    assert.equal(cs.context.thinkingStatus, "Running");
    sb.clearActiveChild(cid);
  });
});
