// webui/test/lib-lan-origins.test.js
// v2 security fix (PR #55 review point 1) — pure tests for the
// browser-Origin trust surface in server/lib/lan.js:
//
//   normalizeOriginHeader  — presence-preserving normalization
//   isLoopbackHost        — bind-host classification for disclosure
//   buildTrustedOrigins   — the exact set router.js reflects / allows
//
// These pin the trust-set MEMBERSHIP. The behavioral gates (no CORS
// headers for untrusted origins, 403 for untrusted mutating requests
// even from loopback) are pinned in checks/router-origin-gate.check.mjs
// and test/integration/router-boot.test.js.
//
// No mocks, no fs, no env — lan.js's origin helpers are pure.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const lan = await import(absPath("lib/lan.js"));

describe("normalizeOriginHeader", () => {
  test("trims + lowercases a serialized origin", () => {
    assert.equal(lan.normalizeOriginHeader("  HTTP://Example.COM:8080  "), "http://example.com:8080");
  });

  test("non-string input normalizes to empty (absent)", () => {
    assert.equal(lan.normalizeOriginHeader(undefined), "");
    assert.equal(lan.normalizeOriginHeader(null), "");
    assert.equal(lan.normalizeOriginHeader(123), "");
  });

  test("'null' (sandboxed iframe) stays PRESENT-but-untrusted, not absent", () => {
    // If Origin: null collapsed to "", the mutating-request gate would
    // treat it as a curl-shaped Origin-less client and wave it through.
    const v = lan.normalizeOriginHeader("null");
    assert.equal(v, "null");
    assert.notEqual(v, "");
  });
});

describe("isLoopbackHost", () => {
  test("loopback forms are loopback", () => {
    assert.equal(lan.isLoopbackHost("127.0.0.1"), true);
    assert.equal(lan.isLoopbackHost("localhost"), true);
    assert.equal(lan.isLoopbackHost("::1"), true);
  });

  test("exposed bind hosts are not loopback", () => {
    assert.equal(lan.isLoopbackHost("0.0.0.0"), false);
    assert.equal(lan.isLoopbackHost("192.168.1.5"), false);
    assert.equal(lan.isLoopbackHost("example.com"), false);
  });
});

describe("buildTrustedOrigins — membership", () => {
  test("own serving origins are always trusted", () => {
    const set = lan.buildTrustedOrigins({ port: 8080, lanBroadcast: false });
    assert.equal(set.has("http://127.0.0.1:8080"), true);
    assert.equal(set.has("http://localhost:8080"), true);
    assert.equal(set.has("http://[::1]:8080"), true);
  });

  test("LAN address origin is trusted only while LAN sharing is on", () => {
    const off = lan.buildTrustedOrigins({ port: 8080, lanBroadcast: false, lanIp: "192.168.1.5" });
    assert.equal(off.has("http://192.168.1.5:8080"), false);
    const on = lan.buildTrustedOrigins({ port: 8080, lanBroadcast: true, lanIp: "192.168.1.5" });
    assert.equal(on.has("http://192.168.1.5:8080"), true);
  });

  test("IPv6 LAN IPs are bracketed in origin form", () => {
    const set = lan.buildTrustedOrigins({ port: 9000, lanBroadcast: true, lanIp: "fd00::abcd" });
    assert.equal(set.has("http://[fd00::abcd]:9000"), true);
  });

  test("explicit allowlist entries are merged in (normalized)", () => {
    const set = lan.buildTrustedOrigins({
      port: 8080,
      lanBroadcast: false,
      extra: ["HTTPS://Toolbox.local:5173"],
    });
    assert.equal(set.has("https://toolbox.local:5173"), true);
  });

  test("lookalikes and scheme mismatches are NOT trusted (exact set membership)", () => {
    const set = lan.buildTrustedOrigins({
      port: 8080,
      lanBroadcast: true,
      lanIp: "192.168.1.5",
      extra: ["http://toolbox.local:5173"],
    });
    // suffix/prefix tricks
    assert.equal(set.has("http://127.0.0.1:8080.evil.com"), false);
    assert.equal(set.has("http://evil.com/http://127.0.0.1:8080"), false);
    // scheme mismatch (https page reading http surface)
    assert.equal(set.has("https://127.0.0.1:8080"), false);
    // port mismatch
    assert.equal(set.has("http://127.0.0.1:8081"), false);
    // different host, same port
    assert.equal(set.has("http://192.168.1.6:8080"), false);
    // sandboxed iframe sentinel
    assert.equal(set.has("null"), false);
  });

  test("default-port elision: port 80 http origins are trusted with and without :80", () => {
    const set = lan.buildTrustedOrigins({ port: 80, lanBroadcast: false });
    assert.equal(set.has("http://127.0.0.1:80"), true);
    assert.equal(set.has("http://127.0.0.1"), true);
    assert.equal(set.has("http://localhost"), true);
  });

  test("garbage extra entries are skipped, not thrown on", () => {
    const set = lan.buildTrustedOrigins({
      port: 8080,
      lanBroadcast: false,
      extra: ["http://ok.example:1", "", undefined, 42, null],
    });
    assert.equal(set.has("http://ok.example:1"), true);
    assert.equal(set.size, 4); // 3 own origins + 1 valid extra
  });
});
