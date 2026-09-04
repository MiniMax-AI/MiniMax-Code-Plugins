// webui/test/lib-models.test.js
// Unit tests for server/lib/models.js — getMcodeModelLimit (model context limit).
//
// Why this test exists: getMcodeModelLimit maps a model name to its real
// context limit (extracted from mcode's cli.js bundle). The wrong limit
// means the webui "context used %" bar shows wrong % — users see "0%" or
// "200%" depending on which way it's wrong. The fuzzy-match fallback
// (M2.7-highspeed → M2.7's 200k) is non-obvious and easy to break.
//
// Test strategy: NO mock.module. models.js only imports ./config.js.
// getMcodeModelLimit is a pure function on its input string.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const models = await import(absPath("lib/models.js"));

describe("getMcodeModelLimit — known models (exact match)", () => {
  test("'MiniMax-M3' returns 512000", () => {
    assert.equal(models.getMcodeModelLimit("MiniMax-M3"), 512000);
  });

  test("'MiniMax-M2.7' returns 200000", () => {
    assert.equal(models.getMcodeModelLimit("MiniMax-M2.7"), 200000);
  });

  test("'MiniMax-M2.7-highspeed' returns 200000 (exact match)", () => {
    // The hardcoded MCODE_MODEL_LIMITS table has this entry directly
    assert.equal(models.getMcodeModelLimit("MiniMax-M2.7-highspeed"), 200000);
  });
});

describe("getMcodeModelLimit — fully qualified name (provider/model)", () => {
  test("'minimax_api/MiniMax-M3' strips provider and returns 512000", () => {
    assert.equal(models.getMcodeModelLimit("minimax_api/MiniMax-M3"), 512000);
  });

  test("'someprovider/MiniMax-M2.7' strips any provider", () => {
    assert.equal(models.getMcodeModelLimit("someprovider/MiniMax-M2.7"), 200000);
  });

  test("'minimax_api/MiniMax-M2.7-highspeed' returns 200000", () => {
    assert.equal(
      models.getMcodeModelLimit("minimax_api/MiniMax-M2.7-highspeed"),
      200000,
    );
  });
});

describe("getMcodeModelLimit — empty / null / unknown", () => {
  test("empty string returns 0", () => {
    assert.equal(models.getMcodeModelLimit(""), 0);
  });

  test("null returns 0", () => {
    assert.equal(models.getMcodeModelLimit(null), 0);
  });

  test("undefined returns 0", () => {
    assert.equal(models.getMcodeModelLimit(undefined), 0);
  });

  test("unknown model returns 0", () => {
    assert.equal(models.getMcodeModelLimit("gpt-4-unknown"), 0);
  });
});

describe("getMcodeModelLimit — fuzzy match (suffix variants)", () => {
  test("'MiniMax-M3-turbo' should match 'MiniMax-M3' via prefix fuzzy (M3 startsWith short)", () => {
    // The fuzzy logic iterates keys: if short.startsWith(k) || k.startsWith(short)
    // "MiniMax-M3-turbo".startsWith("MiniMax-M3") → true → 512000
    assert.equal(models.getMcodeModelLimit("MiniMax-M3-turbo"), 512000);
  });

  test("'MiniMax-M2.7-something' matches 'MiniMax-M2.7' via prefix (200k)", () => {
    // short = "MiniMax-M2.7-something", key = "MiniMax-M2.7"
    // short.startsWith(key) → true → 200000
    assert.equal(models.getMcodeModelLimit("MiniMax-M2.7-something"), 200000);
  });

  test("fully-qualified with unknown suffix falls back via prefix match", () => {
    // "minimax_api/MiniMax-M3-experimental" → short = "MiniMax-M3-experimental"
    // short.startsWith("MiniMax-M3") → true → 512000
    assert.equal(
      models.getMcodeModelLimit("minimax_api/MiniMax-M3-experimental"),
      512000,
    );
  });
});
