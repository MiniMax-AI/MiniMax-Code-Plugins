---
name: plan-stream-emit
description: |
  Before touching files on a non-trivial task, emit a structured plan and surface to the user for early course-correction.
  USE WHEN: non-trivial task, multi-step task, ambiguous requirement, would take > 3 tool calls, user has not approved an approach yet, user said "plan first" / "before you start" / "let me see your approach" / "先出计划" / "出方案", crossing trust boundary (production, public repo, irreversible action).
  TRIGGER PHRASES: "plan first", "先出计划", "let me see", "出方案", "确认一下", "先别动手", "想清楚再开始", "before you start", "我看看方案", "出 plan", "出计划".
  SKIP WHEN: single one-shot question, user already gave numbered list of steps, trivially reversible, "do X" with X being one line.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.1"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs (PlanUpdate / PlanDelta)
---

# Plan Stream Emit

For any non-trivial task, emit a structured plan first and let the user see it before you start
changing files. A plan is a list of small, ordered, named steps with explicit pass conditions —
not prose, not a single "I'll do X" line.

## When to use

Activate when **any** of these is true:

- The user request is multi-step (more than 3 distinct actions).
- The task is ambiguous in any way: which file, which API, which framework, which version.
- The user request is large enough that getting it wrong would cost more than 2 minutes of
  re-work.
- The user said "plan first" / "before you start" / "let me see your approach".
- The task crosses a trust boundary (production code, public repo, irreversible action).

## When NOT to use

- A single one-shot question or one-line edit.
- The user already gave a numbered list of steps ("do 1, 2, 3, 4 in order").
- The task is trivially reversible and the cost of a wrong move is near zero.

## Process

1. **Stop and think before any tool call.** Do not start `bash`, `read`, or `write` until the
   plan is on the page.
2. **Write the plan** as a `todowrite` list, in this exact shape:

   ```markdown
   ## Plan — <short task name>

   - [ ] **Step 1**: <verb-first sentence, names the file/action>
         Pass: <one-line checkable condition>
   - [ ] **Step 2**: <verb-first sentence, names the file/action>
         Pass: <one-line checkable condition>
   - [ ] **Step 3**: <verb-first sentence, names the file/action>
         Pass: <one-line checkable condition>
   - [ ] **Step 4** (optional, only if needed): <...>
   - [ ] **Step N** (always): Verify — <how you confirm the whole task is done>
   ```

3. **Add an "Open questions" section** if any step has un-resolved ambiguity:

   ```markdown
   ## Open questions

   - <question that, if answered, would change the plan>
   - <another question>
   ```

4. **Surface the plan to the user** with a one-sentence preamble: "Here is my plan — I will
   start with Step 1 once you confirm or correct it." Do not begin executing until the user
   acks, **unless** the user has previously said "just go" or "no need to check in for this".
5. **Update the plan as you go.** When a step is done, mark it complete and emit the next
   step's status. If reality diverges from the plan, **stop and re-plan** rather than silently
   re-routing.
6. **Final step is always a Verify** — how the agent will confirm the whole task is done
   (test pass, manual smoke, file existence check, etc.).

## Output contract

The user sees, in this order:

- One-sentence preamble acknowledging the plan is coming.
- The `## Plan` block.
- (Optional) The `## Open questions` block.
- A clear stop point: "I'll start Step 1 once you confirm" (or, if pre-authorised, "Starting
  Step 1.").

After execution, the user sees the same plan with `[x]` checks updating live, and a final
Verify line that names what was actually checked.

## Example

```markdown
I'll plan the migration before touching files.

## Plan — Migrate auth to OIDC alongside SAML

- [ ] **Step 1**: Read src/auth/idp.rs and src/auth/callback.rs to map the current interface.
      Pass: I can name every public function and its caller in one sentence.
- [ ] **Step 2**: Sketch the OidcProvider trait and one stub impl in a new file
      src/auth/oidc/mod.rs.
      Pass: `cargo check` passes with the new module imported.
- [ ] **Step 3**: Wire the new provider into the login/callback dispatch in src/auth/mod.rs,
      gated on a config flag `auth.oidc_enabled`.
      Pass: existing SAML tests still pass; `auth.oidc_enabled = false` is the default.
- [ ] **Step 4**: Add one happy-path test for OIDC login with a mock IdP.
      Pass: `cargo test auth::oidc` is green.
- [ ] **Step 5**: Document the new config flag in docs/auth.md.
      Pass: docs/auth.md lists `oidc_enabled`, `oidc_issuer`, `oidc_client_id`.
- [ ] **Verify**: Run the full test suite + a manual smoke against the dev OIDC sandbox.

## Open questions

- Do you have a preferred OIDC library (openidconnect crate vs oauth2 + manual JWKS)?
- Should the OIDC path share the session store with SAML, or own its own?
```

## Common pitfalls

- **Do not emit a plan and then ignore it.** Every tool call should map to a step. If reality
  diverges, **stop and re-plan**, do not silently re-route.
- **Do not write prose plans.** "I'll look at the code and then maybe refactor" is not a plan.
  Every step names an action and a pass condition.
- **Do not skip the Verify step.** The user must be able to trust the agent to confirm the
  whole task is done, not just the last file edit.
- **Do not over-plan trivial work.** A 3-line bug fix is one step. Save the structure for work
  that needs it.
- **Do not surface a plan and immediately barrel into Step 1.** The user must have a chance to
  redirect cheaply, before you have committed to a path.
- **Do not re-plan without telling the user.** "I am going to re-plan because Step 2 hit a
  wall" is a one-line update; the user expects it.

## Verification checklist

- [ ] Did the plan come before any tool call?
- [ ] Is every step a verb-first sentence with a pass condition?
- [ ] Did you include a final Verify step?
- [ ] Did you list Open questions instead of guessing on ambiguity?
- [ ] Did the user have a chance to confirm or redirect?
- [ ] Did you update the plan as steps completed, rather than drifting silently?
- [ ] At the end, did the Verify step actually run and pass?
