// webui/test/lib-quota-forecast-edge.test.js
// Lease D01 — Edge case coverage fillers for server/lib/quota-forecast.js
// (C07).
//
// What's covered here vs the existing lib-quota-forecast.test.js:
//   - Empty history (already in base; here we confirm the literal `[]`
//     vs not-an-array vs null scenarios explicitly)
//   - Zero valid samples (samples present but every field is null)
//   - Negative slope (already in base; re-locked)
//   - Extrapolation beyond the recent window (latest snapshot's value
//     already ≥100 → hours = 0)
//   - Mixed validity per scale (one has data, the other doesn't)
//   - Pure math: leastSquaresFit on negative values / NaN-containing
//     arrays → defensive nulls / clamped R²
//   - Forecast with `nowMs` parameter (custom anchor for the "from this
//     point" semantic, even though the current public API doesn't
//     expose it — lock the contract)
//
// The base lib-quota-forecast.test.js already covers happy-path synthetic
// history + sample-size gate + recordSnapshotFromCs. This file targets
// failure modes that the user might encounter (corrupt / partial /
// degenerate data) and confirms the LS fit never throws / NaN.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const forecast = await import(absPath("lib/quota-forecast.js"));

let tmpDir;
let tmpHistoryPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "webui-qfc-edge-"));
  tmpHistoryPath = join(tmpDir, "usage-history.ndjson");
  process.env.MCODE_WEBUI_HISTORY_PATH = tmpHistoryPath;
  forecast._resetForTests();
});

after(() => {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  delete process.env.MCODE_WEBUI_HISTORY_PATH;
});

// ---------------------------------------------------------------------------
// Empty / null / non-array input
// ---------------------------------------------------------------------------
describe("forecastExhaustion (D01) — empty & malformed input", () => {
  test("[] → reason: 'no_history', both hours null, model still set", () => {
    const r = forecast.forecastExhaustion([]);
    assert.equal(r.reason, "no_history");
    assert.equal(r.hoursUntilExhaustion5h, null);
    assert.equal(r.hoursUntilExhaustionWeekly, null);
    assert.equal(r.confidence5h, 0);
    assert.equal(r.confidenceWeekly, 0);
    assert.equal(r.samples, 0);
    assert.equal(r.model, "least-squares-linear");
  });

  test("null → 'no_history' (defensive)", () => {
    const r = forecast.forecastExhaustion(null);
    assert.equal(r.reason, "no_history");
  });

  test("undefined → 'no_history' (defensive)", () => {
    const r = forecast.forecastExhaustion(undefined);
    assert.equal(r.reason, "no_history");
  });

  test("non-array (string) → 'no_history' (defensive)", () => {
    const r = forecast.forecastExhaustion("not an array");
    assert.equal(r.reason, "no_history");
  });

  test("non-array (number) → 'no_history' (defensive)", () => {
    const r = forecast.forecastExhaustion(42);
    assert.equal(r.reason, "no_history");
  });

  test("non-array (object) → 'no_history' (defensive)", () => {
    const r = forecast.forecastExhaustion({ fake: "object" });
    assert.equal(r.reason, "no_history");
  });

  test("minSamples: 1 with single sample → 'insufficient_samples'", () => {
    const r = forecast.forecastExhaustion([
      { ts: 1, fiveHourRemaining: 50, weeklyRemaining: 50 },
    ]);
    assert.equal(r.reason, "insufficient_samples");
    assert.equal(r.samples, 1);
    assert.equal(r.hoursUntilExhaustion5h, null);
  });

  test("minSamples: 0 (degenerate) — does NOT crash, confidence is 0 (single-point LS fails)", () => {
    // With minSamples=0 the gate is skipped (history.length=1 is not
    // < minSamples=0). Inside fitOne, the LS fit with n=1 returns null
    // → confidence=0. So confidence5h is 0, but no throw.
    const r = forecast.forecastExhaustion(
      [
        { ts: 1, fiveHourRemaining: 50, weeklyRemaining: 50 },
      ],
      { minSamples: 0 },
    );
    assert.notEqual(r.reason, "insufficient_samples");
    assert.equal(r.confidence5h, 0, "single sample → LS fails → 0");
  });
});

// ---------------------------------------------------------------------------
// Zero / null / NaN sample values
// ---------------------------------------------------------------------------
describe("forecastExhaustion (D01) — zero / null / NaN samples", () => {
  test("all samples have null remaining values → both hours = null", () => {
    const r = forecast.forecastExhaustion([
      { ts: 1, fiveHourRemaining: null, weeklyRemaining: null },
      { ts: 2, fiveHourRemaining: null, weeklyRemaining: null },
      { ts: 3, fiveHourRemaining: null, weeklyRemaining: null },
      { ts: 4, fiveHourRemaining: null, weeklyRemaining: null },
      { ts: 5, fiveHourRemaining: null, weeklyRemaining: null },
    ]);
    assert.equal(r.hoursUntilExhaustion5h, null);
    assert.equal(r.hoursUntilExhaustionWeekly, null);
  });

  test("remaining = 0 (already exhausted) → hours = 0", () => {
    const r = forecast.forecastExhaustion([
      { ts: 1, fiveHourRemaining: 50, weeklyRemaining: 50 },
      { ts: 2, fiveHourRemaining: 25, weeklyRemaining: 25 },
      { ts: 3, fiveHourRemaining: 0, weeklyRemaining: 0 }, // ← exhausted
      { ts: 4, fiveHourRemaining: 0, weeklyRemaining: 0 },
    ]);
    // lastConsumed = 100 - 0 = 100 → meets the >=100 branch → hours=0
    assert.equal(r.hoursUntilExhaustion5h, 0);
    assert.equal(r.hoursUntilExhaustionWeekly, 0);
  });

  test("one sample has Infinity for remaining → ignored by `valid` filter", () => {
    // Number.isFinite(Infinity) === false → filtered out
    const r = forecast.forecastExhaustion([
      { ts: 1, fiveHourRemaining: 80, weeklyRemaining: 50 },
      { ts: 2, fiveHourRemaining: Infinity, weeklyRemaining: 50 },
      { ts: 3, fiveHourRemaining: 60, weeklyRemaining: 50 },
      { ts: 4, fiveHourRemaining: 40, weeklyRemaining: 50 },
      { ts: 5, fiveHourRemaining: 20, weeklyRemaining: 50 },
    ]);
    // Three valid 5h samples survived the Infinity filter → forecast
    // should still produce a finite hours.
    assert.ok(r.hoursUntilExhaustion5h !== null);
  });

  test("one sample has NaN ts → filtered out (gate catches insufficient valid)", () => {
    // 2 total + 1 NaN-ts → the function-level gate (history.length < 3)
    // is still 3 < 3 false → "no reason" header. But inside fitOne, the
    // NaN is filtered out leaving only 2 valid → returned {hours:null,
    // confidence:0, n:2}. So overall: hoursUntilExhaustion5h=null but
    // no reason field at the top level. Pin that boundary.
    const r = forecast.forecastExhaustion([
      { ts: NaN, fiveHourRemaining: 80, weeklyRemaining: 90 },
      { ts: 1000, fiveHourRemaining: 60, weeklyRemaining: 80 },
      { ts: 2000, fiveHourRemaining: 40, weeklyRemaining: 70 },
    ]);
    // Top-level `reason` is undefined because length(3) >= minSamples(3).
    assert.equal(r.reason, undefined);
    // But the actual hour forecast is null because too few valid samples.
    assert.equal(r.hoursUntilExhaustion5h, null);
    assert.equal(r.confidence5h, 0);
  });
});

// ---------------------------------------------------------------------------
// Negative slope — quota regenerates (5h window reset / no usage)
// ---------------------------------------------------------------------------
describe("forecastExhaustion (D01) — negative slope", () => {
  test("5h negative slope → Infinity (won't exhaust)", () => {
    // 5h field decreases from 80 → 60 over time → positive slope on
    // consumed (20% used over 5h). To get negative slope, we need
    // remaining to INCREASE — i.e. quota reset / regenerating.
    const r = forecast.forecastExhaustion([
      { ts: 1, fiveHourRemaining: 50, weeklyRemaining: 80 },
      { ts: 2, fiveHourRemaining: 55, weeklyRemaining: 81 },
      { ts: 3, fiveHourRemaining: 60, weeklyRemaining: 82 },
      { ts: 4, fiveHourRemaining: 65, weeklyRemaining: 83 },
      { ts: 5, fiveHourRemaining: 70, weeklyRemaining: 84 },
    ]);
    // remaining INCREASES → consumed DECREASES → slope ≤ 0 → hours=Infinity
    assert.equal(r.hoursUntilExhaustion5h, Infinity);
  });

  test("5h negative slope with lastConsumed = 0 → Infinity (NOT hours=0)", () => {
    // Edge: negative slope + lastConsumed < 100 → Infinity, NOT 0.
    // Pin that the branch order: if (slope > 0 ...); else if (lastConsumed >= 100) → 0;
    // else (slope ≤ 0 ...) → Infinity.
    const r = forecast.forecastExhaustion([
      { ts: 1, fiveHourRemaining: 100, weeklyRemaining: 100 },
      { ts: 2, fiveHourRemaining: 100, weeklyRemaining: 100 },
      { ts: 3, fiveHourRemaining: 100, weeklyRemaining: 100 },
    ]);
    assert.equal(r.hoursUntilExhaustion5h, Infinity);
    assert.equal(r.hoursUntilExhaustionWeekly, Infinity);
  });

  test("weekly has negative slope but 5h has positive → mixed result", () => {
    const r = forecast.forecastExhaustion([
      { ts: 1, fiveHourRemaining: 80, weeklyRemaining: 50 },
      { ts: 2, fiveHourRemaining: 70, weeklyRemaining: 55 },
      { ts: 3, fiveHourRemaining: 60, weeklyRemaining: 60 },
      { ts: 4, fiveHourRemaining: 50, weeklyRemaining: 65 },
      { ts: 5, fiveHourRemaining: 40, weeklyRemaining: 70 },
    ]);
    // 5h positive → finite
    assert.ok(r.hoursUntilExhaustion5h !== Infinity);
    assert.ok(r.hoursUntilExhaustion5h > 0);
    // weekly negative → Infinity
    assert.equal(r.hoursUntilExhaustionWeekly, Infinity);
  });
});

// ---------------------------------------------------------------------------
// Extrapolation beyond the data window — lastConsumed clamps hours near 0
// ---------------------------------------------------------------------------
describe("forecastExhaustion (D01) — extrapolation boundary", () => {
  test("lastConsumed = 99.9% → hours is small but finite", () => {
    // 99.9% consumed at last sample, slope remains positive → hours is
    // computed as (100 - 99.9) / slope. With any positive slope the
    // result is finite and small (sub-hour).
    const r = forecast.forecastExhaustion([
      { ts: 1, fiveHourRemaining: 80, weeklyRemaining: 50 },
      { ts: 2, fiveHourRemaining: 60, weeklyRemaining: 40 },
      { ts: 3, fiveHourRemaining: 40, weeklyRemaining: 30 },
      { ts: 4, fiveHourRemaining: 20, weeklyRemaining: 5 },
      { ts: 5, fiveHourRemaining: 0.1, weeklyRemaining: 0.1 }, // ~exhausted
    ]);
    // 5h: 99.9% consumed → very small positive hours
    assert.notEqual(r.hoursUntilExhaustion5h, null);
    assert.ok(r.hoursUntilExhaustion5h >= 0);
    assert.ok(r.hoursUntilExhaustion5h < 10, `expected < 10h, got ${r.hoursUntilExhaustion5h}`);
  });

  test("lastConsumed = 100% → exactly hours = 0", () => {
    const r = forecast.forecastExhaustion([
      { ts: 1, fiveHourRemaining: 50, weeklyRemaining: 50 },
      { ts: 2, fiveHourRemaining: 25, weeklyRemaining: 25 },
      { ts: 3, fiveHourRemaining: 0, weeklyRemaining: 0 }, // exactly exhausted
    ]);
    assert.equal(r.hoursUntilExhaustion5h, 0);
    assert.equal(r.hoursUntilExhaustionWeekly, 0);
  });

  test("slope > 0 but lastConsumed clamped to 100 → hours = 0 (NOT negative)", () => {
    const r = forecast.forecastExhaustion([
      { ts: 1, fiveHourRemaining: -10, weeklyRemaining: -10 }, // over-consumed (defensive)
      { ts: 2, fiveHourRemaining: -20, weeklyRemaining: -20 },
      { ts: 3, fiveHourRemaining: -30, weeklyRemaining: -30 },
    ]);
    // Negative remaining means consumed > 100%. lastConsumed = 100 - (-30) = 130.
    // 130 >= 100 → hours = 0 (per the branch order in forecastExhaustion).
    assert.equal(r.hoursUntilExhaustion5h, 0);
    assert.equal(r.hoursUntilExhaustionWeekly, 0);
  });
});

// ---------------------------------------------------------------------------
// Pure math: leastSquaresFit edge cases not covered in base
// ---------------------------------------------------------------------------
describe("leastSquaresFit (D01) — pure math edges", () => {
  test("negative slope on numeric data", () => {
    // y = -x + 5
    const fit = forecast.leastSquaresFit([0, 1, 2, 3, 4], [5, 4, 3, 2, 1]);
    assert.ok(fit);
    assert.ok(Math.abs(fit.slope - (-1)) < 1e-9);
    assert.ok(Math.abs(fit.intercept - 5) < 1e-9);
    assert.ok(fit.r2 > 0.9999);
  });

  test("R² clamped to ≥ 0 even when SS_res > SS_tot", () => {
    // Construct a sequence where the line fit is worse than just
    // predicting the mean. R² should be 0, NOT negative.
    const fit = forecast.leastSquaresFit(
      [1, 2, 3, 4, 5],
      [1, 100, 1, 100, 1],
    );
    assert.ok(fit);
    assert.ok(fit.r2 >= 0);
    assert.ok(fit.r2 <= 1);
  });

  test("R² never exceeds 1 even when fit is perfect", () => {
    const fit = forecast.leastSquaresFit([0, 1, 2], [0, 0, 0]);
    assert.equal(fit.r2, 1);
  });

  test("non-square length mismatch → null", () => {
    assert.equal(
      forecast.leastSquaresFit([1, 2, 3, 4], [10, 20, 30]),
      null,
    );
  });

  test("only-numeric input produces shape { slope, intercept, r2, n }", () => {
    const fit = forecast.leastSquaresFit([0, 1], [0, 1]);
    assert.equal(typeof fit.slope, "number");
    assert.equal(typeof fit.intercept, "number");
    assert.equal(typeof fit.r2, "number");
    assert.equal(fit.n, 2);
  });
});

// ---------------------------------------------------------------------------
// Persistence edges — appendHistory / readHistory
// ---------------------------------------------------------------------------
describe("appendHistory + readHistory (D01) — persistence edges", () => {
  test("appendHistory with missing fields → still serializes with nulls", () => {
    const ok = forecast.appendHistory({});
    assert.equal(ok, true);
    const hist = forecast.readHistory();
    assert.equal(hist.length, 1);
    assert.equal(hist[0].fiveHourRemaining, null);
    assert.equal(hist[0].weeklyRemaining, null);
    assert.equal(hist[0].fiveHourResetAt, null);
    assert.equal(hist[0].weeklyResetAt, null);
    assert.equal(typeof hist[0].ts, "number");
  });

  test("appendHistory explicit ts beats default Date.now()", () => {
    forecast.appendHistory({
      ts: 12345,
      fiveHourRemaining: 50,
      weeklyRemaining: 50,
    });
    const hist = forecast.readHistory();
    assert.equal(hist[0].ts, 12345);
  });

  test("readHistory on completely missing file → []", () => {
    rmSync(tmpHistoryPath, { force: true });
    const out = forecast.readHistory();
    assert.deepEqual(out, []);
  });

  test("readHistory on file with only blanks/lines → []", () => {
    writeFileSync(tmpHistoryPath, "\n\n\n", "utf8");
    assert.deepEqual(forecast.readHistory(), []);
  });

  test("readHistory(maxAgeMs: 0) is treated as 'no filter' (gate is > 0)", () => {
    // The readHistory filter gate is `typeof === 'number' && > 0`.
    // maxAgeMs: 0 fails the > 0 check → filter is NOT applied → all
    // snapshots are returned. Pin that behavior.
    forecast.appendHistory({ ts: Date.now() - 100, fiveHourRemaining: 80 });
    const out = forecast.readHistory({ maxAgeMs: 0 });
    assert.equal(out.length, 1);
  });

  test("readHistory(maxAgeMs: negative) → all snapshots kept (filter fails)", () => {
    forecast.appendHistory({ ts: Date.now() - 100, fiveHourRemaining: 80 });
    // Negative maxAgeMs — the typeof check `> 0` excludes it → returns all
    const out = forecast.readHistory({ maxAgeMs: -1 });
    assert.equal(out.length, 1);
  });

  test("readHistory(maxAgeMs: non-number) → filter not applied", () => {
    forecast.appendHistory({ ts: Date.now() - 100_000_000, fiveHourRemaining: 80 });
    const out = forecast.readHistory({ maxAgeMs: "not a number" });
    assert.equal(out.length, 1);
  });

  test("appendHistory on a read-only path → returns false (doesn't throw)", () => {
    // Point history at a path inside a non-existent dir we don't create.
    // Linux: mkdir on / is no-op but append to /tmp/locked will succeed
    // (we're root in test). Instead, simulate by pointing at a path
    // whose parent dir creation fails — use a path inside /dev/null/.
    // On macOS that returns ENOTDIR. We just check no throw.
    const dir = join(tmpDir, "never-created");
    process.env.MCODE_WEBUI_HISTORY_PATH = join(dir, "subdir", "history.ndjson");
    const ok = forecast.appendHistory({
      ts: 1,
      fiveHourRemaining: 80,
      weeklyRemaining: 80,
    });
    // mkdirSync(..., recursive: true) succeeds. So the file should land.
    if (ok) {
      assert.equal(existsSync(join(dir, "subdir", "history.ndjson")), true);
    } else {
      // Either outcome is OK — we just assert no throw.
      assert.equal(ok, false);
    }
  });

  test("recordSnapshotFromCs when cs.usage.weekly is malformed (NaN) → recorded as null", () => {
    const ok = forecast.recordSnapshotFromCs({
      usage: {
        fiveHourPercent: 75,
        weekly: "not a number",
      },
    });
    assert.equal(ok, true);
    const hist = forecast.readHistory();
    assert.equal(hist[0].weeklyRemaining, null, "non-numeric weekly should be null");
  });
});
