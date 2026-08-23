---
name: fork-context-decision
description: "When spawning a sub-agent, decide how much parent context to give it via the `fork_turns` parameter. Use every time you call `task` (or equivalent) to hand off work — the choice between `all` / `none` / a positive integer is one of the largest cost levers in multi-agent work. Mirrors the `fork_turns` semantics in codex-rs/ext/goal/src/multi_agents.rs (V2 multi-agent protocol)."
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/session/multi_agents.rs
---

# Fork Context Decision

`fork_turns` is the **single largest cost lever** in multi-agent work. `all` doubles your
context, `none` forces the sub-agent to re-derive from a brief, and the integer in between
is a precision knob. Pick wrong and you either pay main-model prices for routine work, or
you spawn a sub-agent that cannot do its job because it cannot see what came before.

This Skill codifies the decision so you make it explicitly, not by accident.

## When to use

Activate when **any** of these is true:

- You are about to call `task` (or any sub-agent spawn) to hand off a sub-task.
- You are designing a multi-agent flow (`parallel-fanout`, `delegate-with-context`).
- A previous sub-agent failed and you are debugging whether the cause was over- or
  under-forking.
- You are about to spawn a sub-agent and feel unsure whether to pass context or not.

## When NOT to use

- The sub-agent tool does not support a fork / context parameter (this Skill is then
  irrelevant; skip).
- The sub-task is so trivial that the cost difference is noise (a one-line `grep`).
- You have already decided `fork_turns=0` or `none` (i.e. you have already chosen "no
  context") and there is no decision to make.

## The 3 fork modes

| Mode | What the sub-agent sees | Cost | When to use |
|---|---|---|---|
| **`all`** (default if omitted) | All of parent's history | **High** — sub-agent pays for every turn you took | Sub-agent needs the *exact* reasoning that led to the current state. Rare. |
| **`N`** (positive integer) | Last N turns of parent | **Medium** — proportional to N | Sub-agent needs the *recent* context (the last few tool calls / decisions) but not the full history. Most common. |
| **`none`** (or `0`) | Nothing — pure brief | **Low** — only the brief | Sub-agent can do its job from a well-written brief alone. The default for `parallel-fanout`. |

## Decision framework

Before every `task` call, ask:

1. **Can the sub-agent do the job from the brief alone?**
   - **Yes** → `none`
   - **No** → continue

2. **Does it need recent decisions / tool outputs to do the job?**
   - "Recent" = the last 3-10 turns
   - **Yes** → `N` where N ≈ the number of turns that contain the needed context
   - **No** → continue

3. **Does it need the full reasoning that led here?**
   - This is rare. Most sub-tasks do not.
   - **Yes** → `all` (and consider whether the sub-agent should be a continuation of the
     main agent instead of a fresh sub-agent)

4. **Will the cost of `all` be acceptable?**
   - If `all` would push the sub-agent over its own budget, choose `N` or `none`.
   - If the sub-task is cheap and the cost of failure is high, `all` may be worth it.

## Output contract

Every time you call `task`, the user sees:

- The chosen mode (`all` / `N` / `none`) in the brief or in a one-line preamble.
- A one-sentence reason: "fork=N because the brief alone misses the X decision made 3
  turns ago."

## Process

1. **State the chosen mode** in the brief, before writing the rest of it. This forces an
   explicit decision.
2. **For `N`**, name the specific turns / events the sub-agent needs to see. Do not just
   write `N=5`; write `N=5 because the last 5 turns contain the X decision`.
3. **For `none`**, the brief must be self-contained. If the brief references "the
   conversation above" or "what we just decided," you have made a mistake — `none` requires
   a complete brief.
4. **For `all`**, explicitly justify why the sub-agent needs the full history. Default
   suspicion: you do not need `all`; you need `N`.

## Example

```text
> task(subagent=explore, run_in_background=true,
       fork_turns=0,
       prompt="<self-contained brief, see below>")
launched explore (id: 5a3f); fork=none because the brief is self-contained
```

```text
> task(subagent=explore, run_in_background=true,
       fork_turns=3,
       prompt="The last 3 turns contain the design decision; resume from there.
               <rest of brief>")
launched explore (id: 6b2c); fork=3 because the sub-task picks up after the auth redesign
decision
```

```text
> task(subagent=explore, run_in_background=true,
       fork_turns=all,  // rare
       prompt="<brief>")
launched explore (id: 7c1a); fork=all because this sub-agent IS the continuation of the
debugging session
```

## Common pitfalls

- **Do not default to `all`.** It is the most expensive answer. The Skill exists to move
  work *off* `all`, not to confirm the obvious.
- **Do not default to `none` if the brief is incomplete.** An under-forked sub-agent will
  fail silently. It is better to over-fork than under-fork on the first attempt; downgrade
  on retry.
- **Do not pick `N` without naming the turns.** "N=5" is not a decision; "N=5 because the
  last 5 turns contain the X decision" is.
- **Do not pick `all` "to be safe."** It is not safer; it is expensive. Safety comes from
  a well-scoped brief + an explicit decision, not from dumping history.
- **Do not change the fork mode mid-stream.** If you started with `none` and the
  sub-agent comes back saying "I need more context," do not re-spawn with `all`; instead,
  send a follow-up `send_message` (or equivalent) with the specific context it needs.
  Re-spawning wastes the work it already did.

## Verification checklist

- [ ] Did you choose `all` / `N` / `none` explicitly, not by leaving the default?
- [ ] Is the chosen mode justified in the brief or in a one-line preamble?
- [ ] For `N`: did you name the specific turns the sub-agent needs?
- [ ] For `none`: is the brief self-contained (no references to "above" or "earlier")?
- [ ] For `all`: did you explicitly justify why the full history is needed?
- [ ] Is the cost of the chosen mode acceptable (no surprise over-budget)?
- [ ] If a sub-agent came back saying "I need more context," did you send a follow-up
      message rather than re-spawning with `all`?
