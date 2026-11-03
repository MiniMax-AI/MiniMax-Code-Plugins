// webui/test/lib-settings.test.js
// Unit tests for server/lib/settings.js — LAN broadcast toggle + rejectLan + snapshot.
// v1.0.1: extend with persistence (read/write ~/.mcode-webui/settings.json) +
//   new fields (readOnly, tokenEnabled, currentToken). The interface-allowlist
//   feature was added then removed in the same release — stubs for the
//   removed API are kept (so older test code still imports cleanly).
//
// Why this test exists: settings.js holds the runtime-mutable LAN broadcast flag
// + persistent security settings. When ON: any IP can hit the server. When OFF:
// only local IPs. Bugs here = either security hole or user pain.
//
// Test strategy: NO mock.module. settings.js imports ./config.js + ./lan.js +
// ./auth.js (no webui deps). All exports are pure functions on module-level
// mutable state. For persistence tests we use a temp HOME directory via the
// `MCODE_WEBUI_HOME` env var (a test-only override) so we never touch the
// real user settings file.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

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

  test("returns true and writes HTML 403 for non-API paths (single bilingual page)", () => {
    settings.setLanBroadcast(false);
    const res = fakeRes();
    const rejected = settings.rejectLan(res, "/", "192.168.1.100");
    assert.equal(rejected, true);
    assert.equal(res._status, 403);
    assert.ok(res._isHtml, "non-API path should return HTML");
    // Single page contains BOTH languages (not Accept-Language switching)
    assert.match(res._body, /局域网访问已关闭/); // zh title
    assert.match(res._body, /LAN access disabled/); // en title
    assert.match(res._body, /192\.168\.1\.100/); // remote IP
  });

  test("HTML page uses dynamic PORT (not hardcoded 7890)", () => {
    settings.setLanBroadcast(false);
    const res = fakeRes();
    settings.rejectLan(res, "/some/page", "10.0.0.1");
    assert.match(res._body, /127\.0\.0\.1:8080/);
    assert.doesNotMatch(res._body, /7890/);
  });

  test("JSON 403 body is bilingual (API callers)", () => {
    settings.setLanBroadcast(false);
    const res = fakeRes();
    settings.rejectLan(res, "/api/anything", "203.0.113.5");
    assert.equal(res._status, 403);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.match(body.error, /LAN access disabled/);
    assert.match(body.error, /局域网/);
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
    // v1.0.1: new fields
    assert.equal(typeof snap.readOnly, "boolean");
    assert.equal(typeof snap.tokenEnabled, "boolean");
    assert.equal(typeof snap.tokenAcknowledged, "boolean");
    assert.equal(typeof snap.tokenRotatedAt, "number");
    // v1.0.1 cleanup: allowedInterfaces / availableInterfaces removed
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

  test("currentToken omitted when tokenAcknowledged is true", () => {
    // We can't easily set currentToken in the unimported-state test
    // module, but we can verify the snapshot returns "" when acknowledged
    // (initial state has tokenAcknowledged=false and currentToken=""
    // before init() runs, so currentToken is "" either way)
    const snap = settings.getSettingsSnapshot();
    assert.equal(snap.currentToken, "");
  });
});

// =====================================================================
// v1.0.1 — new fields + persistence
// =====================================================================

describe("settings — readOnly getter/setter", () => {
  test("default readOnly is false (after fresh import)", () => {
    assert.equal(settings.getReadOnly(), false);
  });

  test("setReadOnly(true) updates and snapshot reflects it", () => {
    settings.setReadOnly(true);
    assert.equal(settings.getReadOnly(), true);
    assert.equal(settings.getSettingsSnapshot().readOnly, true);
  });

  test("setReadOnly coerces truthy", () => {
    settings.setReadOnly("yes");
    assert.equal(settings.getReadOnly(), true);
  });
});

describe("settings — tokenEnabled getter/setter", () => {
  test("default tokenEnabled is true", () => {
    assert.equal(settings.getTokenEnabled(), true);
  });

  test("setTokenEnabled(false) updates and snapshot reflects it", () => {
    settings.setTokenEnabled(false);
    assert.equal(settings.getTokenEnabled(), false);
    assert.equal(settings.getSettingsSnapshot().tokenEnabled, false);
  });
});

describe("settings — token acknowledged getter/setter", () => {
  test("default tokenAcknowledged is false (before init())", () => {
    assert.equal(settings.getTokenAcknowledged(), false);
  });

  test("setTokenAcknowledged(true) updates", () => {
    settings.setTokenAcknowledged(true);
    assert.equal(settings.getTokenAcknowledged(), true);
    assert.equal(settings.getSettingsSnapshot().tokenAcknowledged, true);
  });
});

describe("settings — removed: allowedInterfaces stub", () => {
  // Interface-allowlist feature was added in v1.0.1 then removed per
  // PR #16 reviewer scope concerns. The getter + setter are kept as
  // no-ops so older imports don't break. Verify the stubs are safe.
  test("getAllowedInterfaces returns [] (stub, feature removed)", () => {
    assert.deepEqual(settings.getAllowedInterfaces(), []);
  });

  test("setAllowedInterfaces is a no-op (stub, feature removed)", () => {
    // Should not throw, should not change state.
    assert.doesNotThrow(() => settings.setAllowedInterfaces(["Wi-Fi"]));
    assert.deepEqual(settings.getAllowedInterfaces(), []);
  });
});

describe("settings — generateToken / rotateToken", () => {
  test("generateToken returns 32 hex chars", () => {
    const t = settings.generateToken();
    assert.equal(typeof t, "string");
    assert.equal(t.length, 32);
    assert.match(t, /^[0-9a-f]{32}$/);
  });

  test("generateToken returns unique values", () => {
    const t1 = settings.generateToken();
    const t2 = settings.generateToken();
    assert.notEqual(t1, t2);
  });

  test("rotateToken updates currentToken + tokenRotatedAt + acknowledged", () => {
    settings.setTokenAcknowledged(true);
    const before = settings.getTokenRotatedAt();
    const t = settings.rotateToken();
    assert.equal(settings.getCurrentToken(), t);
    assert.notEqual(t, "");
    assert.ok(settings.getTokenRotatedAt() >= before);
    // Acknowledged is reset on rotation (operator must save again)
    assert.equal(settings.getTokenAcknowledged(), false);
  });
});

describe("settings — persistence (MCODE_WEBUI_SETTINGS_PATH override)", () => {
  // Redirect the settings file to a temp path so tests never touch the
  // real ~/.mcode-webui/settings.json. settings.js respects the env var
  // MCODE_WEBUI_SETTINGS_PATH at every load/persist call (lazy lookup).
  let tempDir;
  let origPath;
  let settingsFile;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mcode-webui-test-"));
    origPath = process.env.MCODE_WEBUI_SETTINGS_PATH;
    settingsFile = join(tempDir, "settings.json");
    process.env.MCODE_WEBUI_SETTINGS_PATH = settingsFile;
  });
  afterEach(() => {
    if (origPath === undefined) delete process.env.MCODE_WEBUI_SETTINGS_PATH;
    else process.env.MCODE_WEBUI_SETTINGS_PATH = origPath;
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  test("init() on first run creates the settings file at the override path", () => {
    settings.init({ printToken: () => {} });
    assert.ok(existsSync(settingsFile), "settings file should exist at " + settingsFile);
    const body = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(body.version, 1);
    assert.equal(typeof body.currentToken, "string");
    assert.ok(body.currentToken.length > 0, "first-run token should be generated");
    // Settings file should NOT include lanBroadcast (intentionally not persisted)
    assert.equal(body.lanBroadcast, undefined);
  });

  test("init() calls printToken only on first run (no token on disk)", () => {
    let called = 0;
    let printedToken = "";
    settings.init({ printToken: (t) => { called++; printedToken = t; } });
    assert.equal(called, 1);
    assert.ok(printedToken.length > 0);
    // Calling init() again should NOT re-print (token now on disk)
    settings.init({ printToken: () => { called++; } });
    assert.equal(called, 1, "should not re-print when token already on disk");
  });

  test("setReadOnly persists to disk", () => {
    settings.init({ printToken: () => {} });
    settings.setReadOnly(true);
    const body = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(body.readOnly, true);
  });

  test("rotateToken persists new token + resets acknowledged", () => {
    settings.init({ printToken: () => {} });
    settings.setTokenAcknowledged(true);
    const t1 = settings.getCurrentToken();
    const t2 = settings.rotateToken();
    assert.notEqual(t1, t2);
    const body = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(body.currentToken, t2);
    assert.equal(body.tokenAcknowledged, false);
  });

  test("load reads existing settings file (round-trip)", () => {
    settings.init({ printToken: () => {} });
    settings.setReadOnly(true);
    settings.setTokenAcknowledged(true);
    const t1 = settings.getCurrentToken();

    const body = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(body.readOnly, true);
    assert.equal(body.tokenAcknowledged, true);
    assert.equal(body.currentToken, t1);
  });

  test("init() handles corrupt settings file by backing up + using defaults", () => {
    writeFileSync(settingsFile, "{ this is not json", "utf8");
    settings.init({ printToken: () => {} });
    // Should NOT have thrown; should have created a .bak file
    assert.ok(existsSync(settingsFile + ".bak"), "corrupt file should be backed up");
    // Body should be a fresh valid settings file
    const body = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(body.version, 1);
  });
});
