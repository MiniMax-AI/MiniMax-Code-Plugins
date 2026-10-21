---
name: minimax-code-checkin
description: |
  Complete MiniMax Code's daily check-in to claim free credits
  (400/day, 1000 on day 4 and day 7, 4000/week, valid 30 days) AND
  manage the schedule of that automated check-in. Use when the user
  says "签到", "MiniMax Code 签到", "每日签到", "领积分",
  "check in MiniMax Code", when a cron task fires the daily
  check-in, OR when the user says "改签到时间", "把签到改到X点",
  "每天X点签到", "调定时", "定时几点", "关掉自动签到",
  "开启自动签到". Do NOT use for: querying credit balance,
  redeeming credits, signing in to third-party platforms
  (掘金/CSDN/...), modifying unrelated cron tasks, or anything
  outside MiniMax Code's built-in check-in.
---

# MiniMax Code Daily Check-in

## Inputs to collect

- **Region**: 国内 (`agent.minimaxi.com`) or 海外 (`agent.minimax.io`).
  Pick by inspecting the user's existing MiniMax Code cookie or the
  desktop app's logged-in account. Don't ask the user every time —
  remember the decision in the session.
- **Cron schedule** (only when the user asks to create or change
  the scheduled run): default 09:00 local; confirm the time zone
  if not obvious.

## Procedure

0. **Branch on intent.** Decide which of three modes the request is:
   - **A. Run now** — user wants the check-in executed right now
     (default for "签到", "领积分", cron fire, etc.). Go to step 1.
   - **B. Schedule query** — user asks "什么时候签到", "定时几点".
     Run `mavis cron list --agent_name mavis`, locate the task named
     `minimax-code-checkin-daily`, run `mavis cron get <cronId>`,
     surface its schedule + enabled state. Skip step 1–4.
   - **C. Schedule change** — user asks "改到 X 点", "关掉自动签到",
     "改成每周一三五签到", etc. Run `mavis cron list` to find the
     task, then call `mavis cron update --cron_id <id> ...` with the
     new schedule / enabled flag. Confirm with the user before
     disabling if the request is ambiguous (e.g. "停一下签到").
     Skip step 1–4.

1. **Confirm login state** before doing anything else (only for mode A).
   - Web path: check the browser cookie store for either
     `agent.minimaxi.com` or `agent.minimax.io`. If a valid session
     cookie exists, treat the user as logged in.
   - Desktop path (fallback): inspect the MiniMax Code desktop app's
     OAuth cache (Shared OAuth Core). On Windows this lives under
     `%APPDATA%\MiniMax Code\`; on macOS under
     `~/Library/Application Support/MiniMax Code/`. A non-empty
     access token counts as logged in.
   - Why: the check-in endpoint rejects anonymous requests; without
     a valid session the click just refreshes the login page.

2. **Probe the check-in surface.** The button has moved across
   versions:
   - **Web**: `Settings → Usage` page on the region URL, OR a
     dedicated `/checkin` route added in v3.0.58 (2026-08-05).
   - **Desktop TUI**: `/checkin` slash command (also v3.0.58+).
   - Try the version-aware route first; fall back to the older
     `Settings → Usage` surface if the dedicated route is missing.
   - Why: blindly clicking the wrong surface wastes a turn and may
     hit a non-MCS element.

3. **Click the "签到" / "立即签到" button**. Stop if the button is
   already in a "已签到" / disabled state.
   - Why: clicking an already-claimed check-in is treated as abuse
     by the backend and can flag the account.

4. **Read the response** and surface a short summary:
   - today reward (400 normally, 1000 on day 4 / day 7)
   - current streak day count
   - total credit balance

## Output contract

Reply in chat with one concise line, in Chinese:

| Situation | Message |
|---|---|
| Success | `✅ 已签到：+400 积分（连续 N 天），余额 M` |
| Success with bonus | `✅ 已签到：+1000 积分（连续 4/7 天奖励），余额 M` |
| Already done today | `ℹ️ 今日已签到（连续 N 天），余额 M` |
| Not logged in | `⚠️ 未登录 MiniMax Code <region>（<region URL>）。请在浏览器登录后回我"签到"重试。Web 入口：设置→用量；桌面端：TUI 输入 /checkin` |
| Surface missing | `⚠️ 没找到签到入口，MiniMax Code 版本 X.Y.Z（需 ≥ v3.0.58）。请升级或参考 references/checkin-flow.md` |
| Schedule queried | `ℹ️ 当前自动签到：每天 09:00（Asia/Shanghai），状态 enabled。下次触发：<nextRun>` |
| Schedule updated | `✅ 自动签到已改为 <schedule>（<timezone>），下次触发：<nextRun>` |
| Schedule disabled | `⏸ 已暂停自动签到（cron 已 disabled）。需要重启请说"开启自动签到"` |
| Schedule enabled | `▶ 已恢复自动签到，下次触发：<nextRun>` |

## Failure handling

- **Not logged in**: report the region URL, point to Web/TUI entry,
  and ask the user to log in then re-trigger the skill. Never try to
  fill credentials yourself, and skip the run-mode steps (2/3/4) —
  they would just bounce off the login page.
- **Check-in surface missing**: report the detected MiniMax Code
  version and remind the user to upgrade to ≥ v3.0.58.
- **Already checked in today**: do NOT click again — repeat clicks
  may be flagged as abuse.
- **Network error**: retry once with a 3s backoff; on second failure,
  report the error verbatim and exit.
- **MiniMax Code version < v3.0.58**: surface not guaranteed to
  exist. Tell the user to upgrade before relying on this skill.
- **Cron task not found** (`mavis cron list` returns nothing named
  `minimax-code-checkin-daily`): offer to create it — show the
  default command, ask for the desired schedule + time zone before
  running `mavis cron create`.
- **`mavis cron update` fails**: report the error verbatim; do NOT
  silently fall back to the previous schedule. Confirm with the user.

## Examples

**Input** (cron at 09:00):
> 执行 MiniMax Code 每日签到

**Output**:
> ✅ 已签到：+400 积分（连续 3 天），余额 1200

**Input** (user just signed in, on day 4):
> 我刚登录 MiniMax Code，帮我把今天的签到也领了

**Output**:
> ✅ 已签到：+1000 积分（连续 4 天奖励），余额 5400

**Input** (already signed in earlier today):
> 今天签到了吗

**Output**:
> ℹ️ 今日已签到（连续 4 天），余额 5400

**Input** (user changes the cron time):
> 把自动签到改到晚上 8 点

**Output**:
> ✅ 自动签到已改为 `0 20 * * *`（Asia/Shanghai），下次触发：今天 20:00

**Input** (user disables the cron):
> 关掉自动签到

**Output**:
> ⏸ 已暂停自动签到（cron 已 disabled）。需要重启请说"开启自动签到"

**Input** (user asks when check-in runs):
> 什么时候自动签到？

**Output**:
> ℹ️ 当前自动签到：每天 09:00（Asia/Shanghai），状态 enabled。下次触发：<nextRun>