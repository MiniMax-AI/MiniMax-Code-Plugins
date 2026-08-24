---
name: session-handoff
description: "At the end of a session, write a state file that lets the next session pick up exactly where this one left off. Use when a session is ending (user says 'done for today' / context is about to compact / time is up) and there is non-trivial work in progress. Mirrors codex-rs `state/migrations/0047_rollout_migration_state.sql` (explicit migration state) and the `state/runtime/recovery.rs` pattern (DB-backed resume on crash)."
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/state/src/runtime/recovery.rs and state/migrations/0047_rollout_migration_state.sql
---

# Session Handoff

Sessions end. Time, context, attention, the user's day — all are finite. The default
end is "we'll pick it up next time," but that usually means "we'll figure out what we
were doing next time" — which costs the user another 5 minutes of re-orientation
every session, and costs you the context you built.

This Skill makes session end a **first-class operation** with an explicit output: a
handoff file that the next session can `read` first, before any other action, and be
productive in 30 seconds instead of 5 minutes.

## When to use

Activate when **any** of these is true:

- The user says "done for today" / "let's stop here" / "see you tomorrow" / "we'll
  continue later".
- The context is about to be compacted or has grown large; you anticipate losing
  context before the next user message.
- A long task is in progress and a "natural pause" is approaching (end of work day,
  end of a logical milestone, user switch context).
- A sub-task is in flight (long-running build, background command) that will outlive
  this session.

## When NOT to use

- The session just started. There is no in-progress work to hand off.
- The work is fully complete and verified (`completion-audit` passed). No
  in-progress state to hand off.
- The user explicitly said "throw it all away, start fresh next time." Respect that.

## Process

1. **Confirm the handoff is wanted** (if you can — skip this step if the user is
   clearly stepping away). One line: "Writing a handoff file so next session can
   pick this up — okay?"
2. **Choose a single, predictable path.** Default:
   `.minimax/handoff/<ISO-date>-<short-id>.md`. Different from world-state and
   goal files (those describe current state; handoff is the **transition**).
3. **Write the handoff file** in this exact shape:

   ```markdown
   # Handoff — <short task name>

   **Written**: <ISO timestamp>
   **Session ended because**: <one-line reason — user said stop / time up / context about to compact>
   **Handed off to**: <next session, whoever reads this first>

   ## Goal (verbatim from the user)

   <quote the user's original ask>

   ## Current state (point-in-time snapshot)

   - <state file path> — last updated <ISO>
   - <world-state file path> — last updated <ISO>
   - <goal file path> — last updated <ISO>
   - <family file path, if any> — last updated <ISO>

   ## What was done (this session)

   - [x] <step + result + key file path>
   - [x] <step>
   - [ ] <step — not done in this session, see "In progress">

   ## In progress (when we stopped)

   - **What**: <the sub-task that was running when we stopped>
   - **Where we were**: <the exact step / line / commit>
   - **Next concrete step**: <one verb-first sentence — "Run X and report Y">
   - **Blocker (if any)**: <one sentence>

   ## Open questions for next session

   - <question that, if answered, would unblock the next step>
   - <another question>

   ## Critical paths (read these first next session)

   - <file the next session absolutely must read>
   - <another file>
   - <tool / state to check>

   ## Things that might be wrong on resume

   - <state that may have changed since this handoff>
   - <file that may have been edited by another process>
   - <assumption that may no longer hold>
   ```

4. **Update the state files** (world-state, goal, family) to reference the handoff
   file by path. The next session's `world-state-tracking` read should mention "see
   handoff file X" so the next-session agent knows to read it first.

5. **Tell the user, in one line**, where the handoff is: "Handoff written to
   `.minimax/handoff/2026-08-24-xxx.md` — read this first next session."

6. **If a sub-task is in flight** (background command, async build, etc.):
   - Record its task_id, command, expected completion signal in the handoff.
   - Do not assume the sub-task will complete; the next session may need to check.

## Output contract

The user sees, in this order:

- One-line confirmation of the handoff path.
- The handoff file's contents (or a link to it).
- (If sub-task in flight) the task_id and how to check its status.
- (If open questions) the questions, so the user can answer them before the next session.

## Example

```markdown
# Handoff — Auth refactor (OIDC alongside SAML)

**Written**: 2026-08-23T23:55:00Z
**Session ended because**: user said "we'll continue tomorrow"
**Handed off to**: next session — read this first

## Goal (verbatim from the user)

> "Refactor the auth subsystem to support OIDC without breaking the existing SAML path."

## Current state (point-in-time snapshot)

- `.minimax/goal/2026-08-23-auth-oidc.md` — last updated 2026-08-23T23:55:00Z
- `.minimax/state/auth-refactor.md` — last updated 2026-08-23T23:55:00Z
- `.minimax/family/auth-refactor.md` — last updated 2026-08-23T23:55:00Z

## What was done (this session)

- [x] Mapped current auth flow in `src/auth/`
- [x] Drafted `OidcProvider` trait + one impl for `provider = "okta"`
- [x] Confirmed 12/12 existing SAML tests still pass
- [ ] Add OIDC test for happy path with mock IdP
- [ ] Update `docs/auth.md` with new config flag

## In progress (when we stopped)

- **What**: writing the OIDC happy-path test
- **Where we were**: about to add the test fixture (decided to use `oauth2-mock-server`)
- **Next concrete step**: Create `tests/auth/oidc_test.rs` with a mock server fixture
  and one login round-trip assertion
- **Blocker**: none

## Open questions for next session

- Should the OIDC module own token storage, or reuse the existing session store?
- Does IT have a preferred OIDC library (defaulting to `openidconnect`)?

## Critical paths (read these first next session)

- `/repo/src/auth/idp.rs` — current IdP interface
- `/repo/src/auth/oidc/mod.rs` — drafted OIDC implementation
- `.minimax/goal/2026-08-23-auth-oidc.md` — current goal
- `.minimax/state/auth-refactor.md` — current world state

## Things that might be wrong on resume

- `docs/auth.md` was last updated 3 days ago by another contributor; verify it still
  describes SAML only before adding OIDC docs.
- The test fixture choice (`oauth2-mock-server`) is a recent decision; confirm with
  the user before committing to it.
```

## Common pitfalls

- **Do not write the handoff after every tool call.** It is a session-end operation, not
  a checkpoint.
- **Do not skip the verbatim goal.** The next session does not have the user's voice
  in context; the verbatim quote is the only way to recover the user's exact ask.
- **Do not write vague "next steps."** "Continue the work" is not a step.
  "Create test file X with assertion Y" is.
- **Do not assume the sub-task will complete.** A background build can be killed
  between sessions; the next session must check.
- **Do not put sensitive data in the handoff.** The file is on disk. Treat it like
  any other workspace file.
- **Do not make the handoff the only place state lives.** The handoff **points to**
  state files; the state files are the source of truth, the handoff is the index.

## Verification checklist

- [ ] Is the handoff at a single, predictable path (`.minimax/handoff/...`)?
- [ ] Is the goal section copied verbatim from the user?
- [ ] Are the "done" items ✅ with file paths, and the "in progress" items ⬜ with
      exact "where we were" pointers?
- [ ] Is the "Next concrete step" one verb-first sentence?
- [ ] Are the critical paths listed (what the next session must read first)?
- [ ] Are the "might be wrong" risks named (so the next session verifies them)?
- [ ] If a sub-task is in flight, is its task_id and status-check method recorded?
- [ ] Did you tell the user where the handoff file is?
- [ ] Did you update the world-state file to reference the handoff path?
