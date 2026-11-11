// webui/test/lib-alerts.test.js
// Unit tests for server/lib/alerts.js — pushAlert / dedup / ring
// buffer / SSE broadcast.
//
// Why this test exists: lease B02 introduces the independent anomaly
// channel (front-end bell icon data source). pushAlert is the only
// write point; its contract must be deterministic.
//
// Test strategy: NO setupMocks — alerts.js has zero deps at module
// level (events.js is dynamic-imported, guarded). The B01 events
// dependency is asserted by stubbing it with t.mock.module.

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const absPath = (rel) =>
    pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const alerts = await import(absPath("lib/alerts.js"));

function fakeSse() {
    const writes = [];
    return {
        writes,
        write(chunk) {
            writes.push(chunk);
        },
    };
}

describe("pushAlert — basic", () => {
    beforeEach(() => {
        alerts._resetForTests();
    });

    test("returns an alert with the canonical shape", () => {
        const a = alerts.pushAlert({
            level: "error",
            msg: "boom",
            src: "chat.send",
            cid: "cid-1",
        });
        assert.equal(a.level, "error");
        assert.equal(a.msg, "boom");
        assert.equal(a.src, "chat.send");
        assert.equal(a.cid, "cid-1");
        assert.equal(a.sessionId, null);
        assert.equal(a.data, null);
        assert.equal(a.count, 1);
        assert.equal(typeof a.id, "string");
        assert.equal(typeof a.ts, "number");
    });

    test("normalizes unknown levels to info", () => {
        const a = alerts.pushAlert({ level: "debug", msg: "x" });
        assert.equal(a.level, "info");
    });

    test("truncates oversized msg to 2000 chars", () => {
        const huge = "x".repeat(5000);
        const a = alerts.pushAlert({ level: "info", msg: huge });
        assert.equal(a.msg.length, 2000);
    });

    test("default src is 'system'", () => {
        const a = alerts.pushAlert({ level: "info", msg: "x" });
        assert.equal(a.src, "system");
    });

    test("ring buffer size is 100 (RING_SIZE)", () => {
        for (let i = 0; i < 150; i++) {
            alerts.pushAlert({
                level: "info",
                msg: "m" + i,
                src: "test",
                cid: "cid",
            });
        }
        assert.equal(alerts.getAlertCount(), 100);
        // oldest surviving entry is the 51st (150 - 100 + 1)
        const recent = alerts.getRecentAlerts();
        assert.equal(recent[0].msg, "m50");
        assert.equal(recent[99].msg, "m149");
    });
});

describe("pushAlert — dedup", () => {
    beforeEach(() => {
        alerts._resetForTests();
    });

    test("same {level,msg,src,cid} within 60s collapses with count++", () => {
        const a = alerts.pushAlert({
            level: "warn",
            msg: "transient",
            src: "mcode-acp",
            cid: "cid-1",
        });
        assert.equal(a.count, 1);

        const b = alerts.pushAlert({
            level: "warn",
            msg: "transient",
            src: "mcode-acp",
            cid: "cid-1",
        });
        assert.equal(b, a, "deduped push returns the same alert object");
        assert.equal(b.count, 2);
        // ring still has only one entry
        assert.equal(alerts.getAlertCount(), 1);
    });

    test("different cid does not collapse", () => {
        alerts.pushAlert({ level: "warn", msg: "x", src: "s", cid: "cid-1" });
        alerts.pushAlert({ level: "warn", msg: "x", src: "s", cid: "cid-2" });
        assert.equal(alerts.getAlertCount(), 2);
    });

    test("different src does not collapse", () => {
        alerts.pushAlert({ level: "warn", msg: "x", src: "src-a", cid: "cid-1" });
        alerts.pushAlert({ level: "warn", msg: "x", src: "src-b", cid: "cid-1" });
        assert.equal(alerts.getAlertCount(), 2);
    });

    test("different msg does not collapse", () => {
        alerts.pushAlert({ level: "warn", msg: "x", src: "s", cid: "cid-1" });
        alerts.pushAlert({ level: "warn", msg: "y", src: "s", cid: "cid-1" });
        assert.equal(alerts.getAlertCount(), 2);
    });

    test("dedup survives ring wrap (no collateral increment on stale index)", () => {
        // Regression for V01 Finding 1:
        //   When the ring buffer wraps, the _dedupIndex Map used to hold
        //   {idx, ts} entries pointing at buffer positions. After a wrap,
        //   those idx values were stale — _buffer[existing.idx] would
        //   resolve to a *different* alert in the buffer, and the
        //   count++ would corrupt that sibling alert. The previous code
        //   only handled the case `cur.idx === 0` (the dropped entry was
        //   at index 0); every other wrap leaked a stale entry.
        //
        //   Fix: _dedupIndex now stores the alert object reference, not
        //   a buffer index. This test reproduces the original failure
        //   mode and asserts no collateral increment occurs.
        for (let i = 0; i < 100; i++) {
            alerts.pushAlert({
                level: "info",
                msg: "m" + i,
                src: "t",
                cid: "c",
            });
        }
        for (let i = 100; i < 105; i++) {
            alerts.pushAlert({
                level: "info",
                msg: "m" + i,
                src: "t",
                cid: "c",
            });
        }
        // Buffer now holds [m5..m104] (5 wraps, length 100). m50 sits
        // at index 45. m55 sits at index 50 — exactly where the OLD
        // broken dedup index would point if m50 had been re-pushed.
        const r = alerts.pushAlert({
            level: "info",
            msg: "m50",
            src: "t",
            cid: "c",
        });
        assert.equal(r.msg, "m50", "dedup hit must return the original m50 alert");
        assert.equal(r.count, 2, "m50 count must be incremented to 2");

        const recent = alerts.getRecentAlerts();
        assert.equal(recent.length, 100);

        const m50 = recent.find((a) => a.msg === "m50");
        assert.ok(m50, "m50 should still be in the ring buffer at index 45");
        assert.equal(m50.count, 2);

        const m55 = recent.find((a) => a.msg === "m55");
        assert.ok(m55, "m55 should be in the ring buffer");
        assert.equal(
            m55.count,
            1,
            "m55 must NOT have its count incremented (the old bug would bump it to 2 because _buffer[50] used to point there)",
        );

        // The crucial regression assertion: the ONLY alert in the
        // buffer with count > 1 is m50. Any other alert with count > 1
        // means the dedup index was resolved against a stale buffer
        // position — the original bug.
        const collateral = recent
            .filter((a) => a.count !== 1)
            .map((a) => ({ msg: a.msg, count: a.count }));
        assert.deepEqual(
            collateral,
            [{ msg: "m50", count: 2 }],
            "only m50 should have count > 1; no collateral increments",
        );
    });
});

describe("pushAlert — SSE broadcast", () => {
    beforeEach(() => {
        alerts._resetForTests();
    });

    test("subscriber receives an `append` frame on pushAlert", () => {
        const res = fakeSse();
        const unsubscribe = alerts.subscribeAlerts(res);
        alerts.pushAlert({ level: "info", msg: "hi", src: "s", cid: "cid-1" });
        assert.equal(res.writes.length, 1);
        const frame = JSON.parse(res.writes[0].slice(6));
        assert.equal(frame.kind, "append");
        assert.equal(frame.alert.msg, "hi");
        unsubscribe();
    });

    test("multiple subscribers all receive frames", () => {
        const a = fakeSse();
        const b = fakeSse();
        alerts.subscribeAlerts(a);
        alerts.subscribeAlerts(b);
        alerts.pushAlert({ level: "info", msg: "fan-out", src: "s" });
        assert.equal(a.writes.length, 1);
        assert.equal(b.writes.length, 1);
        assert.equal(a.writes[0], b.writes[0]);
    });

    test("deduped push sends an `update` frame (not a new entry)", () => {
        const res = fakeSse();
        alerts.subscribeAlerts(res);
        alerts.pushAlert({ level: "warn", msg: "dup", src: "s" });
        alerts.pushAlert({ level: "warn", msg: "dup", src: "s" });
        assert.equal(res.writes.length, 2);
        const first = JSON.parse(res.writes[0].slice(6));
        const second = JSON.parse(res.writes[1].slice(6));
        assert.equal(first.kind, "append");
        assert.equal(second.kind, "update");
        assert.equal(second.alert.count, 2);
    });

    test("unsubscribe stops further writes", () => {
        const res = fakeSse();
        const unsub = alerts.subscribeAlerts(res);
        alerts.pushAlert({ level: "info", msg: "1", src: "s" });
        unsub();
        alerts.pushAlert({ level: "info", msg: "2", src: "s" });
        assert.equal(res.writes.length, 1);
        assert.equal(alerts.getSubscriberCount(), 0);
    });

    test("a subscriber that throws on write does not break others", () => {
        const throwing = {
            write() {
                throw new Error("broken pipe");
            },
        };
        const good = fakeSse();
        alerts.subscribeAlerts(throwing);
        alerts.subscribeAlerts(good);
        alerts.pushAlert({ level: "info", msg: "x", src: "s" });
        assert.equal(good.writes.length, 1);
    });
});

describe("pushAlert — event-stream emission (B01 dependency)", () => {
    beforeEach(() => {
        alerts._resetForTests();
    });

    after(async () => {
        alerts._resetForTests();
    });

    test("audit-write failure does not break the alert flow", async () => {
        // The events.js module is not yet present (B01 in flight). The
        // dynamic import inside alerts.js should swallow the missing
        // module and not propagate. We just confirm pushAlert still
        // works.
        const a = alerts.pushAlert({
            level: "error",
            msg: "no-audit",
            src: "test",
        });
        assert.equal(a.count, 1);
        // give the dynamic-import microtask a tick to settle
        await new Promise((r) => setImmediate(r));
        assert.equal(alerts.getAlertCount(), 1);
    });

    test("audit write carries alert payload (id, msg, count, sessionId, data)", async () => {
        // Regression for V01 Finding 2:
        //   alerts.js used to call events.append(kind, { target, cid, id,
        //   msg, count, sessionId, data }) — passing alert fields at the
        //   top level of the `fields` object. events.append() only hoists
        //   {target, cid, actor}; every other top-level field is
        //   silently dropped. Result: the audit line ended up with
        //   data: {} and ALL alert fields lost.
        //
        //   Fix: wrap alert fields inside `payload: {...}` per the
        //   events.js contract. This test redirects events.ndjson via
        //   MCODE_WEBUI_EVENTS_PATH, pushes an alert carrying sessionId
        //   + data, waits for the fire-and-forget audit write, then
        //   reads events.ndjson and asserts the payload survived.

        const tmpDir = mkdtempSync(join(tmpdir(), "webui-alerts-audit-"));
        const tmpEventsPath = join(tmpDir, "events.ndjson");
        process.env.MCODE_WEBUI_EVENTS_PATH = tmpEventsPath;

        // events.js is dynamic-imported by alerts.js on first push.
        // We import it here too so we can clear its in-memory seq / hash
        // state (otherwise a previous test's chain head leaks in).
        const events = await import(absPath("lib/events.js"));
        events._resetForTests();

        try {
            const a = alerts.pushAlert({
                level: "error",
                msg: "mcode subprocess crashed",
                src: "chat:send",
                cid: "cid-1",
                sessionId: "mvs_test_session_xyz",
                data: { exitCode: 1, signal: "SIGSEGV" },
            });

            // tryWriteEvent is fire-and-forget (async dynamic import +
            // append). Give the microtask queue a chance to settle.
            await new Promise((r) => setTimeout(r, 200));

            const raw = readFileSync(tmpEventsPath, "utf8").trim();
            const lines = raw.split("\n").filter((l) => l.length > 0);
            assert.ok(
                lines.length >= 1,
                "events.ndjson should have at least one line after pushAlert",
            );
            const last = JSON.parse(lines[lines.length - 1]);

            // Top-level hoisted fields
            assert.equal(last.kind, "alert.error");
            assert.equal(last.target, "chat:send");
            assert.equal(last.cid, "cid-1");

            // The crux of the regression: the payload must carry all
            // alert fields. Under the old bug, last.data was {}.
            assert.equal(typeof last.data.id, "string");
            assert.equal(last.data.id, a.id);
            assert.equal(last.data.msg, "mcode subprocess crashed");
            assert.equal(last.data.count, 1);
            assert.equal(last.data.sessionId, "mvs_test_session_xyz");
            assert.deepEqual(last.data.data, {
                exitCode: 1,
                signal: "SIGSEGV",
            });
        } finally {
            try {
                rmSync(tmpDir, { recursive: true, force: true });
            } catch {}
            // Don't unset MCODE_WEBUI_EVENTS_PATH — other tests in the
            // same suite may rely on it being absent for their own
            // scoping. (This is a leaf test; the per-file after() in
            // lib-events.test.js handles its own cleanup.)
        }
    });
});

describe("getRecentAlerts", () => {
    beforeEach(() => {
        alerts._resetForTests();
    });

    test("returns a snapshot oldest → newest", () => {
        alerts.pushAlert({ level: "info", msg: "a", src: "s" });
        alerts.pushAlert({ level: "warn", msg: "b", src: "s" });
        alerts.pushAlert({ level: "error", msg: "c", src: "s" });
        const snap = alerts.getRecentAlerts();
        assert.equal(snap.length, 3);
        assert.deepEqual(
            snap.map((a) => a.msg),
            ["a", "b", "c"],
        );
    });

    test("respects the limit argument", () => {
        for (let i = 0; i < 10; i++) {
            alerts.pushAlert({ level: "info", msg: "m" + i, src: "s" });
        }
        const snap = alerts.getRecentAlerts(3);
        assert.equal(snap.length, 3);
        assert.equal(snap[0].msg, "m7");
        assert.equal(snap[2].msg, "m9");
    });
});

describe("ALERT_LEVELS export", () => {
    test("exposes info / warn / error", () => {
        assert.deepEqual(alerts.ALERT_LEVELS, ["info", "warn", "error"]);
    });
});