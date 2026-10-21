// webui/test/lib-config-bindhost.test.js
// v2 security fix (PR #55 review point 2) — the default bind is
// loopback. Pins:
//
//   - resolveBindHost() pure rule: env HOST > lanBind opt-in > loopback
//   - the exported HOST constant actually resolved to loopback in a
//     process with no env HOST and no persisted lanBind
//
// The live-boot proof (server.js listening line) is covered by
// test/integration/default-bind.test.js. Here we keep it unit-level:
// env is scrubbed BEFORE the one-shot config.js import, and the
// settings path points at a nonexistent temp file so the host's real
// ~/.mcode-webui/settings.json cannot leak lanBind into the result.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

let cfg;
before(async () => {
  delete process.env.HOST;
  process.env.MCODE_WEBUI_SETTINGS_PATH = join(
    mkdtempSync(join(tmpdir(), "webui-bindhost-test-")),
    "settings.json", // deliberately NOT created — readPersistedLanBind sees no file
  );
  cfg = await import(absPath("lib/config.js"));
});

describe("resolveBindHost — pure resolution rule", () => {
  test("explicit env HOST always wins (deploys / docker keep working)", () => {
    assert.equal(cfg.resolveBindHost("0.0.0.0", true), "0.0.0.0");
    assert.equal(cfg.resolveBindHost("192.168.1.9", true), "192.168.1.9");
    assert.equal(cfg.resolveBindHost("  0.0.0.0  ", false), "0.0.0.0");
  });

  test("blank env HOST falls through (not treated as explicit)", () => {
    assert.equal(cfg.resolveBindHost("", true), "0.0.0.0");
    assert.equal(cfg.resolveBindHost("   ", false), "127.0.0.1");
  });

  test("persisted lanBind opt-in binds 0.0.0.0", () => {
    assert.equal(cfg.resolveBindHost(undefined, true), "0.0.0.0");
  });

  test("no env, no opt-in → loopback (the new default)", () => {
    assert.equal(cfg.resolveBindHost(undefined, false), "127.0.0.1");
    assert.equal(cfg.resolveBindHost(undefined, undefined), "127.0.0.1");
  });
});

describe("exported HOST constant (module-load resolution)", () => {
  test("resolves to 127.0.0.1 with no env HOST and no persisted lanBind", () => {
    assert.equal(cfg.HOST, "127.0.0.1");
  });
});
