// webui/server/routes/alerts.js
// GET /api/alerts (SSE) — independent anomaly / system-signal channel.
//
// Protocol (mirrors /api/events but simpler):
//   1. Server writes SSE headers + a snapshot of the ring buffer.
//   2. On every pushAlert(), an `append` or `update` frame is sent.
//   3. Heartbeat: every 30s a `event: heartbeat` frame.
//   4. On req "close", unsubscribe + clear heartbeat interval.
//
// Frame shapes:
//   data: {"kind":"snapshot","alerts":[...]}
//   data: {"kind":"append","alert":{...}}
//   data: {"kind":"update","alert":{...}}
//   event: heartbeat
//   data: {"ts":<ms>}
//
// Frontend (bell icon — owned by C batch, not this lease) is expected
// to subscribe via `new EventSource("/api/alerts")` and render the
// ring buffer + increment an unread counter on each `append`.

import {
    getRecentAlerts,
    subscribeAlerts,
} from "../lib/alerts.js";

const SSE_HEADERS = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
};

const HEARTBEAT_MS = 30_000;

export async function handleAlerts(req, res, _ctx) {
    res.writeHead(200, SSE_HEADERS);

    // 1. Replay ring buffer as a single snapshot frame.
    const snapshot = {
        kind: "snapshot",
        alerts: getRecentAlerts(),
    };
    try {
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    } catch {
        // Client already gone — nothing to do.
        return true;
    }

    // 2. Subscribe to live updates.
    const unsubscribe = subscribeAlerts(res);

    // 3. Heartbeat — keeps proxies from idling the SSE channel out.
    const heartbeat = setInterval(() => {
        try {
            res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
        } catch {
            // Will be cleaned up on close.
        }
    }, HEARTBEAT_MS);
    // Don't keep the event loop alive just for heartbeats.
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    // 4. Cleanup on disconnect.
    req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
    });

    return true;
}