// webui/checks/router-origin-gate.check.mjs
// v2 security fix (PR #55 review point 1) — behavioral pins for the
// router's browser-Origin trust surface, driven through the REAL
// handleRequest (no mocks on the router path):
//
//   1. malicious-page simulation: Origin: http://evil.example against
//      127.0.0.1 — GET gets NO CORS headers (page cannot read the
//      body), mutating routes get 403 EVEN THOUGH the socket is
//      loopback-local (the wildcard-CORS × local-token-bypass
//      combination hole from the review).
//   2. trusted Origin (the server's own serving origin) is reflected
//      verbatim and its POSTs pass.
//   3. Origin-less clients (curl / MCP / CLI shape) are untouched.
//   4. explicitly configured trustedOrigins entries pass the gate.
//
// All requests originate from remoteAddress 127.0.0.1 on purpose:
// that is exactly the position a hostile page's browser request lands
// in, and the gate must not be fooled by it.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

// Fixed port so the "own serving origin" is predictable. Must be set
// before config.js is imported (PORT is resolved at module load).
const PORT = 8123;
const OWN_ORIGIN = `http://127.0.0.1:${PORT}`;
const EVIL_ORIGIN = "http://evil.example";

let _tmpSettings;
let _tmpEvents;
before(async () => {
  process.env.PORT = String(PORT);
  _tmpSettings = mkdtempSync(join(tmpdir(), "webui-origingate-settings-"));
  _tmpEvents = mkdtempSync(join(tmpdir(), "webui-origingate-events-"));
  process.env.MCODE_WEBUI_SETTINGS_PATH = join(_tmpSettings, "settings.json");
  process.env.MCODE_WEBUI_EVENTS_PATH = join(_tmpEvents, "events.ndjson");
  delete process.env.TOKEN;
  delete process.env.HOST;
});
after(async () => {
  delete process.env.PORT;
  for (const d of [_tmpSettings, _tmpEvents]) {
    if (d) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  }
});

const router = await import(absPath("router.js"));
const settingsLib = await import(absPath("lib/settings.js"));

function fakeReq({ method = "GET", url = "/api/health", origin, body }) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  const src = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  const req = Readable.from(src);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: "127.0.0.1" }; // loopback on purpose — see header
  return req;
}

function fakeRes() {
  const res = {
    _headers: {},
    _status: null,
    _body: null,
    headersSent: false,
    setHeader(k, v) {
      this._headers[String(k).toLowerCase()] = v;
    },
    getHeader(k) {
      return this._headers[String(k).toLowerCase()];
    },
    writeHead(status, headers) {
      this._status = status;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          this._headers[String(k).toLowerCase()] = v;
        }
      }
      this.headersSent = true;
    },
    end(b) {
      if (b !== undefined) this._body = b;
      this.headersSent = true;
    },
  };
  return res;
}

describe("router Gate 1 — CORS reflection (PR #55 point 1)", () => {
  test("malicious page: GET from evil origin → 200 but NO Access-Control headers (body unreadable)", async () => {
    const res = fakeRes();
    await router.handleRequest(fakeReq({ origin: EVIL_ORIGIN }), res);
    assert.equal(res._status, 200, "the GET itself still executes — only the read is denied");
    assert.equal(res.getHeader("access-control-allow-origin"), undefined);
    assert.equal(res.getHeader("access-control-allow-methods"), undefined);
    assert.equal(res.getHeader("access-control-allow-headers"), undefined);
  });

  test("trusted own origin: GET → origin reflected verbatim (never a wildcard)", async () => {
    const res = fakeRes();
    await router.handleRequest(fakeReq({ origin: OWN_ORIGIN }), res);
    assert.equal(res._status, 200);
    assert.equal(res.getHeader("access-control-allow-origin"), OWN_ORIGIN);
    assert.equal(res.getHeader("vary"), "Origin");
    assert.match(
      String(res.getHeader("access-control-allow-headers")),
      /Content-Type, Authorization/,
    );
  });

  test("malicious page: OPTIONS preflight from evil origin → 204, NO CORS headers (consistent with actual responses)", async () => {
    const res = fakeRes();
    await router.handleRequest(fakeReq({ method: "OPTIONS", url: "/api/state", origin: EVIL_ORIGIN }), res);
    assert.equal(res._status, 204);
    assert.equal(res.getHeader("access-control-allow-origin"), undefined);
  });

  test("curl-shaped request (no Origin): no CORS headers, response unaffected", async () => {
    const res = fakeRes();
    await router.handleRequest(fakeReq({}), res);
    assert.equal(res._status, 200);
    assert.equal(res.getHeader("access-control-allow-origin"), undefined);
  });
});

describe("router Gate 1b — Origin/CSRF gate, loopback NOT exempt (the combination hole)", () => {
  test("malicious page: POST from evil origin over a LOOPBACK socket → 403 before any handler", async () => {
    const res = fakeRes();
    await router.handleRequest(
      fakeReq({ method: "POST", url: "/api/settings", origin: EVIL_ORIGIN, body: {} }),
      res,
    );
    assert.equal(res._status, 403, "untrusted-Origin mutating request must die at Gate 1b");
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.match(body.error, /cross-origin/i);
    assert.equal(res.getHeader("access-control-allow-origin"), undefined);
  });

  test("Origin: null (sandboxed iframe) POST → 403 (present-but-untrusted, not absent)", async () => {
    const res = fakeRes();
    await router.handleRequest(
      fakeReq({ method: "POST", url: "/api/settings", origin: "null", body: {} }),
      res,
    );
    assert.equal(res._status, 403);
  });

  test("lookalike origin (suffix trick) POST → 403", async () => {
    const res = fakeRes();
    await router.handleRequest(
      fakeReq({
        method: "POST",
        url: "/api/settings",
        origin: `${OWN_ORIGIN}.evil.example`,
        body: {},
      }),
      res,
    );
    assert.equal(res._status, 403);
  });

  test("trusted own origin: POST reaches the handler (SPA same-origin flow intact)", async () => {
    const res = fakeRes();
    await router.handleRequest(
      fakeReq({ method: "POST", url: "/api/settings", origin: OWN_ORIGIN, body: {} }),
      res,
    );
    assert.equal(res._status, 200, "same-origin SPA POST must keep working");
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.changed, false);
    assert.equal(res.getHeader("access-control-allow-origin"), OWN_ORIGIN);
  });

  test("Origin-less client (curl / MCP / CLI): POST passes Gate 1b unchanged — zero regression", async () => {
    const res = fakeRes();
    await router.handleRequest(
      fakeReq({ method: "POST", url: "/api/settings", body: {} }),
      res,
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
  });

  test("explicitly configured trustedOrigins entry passes the gate; unconfigured does not", async () => {
    settingsLib.setTrustedOrigins(["http://toolbox.local:5173"]);
    try {
      const ok = fakeRes();
      await router.handleRequest(
        fakeReq({
          method: "POST",
          url: "/api/settings",
          origin: "http://toolbox.local:5173",
          body: {},
        }),
        ok,
      );
      assert.equal(ok._status, 200);
      assert.equal(ok.getHeader("access-control-allow-origin"), "http://toolbox.local:5173");

      const no = fakeRes();
      await router.handleRequest(
        fakeReq({
          method: "POST",
          url: "/api/settings",
          origin: "http://other-toolbox.local:5173",
          body: {},
        }),
        no,
      );
      assert.equal(no._status, 403);
    } finally {
      settingsLib.setTrustedOrigins([]);
    }
  });
});
