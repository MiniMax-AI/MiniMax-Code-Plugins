---
name: acp-collab
description: Use the OpenClaw-mcode-ACP inbox to collaborate peer-to-peer with goudan (OpenClaw main session) instead of one-shot task calls. Read incoming messages, push progress, ask blocking questions, and answer peer questions. Use when working on multi-step tasks that span MiniMax Code and OpenClaw sessions, when uncertain decisions need goudan's input, or when long-running work should report progress back to the parent session.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support and an OpenClaw-mcode-ACP server reachable on http://localhost:9999.
metadata:
  author: 安天齐 (antianqi)
  homepage: https://github.com/antianqi/openclaw-mcode-acp
  version: "0.1.0"
---

# ACP Peer Collaboration

You are running inside an OpenClaw-mcode-ACP session. The other peer is `goudan` (the OpenClaw main session that dispatched you). You can communicate via the ACP inbox, not just return a final answer.

## When to activate this Skill

Activate this Skill whenever any of the following is true:

- The task spans multiple steps and goudan should see progress
- You encounter a decision that needs human judgment
- You find an ambiguity that changes the approach
- You are blocked waiting for clarification
- goudan asks you a question and you need to unblock them

## Setup

The ACP server is at `http://localhost:9999`. Your `session_id` is given in the task prompt as `session_id: <id>`. The Python SDK lives at `<ACP_HOME>/openclaw-skill/acp_tools.py` — `ACP_HOME` is required (see Requirements).

### Authentication

The SDK (not this Plugin) reads the bearer token from one of:

- `$ACP_TOKEN` environment variable (recommended for CI and shells)
- The first line of `<ACP_HOME>/.acp_token` (user-mode convenience)

The SDK attaches `Authorization: Bearer <token>` to every request to `http://127.0.0.1:9999/acp/*`. Do not read, print, or pass the token yourself; the SDK handles it.

To use the SDK from a shell:

```python
import os, sys
_acr_root = os.environ.get('ACP_HOME')
if not _acr_root:
    raise RuntimeError(
        'ACP_HOME env var is not set. Install OpenClaw-mcode-ACP and set '
        'ACP_HOME to its install path (PowerShell: $env:ACP_HOME = "<path>"). '
        'See https://github.com/antianqi/openclaw-mcode-acp for setup.'
    )
sys.path.insert(0, os.path.join(_acr_root, 'openclaw-skill'))
from acp_tools import (
    inbox_read, inbox_write, inbox_ask, inbox_answer,
    inbox_sessions, peer_session_id, peer_greet,
)
```

## Protocol

### 1. Greet goudan (first action of the session)

```python
peer_greet(session_id, "[mavis] Starting: <one-line summary of the task>")
```

### 2. Push progress (during work)

```python
inbox_write(
    session_id,
    "[mavis] Step 3 of 7 done. Found 3 candidate schemas.",
    sender="mavis",
)
```

### 3. Ask a blocking question (when uncertain)

```python
result = inbox_ask(
    session_id,
    "Schema has 3 variants: A (加盟商), B (门店), C (订单). Which one?",
    sender="mavis",
    timeout=120,
)
# result == {"question_id": <int>, "answer": "<string>"} on success
# result == {"error": "timeout", "question_id": <int>} on timeout
if "error" in result:
    raise RuntimeError(f"goudan did not answer within 120s (qid={result['question_id']})")
choice = result["answer"]
```

### 4. Answer goudan's question (when asked)

If `inbox_read` shows a message with `msg_type == "question"`, answer it before continuing:

```python
pending = inbox_read(session_id, sender="goudan", msg_type="question", limit=1)
for q in pending.get("messages", []):
    inbox_answer(q["id"], "<your answer>")
```

### 5. Final report (end of session)

```python
inbox_write(
    session_id,
    "[mavis] DONE. Files: <list>. Decision: <one line>.",
    sender="mavis",
)
```

## Constraints

- **Asking is cheaper than redoing.** When uncertain, ask. Do not invent schema, filenames, or decisions.
- One question per `inbox_ask`. Multi-part questions get only the first answer; split them.
- Never write with `sender="goudan"` — you are `mavis`.
- Use `timeout <= 300`. If longer is needed, push progress first, then ask.
- Always send a final report so goudan knows you finished.

## Failure handling

If the ACP server is unreachable, fall back to your final-answer channel and note that peer communication was skipped. Do not silently retry in a loop.