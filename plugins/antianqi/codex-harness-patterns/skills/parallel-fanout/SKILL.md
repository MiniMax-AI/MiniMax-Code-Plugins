---
name: parallel-fanout
description: |
  Decompose a task into 2+ truly independent sub-tasks and dispatch them concurrently. Pick whether to fan out explicitly, not by accident.
  USE WHEN: the user task is clearly decomposable into 2+ independent sub-tasks (independent files, independent probes, independent analyses), you would otherwise serialize work that has no real dependency, user said "in parallel" / "并行" / "fan out" / "spawn agents" / "同时跑".
  TRIGGER PHRASES: "in parallel", "parallel", "fan out", "spawn agents", "并行", "同时", "concurrent", "subagents", "multi-agent", "同时跑几个".
  SKIP WHEN: sub-tasks have a hard data dependency (output of A is input of B), the user explicitly said "sequential" / "one at a time", there is only one sub-task.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support. The example calls in this Skill are written in Codex-harness style (pseudocode) using `subagent=...` and `fork_turns=...`; MiniMax Code's `task` tool may use different parameter names. Adapt the call shape to the actual host API.
metadata:
  author: antianqi
  version: "1.0.2"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/thread_manager.rs (design principle; example parameter names are Codex-specific)
  changes-from-v1.0.1: "Rewritten to be host-agnostic. Example calls are now pseudocode with an explicit mcode adaptation note. The Skill teaches the fan-out decision, not the parameter spelling."
---

# Parallel Fanout

When the user task is clearly decomposable into 2+ **truly independent** sub-tasks, the
agent has two choices:

1. **Serialize**: do them one by one, holding the conversation hostage.
2. **Fan out**: dispatch them concurrently, aggregate the results.

This Skill is about **knowing when to choose (2)** and **how to dispatch + aggregate
cleanly** so the user gets the parallel speedup without losing correctness.

> **mcode 适配**:本 Skill 的 example 调用用 Codex-harness 风格(`task(subagent=...,
> fork_turns=...)`)作为**伪代码**。MiniMax Code 的 `task` 工具可能用不同参数名
> (`agent_type` / `brief` / `history` 等)。请**根据实际 host API 改写参数名**,
> 不要盲抄。

## When to use

Activate when **any** of these is true:

- The user task is clearly decomposable into 2+ independent sub-tasks.
- The sub-tasks touch **independent files / directories / systems** (so there is no
  shared state to corrupt).
- The user explicitly said "in parallel" / "并行" / "fan out" / "同时".
- You would otherwise serialize work that has no real dependency.

## When NOT to use

- The sub-tasks have a **hard data dependency** (output of A is the input of B).
- The user explicitly said "sequential" / "one at a time" / "按顺序".
- There is only one sub-task (no fan-out to do).
- The sub-tasks would all touch the same file (race condition risk).

## Process

1. **Decompose explicitly**. Write the list of sub-tasks in the brief header before
   dispatching anything. "Sub-tasks: A, B, C" is the single most important line.
2. **For each sub-task, decide context size** (see `fork-context-decision` Skill):
   - Self-contained sub-task? `none` (just the brief).
   - Needs prior context? `N` or `all`.
3. **Check the host's concurrency cap**. Don't fan out 50 sub-tasks if the host
   caps at 8. The agent should respect the host's buffer-unordered limit, not
   assume unlimited concurrency.
4. **Dispatch the batch**. The agent SHOULD wait for all to complete before
   aggregating — partial results are usually not useful.
5. **Aggregate per sub-task**. The aggregator MUST verify each sub-task's output
   before declaring success (use `completion-audit`).
6. **Surface the parallelism in the user-facing message**. "I dispatched 3 sub-agents
   in parallel; here are their results." The user should know fan-out actually
   happened (vs serial).

## Output contract

After activating this Skill, the agent's next message MUST include:

- The **list of sub-tasks** dispatched (one per `task` call).
- The **chosen context level** per sub-task.
- The **aggregation** result (per-sub-task outcome + overall verdict).
- A **completion audit** step (each sub-task verified).

## Common pitfalls

- **Fanning out for the sake of it** — parallelism is a tool, not a goal. If two
  sub-tasks are easier to do serially, do them serially.
- **Missing the data dependency** — the most common bug. Always check: does
  sub-task B actually need sub-task A's output? If yes, serialize.
- **Hitting the host's concurrency cap silently** — the host will queue or fail.
  Check the cap first.
- **Aggregating without verification** — one sub-task may have silently failed.
  Always read each output.
- **Using Codex-only `subagent=...` / `fork_turns=...` parameter names** — those
  are Codex-specific. Adapt to the actual host.

## Example

The example below is **Codex-harness style pseudocode** for clarity. On MiniMax Code,
the `task` tool's parameter names are **not exposed** as shown; adapt to the
actual host API.

```text
# Codex-harness style (pseudocode for design clarity):
Sub-tasks: A, B, C
Concurrency cap: 8 (from host config)

> task(subagent=explore, fork_turns=0,
       brief="A: look up X in repo 1")
> task(subagent=explore, fork_turns=0,
       brief="B: look up Y in repo 2")
> task(subagent=explore, fork_turns=0,
       brief="C: look up Z in repo 3")

# (Agent waits for all three.)
# Aggregator reads each output, audits per `completion-audit`.

# MiniMax Code style (fill in the real host API):
# Replace subagent=... with whatever mcode's task tool uses
# (e.g. agent_type="explore"), and fork_turns=0 with the actual
# context-sharing parameter or remove it.
```

The **decision** (3 sub-tasks, `none` context, wait-for-all) is the same; the
**spelling** depends on the host.

## Verification checklist

- [ ] Did you write the sub-task list in the brief header before dispatching?
- [ ] Did you check the host's concurrency cap and stay under it?
- [ ] Did you choose the right context level per sub-task (via `fork-context-decision`)?
- [ ] Did you wait for all sub-tasks to complete before aggregating?
- [ ] Did you verify each sub-task's output (via `completion-audit`)?
- [ ] Did you adapt Codex-only parameter names to the actual host API?
