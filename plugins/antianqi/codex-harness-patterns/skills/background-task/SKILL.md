---
name: background-task
description: |
  Decide when to put a long-running shell command in the background and how to refer to it later.
  USE WHEN: a command is expected to take > 30 seconds, the user wants a long-running process to coexist with ongoing work, you are about to block the conversation for an unbounded time, user said "background it" / "后台" / "don't block" / "non-blocking" / "run in background".
  TRIGGER PHRASES: "background", "background it", "后台", "don't block", "non-blocking", "in the background", "run async", "long-running", "put it in the background".
  SKIP WHEN: the command finishes in <5 seconds, the user explicitly wants to wait for output, the command is interactive (REPL, vim, ssh).
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support. The example calls in this Skill are written in Codex-harness style (pseudocode) using `bash(task_name=..., run_in_background=true)`; MiniMax Code's tool surface may not expose these exact parameter names — adapt the call to the actual host API.
metadata:
  author: antianqi
  version: "0.1.2"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/ and protocol::Op::CleanBackgroundTerminals (design principle only; the example parameter names are Codex-specific)
  changes-from-v0.1.1: "Rewritten to be host-agnostic. The example calls are now pseudocode with an explicit mcode adaptation note. Removed `bash(action=\"kill\")` (mcode has no such sub-action); replaced with a generic 'stop it via the host's job-control API'."
---

# Background Task

When a shell command is expected to take more than ~30 seconds, the agent has two choices:

1. **Block**: wait for the command to finish, holding the conversation hostage.
2. **Background**: launch it, get a handle, continue working, and check on it later.

This Skill is about **knowing when to choose (2)** and **how to record the handle** so
the agent (or the user) can check on it later.

> **mcode 适配**:本 Skill 的 example 调用用 Codex-harness 风格(`bash(task_name=...,
> run_in_background=true, action="kill")`)作为**伪代码**。MiniMax Code 当前
> host 工具的 `bash` 调用**不暴露** `task_name` / `run_in_background` /
> `action="kill"` 这些 sub-action 参数。请**根据实际 host 工具改写**(例如:
> 用 `Start-Process` / `nohup` / 系统的 job control 启动,然后在另一个 turn 重新
> 调 `bash` 探查)。**不要把伪代码当真实调用复制**。

## When to use

Activate when **any** of these is true:

- A command is expected to take > 30 seconds (`cargo test`, `npm install`, `docker build`,
  a long-running dev server, a large data download).
- The user explicitly says "background" / "后台" / "non-blocking" / "in the background".
- You need a long-running process to coexist with ongoing work (a dev server, a watch
  script, a streaming pipeline).
- You would otherwise block the conversation on a result the user can come back to
  later.

## When NOT to use

- The command finishes in <5 seconds.
- The user explicitly wants the output now (interactive REPL, vim, ssh, a build
  whose output the next step depends on).
- The command is interactive (it expects a TTY or human input).

## Process

1. **Estimate the duration**. If unsure, assume the worst case (> 30s). If a 2-second
   result is fine, just run it blocking.
2. **Choose a descriptive handle**. The agent (and the user) will need to recognise
   it later in the conversation. `dev-server` is good. `task1` is bad.
3. **Launch the background process using the host's job-control mechanism**:
   - Codex-harness style (pseudocode, adapt to your host):
     `bash(task_name="dev-server", run_in_background=true, command="npm run dev")`
   - MiniMax Code style (use whatever the host actually supports; e.g. `Start-Process`
     on Windows, `nohup` or `&` + `disown` on POSIX, or simply record the PID and
     re-`bash` against it on a later turn).
4. **Record the handle**. In a multi-step task, store the handle (PID, name, log
   path) somewhere persistent — in a `world-state-tracking` file, a `session-handoff`
   note, or in the running brief.
5. **Continue working**. The conversation does not block on the background process.
6. **When the result matters**, check on the process. Read its log, poll its status,
   or kill it if it is no longer needed (using the host's stop API, **not** a
   `bash(action="kill")` that does not exist on MiniMax Code).

## Output contract

After activating this Skill, the agent's next message MUST include:

- The chosen **task name / handle**.
- The **expected duration estimate**.
- The **log or status path** so a later turn can check on it.
- Whether the agent is **continuing** or **blocking** on the result.

## Common pitfalls

- **Launching and forgetting the handle** — the user comes back in an hour, the
  agent has no idea which process was which. Always record the handle.
- **Re-using a generic name** — `task1` collides; `cargo-test` does not.
- **Polling too eagerly** — a 5-minute build polled every 5 seconds wastes context.
  Poll on a sensible cadence (every minute for builds, every 5 minutes for downloads).
- **Killing without saving output** — read the log first, then kill, otherwise the
  result is lost.
- **Assuming the host supports `task_name` / `run_in_background` / `action="kill"`** —
  those are Codex-specific parameter names. MiniMax Code's `bash` tool may not
  expose them. Use the host's actual job-control mechanism.

## Example

The example below is **Codex-harness style pseudocode** for clarity. On MiniMax Code,
the `bash` tool's parameter names for background execution are **not exposed**;
adapt the call to whatever the host actually supports (e.g. `Start-Process`,
`nohup &`, PID polling, etc.).

```text
# Codex-harness style (pseudocode for design clarity):
> bash(
    task_name="dev-server",
    run_in_background=true,
    command="npm run dev"
  )

# MiniMax Code style (fill in the real host API):
# Option A: launch detached, then poll
$proc = Start-Process -FilePath "npm" -ArgumentList "run","dev" -PassThru -NoNewWindow
# record $proc.Id somewhere
# later: Get-Process -Id $proc.Id | ...

# Option B: simply run blocking, then do the next thing in the SAME turn
# (the agent's host runs them sequentially anyway)
```

The **decision** (background, with a recorded handle) is the same; the **execution
mechanism** depends on the host.

## Verification checklist

- [ ] Did you estimate the duration before choosing background vs blocking?
- [ ] Did you choose a **descriptive** name (not `task1`)?
- [ ] Did you record the handle (PID / log path) in a persistent place?
- [ ] Did you tell the user "I launched X in the background, here's the log path"?
- [ ] Did you avoid using Codex-only `bash` parameter names verbatim?
