---
name: world-state-tracking
description: |
  Track running state of long task in a single dedicated file that survives compaction.
  USE WHEN: task is long, agent has lost thread, user asks "where are we" / "到哪了" / "我们到哪了", before `context-pressure-compact`, `todowrite` alone is too thin, agent has done > 10 tool calls, "lost the thread" / "继续" / "忘了".
  TRIGGER PHRASES: "where are we", "到哪了", "我们到哪了", "继续", "lost thread", "忘了", "lost the thread", "我们刚才说到哪了", "走神了", "回到主线".
  SKIP WHEN: short task (<5 tool calls), single one-shot question, "do X" with X being small.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.1"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/context/world_state.rs
---

# World State Tracking

Keep a single dedicated state file that records the *shape* of the running task — the goal,
the decisions, the blockers, the next step, the key paths. Unlike the conversation history,
this file is **structured, finite, and survives compaction**. It is the agent's answer to
"where are we?" when the context window is full.

## When to use

Activate when **any** of these is true:

- The task is long enough that the agent has lost the thread at least once already.
- The user asks "where are we?", "what's the status?", "are we still on track?", or "remind
  me what we decided".
- You are about to apply `context-pressure-compact` (the state file is what survives it).
- The task has 3+ open decisions whose rationale you don't want to re-derive every turn.
- Multiple sub-agents (or the user and the agent) need a shared ground truth.

## When NOT to use

- A short task (< 5 turns, no major decisions yet). The state file is overhead.
- The whole task fits in a `todowrite`. Use that instead — it is already structured state.
- The state would duplicate information that lives in source files (e.g. the migration
  plan already lives in `docs/migrations/auth.md`; do not restate it here).

## Process

1. **Pick a single, predictable path.** Default:
   `.minimax/state/<YYYY-MM-DD>-<short-id>.md` (or, for repos without a working dir, a
   tmp file under `/tmp/`). The path is part of the contract — re-read it from the same
   place every turn.
2. **Initialise the file the first time you activate this Skill.** Use this exact shape:

   ```markdown
   # World State — <short task name>

   **Started**: <ISO date>
   **Owner**: <agent name or "main">
   **Last updated**: <ISO timestamp>

   ## Goal

   <one paragraph, in the user's own words, copied from the original request>

   ## Current phase

   <one of: scoping | planning | executing | verifying | blocked | done>

   ## Decisions (with one-line rationale)

   - <decision> — <reason>
   - <decision> — <reason>

   ## Done

   - [x] <step + result + key file path or identifier>
   - [x] <...>

   ## In progress

   - [ ] <step + where you stopped + the next concrete sub-step>

   ## Blockers / open questions

   - <question that, if answered, would unblock the next step>

   ## Next concrete step

   <one verb-first sentence — "Edit X to add Y", "Run Z and report output", etc.>

   ## Key file paths

   - /abs/path/that/the/next/turn/will/need
   ```

3. **Update the file at every meaningful boundary**, not every turn. Boundaries are:
   - End of a `todowrite` step.
   - End of a sub-task handed to a `task` call.
   - Right before a `context-pressure-compact`.
   - Immediately after a user redirection.
   At each update: bump `Last updated`, move items between Done / In progress, add new
   Decisions, and refresh the Next concrete step.
4. **On every new turn, read the file first** (use `read`). It is your 30-line ground truth.
   Do not skim the conversation history to "get back up to speed" — read the state file.
5. **At `context-pressure-compact` time**, the state file is what survives — the noisy
   middle does not. The compact summary should reference the state file by path, not
   duplicate its contents.

## Output contract

The user sees:

- The path to the state file (one line, at the top of any meaningful response).
- On request: a short, *complete* snapshot of the state (the file contents, optionally
  abbreviated).
- On update: a one-line "State updated: <new Last updated>".

## Example

```markdown
# World State — Auth refactor (OIDC alongside SAML)

**Started**: 2026-08-23
**Owner**: main
**Last updated**: 2026-08-23T23:55:00Z

## Goal

Refactor the auth subsystem to support OIDC as a first-class provider alongside the existing
SAML path, without breaking any of the 12 existing SAML tests.

## Current phase

planning

## Decisions (with one-line rationale)

- Keep SAML on the legacy code path; OIDC gets a parallel module. — SAML contract is frozen,
  no test budget to re-validate.
- Reject "generic Provider with config-driven dispatch" — too much config surface for
  marginal benefit.
- Use the `openidconnect` crate (not hand-rolled oauth2). — JWKS, PKCE, state, nonce all
  solved; saves ~400 lines.

## Done

- [x] Mapped current auth flow in `src/auth/`. Wrote findings to `.minimax/snapshots/auth-flow.md`.
- [x] Confirmed test coverage: 12 of 14 files have unit tests (2 missing: `logout`, `session`).

## In progress

- [ ] Drafting the `OidcProvider` trait. Stopped at: how to represent the provider enum
  vs the existing `IdP` interface. Three options on the table; see Open questions.

## Blockers / open questions

- Should the OIDC module own token storage, or reuse the existing session store?
- Does IT have a preferred OIDC library? (defaulting to `openidconnect`)

## Next concrete step

Draft the `OidcProvider` trait + one impl for `provider = "okta"`, then show the diff to
the user before touching `src/auth/callback.rs`.

## Key file paths

- /repo/src/auth/idp.rs
- /repo/src/auth/callback.rs
- /repo/tests/auth/
- /repo/docs/auth.md
```

## Common pitfalls

- **Do not put prose in the state file.** Prose is what the conversation history is for. The
  state file is structured, finite, and machine-grepable.
- **Do not update on every turn.** Update at boundaries. A state file that changes every
  line is just a noisy transcript.
- **Do not duplicate source-of-truth info.** If the API contract lives in `docs/api.md`,
  the state file says "see docs/api.md", not "the API contract is ...".
- **Do not let the state file grow unbounded.** A 500-line state file is no longer a state
  file; it is a journal. If it grows past ~80 lines, split it (e.g. `state.md` +
  `decisions.md`) or compact.
- **Do not forget the path.** If you can name the path from memory every turn, the state
  file is doing its job. If you cannot, move it to a more obvious place.
- **Do not use the state file as a substitute for `todowrite`.** The state file is the
  long-form ground truth; `todowrite` is the short-form live checklist. They coexist.

## Verification checklist

- [ ] Is the state file at a single, predictable path the agent can name from memory?
- [ ] Is it initialised with the full 9-section shape on first activation?
- [ ] Is it updated at boundaries (steps, sub-tasks, compactions, redirections), not every
      turn?
- [ ] Does every new turn start with `read` of the state file, not a conversation skim?
- [ ] Is the state file < ~80 lines? If not, split or compact.
- [ ] Does `context-pressure-compact` reference the state file by path, not duplicate it?
- [ ] Can a new sub-agent orient itself in < 30 seconds by reading only the state file?
