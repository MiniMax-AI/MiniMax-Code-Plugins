// webui/test/usage.test.js
// Unit tests for server/lib/usage.js — parseTokenPlanResponse.
//
// Why this test exists:
//   v2026-08-28 modacker: the first version of the parser read
//   `data?.current_interval_remaining_percent` at the top level.
//   The real Token Plan API actually nests that field inside
//   `model_remains[i].current_interval_remaining_percent`. As a
//   result, every fetch succeeded (HTTP 200) but the popover
//   always showed "—" because `fiveHourPercent` stayed `null`.
//   The user-visible symptom was "I added a key but the usage
//   numbers don't show up."
//
//   The fix:
//     - Pick the `model_name === "general"` entry from model_remains[]
//       (fallback to [0] if no general entry exists)
//     - Read the percentage fields from THAT entry
//     - Convert end_time (ms) → seconds for fiveHourReset
//
//   The fixture below is a verbatim capture of the real API
//   response on 2026-08-28, so any future shape change will
//   trip the "values still come out as expected" assertions.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setupMocks,
  absPath,
  registerAcpMock,
  registerSessionsStore,
} from "./_setup.js";

let parseTokenPlanResponse;
let makeClientState;
let getTokenPlanApiKey;
let getQuotaEnabled;
let pushStateFor;
let sseByCid;
let clients;

before(async (t) => {
  await setupMocks(t);
  const usageMod = await import(absPath("lib/usage.js"));
  parseTokenPlanResponse = usageMod.parseTokenPlanResponse;
  // We don't run runUsageQuery here (that needs a real fetch); we
  // only exercise the pure parser. But we need makeClientState for
  // the cs fixture.
  const sbMod = await import(absPath("lib/state-bus.js"));
  makeClientState = sbMod.makeClientState;
  sseByCid = sbMod.sseByCid;
  clients = sbMod.clients;
  // settings mock — re-imported in usage.js
  const settingsMod = await import(absPath("lib/settings.js"));
  getTokenPlanApiKey = settingsMod.getTokenPlanApiKey;
  getQuotaEnabled = settingsMod.getQuotaEnabled;
  pushStateFor = sbMod.pushStateFor;
});

beforeEach(async () => {
  // We don't run runUsageQuery (which has network side effects),
  // so we don't need a real SSE client registered. But if a test
  // ever switches to runUsageQuery, leave this here for the day.
});

// Real Token Plan API response captured 2026-08-28 via:
//   curl -H "Authorization: Bearer <user_key>" \
//        https://www.minimaxi.com/v1/token_plan/remains
// The numbers were 100% remaining because the user hadn't used
// any quota in the current window (cool-down). The point is the
// SHAPE — the parser needs to read from model_remains[0] (the
// "general" entry), not the top level.
const REAL_API_FIXTURE = {
  model_remains: [
    {
      start_time: 1787846400000,
      end_time: 1787864400000,
      remains_time: 9847188,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      model_name: "general",
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      weekly_start_time: 1787500800000,
      weekly_end_time: 1788105600000,
      weekly_remains_time: 251047188,
      current_interval_status: 1,
      current_interval_remaining_percent: 100,
      // v2026-08-28 modacker: field ends with `percent`, not `pct`.
      //   The first version of the parser read `current_weekly_remaining_pct`
      //   and silently got undefined. This fixture pins the real wire shape.
      current_weekly_remaining_percent: 100,
    },
  ],
};

describe("parseTokenPlanResponse — 真实 API 响应 (model_remains[0] 路径)", () => {
  test("general model 字段被正确提取, 不再是 null", () => {
    const cs = { usage: {} };
    const result = parseTokenPlanResponse(REAL_API_FIXTURE, cs);
    assert.equal(result.ok, true);
    assert.equal(cs.usage.fiveHourPercent, 100,
      "回归: 之前读 top-level data.current_interval_remaining_percent 总是 undefined → 前端显示 '—'");
    assert.equal(cs.usage.weekly, "100%");
  });

  test("end_time (ms) 转为 seconds 给 fiveHourReset", () => {
    const cs = { usage: {} };
    parseTokenPlanResponse(REAL_API_FIXTURE, cs);
    assert.equal(cs.usage.fiveHourReset, 1787864400,
      "fiveHourReset 是 unix 秒 (前端 nextFiveHourReset 期望), 不是 ms");
  });

  test("非 general model 入口(只有 video 类), 也能 fallback 到 model_remains[0]", () => {
    const fixtureNoGeneral = {
      model_remains: [
        {
          model_name: "video",
          current_interval_remaining_percent: 42.5,
          current_weekly_remaining_percent: 60.0,
          end_time: 1787864400000,
        },
      ],
    };
    const cs = { usage: {} };
    const r = parseTokenPlanResponse(fixtureNoGeneral, cs);
    assert.equal(r.ok, true);
    assert.equal(cs.usage.fiveHourPercent, 42.5,
      "没 general 入口时, fallback 到 [0] — 而不是返回 null 让前端空着");
    assert.equal(cs.usage.weekly, "60%");
  });

  test("缺字段时返回 null, 不抛错", () => {
    const cs = { usage: {} };
    const r = parseTokenPlanResponse({ model_remains: [{}] }, cs);
    assert.equal(r.ok, true);
    assert.equal(cs.usage.fiveHourPercent, null);
    assert.equal(cs.usage.weekly, null);
    assert.equal(cs.usage.fiveHourReset, null);
  });

  test("base_resp.status_code !== 0 → 返回 ok:false + error, 不污染 cs", () => {
    const cs = { usage: {} };
    const r = parseTokenPlanResponse(
      { base_resp: { status_code: 1004, status_msg: "login fail: ..." } },
      cs,
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /login fail/);
    assert.equal(cs.usage.fiveHourPercent, undefined,
      "出错时不写 partial 状态, 调用方根据 r.ok 决定写 error / hidden 字段");
  });

  test("model_remains 不是数组时, 不崩, 字段都是 null", () => {
    const cs = { usage: {} };
    const r = parseTokenPlanResponse({ model_remains: "garbage" }, cs);
    assert.equal(r.ok, true);
    assert.equal(cs.usage.fiveHourPercent, null);
    assert.equal(cs.usage.weekly, null);
  });
});

describe("parseTokenPlanResponse — 历史假象 (老 parser bug)", () => {
  // v0.5.ap 之前版本的 parser 期望字段在顶层, 即
  //   data.current_interval_remaining_percent / data.weekly_remaining_pct
  // 它实际从不被使用, 总是 null。 这里是保险测试, 确保我们新 parser
  // 不会"读顶层" (即使 API 加了顶层字段作为冗余也不会被误用)。
  test("顶层 current_interval_remaining_percent 不被使用 (即使 API 同时返了它)", () => {
    const fixture = {
      // 顶层字段 (假 — 真实 API 不返)
      current_interval_remaining_percent: 99,
      current_weekly_remaining_percent: 99,
      // 真实 API 返的嵌套字段
      model_remains: [{
        model_name: "general",
        current_interval_remaining_percent: 50,
        current_weekly_remaining_percent: 60,
        end_time: 1787864400000,
      }],
    };
    const cs = { usage: {} };
    parseTokenPlanResponse(fixture, cs);
    // 必须从嵌套读, 不是从顶层
    assert.equal(cs.usage.fiveHourPercent, 50,
      "若读顶层 (99), 用户看到的 5h 跟 weekly 不一致就出现幻象");
    assert.equal(cs.usage.weekly, "60%");
  });
});
