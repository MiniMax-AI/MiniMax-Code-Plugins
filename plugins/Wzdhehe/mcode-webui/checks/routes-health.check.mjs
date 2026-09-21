// webui/test/routes-health.test.js
// Unit tests for server/routes/health.js — handleHealth.
//
// Why this test exists: /api/health is the first thing every external monitor
// and the agent-browser probe hits. If it returns wrong shape, monitoring
// breaks and we don't notice the server is broken.
//
// Test strategy: NO setupMocks. handleHealth is a pure function over config
// constants. No webui deps, no fs.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const health = await import(absPath("routes/health.js"));

function fakeRes() {
  const res = {
    _status: null,
    _headers: null,
    _body: null,
    writeHead(s, h) {
      this._status = s;
      this._headers = h;
    },
    end(b) {
      this._body = b;
    },
  };
  return res;
}

describe("handleHealth — /api/health", () => {
  test("returns 200 + ok:true", () => {
    const res = fakeRes();
    health.handleHealth(null, res);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
  });

  test("response includes all expected fields", () => {
    const res = fakeRes();
    health.handleHealth(null, res);
    const body = JSON.parse(res._body);
    // Check all documented fields exist with correct types
    assert.equal(typeof body.port, "number");
    assert.equal(typeof body.defaultModel, "string");
    assert.equal(typeof body.defaultWorkspace, "string");
    assert.equal(typeof body.mcodeCmd, "string");
    assert.equal(typeof body.mcodeVersion, "string");
    assert.equal(typeof body.maxConcurrent, "number");
  });

  test("Content-Type is application/json", () => {
    const res = fakeRes();
    health.handleHealth(null, res);
    assert.match(res._headers["Content-Type"], /application\/json/);
  });

  test("port is a valid port number (1-65535)", () => {
    const res = fakeRes();
    health.handleHealth(null, res);
    const body = JSON.parse(res._body);
    assert.ok(body.port > 0 && body.port < 65536);
  });

  test("maxConcurrent is a positive integer", () => {
    const res = fakeRes();
    health.handleHealth(null, res);
    const body = JSON.parse(res._body);
    assert.ok(Number.isInteger(body.maxConcurrent));
    assert.ok(body.maxConcurrent > 0);
  });
});
