// webui/test/lib-settings.test.js
// Unit tests for server/lib/settings.js — LAN broadcast toggle + rejectLan + snapshot.
//
// Why this test exists: settings.js holds the runtime-mutable LAN broadcast flag.
// When ON: any IP can hit the server. When OFF: only local IPs (rejected via rejectLan).
// /api/settings is the one endpoint that's allowed even when LAN is off, so users
// can flip the switch back remotely. Bugs here = either security hole (LAN allowed
// when off) or user pain (can't reach webui from phone even when on).
//
// Test strategy: NO mock.module. settings.js imports ./config.js + ./lan.js (no
// webui deps). All exports are pure functions on a module-level mutable state.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const settings = await import(absPath("lib/settings.js"));

// Build a minimal fake res that captures writeHead/end
function fakeRes() {
  const res = {
    _status: null,
    _headers: null,
    _body: null,
    _isHtml: null,
    writeHead(status, headers) {
      this._status = status;
      this._headers = headers;
      this._isHtml = headers && headers["Content-Type"] && headers["Content-Type"].includes("text/html");
    },
    end(body) {
      this._body = body;
    },
  };
  return res;
}

describe("settings — getLanBroadcast / setLanBroadcast", () => {
  beforeEach(() => {
    // Reset to default true at the start of each test
    settings.setLanBroadcast(true);
  });

  test("default value is true (LAN broadcast enabled by default)", () => {
    assert.equal(settings.getLanBroadcast(), true);
  });

  test("setLanBroadcast(false) updates getLanBroadcast() to false", () => {
    settings.setLanBroadcast(false);
    assert.equal(settings.getLanBroadcast(), false);
  });

  test("setLanBroadcast(true) after false returns true", () => {
    settings.setLanBroadcast(false);
    settings.setLanBroadcast(true);
    assert.equal(settings.getLanBroadcast(), true);
  });

  test("setLanBroadcast coerces truthy non-boolean to true", () => {
    settings.setLanBroadcast("yes");
    assert.equal(settings.getLanBroadcast(), true);
  });

  test("setLanBroadcast coerces falsy non-boolean to false", () => {
    settings.setLanBroadcast(0);
    assert.equal(settings.getLanBroadcast(), false);
  });
});

describe("settings — rejectLan", () => {
  test("returns false (not rejected) for /api/settings — the toggle endpoint", () => {
    // This is the escape hatch: even when LAN is off, users can hit /api/settings
    // to flip the switch back on.
    const res = fakeRes();
    const rejected = settings.rejectLan(res, "/api/settings", "192.168.1.100");
    assert.equal(rejected, false);
    // Should NOT have written a response
    assert.equal(res._status, null);
  });

  test("returns true and writes JSON 403 for non-/api/settings API paths", () => {
    settings.setLanBroadcast(false); // assume LAN is off
    const res = fakeRes();
    const rejected = settings.rejectLan(res, "/api/sessions", "192.168.1.100");
    assert.equal(rejected, true);
    assert.equal(res._status, 403);
    assert.ok(!res._isHtml, "API path should return JSON, not HTML");
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.match(body.error, /LAN/);
  });

  test("returns true and writes HTML 403 for non-API paths (browser request)", () => {
    settings.setLanBroadcast(false);
    const res = fakeRes();
    const rejected = settings.rejectLan(res, "/", "192.168.1.100");
    assert.equal(rejected, true);
    assert.equal(res._status, 403);
    assert.ok(res._isHtml, "non-API path should return HTML");
    assert.match(res._body, /局域网访问已关闭/);
    assert.match(res._body, /192\.168\.1\.100/); // remote IP embedded in the page
  });

  test("HTML page mentions /api/settings as the toggle path", () => {
    settings.setLanBroadcast(false);
    const res = fakeRes();
    settings.rejectLan(res, "/some/page", "10.0.0.1");
    assert.match(res._body, /127\.0\.0\.1:7890/);
  });
});

describe("settings — getSettingsSnapshot", () => {
  test("returns an object with all expected fields", () => {
    settings.setLanBroadcast(true);
    const snap = settings.getSettingsSnapshot();
    assert.equal(snap.ok, true);
    assert.equal(snap.lanBroadcast, true);
    assert.equal(typeof snap.port, "number");
    assert.equal(typeof snap.host, "string");
    assert.equal(typeof snap.lanIp, "string");
    assert.equal(typeof snap.lanUrl, "string");
    assert.equal(typeof snap.localUrl, "string");
    assert.equal(typeof snap.mcodeCmd, "string");
    assert.equal(typeof snap.mcodeVersion, "string");
    assert.equal(typeof snap.defaultWorkspace, "string");
    assert.equal(typeof snap.defaultModel, "string");
  });

  test("lanUrl uses PORT and LAN_IP", () => {
    const snap = settings.getSettingsSnapshot();
    assert.equal(snap.lanUrl, `http://${snap.lanIp}:${snap.port}`);
  });

  test("localUrl uses 127.0.0.1 and PORT", () => {
    const snap = settings.getSettingsSnapshot();
    assert.equal(snap.localUrl, `http://127.0.0.1:${snap.port}`);
  });

  test("lanBroadcast reflects current setLanBroadcast value", () => {
    settings.setLanBroadcast(false);
    assert.equal(settings.getSettingsSnapshot().lanBroadcast, false);
    settings.setLanBroadcast(true);
    assert.equal(settings.getSettingsSnapshot().lanBroadcast, true);
  });
});
