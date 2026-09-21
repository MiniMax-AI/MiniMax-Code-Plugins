// webui/server/lib/quota-forecast.js
// Linear forecast for quota exhaustion — fix for CAPABILITIES.md §8
// "Forecast exhaustion time ❌" (lease C07).
//
// What this module does:
//   1. Maintains an append-only NDJSON history of quota snapshots at
//      ~/.mcode-webui/usage-history.ndjson (overridable via
//      MCODE_WEBUI_HISTORY_PATH for tests).
//   2. On every /api/usage call, routes/usage.js#handleUsage calls
//      recordSnapshotFromCs(cs) to append one line. This is best-effort:
//      a failure never breaks the /api/usage response.
//   3. forecastExhaustion(history) fits a least-squares linear
//      regression y = m*x + b on (timestamp, consumed-percent) pairs
//      for each time scale (5h + weekly) and returns the predicted
//      time-to-exhaustion plus the R² confidence.
//
// Math backbones (sih-math/llm-friendly-build/mapping.md 2026-09-13):
//   - ALG-013 类型化关系模型与事件化投影 — NDJSON history is a typed
//     relation model; each line is a row, replayable either direction.
//   - ORD-015 共归纳与镜像对偶 — the history can be replayed to any
//     earlier state; least-squares gives the canonical mirror view.
//   - LIM-007 (implicit through ALG-013) — least-squares minimizes
//     the L² norm, the canonical inverse problem on a Hilbert space.
//
// Design choices:
//   - Zero npm deps. We write the LS normal equations ourselves.
//   - At least 3 samples are required to fit; below that we return
//     null + reason='insufficient_samples' so the UI can show a
//     "collecting data…" placeholder rather than a fake number.
//   - If slope ≤ 0 (quota not being consumed), return Infinity
//     rather than a negative number — the quota reset semantics
//     (5h/weekly window) make "negative time" meaningless.
//   - If quota is already exhausted, return 0 — matches user intuition.
//   - Confidence is R² ∈ [0, 1]; we clamp because noisy data can
//     make R² negative (worse than predicting the mean), and the UI
//     shouldn't display "negative confidence".
//
// File location pattern mirrors events.js (B01): lazy resolver that
// honors an env override, mkdirSync best-effort, appendFileSync one
// line at a time. Settings.js#ensureDir (lines 126-134) is the prior
// art for the dir-creation pattern.

import {
  existsSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Path resolution — env override for tests, homedir default for prod.
// ---------------------------------------------------------------------------
const HISTORY_DIR_DEFAULT = join(homedir(), ".mcode-webui");
const HISTORY_PATH_DEFAULT = join(HISTORY_DIR_DEFAULT, "usage-history.ndjson");

function _historyPath() {
  return process.env.MCODE_WEBUI_HISTORY_PATH || HISTORY_PATH_DEFAULT;
}

function _ensureDir(path) {
  // Best-effort, mirrors events.js#_ensureDir + settings.js#ensureDir:
  // log + continue rather than throwing — the actual appendFileSync
  // below will surface a clearer error if the dir is truly inaccessible.
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (e) {
    console.warn(
      `[webui] quota-forecast mkdir ${dirname(path)} failed: ${e.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Persistence — appendHistory / readHistory.
// ---------------------------------------------------------------------------

// appendHistory — write one snapshot line to the NDJSON history file.
// Returns true on success, false on failure (caller decides whether
// to surface the error; we keep it silent because the forecast is
// best-effort and /api/usage must not be coupled to disk health).
export function appendHistory(snapshot) {
  const path = _historyPath();
  _ensureDir(path);
  const ts = typeof snapshot?.ts === "number" ? snapshot.ts : Date.now();
  const line = JSON.stringify({
    ts,
    fiveHourRemaining:
      typeof snapshot?.fiveHourRemaining === "number"
        ? snapshot.fiveHourRemaining
        : null,
    fiveHourResetAt:
      typeof snapshot?.fiveHourResetAt === "number"
        ? snapshot.fiveHourResetAt
        : null,
    weeklyRemaining:
      typeof snapshot?.weeklyRemaining === "number"
        ? snapshot.weeklyRemaining
        : null,
    weeklyResetAt:
      typeof snapshot?.weeklyResetAt === "number"
        ? snapshot.weeklyResetAt
        : null,
  }) + "\n";
  try {
    appendFileSync(path, line, "utf8");
    return true;
  } catch (e) {
    console.warn(`[webui] quota-forecast append failed: ${e.message}`);
    return false;
  }
}

// readHistory — read NDJSON history file, return array of snapshots.
//   - Lines that fail to parse are skipped (robustness against manual
//     edits or partial writes). The forecast is "best-effort", and a
//     corrupt line should not take down the entire endpoint.
//   - `opts.maxAgeMs` filters out stale snapshots so the regression
//     only sees the relevant window (caller passes 5h or 7d).
export function readHistory(opts = {}) {
  const path = _historyPath();
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    console.warn(`[webui] quota-forecast read failed: ${e.message}`);
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      out.push(o);
    } catch {
      // Skip malformed line — see comment above.
    }
  }
  if (typeof opts.maxAgeMs === "number" && opts.maxAgeMs > 0) {
    const cutoff = Date.now() - opts.maxAgeMs;
    return out.filter(
      (s) => typeof s.ts === "number" && s.ts >= cutoff,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure math — least-squares fit. Exported for unit testing.
// ---------------------------------------------------------------------------

// leastSquaresFit — fit y = m*x + b by minimizing sum of squared
// residuals. Closed-form normal equations:
//   m = (n*sxy - sx*sy) / (n*sxx - sx*sx)
//   b = (sy - m*sx) / n
// Returns { slope, intercept, r2, n } or null if the input is degenerate.
//
// R² (coefficient of determination) measures how well the linear
// model explains the variance in y:
//   R² = 1 - SS_res / SS_tot
// where SS_res = sum((y_actual - y_predicted)²) and SS_tot is the
// variance around the mean. R² = 1 means perfect fit; R² = 0 means
// the fit is no better than predicting the mean.
//
// Degenerate cases:
//   - n < 2: return null (can't fit a line through one point)
//   - all x identical: denominator is 0, return null
//   - SS_tot = 0 (all y identical):
//       - if SS_res = 0 too, the line is perfect → R² = 1
//       - else the line misses every point → R² = 0
//   - Negative R² (fit worse than mean): clamp to 0 so the UI never
//     shows "negative confidence".
export function leastSquaresFit(x, y) {
  const n = x.length;
  if (n < 2 || n !== y.length) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null; // all x identical
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  // R²
  let ssRes = 0, ssTot = 0;
  const yMean = sy / n;
  for (let i = 0; i < n; i++) {
    const yPred = slope * x[i] + intercept;
    ssRes += (y[i] - yPred) ** 2;
    ssTot += (y[i] - yMean) ** 2;
  }
  let r2 = 0;
  if (ssTot > 0) r2 = 1 - ssRes / ssTot;
  else r2 = ssRes === 0 ? 1 : 0;
  if (r2 < 0) r2 = 0;
  if (r2 > 1) r2 = 1;
  return { slope, intercept, r2, n };
}

// ---------------------------------------------------------------------------
// Forecast — the public API called by routes/usage.js#handleForecast.
// ---------------------------------------------------------------------------

// forecastExhaustion — predict hours-until-exhaustion for each scale.
//
// Inputs:
//   history — array of { ts, fiveHourRemaining, weeklyRemaining, ... }
//   opts:
//     - minSamples (default 3) — below this return null + reason
//     - nowMs (default Date.now()) — anchor for "from this point"
//
// Output shape (always returned, even on insufficient data, so the
// UI doesn't crash on missing fields):
//   {
//     hoursUntilExhaustion5h:   number | null,
//     hoursUntilExhaustionWeekly: number | null,
//     confidence5h:   number (R², 0..1),
//     confidenceWeekly: number (R², 0..1),
//     samples: number,
//     model: "least-squares-linear",
//     reason?: "no_history" | "insufficient_samples"
//   }
//
// Physics:
//   y = % consumed = (100 - remaining). We fit y over time, so a
//   positive slope means quota is being consumed. Exhaustion is
//   reached when y = 100%, i.e.:
//     secondsLeft = (100 - lastConsumed) / slope
//   If slope ≤ 0, the quota is not being consumed (e.g. window
//   reset, no usage). We return Infinity rather than a negative
//   number because the user expectation is "won't run out" not
//   "ran out N hours ago in the past".
export function forecastExhaustion(history, opts = {}) {
  const minSamples = opts.minSamples ?? 3;
  if (!Array.isArray(history) || history.length === 0) {
    return {
      hoursUntilExhaustion5h: null,
      hoursUntilExhaustionWeekly: null,
      confidence5h: 0,
      confidenceWeekly: 0,
      samples: 0,
      model: "least-squares-linear",
      reason: "no_history",
    };
  }
  if (history.length < minSamples) {
    return {
      hoursUntilExhaustion5h: null,
      hoursUntilExhaustionWeekly: null,
      confidence5h: 0,
      confidenceWeekly: 0,
      samples: history.length,
      model: "least-squares-linear",
      reason: "insufficient_samples",
    };
  }

  const fitOne = (key) => {
    const valid = history
      .map((s) => ({ ts: s.ts, rem: s[key] }))
      .filter(
        (s) =>
          typeof s.ts === "number" &&
          typeof s.rem === "number" &&
          Number.isFinite(s.ts) &&
          Number.isFinite(s.rem),
      );
    if (valid.length < minSamples) {
      return { hours: null, confidence: 0, n: valid.length };
    }
    // Use the first valid sample as x=0 so slope is "per second since
    // first sample" — numerically stable even when timestamps are
    // unix-millis (1.7e12 magnitude).
    const x0 = valid[0].ts / 1000;
    const x = valid.map((s) => s.ts / 1000 - x0);
    const y = valid.map((s) => 100 - s.rem);
    const fit = leastSquaresFit(x, y);
    if (!fit) {
      return { hours: null, confidence: 0, n: valid.length };
    }
    const lastConsumed = y[y.length - 1];
    let hours = null;
    if (fit.slope > 0 && lastConsumed < 100) {
      const secondsLeft = (100 - lastConsumed) / fit.slope;
      hours = secondsLeft / 3600;
    } else if (lastConsumed >= 100) {
      hours = 0; // already exhausted
    } else if (fit.slope <= 0) {
      hours = Infinity; // not consuming — won't exhaust in linear projection
    }
    return { hours, confidence: fit.r2, n: fit.n };
  };

  const fit5h = fitOne("fiveHourRemaining");
  const fitWk = fitOne("weeklyRemaining");
  // `samples` is the count of pairs the LS fit actually used — we
  // report the smaller of the two so the UI knows the weakest link.
  const samples = Math.min(fit5h.n, fitWk.n);

  return {
    hoursUntilExhaustion5h: fit5h.hours,
    hoursUntilExhaustionWeekly: fitWk.hours,
    confidence5h: fit5h.confidence,
    confidenceWeekly: fitWk.confidence,
    samples,
    model: "least-squares-linear",
  };
}

// ---------------------------------------------------------------------------
// Snapshot recording — convenience wrapper used by routes/usage.js.
// ---------------------------------------------------------------------------

// recordSnapshotFromCs — extract quota fields from the client state
// (after runUsageQuery has populated them) and append a history row.
// Returns true if appended, false otherwise. Silent failure is OK
// here — the forecast is best-effort.
//
// Why this is a thin wrapper rather than inlined:
//   - Keeps routes/usage.js focused on routing
//   - Lets tests drive the shape without spinning up runUsageQuery
export function recordSnapshotFromCs(cs) {
  if (!cs || typeof cs !== "object") return false;
  const u = cs.usage || {};
  if (u.hidden) return false; // feature disabled → don't pollute history
  const hasFiveHour = typeof u.fiveHourPercent === "number";
  const hasWeekly = typeof u.weekly === "string";
  if (!hasFiveHour && !hasWeekly) return false; // no quota data at all
  let weeklyRemaining = null;
  if (hasWeekly) {
    // u.weekly is a string like "85%"; parseFloat strips the % sign.
    const parsed = parseFloat(String(u.weekly));
    if (Number.isFinite(parsed)) weeklyRemaining = parsed;
  }
  return appendHistory({
    ts: Date.now(),
    fiveHourRemaining: hasFiveHour ? u.fiveHourPercent : null,
    fiveHourResetAt:
      typeof u.fiveHourReset === "number" ? u.fiveHourReset : null,
    weeklyRemaining,
    weeklyResetAt: null, // not currently exposed by the parser
  });
}

// _resetForTests — currently no-op since path is read fresh each call
// and there's no in-memory state to reset. Provided for symmetry with
// events.js#_resetForTests so test files have a uniform shape.
export function _resetForTests() {
  // intentionally empty
}