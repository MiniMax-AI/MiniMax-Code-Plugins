---
name: acp-task-dispatch
description: Dispatch a self-contained task to the OpenClaw-mcode-ACP HTTP server from inside MiniMax Code. Use when a task should be persisted, retried, observed over time, or processed by a worker pool instead of the current MiniMax Code session.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support and an OpenClaw-mcode-ACP server reachable on http://127.0.0.1:9999.
metadata:
  author: 安天齐 (antianqi)
  homepage: https://github.com/antianqi/openclaw-mcode-acp
  version: "0.2.0"
---

# ACP Task Dispatch

Send a discrete, self-contained task to the OpenClaw-mcode-ACP server instead of running it inline in the current session. Useful when:

- The task is long-running and you do not want to block
- You want a persistent record (SQLite history) for later review
- A worker pool should pick it up off the queue
- You want to observe progress via SSE / WebSocket events

## Setup

The Plugin ships its own HTTP client. There is **no `ACP_HOME` to set**, no external Python SDK to install, and no `sys.path` to mutate. The client lives at `<plugin_root>/client/_acp_client.py` and is resolved through the `ACP_PLUGIN_ROOT` environment variable (set automatically by the Plugin runtime) with a `__file__`-based fallback for ad-hoc invocations.

### Authentication

The bundled client reads the bearer token from one of (first hit wins):

1. `$ACP_TOKEN` (recommended for CI and shells)
2. `~/.acp_token` (one line, no trailing newline)
3. `<plugin_root>/.acp_token` (one line; co-located fallback for fresh installs)

The client attaches `Authorization: Bearer <token>` to every request to `http://127.0.0.1:9999/acp/*`. **Do not read, print, or pass the token yourself.** The client also refuses to follow HTTP redirects (a hostile loopback server cannot exfiltrate the token via a 302) and refuses to talk to anything other than the loopback allow-list.

If the token cannot be located, the client raises `ACPTokenMissing`. Tell the user to set `$ACP_TOKEN` (or write one of the fallback files) and stop; do not retry.

## Dispatch a task

```python
import os, sys
# ACP_PLUGIN_ROOT is the directory that contains this Plugin's `client/`.
# It is set automatically when the Skill is loaded by the Plugin runtime;
# the `__file__` fallback keeps the snippet working when it is pasted
# into an ad-hoc Python session.
_plugin_root = os.environ.get('ACP_PLUGIN_ROOT') or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
sys.path.insert(0, os.path.join(_plugin_root, 'client'))
from _acp_client import create_task, get_task, history

# create_task returns the task_id as a string directly (not a dict).
task_id = create_task(
    prompt="用一句话回答:1+1=?",
    workspace="D:/some/work/dir",
    timeout=300,
)
print(task_id)
```

`create_task` is fire-and-forget. The server runs the task on a worker pool (default 3 concurrent) and persists every transition to SQLite.

## Poll for completion

```python
import time
while True:
    state = get_task(task_id)
    # The terminal success state is `succeeded`, not `completed`.
    if state["status"] in ("succeeded", "failed", "timeout", "cancelled"):
        break
    time.sleep(2)
print(state.get("answer", state.get("error")))
```

For a blocking wait that returns the final task dict directly, use `wait_task(task_id, timeout=600, poll_interval=2.0)` from the same client.

## Inspect history

```python
# `history()` returns a list of task dicts directly, not
# `{"tasks": [...]}`.
for t in history(limit=20):
    print(t["task_id"], t["status"], t.get("duration_ms"))
```

## Stream progress (optional)

`stream_task(task_id, on_event=lambda type, data: ...)` consumes the server's SSE stream and yields `{type, data}` dicts. `run_and_stream(prompt, workspace, ...)` is a convenience that creates a task, streams its events, and returns the final task dict.

## Constraints

- The `prompt` is the entire instruction given to a fresh `mcode` subprocess. It must be self-contained — the subprocess has no memory of your session.
- The `workspace` directory must exist; the server runs `mcode` with that as cwd.
- Default `timeout` is 60 seconds. Raise it for longer work, but consider `--permission full` first if the task needs to write files.
- For multi-step peer work, prefer the `acp-collab` Skill instead — this Skill is for one-shot fire-and-forget dispatch.

## Failure handling

If `create_task` raises `ACPError`, the server is likely down or rejected the request. Verify the server is reachable on `http://127.0.0.1:9999/acp/health` and that the token matches. Stop and surface the error to the user; do not retry in a tight loop.
