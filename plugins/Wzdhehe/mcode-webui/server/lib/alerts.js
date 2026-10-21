// webui/server/lib/alerts.js
// Anomaly channel — independent SSE bus for system-level signals
// (mcode subprocess crash, token expired, sqlite failure, protocol
// unsupported, etc.).
//
// Design (lease B02):
//   • Three levels: "info" / "warn" / "error"
//   • Ring buffer (last 100 alerts) — SSE replay on connect
//   • Dedup window 60s — same {level, msg, src, cid} collapses to one
//     alert with `count` incremented (avoids spam)
//   • Optional event-stream emission (depends on B01 events.js — see
//     `tryWriteEvent` below). kind = `alert.{level}`.
//   • Pure module: no fs / spawn side-effects on import. Event writing
//     is dynamic-import + guarded; missing events.js → silent skip.
//
// Why independent of state-bus:
//   state-bus pushes per-cid state. Alerts are broadcast (no cid scope
//   is required for the system-level signal), plus they have their own
//   dedup / replay semantics. A single chokepoint per concern, not a
//   single chokepoint total.

import { randomUUID } from "node:crypto";

// Ring buffer — fixed size, head drops oldest
const RING_SIZE = 100;
// Dedup window — collapse identical alerts within this window (ms)
const DEDUP_WINDOW_MS = 60_000;

const _buffer = []; // newest at end
const _subscribers = new Set(); // SSE response objects
// dedupKey → { alert, ts }. Storing the alert object (by reference) — not
// its buffer index — means wrap-and-shift of the ring buffer does not
// invalidate the dedup hit. (See Finding 1 fix; previously we stored idx
// and the `if (cur.idx === 0) delete` block only handled one specific
// case, leaving stale idx>0 entries after every other wrap.)
const _dedupIndex = new Map();

// ---------- helpers ----------

function dedupKey(level, msg, src, cid) {
    // src may be a string ("chat") or compound ("chat:send"); we keep it
    // as-is. cid is part of the key so "chat error in tab A" and "chat
    // error in tab B" do not collapse into one.
    return `${level}|${src || ""}|${cid || ""}|${msg}`;
}

function pushRing(alert) {
    _buffer.push(alert);
    if (_buffer.length > RING_SIZE) {
        // Drop the oldest entry. We do NOT touch _dedupIndex here: the
        // dedup index stores the alert object by reference (see comment
        // on _dedupIndex declaration), so a wrap doesn't invalidate any
        // dedup hit — `existing.alert` always resolves to the live
        // alert, whether or not it's still in the buffer. The dedup
        // window itself (DEDUP_WINDOW_MS) handles staleness.
        _buffer.shift();
    }
}

// Write a structured event to events.ndjson (B01 dependency).
// Dynamic import + try/catch — if B01 is not yet implemented, alerts
// still work in-process; the audit-trail write is best-effort.
let _eventsMod = null;
let _eventsModTried = false;
async function tryWriteEvent(alert) {
    if (_eventsModTried && !_eventsMod) return; // already known missing
    if (!_eventsMod) {
        _eventsModTried = true;
        try {
            // Dynamic import is async — we resolve once and cache. Use
            // the module-relative path so the lease stays inside
            // server/lib without needing config.js.
            const url = new URL("./events.js", import.meta.url);
            _eventsMod = await import(url.href);
        } catch {
            _eventsMod = null;
            return;
        }
    }
    if (!_eventsMod || typeof _eventsMod.append !== "function") return;
    try {
        // B01 contract: append(kind, fields, opts).
        //   `target` and `cid` are hoisted to top-level fields inside
        //   append(). ALL other alert fields MUST go inside `payload` —
        //   events.append() treats any top-level field outside the
        //   reserved {target,cid,actor,kind,seq,ts,before_hash,after_hash}
        //   set as a typo and silently drops it. (See Finding 2 fix:
        //   previously id/msg/count/sessionId/data were passed at
        //   top-level and the entire payload vanished from the line.)
        const {
            id,
            msg,
            count,
            sessionId,
            data,
        } = alert;
        _eventsMod.append(`alert.${alert.level}`, {
            target: alert.src || "",
            cid: alert.cid || "",
            payload: {
                id,
                msg,
                count,
                sessionId: sessionId || null,
                data: data || null,
            },
        });
    } catch {
        // audit write failure must not break the alert flow
    }
}

// ---------- public API ----------

// Normalize an input alert into the canonical shape.
function normalize(input) {
    const level = input && input.level;
    const allowed = ["info", "warn", "error"];
    const lvl = allowed.includes(level) ? level : "info";
    const msg = (input && input.msg ? String(input.msg) : "").slice(0, 2000);
    const src = input && input.src ? String(input.src).slice(0, 200) : "system";
    return {
        id: (input && input.id) || randomUUID(),
        ts: Date.now(),
        level: lvl,
        msg,
        src,
        cid: input && input.cid ? String(input.cid).slice(0, 200) : null,
        sessionId:
            input && input.sessionId ? String(input.sessionId).slice(0, 200) : null,
        data: input && input.data !== undefined ? input.data : null,
    };
}

// pushAlert — add a system-level signal. Dedups, ring-buffers,
// broadcasts to SSE subscribers, and (best-effort) writes an audit
// event. Returns the alert object that was added (or the existing
// dedup-matched alert with count incremented).
export function pushAlert(input) {
    const alert = normalize(input);
    const key = dedupKey(alert.level, alert.msg, alert.src, alert.cid);
    const now = alert.ts;
    const existing = _dedupIndex.get(key);
    if (existing && now - existing.ts < DEDUP_WINDOW_MS) {
        // Merge into the existing entry — bump count, refresh ts.
        // Resolve via the stored alert reference, not via buffer index,
        // so a ring-buffer wrap cannot redirect the increment to the
        // wrong alert. (See Finding 1 fix.)
        const target = existing.alert;
        if (target) {
            target.count = (target.count || 1) + 1;
            target.ts = now;
            // SSE: tell subscribers the count changed
            broadcast({ kind: "update", alert: target });
        }
        // Audit: one event per push attempt is too noisy; skip audit
        // for the deduped merges. The first push already wrote one.
        return target || alert;
    }
    alert.count = 1;
    alert._dedupKey = key;
    pushRing(alert);
    _dedupIndex.set(key, { alert, ts: now });
    broadcast({ kind: "append", alert });
    // Fire-and-forget audit write
    tryWriteEvent(alert);
    return alert;
}

// Broadcast a frame to every SSE subscriber.
function broadcast(frame) {
    const payload = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of _subscribers) {
        try {
            res.write(payload);
        } catch {
            // Subscriber write failed — drop on next subscribe cycle
        }
    }
}

// getRecentAlerts — snapshot of the ring buffer (oldest → newest).
// Used for SSE replay on connect.
export function getRecentAlerts(limit) {
    if (typeof limit !== "number" || limit <= 0 || limit > RING_SIZE) {
        return _buffer.slice();
    }
    return _buffer.slice(-limit);
}

// subscribeAlerts — register an SSE response. Returns an `unsubscribe`
// thunk that the route must call on `req.on("close")`.
export function subscribeAlerts(res) {
    _subscribers.add(res);
    return function unsubscribe() {
        if (_subscribers.has(res)) _subscribers.delete(res);
    };
}

// For tests / diagnostics — counts without exposing internals.
export function getAlertCount() {
    return _buffer.length;
}

export function getSubscriberCount() {
    return _subscribers.size;
}

// ---------- test-only ----------

// _resetForTests — clears the ring buffer, dedup index, and subscribers.
// Module-internal name to flag that production code must not call it.
export function _resetForTests() {
    _buffer.length = 0;
    _dedupIndex.clear();
    _subscribers.clear();
}

// Constants exported for tests + doc clarity.
export const ALERT_LEVELS = ["info", "warn", "error"];
export const ALERT_RING_SIZE = RING_SIZE;
export const ALERT_DEDUP_WINDOW_MS = DEDUP_WINDOW_MS;