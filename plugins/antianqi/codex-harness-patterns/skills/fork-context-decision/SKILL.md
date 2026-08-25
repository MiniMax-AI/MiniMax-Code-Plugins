---
name: fork-context-decision
description: |
  Decide how much parent context to pass to a sub-agent before spawning it. Pick "all / N turns / brief only" explicitly, not by accident.
  USE WHEN: about to call `task()` to hand off work, designing a multi-agent flow, sub-agent failed and debugging whether cause was over- or under-forking, user said "give it the full history" / "传 history" / "just the brief" / "don't carry context" / "不用 fork" / "不要带 context".
  TRIGGER PHRASES: "fork 多少", "give it the full history", "不用 fork", "传 history", "just the brief", "不要带 context", "fork 0", "fork all", "传全部对话", "不带 context".
  SKIP WHEN: sub-task is trivial (one-line read), you have already decided "no context" (no decision to make).
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support. The example calls in this Skill are written in Codex-harness style (pseudocode); MiniMax Code's `task` tool may use a different parameter name for the same concept (e.g. `brief` vs `fork_turns`) — adapt the call to the actual host API, do NOT blindly use the parameter names below.
metadata:
  author: antianqi
  version: "0.1.2"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/session/multi_agents.rs (design principle only; the example parameter names are Codex-specific)
  changes-from-v0.1.1: "Rewritten to be host-agnostic. The example calls are now pseudocode (Codex-style) with an explicit mcode adaptation note. The Skill teaches the decision, not the parameter spelling."
---

# Fork Context Decision

How much parent context to pass to a sub-agent is the **single largest cost lever** in
multi-agent work. Too much and you double the model's context; too little and the
sub-agent cannot do its job because it cannot see what came before. Pick wrong either
way, the work slows down or silently fails.

This Skill codifies the decision so the agent makes it explicitly, not by accident.

> **mcode 适配**:本 Skill 的 example 调用用 Codex-harness 风格(`fork_turns=N`)作为
> **伪代码**。MiniMax Code 的 `task` 工具可能用不同参数名表达同一概念(如 `brief`
> vs `fork_turns`)。请**根据实际 host API 改写参数名**,不要盲抄。

## When to use

Activate when **any** of these is true:

- You are about to call `task` (or any sub-agent spawn) to hand off a sub-task.
- You are designing a multi-agent flow (`parallel-fanout`, `delegate-with-context`).
- A previous sub-agent failed and you are debugging whether the cause was over- or
  under-forking.
- You are about to spawn a sub-agent and feel unsure whether to pass context or not.

## When NOT to use

- The sub-agent tool does not accept any context / fork parameter (then the decision
  is forced; skip).
- The sub-task is so trivial that the cost difference is noise (a one-line `read`).
- You have already decided "no context" (no decision to make).

## The decision

Three choices, ordered by cost:

| Choice | What the sub-agent sees | Use when |
|---|---|---|
| **all** | The full parent conversation history. | Sub-agent must reason about a prior decision, debug an earlier failure, or reuse a result the parent has already computed. |
| **N** (integer) | The last N turns. | Sub-agent needs recent context but not the full history. |
| **none** (or `0` / `brief`) | Only the brief you write inline. | Sub-task is self-contained; the brief is enough. |

### Pseudo-cost table

| Choice | Token cost | Sub-agent accuracy on context-dependent tasks | Sub-agent accuracy on self-contained tasks |
|---|---|---|---|
| `all` | 100% | high | low (distracted by noise) |
| `N` | moderate | high (if N is enough) | high |
| `none` | minimal | low | high (focused) |

## Process

1. **Classify the sub-task**. Does it need to see any prior turn?
   - If **yes**: choose `all` or `N`.
   - If **no**: choose `none` and write a self-contained brief.
2. **If you chose `N`**: pick the smallest N that still works.
   - Start at 3. If the sub-agent asks for more context, bump to 5, then 10, then `all`.
3. **Document the choice in the brief**:
   - `Context: last 3 turns (decided N=3 because the sub-task needs the prior tool output).`
4. **If the sub-agent fails**, retry with the next higher N before changing anything
   else.

## Output contract

After activating this Skill, the next `task` call MUST include the chosen context level,
either as a parameter or in the brief header:

```text
# Sub-task brief
Context level: <all | N | none>
Reason: <one sentence>
<the actual brief>
```

## Common pitfalls

- **Defaulting to `all` "to be safe"** — costs you every turn, and dilutes the
  sub-agent's focus. Only use `all` if you have a concrete reason.
- **Defaulting to `none` "to save cost"** — the sub-agent re-derives from the brief,
  and the brief is often wrong. The cost saved is the cost of the bug.
- **Not documenting the choice** — a future reviewer (or you, tomorrow) cannot tell
  why `N=3` was chosen. Document or it didn't happen.
- **Changing the brief without changing `N`** — if the brief is wrong, more context
  doesn't help. Fix the brief first.

## Example

The example below is **Codex-harness style pseudocode** for clarity. On MiniMax Code,
the `task` tool's parameter name for "how much parent context to share" may be
`brief` (a string) rather than `fork_turns` (an integer). **Adapt the call shape to
the actual host tool, do not copy this verbatim**:

```text
# Codex-harness style (pseudocode for design clarity):
> task(
    subagent=explore,
    fork_turns=3,                 # ← replace with the actual mcode param
    brief="Investigate why test_lint.py flakes on Windows. ..."
  )

# MiniMax Code style (actual API, fill in the real param name):
> task(agent_type="explore", brief="...")   # if mcode uses a `brief` field
> task(subagent="explore", history="last-3")  # if mcode uses a `history` field
```

The **decision** (3 turns) is the same; the **spelling** depends on the host.

## Verification checklist

- [ ] Did you classify the sub-task before choosing?
- [ ] Did you pick the smallest N that works (not jumping straight to `all`)?
- [ ] Did you document the choice in the brief header?
- [ ] If the sub-agent failed, did you bump N before changing the brief?
- [ ] Did you adapt the example parameter names to the actual host `task` API?
