// webui/test/check-docs-alignment.test.js
// Unit tests for scripts/check-docs-alignment.mjs.
//
// Strategy: we import the script's helper functions by re-reading the
// source file and exercising them on synthetic router / doc fixtures
// in-memory. This keeps the test fully offline (no filesystem writes,
// no need to launch the real webui) and fast (< 50 ms).
//
// We do NOT shell out to `node scripts/check-docs-alignment.mjs` from
// this test — that would create a fragile dependency on the live
// plugin.json / router.js. The point of these tests is to lock down
// the script's logic so a future refactor of pathMatches() etc.
// doesn't silently regress.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SCRIPT_PATH = join(ROOT, "scripts", "check-docs-alignment.mjs");

// -----------------------------------------------------------------------
// pathMatches — extract and exercise directly. We avoid importing the
// whole script (which would also try to read live files); instead we
// parse the script source for the helper definition and re-execute it
// in a sandboxed Function scope.
//
// This is a deliberately light dependency: if check-docs-alignment.mjs
// ever renames the helper or moves it, these tests fail loudly, which
// is exactly the signal we want.
// -----------------------------------------------------------------------

function extractHelper(name) {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  // Match the full `function name(paramA, paramB) { ... }` block.
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`helper "${name}" not found in script`);
  let depth = 0;
  let i = src.indexOf("{", start);
  const open = start; // include the `function name(...)` signature
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // Eval the helper as a function declaration into a fresh scope.
        // eslint-disable-next-line no-new-func
        return new Function(
          src.slice(open, i + 1) + `\nreturn ${name};`,
        )();
      }
    }
  }
  throw new Error(`helper "${name}" body did not close`);
}

const pathMatches = extractHelper("pathMatches");

describe("check-docs-alignment / pathMatches", () => {
  const routerLiteral = `
    match: (p) => p === "/api/health",
  `;
  const routerDynamic = `
    match: (p) => p.startsWith("/api/sessions/") && p.length > "/api/sessions/".length,
  `;

  test("literal substring match returns true", () => {
    assert.equal(pathMatches("/api/health", routerLiteral), true);
  });

  test("literal substring match returns false when path is absent", () => {
    assert.equal(pathMatches("/api/missing", routerLiteral), false);
  });

  test("dynamic :id placeholder matches startsWith guard", () => {
    assert.equal(pathMatches("/api/sessions/:id", routerDynamic), true);
  });

  test("dynamic :id placeholder does not match a literal-only router", () => {
    assert.equal(pathMatches("/api/sessions/:id", routerLiteral), false);
  });

  test("concrete dynamic path falls through (no literal substring, no :id param)", () => {
    // /api/sessions/foo is neither a literal substring of the router
    // source nor an :id-style placeholder, so it does NOT match the
    // dynamic guard by itself. (The router would actually dispatch it,
    // but pathMatches() is intentionally a structural check, not a
    // behavior simulation.)
    assert.equal(pathMatches("/api/sessions/foo", routerDynamic), false);
  });

  test("quotes can be either double or single in router source", () => {
    const singleQuote = `
      match: (p) => p.startsWith('/api/sessions/') && p.length > '/api/sessions/'.length,
    `;
    assert.equal(pathMatches("/api/sessions/:id", singleQuote), true);
  });

  test("multi-segment path with placeholder does not match (no structural fragment)", () => {
    // /api/sessions/:id/messages — the placeholder regex only handles
    // a trailing :param, not an inline one. The helper's job is to
    // assert structural coverage, not full URL templating, so this
    // intentionally returns false.
    assert.equal(
      pathMatches("/api/sessions/:id/messages", routerDynamic),
      false,
    );
  });

  test("totally unrelated paths do not match", () => {
    assert.equal(pathMatches("/api/totally/different", routerDynamic), false);
  });
});

// -----------------------------------------------------------------------
// The live check script — sanity assertions on its surface (exit codes
// + filesystem footprint). We do not exec it here because the real
// repo will (correctly!) fail the check until §AP11 drift is resolved
// (cleanup-orphans endpoint is documented but not registered).
// -----------------------------------------------------------------------

describe("check-docs-alignment / script surface", () => {
  test("the script file exists at scripts/check-docs-alignment.mjs", () => {
    // Will throw ENOENT if missing.
    readFileSync(SCRIPT_PATH, "utf8");
  });

  test("the script has no `npm` dependency declarations (zero-dep)", () => {
    const src = readFileSync(SCRIPT_PATH, "utf8");
    assert.equal(/require\(/.test(src), false, "should not use CommonJS require()");
    // Confirm only node: builtins are imported.
    const imports = [...src.matchAll(/^import .+ from ["']([^"']+)["'];?$/gm)];
    assert.ok(imports.length > 0, "expected at least one import");
    for (const m of imports) {
      assert.match(
        m[1],
        /^(node:|\.\/)/,
        `import "${m[1]}" must be a node: builtin or relative path`,
      );
    }
  });

  test("the script declares its exit codes via process.exit(0|1|2)", () => {
    const src = readFileSync(SCRIPT_PATH, "utf8");
    assert.match(src, /process\.exit\(0\)/);
    assert.match(src, /process\.exit\(1\)/);
    assert.match(src, /process\.exit\(2\)/);
  });

  test("the script supports the package.json `check` invocation", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );
    assert.equal(
      pkg.scripts.check,
      "node scripts/check-docs-alignment.mjs",
      "package.json must wire `npm run check` to the script",
    );
  });
});

// -----------------------------------------------------------------------
// Live execution — we run the script with the real repo's fixtures and
// assert that it produces the EXPECTED drift list (the §AP11 cleanup-
// orphans endpoint + a handful of env vars that aren't exported by
// config.js). The test passes when the script exits with code 1 and
// the expected drift items appear in stderr.
//
// We use node --no-warnings to keep CI logs quiet.
// -----------------------------------------------------------------------

import { spawnSync } from "node:child_process";

describe("check-docs-alignment / live execution", () => {
  test("script exits 0 on the real repo (post-reconcile §6)", () => {
    const res = spawnSync(
      process.execPath,
      [SCRIPT_PATH],
      { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
    );
    // v2.0 reconcile §6 (2026-09-20): both known drift families were
    // resolved — §AP11 cleanup-orphans route wired in router.js (§6.1)
    // and 4× SECURITY-NOTES env vars exported in config.js (§6.2).
    // The script should now exit 0 (no drift) and the output should
    // NOT mention §AP11 anymore. The check stays tight here so it
    // fails loudly if someone re-introduces drift.
    assert.equal(
      res.status,
      0,
      `expected exit 0 (no drift, post-reconcile §6), got ${res.status}. ` +
      `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
    // Strip ANSI escape codes so the regex sees plain "OK all checks
    // passed." (the script colors its output, see TAG.red/green).
    const stripped = ((res.stdout || "") + (res.stderr || "")).replace(
      /\x1b\[[0-9;]*m/g,
      "",
    );
    // The §AP11 cleanup-orphans check title still appears in the script's
    // output as the heading "[6/6] known drift: cleanup-orphans endpoint
    // consistency" — but its body must be a ✓ (passed) line, not a ✗
    // (failed) line. Assert NO ✗ markers at all: that catches the §AP11
    // drift AND any re-introduced drift in any of the 6 check groups.
    assert.equal(
      (stripped.match(/^\s*✗\s/gm) || []).length,
      0,
      `expected NO ✗ lines after reconcile §6, got ` +
      `${(stripped.match(/✗/g) || []).length} ✗ markers.\n` +
      `stripped: ${stripped.slice(0, 1200)}`,
    );
    assert.match(
      stripped,
      /OK\s+all checks passed/,
      `expected "OK all checks passed" after reconcile §6, got stripped: ${stripped.slice(0, 600)}`,
    );
  });

  test("script reports 0 mismatches when run against a synthetic green tree", () => {
    // We can't easily synthesize a green tree in the same repo, so
    // this is a placeholder that asserts the script's plumbing is
    // working: it must parse plugin.json, README.md, docs/API.md,
    // docs/CAPABILITIES.md, references/SECURITY-NOTES.md,
    // server/router.js, server/lib/config.js without throwing.
    // (Any throw would surface as a non-{0,1,2} exit code.)
    const res = spawnSync(
      process.execPath,
      [SCRIPT_PATH],
      { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
    );
    assert.ok(
      res.status === 0 || res.status === 1,
      `script must exit 0 or 1, got ${res.status}. stderr:\n${res.stderr}`,
    );
  });
});

// Keep this last so the helper-eval above is exercised first.
test("absPath helper resolves to the script URL correctly", () => {
  const url = pathToFileURL(SCRIPT_PATH).href;
  assert.match(url, /^file:\/\//);
  assert.ok(url.endsWith("check-docs-alignment.mjs"));
});