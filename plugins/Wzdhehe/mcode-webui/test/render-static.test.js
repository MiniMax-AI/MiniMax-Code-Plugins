// webui/test/render-static.test.js
// Static source assertions for public/app/render.js — the session-delete
// second-confirm bar must never be assembled from an innerHTML template
// string (CodeQL js/xss-through-dom: the DOM-sourced data-id value sat
// in an attribute position where a quote breaks out).
//
// Style follows test/main-static.test.js: read the source and assert
// mechanically. No DOM is instantiated; we assert on the code shape
// itself so a regression (someone "simplifying" the confirm bar back to
// innerHTML concatenation) fails the suite.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const RENDER_SRC = readFileSync(
  resolve(TEST_DIR, "..", "public", "app", "render.js"),
  "utf8",
);

// The session-delete confirm bar construction: from the bar element's
// creation to the appendChild that attaches it to the session item
// (inclusive).
function confirmBarBlock() {
  const start = RENDER_SRC.indexOf("const bar = document.createElement('div')");
  if (start === -1) return null;
  const endMarker = "item.appendChild(bar)";
  const end = RENDER_SRC.indexOf(endMarker, start);
  if (end === -1) return null;
  return RENDER_SRC.slice(start, end + endMarker.length);
}

describe("render.js session-confirm bar — DOM construction", () => {
  test("the confirm-bar construction block exists", () => {
    assert.ok(
      confirmBarBlock(),
      "cannot locate the session-confirm bar construction block",
    );
  });

  test("confirm-bar block assigns zero innerHTML", () => {
    const block = confirmBarBlock();
    assert.ok(block, "cannot locate the session-confirm bar construction block");
    assert.equal(
      /\.innerHTML\s*=/.test(block),
      false,
      "session-confirm bar must not assign innerHTML (DOM-sourced data-id in attribute position)",
    );
  });

  test("confirm-bar block builds elements via createElement + setAttribute + textContent", () => {
    const block = confirmBarBlock();
    assert.ok(block, "cannot locate the session-confirm bar construction block");
    assert.match(block, /createElement\(\s*['"]div['"]\s*\)/);
    assert.match(block, /createElement\(\s*['"]span['"]\s*\)/);
    assert.match(block, /createElement\(\s*['"]button['"]\s*\)/);
    assert.match(block, /setAttribute\(\s*['"]data-id['"]/);
    assert.match(block, /\.textContent\s*=/);
  });

  test("visual parity survives: same structure, classes, cancel title", () => {
    const block = confirmBarBlock();
    assert.ok(block, "cannot locate the session-confirm bar construction block");
    assert.match(block, /className\s*=\s*['"]session-confirm['"]/);
    assert.match(block, /className\s*=\s*['"]session-confirm-yes['"]/);
    assert.match(block, /className\s*=\s*['"]session-confirm-no['"]/);
    assert.match(block, /setAttribute\(\s*['"]title['"],\s*t\('session_delete_cancel'\)\)/);
    assert.match(block, /t\('session_delete_confirm'\)/);
    assert.match(block, /t\('session_delete_yes'\)/);
  });
});
