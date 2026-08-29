---
name: background-task
description: |
  Decide when to launch a long-running task in the background and how to refer to it later. Covers both the `task` tool (sub-agent background via `run_in_background: true`) and the `bash` tool (shell background via `run_in_background: true`).
  USE WHEN: a sub-agent is expected to take > 1 minute, a shell command is expected to take > 30 seconds, the user wants a long-running process to coexist with ongoing work, you are about to block the conversation for an unbounded time, user said "background it" / "后台" / "don't block" / "non-blocking" / "run in background".
  TRIGGER PHRASES: "background", "background it", "后台", "don't block", "non-blocking", "in the background", "run async", "long-running", "put it in the background".
  SKIP WHEN: the sub-agent / command finishes in <5 seconds, the user explicitly wants to wait for output, the command is interactive (REPL, vim, ssh).
license: Apache-2.0
compatibility: Targets MiniMax Code 0.2.4. Verified against the bundled `cli.js` schema. `task(...)` accepts `run_in_background: true` and returns a `task_id` for later `task_query` / `task_output` / `task_stop`. `bash(...)` accepts `run_in_background: true` and returns a job handle. The Codex-harness `bash(task_name=..., run_in_background=true, action="kill")` shape is **not** the mcode surface — mcode's `bash` has no `task_name` or `action` field; killing is via `task_stop(task_id=...)` for sub-agents and via the host's job-control API for shell jobs.
metadata:
  author: antianqi
  version: "0.2.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/ and protocol::Op::CleanBackgroundTerminals (design principle only; the mcode 0.2.4 surface is `task(run_in_background=true)` + `task_query` / `task_output` / `task_stop` for sub-agents, and `bash(run_in_background=true)` for shell jobs)
  changes-from-v0.1.2: "Replaced the v0.1.2 'Codex-harness pseudocode + adapt the call' block with the actual mcode 0.2.4 surface. mcode `task` and `bash` both accept `run_in_background: true`; for sub-agents the returned handle is a `task_id` queried with `task_query` / `task_output` / `task_stop`. The Codex-harness `bash(task_name=..., action=\"kill\")` shape is removed because mcode's `bash` has neither `task_name` nor an `action` sub-action field (the validator in `cli.js:xza` only allows `command` / `timeout` / `run_in_background`). Killing a sub-agent uses `task_stop(task_id=...)`; killing a shell background job uses the host's own job-control API (the example now shows `Stop-Process -Id` on Windows and `kill -PID` on POSIX, both invoked through a foreground `bash` call rather than a fake `action=\"kill\"` field)."
---

# Background Task

When a task (a sub-agent invocation or a shell command) is expected to take
more than ~30 seconds, the agent has two choices:

1. **Block**: wait for the task to finish, holding the conversation hostage.
2. **Background**: launch it, get a handle, continue working, and check on it later.

This Skill is about **knowing when to choose (2)** and **how to record the
handle** so the agent (or the user) can check on it later.

## mcode 0.2.4 surface

There are two background-capable tools on mcode 0.2.4, and the right one depends
on whether the background work is a sub-agent or a shell command.

### Sub-agent background: `task(run_in_background: true)` + `task_query` / `task_output` / `task_stop`

The canonical `task` schema:

```text
task(
  description:    string,            // 3-5 word label, required
  prompt:         string,            // the brief, required
  agent_name:  "explore" | "worker" | "verifier",  // required
  run_in_background?: boolean        // optional; true = async, false = sync (default)
)
```

When `run_in_background: true`, mcode returns immediately with a `task_id`.
The companion tools (also canonical in `cli.js`):

| Tool | Purpose | Required fields |
|---|---|---|
| `task_query(task_id?, status?)` | List session tasks (omit `task_id`) or get one. | `task_id` for single fetch; `status` filter optional. |
| `task_output(task_id, offset?)` | Read a task's output incrementally. | `task_id` (required); `offset` (optional, byte offset for long output). |
| `task_stop(task_id, reason?)` | Request a background task to stop. | `task_id` (required); `reason` (optional, human-readable). |

`run_in_background: false` (the default) blocks the calling turn until the
sub-agent finishes and returns its final result.

### Shell background: `bash(run_in_background: true)`

The `bash` tool's canonical schema (from `cli.js:xza`):

```text
bash(
  command:         string,    // required
  timeout?:        number,    // optional, seconds
  run_in_background?: boolean // optional; true = async, false = sync (default)
)
```

When `run_in_background: true`, the `bash` call returns immediately with a
job handle that the host's job-control API can target (Windows:
`Stop-Process -Id <pid>`; POSIX: `kill <pid>`, both invoked through a
foreground `bash` call rather than any `action="kill"` field). The exact
shape of the returned handle is not part of the public mcode 0.2.4 runtime
contract; the host's job-control API is the source of truth for the
underlying process id. **There is no `task_name=` and no `action="kill"`
field.** The Codex-harness shape `bash(task_name=..., run_in_background=true,
action="kill")` is **not** the mcode surface — mcode's `bash` validator
rejects any key outside `command` / `timeout` / `run_in_background`.

Killing a shell background job: invoke the host's job-control API in a
**foreground** `bash` call. Windows: `Stop-Process -Id <pid>`. POSIX:
`kill <pid>`. The Skills do not pretend `bash(action="kill")` exists on
mcode 0.2.4.

## When to use

Activate when **any** of these is true:

- A sub-agent is expected to take > 1 minute (deep research, multi-file
  refactor, anything you cannot predict the duration of).
- A shell command is expected to take > 30 seconds (`cargo test`, `npm install`,
  `docker build`, a long-running dev server, a large data download).
- The user explicitly says "background" / "后台" / "non-blocking" / "in the background".
- You need a long-running process to coexist with ongoing work (a dev server, a
  watch script, a streaming pipeline).
- You would otherwise block the conversation on a result the user can come back
  to later.

## When NOT to use

- The task / command finishes in <5 seconds.
- The user explicitly wants the output now (interactive REPL, vim, ssh, a build
  whose output the next step depends on).
- The command is interactive (it expects a TTY or human input).

## Process

1. **Estimate the duration**. If unsure, assume the worst case. The mcode
   `task` tool description (`run_in_background`) says "Set to true when the
   sub-task is open-ended or expected to take more than ~1 minute (deep
   research, multi-step investigation, large refactors, anything you cannot
   predict the duration of), so you can keep working and the result is
   reported back automatically when it completes. Leave false (the default)
   for short, well-scoped sub-tasks whose result you need right now to
   continue. When in doubt for a long or uncertain task, prefer true."
2. **Choose a descriptive handle**. The agent (and the user) will need to
   recognise it later. `dev-server` is good. `task1` is bad.
3. **Launch in the background using the matching tool**:
   - Sub-agent: `task(..., run_in_background: true)`; mcode returns a
     `task_id`. Store it.
   - Shell: `bash(command: "npm run dev", run_in_background: true)`; mcode
     returns a job handle (the exact shape is not part of the public
     runtime contract; the host's job-control API is the source of
     truth). Store the handle.
4. **Record the handle**. In a multi-step task, store the handle (task_id,
   job id, log path) somewhere persistent — in a `world-state-tracking` file,
   a `session-handoff` note, or in the running brief.
5. **Continue working**. The conversation does not block on the background
   task.
6. **When the result matters**:
   - Sub-agent: `task_query(task_id)` for status, `task_output(task_id)` for
     output, `task_stop(task_id)` to stop.
   - Shell: foreground `bash` call against the host's job-control API
     (`Get-Process -Id <pid>` / `Stop-Process -Id <pid>` on Windows;
     `ps -p <pid>` / `kill <pid>` on POSIX). Read the log file or stdout
     from the original launch.

## Output contract

After activating this Skill, the agent's next message MUST include:

- The chosen **handle** (`task_id` or job id) and the **tool** that produced it
  (`task` / `bash`).
- The **expected duration estimate**.
- The **log or status path** so a later turn can check on it.
- Whether the agent is **continuing** or **blocking** on the result.

## Common pitfalls

- **Launching and forgetting the handle** — the user comes back in an hour,
  the agent has no idea which process was which. Always record the handle.
- **Re-using a generic name** — `task1` collides; `cargo-test` does not.
- **Polling too eagerly** — a 5-minute build polled every 5 seconds wastes
  context. Poll on a sensible cadence (every minute for builds, every 5 minutes
  for downloads).
- **Killing without saving output** — read the log first, then kill, otherwise
  the result is lost.
- **Using Codex-only `bash(task_name=..., action="kill")` syntax** — mcode
  0.2.4's `bash` does not have those fields. Use `task_stop(task_id=...)` for
  sub-agents and a foreground `bash` call to the host's job-control API for
  shell jobs.
- **Passing `model_config_id` in a background `task()` call** — the `task`
  tool does not accept it (see `model-router`). The model is the session's
  current model.

## Example

The example below is **MiniMax Code 0.2.4 `task` / `bash` tool syntax**. Two
background launches are demonstrated.

### Sub-agent background

```text
# Launch a long-running research sub-agent in the background.
# mcode returns a task_id we can later query / read / stop.

> task(
    description="Research migration paths",
    agent_name="explore",
    run_in_background=true,
    prompt="""
      Investigate migration paths from <lib-A> to <lib-B> in the
      <repo> codebase. Produce a markdown report at
      <repo>/notes/migration.md comparing the top 3 candidates
      with code samples, risk notes, and a recommended path.
      This may take 10+ minutes; you can take your time.
    """
  )
# Returns immediately with:
#   { task_id: "tsk_01HXYZ...", status: "queued" }

# Later, check status:
> task_query(task_id="tsk_01HXYZ...")
#   { task_id: "tsk_01HXYZ...", status: "running", ... }

# Read partial output (the report grows as the sub-agent works):
> task_output(task_id="tsk_01HXYZ...", offset=0)
#   <partial markdown content>
#   next_offset: 12345

# Stop it if the user changed their mind:
> task_stop(task_id="tsk_01HXYZ...", reason="user changed scope")
#   { task_id: "tsk_01HXYZ...", status: "stopping" }
```

### Shell background

```text
# Launch a long-running dev server in the background.
# mcode returns a job id we can later target via the host's job-control API.

> bash(
    command="npm run dev",
    run_in_background=true
  )
# Returns immediately with a job handle. The exact shape is not
# part of the public mcode 0.2.4 runtime contract; the host's
# job-control API is the source of truth. Treat the handle as
# opaque and pass it to the host's job-control API in a
# foreground `bash` call (e.g. `Stop-Process -Id <pid>` /
# `kill <pid>` on POSIX) when you need to stop the job.

# Later, check whether it is still alive (foreground bash call):
> bash(
    command="Get-Process -Id 12345 | Select-Object Id,ProcessName,StartTime"
  )
# (or on POSIX: `ps -p 12345 -o pid,etime,cmd`)

# Stop it when done (foreground bash call to the host's job-control API):
> bash(
    command="Stop-Process -Id 12345"
  )
# (or on POSIX: `kill 12345`)
```

The **decision** (background, with a recorded handle) is the same; the
**execution mechanism** depends on whether the background work is a sub-agent
(use `task` + `task_query` / `task_output` / `task_stop`) or a shell command
(use `bash(run_in_background: true)` + the host's job-control API).

## Verification checklist

- [ ] Did you estimate the duration before choosing background vs blocking?
- [ ] Did you choose a **descriptive** handle (not `task1`)?
- [ ] Did you use the right tool — `task` for sub-agents, `bash` for shell
      commands?
- [ ] Did you set `run_in_background: true` (not Codex's `bash(task_name=...)`)?
- [ ] Did you record the handle (task_id / job id / log path) in a persistent place?
- [ ] Did you tell the user "I launched X in the background, here's the handle and
      log path"?
- [ ] If you stopped it, did you use `task_stop(task_id=...)` (sub-agent) or
      `Stop-Process` / `kill` via a foreground `bash` call (shell)?
