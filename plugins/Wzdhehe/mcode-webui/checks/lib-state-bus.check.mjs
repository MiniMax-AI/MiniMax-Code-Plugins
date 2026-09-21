// webui/test/lib-state-bus.test.js
// Unit tests for the Lease C04 SSE coalescing + diff gate added to
// server/lib/state-bus.js. Verifies:
//   - STATE_PUSH_THROTTLE_MS env var controls the throttle window
//   - Diff gate: identical payloads after a write are suppressed (no
//     redundant full-state replaces hit the client)
//   - Coalescing window: within STATE_PUSH_THROTTLE_MS, multiple
//     pushes with DIFFERENT payloads coalesce to one write (last-call-
//     wins), so the per-cid write rate is capped at ~1/throttle Hz
//   - Fresh-client detection: when a cid gets a different SSE res
//     (re-connect / test reset), the next push writes immediately
//     regardless of diff or throttle state
//   - setSseClient + endSseClient reset coalesce state for that cid
//   - resetCoalesceState() / flushPendingPushes() / peekLastPushed()
//     are usable as test escape hatches
//
// Why this file is separate from test/state-bus.test.js: that file
// was written for the pre-coalescer sync-write contract. Adding 150+
// lines of throttle-specific tests would crowd an already-large file;
// the C04 tests live here so the existing file's contract remains
// visible at a glance.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
    setupMocks,
    absPath,
    registerAcpMock,
    registerSessionsStore,
} from "../test/_setup.js";

let pushStateFor, pushOnlineCount;
let clients, sseByCid, makeClientState;
let STATE_PUSH_THROTTLE_MS;
let resetCoalesceState, flushPendingPushes;
let peekLastPushed, peekLastWriteTs;
let setSseClient, endSseClient;

before(async (t) => {
    await setupMocks(t);
    const mod = await import(absPath("lib/state-bus.js"));
    pushStateFor = mod.pushStateFor;
    pushOnlineCount = mod.pushOnlineCount;
    clients = mod.clients;
    sseByCid = mod.sseByCid;
    makeClientState = mod.makeClientState;
    STATE_PUSH_THROTTLE_MS = mod.STATE_PUSH_THROTTLE_MS;
    resetCoalesceState = mod.resetCoalesceState;
    flushPendingPushes = mod.flushPendingPushes;
    peekLastPushed = mod.peekLastPushed;
    peekLastWriteTs = mod.peekLastWriteTs;
    setSseClient = mod.setSseClient;
    endSseClient = mod.endSseClient;
});

beforeEach(() => {
    // Reset coalesce state between tests — production throttles stay
    // live, but each test starts from a clean slate so diff cache /
    // throttle timestamps from the previous test don't bleed in.
    resetCoalesceState();
    clients.clear();
    sseByCid.clear();
    registerAcpMock({
        getMcodeSessionsForWorkspace: async () => [],
        getMcodeSessionsCacheSync: () => null,
        getMcodeSessionsStaleSync: () => null,
    });
    registerSessionsStore({
        initial: [
            {
                id: "sess-1",
                title: "old",
                workspace: "/w",
                createdAt: 1,
                updatedAt: 1,
                chat: [],
            },
        ],
    });
});

function fakeSse() {
    const writes = [];
    return {
        writes,
        write: (chunk) => {
            writes.push(chunk);
        },
    };
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// Throttle knob: STATE_PUSH_THROTTLE_MS is exported, env-controlled,
// and defaults to 0 (no time-based throttle — only the diff gate is
// always active).
// ============================================================
describe("STATE_PUSH_THROTTLE_MS — env-driven throttle knob", () => {
    test("default value is a non-negative integer (env-unset → 0)", () => {
        assert.equal(typeof STATE_PUSH_THROTTLE_MS, "number");
        assert.ok(STATE_PUSH_THROTTLE_MS >= 0);
    });

    test("resetCoalesceState clears pending timers + diff cache", () => {
        const cid = "cid-rst-1";
        const res = fakeSse();
        clients.set(cid, makeClientState());
        sseByCid.set(cid, res);
        pushStateFor(cid, { mcodeSessions: [{ id: "x" }] });
        assert.ok(peekLastPushed(cid), "first push writes + caches payload");
        resetCoalesceState();
        assert.equal(peekLastPushed(cid), undefined,
            "resetCoalesceState clears _lastPushedByCid");
        assert.equal(peekLastWriteTs(cid), undefined,
            "resetCoalesceState clears _lastWriteTsByCid");
    });

    test("flushPendingPushes returns count of cids flushed", () => {
        // With default throttle=0, no pending builds up — 0 flushed
        const a = fakeSse(),
            b = fakeSse();
        clients.set("a", makeClientState());
        clients.set("b", makeClientState());
        sseByCid.set("a", a);
        sseByCid.set("b", b);
        pushStateFor("a", { mcodeSessions: [] });
        pushStateFor("b", { mcodeSessions: [] });
        // Both pushed synchronously (throttle=0); nothing pending
        assert.equal(flushPendingPushes(), 0);
    });
});

// ============================================================
// Diff gate: identical payloads after the last write are suppressed.
// Always-on regardless of STATE_PUSH_THROTTLE_MS value.
// ============================================================
describe("diff gate — identical payloads suppressed (always on)", () => {
    test("second push with identical bytes writes nothing", () => {
        const cid = "cid-diff-1";
        const res = fakeSse();
        clients.set(cid, makeClientState());
        sseByCid.set(cid, res);
        pushStateFor(cid, { mcodeSessions: [{ id: "v1" }] });
        assert.equal(res.writes.length, 1, "first push writes");
        pushStateFor(cid, { mcodeSessions: [{ id: "v1" }] });
        assert.equal(res.writes.length, 1,
            "second push with identical bytes is dropped — diff gate");
    });

    test("third push with identical bytes still suppressed", () => {
        const cid = "cid-diff-2";
        const res = fakeSse();
        clients.set(cid, makeClientState());
        sseByCid.set(cid, res);
        pushStateFor(cid, { mcodeSessions: [{ id: "v1" }] });
        pushStateFor(cid, { mcodeSessions: [{ id: "v1" }] });
        pushStateFor(cid, { mcodeSessions: [{ id: "v1" }] });
        assert.equal(res.writes.length, 1,
            "all three identical pushes coalesce to one wire frame");
    });

    test("different payload after a write goes through", () => {
        const cid = "cid-diff-3";
        const res = fakeSse();
        clients.set(cid, makeClientState());
        sseByCid.set(cid, res);
        pushStateFor(cid, { mcodeSessions: [{ id: "v1" }] });
        pushStateFor(cid, { mcodeSessions: [{ id: "v2" }] });
        assert.equal(res.writes.length, 2,
            "different bytes pass the diff gate");
    });

    test("peekLastPushed returns last successful wire payload", () => {
        const cid = "cid-diff-4";
        const res = fakeSse();
        clients.set(cid, makeClientState());
        sseByCid.set(cid, res);
        assert.equal(peekLastPushed(cid), undefined,
            "no record before first push");
        pushStateFor(cid, { mcodeSessions: [{ id: "x" }] });
        const cached = peekLastPushed(cid);
        assert.ok(cached, "peekLastPushed returns the cached JSON");
        assert.match(cached, /"x"/, "cached payload contains the data");
    });

    test("peekLastWriteTs returns ms timestamp of last successful write", () => {
        const cid = "cid-diff-5";
        const res = fakeSse();
        clients.set(cid, makeClientState());
        sseByCid.set(cid, res);
        assert.equal(peekLastWriteTs(cid), undefined);
        const before = Date.now();
        pushStateFor(cid, { mcodeSessions: [{ id: "t" }] });
        const after = Date.now();
        const ts = peekLastWriteTs(cid);
        assert.ok(ts >= before && ts <= after,
            "timestamp is between before/after Date.now() bounds");
    });
});

// ============================================================
// Fresh-client detection: when a cid's res changes, all coalesce
// state for that cid is cleared and the next push writes immediately.
// ============================================================
describe("fresh-client detection — new res resets coalesce state", () => {
    test("first pushStateFor writes unconditionally (no prior state)", () => {
        const cid = "cid-fresh-1";
        const res = fakeSse();
        clients.set(cid, makeClientState());
        sseByCid.set(cid, res);
        pushStateFor(cid, { mcodeSessions: [{ id: "fresh" }] });
        assert.equal(res.writes.length, 1,
            "first push to a never-seen cid writes synchronously");
    });

    test("re-binding via setSseClient clears prior coalesce state", () => {
        const cid = "cid-fresh-2";
        const oldRes = fakeSse();
        clients.set(cid, makeClientState());
        sseByCid.set(cid, oldRes);
        pushStateFor(cid, { mcodeSessions: [{ id: "old" }] });
        assert.equal(oldRes.writes.length, 1);
        // New client connects (simulated by setSseClient with new res)
        const newRes = fakeSse();
        sseByCid.set(cid, newRes);
        setSseClient(cid, newRes);
        // Diff cache is fresh — push with identical payload should
        // still write (the new client hasn't seen any prior frame).
        pushStateFor(cid, { mcodeSessions: [{ id: "old" }] });
        assert.equal(newRes.writes.length, 1,
            "after setSseClient, identical payload writes to new res");
        assert.equal(oldRes.writes.length, 1,
            "old res not re-touched (different res object)");
    });

    test("endSseClient drops coalesce state for the disconnected cid", () => {
        const cid = "cid-fresh-3";
        const res = fakeSse();
        clients.set(cid, makeClientState());
        sseByCid.set(cid, res);
        pushStateFor(cid, { mcodeSessions: [{ id: "v1" }] });
        assert.equal(peekLastPushed(cid).length > 0, true);
        endSseClient(cid, res);
        assert.equal(peekLastPushed(cid), undefined,
            "endSseClient clears _lastPushedByCid for that cid");
        assert.equal(peekLastWriteTs(cid), undefined,
            "endSseClient clears _lastWriteTsByCid for that cid");
    });
});

// ============================================================
// Coalescing under explicit throttle: with the throttle set to a
// short window via a fresh import, multiple pushes within the window
// coalesce to one write.
// ============================================================
describe("coalescing window — explicit throttle via env", () => {
    // Re-import with env var set to a tight window. We can't mutate
    // STATE_PUSH_THROTTLE_MS at runtime (it's a module-level const),
    // but the import resolves the env at load time, so an isolated
    // dynamic import with env set gives us a fresh module instance
    // with the throttle knob turned up.
    let throttledMod;
    let originalEnv;
    before(() => {
        originalEnv = process.env.STATE_PUSH_THROTTLE_MS;
        process.env.STATE_PUSH_THROTTLE_MS = "20";
        // Cache-bust the module so the new env is read on import
        return import(absPath("lib/state-bus.js") + "?bust=" + Date.now())
            .then((m) => {
                throttledMod = m;
            });
    });
    after(() => {
        if (originalEnv === undefined) delete process.env.STATE_PUSH_THROTTLE_MS;
        else process.env.STATE_PUSH_THROTTLE_MS = originalEnv;
    });

    test("first push in window writes synchronously", async () => {
        const cid = "cid-coal-1";
        const res = fakeSse();
        throttledMod.clients.set(cid, throttledMod.makeClientState());
        throttledMod.sseByCid.set(cid, res);
        throttledMod.pushStateFor(cid, { mcodeSessions: [{ id: "first" }] });
        assert.equal(res.writes.length, 1,
            "first push in window writes immediately (sync contract)");
    });

    test("subsequent pushes in window are deferred (not written sync)", () => {
        const cid = "cid-coal-2";
        const res = fakeSse();
        throttledMod.clients.set(cid, throttledMod.makeClientState());
        throttledMod.sseByCid.set(cid, res);
        throttledMod.pushStateFor(cid, { mcodeSessions: [{ id: "v1" }] });
        // Three more pushes within microseconds — all within window
        throttledMod.pushStateFor(cid, { mcodeSessions: [{ id: "v2" }] });
        throttledMod.pushStateFor(cid, { mcodeSessions: [{ id: "v3" }] });
        throttledMod.pushStateFor(cid, { mcodeSessions: [{ id: "v4" }] });
        assert.equal(res.writes.length, 1,
            "4 pushes within window → 1 wire frame so far (3 deferred)");
    });

    test("after window expires, last pending flushes to wire", async () => {
        const cid = "cid-coal-3";
        const res = fakeSse();
        throttledMod.clients.set(cid, throttledMod.makeClientState());
        throttledMod.sseByCid.set(cid, res);
        throttledMod.pushStateFor(cid, { mcodeSessions: [{ id: "v1" }] });
        throttledMod.pushStateFor(cid, { mcodeSessions: [{ id: "v4" }] });
        // Wait past the 20ms window
        await sleep(40);
        assert.equal(res.writes.length, 2,
            "after window: pending flushes (last-call-wins v4)");
        const lastWrite = JSON.parse(res.writes[1].slice(6));
        assert.deepEqual(lastWrite.mcodeSessions, [{ id: "v4" }],
            "flushed payload is the latest (last-call-wins)");
    });

    test("flushPendingPushes forces immediate flush", () => {
        const cid = "cid-coal-4";
        const res = fakeSse();
        throttledMod.clients.set(cid, throttledMod.makeClientState());
        throttledMod.sseByCid.set(cid, res);
        throttledMod.pushStateFor(cid, { mcodeSessions: [{ id: "v1" }] });
        throttledMod.pushStateFor(cid, { mcodeSessions: [{ id: "v2" }] });
        const flushed = throttledMod.flushPendingPushes();
        assert.ok(flushed >= 1, "flushPendingPushes reports cids flushed");
        assert.equal(res.writes.length, 2,
            "immediate flush emits the pending wire frame");
    });

    test("pushes outside window each write (60Hz cap is a soft ceiling)", async () => {
        const cid = "cid-coal-5";
        const res = fakeSse();
        throttledMod.clients.set(cid, throttledMod.makeClientState());
        throttledMod.sseByCid.set(cid, res);
        throttledMod.pushStateFor(cid, { mcodeSessions: [{ id: "a" }] });
        await sleep(25); // > 20ms window
        throttledMod.pushStateFor(cid, { mcodeSessions: [{ id: "b" }] });
        await sleep(25);
        throttledMod.pushStateFor(cid, { mcodeSessions: [{ id: "c" }] });
        await sleep(25);
        assert.equal(res.writes.length, 3,
            "three pushes spaced >window each write");
    });
});

// ============================================================
// pushOnlineCount + broadcast go through the same gate
// ============================================================
describe("pushOnlineCount + broadcast — same diff gate", () => {
    test("pushOnlineCount identical burst is coalesced to 1 write", () => {
        const cid = "cid-oc-1";
        const res = fakeSse();
        clients.set(cid, makeClientState());
        sseByCid.set(cid, res);
        pushOnlineCount(false);
        pushOnlineCount(false);
        pushOnlineCount(false);
        assert.equal(res.writes.length, 1,
            "3 identical pushOnlineCount calls → 1 wire frame");
    });

    test("broadcast with two clients coalesces per-client", () => {
        const a = fakeSse(),
            b = fakeSse();
        clients.set("a", makeClientState());
        clients.set("b", makeClientState());
        sseByCid.set("a", a);
        sseByCid.set("b", b);
        pushStateFor("__broadcast__");
        pushStateFor("__broadcast__");
        assert.equal(a.writes.length, 1,
            "client a receives 1 wire frame (diff gate)");
        assert.equal(b.writes.length, 1,
            "client b receives 1 wire frame (diff gate)");
    });
});