// webui/test/routes-alerts.test.js
// Unit tests for server/routes/alerts.js — handleAlerts SSE endpoint.
//
// Why this test exists: lease B02 wires /api/alerts (anomaly SSE).
// The route must:
//   1. Reply with text/event-stream + correct headers
//   2. Replay the ring buffer as a `snapshot` frame
//   3. Forward subsequent pushAlert() frames to the subscriber
//   4. Tear down heartbeat + subscriber on `req.on("close")`
//
// Test strategy: NO setupMocks — alerts.js is the only dep and is
// pure. We synthesize a fake req/res with a write hook and exercise
// the live broadcast path.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
    pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const alertsRoute = await import(absPath("routes/alerts.js"));
const alertsLib = await import(absPath("lib/alerts.js"));

function fakeRes() {
    const res = {
        _status: null,
        _headers: null,
        writes: [],
        writeHead(s, h) {
            this._status = s;
            this._headers = h;
        },
        write(chunk) {
            this.writes.push(chunk);
            return true;
        },
    };
    return res;
}

function fakeReq() {
    const req = new EventEmitter();
    return req;
}

describe("handleAlerts — /api/alerts", () => {
    beforeEach(() => {
        alertsLib._resetForTests();
    });

    test("returns 200 with SSE headers", async () => {
        const req = fakeReq();
        const res = fakeRes();
        const handled = await alertsRoute.handleAlerts(req, res, { cid: "c" });
        assert.equal(handled, true);
        assert.equal(res._status, 200);
        assert.match(res._headers["Content-Type"], /text\/event-stream/);
        assert.match(res._headers["Cache-Control"], /no-cache/);
        assert.equal(res._headers["X-Accel-Buffering"], "no");
        // prevent the heartbeat interval from keeping the test loop alive
        req.emit("close");
    });

    test("first frame is a snapshot of the ring buffer", async () => {
        alertsLib.pushAlert({ level: "info", msg: "first", src: "s" });
        alertsLib.pushAlert({ level: "error", msg: "second", src: "s" });
        const req = fakeReq();
        const res = fakeRes();
        await alertsRoute.handleAlerts(req, res, {});
        const snapFrame = JSON.parse(res.writes[0].slice(6));
        assert.equal(snapFrame.kind, "snapshot");
        assert.equal(snapFrame.alerts.length, 2);
        assert.equal(snapFrame.alerts[0].msg, "first");
        assert.equal(snapFrame.alerts[1].msg, "second");
        req.emit("close");
    });

    test("live pushAlert after subscribe is forwarded as an `append` frame", async () => {
        const req = fakeReq();
        const res = fakeRes();
        await alertsRoute.handleAlerts(req, res, {});
        const writesBefore = res.writes.length;

        alertsLib.pushAlert({
            level: "warn",
            msg: "live",
            src: "s",
            cid: "cid-x",
        });

        assert.equal(res.writes.length, writesBefore + 1);
        const liveFrame = JSON.parse(
            res.writes[res.writes.length - 1].slice(6),
        );
        assert.equal(liveFrame.kind, "append");
        assert.equal(liveFrame.alert.msg, "live");
        assert.equal(liveFrame.alert.cid, "cid-x");
        req.emit("close");
    });

    test("req close → subscriber is removed", async () => {
        const req = fakeReq();
        const res = fakeRes();
        await alertsRoute.handleAlerts(req, res, {});
        assert.equal(alertsLib.getSubscriberCount(), 1);
        req.emit("close");
        assert.equal(alertsLib.getSubscriberCount(), 0);
    });

    test("req close → no further frames after unsubscribe", async () => {
        const req = fakeReq();
        const res = fakeRes();
        await alertsRoute.handleAlerts(req, res, {});
        const writesBefore = res.writes.length;
        req.emit("close");
        alertsLib.pushAlert({ level: "info", msg: "post-close", src: "s" });
        assert.equal(res.writes.length, writesBefore);
    });

    test("returns true on client already gone (write throws during replay)", async () => {
        const req = fakeReq();
        const res = {
            writeHead() {},
            write() {
                throw new Error("socket hang up");
            },
        };
        const handled = await alertsRoute.handleAlerts(req, res, {});
        assert.equal(handled, true);
        // cleanup
        req.emit("close");
    });
});