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

describe("router — CORS headers (v2 trusted-origin policy, PR #55 review point 1)", () => {
  test("L281: Allow-Headers includes Authorization (reviewer-required fix)", () => {
    assert.match(
      routerSource,
      /Access-Control-Allow-Headers['"]\s*,\s*['"]Content-Type, Authorization/,
      "router.js must allow Authorization in CORS Allow-Headers (cross-origin fetch with Bearer token needs this)"
    );
  });

  test("no wildcard Allow-Origin anywhere (v2: wildcard × local-bypass hole is closed)", () => {
    assert.doesNotMatch(
      routerSource,
      /Access-Control-Allow-Origin['"]\s*,\s*['"]\*/,
      "router.js must NOT send Access-Control-Allow-Origin: * — combined with the local-request token bypass any web page could read API responses by targeting 127.0.0.1 (PR #55 review point 1)"
    );
  });

  test("Allow-Origin is reflected from the request Origin, gated on trust", () => {
    assert.match(
      routerSource,
      /originTrusted[\s\S]*?setHeader\(['"]Access-Control-Allow-Origin['"],\s*originHeader\)/,
      "CORS Allow-Origin must reflect the (normalized) request Origin verbatim and only inside the trusted branch"
    );
    assert.match(
      routerSource,
      /const originTrusted = originHeader !== ['"]['"] && trustedOrigins\.has\(originHeader\);/,
      "trust decision must be set membership of the normalized Origin header"
    );
  });

  test("responses key caches on Origin (Vary: Origin)", () => {
    assert.match(
      routerSource,
      /setHeader\(['"]Vary['"],\s*['"]Origin['"]\)/,
      "responses must carry Vary: Origin — the CORS surface varies by request Origin whether or not ACAO is reflected"
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

describe("router — Gate 1b Origin/CSRF gate (v2, PR #55 review point 1)", () => {
  test("mutating request with untrusted Origin is 403'd before other gates", () => {
    // The gate must fire on method alone (not path), BEFORE the LAN /
    // token / read-only gates, and must NOT be exempted by locality.
    assert.match(
      routerSource,
      /originHeader !== ['"]['"] &&\s*\n?\s*!originTrusted &&/,
      "Gate 1b must reject any mutating request whose Origin is present but untrusted"
    );
    // The gate block sits before Gate 2 (LAN reject).
    const gate1b = routerSource.indexOf("Gate 1b:");
    const gate2 = routerSource.indexOf("// Gate 2:");
    assert.ok(gate1b >= 0, "Gate 1b comment not found in router.js");
    assert.ok(gate2 > gate1b, "Gate 1b must run before Gate 2 (LAN reject)");
    // Slice only the gate block itself (up to the first statement after
    // it) — the later `local = isLocalRequest(req)` line belongs to the
    // gates that legitimately consult locality.
    const gateEnd = routerSource.indexOf("const pathname", gate1b);
    assert.ok(gateEnd > gate1b, "Gate 1b block boundary not found");
    const block = routerSource.slice(gate1b, gateEnd);
    assert.match(block, /cross-origin request rejected/, "Gate 1b answers 403 with a JSON error body");
    assert.doesNotMatch(
      block,
      /isLocalRequest/,
      "Gate 1b must not consult socket locality — the loopback token bypass must never double as a browser cross-origin exemption"
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
