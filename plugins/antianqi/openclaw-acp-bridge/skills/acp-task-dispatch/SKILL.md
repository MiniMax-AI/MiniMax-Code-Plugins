---
name: acp-task-dispatch
description: Dispatch a self-contained task to the OpenClaw-mcode-ACP HTTP server from inside MiniMax Code. Use when a task should be persisted, retried, observed over time, or processed by a worker pool instead of the current MiniMax Code session.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support and an OpenClaw-mcode-ACP server reachable on http://localhost:9999.
metadata:
  author: 安天齐 (antianqi)
  homepage: https://github.com/antianqi/openclaw-mcode-acp
  version: "0.1.0"
---

# ACP Task Dispatch

Send a discrete, self-contained task to the OpenClaw-mcode-ACP server instead of running it inline in the current session. Useful when:

- The task is long-running and you do not want to block
- You want a persistent record (SQLite history) for later review
- A worker pool should pick it up off the queue
- You want to observe progress via SSE / WebSocket events

## Setup

Same as `acp-collab`. The SDK lives at `<ACP_HOME>/openclaw-skill/acp_tools.py` — `ACP_HOME` is required.

### Authentication

The SDK (not this Plugin) reads the bearer token from `$ACP_TOKEN` (or `<ACP_HOME>/.acp_token`) and attaches it to every request as `Authorization: Bearer <token>`. Do not handle the token in this Skill.

## Dispatch a task

```python
import os, sys
_acr_root = os.environ.get('ACP_HOME')
if not _acr_root:
    raise RuntimeError(
        'ACP_HOME env var is not set. Install OpenClaw-mcode-ACP and set '
        'ACP_HOME to its install path (PowerShell: $env:ACP_HOME = "<path>").'
    )
sys.path.insert(0, os.path.join(_acr_root, 'openclaw-skill'))
from acp_tools import create_task, get_task, list_history

task = create_task(
    prompt="用一句话回答:1+1=?",
    workspace="D:/some/work/dir",
    timeout=300,
)
print(task["task_id"])
```

`create_task` returns `{task_id, status, ...}`. The server runs it on a worker pool (default 3 concurrent) and persists every transition to SQLite.

## Poll for completion

```python
import time
task_id = task["task_id"]
while True:
    state = get_task(task_id)
    if state["status"] in ("completed", "failed", "timeout", "cancelled"):
        break
    time.sleep(2)
print(state.get("answer", state.get("error")))
```

## Inspect history

```python
recent = list_history(limit=20)
for t in recent["tasks"]:
    print(t["task_id"], t["status"], t.get("duration_ms"))
```

## Constraints

- The `prompt` is the entire instruction given to a fresh `mcode` subprocess. It must be self-contained — the subprocess has no memory of your session.
- The `workspace` directory must exist; the server runs `mcode` with that as cwd.
- Default `timeout` is 60 seconds. Raise it for longer work, but consider `--permission full` first if the task needs to write files.
- For multi-step peer work, prefer the `acp-collab` Skill instead — this Skill is for one-shot fire-and-forget dispatch.

## Failure handling

If `create_task` returns a non-2xx response, the server is likely down or rejected the request. Verify the server is reachable and that your environment is configured correctly (the server requires `$ACP_TOKEN` to match; this Plugin does not embed or manage credentials). Stop and surface the error to the user; do not retry in a tight loop.