// webui/test/lib-auth.test.js
// Unit tests for server/lib/auth.js — TOKEN-based auth middleware.
//
// The expected token is read from process.env.TOKEN lazily on each
// call (see getExpectedToken() in lib/auth.js). That means tests can
// set process.env.TOKEN directly without needing to mock config.js
// (avoids Node's ESM-cache + mock.module dance).
//
//   - TOKEN env unset   -> isAuthEnforced() === false (no enforcement)
//   - TOKEN env "abc"   -> isAuthEnforced() === true; req must carry abc
//
// We always clear+set process.env.TOKEN around each test to avoid
// order-dependent pollution (test runner runs tests in declaration
// order in a single process).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(TEST_DIR, "..", "server");
const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href;

// Single import — auth.js reads TOKEN lazily so per-test env changes
// are honored without re-importing.
const auth = await import(absPath("lib/auth.js"));
const {
  extractToken,
  safeEquals,
  isRequestAuthorized,
  isAuthEnforced,
  writeAuthRequired,
  setExpectedToken,
  setTokenAuthEnabled,
} = auth;

// Each test that sets process.env.TOKEN also clears it in a finally
// block (tests run in a single process; order-dependent).

// Make a non-local request so isLocalRequest() returns false.
// Local bypass is tested separately.
function makeReq(headers = {}, url = "/api/state") {
  return {
    headers,
    url,
    socket: { remoteAddress: "192.0.2.1" }, // TEST-NET-1, non-routable, non-loopback
  };
}

// --- extractToken ---------------------------------------------------------

test("extractToken: Authorization: Bearer <token>", () => {
  const req = { headers: { authorization: "Bearer abc123" }, url: "/" };
  assert.equal(extractToken(req), "abc123");
});

test("extractToken: lowercase 'bearer' is accepted", () => {
  const req = { headers: { authorization: "bearer abc123" }, url: "/" };
  assert.equal(extractToken(req), "abc123");
});

test("extractToken: uppercase 'BEARER' is accepted", () => {
  const req = { headers: { authorization: "BEARER abc123" }, url: "/" };
  assert.equal(extractToken(req), "abc123");
});

test("extractToken: 'Bearer<token>' without space is rejected", () => {
  const req = { headers: { authorization: "Bearerabc123" }, url: "/" };
  assert.equal(extractToken(req), "");
});

test("extractToken: header 'Basic ...' is rejected", () => {
  const req = { headers: { authorization: "Basic abc123" }, url: "/" };
  assert.equal(extractToken(req), "");
});

test("extractToken: ?token=<value> query string", () => {
  const req = { headers: {}, url: "/api/state?token=abc123&cid=xyz" };
  assert.equal(extractToken(req), "abc123");
});

test("extractToken: header wins when both header and query set", () => {
  const req = {
    headers: { authorization: "Bearer header-tok" },
    url: "/api/state?token=query-tok",
  };
  assert.equal(extractToken(req), "header-tok");
});

test("extractToken: fragment-only token is server-invisible", () => {
  // Per RFC 3986 the URL fragment is not sent to the server. Node's
  // URL parser drops it from `pathname` + `searchParams` before the
  // auth layer ever sees it.
  const req = { headers: {}, url: "/api/state#token=secret" };
  assert.equal(extractToken(req), "");
});

test("extractToken: caps supplied token at 256 chars", () => {
  const huge = "a".repeat(100_000);
  const req = { headers: {}, url: "/api/state?token=" + huge };
  const got = extractToken(req);
  assert.equal(got.length, 256);
  assert.equal(got, "a".repeat(256));
});

test("extractToken: malformed URL does not throw", () => {
  const req = { headers: {}, url: "not a url" };
  assert.doesNotThrow(() => extractToken(req));
});

test("extractToken: no header, no query => ''", () => {
  const req = { headers: {}, url: "/api/state" };
  assert.equal(extractToken(req), "");
});

// --- safeEquals -----------------------------------------------------------

test("safeEquals: equal strings return true", () => {
  assert.equal(safeEquals("abc", "abc"), true);
  assert.equal(safeEquals("", ""), true);
});

test("safeEquals: different strings return false", () => {
  assert.equal(safeEquals("abc", "abd"), false);
  assert.equal(safeEquals("abc", "ABC"), false);
});

test("safeEquals: length mismatch returns false", () => {
  assert.equal(safeEquals("abc", "abcd"), false);
  assert.equal(safeEquals("abcd", "abc"), false);
});

test("safeEquals: non-string returns false", () => {
  assert.equal(safeEquals(null, "abc"), false);
  assert.equal(safeEquals("abc", undefined), false);
  assert.equal(safeEquals(123, "abc"), false);
});

// --- isAuthEnforced + isRequestAuthorized (env-driven) ------------------

test("isAuthEnforced: TOKEN unset => false (no enforcement)", () => {
  delete process.env.TOKEN;
  assert.equal(isAuthEnforced(), false);
  assert.equal(isRequestAuthorized(makeReq()), true); // bypass
});

test("isAuthEnforced: TOKEN set => true; remote + no token => 401", () => {
  process.env.TOKEN = "expected-token";
  try {
    assert.equal(isAuthEnforced(), true);
    assert.equal(isRequestAuthorized(makeReq()), false);
  } finally {
    delete process.env.TOKEN;
  }
});

test("isRequestAuthorized: header matches TOKEN", () => {
  process.env.TOKEN = "expected-token";
  try {
    const req = makeReq({ authorization: "Bearer expected-token" });
    assert.equal(isRequestAuthorized(req), true);
  } finally {
    delete process.env.TOKEN;
  }
});

test("isRequestAuthorized: header case-insensitive", () => {
  process.env.TOKEN = "expected-token";
  try {
    assert.equal(
      isRequestAuthorized(makeReq({ authorization: "bearer expected-token" })),
      true,
    );
    assert.equal(
      isRequestAuthorized(makeReq({ authorization: "BEARER expected-token" })),
      true,
    );
  } finally {
    delete process.env.TOKEN;
  }
});

test("isRequestAuthorized: header wrong token => false", () => {
  process.env.TOKEN = "expected-token";
  try {
    assert.equal(
      isRequestAuthorized(makeReq({ authorization: "Bearer wrong-token" })),
      false,
    );
  } finally {
    delete process.env.TOKEN;
  }
});

test("isRequestAuthorized: query matches TOKEN (SSE path)", () => {
  process.env.TOKEN = "expected-token";
  try {
    assert.equal(
      isRequestAuthorized(
        makeReq({}, "/api/events?token=expected-token&cid=x"),
      ),
      true,
    );
  } finally {
    delete process.env.TOKEN;
  }
});

test("isRequestAuthorized: query wrong token => false", () => {
  process.env.TOKEN = "expected-token";
  try {
    assert.equal(
      isRequestAuthorized(makeReq({}, "/api/events?token=wrong")),
      false,
    );
  } finally {
    delete process.env.TOKEN;
  }
});

test("isRequestAuthorized: no token at all when TOKEN set => false", () => {
  process.env.TOKEN = "expected-token";
  try {
    assert.equal(isRequestAuthorized(makeReq()), false);
  } finally {
    delete process.env.TOKEN;
  }
});

test("isRequestAuthorized: length-mismatch (10MB supplied) returns false", () => {
  process.env.TOKEN = "x";
  try {
    const huge = "a".repeat(10_000_000);
    // clip to 256, then compare to "x" (length 1) -> not equal -> false
    const req = makeReq({}, "/api/state?token=" + huge);
    assert.equal(isRequestAuthorized(req), false);
  } finally {
    delete process.env.TOKEN;
  }
});

test("isRequestAuthorized: local request bypasses token check (no token)", () => {
  process.env.TOKEN = "expected-token";
  try {
    // 127.0.0.1 is loopback — isLocalRequest should return true
    const req = makeReq({}, "/api/state");
    req.socket.remoteAddress = "127.0.0.1";
    assert.equal(isRequestAuthorized(req), true);
  } finally {
    delete process.env.TOKEN;
  }
});

test("isRequestAuthorized: IPv6 ::1 loopback bypasses token check", () => {
  process.env.TOKEN = "expected-token";
  try {
    const req = makeReq({}, "/api/state");
    req.socket.remoteAddress = "::1";
    assert.equal(isRequestAuthorized(req), true);
  } finally {
    delete process.env.TOKEN;
  }
});

test("isRequestAuthorized: IPv6-mapped loopback bypasses token check", () => {
  process.env.TOKEN = "expected-token";
  try {
    const req = makeReq({}, "/api/state");
    req.socket.remoteAddress = "::ffff:127.0.0.1";
    assert.equal(isRequestAuthorized(req), true);
  } finally {
    delete process.env.TOKEN;
  }
});

// --- writeAuthRequired ---------------------------------------------------

test("writeAuthRequired: 401 + JSON body, no token echo", () => {
  const fakeRes = {
    headersSent: false,
    writeHead(status, headers) {
      this._status = status;
      this._headers = headers;
    },
    end(body) {
      this._body = body;
    },
  };
  const handled = writeAuthRequired(fakeRes);
  assert.equal(handled, true);
  assert.equal(fakeRes._status, 401);
  assert.match(fakeRes._headers["Content-Type"], /json/);
  assert.match(fakeRes._headers["WWW-Authenticate"], /Bearer/);
  const body = JSON.parse(fakeRes._body);
  assert.equal(body.ok, false);
  assert.equal(body.error, "auth required");
  // NEVER include any token-shaped field
  assert.equal(Object.keys(body).length, 2);
});

// --- v1.0.1: setExpectedToken / setTokenAuthEnabled / in-memory override ---

test("setExpectedToken: in-memory override is honored when env unset", () => {
  delete process.env.TOKEN;
  setExpectedToken("in-memory-token");
  try {
    assert.equal(isAuthEnforced(), true);
    assert.equal(isRequestAuthorized(makeReq({ authorization: "Bearer in-memory-token" })), true);
    assert.equal(isRequestAuthorized(makeReq({ authorization: "Bearer wrong" })), false);
  } finally {
    setExpectedToken("");
  }
});

test("setExpectedToken: env TOKEN still wins over in-memory", () => {
  setExpectedToken("in-memory-token");
  process.env.TOKEN = "env-token";
  try {
    // in-memory token should NOT match
    assert.equal(isRequestAuthorized(makeReq({ authorization: "Bearer in-memory-token" })), false);
    // env token should match
    assert.equal(isRequestAuthorized(makeReq({ authorization: "Bearer env-token" })), true);
  } finally {
    delete process.env.TOKEN;
    setExpectedToken("");
  }
});

test("setTokenAuthEnabled(false): bypasses even when token is set", () => {
  setExpectedToken("some-token");
  setTokenAuthEnabled(false);
  try {
    // Even with a token in expected, the gate is OFF
    assert.equal(isAuthEnforced(), false);
    // No token presented — but auth is off, so authorized
    assert.equal(isRequestAuthorized(makeReq()), true);
    // Wrong token — also OK because auth is off
    assert.equal(isRequestAuthorized(makeReq({ authorization: "Bearer wrong" })), true);
  } finally {
    setTokenAuthEnabled(true);
    setExpectedToken("");
  }
});

test("setTokenAuthEnabled: persistent — survives across multiple isRequestAuthorized calls", () => {
  setTokenAuthEnabled(false);
  setExpectedToken("abc");
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal(isRequestAuthorized(makeReq()), true);
    }
  } finally {
    setTokenAuthEnabled(true);
    setExpectedToken("");
  }
});
