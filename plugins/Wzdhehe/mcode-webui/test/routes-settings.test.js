// webui/test/routes-settings.test.js
// Unit tests for server/routes/settings.js — handleGetSettings + handlePostSettings.
//
// Why this test exists: /api/settings is the LAN broadcast toggle. handlePostSettings
// only updates the flag if it actually changed (avoids spurious "settings saved"
// UI feedback). Bugs here = user can't toggle LAN, or settings say "saved" when
// nothing actually changed.
//
// Test strategy: NO setupMocks. routes-settings.js imports settings.js (no webui
// deps). All state is module-level in settings.js (we set it before each test).

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const settingsRoute = await import(absPath("routes/settings.js"));
const settingsLib = await import(absPath("lib/settings.js"));

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

describe("handleGetSettings — /api/settings GET", () => {
  beforeEach(() => {
    settingsLib.setLanBroadcast(true);
  });

  test("returns 200 + full snapshot", () => {
    const res = fakeRes();
    settingsRoute.handleGetSettings(null, res);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.lanBroadcast, true);
    assert.equal(typeof body.port, "number");
    assert.equal(typeof body.host, "string");
  });
});

describe("handlePostSettings — /api/settings POST", () => {
  beforeEach(() => {
    settingsLib.setLanBroadcast(true); // reset to known state
  });

  test("lanBroadcast:true sets changed:true (state was false)", async () => {
    settingsLib.setLanBroadcast(false);
    const res = fakeRes();
    await settingsRoute.handlePostSettings(
      fakeReq({ lanBroadcast: true }),
      res,
      {},
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.lanBroadcast, true);
    assert.equal(body.changed, true);
    assert.equal(settingsLib.getLanBroadcast(), true);
  });

  test("lanBroadcast:false sets changed:true (state was true)", async () => {
    // beforeEach sets to true
    const res = fakeRes();
    await settingsRoute.handlePostSettings(
      fakeReq({ lanBroadcast: false }),
      res,
      {},
    );
    const body = JSON.parse(res._body);
    assert.equal(body.lanBroadcast, false);
    assert.equal(body.changed, true);
    assert.equal(settingsLib.getLanBroadcast(), false);
  });

  test("lanBroadcast:same value sets changed:false", async () => {
    // beforeEach sets to true
    const res = fakeRes();
    await settingsRoute.handlePostSettings(
      fakeReq({ lanBroadcast: true }), // same as current
      res,
      {},
    );
    const body = JSON.parse(res._body);
    assert.equal(body.lanBroadcast, true);
    assert.equal(body.changed, false, "should report no change when value is same");
  });

  test("missing lanBroadcast field sets changed:false (no update)", async () => {
    const res = fakeRes();
    await settingsRoute.handlePostSettings(fakeReq({}), res, {});
    const body = JSON.parse(res._body);
    assert.equal(body.changed, false);
    assert.equal(settingsLib.getLanBroadcast(), true, "should not change state");
  });

  test("non-boolean lanBroadcast (e.g. string) sets changed:false", async () => {
    const res = fakeRes();
    await settingsRoute.handlePostSettings(
      fakeReq({ lanBroadcast: "yes" }),
      res,
      {},
    );
    const body = JSON.parse(res._body);
    assert.equal(body.changed, false, "string 'yes' is not a boolean");
  });

  test("response always includes the full snapshot (port, host, lanIp, etc)", async () => {
    const res = fakeRes();
    await settingsRoute.handlePostSettings(
      fakeReq({ lanBroadcast: false }),
      res,
      {},
    );
    const body = JSON.parse(res._body);
    assert.equal(typeof body.port, "number");
    assert.equal(typeof body.host, "string");
    assert.equal(typeof body.lanIp, "string");
    assert.equal(typeof body.lanUrl, "string");
    assert.equal(typeof body.localUrl, "string");
    assert.equal(typeof body.mcodeCmd, "string");
    assert.equal(typeof body.mcodeVersion, "string");
  });
});
