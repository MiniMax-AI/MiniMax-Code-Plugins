# OpenClaw ACP Bridge

> Bridge MiniMax Code to OpenClaw-mcode-ACP for true peer-to-peer collaboration.

## What this Plugin solves

MiniMax Code (the desktop coding agent) is powerful on its own, but its default interaction model is **one-shot**: you give it a prompt, it produces an answer, you walk away. There is no first-class channel for `mcode` (running in a child session) to ask the parent (`goudan` in OpenClaw) a clarifying question, push intermediate progress, or collaborate on a multi-step task across sessions.

[OpenClaw-mcode-ACP](https://github.com/antianqi/openclaw-mcode-acp) is an HTTP + WebSocket server that wraps `mcode` and exposes:

- **Task dispatch** (queue + worker pool, with persistent SQLite history)
- **Peer-to-peer inbox** (`goudan` ↔ `mavis`, with blocking `ask` and `answer`)
- **Streaming events** (SSE one-way + WebSocket bidirectional)

This Plugin teaches MiniMax Code how to use that inbox as a **peer** instead of a one-shot executor.

## Try it

After installing this Plugin, give MiniMax Code a multi-step task that requires judgment and cross-session state:

```text
Read the 3 XLS files under D:/data/q3/ and pick the canonical schema.
Push progress to goudan via the acp-collab inbox.
When the schema is ambiguous, block and ask goudan instead of guessing.
Write the final decision back to the inbox.
```

Expected behavior:

1. MiniMax Code reads the files and posts a progress message to the inbox.
2. When schema is ambiguous, it calls `inbox_ask` and blocks server-side.
3. You (or goudan) answer the question.
4. MiniMax Code continues and writes a final progress message.

## Skills included

- `acp-collab` — peer collaboration via inbox (read, write, blocking ask, answer) **[mavis side]**
- `acp-task-dispatch` — send a self-contained task to the ACP server from inside MiniMax Code
- `acp-inbox-bridge` — goudan-side companion: lets the OpenClaw main agent drive the same inbox from the goudan perspective. **Added in v0.3.0.** See [Goudan-side companion](#goudan-side-companion) below.

## Requirements

- MiniMax Code desktop app with Agent Plugins 1.0 support
- A running OpenClaw-mcode-ACP server **v7-bidir or later** (default: `http://127.0.0.1:9999`)
- Python 3.10+ on `PATH`
- A bearer token that the server accepts. The Plugin reads it from (first hit wins):
  - `$ACP_TOKEN` environment variable (recommended for CI and shells)
  - `~/.acp_token` (one line, no trailing newline)
  - `<plugin_root>/.acp_token` (one line; co-located fallback for fresh installs)

The Plugin does **not** require `openclaw-mcode-acp` source checkout, `ACP_HOME`, or any external Python SDK. The HTTP client is bundled inside the Plugin at `client/_acp_client.py`.

### Supported platforms

| Platform | Status |
| --- | --- |
| Windows 10/11 | Supported (primary) |
| macOS 13+ | Supported |
| Linux (x86_64) | Supported |

The Plugin uses forward slashes internally (`posixpath`) and only ever resolves the plugin root through the `ACP_PLUGIN_ROOT` environment variable (set automatically by the Plugin runtime) with a `__file__`-based fallback. There are no hardcoded absolute paths in any Skill code, this README, or the bundled smoke test.

## Authentication

The server requires every request to carry `Authorization: Bearer <token>`. The **bundled client** (at `client/_acp_client.py`) reads the token on first call from the locations listed in Requirements. The Skills do not handle the token themselves; they import the client and call its public functions.

Security properties of the bundled client (each is verified by the bundled `scripts/smoke.py` and `scripts/test_no_redirect.py`):

- **No redirects.** Every token-bearing request is dispatched through an `OpenerDirector` whose `HTTPRedirectHandler` is replaced with a subclass that raises `HTTPError` on any 3xx. A loopback server that returns 302 cannot exfiltrate the token to another local origin.
- **Loopback-only.** The client refuses to talk to anything not on `{127.0.0.1, ::1, [::1]}`. A misconfigured `ACP_BASE_URL` cannot redirect the token to a remote host.
- **Single opener.** The same opener is used by `scripts/smoke.py`, the no-redirect regression test, and every Skill call. There is no "smoke test only" path: the no-redirect guarantee in the smoke test is the no-redirect guarantee in the Skills.

The token is never sent to a remote host, never logged to disk, and never echoed to the model.

**Rules for the Agent:**

- Do not read, print, log, or include the token in any user-facing output. If a command would expose the token (`echo $ACP_TOKEN`, `env | grep TOKEN`, etc.), refuse and explain.
- Do not ask the user to paste the token into chat. If it is missing, tell them to set `$ACP_TOKEN` (or write one of the fallback files) and stop.
- Do not pass the token as a parameter to any Skill function. The client reads it directly from the environment.

## Goudan-side companion

Added in v0.3.0. The `acp-collab` and `acp-task-dispatch` Skills above are
written for **mavis** (running inside MiniMax Code). v0.3.0 adds the
goudan-side perspective so the **OpenClaw main agent** (goudan) can also
drive the inbox from its own session.

| | mavis side | goudan side |
| --- | --- | --- |
| Skill | `acp-collab` | `acp-inbox-bridge` (v0.3.0) |
| Default `sender` | `mavis` | `goudan` |
| Audience | MiniMax Code child session | OpenClaw main session |
| Wrapper | None (calls `client/_acp_client.inbox_*` directly) | `scripts/acp_inbox.py` (thin class API) |
| Smoke test | `scripts/smoke.py` | `scripts/test_inbox_goudan.py` |

Both sides drive the **same** `client/_acp_client.py` HTTP transport, so
the loopback-only, no-redirect, token-via-env security model is shared
unchanged. The wrapper is a class API; it does not reimplement HTTP.

```python
# goudan-side: proactive message
import os, sys
_plugin_root = os.environ.get("ACP_PLUGIN_ROOT") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
sys.path.insert(0, os.path.join(_plugin_root, "scripts"))
from acp_inbox import ACPInbox

acp = ACPInbox()
acp.write("goudan-mavis-001", "found 1 cron failure: list files in memory/")
result = acp.ask("goudan-mavis-001", "retry or disable?", timeout=120)
print(result["answer"])
```

The full goudan-side workflow is documented in
[`skills/acp-inbox-bridge/SKILL.md`](skills/acp-inbox-bridge/SKILL.md).

## Client API contract

The bundled client (`client/_acp_client.py`) exposes the following functions. All except `health()` and `peer_session_id()` / `peer_greet()` carry the bearer token. Every request goes through the no-redirect opener, and every `base_url` is checked against the loopback allow-list before the first request.

| Function | Auth | Returns |
| --- | --- | --- |
| `health()` | no | `{status, version, ...}` dict |
| `create_task(prompt, workspace, files?, timeout?)` | yes | `task_id` (string) |
| `get_task(task_id)` | yes | task dict |
| `wait_task(task_id, timeout?, poll_interval?)` | yes | final task dict (polls `get_task`) |
| `cancel_task(task_id)` | yes | updated task dict |
| `history(status?, workspace?, limit?, since?)` | yes | list of task dicts |
| `list_tasks(limit?)` | yes | list of task dicts (in-memory) |
| `stream_task(task_id, on_event?)` | yes | iterator of `{type, data}` (SSE) |
| `run_and_stream(prompt, workspace, ..., on_event?)` | yes | final task dict (create + stream) |
| `stats()` | yes | queue + DB summary |
| `inbox_write(session_id, content, sender, msg_type?, parent_id?)` | yes | `message_id` (int) |
| `inbox_read(session_id, since_id?, sender?, msg_type?, limit?)` | yes | **list** of message dicts (auto-marked-read) |
| `inbox_ask(session_id, question, sender, timeout?)` | yes | `{question_id, answer?, error?}` |
| `inbox_answer(question_id, answer)` | yes | `answer_id` (int) |
| `inbox_sessions(limit?)` | yes | list of session summaries |
| `peer_session_id(prefix?)` | no | fresh session id string (local only) |
| `peer_greet(session_id, message)` | yes | message id; **hard-codes `sender='goudan'`**, so mavis should not call this — use `inbox_write(sender='mavis')` instead |

The terminal success state for `create_task` is `succeeded`, not `completed`. Polling code should check for `succeeded` / `failed` / `timeout` / `cancelled`.

The client endpoints are cross-checked against `server/acp-server.py` in the upstream `antianqi/openclaw-mcode-acp` repository at the `v7-bidir+` revision. If a future server release breaks the contract, this Plugin's version must be bumped to `0.3.x` and a migration note added to `CHANGELOG.md`.

## Verify the Plugin works (smoke test)

Before installing into MiniMax Code, run the bundled smoke test to confirm the Plugin can talk to your server:

```bash
export ACP_TOKEN=<the token your server was started with>
python plugins/antianqi/openclaw-acp-bridge/scripts/smoke.py
```

The smoke test (no MiniMax Code required) validates:

1. The bundled `client/_acp_client.py` parses and imports cleanly.
2. The token resolver returns a non-empty value when `$ACP_TOKEN` (or a fallback file) is set.
3. The loopback guard accepts the documented hosts and refuses everything else.
4. The server's `/acp/health` returns HTTP 200 within 5 seconds (no auth required).
5. An inbox write/read roundtrip succeeds (uses `$ACP_TOKEN` through the bundled client).
6. The bundled no-redirect opener is in fact the one used by `_acp_client._OPENER` (i.e. the Skill runtime and the smoke test share the same opener).
7. Plugin SKILL.md files resolve the plugin root through `ACP_PLUGIN_ROOT` (or a `__file__` fallback) — no hardcoded `D:/openclaw-acp` or similar absolute paths.

Exits 0 on full pass, 1 on any failure. CI-friendly (exits non-zero on any failed assertion).

A second test, `scripts/test_no_redirect.py`, is a regression test for the
**no-redirect policy** on token-bearing requests. It stands up two local
HTTP servers (a redirector and a capture endpoint) and proves that
`$ACP_TOKEN` never reaches the capture server even when the first
server responds with 302. Run it the same way:

```bash
python plugins/antianqi/openclaw-acp-bridge/scripts/test_no_redirect.py
```

Unlike earlier revisions, this test drives requests through the **same**
`_acp_client` module the Skills use at runtime (it imports
`_acp_client._OPENER` directly), so the assertion is no longer "the
smoke test's opener refuses redirects" but "the runtime's opener refuses
redirects" — the property the review called out in v0.1.3 is now
verified end-to-end.

## Data and network

- Calls `http://127.0.0.1:9999` (HTTP loopback only; no remote endpoints)
- No network calls outside the loopback allow-list
- No telemetry, no remote services, no third-party APIs
- No tokens, credentials, or paid services
- Standard library only (no `pip install` required for the runtime client)

## Test evidence

Validated on 2026-08-26 against OpenClaw-mcode-ACP v7-bidir:

- Plugin-bundled `scripts/smoke.py`: 7/7 checks pass (opener/loopback/health/inbox roundtrip/SKILL.md path resolution/etc.)
- No-redirect regression test `scripts/test_no_redirect.py`: 3/3 assertions pass (302 refused, capture clean, GET 200) — **the test now drives the same `_acp_client` module the Skills import**
- All 5 HTTP inbox endpoint tests pass (`/acp/inbox/write`, `/read`, `/ask`, `/answer`, `/sessions`)
- Stub-mavis ↔ goudan end-to-end demo: 14 messages exchanged in ~3 seconds, including blocking questions and answers

### CI

A GitHub Actions workflow at `.github/workflows/openclaw-acp-bridge-smoke.yml` runs `scripts/smoke.py` and `scripts/test_no_redirect.py` on every push and PR targeting `main`. The workflow no longer checks out any external SDK; the bundled client is the only thing under test. The latest run output is the source of truth for whether the Plugin works.

## Limitations

- This Plugin is **instructive** — MiniMax Code follows the Skills and calls Python via its shell tool. It does not inject code into MiniMax Code itself.
- For tightest integration, prefer running `mcode` via the ACP server CLI (`acp_cli.py` in the upstream repository) instead of dispatching tasks manually.
- The blocking `ask` timeout defaults to 300 seconds. Longer waits require pushing progress first.

## See also

- Project home: https://github.com/antianqi/openclaw-mcode-acp
- Project intro (for sharing): https://github.com/antianqi/openclaw-mcode-acp/blob/main/docs/PROJECT_INTRO.md
- CHANGELOG (real bugs we hit and fixed): https://github.com/antianqi/openclaw-mcode-acp/blob/main/CHANGELOG.md
