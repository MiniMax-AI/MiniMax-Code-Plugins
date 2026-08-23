---
name: goal-persistence
description: "Maintain an explicit north-star goal for the whole thread that survives compactions and detects drift. Use at the start of any non-trivial task (one-time set), after every user redirection (one-time update), and at every `context-pressure-compact` boundary (one-line alignment check). Before declaring done, run a completion audit (see also `completion-audit` Skill). Mirrors codex-rs `Op::SetThreadMemoryMode` + `EventMsg::ThreadGoalUpdated` in protocol/src/protocol.rs and the continuation template in ext/goal/templates/goals/continuation.md."
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "1.0.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs (SetThreadMemoryMode, ThreadGoalUpdatedEvent) and ext/goal/templates/goals/continuation.md
  changes-from-v0.1.0: "Added completion-audit and blocked-audit sections from the Codex continuation template; added token-budget reporting rule; aligned language with the canonical 'treat completion as unproven' principle."
---

# Goal Persistence

The single biggest reason long tasks fail is **goal drift**: the agent starts doing A, the user
asks for B, the conversation accumulates noise, the agent ends up doing C with the
justification that "it felt like the right next step." The original goal is gone — or worse,
silently replaced by a goal the agent inferred.

This Skill keeps the original goal *visible*, *versioned*, and *checkable* across the whole
thread. It is the *why* of the task; `world-state-tracking` is the *where*.

**v1.0 update**: now incorporates the canonical completion audit and blocked audit
from the Codex goal continuation template, so declaring "done" is always evidence-based,
not intent-based.

## When to use

Activate when **any** of these is true:

- A non-trivial task has just been stated (one-time **set**).
- The user has redirected the task ("actually, do X instead", "wait, scrap that", "now also
  include Y") — one-time **update**.
- A `context-pressure-compact` is about to be applied — one-line **alignment check**.
- The agent is about to start a tool call that has *any* chance of being misaligned with
  the original ask (a "drift self-test").
- The agent is about to mark the goal as `complete` or `blocked` — the **completion audit**
  and **blocked audit** sections apply.

## When NOT to use

- Trivial one-shot tasks. The user request *is* the goal; no need to persist it.
- Pure research / exploration ("look into X, no commitment"). A goal implies a deliverable.
- The goal has not changed in many turns and the agent is on track. Re-writing the goal
  file is noise.

## Process

1. **Pick a single, predictable path.** Default:
   `.minimax/goal/<YYYY-MM-DD>-<short-id>.md`. Different from the world-state file (which is
   "where we are"; this is "what we are doing").
2. **Initialise the goal file** at the start of a non-trivial task, in this exact shape:

   ```markdown
   # Goal — <short task name>

   **Set**: <ISO date>
   **Owner**: <agent name or "main">
   **Last checked**: <ISO timestamp>
   **Version**: 1

   ## Original goal (verbatim from the user)

   <quote the user's exact words, or "the user wants: <one-sentence paraphrase>" if
   verbatim is impractical>

   ## Why this goal

   <one paragraph on the user's underlying motivation — what they are really trying
   to achieve, not just the surface request>

   ## Success looks like

   - <checkable deliverable 1>
   - <checkable deliverable 2>

   ## Explicitly out of scope

   - <thing the user said is NOT part of this>
   - <adjacent thing the agent might be tempted to do unprompted>

   ## Version history

   - v1: <ISO timestamp> — initial set
   ```

3. **Update the goal** (bump `Version`, append a row to Version history) when **any** of:
   - The user explicitly redirects.
   - The user adds or removes a deliverable.
   - The user expands or narrows the scope.
   - The user re-states the goal in a way that supersedes the prior version.
4. **Drift self-test** before any non-trivial tool call: read the goal file, read the
   tool call, ask "does this tool call serve the current version of the goal?". If
   **no**, surface the drift to the user before executing:

   ```text
   Drift check: this tool call is `<what>`, but the current goal is `<why>`.
   - aligned → continue
   - misaligned (tool call is a side quest) → ask the user before executing
   - superseded (the goal has moved on) → update the goal file first
   ```

5. **At every `context-pressure-compact`**, the compact summary must reference the goal
   file by path, not duplicate it. The goal file is the thing that survives; the
   summary is the thing that gets re-derived.
6. **Before marking the goal `complete`**, run a **completion audit** (next section).
7. **When the user finally says "done" / "ship it" / "looks good"**, mark the goal as
   achieved in the file (`Status: achieved, <ISO>`) and leave the file in place as part
   of the audit trail. **On a budgeted goal, also report the final token usage to the
   user** (token accountability).

## Completion Audit (before declaring done)

**Treat completion as unproven until you have evidence for each requirement.**

```text
Verifying before declaring "<goal name>" done.

| Requirement                                | Evidence                                          | Result |
|--------------------------------------------|---------------------------------------------------|--------|
| <requirement 1>                            | <how I verified it>                                | ✅     |
| <requirement 2>                            | <how I verified it>                                | ✅     |
| ...                                        | ...                                               | ...    |
```

Result legend: ✅ proves completion · ❌ contradicts · 🟡 incomplete · ⚪ too weak · 🚫 missing.

**All items must be ✅ before declaring done.** If any item is not ✅, surface the unfinished
items; do not mark complete. See `completion-audit` Skill for the full protocol.

## Blocked Audit (before declaring blocked)

**Do not declare blocked the first time a blocker appears.** Only use `blocked` when the
same blocking condition has repeated for at least **three consecutive goal turns** (the
original/user-triggered turn plus any automatic continuations), and the agent is at a true
impasse.

```text
Checking if "<goal name>" should be marked blocked.

- Turn N: blocker = <first time I hit it>           ← not yet
- Turn N+1: blocker = <same condition>               ← not yet
- Turn N+2: blocker = <same condition>               ← not yet
- Turn N+3: blocker = <same condition>               ← THRESHOLD MET, can mark blocked

If after 3 turns the blocker is different, reset the count.
```

**Do not mark blocked merely because the work is hard, slow, uncertain, incomplete, or would
benefit from clarification.** "I don't know what to do next" is not blocked — it is
uninformed, and the response is to ask, not to stop.

## Token Budget Reporting (on a budgeted goal)

If the goal has a `token_budget`, when marking `complete` (or `blocked`):

```text
Final token usage: 18,420 / 20,000 (92% of goal budget).
```

The user set the budget; they get the report. Do not omit the final number; do not estimate —
read it from the actual usage.

## Output contract

The user sees, in this order:

- On set: the goal file's contents (full) + the path + the version.
- On update: the diff (one line: "v1 → v2: <what changed>").
- On drift check: one line verdict (`aligned` / `misaligned: <why>` / `superseded: <why>`).
- On compact: a one-line "Goal still in scope, see <path>".
- Before done: the completion audit table + final token usage (if budgeted).
- Before blocked: the blocked audit count + the actual blocker.
- On "done": the goal file marked `Status: achieved, <ISO>`.

## Example goal file

```markdown
# Goal — Auth refactor (OIDC alongside SAML)

**Set**: 2026-08-23
**Owner**: main
**Last checked**: 2026-08-23T23:55:00Z
**Version**: 1

## Original goal (verbatim from the user)

> "Refactor the auth subsystem to support OIDC without breaking the existing SAML path."

## Why this goal

The user is migrating from a single-SAML IdP to multi-IdP (SAML + OIDC) to support a new
customer segment. They cannot break the existing 12 SAML tests because that would
regress two production customers. The OIDC work is for *new* customers only.

## Success looks like

- A new OIDC provider implementation that works end-to-end with one real-world IdP
  (e.g. Okta).
- All 12 existing SAML tests still pass.
- A config flag `auth.oidc_enabled` defaults to `false`, so production is unaffected.
- One happy-path test for OIDC login with a mock IdP.

## Explicitly out of scope

- Refactoring the existing SAML code beyond what is strictly necessary to add the
  provider abstraction.
- Adding OAuth2 (not OIDC) flows.
- Changing the session storage layer.

## Version history

- v1: 2026-08-23T22:00:00Z — initial set
```

Drift check example:

```text
> bash(command="git rebase --interactive HEAD~20", description="rewrite recent history")

Drift check: this tool call is "rewrite 20 commits of history", but the current goal
is "add OIDC without breaking SAML".
- misaligned (interactive rebase is not on the path to the goal) → confirm with the
  user before executing
```

## Common pitfalls

- **Do not skip the "why this goal" section.** It is the most valuable paragraph. It
  is the guard against drift: when in doubt, the "why" disambiguates.
- **Do not paraphrase the original goal** unless verbatim is impractical. Paraphrase
  loses nuance; the user might have picked those exact words for a reason.
- **Do not let the goal file grow.** A 200-line goal file is a project plan, not a
  goal. Keep it under ~40 lines; let `world-state-tracking` and `todowrite` carry the
  detail.
- **Do not drift-check every tool call.** A drift check before `read` or `grep` is
  noise. Drift-check before any *write*, *edit*, or *bash* that has a non-trivial
  surface.
- **Do not update the goal on every turn.** Goal updates are rare events. If you are
  bumping the version more than once per 20 turns, you are not using it as a goal.
- **Do not conflate goal with state.** The goal file is *what*; the world-state file
  is *where*. They are different files for different questions.
- **Do not mark complete without a completion audit.** "I think it works" is not
  evidence. Each requirement needs its own ✅.
- **Do not mark blocked at the first blocker.** Three consecutive turns of the same
  blocker is the threshold. "Hard" is not "blocked."
- **Do not omit token usage on a budgeted goal.** The user set the budget to know what
  the work costs; they get the final number.

## Verification checklist

- [ ] Did you pick a single, predictable path for the goal file?
- [ ] Is the goal file under ~40 lines?
- [ ] Does it have all sections (Set / Owner / Last checked / Version / Original
      goal / Why this goal / Success / Out of scope / Version history)?
- [ ] Is the "Original goal" copied verbatim where possible?
- [ ] Does the "Why this goal" paragraph explain motivation, not just the surface
      request?
- [ ] Did you do a drift self-test before the last non-trivial tool call?
- [ ] At the next `context-pressure-compact`, does the summary reference the goal
      file by path?
- [ ] Before marking done, did you run the completion audit (all items ✅)?
- [ ] Before marking blocked, did you count to 3 consecutive turns of the same
      blocker?
- [ ] On done, did you report final token usage (if budgeted)?
- [ ] On done, did you mark the goal as achieved in the file (audit trail)?
