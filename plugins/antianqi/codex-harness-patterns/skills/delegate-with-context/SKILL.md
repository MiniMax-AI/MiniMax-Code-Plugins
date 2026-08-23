---
name: delegate-with-context
description: "When delegating a sub-task to another agent (via `task`), prepare a minimal-context brief instead of dumping the full conversation history. Use when handing off a sub-task boundary, when a sub-agent needs the user's goal + the specific boundary + the pass condition + the minimal inputs, and when the conversation history is large enough that forwarding it all would waste tokens. Mirrors codex-rs InterAgentCommunication in Op / CollabAgentSpawnBegin."
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs (Op::InterAgentCommunication, CollabAgentSpawnBegin/End)
---

# Delegate With Context

When you spawn a sub-agent (`task` or equivalent), the brief you pass is the only thing it sees.
A bad brief makes the sub-agent re-derive the whole conversation; a good brief gives it exactly
what it needs to do its job and nothing more.

This Skill is the inverse of "pass the full history" — the full history is the most expensive
context you can give a sub-agent, and it is rarely what the sub-agent needs.

## When to use

Activate when **any** of these is true:

- You are about to call `task` (or any sub-agent spawn) to hand off a sub-task.
- The full conversation history is > 30 turns or contains large tool outputs the sub-agent
  does not need.
- The sub-task has a clear boundary (file, function, doc, test) that can be described in one
  sentence.
- You find yourself wanting to write "see the conversation above" — that is the trigger to
  stop and write an actual brief.

## When NOT to use

- The sub-agent is a simple one-shot lookup that needs verbatim context (rare; usually a
  `read` or `grep` is faster than a sub-agent).
- The sub-task boundary is fuzzy. If you cannot name the boundary, you cannot brief it —
  decompose first, then delegate.
- The work is so small that the brief would be longer than just doing it.

## Process

1. **Write the brief as a fenced block** in this exact shape, **before** calling `task`:

   ```markdown
   ## Sub-task brief

   **Goal** (one sentence, in the user's own words if possible):
   <...>

   **Boundary** (what is in scope, what is out of scope):
   - In: <...>
   - Out: <...>

   **Inputs** (only what the sub-agent needs to read; absolute paths):
   - /path/to/file.rs (function `foo`)
   - /path/to/spec.md (section 3.2 only)
   - <or "none — start from the public API contract">

   **Pass condition** (one checkable sentence):
   <...>

   **Output shape** (what the sub-agent should return):
   - A patch, a report, a single sentence, a JSON object — be specific.
   - If returning code, name the file path the patch should land in.

   **Constraints** (what NOT to do, to save round trips):
   - Do not refactor adjacent code.
   - Do not change the public API.
   - Do not introduce new dependencies.
   - <or "none">
   ```

2. **Call `task` with the brief as the prompt.** The full conversation history is *not* in
   the prompt; the brief is.
3. **Verify the brief round-tripped.** Read the sub-agent's first response. If it is solving
   the wrong problem, your brief failed — do not let it finish. Stop and re-brief.
4. **If the sub-agent needs more context mid-task**, send a follow-up brief in the same
   shape, not the original full history.
5. **On return, validate against the pass condition.** If unmet, re-dispatch with a tighter
   brief; do not patch the result yourself unless the fix is trivial.

## Output contract

The user sees, in this order:

- The Sub-task brief block (before the `task` call).
- The `task` invocation (one line).
- The sub-agent's first sentence (or its pass/fail against the pass condition).
- (If failed) the re-brief, not a silent retry.

## Example

```markdown
## Sub-task brief

**Goal**: Add a single function `format_currency(amount: f64, currency: &str) -> String` to
`src/money.rs` that formats USD with two decimals, EUR with symbol suffix, JPY with no decimals.

**Boundary**:
- In: one new function + 4 unit tests
- Out: refactoring `money.rs`, changing existing callers, adding a new file

**Inputs**:
- /repo/src/money.rs (read top of file to see the existing style)

**Pass condition**:
- `cargo test money::` green
- `format_currency(1234.5, "USD") == "$1,234.50"`
- `format_currency(1234.5, "EUR") == "1,234.50 €"`
- `format_currency(1234.0, "JPY") == "¥1,234"`

**Output shape**: a unified diff against `/repo/src/money.rs`.

**Constraints**:
- No new dependencies (no `rust_decimal`, `num-format`, etc.)
- Match the existing function signature style in `money.rs`
```

Then:

```text
> task(subagent=explore,
       prompt="<the brief above, verbatim>")
```

## Common pitfalls

- **Do not pass the full conversation history as context.** That is the failure mode this Skill
  exists to prevent. Pass the brief.
- **Do not write a brief that says "see above".** The sub-agent does not have "above".
- **Do not omit the pass condition.** Without it, the sub-agent picks its own definition of
  done, which is rarely yours.
- **Do not omit the constraints.** "Don't refactor adjacent code" saves a 3-message ping-pong.
- **Do not over-brief.** A 200-line brief for a one-function change is itself a token waste.
- **Do not under-brief.** "Look at the auth code" is a wish, not a brief.
- **Do not brief a sub-task boundary that is fuzzy.** Decompose first (`plan-stream-emit`),
  then brief the resulting steps.

## Verification checklist

- [ ] Did you write the Sub-task brief block before calling `task`?
- [ ] Is the goal one sentence in the user's voice?
- [ ] Is the boundary explicit (in / out)?
- [ ] Are the inputs absolute paths, not "look around the repo"?
- [ ] Is the pass condition one checkable sentence?
- [ ] Is the output shape specific (patch / report / JSON)?
- [ ] Did you list the constraints to head off re-work?
- [ ] Did the sub-agent's first response show it understood the brief?
