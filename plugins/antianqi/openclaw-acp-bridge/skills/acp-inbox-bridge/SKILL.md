---
name: acp-inbox-bridge
description: Use the OpenClaw-mcode-ACP inbox from inside an OpenClaw main session (goudan) to PROACTIVELY send messages, ask blocking questions, and answer mavis-side questions. Differs from `acp-collab` (mavis / MiniMax Code perspective) — this is the goudan-side companion that uses the same `client/_acp_client.inbox_*` HTTP transport and inherits the same loopback-only, no-redirect, token-via-env security model. Use when a multi-step task spans the OpenClaw main session and a MiniMax Code peer, when goudan should report progress or findings to mavis, when goudan needs to ask a clarifying question that requires a mavis-side tool (e.g. reading `~/.minimax/`), or when mavis has asked a question and goudan must answer it before continuing.
license: Apache-2.0
compatibility: Requires an OpenClaw-mcode-ACP server reachable on http://127.0.0.1:9999 and the openclaw-acp-bridge Plugin installed (so `client/_acp_client.py` is on the path).
metadata:
  author: 安天齐 (antianqi)
  homepage: https://github.com/antianqi/openclaw-mcode-acp
  version: "0.3.0"
---

# ACP Inbox Bridge — goudan (OpenClaw) perspective

You are running inside an OpenClaw main session (goudan). The other peer
is `mavis` (MiniMax Code, dispatched as a child session). You can
communicate via the ACP inbox — not just return a final answer.

This is the goudan-side companion to the `acp-collab` Skill. `acp-collab`
teaches mavis how to talk to you; this Skill teaches you how to talk to
mavis. Both Skills drive the same `client/_acp_client.inbox_*` HTTP
transport, so the loopback-only, no-redirect, token-via-env security
model is shared.

## When to activate this Skill

Activate this Skill whenever any of the following is true:

- You are running a long task and mavis should see progress
- You found an issue (cron failure, audit anomaly, bridge timeout) that
  mavis needs to act on
- You need a piece of mavis-side state (e.g. a file under
  `~/.minimax/`, a memory note, the OAuth token expiry) that you cannot
  read from your own domain
- mavis has asked you a question via the inbox and you need to unblock
  them with a `msg_type=answer`
- A decision needs human judgment and mavis is closer to the human than
  you are

Do NOT activate this Skill to bypass the domain boundary: do not use it
to read `~/.minimax/` directly, to read mavis-side logs, or to probe
mavis-side processes. The inbox is for **messaging**, not for direct
file or process access on the mavis side.

## Setup

The bundled client at `<plugin_root>/client/_acp_client.py` is the same
one the mavis-side Skills use. There is **no `ACP_HOME` to set**, no
external Python SDK to install, and no `sys.path` to mutate. The
goudan-side wrapper `scripts/acp_inbox.py` resolves the plugin root
through `$ACP_PLUGIN_ROOT` (set by the Plugin runtime) with a
`__file__`-based fallback for ad-hoc invocations.

### Authentication

The bundled client reads the bearer token from one of (first hit wins):

1. `$ACP_TOKEN` (recommended for shells and CI)
2. `~/.acp_token` (one line, no trailing newline)
3. `<plugin_root>/.acp_token` (one line; co-located fallback)

The client attaches `Authorization: Bearer <token>` to every request to
`http://127.0.0.1:9999/acp/*`. **Do not read, print, or pass the token
yourself.** The client also refuses to follow HTTP redirects and refuses
to talk to anything other than the literal loopback allow-list
(`{127.0.0.1, ::1, [::1]}`). The round-5 amendment removed `localhost`
from the allow-list to avoid DNS / hostname resolution attacks.

If the token cannot be located, the client raises `ACPTokenMissing`.
Tell the user to set `$ACP_TOKEN` (or write one of the fallback files)
and stop; do not retry.

### Calling the goudan-side wrapper

```python
import os
import sys
# ACP_PLUGIN_ROOT is the directory that contains this Plugin's `client/`.
# It is set automatically when the Skill is loaded by the Plugin runtime;
# the `__file__` fallback keeps the snippet working when it is pasted
# into an ad-hoc Python session.
_plugin_root = os.environ.get("ACP_PLUGIN_ROOT") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
sys.path.insert(0, os.path.join(_plugin_root, "scripts"))
from acp_inbox import ACPInbox

acp = ACPInbox()
```

## Protocol

### 1. First message of the session (goudan announces itself)

Use `acp.greet(session_id, note=...)` to write a `peer_greet`-shaped
message. The default `sender` is `"goudan"` — never pass
`sender="mavis"` from this side.

```python
acp.greet(session_id, note="starting audit cross-check for 8/31")
```

### 2. Push progress (during work)

```python
acp.write(session_id, "[goudan] Step 3 of 7 done. Found 3 candidate cron failures.")
```

### 3. Ask a blocking question (when mavis is the only one who can answer)

Use `acp.ask(...)` to write a question and block for the answer. The
server's `/acp/inbox/ask` endpoint handles the blocking poll; the
wrapper delegates. Default `timeout` is 30s; the mavis-side Skill's
`acp-collab` enforces `timeout <= 300`, so do not exceed that.

```python
result = acp.ask(
    session_id,
    "Cron 'Wiki auto-整理' is failing on `list files in memory/`. Should I retry, disable, or have mavis patch the tool?",
    timeout=120,
)
if "error" in result:
    # timeout / no answer within the budget
    raise RuntimeError(f"mavis did not answer within 120s (qid={result['question_id']})")
answer = result["answer"]
```

### 4. Answer mavis's question (when asked)

If `acp.read(...)` shows a message with `msg_type == "question"` from
mavis, answer it before continuing. `acp.read` returns a list of
message dicts, each with an `id` (int) that you pass to `acp.answer`:

```python
for q in acp.read(session_id, sender="mavis", msg_type="question"):
    # q["id"] is the question's message id
    acp.answer(q["id"], "Yes, retry the cron; the failure is a non-fatal tool error.")
```

### 5. Final report (end of session)

```python
acp.write(
    session_id,
    "[goudan] DONE. 5 anomalies, 2 retried, 3 escalated to mavis.",
)
```

## Constraints

- **Asking is cheaper than redoing.** When uncertain, ask. Do not invent
  cron fix paths, audit-id interpretations, or bridge config decisions.
- One question per `acp.ask`. Multi-part questions get only the first
  answer; split them.
- Never write with `sender="mavis"`. You are goudan. mavis is the
  mavis-side Skill's job.
- Use `timeout <= 300`. If longer is needed, push progress first, then
  ask.
- Always send a final report so mavis knows you finished.
- Do not echo raw JSON or large tool outputs in messages; parse and
  summarize.

## RAW mode (LLM rate-limit bypass)

If you (or your LLM) is hitting a `5h Token Plan` rate limit, you can
post a message whose content starts with `RAW:` and the
`goudan_inbox_responder.py` daemon will execute it as a raw
`openclaw <subcommand> --json` call without going through the LLM. This
is useful for fast data fetches when the LLM is throttled.

```
RAW: sessions --active 1440 --limit 30
RAW: cron list
RAW: audit --after 1788105600000 --before 1788192000000 --limit 50
```

The daemon enforces a 60-second subprocess timeout. The output is
written to the inbox as a `message` (not an `answer`).

## Failure handling

- If the ACP server is unreachable, fall back to your final-answer
  channel and note that peer communication was skipped. Do not silently
  retry in a loop.
- If `acp.ask` times out, push progress (`acp.write` with
  `msg_type="progress"`) and decide whether to escalate, retry, or
  skip the question.
- If the token is missing, raise `ACPTokenMissing` upstream and tell
  the user to set `$ACP_TOKEN` (or write one of the fallback files).

## Differs from `acp-collab`

| | `acp-collab` | `acp-inbox-bridge` (this) |
| --- | --- | --- |
| Audience | mavis (MiniMax Code) | goudan (OpenClaw main) |
| Default sender | `mavis` | `goudan` |
| Client API | `inbox_write / inbox_read / inbox_ask / inbox_answer / inbox_sessions` directly | `ACPInbox` class wrapping the same functions |
| Skill file | `skills/acp-collab/SKILL.md` | `skills/acp-inbox-bridge/SKILL.md` (this file) |
| Python wrapper | None (Skills call the client directly) | `scripts/acp_inbox.py` |
| Smoke test | `scripts/smoke.py` (mavis-side) | `scripts/test_inbox_goudan.py` (goudan-side) |
| Security model | Loopback-only, no-redirect, token-via-env, no hardcoded path. **All of these are shared via `client/_acp_client.py`.** | Same. |

Both Skills drive the same `client/_acp_client.py` module. The wrapper
in `scripts/acp_inbox.py` is a thin class API for callers that prefer
OO over function calls; it does not reimplement HTTP.
