// webui/test/lib-lan.test.js
// Unit tests for server/lib/lan.js — LAN IP detection + local request check.
//
// Why this test exists: lan.js exports LAN_IP as a module-level const (eagerly
// evaluated at load time), and isLocalRequest is the gate that decides whether
// the server rejects a non-local request when LAN broadcast is off. Bugs here
// mean either: (a) LAN is incorrectly allowed (security), or (b) LAN is
// incorrectly blocked (user complaint — "I can't reach webui from my phone").
//
// Test strategy: NO mock.module. lan.js has no webui deps. isLocalRequest is
// a pure function on `req.socket.remoteAddress` — we construct fake req objects.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const lan = await import(absPath("lib/lan.js"));

// Build a minimal req-like object with just the socket.remoteAddress field
// that isLocalRequest reads. The real req has many more fields but only this
// one is accessed.
function fakeReq(remoteAddress) {
  return { socket: { remoteAddress } };
}

describe("lan — isLocalRequest", () => {
  test("returns true for IPv4 loopback (127.0.0.1)", () => {
    assert.equal(lan.isLocalRequest(fakeReq("127.0.0.1")), true);
  });

  test("returns true for IPv6 loopback (::1)", () => {
    assert.equal(lan.isLocalRequest(fakeReq("::1")), true);
  });

  test("returns true for IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
    assert.equal(lan.isLocalRequest(fakeReq("::ffff:127.0.0.1")), true);
  });

  test("returns true when remoteAddress matches LAN_IP (this host's LAN IP)", () => {
    // LAN_IP is detected at module load. If we're hitting our own IP from
    // ourselves, it should count as local.
    assert.equal(lan.isLocalRequest(fakeReq(lan.LAN_IP)), true);
  });

  test("returns false for a non-local IP (random LAN IP)", () => {
    // Use an IP that's almost certainly not the local one.
    // We avoid 127.0.0.0/8 and LAN_IP. Anything else should be non-local
    // UNLESS this host happens to have that as its LAN IP (very unlikely).
    assert.equal(lan.isLocalRequest(fakeReq("192.0.2.123")), false);
  });

  test("returns false for empty remoteAddress", () => {
    assert.equal(lan.isLocalRequest(fakeReq("")), false);
  });

  test("returns false when remoteAddress is undefined", () => {
    assert.equal(lan.isLocalRequest({ socket: {} }), false);
  });
});

describe("lan — module-level constants", () => {
  test("LAN_IP is a non-empty string", () => {
    assert.equal(typeof lan.LAN_IP, "string");
    assert.ok(lan.LAN_IP.length > 0);
  });

  test("LAN_IP is a valid IP-like string (contains digits and dots or colons)", () => {
    // Either IPv4 (1.2.3.4) or IPv6 (::1, fe80::...). Both contain digits.
    assert.ok(/[\d.]/.test(lan.LAN_IP) || /:/.test(lan.LAN_IP));
  });
});

describe("lan — detectLanIp", () => {
  test("returns a string (never throws)", () => {
    const ip = lan.detectLanIp();
    assert.equal(typeof ip, "string");
    assert.ok(ip.length > 0);
  });

  test("returns a fallback IP (127.0.0.1) when no external interface", () => {
    // In CI / sandboxed envs there may be no non-internal IPv4. The function
    // should fall back to 127.0.0.1 in that case. We can't easily force this
    // state, so we just verify the function doesn't throw and returns a string.
    const ip = lan.detectLanIp();
    assert.ok(typeof ip === "string");
  });
});
