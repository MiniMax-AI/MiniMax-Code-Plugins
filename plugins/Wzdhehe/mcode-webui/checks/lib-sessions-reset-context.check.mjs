// webui/checks/lib-sessions-reset-context.check.mjs
// Unit tests for server/lib/sessions.js — resetContext thinking-claim reset.
//
// Why this test exists (v2 2026-09-20 webui-manual-audit):
//   resetContext is the session-CHANGE reset (switch / create / new /
//   /clear / delete fan-out / protocol activate-session). It used to
//   clear only the context counters — a mid-run switch left
//   running.active=true + thinkingStatus="Running" parked in the
//   client state, so the footer/context panel showed 思考中 forever
//   and the send button stayed a stop button for a run the user had
//   navigated away from. Worse, commands.js#handleCmdCommand("/new")
//   REFUSES to create a session while cs.running.active — a stale
//   claim permanently blocks that button too. The claim only healed
//   when the in-flight run's finalize() fired; runs that die in their
//   start phase never heal.
//
//   resetContext must now drop cs.running to the idle shape
//   (byte-mirrored from the runners' finalize() + makeClientState())
//   and set context.thinkingStatus = "Idle".
//
//   Two scoped boundaries pinned here as NEGATIVE assertions:
//     - cs.chat is NOT touched (no ▍ cursor stripping): every caller
//       has already replaced or cleared the chat — stripping here
//       could corrupt the TARGET session's lines. Contrast
//       chat.js#resetThinkingClaim (same-session terminal failure),
//       which DOES strip.
//     - context.lastUsageAt IS nulled (session-change semantics: the
//       target session has no observed usage yet) — again contrasting
//       resetThinkingClaim, which keeps it because the session is the
//       same there.
//
// Test strategy: NO mocks — this file imports the REAL lib/sessions.js
// directly (it is a pure module: only config.js constants at import
// time, zero IO). node --test runs each check file in its own process,
// so the module-mock registrations other checks perform cannot leak in.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resetContext } from "../server/lib/sessions.js";

// Idle shape mirrored from finalize() (mcode-acp.js / mcode-exec.js) +
// makeClientState() (state-bus.js) — the at-rest target. Kept in sync
// with IDLE_RUNNING in checks/chat-failed-send.check.mjs.
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

// Minimal cs fixture mirroring state-bus#makeClientState()'s
// running/context/chat fields (the only fields resetContext touches).
// state-bus itself is NOT imported unmocked — it drags in acp-client /
// auth / settings, none of which this pure-lib check needs.
function makeCs() {
  return {
    sessionId: "webui-current",
    chat: [],
    running: {
      active: false,
      prompt: null,
      pid: null,
      startedAt: null,
      model: null,
      sessionId: null,
      lastDeltaAt: null,
      tps: 0,
    },
    context: {
      tokens: 0,
      used: 0,
      percent: 0,
      limit: 512000,
      tps: 0,
      thinkingStatus: "Idle",
      thinkingDuration: null,
      lastUsageAt: null,
      assistantLast: null,
      assistantAt: null,
    },
  };
}

// Seed cs exactly as a runner that is mid-stream (or died before
// finalize) would have left it: active running claim + Running status
// + live tps/duration + a ▍-cursor chat line still marked streaming.
function seedStaleClaim(cs) {
  cs.running = {
    active: true,
    prompt: "prompt",
    pid: 4242, // exec-shape claim carries a real pid
    startedAt: Date.now() - 4000,
    model: "MiniMax-M3",
    sessionId: "mvs_stale",
    lastDeltaAt: Date.now() - 100,
    tps: 12,
  };
  cs.context.thinkingStatus = "Running";
  cs.context.thinkingDuration = 4;
  cs.context.tps = 12;
  cs.context.tokens = 1234;
  cs.context.used = 1234;
  cs.context.percent = 1;
  cs.context.spent = 0.05;
  cs.context.assistantLast = "partial answer";
  cs.context.assistantAt = 111;
  cs.context.lastUsageAt = 12345;
  cs.chat = ["› earlier", "▲ partial thought ▍"];
}

describe("resetContext — thinking-claim reset (session-change path)", () => {
  test("stale running claim → idle shape + Idle status (acp-shape, no pid)", () => {
    const cs = makeCs();
    seedStaleClaim(cs);
    cs.running.pid = null; // acp runner shape

    resetContext(cs);

    assert.deepEqual(cs.running, { ...IDLE_RUNNING });
    assert.equal(cs.context.thinkingStatus, "Idle");
    assert.equal(cs.context.thinkingDuration, null);
    assert.equal(cs.context.tps, 0);
  });

  test("stale running claim with live pid (exec shape) → pid cleared too", () => {
    const cs = makeCs();
    seedStaleClaim(cs);
    assert.equal(cs.running.pid, 4242);

    resetContext(cs);

    assert.deepEqual(cs.running, { ...IDLE_RUNNING });
  });

  test("counters still reset (pre-existing contract pinned)", () => {
    const cs = makeCs();
    seedStaleClaim(cs);

    resetContext(cs);

    assert.equal(cs.context.tokens, 0);
    assert.equal(cs.context.used, 0);
    assert.equal(cs.context.percent, 0);
    assert.equal(cs.context.spent, 0);
    assert.equal(cs.context.assistantLast, null);
    assert.equal(cs.context.assistantAt, null);
  });

  test("lastUsageAt nulled — session-change semantics (contrast: resetThinkingClaim keeps it)", () => {
    const cs = makeCs();
    seedStaleClaim(cs);

    resetContext(cs);

    // The target session has no observed usage yet; carrying the old
    // session's freshness datum over zeroed counters would lie.
    assert.equal(cs.context.lastUsageAt, null);
  });

  test("cs.chat untouched — ▍ cursors survive (chat ownership stays with the caller)", () => {
    const cs = makeCs();
    seedStaleClaim(cs);

    resetContext(cs);

    // Deliberate contrast with chat.js#resetThinkingClaim: on the
    // switch/create/clear paths the caller has already replaced (or is
    // about to clear) cs.chat, so stripping cursors here could corrupt
    // the TARGET session's lines. resetContext must not touch chat.
    assert.deepEqual(cs.chat, ["› earlier", "▲ partial thought ▍"]);
    assert.equal(Array.isArray(cs.chat), true);
  });

  test("context.limit survives — percent recalcs keep a denominator", () => {
    const cs = makeCs();
    seedStaleClaim(cs);

    resetContext(cs);

    assert.equal(cs.context.limit, 512000);
  });

  test("fresh idle state stays idle (idempotence)", () => {
    const cs = makeCs();

    resetContext(cs);

    assert.deepEqual(cs.running, { ...IDLE_RUNNING });
    assert.equal(cs.context.thinkingStatus, "Idle");
  });
});
