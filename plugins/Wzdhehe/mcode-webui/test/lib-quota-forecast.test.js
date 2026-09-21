// webui/test/lib-quota-forecast.test.js
// Unit tests for server/lib/quota-forecast.js — pure LS forecast.
//
// Why this test exists:
//   v2026-09-20 C07 lease — implements CAPABILITIES.md §8
//   "Forecast exhaustion time ❌". The user-facing symptom was that
//   the popover shows current quota but never predicts when it will
//   run out. The fix is a least-squares linear fit on a per-call
//   snapshot history (~/.mcode-webui/usage-history.ndjson).
//
// Test strategy:
//   - quota-forecast.js has zero deps on the rest of webui (it just
//     reads/writes NDJSON + does math). No _setup.js mocks needed.
//   - Override MCODE_WEBUI_HISTORY_PATH per test for hermetic FS.
//   - All math tests are pure (no FS) and run synchronously.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) =>
    pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

let forecast;
let tmpDir;
let tmpHistoryPath;

before(async () => {
    forecast = await import(absPath("lib/quota-forecast.js"));
});

beforeEach(() => {
    // Fresh tmp dir per test → fresh usage-history.ndjson.
    // Override the path BEFORE the module's lazy resolver sees it.
    tmpDir = mkdtempSync(join(tmpdir(), "webui-quota-forecast-test-"));
    tmpHistoryPath = join(tmpDir, "usage-history.ndjson");
    process.env.MCODE_WEBUI_HISTORY_PATH = tmpHistoryPath;
    forecast._resetForTests();
});

after(() => {
    if (tmpDir) {
        try {
            rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
    }
    delete process.env.MCODE_WEBUI_HISTORY_PATH;
});

// Deterministic history generator. Index math + seeded LCG so R²
// assertions are stable across runs (Math.random would flake).
function syntheticHistory(opts = {}) {
    const startTs = opts.startTs ?? Date.now() - 5 * 60 * 60 * 1000;
    const samples = opts.samples ?? 5;
    const stepMs = opts.stepMs ?? 60 * 60 * 1000; // 1h
    const slope5h = opts.slope5h ?? 5;
    const slopeWk = opts.slopeWk ?? 1;
    const startRem5h = opts.startRem5h ?? 80;
    const startRemWk = opts.startRemWk ?? 95;
    const noise = opts.noise ?? 0;
    let seed = opts.seed ?? 42;
    const rand = () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = seed;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const out = [];
    for (let i = 0; i < samples; i++) {
        const h = (i * stepMs) / 3_600_000;
        const j = noise ? (rand() - 0.5) * 2 * noise : 0;
        out.push({
            ts: startTs + i * stepMs,
            fiveHourRemaining: Math.max(
                0,
                Math.min(100, startRem5h - slope5h * h + j),
            ),
            weeklyRemaining: Math.max(
                0,
                Math.min(100, startRemWk - slopeWk * h + j),
            ),
        });
    }
    return out;
}

describe("forecastExhaustion — sample-size gate", () => {
    test("empty array → reason='no_history'", () => {
        const r = forecast.forecastExhaustion([]);
        assert.equal(r.reason, "no_history");
        assert.equal(r.samples, 0);
        assert.equal(r.model, "least-squares-linear");
    });

    test("n < 3 → reason='insufficient_samples'", () => {
        const r = forecast.forecastExhaustion([
            { ts: 1000, fiveHourRemaining: 80, weeklyRemaining: 90 },
            { ts: 2000, fiveHourRemaining: 70, weeklyRemaining: 89 },
        ]);
        assert.equal(r.reason, "insufficient_samples");
        assert.equal(r.samples, 2);
        assert.equal(r.hoursUntilExhaustion5h, null);
    });

    test("custom minSamples is honored", () => {
        const r = forecast.forecastExhaustion(
            [
                { ts: 1000, fiveHourRemaining: 80, weeklyRemaining: 90 },
                { ts: 2000, fiveHourRemaining: 75, weeklyRemaining: 89 },
                { ts: 3000, fiveHourRemaining: 70, weeklyRemaining: 88 },
            ],
            { minSamples: 10 },
        );
        assert.equal(r.reason, "insufficient_samples");
    });
});

describe("forecastExhaustion — physics (slope → hours)", () => {
    test("positive slope → finite positive hours", () => {
        // 5%/h over 5h starting from 80% → 55% remaining at last
        // sample → 11h to 0%. Allow ±2h tolerance for LS jitter.
        const hist = syntheticHistory({
            samples: 5, slope5h: 5, slopeWk: 1,
            startRem5h: 80, startRemWk: 95,
        });
        const r = forecast.forecastExhaustion(hist);
        assert.ok(r.hoursUntilExhaustion5h !== null);
        assert.ok(
            r.hoursUntilExhaustion5h > 9 && r.hoursUntilExhaustion5h < 13,
            `expected ~11h, got ${r.hoursUntilExhaustion5h}`,
        );
    });

    test("negative slope → hours = Infinity (won't exhaust)", () => {
        const hist = syntheticHistory({
            samples: 5, slope5h: -5, slopeWk: -1,
            startRem5h: 50, startRemWk: 80,
        });
        const r = forecast.forecastExhaustion(hist);
        assert.equal(r.hoursUntilExhaustion5h, Infinity);
        assert.equal(r.hoursUntilExhaustionWeekly, Infinity);
    });

    test("already exhausted → hours = 0", () => {
        const hist = syntheticHistory({
            samples: 5, slope5h: 50, slopeWk: 50,
            startRem5h: 100, startRemWk: 100,
        });
        const r = forecast.forecastExhaustion(hist);
        assert.equal(r.hoursUntilExhaustion5h, 0);
        assert.equal(r.hoursUntilExhaustionWeekly, 0);
    });

    test("null values within a scale → that scale returns null", () => {
        const hist = [
            { ts: 1000, fiveHourRemaining: 80, weeklyRemaining: null },
            { ts: 2000, fiveHourRemaining: null, weeklyRemaining: null },
            { ts: 3000, fiveHourRemaining: 70, weeklyRemaining: 90 },
            { ts: 4000, fiveHourRemaining: 60, weeklyRemaining: null },
            { ts: 5000, fiveHourRemaining: 50, weeklyRemaining: 88 },
        ];
        const r = forecast.forecastExhaustion(hist);
        assert.ok(r.hoursUntilExhaustion5h !== null);
        assert.equal(r.hoursUntilExhaustionWeekly, null);
    });
});

describe("forecastExhaustion — confidence (R²)", () => {
    test("R² ≈ 1 for perfect linear data (no noise)", () => {
        const hist = syntheticHistory({
            samples: 6, slope5h: 5, slopeWk: 1, noise: 0,
        });
        const r = forecast.forecastExhaustion(hist);
        assert.ok(r.confidence5h > 0.99);
        assert.ok(r.confidenceWeekly > 0.99);
    });

    test("R² drops for noisy data", () => {
        const hist = syntheticHistory({
            samples: 12, slope5h: 5, slopeWk: 1, noise: 30, seed: 7,
        });
        const r = forecast.forecastExhaustion(hist);
        assert.ok(r.confidence5h < 0.95);
    });

    test("R² is clamped to [0, 1] — never negative", () => {
        const hist = [
            { ts: 1000, fiveHourRemaining: 60, weeklyRemaining: 95 },
            { ts: 2000, fiveHourRemaining: 40, weeklyRemaining: 95 },
            { ts: 3000, fiveHourRemaining: 60, weeklyRemaining: 95 },
            { ts: 4000, fiveHourRemaining: 40, weeklyRemaining: 95 },
            { ts: 5000, fiveHourRemaining: 60, weeklyRemaining: 95 },
        ];
        const r = forecast.forecastExhaustion(hist);
        assert.ok(r.confidence5h >= 0 && r.confidence5h <= 1);
    });
});

describe("appendHistory + readHistory", () => {
    test("round-trip: append then read returns the same shape", () => {
        assert.equal(forecast.readHistory().length, 0);
        const ok = forecast.appendHistory({
            ts: 1_700_000_000_000,
            fiveHourRemaining: 80,
            weeklyRemaining: 90,
        });
        assert.equal(ok, true);
        const after = forecast.readHistory();
        assert.equal(after.length, 1);
        assert.equal(after[0].ts, 1_700_000_000_000);
        assert.equal(after[0].fiveHourRemaining, 80);
    });

    test("skips malformed lines on read (corrupt-file robustness)", () => {
        writeFileSync(
            tmpHistoryPath,
            [
                JSON.stringify({ ts: 1000, fiveHourRemaining: 50, weeklyRemaining: 60 }),
                "this is not json",
                JSON.stringify({ ts: 2000, fiveHourRemaining: 40, weeklyRemaining: 50 }),
                "",
                "{broken",
            ].join("\n") + "\n",
            "utf8",
        );
        const out = forecast.readHistory();
        assert.equal(out.length, 2);
        assert.equal(out[0].ts, 1000);
        assert.equal(out[1].ts, 2000);
    });

    test("readHistory(maxAgeMs) filters stale snapshots", () => {
        const now = Date.now();
        forecast.appendHistory({ ts: now - 7_200_000, fiveHourRemaining: 80, weeklyRemaining: 90 });
        forecast.appendHistory({ ts: now - 60_000, fiveHourRemaining: 70, weeklyRemaining: 89 });
        const recent = forecast.readHistory({ maxAgeMs: 3_600_000 });
        assert.equal(recent.length, 1);
        assert.equal(recent[0].fiveHourRemaining, 70);
    });

    test("readHistory returns [] when file doesn't exist", () => {
        rmSync(tmpHistoryPath, { force: true });
        assert.deepEqual(forecast.readHistory(), []);
    });
});

describe("leastSquaresFit — pure math", () => {
    test("fits y = 2x + 1 perfectly (R² > 0.9999)", () => {
        const fit = forecast.leastSquaresFit([0, 1, 2, 3, 4], [1, 3, 5, 7, 9]);
        assert.ok(fit);
        assert.ok(Math.abs(fit.slope - 2) < 1e-9);
        assert.ok(Math.abs(fit.intercept - 1) < 1e-9);
        assert.ok(fit.r2 > 0.9999);
    });

    test("returns null for n < 2 or length mismatch", () => {
        assert.equal(forecast.leastSquaresFit([1], [5]), null);
        assert.equal(forecast.leastSquaresFit([], []), null);
        assert.equal(forecast.leastSquaresFit([1, 2, 3], [1, 2]), null);
    });

    test("returns null for all-identical x (degenerate)", () => {
        // n*sxx - sx*sx = 3*75 - 15*15 = 0
        assert.equal(forecast.leastSquaresFit([5, 5, 5], [1, 2, 3]), null);
    });

    test("R² = 1 when all y identical (line passes through constant)", () => {
        const fit = forecast.leastSquaresFit([0, 1, 2], [5, 5, 5]);
        assert.ok(fit);
        assert.equal(fit.slope, 0);
        assert.equal(fit.intercept, 5);
        assert.equal(fit.r2, 1);
    });
});

describe("recordSnapshotFromCs", () => {
    test("appends when both quota fields present", () => {
        const ok = forecast.recordSnapshotFromCs({
            usage: {
                fiveHourPercent: 75,
                weekly: "85%",
                fiveHourReset: 1_700_000_000,
            },
        });
        assert.equal(ok, true);
        const hist = forecast.readHistory();
        assert.equal(hist[0].fiveHourRemaining, 75);
        assert.equal(hist[0].weeklyRemaining, 85);
    });

    test("skips when cs.usage.hidden (feature disabled)", () => {
        const ok = forecast.recordSnapshotFromCs({
            usage: { hidden: true, fiveHourPercent: 75, weekly: "85%" },
        });
        assert.equal(ok, false);
        assert.equal(forecast.readHistory().length, 0);
    });

    test("skips when cs.usage is empty / cs is null", () => {
        assert.equal(forecast.recordSnapshotFromCs({ usage: {} }), false);
        assert.equal(forecast.recordSnapshotFromCs(null), false);
        assert.equal(forecast.recordSnapshotFromCs(undefined), false);
    });
});

describe("handleForecast — route handler", () => {
    test("responds with { ok: true, forecast: {...} } from real history", async () => {
        // Seed 3 snapshots → forecast should produce finite hours
        for (const [age, rem] of [[3_600_000, 80], [1_800_000, 70], [60_000, 60]]) {
            forecast.appendHistory({
                ts: Date.now() - age,
                fiveHourRemaining: rem,
                weeklyRemaining: 90 - (60 - rem) * 0.2,
            });
        }
        const usageRoute = await import(absPath("routes/usage.js"));
        let captured;
        const res = {
            writeHead() {},
            end(body) { captured = body; },
        };
        await usageRoute.handleForecast(
            { url: "/api/usage/forecast" }, res, { cid: "test" },
        );
        const body = JSON.parse(captured);
        assert.equal(body.ok, true);
        assert.equal(body.forecast.model, "least-squares-linear");
        assert.equal(body.forecast.samples, 3);
        assert.ok(body.forecast.hoursUntilExhaustion5h !== null);
    });

    test("responds with reason='no_history' when file is empty", async () => {
        const usageRoute = await import(absPath("routes/usage.js"));
        let captured;
        const res = {
            writeHead() {},
            end(body) { captured = body; },
        };
        await usageRoute.handleForecast(
            { url: "/api/usage/forecast" }, res, { cid: "test" },
        );
        const body = JSON.parse(captured);
        assert.equal(body.forecast.reason, "no_history");
        assert.equal(body.forecast.samples, 0);
    });
});