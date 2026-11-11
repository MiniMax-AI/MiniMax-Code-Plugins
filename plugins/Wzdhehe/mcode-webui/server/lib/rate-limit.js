// webui/server/lib/rate-limit.js
// Per-{IP,token} fixed-window rate limiter (v2.0, lease C03).
//
// Design (see docs/HTTPS-REVERSE-PROXY.md §Why a reverse proxy for HTTPS,
// and docs/CAPABILITIES.md §11 for the operational context):
//
//   - Fixed-window counter: each {remoteAddress|token} bucket has a
//     windowStart + count. When Date.now() - windowStart >= WINDOW_MS,
//     the bucket resets. Cheap, no background timers, no drift.
//
//   - Whitelist: requests from loopback (127.0.0.1, ::1, ::ffff:127.0.0.1,
//     or this host's LAN_IP) are NEVER counted or rejected. The webui is
//     often driven from the same machine that hosts it; throttling
//     loopback would break the operator's local-first workflow.
//
//   - Token holders get 2x the per-window budget. The token is the proof
//     of identity — a misconfigured brute-forcer can't see or use it
//     without breaking the comparison in lib/auth.js first. So if you
//     have a valid token, you almost certainly are the operator.
//
//   - Burst ceiling: within a single window, count may exceed the
//     steady-state PER_MIN up to BURST before we 429. This absorbs
//     legitimate user actions (page reload, tab open x10) without
//     triggering false 429s, while keeping the long-run average at
//     PER_MIN / 60s.
//
//   - Token holders double both PER_MIN and BURST (so 60/100 by default
//     becomes 120/200 with a token).
//
//   - State lives in a process-local Map. There is no external store.
//     Restart clears all buckets (intentional — same as token state).
//     A multi-process deployment would need an external counter
//     (Redis / sqlite); not in scope for the embedded single-process
//     webui that ships in this repo.
//
//   - On 429 we emit HTTP 429 + Retry-After: <seconds> + a JSON body.
//     Retry-After is the seconds remaining until the current window
//     rolls over; clients should back off until then.
//
// Public surface:
//   - createRateLimiter(opts?) → { check(req), middleware(req,res,next),
//     reset(), snapshot() }
//   - rateLimitMiddleware(req, res, next) — the default export; uses
//     module-level config so router.js can wire it as a plain function.
//
// The middleware does NOT call writeHead/end directly — it returns
// `{blocked:true, status, headers, body}` so the router can shape its
// own response (keeps coupling loose; mirrors the pattern in
// lib/auth.js#writeAuthRequired).

import { isLocalRequest } from "./lan.js";
import { extractToken } from "./auth.js";
import {
    RATE_LIMIT_PER_MIN,
    RATE_LIMIT_BURST,
} from "./config.js";

const DEFAULT_WINDOW_MS = 60_000; // 60 seconds
// Floor at 1 to avoid div-by-zero / negative Retry-After when env
// is misconfigured. Anything below this is treated as "off" by
// callers using the `enabled` flag.
const FLOOR_PER_MIN = 1;
const FLOOR_BURST = 1;
const FLOOR_WINDOW_MS = 1; // tests need to exercise sub-second windows

// Read an env var as a positive number, with a static fallback.
// Env reads are LAZY (mirroring lib/auth.js#getExpectedToken) so
// tests can flip process.env between calls without re-importing.
function readEnvNumber(name, fallback) {
    const v = Number(process.env[name]);
    if (Number.isFinite(v) && v > 0) return v;
    return fallback;
}

/**
 * Build a per-{IP,token} fixed-window rate limiter.
 *
 * @param {object} [opts]
 *   - perMin   : number — steady-state allowance per 60s window (default: lazy env RATE_LIMIT_PER_MIN, floored at 1)
 *   - burst    : number — hard ceiling within one window (default: lazy env RATE_LIMIT_BURST, floored at 1)
 *   - windowMs : number — window length in ms (default: 60000, floored at 1)
 *   - tokenMultiplier : number — multiplier applied when a valid token is present (default: 2)
 *   - isLocal  : function(req) → boolean — override local check (default: lib/lan.js#isLocalRequest)
 *   - getToken : function(req) → string — override token extractor (default: lib/auth.js#extractToken)
 * @returns {{
 *   check: (req) => {allowed:boolean, remaining:number, retryAfter:number, limit:number, count:number},
 *   middleware: (req,res) => {blocked:boolean, status?:number, headers?:object, body?:object},
 *   reset: () => void,
 *   snapshot: () => {buckets:number, perMin:number, burst:number, windowMs:number}
 * }}
 */
export function createRateLimiter(opts = {}) {
    const perMinRaw = opts.perMin !== undefined
        ? Number(opts.perMin)
        : readEnvNumber("MCODE_WEBUI_RATE_LIMIT", RATE_LIMIT_PER_MIN);
    const burstRaw = opts.burst !== undefined
        ? Number(opts.burst)
        : readEnvNumber("MCODE_WEBUI_RATE_LIMIT_BURST", RATE_LIMIT_BURST);
    const perMin = Math.max(FLOOR_PER_MIN, perMinRaw || FLOOR_PER_MIN);
    const burst = Math.max(FLOOR_BURST, burstRaw || FLOOR_BURST);
    const windowMs = Math.max(FLOOR_WINDOW_MS, Number(opts.windowMs) || DEFAULT_WINDOW_MS);
    const tokenMultiplier = Number(opts.tokenMultiplier) || 2;
    const isLocal = opts.isLocal || isLocalRequest;
    const getToken = opts.getToken || extractToken;

    /** @type {Map<string, {windowStart:number, count:number}>} */
    const buckets = new Map();

    function key(req) {
        const ip = (req && req.socket && req.socket.remoteAddress) || "unknown";
        const tok = getToken(req) || "-";
        return `${ip}|${tok}`;
    }

    function bucketFor(req, now) {
        const k = key(req);
        let b = buckets.get(k);
        if (!b || now - b.windowStart >= windowMs) {
            b = { windowStart: now, count: 0 };
            buckets.set(k, b);
        }
        return { key: k, bucket: b };
    }

    function check(req) {
        const now = Date.now();
        const { bucket } = bucketFor(req, now);
        bucket.count += 1;

        // Whitelist: never count, never reject loopback.
        if (isLocal(req)) {
            return {
                allowed: true,
                remaining: Infinity,
                retryAfter: 0,
                limit: perMin,
                count: bucket.count,
                windowStart: bucket.windowStart,
            };
        }

        const hasToken = !!getToken(req);
        const effectivePerMin = hasToken ? perMin * tokenMultiplier : perMin;
        const effectiveBurst = hasToken ? burst * tokenMultiplier : burst;
        const overSteady = bucket.count > effectivePerMin;
        const overBurst = bucket.count > effectiveBurst;

        if (overBurst) {
            const retryAfter = Math.max(
                1,
                Math.ceil((windowMs - (now - bucket.windowStart)) / 1000),
            );
            return {
                allowed: false,
                remaining: 0,
                retryAfter,
                limit: effectivePerMin,
                count: bucket.count,
                windowStart: bucket.windowStart,
            };
        }

        return {
            allowed: true,
            // remaining is the "soft budget" — within burst but over
            // steady. Clients seeing remaining=0 should slow down
            // even though they aren't blocked yet.
            remaining: overSteady ? 0 : effectivePerMin - bucket.count,
            retryAfter: 0,
            limit: effectivePerMin,
            count: bucket.count,
            windowStart: bucket.windowStart,
        };
    }

    function middleware(req, res) {
        const r = check(req);
        // Surface limit headers on every response, even allowed ones,
        // so well-behaved clients can self-throttle.
        try {
            if (!res.headersSent) {
                res.setHeader(
                    "X-RateLimit-Limit",
                    String(r.limit === Infinity ? perMin : r.limit),
                );
                res.setHeader(
                    "X-RateLimit-Remaining",
                    String(r.remaining === Infinity ? perMin : Math.max(0, r.remaining)),
                );
                res.setHeader(
                    "X-RateLimit-Reset",
                    String(Math.ceil((r.windowStart + windowMs) / 1000)),
                );
            }
        } catch {
            // ignore — header set may fail on already-started responses
        }
        if (r.allowed) return { blocked: false };
        return {
            blocked: true,
            status: 429,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Retry-After": String(r.retryAfter),
            },
            body: { ok: false, error: "rate_limited", retryAfter: r.retryAfter },
        };
    }

    function reset() {
        buckets.clear();
    }

    function snapshot() {
        return {
            buckets: buckets.size,
            perMin,
            burst,
            windowMs,
        };
    }

    return { check, middleware, reset, snapshot };
}

// Module-level singleton so router.js can wire the middleware with a
// single import. Tests that need isolation should call
// createRateLimiter() with custom opts.
const _default = createRateLimiter();

/**
 * Drop-in middleware for router.js. Returns a discriminated-union
 * response object; the router does the actual writeHead/end so it can
 * keep CORS headers and the 204-OPTIONS short-circuit symmetric with
 * the other gates.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {{blocked:boolean, status?:number, headers?:object, body?:object}}
 */
export function rateLimitMiddleware(req, res) {
    return _default.middleware(req, res);
}

/** Test-only: reset the singleton's bucket map. */
export function _resetDefaultForTests() {
    _default.reset();
}

/** Test-only: read the singleton's current state. */
export function _snapshotDefault() {
    return _default.snapshot();
}