---
name: context-pressure-compact
description: "Compress a long-running multi-step task into a structured state summary before continuing, so the agent can keep going without losing track of the original goal. Use when the active `todowrite` exceeds 5 items, after ~20 tool calls, when the user says 'compact' / 'summarize so far' / 'we need to refocus', or when context usage is visibly heavy. Mirrors codex-rs/core/src/compact.rs::run_pre_sampling_compact."
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs
---

# Context Pressure Compact

Compress the running state of a long task into a structured snapshot, then keep working from the
snapshot. The agent loses the noisy middle (failed attempts, finished steps, stale tool output)
but keeps the goal, the decisions, and the next move.

## When to use

Activate when **any** of these is true:

- The active `todowrite` has more than 5 items, **and** at least 2 are still in progress.
- The agent has executed roughly 20 or more tool calls since the user request.
- The user says "compact", "summarize so far", "refocus", "we're getting lost", or
  "let me see the state".
- A tool call from `tool-output-budget` is being applied to a string the agent will not need
  again (it has been superseded by newer output).
- A sub-task boundary (a self-contained feature is done; the next user step starts a new one).

Do **not** use this Skill for short tasks (< 5 tool calls, < 3 `todowrite` items). Compaction has
its own cost; the savings only matter once the conversation is genuinely heavy.

## When NOT to use

- A single one-shot question. The user wants an answer, not a checkpoint.
- The user is in the middle of dictating a multi-step request. Finish listening first.
- The user explicitly said "do not summarize" or "keep everything".

## Process

1. **Freeze new work.** Do not start any new tool call before the snapshot is written.
2. **Write the snapshot** to a single fenced block, in this exact shape:

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
   ```

3. **Optionally persist to disk** if the user has a working directory. Default path:
   `.minimax/snapshots/<ISO-date>-<short-id>.md`. The user can `read` it later to reload context.
4. **Drop the noisy middle from the next prompt.** After the snapshot, your next response should
   start from "Next concrete step", not from re-stating the goal.
5. **Continue working** as if the snapshot is the only context. Do not re-fetch the files you
   already listed under "Key file paths" unless you need to re-read them.

## Output contract

Every time you apply this Skill, the user sees:

- The Compact Snapshot block (as above).
- An optional one-line "discarded N tool calls and M lines of intermediate output" note.
- The next concrete step, phrased as an action the user can sanity-check.

## Example

```markdown
## Compact Snapshot — 2026-08-23T23:55:00Z — step 7

**Goal**: Refactor the auth subsystem to support OIDC without breaking the existing SAML path.

**Done**:
- Mapped current auth flow in src/auth/. Wrote findings to .minimax/snapshots/auth-flow.md
- Identified 4 injection points: login(), callback(), refresh(), logout()
- Confirmed test coverage: 12 of 14 files have unit tests (2 missing: logout, session)

**In progress**:
- Designing the OIDC adapter interface. Stopped at: how to represent the "provider" enum
  vs the existing "IdP" interface. Need to decide: 1) extend IdP, 2) new OidcProvider sibling,
  3) generic Provider with config-driven dispatch.

**Decisions made**:
- Keep SAML on the legacy code path; OIDC gets a parallel module. (Reason: SAML contract is
  frozen, no test budget to re-validate.)
- Reject (3) generic Provider — too much config surface for marginal benefit.

**Key file paths**:
- /repo/src/auth/idp.rs
- /repo/src/auth/callback.rs
- /repo/tests/auth/

**Blockers / open questions**:
- Should the OIDC module own token storage, or reuse the existing session store?
- Does IT have a preferred OIDC library (openidconnect vs oauth2)?

**Next concrete step**: Draft the OidcProvider trait + one impl for `provider = "okta"`, then
show the diff to the user before touching the callback.
```

## Common pitfalls

- **Do not rewrite history.** The snapshot records what actually happened, including the wrong
  path you took. Future you needs the wrong path to avoid re-walking it.
- **Do not omit Blockers.** This is the most valuable section — it's how the user unblocks you
  with one sentence instead of three round trips.
- **Do not skip "Key file paths".** Absolute paths save the next turn from `glob` and `grep`.
- **Do not snap every turn.** A snapshot after every tool call is noise. Use the triggers above.
- **Do not nest snapshots.** One snapshot is the new ground truth; the previous one is
  superseded and can be discarded (or moved to `.minimax/snapshots/archive/`).

## Verification checklist

- [ ] Is the goal copied verbatim from the user?
- [ ] Are Done / In progress / Decisions / Paths / Blockers / Next step all present and
      non-empty (or explicitly "none")?
- [ ] Did you avoid starting a new tool call before the snapshot was written?
- [ ] Did you drop the noisy middle from the next prompt?
- [ ] Did the user get a chance to answer Blockers before you kept going?
