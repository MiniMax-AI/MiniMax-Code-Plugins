---
name: retry-with-backoff
description: |
  Execute explicit retry policy: max 3, base 2s, max 30s, full jitter, 60s total budget, respects `Retry-After`.
  USE WHEN: `error-recovery-strategy` classified error as `transient` and chose `retry`, HTTP 429 with `Retry-After` header, network timeout/refused/reset, queue/lock/eventually-consistent read returned stale, user said "重试" / "retry" / "再试" / "等一下" / "等几秒" / "backoff" / "exponential" / "rate limit" / "429" / "限流".
  TRIGGER PHRASES: "重试", "retry", "再试", "等一下", "等几秒", "backoff", "exponential", "rate limit", "429", "Retry-After", "throttled", "限流", "busy", "服务忙".
  SKIP WHEN: error is `deterministic` (won't change on retry), error is `unknown` (escalate to ask-user), work is time-sensitive and 30s backoff is too late.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.1"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/code-mode/src/grpc_session/reconnect.rs
---

# Retry With Backoff

Retry is the most common recovery action — and the easiest to do badly. Retrying
without a budget burns wall-clock and budget. Retrying with too-aggressive a backoff
hits the rate-limited service again. Retrying without jitter causes a thundering herd
when many agents retry the same service at the same instant.

This Skill defines a single, explicit retry policy. **Always state the policy before
running the retries.** Do not improvise.

## When to use

Activate when **any** of these is true:

- `error-recovery-strategy` Skill categorised the error as `transient` and chose
  `retry` as the action.
- A rate-limited service (HTTP 429, API quota) returned a `Retry-After` header.
- A network call timed out, refused, or reset.
- A queue / lock / eventually-consistent read returned a stale or empty result.

## When NOT to use

- The error is `deterministic` (permission denied, file not found). Retry will fail
  the same way. Switch tool or ask user instead.
- The error is `unknown`. Retry without a clear reason is gambling. Ask user.
- The work is time-sensitive enough that a 30-second backoff would be too late. In
  that case, retry **without** backoff (1 immediate attempt) and then escalate to
  user on failure.

## Process

1. **Pick the policy before retrying.** Defaults (override only with reason):

   | Parameter | Default | Why |
   |---|---|---|
   | `max_attempts` | `3` (original + 2 retries) | Three strikes; the third strike is the cost of "I'm sure it's transient." |
   | `base_delay_seconds` | `2` | Short enough to be useful, long enough to feel the first retry. |
   | `max_delay_seconds` | `30` | Above 30 s the user has usually already given up mentally. |
   | `total_time_budget_seconds` | `60` | Hard ceiling; beyond this, escalate to user. |
   | `jitter_strategy` | `full` (uniform 0..delay) | Prevents thundering herd. |
   | `respect_retry_after` | `true` (if server provides `Retry-After`, use it) | Server knows more than we do. |

2. **State the policy in the response, in one line:**

   ```text
   Retry plan: 3 attempts, base 2s, max 30s, full jitter, budget 60s total
   ```

3. **Compute each retry's actual delay as:**

   ```text
   delay(n) = min(base * 2^(n-1), max_delay)
   actual_delay(n) = uniform(0, delay(n))   # full jitter
   ```

   For `n = 1, 2, 3` with base 2s and max 30s:
   - attempt 1: `min(2, 30) = 2s`, jittered to `[0, 2]`s
   - attempt 2: `min(4, 30) = 4s`, jittered to `[0, 4]`s
   - attempt 3: `min(8, 30) = 8s`, jittered to `[0, 8]`s

4. **If the server returned a `Retry-After` header**, use `max(delay(n), retry_after)` —
   the server is saying "wait at least this long," not "wait exactly this long."

5. **Between attempts**, do not start any other tool call. The whole point of the
   delay is to let the service recover. If you are tempted to "do other work while
   waiting," surface to the user instead — they may want to know you are in retry
   mode before you start something else.

6. **After the last attempt**, evaluate:
   - **Success** → continue, mention the retry in the result so the user knows it
     took longer than expected.
   - **Still failing** → escalate to `error-recovery-strategy`'s `ask-user` action.
     Do not silently extend the retry count. Do not skip-with-warning.

7. **If the total time budget (60s default) is exceeded mid-retry**, stop the next
   delay and escalate immediately. Time budget is **hard**, not soft.

## Output contract

The user sees, in this order:

- One-line retry plan (max attempts, base, max, jitter, total budget).
- (Per attempt) one line: "attempt N failed: <error summary>; waiting Ms."
- After the last attempt: success → continue, failure → escalate to `ask-user`.
- A short post-mortem: "Why did this take N×t? The server was rate-limiting / network
  was congested / etc." if you can identify the cause; "unknown" is acceptable.

## Example

```text
Retry plan: 3 attempts, base 2s, max 30s, full jitter, budget 60s total

attempt 1: GET /api/v1/users/123 → 503 Service Unavailable
  waiting 1.4s (jittered from 2s)

attempt 2: GET /api/v1/users/123 → 503 Service Unavailable
  waiting 3.1s (jittered from 4s)

attempt 3: GET /api/v1/users/123 → 200 OK
  total time: 4.5s (well under 60s budget)
```

Counter-example (escalate, do not extend):

```text
Retry plan: 3 attempts, base 2s, max 30s, full jitter, budget 60s total

attempt 1: ... 503
attempt 2: ... 503
attempt 3: ... 503
  total time: 4.5s

Recovery decision: ask-user
Reason: 3 attempts exhausted within budget; error is consistently 503; switching
        to ask rather than extending to attempt 4.
```

## Common pitfalls

- **Do not retry without a budget.** Even one undeclared retry can burn 5 minutes.
- **Do not skip jitter.** A "deterministic" delay causes thundering herd when multiple
  agents retry the same service. Always jitter.
- **Do not retry past the total time budget.** The budget is hard. If you exceed it,
  you have failed the Skill, regardless of how many more attempts you could fit.
- **Do not retry `deterministic` errors.** A permission-denied error will fail every
  time. Switch or ask.
- **Do not start other work between retries.** The delay is for the service, not for
  you. If the user has new instructions, queue them or surface a question.
- **Do not respect `Retry-After` blindly.** It is a *minimum*, not a *maximum*. Use
  `max(delay(n), retry_after)`, not `retry_after` alone.
- **Do not silently extend.** If 3 attempts failed, escalate. Do not try 4 "just
  in case." The user should know the work is blocked.

## Verification checklist

- [ ] Did you state the retry plan (max attempts, base, max, jitter, budget) before
      retrying?
- [ ] Did you respect any `Retry-After` from the server (using `max`)?
- [ ] Did you add full jitter to every delay?
- [ ] Did you cap each delay at the configured `max_delay_seconds`?
- [ ] Did you stop at `max_attempts` (no silent extension)?
- [ ] Did you stop at `total_time_budget_seconds` (no overrun)?
- [ ] On exhaustion, did you escalate to `ask-user` (not silent skip)?
- [ ] Did you report the total time and cause (if known) in the post-mortem?
