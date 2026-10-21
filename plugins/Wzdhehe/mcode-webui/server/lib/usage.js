// webui/server/lib/usage.js
// Quota (5h / weekly plan limits) queries.
//
// Architecture (SiHankor boundary, modacker 2026-08-28):
//   - webui is a *plugin* for mcode; the only auth/key holder is mcode.
//   - For plan-level quota, mcode does NOT currently expose a quota
//     subcommand or local cache. We deliberately do NOT call the
//     remote MiniMax API from the plugin (would duplicate auth) and
//     do NOT read the desktop app (out of scope per project owner).
//   - If the user has set a Token Plan API Key in settings, webui
//     calls the official API directly using that key.
//   - If no key is configured, the entire feature is hidden: we do
//     NOT show a degraded empty state (no "—" placeholders, no info
//     banner). The "套餐用量" button disappears from the UI entirely.
//     Rationale: half-truths are worse than silence; the user has
//     full control over whether to opt in.
//
// All session-level token usage is *not* the responsibility of this
// module — that lives in `mavis-usage.js` and is read by the chat
// flow when a mcode session exists.

import { pushStateFor } from "./state-bus.js";
import { getTokenPlanApiKey, getQuotaEnabled } from "./settings.js";

const QUOTA_ENDPOINT = "https://www.minimaxi.com/v1/token_plan/remains";
const QUOTA_TIMEOUT_MS = 15_000;

// Token Plan API key must be the user's Subscription Key from
// https://platform.minimaxi.com/user-center/token-plan — not the OAuth
// session JWT (which the API rejects with status_code 1004).
async function fetchTokenPlanRemains(apiKey) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), QUOTA_TIMEOUT_MS);
  try {
    const r = await fetch(QUOTA_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: ac.signal,
    });
    if (!r.ok) {
      throw new Error(`HTTP ${r.status} ${r.statusText}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// runUsageQuery — called by POST /api/usage, /api/usage-trigger, and
// the /usage slash command.
//
// Behavior matrix:
//   quotaEnabled=false OR no key  → set hidden=true, return early.
//   quotaEnabled=true + key set   → call API, populate fields, hidden=false.
//   API fails                       → hidden=false, error set so the
//                                    popover can show "load failed" toast.
// parseTokenPlanResponse — extracted from runUsageQuery for
// testability. Pure function: takes the API JSON, mutates the
// supplied `cs.usage` shape, returns either { ok: true } or
// { ok: false, error }. No side effects beyond the cs.usage
// mutation, so tests can assert on the populated fields directly.
//
// Exported so test/usage.test.js can drive it with a fixed JSON
// fixture (the real API response captured on 2026-08-28).
export function parseTokenPlanResponse(data, cs) {
  // base_resp is the standard platform wrapper. status_code !== 0
  // means the API rejected the call (e.g., 1004 login fail).
  const baseResp = data?.base_resp;
  if (baseResp && baseResp.status_code && baseResp.status_code !== 0) {
    return {
      ok: false,
      error: baseResp.status_msg || `API status ${baseResp.status_code}`,
    };
  }

  // Real Token Plan response shape (verified 2026-08-28 via curl
  // with the user's key against the live endpoint):
  //   {
  //     model_remains: [
  //       {
  //         model_name: "general",
  //         start_time, end_time, remains_time,
  //         current_interval_total_count, current_interval_usage_count,
  //         current_interval_remaining_percent, current_interval_status,
  //         current_weekly_total_count, current_weekly_usage_count,
  //         current_weekly_remaining_pct,
  //         weekly_start_time, weekly_end_time, weekly_remains_time,
  //         ...
  //       },
  //       ... (other models)
  //     ]
  //   }
  //
  // CRITICAL: the per-model fields live INSIDE model_remains[i],
  // NOT at the top level. The first version of this parser read
  //   data?.current_interval_remaining_percent
  // which is always undefined, so the popover always showed "—".
  // The fix is to pick the "general" entry (or the first one)
  // and read from that, mirroring what getGeneralQuota() in
  // public/app/state.js does client-side.
  const modelEntry = Array.isArray(data?.model_remains)
    ? (data.model_remains.find((m) => m && m.model_name === "general")
      || data.model_remains[0]
      || null)
    : null;

  cs.usage.plan = data?.plan ?? null;
  cs.usage.expires = data?.expires ?? null;
  cs.usage.credits = data?.credits ?? null;
  // Stash the raw response for debugging — the SSE push of cs
  // exposes `usage.raw` to the client, and a "查看 raw 响应"
  // affordance in the popover would surface this when the
  // numbers look wrong (e.g., API shape drift). We cap it at
  // 8 KB to avoid memory bloat on an unexpectedly large body.
  try {
    cs.usage.raw = JSON.stringify(data).slice(0, 8192);
  } catch {
    cs.usage.raw = null;
  }
  // 5h window percentage: pick the "general" model's remaining %
  // out of model_remains[]. Falls back to null if the API shape
  // changes and the field is missing.
  //
  // v2026-08-28 modacker: field name is `current_interval_remaining_percent`
  //   (with the full word `percent`), NOT `current_interval_remaining_pct`.
  //   The first version of this parser read `current_interval_remaining_pct`
  //   — the typo was benign because both fields returned undefined and the
  //   popover gracefully showed "—", but the new test fixture pins the
  //   exact wire shape so any future drift is caught immediately.
  const fiveHourRaw = modelEntry?.current_interval_remaining_percent;
  cs.usage.fiveHourPercent = (typeof fiveHourRaw === "number")
    ? fiveHourRaw
    : null;
  // weekly: same pattern, field is `current_weekly_remaining_percent`
  //   (NOT `current_weekly_remaining_pct` — that was the typo above).
  //   Pass through as a "%" string for popover format consistency.
  const weeklyRaw = modelEntry?.current_weekly_remaining_percent;
  cs.usage.weekly = (typeof weeklyRaw === "number")
    ? `${weeklyRaw}%`
    : null;
  // 5h reset time: the API gives absolute start/end/remaining
  // timestamps. We compute "next reset" as end_time (the next
  // 5h boundary) — same semantic the popover wants. Falls
  // back to a synthesized next 5h boundary if absent.
  let resetTs = null;
  const endTime = modelEntry?.end_time;
  if (typeof endTime === "number") resetTs = Math.floor(endTime / 1000); // ms → s
  cs.usage.fiveHourReset = resetTs;
  // session-level fields are computed elsewhere (mavis-usage.js);
  // reset them here so a stale value from a previous /api/usage
  // call doesn't bleed through after a plan-level refresh.
  cs.usage.sessionInput = 0;
  cs.usage.sessionOutput = 0;
  cs.usage.sessionTotal = 0;
  cs.usage.sessionCacheRead = 0;
  cs.usage.sessionCacheWrite = 0;
  cs.usage.sessionReasoning = 0;
  cs.usage.sessionCacheHitRate = 0;
  return { ok: true };
}

export async function runUsageQuery(cs, cid) {
  const enabled = getQuotaEnabled();
  const apiKey = getTokenPlanApiKey();

  if (!enabled || !apiKey) {
    // Feature off: hide entirely, don't fetch, don't show placeholders.
    cs.usage.plan = null;
    cs.usage.expires = null;
    cs.usage.credits = null;
    cs.usage.fiveHourPercent = null;
    cs.usage.fiveHourReset = null;
    cs.usage.weekly = null;
    cs.usage.sessionInput = 0;
    cs.usage.sessionOutput = 0;
    cs.usage.sessionTotal = 0;
    cs.usage.sessionCacheRead = 0;
    cs.usage.sessionCacheWrite = 0;
    cs.usage.sessionReasoning = 0;
    cs.usage.sessionCacheHitRate = 0;
    cs.usage.fetchedAt = Date.now();
    cs.usage.error = null;
    cs.usage.hidden = true;
    pushStateFor(cid);
    return;
  }

  try {
    const data = await fetchTokenPlanRemains(apiKey);
    const result = parseTokenPlanResponse(data, cs);
    cs.usage.fetchedAt = Date.now();
    if (result.ok) {
      cs.usage.error = null;
      cs.usage.hidden = false;
    } else {
      cs.usage.error = result.error;
      cs.usage.hidden = false; // button shown so user sees the error
    }
  } catch (e) {
    cs.usage.fetchedAt = Date.now();
    cs.usage.error = String(e.message || e);
    cs.usage.hidden = false; // button is shown so user can see the error
  }
  pushStateFor(cid);
}
