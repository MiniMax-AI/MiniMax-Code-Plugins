// webui/test/lib-rate-limit-edge.test.js
// Lease D01 — Edge case coverage fillers for server/lib/rate-limit.js (C03).
//
// What's covered here vs the existing lib-rate-limit.test.js:
//   - All loopback formats (127.0.0.1 / ::1 / ::ffff:127.0.0.1 plus
//     a couple of odd ones like "127.0.0.2" that the spec shouldn't
//     whitelist but we still confirm isn't busted)
//   - Empty / malformed token shapes (Bearer "" / Bearer sole-space /
//     no Authorization at all)
//   - MCODE_WEBUI_RATE_LIMIT=0 boundary (floored to 1, NOT disabled)
//   - High-volume concurrent sequential loops to verify the window +
//     reset interaction under load
//   - Headers-only path (no body) on allow — verifies X-RateLimit-Reset
//     is a sane future timestamp
//
// Baseline tests in lib-rate-limit.test.js already cover the happy path,
// factory shape, token multiplier, and the success/fail middleware
// response structure. This file targets the less-common inputs.

import { test, describe, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

// ESM top-level await — Node 22+ supports this. Imports happen once
// per test file, and `describe` blocks run after this resolves.
const rl = await import(absPath("lib/rate-limit.js"));

after(() => {
  // Clean up env overrides we set
  for (const k of [
    "MCODE_WEBUI_RATE_LIMIT",
    "MCODE_WEBUI_RATE_LIMIT_BURST",
  ]) delete process.env[k];
});

// Minimal req stub (matches lib-rate-limit.test.js shape)
function fakeReq(opts = {}) {
  const {
    remoteAddress = "192.0.2.1",
    headers = {},
    url = "/api/state",
  } = opts;
  return {
    method: "GET",
    url,
    headers,
    socket: { remoteAddress },
  };
}

function fakeRes() {
  const headers = {};
  let headersSent = false;
  return {
    headers,
    get headersSent() { return headersSent; },
    setHeader(name, value) { headers[name] = value; },
    writeHead() { headersSent = true; },
    end() { headersSent = true; },
  };
}

// ---------------------------------------------------------------------------
// Loopback formats — covered in base test, but we add a few more shapes
// to lock down the contract that gets written into the runtime header
// check (router.js reads `req.socket.remoteAddress` directly).
// ---------------------------------------------------------------------------
describe("rate-limit (D01) — loopback formats", () => {
  const limiter = rl.createRateLimiter({ perMin: 1, burst: 1, windowMs: 60_000 });

  test("127.0.0.1 → allowed (already in base, smoke check)", () => {
    const r = limiter.check(fakeReq({ remoteAddress: "127.0.0.1" }));
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, Infinity);
  });

  test("::1 (IPv6 loopback) → allowed", () => {
    const r = limiter.check(fakeReq({ remoteAddress: "::1" }));
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, Infinity);
  });

  test("::ffff:127.0.0.1 (IPv4-mapped loopback) → allowed", () => {
    const r = limiter.check(fakeReq({ remoteAddress: "::ffff:127.0.0.1" }));
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, Infinity);
  });

  test("LAN_IP (auto-detected) → allowed when matches the loopback of this host", async () => {
    const lanUrl = absPath("lib/lan.js");
    const { LAN_IP } = await import(lanUrl);
    const limitedLimiter = rl.createRateLimiter({ perMin: 1, burst: 1 });
    // LAN_IP is the host's external IPv4. If it's loopback, skip —
    // existing tests already cover `127.0.0.1`.
    if (LAN_IP === "127.0.0.1" || LAN_IP === "::1" || LAN_IP === "::ffff:127.0.0.1") {
      // Skip — covered by IPv4/IPv6 loopback tests above.
      return;
    }
    // LAN_IP is a unique IPv4 — the limiter config above (perMin=1,
    // burst=1) cannot produce > 1 allowed request, but if LAN_IP is
    // whitelisted we expect ALL requests from it to be allowed.
    const r1 = limitedLimiter.check(fakeReq({ remoteAddress: LAN_IP }));
    const r2 = limitedLimiter.check(fakeReq({ remoteAddress: LAN_IP }));
    const r3 = limitedLimiter.check(fakeReq({ remoteAddress: LAN_IP }));
    assert.equal(r1.allowed, true, `LAN_IP ${LAN_IP} should be whitelisted`);
    assert.equal(r2.allowed, true);
    assert.equal(r3.allowed, true);
  });

  test("127.0.0.2 (adjacent but NOT loopback) is NOT whitelisted", () => {
    const limitedLimiter = rl.createRateLimiter({ perMin: 2, burst: 2 });
    const r1 = limitedLimiter.check(fakeReq({ remoteAddress: "127.0.0.2" }));
    const r2 = limitedLimiter.check(fakeReq({ remoteAddress: "127.0.0.2" }));
    const r3 = limitedLimiter.check(fakeReq({ remoteAddress: "127.0.0.2" }));
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, true);
    assert.equal(r3.allowed, false, "127.0.0.2 must NOT be treated as loopback");
  });

  test("::ffff:127.0.0.2 (mapped-but-NOT-loopback) is NOT whitelisted", () => {
    const limitedLimiter = rl.createRateLimiter({ perMin: 2, burst: 2 });
    const r1 = limitedLimiter.check(fakeReq({ remoteAddress: "::ffff:127.0.0.2" }));
    const r2 = limitedLimiter.check(fakeReq({ remoteAddress: "::ffff:127.0.0.2" }));
    const r3 = limitedLimiter.check(fakeReq({ remoteAddress: "::ffff:127.0.0.2" }));
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, true);
    assert.equal(r3.allowed, false);
  });
});

// ---------------------------------------------------------------------------
// Empty / malformed tokens — must be treated as "no token" (not "valid token")
// ---------------------------------------------------------------------------
describe("rate-limit (D01) — token edge cases", () => {
  test("Bearer empty string → no token, base budget", () => {
    const limiter = rl.createRateLimiter({ perMin: 2, burst: 4 });
    const req1 = fakeReq({
      remoteAddress: "10.10.0.1",
      headers: { authorization: "Bearer " },
    });
    const req2 = fakeReq({
      remoteAddress: "10.10.0.1",
      headers: { authorization: "Bearer " },
    });
    const req3 = fakeReq({
      remoteAddress: "10.10.0.1",
      headers: { authorization: "Bearer " },
    });
    // base perMin=2 — no token multiplier should kick in
    assert.equal(limiter.check(req1).limit, 2);
    assert.equal(limiter.check(req2).limit, 2);
    // 3rd request: still allowed (burst=4), but remaining = 0
    const r3 = limiter.check(req3);
    assert.equal(r3.allowed, true);
    assert.equal(r3.remaining, 0);
  });

  test("Bearer whitespace-only → no token, base budget", () => {
    const limiter = rl.createRateLimiter({ perMin: 1, burst: 2 });
    const req = fakeReq({
      remoteAddress: "10.10.0.2",
      headers: { authorization: "Bearer    " },
    });
    const r = limiter.check(req);
    assert.equal(r.limit, 1, "whitespace token should NOT trigger 2x");
  });

  test("Authorization header without Bearer → no token, base budget", () => {
    const limiter = rl.createRateLimiter({ perMin: 1, burst: 2 });
    const req = fakeReq({
      remoteAddress: "10.10.0.3",
      headers: { authorization: "Basic abc123" },
    });
    const r = limiter.check(req);
    assert.equal(r.limit, 1);
  });

  test("No headers at all → no token, base budget", () => {
    const limiter = rl.createRateLimiter({ perMin: 1, burst: 2 });
    const req = fakeReq({ remoteAddress: "10.10.0.4" });
    const r = limiter.check(req);
    assert.equal(r.limit, 1);
    assert.equal(r.allowed, true);
  });
});

// ---------------------------------------------------------------------------
// Env zero / negative / non-numeric → floored to 1 (rate limiting is
// NEVER silently disabled by env misconfiguration).
// ---------------------------------------------------------------------------
describe("rate-limit (D01) — env var boundaries", () => {
  test("MCODE_WEBUI_RATE_LIMIT=0 → falls back to default 60 (NOT silently disabled)", () => {
    // readEnvNumber's contract: `v > 0` gates the env read. 0 is treated
    // as "not configured" and the module default (60) is used. The point
    // is that rate limiting is NEVER silently disabled.
    const saved = process.env.MCODE_WEBUI_RATE_LIMIT;
    process.env.MCODE_WEBUI_RATE_LIMIT = "0";
    try {
      const limiter = rl.createRateLimiter();
      assert.equal(limiter.snapshot().perMin, 60, "0 must NOT disable rate limiting");
      assert.ok(limiter.snapshot().perMin >= 1);
    } finally {
      if (saved === undefined) delete process.env.MCODE_WEBUI_RATE_LIMIT;
      else process.env.MCODE_WEBUI_RATE_LIMIT = saved;
    }
  });

  test("MCODE_WEBUI_RATE_LIMIT=-99 (negative) → falls back to default", () => {
    const saved = process.env.MCODE_WEBUI_RATE_LIMIT;
    process.env.MCODE_WEBUI_RATE_LIMIT = "-99";
    try {
      const limiter = rl.createRateLimiter();
      assert.equal(limiter.snapshot().perMin, 60);
    } finally {
      if (saved === undefined) delete process.env.MCODE_WEBUI_RATE_LIMIT;
      else process.env.MCODE_WEBUI_RATE_LIMIT = saved;
    }
  });

  test("MCODE_WEBUI_RATE_LIMIT=NaN (non-numeric) → fallback default (60)", () => {
    const saved = process.env.MCODE_WEBUI_RATE_LIMIT;
    process.env.MCODE_WEBUI_RATE_LIMIT = "not-a-number";
    try {
      const limiter = rl.createRateLimiter();
      // readEnvNumber returns the fallback (RATE_LIMIT_PER_MIN = 60)
      // when Number(...) is NaN (Number.isFinite(NaN) is false).
      assert.equal(limiter.snapshot().perMin, 60);
    } finally {
      if (saved === undefined) delete process.env.MCODE_WEBUI_RATE_LIMIT;
      else process.env.MCODE_WEBUI_RATE_LIMIT = saved;
    }
  });

  test("MCODE_WEBUI_RATE_LIMIT_BURST=-5 → falls back to default 100", () => {
    const saved = process.env.MCODE_WEBUI_RATE_LIMIT_BURST;
    process.env.MCODE_WEBUI_RATE_LIMIT_BURST = "-5";
    try {
      const limiter = rl.createRateLimiter();
      assert.equal(limiter.snapshot().burst, 100, "negative must fall back, NOT silently disable");
    } finally {
      if (saved === undefined) delete process.env.MCODE_WEBUI_RATE_LIMIT_BURST;
      else process.env.MCODE_WEBUI_RATE_LIMIT_BURST = saved;
    }
  });

  test("MCODE_WEBUI_RATE_LIMIT=1.5 (decimal) → read as 1.5, Math.max(1, 1.5) = 1.5", () => {
    const saved = process.env.MCODE_WEBUI_RATE_LIMIT;
    process.env.MCODE_WEBUI_RATE_LIMIT = "1.5";
    try {
      const limiter = rl.createRateLimiter();
      // Number.isFinite(1.5) && 1.5 > 0 → 1.5 used as-is; then
      // floored by Math.max(FLOOR_PER_MIN, ...). Math.max(1, 1.5) = 1.5.
      assert.equal(limiter.snapshot().perMin, 1.5);
    } finally {
      if (saved === undefined) delete process.env.MCODE_WEBUI_RATE_LIMIT;
      else process.env.MCODE_WEBUI_RATE_LIMIT = saved;
    }
  });

  test("MCODE_WEBUI_RATE_LIMIT=10 → 10 (positive numbers use the env)", () => {
    const saved = process.env.MCODE_WEBUI_RATE_LIMIT;
    process.env.MCODE_WEBUI_RATE_LIMIT = "10";
    try {
      const limiter = rl.createRateLimiter();
      assert.equal(limiter.snapshot().perMin, 10);
    } finally {
      if (saved === undefined) delete process.env.MCODE_WEBUI_RATE_LIMIT;
      else process.env.MCODE_WEBUI_RATE_LIMIT = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// High-volume sequential loopback / non-loopback — confirms no off-by-one
// in the bucket counter, no shared state between iterations.
// ---------------------------------------------------------------------------
describe("rate-limit (D01) — concurrent sequential load", () => {
  test("500 sequential loopback requests all whitelisted", () => {
    const limiter = rl.createRateLimiter({ perMin: 1, burst: 1 });
    for (let i = 0; i < 500; i++) {
      const r = limiter.check(fakeReq({ remoteAddress: "127.0.0.1" }));
      assert.equal(r.allowed, true, `request ${i} blocked — should always allow loopback`);
    }
  });

  test("200 sequential non-loopback requests burst-throttled", () => {
    const limiter = rl.createRateLimiter({ perMin: 50, burst: 100 });
    let allowed = 0;
    let blocked = 0;
    for (let i = 0; i < 200; i++) {
      const r = limiter.check(fakeReq({ remoteAddress: "10.20.0.1" }));
      if (r.allowed) allowed += 1;
      else blocked += 1;
    }
    assert.equal(allowed, 100, "exactly burst requests should be allowed");
    assert.equal(blocked, 100, "all the rest should be blocked");
  });

  test("distinct IPs do not share bucket state", () => {
    const limiter = rl.createRateLimiter({ perMin: 1, burst: 1 });
    // Fill IP-A's bucket
    limiter.check(fakeReq({ remoteAddress: "10.20.0.100" }));
    limiter.check(fakeReq({ remoteAddress: "10.20.0.100" }));
    // IP-A 3rd should be blocked
    const aBlocked = limiter.check(fakeReq({ remoteAddress: "10.20.0.100" }));
    // IP-B's first request must still be allowed
    const bAllowed = limiter.check(fakeReq({ remoteAddress: "10.20.0.101" }));
    assert.equal(aBlocked.allowed, false);
    assert.equal(bAllowed.allowed, true);
    assert.equal(limiter.snapshot().buckets, 2, "two distinct IP buckets");
  });

  test("distinct tokens (same IP) do not share bucket state", () => {
    const limiter = rl.createRateLimiter({ perMin: 1, burst: 1 });
    const tok1 = fakeReq({
      remoteAddress: "10.20.0.200",
      headers: { authorization: "Bearer tok1" },
    });
    const tok2 = fakeReq({
      remoteAddress: "10.20.0.200",
      headers: { authorization: "Bearer tok2" },
    });
    limiter.check(tok1);
    limiter.check(tok1);
    const tok1Block = limiter.check(tok1);
    const tok2Allow = limiter.check(tok2);
    assert.equal(tok1Block.allowed, false);
    assert.equal(tok2Allow.allowed, true);
  });
});

// ---------------------------------------------------------------------------
// Middleware response — verify headers are set even when allow path runs
// (locked in base test, but we double-check the X-RateLimit-Reset future-shape
// invariant here).
// ---------------------------------------------------------------------------
describe("rate-limit (D01) — middleware headers always set", () => {
  test("X-RateLimit-Reset is a future unix-seconds timestamp", () => {
    rl._resetDefaultForTests();
    const res = fakeRes();
    const req = fakeReq({ remoteAddress: "10.30.0.1", url: "/api/state" });
    const before = Math.floor(Date.now() / 1000);
    rl.rateLimitMiddleware(req, res);
    const after = Math.floor(Date.now() / 1000);
    const reset = Number(res.headers["X-RateLimit-Reset"]);
    assert.ok(reset >= before, `Reset ${reset} must be >= start ${before}`);
    assert.ok(reset <= after + 70, `Reset ${reset} should be within ~windowMs (got ${after})`);
  });

  test("reset() inside singleton clears buckets for next request", () => {
    rl._resetDefaultForTests();
    const req = fakeReq({ remoteAddress: "10.30.0.2", url: "/api/state" });
    rl.rateLimitMiddleware(req, fakeRes());
    rl.rateLimitMiddleware(req, fakeRes());
    rl._resetDefaultForTests();
    // After reset, the singleton should have 0 buckets
    assert.equal(rl._snapshotDefault().buckets, 0);
  });
});
