// webui/test/main-static.test.js
// Static source assertions for public/app/main.js — the init-failure
// fallback must never assign innerHTML from concatenated error text
// (CodeQL js/xss-through-innerHTML, PR #55).
//
// Style follows scripts/check-docs-alignment.mjs: read the source and
// assert mechanically. No DOM is instantiated; we assert on the code
// shape itself so a regression (someone "simplifying" the fatal-error
// panel back to innerHTML concatenation) fails the suite.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MAIN_SRC = readFileSync(
  resolve(TEST_DIR, "..", "public", "app", "main.js"),
  "utf8",
);

// The init-fatal catch block: from the "[webui INIT FATAL]" log line to
// the re-throw that follows it.
function initFatalBlock() {
  const start = MAIN_SRC.indexOf("[webui INIT FATAL]");
  if (start === -1) return null;
  const end = MAIN_SRC.indexOf("throw e", start);
  if (end === -1) return null;
  return MAIN_SRC.slice(start, end);
}

describe("main.js init-failure fallback — no innerHTML", () => {
  test("the INIT FATAL catch block exists", () => {
    assert.ok(initFatalBlock(), "cannot locate the init-fatal catch block");
  });

  test("catch block assigns zero innerHTML", () => {
    const block = initFatalBlock();
    assert.ok(block, "cannot locate the init-fatal catch block");
    assert.equal(
      /\.innerHTML\s*=/.test(block),
      false,
      "init-failure fallback must not assign innerHTML (untrusted e?.stack)",
    );
  });

  test("catch block builds the panel via DOM APIs + textContent", () => {
    const block = initFatalBlock();
    assert.ok(block, "cannot locate the init-fatal catch block");
    assert.match(block, /createElement\(\s*['"]pre['"]\s*\)/);
    assert.match(block, /\.textContent\s*=/);
    // Full-replacement semantics (the old innerHTML overwrite cleared
    // the body; replaceChildren keeps that without parsing markup).
    assert.match(block, /replaceChildren\(pre\)/);
  });

  test("visual parity survives: red text, padding, font size", () => {
    const block = initFatalBlock();
    assert.ok(block, "cannot locate the init-fatal catch block");
    assert.match(block, /color\s*=\s*['"]red['"]/);
    assert.match(block, /padding\s*=\s*['"]20px['"]/);
    assert.match(block, /fontSize\s*=\s*['"]14px['"]/);
  });
});
