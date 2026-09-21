// webui/checks/settings-sec-net.check.mjs
// v2 security fix (PR #55 review points 1+2) — settings-surface pins:
//
//   point 1: GET /api/settings stops returning the long-lived
//     token-bearing `lanUrlWithToken` once the token is acknowledged
//     (first-run bootstrap keeps it, minimally).
//   point 2: `lanBind` persisted opt-in + explicit exposure disclosure
//     in the snapshot (`lanExposed` / `lanExposureNotice` /
//     `bindRestartPending`), and `trustedOrigins` allowlist write path
//     (valid → applied; invalid → 400, state untouched).
//
// Harness follows checks/routes-settings.check.mjs: real modules
// (settings.js + routes/settings.js), env-isolated events + settings
// paths so nothing touches the operator's real ~/.mcode-webui.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

let _tmpA;
let _tmpB;
before(async () => {
  _tmpA = mkdtempSync(join(tmpdir(), "webui-sec-net-settings-"));
  _tmpB = mkdtempSync(join(tmpdir(), "webui-sec-net-events-"));
  process.env.MCODE_WEBUI_SETTINGS_PATH = join(_tmpA, "settings.json");
  process.env.MCODE_WEBUI_EVENTS_PATH = join(_tmpB, "events.ndjson");
  // Determinism: neither env token nor env bind may shadow the
  // settings.json state these tests drive.
  delete process.env.TOKEN;
  delete process.env.HOST;
});
after(async () => {
  for (const d of [_tmpA, _tmpB]) {
    if (d) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  }
});

const settingsLib = await import(absPath("lib/settings.js"));
const settingsRoute = await import(absPath("routes/settings.js"));

function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}
function fakeRes() {
  const res = {
    _status: null,
    _headers: null,
    _body: null,
    writeHead(s, h) {
      this._status = s;
      if (h) this._headers = h;
    },
    end(b) {
      this._body = b;
    },
  };
  return res;
}

// -----------------------------------------------------------------------
// Point 1 — lanUrlWithToken lifecycle
// -----------------------------------------------------------------------

describe("settings snapshot — lanUrlWithToken (PR #55 point 1)", () => {
  beforeEach(() => {
    settingsLib.setTokenAcknowledged(false);
  });

  test("first-run surface: present with ?token= while NOT acknowledged", () => {
    settingsLib.rotateToken(); // sets currentToken + tokenAcknowledged=false
    const snap = settingsLib.getSettingsSnapshot();
    assert.equal(typeof snap.lanUrlWithToken, "string");
    assert.match(snap.lanUrlWithToken, /\?token=/);
    assert.equal(typeof snap.currentToken, "string");
    assert.ok(snap.currentToken.length > 0);
  });

  test("after acknowledgeToken the field is OMITTED entirely (no token-bearing URL)", () => {
    settingsLib.rotateToken();
    settingsLib.setTokenAcknowledged(true);
    const snap = settingsLib.getSettingsSnapshot();
    assert.equal(snap.lanUrlWithToken, undefined, "lanUrlWithToken must not be returned after acknowledgment");
    assert.equal(snap.currentToken, "");
    // The bare display URL stays for the chip.
    assert.equal(typeof snap.lanUrl, "string");
  });

  test("route-level: GET-equivalent snapshot in POST response also omits it after ack", async () => {
    settingsLib.rotateToken();
    settingsLib.setTokenAcknowledged(true);
    const res = fakeRes();
    await settingsRoute.handlePostSettings(fakeReq({}), res, {});
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.lanUrlWithToken, undefined);
  });

  test("rotation re-arms the one-time surface (tokenAcknowledged resets)", () => {
    settingsLib.setTokenAcknowledged(true);
    settingsLib.rotateToken();
    const snap = settingsLib.getSettingsSnapshot();
    assert.match(snap.lanUrlWithToken, /\?token=/);
  });
});

// -----------------------------------------------------------------------
// Point 2 — lanBind opt-in + disclosure
// -----------------------------------------------------------------------

describe("settings snapshot — bind disclosure (PR #55 point 2)", () => {
  beforeEach(() => {
    settingsLib.setLanBind(false);
  });

  test("default (fresh state): loopback, not exposed, no notice", () => {
    const snap = settingsLib.getSettingsSnapshot();
    assert.equal(snap.lanBind, false);
    assert.equal(snap.bindHost, "127.0.0.1");
    assert.equal(snap.lanExposed, false);
    assert.equal(snap.bindRestartPending, false);
    assert.equal(snap.lanExposureNotice, "");
  });

  test("lanBind=true → 0.0.0.0 exposure disclosed in the snapshot", () => {
    settingsLib.setLanBind(true);
    const snap = settingsLib.getSettingsSnapshot();
    assert.equal(snap.lanBind, true);
    assert.equal(snap.bindHost, "0.0.0.0");
    assert.equal(snap.lanExposed, true);
    // The live socket in this process still binds what config resolved at
    // boot (loopback) — the change must be disclosed as restart-pending.
    assert.equal(snap.bindRestartPending, true);
    assert.match(snap.lanExposureNotice, /LAN exposure/i);
    assert.match(snap.lanExposureNotice, /0\.0\.0\.0/);
  });

  test("setLanBind persists the flag (survives restart via settings.json)", () => {
    settingsLib.setLanBind(true);
    const body = JSON.parse(readFileSync(process.env.MCODE_WEBUI_SETTINGS_PATH, "utf8"));
    assert.equal(body.lanBind, true);
  });

  test("route-level: POST {lanBind:true} applies + persists", async () => {
    settingsLib.setLanBind(false);
    const res = fakeRes();
    await settingsRoute.handlePostSettings(fakeReq({ lanBind: true }), res, {});
    const body = JSON.parse(res._body);
    assert.equal(res._status, 200);
    assert.equal(body.changed, true);
    assert.equal(body.lanBind, true);
    assert.equal(body.lanExposed, true);
    assert.equal(settingsLib.getLanBind(), true);
  });
});

// -----------------------------------------------------------------------
// Point 1 (support) — trustedOrigins allowlist write path
// -----------------------------------------------------------------------

describe("trustedOrigins — sanitize + route write path", () => {
  test("sanitizeTrustedOrigins normalizes, dedupes valid entries", () => {
    const r = settingsLib.sanitizeTrustedOrigins([
      "HTTPS://Toolbox.Local:5173",
      "  https://toolbox.LOCAL:5173 ", // duplicate after normalization
      "http://192.168.1.50:3000",
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, [
      "https://toolbox.local:5173",
      "http://192.168.1.50:3000",
    ]);
  });

  test("sanitizeTrustedOrigins rejects path-bearing / userinfo / garbage entries", () => {
    for (const bad of [
      ["http://x.example/path"],
      ["http://user@example.com"],
      ["ftp://example.com"],
      ["not-an-origin"],
      [42],
      ["http://" + "a".repeat(200) + ".example.com"],
      Array.from({ length: 17 }, () => "http://a.example:1"),
    ]) {
      const r = settingsLib.sanitizeTrustedOrigins(bad);
      assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad).slice(0, 60)}`);
      assert.equal(typeof r.error, "string");
    }
  });

  test("non-array input is rejected, never coerced", () => {
    assert.equal(settingsLib.sanitizeTrustedOrigins("http://ok.example").ok, false);
    assert.equal(settingsLib.sanitizeTrustedOrigins(null).ok, false);
  });

  test("route-level: POST valid list → 200 + applied; invalid list → 400 + untouched", async () => {
    settingsLib.setTrustedOrigins([]);
    const ok = fakeRes();
    await settingsRoute.handlePostSettings(
      fakeReq({ trustedOrigins: ["http://toolbox.local:5173"] }),
      ok,
      {},
    );
    assert.equal(ok._status, 200);
    assert.deepEqual(settingsLib.getTrustedOrigins(), ["http://toolbox.local:5173"]);

    const bad = fakeRes();
    await settingsRoute.handlePostSettings(
      fakeReq({ trustedOrigins: ["http://toolbox.local:5173", "http://evil.example/path"] }),
      bad,
      {},
    );
    assert.equal(bad._status, 400);
    const body = JSON.parse(bad._body);
    assert.equal(body.ok, false);
    // Fail-closed: the valid prefix was NOT partially applied.
    assert.deepEqual(settingsLib.getTrustedOrigins(), ["http://toolbox.local:5173"]);
  });

  test("route-level: same-value list → changed:false (no spurious persist)", async () => {
    settingsLib.setTrustedOrigins(["http://toolbox.local:5173"]);
    const res = fakeRes();
    await settingsRoute.handlePostSettings(
      fakeReq({ trustedOrigins: ["http://toolbox.local:5173"] }),
      res,
      {},
    );
    const body = JSON.parse(res._body);
    assert.equal(res._status, 200);
    assert.equal(body.changed, false);
  });
});
