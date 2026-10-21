// webui/test/lib-mcode-rpc.test.js
// Unit tests for server/lib/mcode-rpc.js — public exports + permission mapping.
//
// Why this test exists: mcode-rpc.js is the clean wrapper around mcode 0.1.5
// acp JSON-RPC. PERMISSION_MODES + mcodePermissionToWebui are the enum used
// by routes/model.js. MCODE_ACP_CAPABILITIES drives the capability detection
// in routes/protocol.js. Bugs here = wrong permission labels shown to user
// or capability detection thinks mcode supports methods it doesn't.
//
// Test strategy: NO setupMocks. We import the REAL mcode-rpc.js so we test
// the actual exports. We only test the safe-to-call functions:
// - Pure functions: PERMISSION_MODES, MCODE_ACP_CAPABILITIES, webuiPermissionToMcode,
//   mcodePermissionToWebui
// - UNSUPPORTED short-circuit: setMode, setConfigOption, cancelSession, activateSession
//   (these never reach the real mcode client because they're in the UNSUPPORTED set)
// We do NOT test loadSession/listSessions (would spawn a real mcode acp client).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const rpc = await import(absPath("lib/mcode-rpc.js"));

describe("mcode-rpc — PERMISSION_MODES constant", () => {
  test("is an array of 6 mcode permission mode strings", () => {
    assert.ok(Array.isArray(rpc.PERMISSION_MODES));
    assert.equal(rpc.PERMISSION_MODES.length, 6);
  });

  test("includes the 6 mcode permission mode values", () => {
    assert.ok(rpc.PERMISSION_MODES.includes("default"));
    assert.ok(rpc.PERMISSION_MODES.includes("bypassPermissions"));
    assert.ok(rpc.PERMISSION_MODES.includes("auto"));
    assert.ok(rpc.PERMISSION_MODES.includes("off"));
    assert.ok(rpc.PERMISSION_MODES.includes("read"));
    assert.ok(rpc.PERMISSION_MODES.includes("full"));
  });
});

describe("mcode-rpc — MCODE_ACP_CAPABILITIES", () => {
  test("is an object with expected capability flags (mcode 0.1.5 acp)", () => {
    assert.equal(typeof rpc.MCODE_ACP_CAPABILITIES, "object");
    // mcode 0.1.5 does NOT support set_mode / set_config_option / cancel / activate
    assert.equal(rpc.MCODE_ACP_CAPABILITIES.set_mode, false);
    assert.equal(rpc.MCODE_ACP_CAPABILITIES.set_config_option, false);
    assert.equal(rpc.MCODE_ACP_CAPABILITIES.cancel, false);
    assert.equal(rpc.MCODE_ACP_CAPABILITIES.activate, false);
  });
});

describe("mcode-rpc — mcodePermissionToWebui", () => {
  test("'default' → 'Ask'", () => {
    assert.equal(rpc.mcodePermissionToWebui("default"), "Ask");
  });

  test("'bypassPermissions' → 'Full access'", () => {
    assert.equal(rpc.mcodePermissionToWebui("bypassPermissions"), "Full access");
  });

  test("'auto' → 'Auto'", () => {
    assert.equal(rpc.mcodePermissionToWebui("auto"), "Auto");
  });

  test("'off' → 'Off'", () => {
    assert.equal(rpc.mcodePermissionToWebui("off"), "Off");
  });

  test("'read' → 'Read'", () => {
    assert.equal(rpc.mcodePermissionToWebui("read"), "Read");
  });

  test("'full' → 'Full access'", () => {
    assert.equal(rpc.mcodePermissionToWebui("full"), "Full access");
  });

  test("unknown mode returns the input itself (passthrough)", () => {
    assert.equal(rpc.mcodePermissionToWebui("gibberish"), "gibberish");
  });

  test("empty/undefined mode falls back to 'Full access'", () => {
    assert.equal(rpc.mcodePermissionToWebui(""), "Full access");
    assert.equal(rpc.mcodePermissionToWebui(undefined), "Full access");
    assert.equal(rpc.mcodePermissionToWebui(null), "Full access");
  });
});

describe("mcode-rpc — webuiPermissionToMcode (reverse mapping)", () => {
  test("'ask' → 'default'", () => {
    assert.equal(rpc.webuiPermissionToMcode("ask"), "default");
  });

  test("'full' → 'bypassPermissions'", () => {
    assert.equal(rpc.webuiPermissionToMcode("full"), "bypassPermissions");
  });

  test("'auto' → 'auto'", () => {
    assert.equal(rpc.webuiPermissionToMcode("auto"), "auto");
  });

  test("'read' → 'read'", () => {
    assert.equal(rpc.webuiPermissionToMcode("read"), "read");
  });

  test("'off' → 'off'", () => {
    assert.equal(rpc.webuiPermissionToMcode("off"), "off");
  });

  test("unknown webui mode returns null", () => {
    assert.equal(rpc.webuiPermissionToMcode("gibberish"), null);
  });
});

describe("mcode-rpc — UNSUPPORTED short-circuit functions (no mcode spawn)", () => {
  test("setMode returns {ok:false, code:'unsupported'}", async () => {
    const r = await rpc.setMode("mvs_aaa", "plan_mode");
    assert.equal(r.ok, false);
    assert.equal(r.code, "unsupported");
    // Error message should mention mcode 0.1.5 (sanitized)
    assert.match(r.error, /mcode 0\.1\.5/);
  });

  test("setConfigOption returns {ok:false, code:'unsupported'}", async () => {
    const r = await rpc.setConfigOption("mvs_aaa", "permissionMode", "auto");
    assert.equal(r.ok, false);
    assert.equal(r.code, "unsupported");
  });

  test("cancelSession returns {ok:false, code:'unsupported'}", async () => {
    const r = await rpc.cancelSession("mvs_aaa");
    assert.equal(r.ok, false);
    assert.equal(r.code, "unsupported");
  });

  test("activateSession returns {ok:false, code:'unsupported'}", async () => {
    const r = await rpc.activateSession("mvs_aaa");
    assert.equal(r.ok, false);
    assert.equal(r.code, "unsupported");
  });
});

describe("mcode-rpc — error message sanitization (indirect via setMode)", () => {
  test("error message is sanitized (no embedded newlines or control chars)", async () => {
    // The default error message for unsupported methods comes from
    // callRpc() → fail() → sanitizeError(). The result is a single-line
    // string with no control characters.
    const r = await rpc.setMode("mvs_aaa", "plan_mode");
    assert.equal(r.ok, false);
    // The sanitized message should be a single line (no \n or \r)
    assert.ok(!r.error.includes("\n"), `error should not contain \\n: ${r.error}`);
    assert.ok(!r.error.includes("\r"), `error should not contain \\r: ${r.error}`);
  });
});
