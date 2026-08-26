---
name: acp-collab
description: Use the OpenClaw-mcode-ACP inbox to collaborate peer-to-peer with goudan (OpenClaw main session) instead of one-shot task calls. Read incoming messages, push progress, ask blocking questions, and answer peer questions. Use when working on multi-step tasks that span MiniMax Code and OpenClaw sessions, when uncertain decisions need goudan's input, or when long-running work should report progress back to the parent session.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support and an OpenClaw-mcode-ACP server reachable on http://localhost:9999.
metadata:
  author: 安天齐 (antianqi)
  homepage: https://github.com/antianqi/openclaw-mcode-acp
  version: "0.2.0"
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

The ACP server is at `http://localhost:9999`. Your `session_id` is given in the task prompt as `session_id: <id>`.

The Plugin ships its own HTTP client. There is **no `ACP_HOME` to set**, no external Python SDK to install, and no `sys.path` to mutate. The client lives at `<plugin_root>/client/_acp_client.py` and is resolved through the `ACP_PLUGIN_ROOT` environment variable (set automatically by the Plugin runtime) with a `__file__`-based fallback for ad-hoc invocations.

### Authentication

The bundled client reads the bearer token from one of (first hit wins):

1. `$ACP_TOKEN` (recommended for CI and shells)
2. `~/.acp_token` (one line, no trailing newline)
3. `<plugin_root>/.acp_token` (one line; co-located fallback for fresh installs)

The client attaches `Authorization: Bearer <token>` to every request to `http://127.0.0.1:9999/acp/*`. **Do not read, print, or pass the token yourself.** The client also refuses to follow HTTP redirects (a hostile loopback server cannot exfiltrate the token via a 302) and refuses to talk to anything other than the loopback allow-list.

If the token cannot be located, the client raises `ACPTokenMissing`. Tell the user to set `$ACP_TOKEN` (or write one of the fallback files) and stop; do not retry.

To call the client from a shell:

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
from _acp_client import (
    inbox_read, inbox_write, inbox_ask, inbox_answer,
    inbox_sessions, peer_session_id, peer_greet,
)
```

## Protocol

### 1. First message of the session (mavis announces itself)

`peer_greet()` is a goudan-side helper that posts under
`sender='goudan'`. Calling it from mavis would attribute the
message to the wrong peer. As mavis, announce yourself with
`inbox_write(sender='mavis')` instead:

```python
inbox_write(
    session_id,
    "[mavis] Starting: <one-line summary of the task>",
    sender="mavis",
)
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

If `inbox_read` shows a message with `msg_type == "question"`, answer it before continuing. `inbox_read` returns a **list** directly, not a mapping:

```python
for q in inbox_read(session_id, sender="goudan", msg_type="question", limit=1):
    # q["id"] is the question's message id (an int).
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
