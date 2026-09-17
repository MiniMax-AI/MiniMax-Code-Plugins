---
name: completion-audit
description: |
  Before saying "done", derive requirements, find authoritative evidence, verify each is ✅.
  USE WHEN: about to say "done" / "complete" / "ship it" / "I finished" / "做完了" on non-trivial task, about to mark `todowrite` step done, about to update goal to `complete`, user has been waiting for "done" for several turns, "looks good" / "should be fine" / "应该好了" / "我试过没报错" / "我跑了测试都过了" / "I tested it" / "trust me" / "should work".
  TRIGGER PHRASES: "做完了", "done", "complete", "ship it", "好了", "完成", "搞定", "I think we're done", "应该好了", "looks good", "我试过没报错", "我跑了测试都过了", "I tested it", "trust me", "should work".
  SKIP WHEN: one-line edit, user can see result in chat immediately, user explicitly said "ship it" / "no more review" in this turn.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.1"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/ext/goal/templates/goals/continuation.md
---

# Completion Audit

Before you say "done," prove it. Not from memory, not from intent, not from "the tests passed" —
from **authoritative evidence for each requirement, against the actual current state**.

This Skill is the difference between "I think I'm done" and "I have proven I am done." It is the
single most expensive lesson in agent work: **agents are confident they are done far more often
than they actually are**, and the cost of that false confidence is paid by the user.

## When to use

Activate when **any** of these is true:

- You are about to say "done" / "complete" / "ship it" / "I finished" on a non-trivial task.
- A `todowrite` step is about to be marked `[x]` and that step touches anything the user will
  rely on.
- An active thread goal (`goal-persistence` Skill) is about to be marked `complete`.
- The user has been waiting for "done" for several turns and you feel the urge to say it just to
  end the turn.
- The work spanned multiple tool calls, multiple files, or multiple sub-tasks.

## When NOT to use

- A one-line edit. The cost of the audit is higher than the cost of a wrong "done".
- The deliverable is observable by the user in this turn (e.g. you just printed the result to
  the chat). They can see it; you don't need to audit yourself.
- The user explicitly said "ship it" or "no more review" in this turn.

## Process

1. **Stop. Do not say "done" yet.** Even if it feels done, run this Skill.
2. **Derive concrete requirements** from the original objective — verbatim where possible. If
   the user said "fix the auth bug," the requirements are "auth works for existing users" and
   "no new bug introduced," not "I edited the auth file." Translate surface requests into
   outcome requirements.
3. **For each requirement, identify the authoritative evidence** that would prove it. Not
   "I think it works" — what would *you* check, given infinite time?

   | Requirement | Authoritative evidence |
   |---|---|
   | "auth works for existing users" | existing test suite green + 1 manual smoke |
   | "doc updated" | grep / file content showing the new line |
   | "API returns 200 on happy path" | curl output |
   | "user can log in" | screenshot / log of one full login round-trip |

4. **Inspect that evidence** — the *current* state, not a memory. The test you ran three
   turns ago is no longer authoritative if the code has changed since. Re-run, re-read,
   re-grep.
5. **For each item, classify the result**:

   - ✅ **proves completion** — the evidence matches the requirement unambiguously
   - ❌ **contradicts completion** — the evidence shows the requirement is not met
   - 🟡 **incomplete work** — partial evidence, some sub-requirement unmet
   - ⚪ **too weak to verify** — the evidence does not cover the requirement's scope
   - 🚫 **missing** — no evidence was gathered

6. **If any item is not ✅**, do not declare done. State the unfinished item and continue.
7. **If all items are ✅**, declare done in this shape:

   ```text
   ✅ Done. Verified against:
   - <requirement 1>: <evidence collected> — ✅
   - <requirement 2>: <evidence collected> — ✅
   - ...
   ```

8. **On active thread goal**: report the final token usage to the user
   (per `goal-persistence` Skill — token accountability). State the actual final number, not a
   rough estimate.

## Output contract

The user sees, in this order:

- One-line "verifying before declaring done" preamble.
- The audit table (one row per requirement, one column per: requirement, evidence, result).
- The verdict: ✅ all green / 🟡 unfinished item(s) / ❌ contradiction(s).
- (If all green + active goal) The final token usage.

## Example

```text
Verifying before declaring "auth refactor done".

| Requirement                                | Evidence                                          | Result |
|--------------------------------------------|---------------------------------------------------|--------|
| 12 existing SAML tests still pass          | `cargo test auth::saml` (just re-ran)             | ✅     |
| New OIDC login works with Okta             | `cargo test auth::oidc` + manual smoke (logged in) | ✅     |
| `auth.oidc_enabled` defaults to `false`    | `grep "oidc_enabled" config/default.toml`          | ✅     |
| No new dependencies in `Cargo.toml`        | `git diff Cargo.toml`                              | ✅     |
| Docs updated in `docs/auth.md`             | `grep "oidc_enabled" docs/auth.md`                 | ✅     |
| No off-by-one in `expires_at`              | manual code review of `src/auth/oidc/mod.rs:42`    | ✅     |

Token usage: 18,420 / 20,000 (92% of goal budget).
✅ Done.
```

Counter-example (audit caught a hole):

```text
Verifying before declaring done.

| Requirement                          | Evidence                                          | Result |
|--------------------------------------|---------------------------------------------------|--------|
| Existing tests pass                  | `cargo test`                                       | ✅     |
| Manual smoke test passes              | (not run)                                          | ⚪     |
| Public API unchanged                  | `git diff src/auth/mod.rs`                          | ❌ `login()` signature changed — added `provider` param |
| Docs mention new OIDC config          | `grep "oidc" docs/auth.md`                          | ❌ doc only describes SAML |

🟡 Two requirements unmet. The public API changed but was not declared, and the
docs only describe SAML. The user must decide: revert the public API change, or
accept it and update the docs + declare the API break.
```

## Common pitfalls

- **Do not skip the audit because "I just ran the tests."** The tests you ran three
  turns ago are not the current state. Re-run, re-read.
- **Do not classify "I wrote the code" as evidence.** Writing code is not the requirement;
  the requirement is what the code *does*. Substitute "the code does X" with "I verified X
  by running Y."
- **Do not let the audit become a rubber stamp.** If the verdict is "all green" 100% of
  the time, the audit is not working. The whole point is to catch what you missed.
- **Do not declare done with 🟡 items.** The verdict must be all ✅ or you do not
  declare done. Surface the unfinished items.
- **Do not treat "user said ship it" as a reason to skip the audit.** The user said ship
  it because they *expect* the audit to have been done. Skipping is a betrayal.
- **Do not substitute a narrower, safer, or merely-compatible solution.** If the user
  asked for OIDC and you built OAuth2 "because it's similar," the requirement is unmet even
  if the tests pass.
- **Do not mark a goal complete because the budget is nearly exhausted or because you are
  stopping work.** The audit is the only thing that gets to declare done.

## Verification checklist

- [ ] Did you stop before saying "done"?
- [ ] Did you derive concrete requirements (not surface requests)?
- [ ] For each requirement, did you identify the *authoritative* evidence?
- [ ] Did you inspect the *current* state (not memory of past work)?
- [ ] Is each item classified as ✅ / ❌ / 🟡 / ⚪ / 🚫?
- [ ] Is the verdict all ✅? If not, did you surface the unfinished items?
- [ ] (Active goal) Did you report final token usage?
- [ ] Did the user see the audit table before you declared done?
