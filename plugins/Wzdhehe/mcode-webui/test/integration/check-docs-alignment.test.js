// webui/test/integration/check-docs-alignment.test.js
// D02 lease: integration verification for scripts/check-docs-alignment.mjs
// (the B05 / §AP11 gate).
//
// This file is a complement to test/check-docs-alignment.test.js (which
// exercises the script's pathMatches helper in isolation). Here we run
// the LIVE script against the real repo and assert the drift count + the
// specific drifts that the v2 refactor expects to be present:
//
//   - §AP11 cleanup-orphans drift IS present (B03 added the handler in
//     lib/authorize.js but did not wire it into server/router.js —
//     this is the registered known blocker for the D batch).
//   - 4× SECURITY-NOTES env vars drift IS present (B05 reconcile is
//     the owner).
//   - Total drift = 6 lines (1 cleanup-orphans × 2 occurrences in
//     [3/6] and [6/6], plus 4 env vars in [4/6]).
//
// Note on the brief's "≤ 5 after C05 §7 status line fix":
//   C05's docs/CAPABILITIES.md §7 ⚠→✅ status change is recorded in
//   C05-TASK.DRAFT.md §Changes made, but the check script's check
//   [1/6] was already green BEFORE C05 (it asserts capabilities appear
//   in both docs — status emoji is not in scope). The drift count is
//   unaffected by C05's status change. We assert the actual count
//   (6) here and let the verifier reconcile the brief.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SCRIPT_PATH = join(ROOT, "scripts", "check-docs-alignment.mjs");

// runCheckScript — invoke scripts/check-docs-alignment.mjs and parse
// the FAIL line. Returns { status, stdout, stderr, mismatchCount }.
// Strips ANSI escape codes first — the script colors its output
// (TAG.red/green from scripts/check-docs-alignment.mjs) which would
// break naïve regex matching.
function runCheckScript() {
    const res = spawnSync(process.execPath, [SCRIPT_PATH], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 30_000,
    });
    const rawStdout = res.stdout || "";
    // Strip ANSI: ESC '[' ... 'm'.
    const stripped = rawStdout.replace(/\x1b\[[0-9;]*m/g, "");
    let mismatchCount = 0;
    // The script's summary line is either:
    //   - "FAIL N check group(s) reported mismatches." where N is the number
    //     of individual `check()` calls that failed (NOT the number of check
    //     groups — the label is misleading, see scripts/check-docs-alignment.mjs
    //     line 412). This is the exit-1 path (drift present).
    //   - "OK all checks passed." for the exit-0 path (no drift).
    // v2.0 (reconcile §6): after §AP11 + 4× env vars were resolved the script
    // exits 0 with "OK" — mismatchCount must default to 0, not -1.
    const failMatch = stripped.match(/FAIL\s+(\d+)\s+check group/);
    if (failMatch) mismatchCount = Number(failMatch[1]);
    return {
        status: res.status,
        stdout: rawStdout,
        stdoutStripped: stripped,
        stderr: res.stderr || "",
        mismatchCount,
    };
}

describe("check-docs-alignment: live integration (B05 gate)", () => {
    test("script exits with code 0 (no drift, post-reconcile §6)", () => {
        const r = runCheckScript();
        // Post-reconcile §6.1 + §6.2 (2026-09-20): all known drift resolved
        // (§AP11 cleanup-orphans wired + 4× SECURITY-NOTES env vars exported).
        // Exit 0 is the documented happy-path: script ran, no drift surfaced.
        assert.equal(
            r.status,
            0,
            `expected exit 0 (no drift, post-reconcile), got ${r.status}.\n` +
            `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );
    });

    test("drift count is 0 (post-reconcile §6.1 + §6.2)", () => {
        const r = runCheckScript();
        // v2.0 reconcile §6 (2026-09-20, post-VERIFICATION-REPORT.md):
        //   - §AP11 cleanup-orphans route wired in router.js (reconcile §6.1)
        //   - 4× SECURITY-NOTES env vars exported in config.js (reconcile §6.2)
        // Pre-reconcile: 6 ✗ (D02 worker baseline 2026-09-20)
        // Post-reconcile: 0 ✗
        assert.ok(
            r.mismatchCount >= 0,
            `could not parse drift count from output: ${r.stdoutStripped.slice(0, 400)}`,
        );
        assert.equal(
            r.status,
            0,
            `expected exit 0 (no drift, post-reconcile §6), got ${r.status}.\n` +
            `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );
        assert.equal(
            r.mismatchCount,
            0,
            `drift count should be 0 post-reconcile, got ${r.mismatchCount}.\n` +
            `stdout: ${r.stdoutStripped.slice(0, 800)}`,
        );
    });

    test("§AP11 cleanup-orphans drift is reconciled (no longer present)", () => {
        const r = runCheckScript();
        // reconcile §6.1 wired handleCleanupOrphans → POST /api/sessions/cleanup-orphans.
        // docs/API.md and server/router.js now agree, so §AP11 drift gone.
        const combined = r.stdoutStripped + r.stderr;
        assert.ok(
            !/Either delete the docs\/API\.md entry or add the route/.test(combined),
            `§AP11 fix hint should NOT appear after reconcile §6.1. ` +
            `combined: ${combined.slice(0, 800)}`,
        );
    });

    test("§4 SECURITY-NOTES env vars drift is reconciled (no longer present)", () => {
        const r = runCheckScript();
        // reconcile §6.2 exported 4 env vars (MCODE_WEBUI_UPLOAD_DIR /
        // MCODE_WEBUI_SETTINGS_PATH / MCODE_BETTER_SQLITE3 / DEBUG_INJECT)
        // in server/lib/config.js. All SECURITY-NOTES env vars now have
        // export const counterparts.
        const combined = r.stdoutStripped + r.stderr;
        assert.ok(
            !/has no `export const/.test(combined),
            `§4 missing-export-const message should NOT appear after reconcile §6.2. ` +
            `combined: ${combined.slice(0, 1200)}`,
        );
    });

    test("drift count breakdown matches script output line-by-line", () => {
        const r = runCheckScript();
        // Count ✗ markers in stdout (after stripping ANSI). Each ✗ line
        // corresponds to one drift (per scripts/check-docs-alignment.mjs
        // line 87).
        const xLines = (r.stdoutStripped.match(/^\s*✗\s/gm) || []).length;
        assert.equal(
            xLines,
            r.mismatchCount,
            `mismatchCount (${r.mismatchCount}) should equal ` +
            `the number of ✗ lines (${xLines}) in stdout`,
        );
    });

    test("script input files exist and are non-empty", () => {
        // Belt-and-braces: the script reads plugin.json, README.md,
        // docs/API.md, docs/CAPABILITIES.md, references/SECURITY-NOTES.md,
        // server/router.js, server/lib/config.js. Each MUST exist.
        const inputs = [
            "plugin.json",
            "README.md",
            "docs/API.md",
            "docs/CAPABILITIES.md",
            "references/SECURITY-NOTES.md",
            "server/router.js",
            "server/lib/config.js",
        ];
        for (const rel of inputs) {
            const body = readFileSync(join(ROOT, rel), "utf8");
            assert.ok(
                body.length > 0,
                `${rel} should be non-empty (script reads it at startup)`,
            );
        }
    });
});

// -----------------------------------------------------------------------
// Drift inventory: a structured summary of the current drift so the
// verifier can quote it directly in VERIFICATION-REPORT.md. The exact
// count must match the FAIL line above; if not, the check output
// itself changed and the report should be regenerated.
// -----------------------------------------------------------------------
describe("check-docs-alignment: drift inventory (verifier hand-off)", () => {
    test("no drift lines reported (post-reconcile §6)", () => {
        const r = runCheckScript();
        // Post-reconcile §6 (2026-09-20): all known drift resolved. The
        // check script should print NO FAIL line and NO ✗ markers — the
        // happy-path "OK all checks passed." is the only summary.
        const failMatch = r.stdoutStripped.match(/FAIL\s+(\d+)\s+check group/);
        assert.equal(
            failMatch,
            null,
            `expected NO FAIL line after reconcile §6, got: ${failMatch ? failMatch[0] : "(absent)"}`,
        );
        const xLines = (r.stdoutStripped.match(/^\s*✗\s/gm) || []).length;
        assert.equal(
            xLines,
            0,
            `expected NO ✗ lines after reconcile §6, got ${xLines}`,
        );
        // Sanity: the happy-path summary is present.
        assert.match(
            r.stdoutStripped,
            /OK\s+all checks passed/,
            `expected "OK all checks passed" after reconcile §6, ` +
            `got stdout: ${r.stdoutStripped.slice(0, 600)}`,
        );
    });
});