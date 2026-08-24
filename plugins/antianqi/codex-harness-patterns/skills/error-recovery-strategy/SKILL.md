---
name: error-recovery-strategy
description: "When a tool call, sub-agent task, or external operation fails, decide between retry / switch / fallback / ask-user / skip. Use whenever a tool returns a non-success result, a sub-agent reports failure, or an exception escapes from a call. The decision must be explicit, not reflexive. Mirrors the resilience patterns in codex-rs `code-mode/src/grpc_session/reconnect.rs` (binding-replacement over re-retry) and the `MultiAgentMode::ExplicitRequestOnly` philosophy (don't auto-recover without user signal)."
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/code-mode/src/grpc_session/reconnect.rs and core/src/session/multi_agents.rs
---

# Error Recovery Strategy

When something fails, the default human reaction is "retry." That is often the **wrong**
default. Retrying a permission-denied file write burns the same error three times in a row.
Retrying a network timeout that won't resolve in 30 seconds burns three minutes.

This Skill codifies the decision: **categorize the error first, then pick one of five
recovery actions, then commit to it explicitly.**

## When to use

Activate when **any** of these is true:

- A tool call returns a non-success result (non-zero exit, HTTP 4xx/5xx, exception,
  error message).
- A sub-agent reports `status: closed-failed` in the family file.
- An exception escapes from any of your own code or a library you called.
- A timeout fires on a long-running operation.
- A "weird" result comes back that might be a partial success (e.g. command exited 0
  but produced no output where you expected output).

## When NOT to use

- The operation succeeded. Do not second-guess success.
- The error is in user input (bad prompt, missing file the user should provide). That is
  not a recovery case; it is a clarification case.
- The error is part of expected flow (e.g. a `grep` returning 0 matches is an exit-1, but
  it is not a failure for the search use case).

## Process

1. **Stop. Do not retry yet.** Even if the obvious answer is "retry," run this Skill.
2. **Categorize the error** into one of four buckets:

   | Bucket | Signals | Examples |
   |---|---|---|
   | **transient** | Will probably succeed if tried again soon | Network timeout, HTTP 429/503, "ECONNRESET", "temporarily unavailable", rate limit |
   | **deterministic** | Will fail every time the same way | Permission denied, file not found, "command not found", invalid syntax, wrong credentials |
   | **stale** | Was true once, not anymore | "Index out of date", "stale lock", "file modified since read" |
   | **unknown** | Cannot classify from the message alone | Generic exception, empty error, "something went wrong" |

3. **Pick one of five recovery actions** based on the bucket:

   | Bucket | Default action | When to deviate |
   |---|---|---|
   | **transient** | `retry-with-backoff` (see next skill) | Never skip the backoff. If retries exceed the budget, escalate to `ask-user`. |
   | **deterministic** | `switch` (try an alternative tool) or `fallback` (degrade gracefully) | If no alternative exists, `ask-user`. |
   | **stale** | `refresh-then-retry` (re-read state, then retry once) | If still failing after one refresh, escalate to `ask-user`. |
   | **unknown** | `ask-user` (or `skip-with-warning` if user signal allowed it) | Never silently retry an unknown error. |

4. **Execute the chosen action explicitly** — do not bundle it with other tool calls.
   The user must be able to see "I retried" / "I switched to X" / "I asked you" as a discrete
   step in the response.

5. **Record the decision in the response** so the user can audit:

   ```text
   Recovery decision: <action>
   Reason: <one-line reason, citing the bucket>
   ```

6. **After the action**, re-evaluate. If the action also failed, re-categorize (the bucket
   may have changed — e.g. a "transient" error that persists for 5 retries is now a
   "deterministic" error in practice) and pick a new action.

## Output contract

The user sees, in this order:

- One-line error summary (what went wrong, with the tool / file / op named).
- Bucket classification: `transient` / `deterministic` / `stale` / `unknown`.
- Chosen action: `retry` / `switch` / `fallback` / `refresh-then-retry` / `ask-user` / `skip`.
- One-line reason citing the bucket.
- (If retry) the backoff plan: "N attempts, M seconds between, exponential with jitter."
- (If ask) the user-facing question with concrete options.
- (If fallback / skip) what degraded behaviour the user is now getting.

## Example

```text
> bash(command="cat /etc/hosts")

Error: cat: /etc/hosts: Permission denied
Recovery decision: switch
Reason: bucket=deterministic (permission denied won't change on retry);
        switching to `read` with explicit `path=/etc/hosts` (read may have different
        permission semantics than shell cat) before asking the user.
```

```text
> bash(command="curl https://internal-api.example.com/health")

Error: connect ECONNREFUSED 10.0.0.5:443
Recovery decision: retry
Reason: bucket=transient (network refused); will retry 3 times with 2s/4s/8s backoff
        and 500ms jitter; if all fail, escalate to ask-user.
```

```text
> task(subagent=explore, prompt="...")

Status: closed-failed. Sub-agent error: "context window exceeded".
Recovery decision: ask-user
Reason: bucket=unknown (sub-agent did not return a clear error class); do not silently
        retry with a smaller brief; surface to user with options:
          (a) reduce the sub-task scope
          (b) switch to a model with larger context
          (c) skip this sub-task
```

## Common pitfalls

- **Do not default to retry.** Retry is only correct for `transient` (and a few `stale`).
  For `deterministic` and `unknown`, retry is the most expensive wrong answer.
- **Do not bundle the recovery with other tool calls.** A retry hidden inside a larger
  batch of work is invisible. Always surface the recovery as a discrete step.
- **Do not re-categorize silently.** If you categorize as `transient`, retry 3 times,
  and it still fails, the bucket is now `deterministic` or `unknown` — say so out loud.
- **Do not ask the user a vague question.** "What should I do?" is not an option. Give
  the user 2-4 concrete options based on the bucket.
- **Do not skip-with-warning without permission.** The user did not pre-authorize
  silent skips. If the work is optional, the user should have said so at the start.
- **Do not blame the tool.** The tool did what it was told. Categorize the error
  honestly, not defensively.
- **Do not loop on retry forever.** Always have a max-attempt budget; on exhaustion,
  escalate to `ask-user`.

## Verification checklist

- [ ] Did you categorize the error into one of four buckets before picking an action?
- [ ] Did you pick one of five actions based on the bucket (not the default)?
- [ ] Did you state the recovery decision in the response, with the bucket and reason?
- [ ] (Retry) Did you specify the backoff plan (attempts, intervals, jitter)?
- [ ] (Ask) Did you give 2-4 concrete options, not "what should I do?"
- [ ] (Switch / Fallback) Did you name the alternative tool / the degraded behaviour?
- [ ] (Skip) Did you confirm the user pre-authorized this work as optional?
- [ ] Did you re-evaluate after the action and re-categorize if it failed?
- [ ] Is the recovery step a discrete line in the response (not bundled)?
