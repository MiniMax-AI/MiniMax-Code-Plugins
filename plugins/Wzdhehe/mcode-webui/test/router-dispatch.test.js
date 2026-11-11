// webui/test/router-dispatch.test.js
// Static source assertions for the route-dispatch loop in
// server/router.js — the two CodeQL fixes from the webui-rigor-fix
// batch (S2 cluster):
//
//   1. js/regex-injection (router.js:437): `route.match(pathname)` is
//      name-modeled by CodeQL as String.prototype.match(pattern) with
//      the tainted pathname in the pattern slot. In reality every
//      ROUTES matcher is a static predicate (=== / startsWith /
//      includes / one precompiled regex literal .test(p)); pathname is
//      only ever the *subject*. The fix calls the predicate through a
//      hoisted local, which removes the name-based sink without
//      touching any matcher.
//   2. js/tainted-format-string (router.js:444): the router's error
//      log used a template literal that mixes the tainted pathname
//      into the format string; it now uses printf placeholders in a
//      constant string with the tainted values in argument position.
//
// Style follows test/router-cors.test.js: read the source and assert
// mechanically. No server is spawned; we assert on the code shape so a
// regression (someone inlining `route.match(pathname)` back, or
// re-interpolating the error log) fails the suite.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const routerPath = join(__dirname, "..", "server", "router.js");
const routerSource = readFileSync(routerPath, "utf8");

describe("router — dispatch loop shape (CodeQL rigor fixes)", () => {
  test("no `.match(pathname)` property call with tainted pathname", () => {
    assert.doesNotMatch(
      routerSource,
      /\.match\(\s*pathname\s*\)/,
      "the dispatch loop must not call `route.match(pathname)` — CodeQL models any `.match(x)` call as a regex sink with x in the pattern slot",
    );
  });

  test("dispatch calls the route predicate through a hoisted local", () => {
    assert.match(
      routerSource,
      /const\s+matchesPath\s*=\s*route\.match\s*;\s*\n\s*if\s*\(\s*!matchesPath\(pathname\)\s*\)\s*continue;/,
      "dispatch loop should hoist `route.match` into a local and call it with pathname as the subject only",
    );
  });

  test("error log uses printf placeholders in a constant format string", () => {
    assert.match(
      routerSource,
      /console\.error\(\s*"\[router\] %s %s threw:",\s*req\.method,\s*pathname,\s*e\s*\)/,
      "router error log must keep the format string constant and pass req.method/pathname/e as arguments",
    );
    assert.doesNotMatch(
      routerSource,
      /console\.error\(\s*`\[router\][^`]*\$\{/,
      "router error log must not interpolate tainted values into a template-literal format string",
    );
  });
});

describe("router — matcher table semantics unchanged", () => {
  // These pins guard the "no semantic change" claim of the dispatch fix:
  // the matcher bodies themselves stay in their literal forms, which is
  // also what scripts/check-docs-alignment.mjs pathMatches() resolves
  // against (literal substring + `p.startsWith("prefix/"` guards).
  test("exact-match literals survive (representative sample)", () => {
    assert.match(routerSource, /p === "\/api\/health"/);
    assert.match(routerSource, /p === "\/api\/sessions\/search"/);
    assert.match(routerSource, /p === "\/api\/auth\/decision"/);
    assert.match(routerSource, /p === "\/api\/protocol\/capabilities"/);
  });

  test("prefix matcher survives (DELETE /api/sessions/:id catch-all)", () => {
    assert.match(
      routerSource,
      /p\.startsWith\("\/api\/sessions\/"\) && p\.length > "\/api\/sessions\/"\.length/,
    );
  });

  test("the one precompiled regex matcher survives as a static literal", () => {
    assert.match(
      routerSource,
      /\/\^\\\/api\\\/sessions\\\/\[\^\\\/\]\+\\\/export\$\/\.test\(p\)/,
      "export route must keep its precompiled regex literal (pathname stays the .test subject)",
    );
  });
});
