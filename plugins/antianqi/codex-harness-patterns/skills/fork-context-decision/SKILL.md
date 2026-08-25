---
name: fork-context-decision
description: |
  Decide how much parent context to pass to a sub-agent before spawning it. Pick "all / N turns / brief only" explicitly, not by accident.
  USE WHEN: about to call `task()` to hand off work, designing a multi-agent flow, sub-agent failed and debugging whether cause was over- or under-forking, user said "give it the full history" / "传 history" / "just the brief" / "don't carry context" / "不用 fork" / "不要带 context".
  TRIGGER PHRASES: "fork 多少", "give it the full history", "不用 fork", "传 history", "just the brief", "不要带 context", "fork 0", "fork all", "传全部对话", "不带 context".
  SKIP WHEN: sub-task is trivial (one-line read), you have already decided "no context" (no decision to make).
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support. The example calls use MiniMax Code's `task(agent_name=...)` syntax with the four built-in agents. The context-sharing parameter name (here shown as `history=`) is a placeholder — adapt to whatever the actual `task` tool exposes.
metadata:
  author: antianqi
  version: "0.2.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/session/multi_agents.rs (design principle; the 3 fork modes are portable; the parameter naming follows the actual mcode `task` tool schema)
  changes-from-v0.1.2: "Examples now use MiniMax Code's `task(agent_name=...)` syntax with the four built-in agents. Replaces the Codex-only `task(subagent=..., fork_turns=...)` form. The 3 fork modes (all / N / none) and the decision framework are unchanged."
---

# Fork Context Decision

How much parent context to pass to a sub-agent is the **single largest cost lever** in
multi-agent work. Too much and you double the model's context; too little and the
sub-agent cannot do its job because it cannot see what came before. Pick wrong either
way, the work slows down or silently fails.

This Skill codifies the decision so the agent makes it explicitly, not by accident.

> **mcode 适配**:本 Skill 的 example 用 MiniMax Code `task(agent_name=..., brief=...)` 语法。
> `agent_name` 从 mcode 内置 4 agent 选:
> - `explore` — 只读(纯调查)
> - `worker` — 可改可写(实际干活)
> - `verifier` — 有 bash 不能 write(可验证)
> - `mavis` — root,full tool set
>
> `history` 参数名是**占位符**——实际 host `task` 工具可能用不同名字(如 `context_size` / `forks`)。
> **如果 host 不支持 `history` 参数**,降级为 `none`(只传 brief)。

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

The example below uses **MiniMax Code `task` tool syntax** with the four built-in
agents. If your host uses a different parameter name for context-sharing, adapt
the call shape but preserve the decision (3 turns).

```text
# MiniMax Code style (current `task` tool schema):
> task(
    agent_name="explore",          # or "worker" / "verifier" / "mavis"
    history=3,                      # ← PLACEHOLDER: host param name may differ
    brief="Investigate why test_lint.py flakes on Windows. ..."
  )

# Codex-harness style (for reference only — adapt the param name):
> task(
    subagent=explore,
    fork_turns=3,
    brief="..."
  )
```

The **decision** (3 turns) is the same; the **spelling** depends on the host.

## Verification checklist

- [ ] Did you classify the sub-task before choosing?
- [ ] Did you pick the smallest N that works (not jumping straight to `all`)?
- [ ] Did you document the choice in the brief header?
- [ ] If the sub-agent failed, did you bump N before changing the brief?
- [ ] Did you adapt the example parameter names to the actual host `task` API?
