---
name: goal-token-budgeting
description: "When the user sets an explicit token budget on a goal, track the running usage and report it on completion. Use whenever `goal-persistence` is active and the user provided a `token_budget` (either initially or via `Op::SetThreadMemoryMode`). Mirrors codex-rs `ext/goal/src/accounting.rs` (GoalAccountingState) and the 'Tokens used / Token budget / Tokens remaining' section of the goal continuation template."
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/ext/goal/src/accounting.rs and ext/goal/templates/goals/continuation.md
---

# Goal Token Budgeting

A goal without a budget is open-ended; an agent will spend whatever it takes to "look done"
at the cost of the user. A goal **with** a budget is a contract: the agent is accountable
for fitting the work inside the spend, and the user can decide whether more spend is
worth it.

This Skill tracks the running usage against the budget, surfaces the trend, and reports
the final number on completion.

## When to use

Activate when **any** of these is true:

- `goal-persistence` is active and the user provided a `token_budget` when setting the goal.
- The user says "do X within Y tokens" / "use the cheap model for this" / "don't burn too
  much on this."
- You are about to start a sub-task and want to know "how much budget do I have left?"
- A `context-pressure-compact` is about to be applied and you need to report whether the
  goal is still within budget.

## When NOT to use

- The goal has no budget (the user didn't set one). Tracking zero is not useful.
- The user explicitly said "no budget tracking for this one."

## Process

1. **At goal set**, if the user provided a `token_budget`, record it in the goal file
   (`goal-persistence` Skill) under a new section:

   ```markdown
   ## Token budget

   **Budget**: <N tokens>  (set by user)
   **Set at**: <ISO timestamp>
   ```

   If the user did not provide a budget, do not add this section. Absence of the section
   means "no budget."

2. **At every turn boundary** (end of your response, or at every `context-pressure-compact`),
   read the harness's per-turn token usage and append a row to a usage log:

   ```markdown
   ## Usage log

   | turn | tokens | used_so_far | remaining | % of budget |
   |------|--------|-------------|-----------|-------------|
   | 1    | 1,240  | 1,240       | 18,760    | 6%          |
   | 2    | 2,100  | 3,340       | 16,660    | 17%         |
   | ...  | ...    | ...         | ...       | ...         |
   ```

   You can read the harness's token usage from:
   - the conversation transcript (if the harness surfaces per-turn counts)
   - the system prompt (if it includes running totals)
   - `TokenCount` events (if the harness emits them — see `protocol::EventMsg::TokenCount`)

3. **At every boundary, surface the trend**, not just the raw number:

   - **Under 50% used**: silent (the budget is fine).
   - **50-80% used**: mention the budget in the response, one line. "Budget: 12,400 / 20,000
     (62%)."
   - **80-100% used**: warn the user explicitly. "Budget almost used: 17,200 / 20,000 (86%).
     Next turn may exceed — should I stop here or continue?"
   - **Over 100% used**: stop, surface to user, ask whether to:
     - declare the goal done with the over-budget cost
     - ask for a budget extension
     - re-scope the goal to fit

4. **At every `context-pressure-compact`**, the compact summary must include the latest
   usage row. The user must be able to see the budget trend across the compacted summary.

5. **On goal completion** (via `completion-audit` Skill), the final report **must** include
   the actual final token usage, read from the harness — not an estimate. The user set the
   budget; they get the number.

## Output contract

The user sees:

- At goal set: a one-line "Budget: N tokens" in the goal file.
- During execution: silent under 50%, one line at 50-80%, warn at 80-100%, stop at 100%+.
- At every compact: the latest usage row included in the summary.
- On completion: a one-line "Final token usage: M / N (X%)".

## Example

```text
> User: "Migrate the auth subsystem to OIDC alongside SAML. Token budget: 20,000."

[Goal file]
## Token budget
**Budget**: 20,000 tokens  (set by user)
**Set at**: 2026-08-23T22:00:00Z

[Usage log over time]
| turn | tokens | used_so_far | remaining | % of budget |
|------|--------|-------------|-----------|-------------|
| 1    | 1,240  | 1,240       | 18,760    | 6%          |
| 2    | 2,100  | 3,340       | 16,660    | 17%         |
| 5    | 3,200  | 8,940       | 11,060    | 45%         |
| 8    | 2,500  | 14,300      | 5,700     | 71% ← one-liner appears |
| 10   | 1,800  | 17,200      | 2,800     | 86% ← warn appears |
| 11   | 1,500  | 18,700      | 1,300     | 93% ← warn continues |
| 12   | 1,400  | 20,100      | (over)    | 101% ← stop and ask user |
```

At turn 12, the agent surfaces:

> Budget exceeded: 20,100 / 20,000 tokens. I have 2 of the 4 success criteria verified.
> Options: (a) declare partial completion, (b) ask for a 5,000-token extension, (c) re-scope
> the goal to what fits in 2,000 more tokens. Which?

## Common pitfalls

- **Do not invent a budget the user did not set.** Absence of budget is not "use whatever
  you need." It is "track usage but do not warn at thresholds."
- **Do not estimate the final number on completion.** Read the actual usage from the
  harness. Estimation is dishonest.
- **Do not warn at 50% if the user explicitly said "don't bother me with budget updates."**
  Respect the user's signal.
- **Do not silently cross 100%.** Stop and ask. Crossing the budget without surfacing it
  is a betrayal.
- **Do not re-scope the goal unilaterally to fit the budget.** Re-scoping is a *user
  decision*. The agent's only job at 100%+ is to surface the situation.
- **Do not skip the budget tracking because "the task is small."** A small task becoming
  a 5× budget overrun is exactly when tracking matters most.

## Verification checklist

- [ ] Did the user set an explicit `token_budget`? (If not, do not activate this Skill.)
- [ ] Is the budget recorded in the goal file under "Token budget"?
- [ ] Does the usage log get a row at every turn boundary?
- [ ] At 50-80%, is there a one-line mention in the response?
- [ ] At 80-100%, is there an explicit warn to the user?
- [ ] At 100%+, did the agent stop and ask the user (not silently continue)?
- [ ] At every compact, is the latest usage row in the summary?
- [ ] On completion, is the final number the actual harness-reported usage (not an
      estimate)?
