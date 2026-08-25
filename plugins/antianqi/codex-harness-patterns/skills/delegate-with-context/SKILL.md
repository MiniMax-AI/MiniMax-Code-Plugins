---
name: delegate-with-context
description: |
  Hand off a sub-task to a sub-agent with a tight, complete brief — not the full conversation history. Apply the 4-part message envelope (Task name / Sender / Task / Payload + return path).
  USE WHEN: about to call `task()` to hand off a sub-task, the full conversation history is too large to forward, a minimal-context brief would do, the previous sub-agent failed because the brief was incomplete.
  TRIGGER PHRASES: "delegate", "hand off", "sub-agent", "delegate this", "delegate to", "派给", "委派", "让 sub-agent 干", "把 ... 交给 ...".
  SKIP WHEN: the sub-task is so trivial a `read` will do, you are about to do the work yourself, the user explicitly wants you (not a sub-agent) to do it.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support. The example calls use MiniMax Code's `task(agent_name=..., brief=...)` syntax with the four built-in agents.
metadata:
  author: antianqi
  version: "1.1.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs (InterAgentCommunication) and core/src/session/multi_agents.rs (CollabAgentSpawn); the 4-part envelope is the portable design; the agent_name spelling follows the actual mcode `task` tool schema
  changes-from-v1.0.2: "Examples now use MiniMax Code's `task(agent_name=...)` syntax with the four built-in agents (`explore` / `worker` / `verifier` / `mavis`). The 4-part envelope design is unchanged. Codex-harness `subagent=...` / `task_name=...` form removed. The tool-set claim (`yaml 写死`) was removed because the on-disk agent profile layout is host implementation detail, not a Skill-level contract."
---

# Delegate with Context

When handing off work to a sub-agent, the agent has two extremes:

1. **Forward everything**: the sub-agent sees the full parent history. Costs
   tokens, dilutes focus, may leak irrelevant detail.
2. **Forward nothing**: the sub-agent gets a one-line "go do X". The brief is
   almost always incomplete, and the sub-agent re-derives incorrectly.

This Skill is about the **middle ground**: a tight, complete, structured brief that
gives the sub-agent everything it needs and nothing it does not.

> **mcode 适配**:本 Skill 的 example 用 MiniMax Code `task(agent_name=..., brief=...)` 语法。
> `agent_name` 从 mcode 内置 4 agent 选:
> - `explore` — 只读(纯调查)
> - `worker` — 可改可写(实际干活)
> - `verifier` — 有 bash 不能 write(可验证)
> - `mavis` — root,full tool set
>
> `agent_name` 决定了子 agent 的工具范围(由 host 路由),不靠 brief 约束。

## When to use

Activate when **any** of these is true:

- You are about to call `task` to hand off a sub-task.
- The full conversation history is too large to forward (cost / focus).
- A previous sub-agent failed because the brief was incomplete.
- You want the sub-agent's work to be auditable against a written contract.

## When NOT to use

- The sub-task is so trivial a single `read` will do (no sub-agent needed).
- You are about to do the work yourself.
- The user explicitly wants you (not a sub-agent) to do it.

## Process

1. **Classify the sub-task** (see `fork-context-decision`):
   - Self-contained: `none` (just the brief).
   - Needs prior context: `N` or `all`.
2. **Decide the sub-agent type** (explore / worker / verifier / mavis) based on what
   the sub-task needs.
3. **Write the 4-part envelope** below. The envelope is the **portable** part of
   the brief — host `task` tools all accept a brief string.
4. **Choose context level** (see `fork-context-decision`).
5. **Document the return path** — how the sub-agent should hand the result back.

## The 4-part envelope

Every sub-agent brief MUST have these 4 parts, in order:

```text
Task name: <one short line, e.g. "investigate-lint-flake">
Sender:    <who is asking, e.g. "main agent (you)">
Task:     <one sentence: what the sub-agent must do>
Payload:  <the actual context, links, file paths, prior results>
Return:   <where the result goes, in what format>
```

Each part is mandatory. Skipping any one is the difference between a working
sub-task and a confused one.

### Field-by-field

| Field | Purpose | Bad | Good |
|---|---|---|---|
| Task name | The handle you'll refer to later. | `task1` | `investigate-lint-flake` |
| Sender | Who is asking, so the sub-agent knows the audience. | _(omitted)_ | `main agent` |
| Task | One-sentence scope. | `fix the tests` | `Investigate why test_lint.py flakes on Windows but not Linux. Produce a 1-paragraph root-cause analysis.` |
| Payload | The actual content the sub-agent needs. | `see above` | Links to the file, the prior turn's tool output, the user's exact request. |
| Return | Where the result goes, in what format. | _(omitted)_ | `Append a section to /notes/lint.md titled "## Windows flake root cause" with 1 paragraph.` |

## Common pitfalls

- **Omitting the return path** — the sub-agent finishes and has no idea what
  to do with the result. Always specify.
- **Putting the brief in `Task` and the question in `Payload`** — the sub-agent
  sees both, but the wrong field is the "one-sentence scope". Keep `Task`
  short.
- **Forwarding the full history when `none` would do** — costs tokens and
  dilutes focus. Decide first.
- **Using Codex-only `subagent=...` / `task_name=...` parameter names** —
  Codex-harness style. Adapt to the actual host API.

## Example

The example below is **Codex-harness style pseudocode** for clarity. On MiniMax
Code, the `task` tool's parameter names are **not exposed** as shown; adapt to
the actual host API.

```text
# Codex-harness style (pseudocode for design clarity):
> task(
    subagent=explore,                  # ← replace with mcode's actual param
    task_name="investigate-lint-flake",  # ← ditto
    fork_turns=0,                        # ← ditto
    brief="""
      Task name: investigate-lint-flake
      Sender:    main agent
      Task:     Investigate why test_lint.py flakes on Windows but not Linux.
                Produce a 1-paragraph root-cause analysis.
      Payload:  /home/user/proj/tests/test_lint.py (line 47 is the failure);
                prior turn tool output: <paste here if relevant>
      Return:   Append a section to /notes/lint.md titled
                "## Windows flake root cause" with 1 paragraph.
    """
  )

# MiniMax Code style (current `task` tool schema):
> task(
    agent_name="explore",
    brief="""
      Task name: investigate-lint-flake
      Sender:    main agent
      Task:     Investigate why test_lint.py flakes on Windows but not Linux.
                Produce a 1-paragraph root-cause analysis.
      Payload:  /home/user/proj/tests/test_lint.py (line 47 is the failure);
                prior turn tool output: <paste here if relevant>
      Return:   Append a section to /notes/lint.md titled
                "## Windows flake root cause" with 1 paragraph.
    """
  )
```

The **envelope** is the design; the **call shape** is host-specific.

## Verification checklist

- [ ] Did you classify the sub-task (self-contained vs context-dependent)?
- [ ] Did you write all 4 envelope parts (Task name / Sender / Task / Payload / Return)?
- [ ] Did you specify the **return path** (where the result goes)?
- [ ] Did you choose the right context level (via `fork-context-decision`)?
- [ ] Did you adapt Codex-only parameter names to the actual host `task` API?
