---
name: context-pressure-compact
description: "Compress a long-running multi-step task into a structured state summary before continuing, so the agent can keep going without losing track of the original goal. Use when the active `todowrite` exceeds 5 items, after ~20 tool calls, when the user says 'compact' / 'summarize so far' / 'we need to refocus', or when context usage is visibly heavy. Mirrors codex-rs/core/src/compact.rs::run_pre_sampling_compact and the v2 64K retention budget (RETAINED_MESSAGE_TOKEN_BUDGET)."
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "1.0.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs and core/src/compact_remote_v2.rs
  changes-from-v0.1.0: "Added the 64K retention budget concept (P-10 v2); added 'discarded N tool calls and M lines' reporting rule; cross-referenced world-state-tracking and goal-persistence so compaction is the single coordination point."
---

# Context Pressure Compact

Compress the running state of a long task into a structured snapshot, then keep working
from the snapshot. The agent loses the noisy middle (failed attempts, finished steps, stale
tool output) but keeps the goal, the decisions, and the next move.

**v1.0 update**: now incorporates the 64K retention budget from Codex's `compact_remote_v2.rs`
— the "important" messages preserved after a compact should target ~64,000 tokens, not be
unbounded.

## When to use

Activate when **any** of these is true:

- The active `todowrite` has more than 5 items, **and** at least 2 are still in progress.
- The agent has executed roughly 20 or more tool calls since the user request.
- The user says "compact", "summarize so far", "refocus", "we're getting lost", or
  "let me see the state".
- A tool call from `tool-output-budget` is being applied to a string the agent will not need
  again (it has been superseded by newer output).
- A sub-task boundary (a self-contained feature is done; the next user step starts a new one).
- The estimated total tokens (history + current message) is approaching the model context
  window (typically 80% of the window is the trigger).

Do **not** use this Skill for short tasks (< 5 tool calls, < 3 `todowrite` items). Compaction has
its own cost; the savings only matter once the conversation is genuinely heavy.

## When NOT to use

- A single one-shot question. The user wants an answer, not a checkpoint.
- The user is in the middle of dictating a multi-step request. Finish listening first.
- The user explicitly said "do not summarize" or "keep everything".

## Process

1. **Freeze new work.** Do not start any new tool call before the snapshot is written.
2. **Target the 64K retention budget.** After compact, the **retained** messages (the
   important ones — current goal, recent decisions, key file paths) should target ~64,000
   tokens. Discard the rest. This is `RETAINED_MESSAGE_TOKEN_BUDGET` from
   `compact_remote_v2.rs`. If you retain more, the next compaction will arrive sooner than
   expected; if you retain much less, the agent will lose context.

3. **Write the snapshot** to a single fenced block, in this exact shape:

   ```markdown
   ## Compact Snapshot — <ISO timestamp or "step N">

   **Goal**: <one sentence, copied verbatim from the user request>

   **Done** (these are finished; do not re-do them):
   - <step + key result + path/identifier>

   **In progress** (these are partially done; carry the partial state forward):
   - <step + where you stopped + the next concrete sub-step>

   **Decisions made** (so future you doesn't re-argue them):
   - <decision + one-line reason>

   **Key file paths** (absolute paths the next step will need):
   - /path/to/foo
   - /path/to/bar

   **Blockers / open questions** (so the user can answer them upfront next turn):
   - <question or "none">

   **Next concrete step**: <one verb-first sentence — "Edit X to add Y", "Run Z and report output", etc.>

   **Retained token estimate**: <N tokens>  (target: ~64K, see RETAINED_MESSAGE_TOKEN_BUDGET)
   **Discarded this turn**: <M tool calls and N lines of intermediate output>
   ```

4. **Optionally persist to disk** if the user has a working directory. Default path:
   `.minimax/snapshots/<ISO-date>-<short-id>.md`. The user can `read` it later to reload
   context.
5. **Drop the noisy middle from the next prompt.** After the snapshot, your next response
   should start from "Next concrete step", not from re-stating the goal.
6. **Continue working** as if the snapshot is the only context. Do not re-fetch the files
   you already listed under "Key file paths" unless you need to re-read them.
7. **Coordinate with other state files** (cross-references):
   - **`goal-persistence`** file: survives compaction unchanged (its file is on disk).
   - **`world-state-tracking`** file: survives compaction unchanged.
   - **`subagent-family-tracking`** file: survives compaction unchanged.
   - **`goal-token-budgeting`** usage log: keep the latest row, drop the history.
   - **`todowrite`**: keep Done/In progress sections, drop the granular "attempted X then
     Y then Z" history.

## Output contract

Every time you apply this Skill, the user sees:

- The Compact Snapshot block (as above).
- An optional one-line "discarded N tool calls and M lines of intermediate output" note.
- The next concrete step, phrased as an action the user can sanity-check.
- The retained token estimate (so the user knows the budget is being respected).

## Example

```markdown
## Compact Snapshot — 2026-08-23T23:55:00Z — step 7

**Goal**: Refactor the auth subsystem to support OIDC without breaking the existing SAML path.

**Done** (these are finished; do not re-do them):
- Mapped current auth flow in src/auth/. Wrote findings to .minimax/snapshots/auth-flow.md
- Identified 4 injection points: login(), callback(), refresh(), logout()
- Confirmed test coverage: 12 of 14 files have unit tests (2 missing: logout, session)

**In progress** (these are partially done; carry the partial state forward):
- Designing the OIDC adapter interface. Stopped at: how to represent the "provider" enum
  vs the existing "IdP" interface. Need to decide: 1) extend IdP, 2) new OidcProvider sibling,
  3) generic Provider with config-driven dispatch.

**Decisions made** (so future you doesn't re-argue them):
- Keep SAML on the legacy code path; OIDC gets a parallel module. (Reason: SAML contract is
  frozen, no test budget to re-validate.)
- Reject (3) generic Provider — too much config surface for marginal benefit.

**Key file paths** (absolute paths the next step will need):
- /repo/src/auth/idp.rs
- /repo/src/auth/callback.rs
- /repo/tests/auth/

**Blockers / open questions** (so the user can answer them upfront next turn):
- Should the OIDC module own token storage, or reuse the existing session store?
- Does IT have a preferred OIDC library (openidconnect vs oauth2)?

**Next concrete step**: Draft the OidcProvider trait + one impl for `provider = "okta"`, then
show the diff to the user before touching the callback.

**Retained token estimate**: ~58,000 tokens  (target: ~64K, well within budget)
**Discarded this turn**: 14 tool calls, ~12,000 lines of intermediate output
```

## Common pitfalls

- **Do not rewrite history.** The snapshot records what actually happened, including the
  wrong path you took. Future you needs the wrong path to avoid re-walking it.
- **Do not omit Blockers.** This is the most valuable section — it's how the user unblocks
  you with one sentence instead of three round trips.
- **Do not skip "Key file paths".** Absolute paths save the next turn from `glob` and `grep`.
- **Do not snap every turn.** A snapshot after every tool call is noise. Use the triggers
  above.
- **Do not nest snapshots.** One snapshot is the new ground truth; the previous one is
  superseded and can be discarded (or moved to `.minimax/snapshots/archive/`).
- **Do not exceed the 64K retention target.** A snapshot of 200K tokens defeats the purpose.
  If your retention is naturally > 64K, you need to compress *more* (drop more history,
  shorten the in-progress description), not less.
- **Do not duplicate other state files.** The goal / world-state / family files survive
  on disk. Reference them by path; do not copy them into the snapshot.

## Verification checklist

- [ ] Is the goal copied verbatim from the user?
- [ ] Are Done / In progress / Decisions / Paths / Blockers / Next step all present and
      non-empty (or explicitly "none")?
- [ ] Is the retained token estimate present and within the 64K target (±20%)?
- [ ] Did you avoid starting a new tool call before the snapshot was written?
- [ ] Did you drop the noisy middle from the next prompt?
- [ ] Did the user get a chance to answer Blockers before you kept going?
- [ ] Did you reference (not duplicate) other state files by path?
