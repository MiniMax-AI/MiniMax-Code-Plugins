---
name: background-task
description: |
  Run long-running command as background task instead of blocking conversation.
  USE WHEN: command expected > 30s, dev server / build / watcher / test loop / `tail -f` / long npm/cargo/make output, user said "in the background" / "don't block" / "后台" / "并行跑" / "kick off", earlier foreground call timed out, want to keep talking while command runs, file sync / `fswatch` / live-reload.
  TRIGGER PHRASES: "后台", "background", "in the background", "并行跑", "don't block", "继续做别的事", "kick off the build", "start the server", "跑着不用等", "background task", "起个 server", "watch 一下".
  SKIP WHEN: command is short (<30s), output is the deliverable (read in one shot), destructive command needing exit code.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.1"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/
---

# Background Task

Run a long-running command as a background task and return control to the agent immediately.
Poll, steer, or kill it on later turns. Do not block the conversation on a 10-minute build.

## When to use

Activate when **any** of these is true:

- The command is expected to take > 30 seconds (a full `cargo test`, a `vite dev` server, a
  `webpack --watch`).
- The user has said "start the dev server in the background" / "kick off the build" / "let
  me know when it's done".
- You need to run multiple long commands and want them to overlap.
- A previous foreground call already hit a timeout.
- The command is meant to run indefinitely (`watch`, `serve`, `tail -f`) and you only need
  to read its output on demand.

## When NOT to use

- The command is short (< 30 seconds). Just run it in the foreground.
- The command's output is the entire point (a `curl` whose body you must inspect). Read it
  in one shot, not as a stream.
- The command is destructive and you need to see the result before continuing (e.g.
  `rm -rf`). Run it foreground, see the exit code, then decide.

## Process

1. **State the start plan** in one line before launching: "Starting `npm run dev` in the
   background (expected ~5s to be ready, polling every 10s)."
2. **Launch with `run_in_background: true`** (or your harness's equivalent). Pick a
   descriptive `task_name` so the user can recognise it: `dev-server`, `cargo-test`,
   `vite-watch`. Not `task1`.
3. **On launch, do not block.** Return immediately to whatever the user asked next. Do
   not poll in the same turn unless the user explicitly asked you to wait.
4. **On a later turn (or when the user asks "is it ready?"):**
   - `read` the output buffer (or `tail` the log file if you wrote one).
   - If still running, report progress and continue.
   - If exited, report the exit code and a one-line summary of the last output.
5. **On user request to stop** (or when the task is no longer needed): kill the background
   task. Confirm with the user before killing anything they explicitly started.
6. **At end of session / on `context-pressure-compact`:** list the running background tasks
   in the state file so they survive the compaction.

## Output contract

The user sees, in this order:

- One-line "starting X in background" plan.
- The launch invocation (one line, with the `task_name`).
- A short status line on every later turn that touches the task: "X: running, 3124 lines
  of output so far" / "X: exited 0, last line '...'" / "X: still running, no output yet".
- A clean "stopped X" when killed.

## Example

```text
> bash(task_name="cargo-test", run_in_background=true,
       prompt="cd /repo && cargo test --workspace 2>&1 | tee /tmp/cargo-test.log")
launched cargo-test (id: bt-7a3f); returning to user

[user asks "how's the test run?" two minutes later]

> read offset=0 limit=200 /tmp/cargo-test.log
cargo-test: running, 1234 lines of output so far
  ✓ 23 passed in 0.4s
  ✓ 7 passed in 0.2s
  …
  running 12 of 240 tests (auth::session::rotate)
  no failures yet
```

```text
[user asks "stop the test run, I want to fix the failing one manually"]

> bash(task_name="cargo-test", action="kill")
stopped cargo-test; last output preserved at /tmp/cargo-test.log
```

## Common pitfalls

- **Do not launch with `run_in_background: true` and then immediately poll in the same
  turn.** That defeats the purpose. Launch and return; poll on a later turn or when the
  user asks.
- **Do not use generic `task_name` values.** `dev-server` is good, `task1` is bad — the
  user will not know which task is which after the second background task.
- **Do not buffer the entire output in the context.** If the task writes to a log file,
  `read` with `offset` + `limit` or `tail`. Do not `cat` the whole thing.
- **Do not assume the task is healthy just because it is running.** A 5-minute `cargo test`
  with no new output is hung, not progressing. Check the log.
- **Do not forget to kill.** Background tasks that the user no longer needs are silent
  resource leaks. List them in the state file and clean up on session end.
- **Do not start a background task that writes to stdout the agent must read in real time.**
  Use a log file. Stdout from a backgrounded process is awkward to recover reliably.
- **Do not block the conversation on the task's first output.** The first output is often
  not informative (build setup, server starting, test warming up).

## Verification checklist

- [ ] Did you state the start plan in one line?
- [ ] Did you use `run_in_background: true` (or equivalent) and a descriptive `task_name`?
- [ ] Did you return to the user immediately, not block on the first output?
- [ ] Is the task's output going to a log file (so polling is cheap)?
- [ ] On later turns, is the status report one line with exit code + last line of output?
- [ ] On stop, did you confirm with the user before killing?
- [ ] Are running background tasks listed in the state file for compaction survival?
