---
name: parallel-fanout
description: |
  Decompose a task into 2+ truly independent sub-tasks and dispatch them concurrently. Pick whether to fan out explicitly, not by accident.
  USE WHEN: the user task is clearly decomposable into 2+ independent sub-tasks (independent files, independent probes, independent analyses), you would otherwise serialize work that has no real dependency, user said "in parallel" / "并行" / "fan out" / "spawn agents" / "同时跑".
  TRIGGER PHRASES: "in parallel", "parallel", "fan out", "spawn agents", "并行", "同时", "concurrent", "subagents", "multi-agent", "同时跑几个".
  SKIP WHEN: sub-tasks have a hard data dependency (output of A is input of B), the user explicitly said "sequential" / "one at a time", there is only one sub-task.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support. The example calls use MiniMax Code's `task(agent_name=...)` syntax with the four built-in agents (`explore` / `worker` / `verifier` / `mavis`).
metadata:
  author: antianqi
  version: "1.1.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/thread_manager.rs (design principle); the fan-out decision and wait-for-all aggregation are portable; agent_name values follow the actual mcode `task` tool schema
  changes-from-v1.0.2: "Examples now use MiniMax Code's `task(agent_name=...)` syntax. Codex-harness `subagent=...` form removed. The earlier 'reads each agent's tool whitelist from a mcode host-internal config file' claim was dropped because the on-disk agent profile path is host implementation detail, not a Skill-level contract."
---

# Parallel Fanout

When the user task is clearly decomposable into 2+ **truly independent** sub-tasks, the
agent has two choices:

1. **Serialize**: do them one by one, holding the conversation hostage.
2. **Fan out**: dispatch them concurrently, aggregate the results.

This Skill is about **knowing when to choose (2)** and **how to dispatch + aggregate
cleanly** so the user gets the parallel speedup without losing correctness.

> **mcode 适配**:本 Skill 的 example 用 MiniMax Code `task(agent_name=...)` 语法。
> `agent_name` 从 mcode 内置 4 agent 选:
> - `explore` — 只读(只能 read/grep/glob/web_fetch),适合纯调查
> - `worker` — 可改(read/write/edit/bash/todowrite),适合实施
> - `verifier` — 有 bash 但**不能 write**,适合验证
> - `mavis` — root,full tool set,适合跨 session 综合判断
>
> `agent_name` 决定了子 agent 的工具范围(由 host 路由),不靠 brief 约束。

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

The example below uses **MiniMax Code `task` tool syntax** with the four built-in
agents. If your host uses different parameter names, adapt the call shape but
preserve the fan-out decision (3 sub-tasks, `none` context, wait-for-all).

```text
# MiniMax Code style (current `task` tool schema):
Sub-tasks: A, B, C
Concurrency cap: 8 (from host config)

> task(agent_name="explore", brief="A: look up X in repo 1")
> task(agent_name="explore", brief="B: look up Y in repo 2")
> task(agent_name="explore", brief="C: look up Z in repo 3")

# (Agent waits for all three.)
# Aggregator reads each output, audits per `completion-audit`.

# Codex-harness style (for reference only — adapt the param names):
> task(subagent=explore, fork_turns=0, brief="A: look up X in repo 1")
> task(subagent=explore, fork_turns=0, brief="B: look up Y in repo 2")
> task(subagent=explore, fork_turns=0, brief="C: look up Z in repo 3")
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
