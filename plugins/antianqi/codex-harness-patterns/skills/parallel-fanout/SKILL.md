---
name: parallel-fanout
description: |
  Decompose a task into 2+ truly independent sub-tasks and dispatch them concurrently via separate `task()` calls. Pick whether to fan out explicitly, not by accident.
  USE WHEN: the user task is clearly decomposable into 2+ independent sub-tasks (independent files, independent probes, independent analyses), you would otherwise serialize work that has no real dependency, user said "in parallel" / "并行" / "fan out" / "spawn agents" / "同时跑".
  TRIGGER PHRASES: "in parallel", "parallel", "fan out", "spawn agents", "并行", "同时", "concurrent", "subagents", "multi-agent", "同时跑几个".
  SKIP WHEN: sub-tasks have a hard data dependency (output of A is input of B), the user explicitly said "sequential" / "one at a time", there is only one sub-task.
license: Apache-2.0
compatibility: Targets MiniMax Code 0.2.4 `task` tool. Verified against the bundled `cli.js` schema. Each sub-task is a separate `task()` call with its own `description` / `prompt` / `agent_name`. `agent_name` is canonical (`explore` / `worker` / `verifier`); `mavis` is the root agent, not a sub-agent.
metadata:
  author: antianqi
  version: "1.2.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/thread_manager.rs (design principle); the fan-out decision and wait-for-all aggregation are portable; on mcode each sub-task is a discrete `task()` call
  changes-from-v1.1.0: "Replaced `subagent_type=` with the canonical mcode `agent_name=`. Replaced `brief=` with `prompt=`. Dropped `mavis` from the sub-agent list (mavis is the root). Dropped the Codex-harness pseudocode block; mcode 0.2.4 is the only shape shown. The 'concurrency cap' step now references mcode's own per-session buffer-unordered limit instead of a hypothetical host config."
---

# Parallel Fanout

When the user task is clearly decomposable into 2+ **truly independent** sub-tasks, the
agent has two choices:

1. **Serialize**: do them one by one, holding the conversation hostage.
2. **Fan out**: dispatch them concurrently, aggregate the results.

This Skill is about **knowing when to choose (2)** and **how to dispatch + aggregate
cleanly** so the user gets the parallel speedup without losing correctness.

## mcode 0.2.4 surface

Each sub-task is a separate `task()` call:

```text
task(
  description:    string,            // 3-5 word label, required
  prompt:         string,            // the brief, required
  agent_name:  "explore" | "worker" | "verifier",  // required
  run_in_background?: boolean        // optional; usually false for fan-out
)
```

The agent dispatches all the calls in a single response; mcode executes them
concurrently subject to the host's per-session buffer-unordered limit (8 by
default in 0.2.4; check the runtime config if unsure). The agent then waits
for all to complete before aggregating.

`agent_name` is the canonical mcode spelling. `agent_name=` is accepted as
a runtime alias but the Skills prefer canonical. `mavis` is the root agent
not a sub-agent; do not pass it as `agent_name`.

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
   - Self-contained sub-task? `none` (just the brief in `prompt`).
   - Needs prior context? `N` or `all` → inline the prior content into `prompt`.
3. **Check mcode's per-session buffer-unordered limit**. Default in 0.2.4 is 8
   concurrent `task` calls. If you have more sub-tasks, the host will queue or
   fail — split the batch or use `run_in_background: true` and poll
   `task_output` later.
4. **Dispatch the batch** in a single response. mcode runs them concurrently
   subject to the buffer-unordered limit.
5. **Wait for all to complete**. The aggregator MUST verify each sub-task's
   output before declaring success (use `completion-audit`).
6. **Surface the parallelism in the user-facing message**. "I dispatched 3
   sub-agents in parallel; here are their results." The user should know
   fan-out actually happened (vs serial).

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
- **Hitting mcode's buffer-unordered limit silently** — the host will queue or
  fail. Check the limit first; if you have more than 8, run them in waves.
- **Aggregating without verification** — one sub-task may have silently failed.
  Always read each output.
- **Using `agent_name="mavis"`** — mavis is the root, not a sub-agent.
  Use `explore` / `worker` / `verifier`.
- **Writing the sub-task brief in a separate `brief=` field** — mcode 0.2.4
  has no `brief` field. The brief goes in `prompt`.

## Example

The example below is **MiniMax Code 0.2.4 `task` tool syntax**. The fan-out
is 3 sub-tasks, all `none` context, all dispatched in one response, mcode
runs them concurrently.

```text
# Sub-tasks: A, B, C
# Concurrency cap: 8 (mcode 0.2.4 default)
# Context level: none (all sub-tasks are self-contained)
# Aggregation: read each output, run completion-audit, then summarize

> task(
    description="Look up X in repo 1",
    agent_name="explore",
    prompt="""
      Task name: lookup-X-repo1
      Task:     Find every file in <repo1> that imports `X`.
      Return:   List of <repo1>/<path> files, one per line.
    """
  )

> task(
    description="Look up Y in repo 2",
    agent_name="explore",
    prompt="""
      Task name: lookup-Y-repo2
      Task:     Find every file in <repo2> that imports `Y`.
      Return:   List of <repo2>/<path> files, one per line.
    """
  )

> task(
    description="Look up Z in repo 3",
    agent_name="explore",
    prompt="""
      Task name: lookup-Z-repo3
      Task:     Find every file in <repo3> that imports `Z`.
      Return:   List of <repo3>/<path> files, one per line.
    """
  )

# (Agent waits for all three.)
# Aggregator reads each output, audits per `completion-audit`.
```

The **decision** (3 sub-tasks, `none` context, wait-for-all) is the same; the
**call shape** is what mcode 0.2.4 actually exposes.

## Verification checklist

- [ ] Did you write the sub-task list in the brief header before dispatching?
- [ ] Did you stay under mcode's per-session buffer-unordered limit (default 8)?
- [ ] Did you choose the right context level per sub-task (via `fork-context-decision`)?
- [ ] Did you wait for all sub-tasks to complete before aggregating?
- [ ] Did you verify each sub-task's output (via `completion-audit`)?
- [ ] Did you use `agent_name` from `{explore, worker, verifier}` (not `mavis`)?
- [ ] Did you put the sub-task brief in the `prompt` field (not a separate `brief`)?
