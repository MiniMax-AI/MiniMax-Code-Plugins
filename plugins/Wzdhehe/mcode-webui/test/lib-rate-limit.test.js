// webui/test/lib-rate-limit.test.js
// Unit tests for server/lib/rate-limit.js (v2.0, lease C03).
//
// What we lock in:
//   - localhost / 127.0.0.1 / ::1 are NEVER throttled
//   - Non-local requests are throttled per {IP,token}
//   - Token holders get 2x budget
//   - Burst ceiling is enforced: count > burst → 429
//   - Steady-state PER_MIN triggers soft remaining=0 but not yet 429
//   - 429 carries Retry-After + JSON body
//   - Headers (X-RateLimit-*) are set on every response
//   - Singleton is test-isolated via _resetDefaultForTests()
//
// We use createRateLimiter({...}) with explicit opts rather than the
// singleton for most tests so we don't have to mutate process.env.

import { test, describe, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(TEST_DIR, "..", "server");
const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href;

const rateLimit = await import(absPath("lib/rate-limit.js"));
const {
    createRateLimiter,
    rateLimitMiddleware,
    _resetDefaultForTests,
    _snapshotDefault,
} = rateLimit;

// Minimal req stub. The limiter only touches req.socket.remoteAddress
// and req.headers / req.url (via extractToken).
function fakeReq(opts = {}) {
    const {
        remoteAddress = "192.0.2.1",
        headers = {},
        url = "/api/state",
        method = "GET",
    } = opts;
    return {
        method,
        url,
        headers,
        socket: { remoteAddress },
    };
}

// Minimal res stub. The middleware writes X-RateLimit-* headers via
// setHeader; we capture those and a `headersSent` flag.
function fakeRes() {
    const headers = {};
    let headersSent = false;
    return {
        headers,
        get headersSent() {
            return headersSent;
        },
        setHeader(name, value) {
            headers[name] = value;
        },
        writeHead() {
            headersSent = true;
        },
        end() {
            headersSent = true;
        },
    };
}

describe("rate-limit — createRateLimiter shape", () => {
    test("returns { check, middleware, reset, snapshot }", () => {
        const rl = createRateLimiter({ perMin: 5, burst: 5 });
        assert.equal(typeof rl.check, "function");
        assert.equal(typeof rl.middleware, "function");
        assert.equal(typeof rl.reset, "function");
        assert.equal(typeof rl.snapshot, "function");
    });

    test("snapshot exposes config", () => {
        const rl = createRateLimiter({ perMin: 7, burst: 11, windowMs: 30000 });
        const s = rl.snapshot();
        assert.equal(s.perMin, 7);
        assert.equal(s.burst, 11);
        assert.equal(s.windowMs, 30000);
        assert.equal(typeof s.buckets, "number");
    });

    test("floors perMin / burst at 1 (env guard)", () => {
        const rl = createRateLimiter({ perMin: 0, burst: -3 });
        assert.equal(rl.snapshot().perMin, 1);
        assert.equal(rl.snapshot().burst, 1);
    });

    test("reset() clears all buckets", () => {
        const rl = createRateLimiter({ perMin: 2, burst: 2 });
        rl.check(fakeReq({ remoteAddress: "10.0.0.1" }));
        rl.check(fakeReq({ remoteAddress: "10.0.0.2" }));
        assert.ok(rl.snapshot().buckets >= 2);
        rl.reset();
        assert.equal(rl.snapshot().buckets, 0);
    });
});

describe("rate-limit — whitelist (loopback)", () => {
    const rl = createRateLimiter({ perMin: 1, burst: 1, windowMs: 60000 });

    test("127.0.0.1 is never blocked regardless of count", () => {
        // Even with perMin=1 / burst=1, 50 requests from loopback pass.
        for (let i = 0; i < 50; i++) {
            const r = rl.check(fakeReq({ remoteAddress: "127.0.0.1" }));
            assert.equal(r.allowed, true, `request ${i + 1} should be allowed`);
            assert.equal(r.remaining, Infinity);
        }
    });

    test("::1 is never blocked", () => {
        for (let i = 0; i < 50; i++) {
            const r = rl.check(fakeReq({ remoteAddress: "::1" }));
            assert.equal(r.allowed, true);
        }
    });

    test("::ffff:127.0.0.1 (IPv4-mapped IPv6 loopback) is never blocked", () => {
        for (let i = 0; i < 50; i++) {
            const r = rl.check(fakeReq({ remoteAddress: "::ffff:127.0.0.1" }));
            assert.equal(r.allowed, true);
        }
    });
});

describe("rate-limit — non-local bucket", () => {
    test("first request: allowed, remaining = perMin - 1", () => {
        const rl = createRateLimiter({ perMin: 5, burst: 5 });
        const r = rl.check(fakeReq({ remoteAddress: "10.0.0.5" }));
        assert.equal(r.allowed, true);
        assert.equal(r.remaining, 4);
        assert.equal(r.limit, 5);
        assert.equal(r.count, 1);
    });

    test("count within PER_MIN is allowed with non-zero remaining", () => {
        const rl = createRateLimiter({ perMin: 5, burst: 10 });
        for (let i = 0; i < 5; i++) {
            const r = rl.check(fakeReq({ remoteAddress: "10.0.0.6" }));
            assert.equal(r.allowed, true);
        }
    });

    test("count > PER_MIN but <= BURST: still allowed, remaining=0 (soft signal)", () => {
        const rl = createRateLimiter({ perMin: 5, burst: 10 });
        for (let i = 0; i < 5; i++) {
            rl.check(fakeReq({ remoteAddress: "10.0.0.7" }));
        }
        // 6..10 are above steady but below burst ceiling
        for (let i = 0; i < 5; i++) {
            const r = rl.check(fakeReq({ remoteAddress: "10.0.0.7" }));
            assert.equal(r.allowed, true, `request ${i + 6} should still pass (within burst)`);
            assert.equal(r.remaining, 0);
        }
    });

    test("count > BURST: blocked with 429-style result", () => {
        const rl = createRateLimiter({ perMin: 5, burst: 10 });
        for (let i = 0; i < 10; i++) {
            rl.check(fakeReq({ remoteAddress: "10.0.0.8" }));
        }
        const r = rl.check(fakeReq({ remoteAddress: "10.0.0.8" }));
        assert.equal(r.allowed, false);
        assert.equal(r.retryAfter >= 1, true);
        assert.equal(r.retryAfter <= 60, true);
    });

    test("separate IPs have separate buckets", () => {
        const rl = createRateLimiter({ perMin: 2, burst: 2 });
        // IP-A: 2 allowed, 3rd blocked
        assert.equal(rl.check(fakeReq({ remoteAddress: "10.0.1.1" })).allowed, true);
        assert.equal(rl.check(fakeReq({ remoteAddress: "10.0.1.1" })).allowed, true);
        assert.equal(rl.check(fakeReq({ remoteAddress: "10.0.1.1" })).allowed, false);
        // IP-B: independent bucket, still allowed
        assert.equal(rl.check(fakeReq({ remoteAddress: "10.0.1.2" })).allowed, true);
        assert.equal(rl.check(fakeReq({ remoteAddress: "10.0.1.2" })).allowed, true);
    });

    test("separate tokens (same IP) have separate buckets", () => {
        const rl = createRateLimiter({ perMin: 2, burst: 2 });
        // Same IP, no token: 2 allowed, 3rd blocked
        assert.equal(
            rl.check(fakeReq({ remoteAddress: "10.0.2.1", url: "/api/state" })).allowed,
            true,
        );
        assert.equal(
            rl.check(fakeReq({ remoteAddress: "10.0.2.1", url: "/api/state" })).allowed,
            true,
        );
        assert.equal(
            rl.check(fakeReq({ remoteAddress: "10.0.2.1", url: "/api/state" })).allowed,
            false,
        );
        // Same IP, token=alice: separate bucket, still allowed
        const req = fakeReq({
            remoteAddress: "10.0.2.1",
            headers: { authorization: "Bearer alice" },
            url: "/api/state",
        });
        assert.equal(rl.check(req).allowed, true);
        assert.equal(rl.check(req).allowed, true);
    });
});

describe("rate-limit — token multiplier (2x)", () => {
    test("token holder gets 2x perMin and 2x burst", () => {
        const rl = createRateLimiter({ perMin: 5, burst: 10 });
        // No token: blocked at 11 (burst+1)
        const noTok = fakeReq({ remoteAddress: "10.1.0.1", url: "/api/state" });
        for (let i = 0; i < 10; i++) {
            rl.check(noTok);
        }
        const noTokBlocked = rl.check(noTok);
        assert.equal(noTokBlocked.allowed, false);
        // Token holder: with multiplier 2, allowed at 11 (still within 2*burst=20)
        const tok = fakeReq({
            remoteAddress: "10.1.0.2",
            headers: { authorization: "Bearer alice" },
            url: "/api/state",
        });
        for (let i = 0; i < 10; i++) {
            const r = rl.check(tok);
            assert.equal(r.allowed, true);
            assert.equal(r.limit, 10); // 5 * 2
        }
        // 11th: still within burst (20), allowed, remaining=0
        const r11 = rl.check(tok);
        assert.equal(r11.allowed, true);
        assert.equal(r11.limit, 10);
    });

    test("non-token holder limit field reflects unmultiplied perMin", () => {
        const rl = createRateLimiter({ perMin: 5, burst: 10 });
        const r = rl.check(fakeReq({ remoteAddress: "10.1.0.3", url: "/api/state" }));
        assert.equal(r.limit, 5);
    });

    test("token holder limit field reflects 2x perMin", () => {
        const rl = createRateLimiter({ perMin: 5, burst: 10 });
        const r = rl.check(
            fakeReq({
                remoteAddress: "10.1.0.4",
                headers: { authorization: "Bearer alice" },
                url: "/api/state",
            }),
        );
        assert.equal(r.limit, 10);
    });
});

describe("rate-limit — middleware response shape", () => {
    test("allowed: returns { blocked: false } and sets X-RateLimit-* headers", () => {
        _resetDefaultForTests();
        const res = fakeRes();
        const req = fakeReq({ remoteAddress: "10.2.0.1", url: "/api/state" });
        const r = rateLimitMiddleware(req, res);
        assert.equal(r.blocked, false);
        assert.ok(res.headers["X-RateLimit-Limit"]);
        assert.ok(res.headers["X-RateLimit-Remaining"]);
        assert.ok(res.headers["X-RateLimit-Reset"]);
    });

    test("blocked: returns { blocked, status:429, headers, body } with Retry-After", () => {
        // Use a tight local limiter via opts — go through the factory so
        // we don't have to wait on the singleton to fill up. We can't
        // replace the singleton's opts, so we exercise the singleton
        // shape by hitting it directly.
        _resetDefaultForTests();
        // Singleton uses default env-based limits (60/100). We can't
        // easily produce 101 requests in a single test, so instead we
        // reach into createRateLimiter to verify the response shape.
        const rl = createRateLimiter({ perMin: 1, burst: 1 });
        const r1 = rl.middleware(
            fakeReq({ remoteAddress: "10.2.0.2", url: "/api/state" }),
            fakeRes(),
        );
        assert.equal(r1.blocked, false);
        const r2 = rl.middleware(
            fakeReq({ remoteAddress: "10.2.0.2", url: "/api/state" }),
            fakeRes(),
        );
        assert.equal(r2.blocked, true);
        assert.equal(r2.status, 429);
        assert.match(r2.headers["Retry-After"], /^\d+$/);
        assert.ok(Number(r2.headers["Retry-After"]) >= 1);
        assert.match(r2.headers["Content-Type"], /application\/json/);
        assert.equal(r2.body.ok, false);
        assert.equal(r2.body.error, "rate_limited");
        assert.ok(typeof r2.body.retryAfter === "number");
    });
});

describe("rate-limit — window reset (synthetic)", () => {
    test("after windowMs elapses, bucket starts fresh", async () => {
        const rl = createRateLimiter({ perMin: 2, burst: 2, windowMs: 50 });
        const req = fakeReq({ remoteAddress: "10.3.0.1", url: "/api/state" });
        assert.equal(rl.check(req).allowed, true);
        assert.equal(rl.check(req).allowed, true);
        assert.equal(rl.check(req).allowed, false); // 3rd blocked
        // Wait > windowMs
        await new Promise((r) => setTimeout(r, 80));
        const after = rl.check(fakeReq({ remoteAddress: "10.3.0.1", url: "/api/state" }));
        assert.equal(after.allowed, true);
        assert.equal(after.count, 1); // fresh bucket
    });
});

describe("rate-limit — singleton snapshot", () => {
    before(() => _resetDefaultForTests());
    after(() => _resetDefaultForTests());

    test("snapshot reflects env-derived defaults (60 / 100 / 60000)", () => {
        const s = _snapshotDefault();
        assert.equal(s.perMin, 60);
        assert.equal(s.burst, 100);
        assert.equal(s.windowMs, 60000);
    });

    test("env override: MCODE_WEBUI_RATE_LIMIT=10 lowers perMin (lazy read)", () => {
        const saved = process.env.MCODE_WEBUI_RATE_LIMIT;
        process.env.MCODE_WEBUI_RATE_LIMIT = "10";
        try {
            // Re-import so the IIFE in config.js re-runs — but the
            // singleton in rate-limit.js captures values at module load.
            // We instead assert that *a fresh* limiter picks up the env.
            const fresh = createRateLimiter();
            assert.equal(fresh.snapshot().perMin, 10);
        } finally {
            if (saved === undefined) delete process.env.MCODE_WEBUI_RATE_LIMIT;
            else process.env.MCODE_WEBUI_RATE_LIMIT = saved;
        }
    });
});