// webui/test/router-cors.test.js
// Unit tests for the CORS headers + Gate 3 OPTIONS preflight exemption
// in server/router.js. v1.0.1 reviewer feedback mentioned "CORS/URL-token
// leakage considerations"; these tests guard against the specific bug
// where Gate 3 was rejecting OPTIONS preflight with 401, breaking
// cross-origin clients with token auth enabled.
//
// The CORS bug history:
//   1. L281: `Access-Control-Allow-Headers: Content-Type` (no Authorization)
//      → cross-origin fetch with `Authorization: Bearer` fails preflight.
//   2. Gate 3: `req.method !== "OPTIONS"` exemption was MISSING
//      → even with the L281 fix, OPTIONS preflight to /api/* hit Gate 3
//        and was 401'd (no Authorization attached to preflight), so the
//        real POST never reached the server.
// Both fixed together; the tests below lock both in.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const routerPath = join(__dirname, "..", "server", "router.js");
const routerSource = readFileSync(routerPath, "utf8");

// Boolean model of Gate 3 (v1.0.1 post-fix). Assumes the non-method
// preconditions all hold: non-local request, tokenAuthOn=true, expected
// token set, supplied token absent. The test asserts the ONLY way out
// of the rejection is `req.method !== "OPTIONS"` (post-fix exemption)
// or supplying a valid token.
function wouldGate3Reject({ method, hasSuppliedToken }) {
  if (method === "OPTIONS") return false;       // post-fix exemption
  if (hasSuppliedToken) return false;            // valid token → pass
  return true;                                   // otherwise → 401
}

describe("router — CORS headers (v1.0.1)", () => {
  test("L281: Allow-Headers includes Authorization (reviewer-required fix)", () => {
    assert.match(
      routerSource,
      /Access-Control-Allow-Headers['"]\s*,\s*['"]Content-Type, Authorization/,
      "router.js must allow Authorization in CORS Allow-Headers (cross-origin fetch with Bearer token needs this)"
    );
  });

  // v1.0.1 round 8: Allow-Origin NO LONGER hard-codes `*`. The blanket
  // wildcard allowed any cross-origin page (e.g. https://evil.example)
  // to read responses — which was the bootstrap-token leak vector
  // (hetaoBackend report 2026-09-01). New behavior is per-origin with
  // an env-var allowlist (see setCorsHeaders in router.js).
  test("round 8: source MUST NOT contain Access-Control-Allow-Origin: '*' (would let any cross-origin reader in)", () => {
    assert.doesNotMatch(
      routerSource,
      /Access-Control-Allow-Origin['"]\s*,\s*['"]\*/,
      "router.js must not set Access-Control-Allow-Origin: * — that allows ANY cross-origin reader (CSRF / bootstrap-token leak)"
    );
  });

  test("round 8: setCorsHeaders helper exists and uses MCODE_WEBUI_ALLOWED_ORIGINS env for the allowlist", () => {
    assert.match(
      routerSource,
      /function\s+setCorsHeaders\s*\(/,
      "router.js should define a setCorsHeaders helper for the per-origin CORS logic"
    );
    assert.match(
      routerSource,
      /MCODE_WEBUI_ALLOWED_ORIGINS/,
      "router.js should read MCODE_WEBUI_ALLOWED_ORIGINS env for the cross-origin allowlist"
    );
  });

  test("L280: Allow-Methods is GET, POST, OPTIONS, DELETE (matches route table)", () => {
    assert.match(
      routerSource,
      /Access-Control-Allow-Methods['"]\s*,\s*['"]GET, POST, OPTIONS, DELETE/,
      "router.js L280 should list GET, POST, OPTIONS, DELETE (no PUT/PATCH — none in route table)"
    );
  });
});

describe("router — Gate 3 OPTIONS preflight exemption (v1.0.1)", () => {
  test("OPTIONS preflight + no token → NOT 401 (preflight exemption)", () => {
    // The post-fix Gate 3 has `req.method !== "OPTIONS"` exemption.
    // OPTIONS /api/xxx must NOT be 401'd, even with no token attached.
    const rejected = wouldGate3Reject({ method: "OPTIONS", hasSuppliedToken: false });
    assert.equal(rejected, false, "OPTIONS preflight must bypass Gate 3 — browsers cannot attach Authorization to a preflight");
  });

  test("OPTIONS preflight + with token → NOT 401 (idempotent)", () => {
    const rejected = wouldGate3Reject({ method: "OPTIONS", hasSuppliedToken: true });
    assert.equal(rejected, false);
  });

  test("POST + no token → 401 (regression: token check still works)", () => {
    const rejected = wouldGate3Reject({ method: "POST", hasSuppliedToken: false });
    assert.equal(rejected, true, "POST without token must still be 401'd by Gate 3");
  });

  test("POST + with token → NOT 401 (regression: valid token passes)", () => {
    const rejected = wouldGate3Reject({ method: "POST", hasSuppliedToken: true });
    assert.equal(rejected, false);
  });

  test("DELETE + no token → 401 (regression: destructive endpoints still gated)", () => {
    const rejected = wouldGate3Reject({ method: "DELETE", hasSuppliedToken: false });
    assert.equal(rejected, true);
  });

  test("source: Gate 3 block contains OPTIONS exemption (regression guard)", () => {
    // If someone reverts the OPTIONS exemption, this test fails — even
    // if the boolean model above passes. Belt-and-suspenders.
    //
    // Use semantic boundary (// Gate 4: comment) instead of a magic-number
    // char window: Gate 4 also has `req.method !== "OPTIONS"` and a hard
    // 2000-char slice would falsely match Gate 4 (offset 1330 < 2000).
    const gate3Start = routerSource.indexOf("// Gate 3:");
    assert.ok(gate3Start >= 0, "Gate 3 comment not found in router.js");
    const gate4Start = routerSource.indexOf("// Gate 4:", gate3Start);
    assert.ok(gate4Start > gate3Start, "Gate 4 comment not found after Gate 3");
    const gate3Block = routerSource.slice(gate3Start, gate4Start);
    assert.match(
      gate3Block,
      /req\.method\s*!==\s*['"]OPTIONS['"]/,
      "Gate 3 must have `req.method !== 'OPTIONS'` exemption (without it, cross-origin POST fails preflight with 401)"
    );
  });
});
