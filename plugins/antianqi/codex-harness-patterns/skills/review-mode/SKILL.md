---
name: review-mode
description: "After completing a non-trivial chunk of work (a function, a file, a feature, a config change), switch to a critical-reviewer mode and verify the work before declaring it done. Use when a sub-task boundary is reached, when the user says 'review this' / 'double-check' / 'is this right', or before reporting 'done' on anything the user will rely on. Mirrors codex-rs EnteredReviewMode / ExitedReviewMode events in protocol/src/protocol.rs."
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs (EnteredReviewModeEvent / ExitedReviewModeEvent)
---

# Review Mode

After you write code, before you say "done", switch hats. You were the author; now you are the
reviewer. The reviewer has one job: find the things the author didn't.

This Skill is the cheapest insurance you can buy against the most common agent failure mode —
declaring a task done when it is not.

## When to use

Activate when **any** of these is true:

- A non-trivial sub-task has just finished (a function, a file, a config, a migration, a test
  suite, a doc section).
- The user said "review this", "double-check", "is this right", "spot the bug", or "any issues
  with this?".
- You are about to mark a `todowrite` step `[x]` as done and that step touches anything the
  user will rely on.
- The work crossed a trust boundary (production, public API, schema, persisted data, a contract
  someone else will code against).

## When NOT to use

- A trivial one-line edit. The marginal value of review is too low to pay the token cost.
- The user explicitly said "ship it" / "no review" / "just commit" in this turn.
- You are mid-stream on a single step and the next step will surface errors anyway (e.g.
  running the test suite next).
- The work is exploratory (a sketch, a draft, "show me what you mean"). Review it later, when
  the draft becomes a proposal.

## Process

1. **State the review scope** in one sentence before you read anything: "Reviewing the auth
   refactor: 4 files changed, new `OidcProvider` trait, SAML tests must still pass." Future you
   needs the boundary.
2. **Re-read your own output from a critic's position.** Open the file(s) you changed. Do not
   re-read the diff; read the **result**. Look for:
   - Off-by-one, wrong-sign, null/None mishandling, empty-collection edge cases.
   - Naming that lies (function called `validate` that does not validate).
   - Log/error paths that swallow useful information.
   - Tests that pass for the wrong reason (e.g. asserting `==` on a value the function never
     returns).
   - Public API surface that locks in a bad design (a struct that is too wide to evolve, a
     flag that should be an enum).
   - Comments that contradict the code.
3. **Run the verifier if there is one.** Tests, linter, type-check, schema diff, manual smoke.
   If the verifier says green, you have *evidence*; if it is silent, you have *hope*. Do not
   ship hope.
4. **Produce a verdict** in this exact shape:

   ```markdown
   ## Review — <scope>

   **Verdict**: PASS  /  PASS with caveats  /  FIX required  /  REDO

   **What I checked** (bullet list of specific things):
   - <...>

   **What I found** (concrete defects, not vibes):
   - <file:line — defect — fix>
   - (or "none")

   **What I am unsure about** (so the user can decide):
   - <...>
   - (or "nothing — the verifier ran and the design matches the spec")
   ```

5. **Apply fixes if the verdict is FIX / REDO and the fix is small.** Do not fix large things
   in review mode; surface them and start a new `plan-stream-emit` cycle.
6. **If PASS**, continue to the next step. The review record is part of the audit trail —
   keep it short but specific.

## Output contract

The user sees, in this order:

- One-line scope statement.
- The Review block above.
- (If fix) the one-line summary of what you fixed.
- (If PASS) the next concrete step.

## Example

```markdown
Reviewing the auth refactor: 4 files changed, new `OidcProvider` trait, SAML tests must still pass.

## Review — auth refactor (OIDC adapter v1)

**Verdict**: PASS with caveats

**What I checked**:
- `cargo check` on the workspace
- `cargo test auth::` (all 14 tests pass, including the 12 unchanged SAML ones)
- the new `OidcProvider` trait signature for type-correctness
- the `auth.oidc_enabled = false` default path against the existing SAML flow

**What I found**:
- `src/auth/oidc/mod.rs:42` — `expires_at` is `i64` not `u64`; future-dated tokens underflow.
  Fix applied (cast + `saturating_sub`).
- `src/auth/callback.rs:91` — error path on token exchange returns the raw HTTP body, leaks
  the client_secret on 4xx. Fix applied (redact before returning).
- nothing else

**What I am unsure about**:
- whether the OIDC `nonce` claim should be persisted in the session store; the Okta
  spec says yes, Auth0 says optional. Pick before merging.
```

## Common pitfalls

- **Do not review your own diff — review the result.** A diff makes you forgive yourself
  (you remember why each line is there). The file on disk has no such forgiveness.
- **Do not write "looks good" as a verdict.** "Looks good" is a vibe, not a finding. Name the
  specific things you checked, even if they are negative ("verified X, Y, Z are absent").
- **Do not skip the verifier step.** If there is no test, run the build. If there is no build,
  read the file with a critical eye.
- **Do not fix in review mode beyond trivial.** Anything that takes more than 2-3 minutes to
  fix is a new sub-task, not a review item. Surface it.
- **Do not produce a 50-line review report for a 5-line change.** Match the report size to
  the change size.
- **Do not review work you did not just do.** If the user asks you to review code from last
  week, this Skill's "just finished" assumption does not hold — re-anchor by stating scope.

## Verification checklist

- [ ] Did you state the review scope in one sentence?
- [ ] Did you re-read the file(s) from a critic's position, not the diff?
- [ ] Did you run the verifier (tests / lint / type-check / smoke) and cite its result?
- [ ] Is the verdict one of {PASS, PASS with caveats, FIX required, REDO}?
- [ ] Is "What I found" specific (file:line — defect — fix), not vague?
- [ ] If you applied a fix, was it trivial (< 2-3 minutes)?
- [ ] Did the user see the review record before you moved on?
