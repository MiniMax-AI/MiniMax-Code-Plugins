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

- `acp-collab` — peer collaboration via inbox (read, write, blocking ask, answer)
- `acp-task-dispatch` — send a self-contained task to the ACP server from inside MiniMax Code

## Requirements

- MiniMax Code desktop app with Agent Plugins 1.0 support
- A running OpenClaw-mcode-ACP server **v7-bidir or later** (default: `http://localhost:9999`)
- Python 3.10+ on `PATH`
- **OpenClaw-mcode-ACP source checkout location** — must be exposed via the `ACP_HOME` environment variable. The Plugin never hardcodes a path. Example:
  - PowerShell: `$env:ACP_HOME = 'D:\path\to\openclaw-mcode-acp'`
  - bash / zsh: `export ACP_HOME=/path/to/openclaw-mcode-acp`

### Supported platforms

| Platform | Status | Path example for `ACP_HOME` |
| --- | --- | --- |
| Windows 10/11 | Supported (primary) | `D:\path\to\openclaw-mcode-acp` |
| macOS 13+ | Supported | `/Users/you/path/to/openclaw-mcode-acp` |
| Linux (x86_64) | Supported | `/home/you/path/to/openclaw-mcode-acp` |

The Plugin uses forward slashes internally (`posixpath`) and only ever resolves paths through `ACP_HOME`. There are no hardcoded absolute paths in any Skill code, this README, or the bundled smoke test.

## Authentication

The server requires every request to carry `Authorization: Bearer <token>`. The **Plugin does not read or store the token itself** — it is read by the bundled Python SDK at `<ACP_HOME>/openclaw-skill/acp_tools.py`, which on each call:

1. Reads `$ACP_TOKEN` from the environment (recommended for CI and shells).
2. If unset, reads the first line of `<ACP_HOME>/.acp_token` (user-mode convenience).
3. Sends the token as `Authorization: Bearer <token>` to `http://127.0.0.1:9999/acp/*` (HTTP loopback only).

The token is never sent to a remote host, never logged to disk, and never echoed to the model. The Plugin's Skills only call the SDK; they never construct HTTP requests or read the token directly.

**Rules for the Agent:**

- Do not read, print, log, or include the token in any user-facing output. If a command would expose the token (`echo $ACP_TOKEN`, `env | grep TOKEN`, etc.), refuse and explain.
- Do not ask the user to paste the token into chat. If it is missing, tell them to set `ACP_TOKEN` (or write `<ACP_HOME>/.acp_token`) and stop.
- Do not pass the token as a parameter to any Skill function. The SDK reads it directly from the environment.

## SDK compatibility contract

This Plugin assumes the following functions exist in `<ACP_HOME>/openclaw-skill/acp_tools.py` (server **v7-bidir+**). If any of them disappear or change signature in a future server release, the Plugin will break:

| Function | Required | Notes |
| --- | --- | --- |
| `create_task(prompt, workspace, timeout)` | yes | returns `{task_id, status, ...}` |
| `get_task(task_id)` | yes | returns `{status, answer?, error?, duration_ms?}` |
| `list_history(limit)` | yes | returns `{tasks: [...]}` |
| `inbox_read(session_id, sender?, msg_type?, limit?)` | yes | returns `{messages: [...]}` |
| `inbox_write(session_id, text, sender)` | yes | returns `{ok: bool}` |
| `inbox_ask(session_id, question, sender, timeout)` | yes | blocks server-side until answered or timeout |
| `inbox_answer(question_id, text)` | yes | unblocks the asker |
| `peer_greet(session_id, text)` | yes | first message in a peer session |

If a future server release breaks this contract, this Plugin's version must be bumped to `0.2.x` and a migration note added to `CHANGELOG.md`.

## Verify the Plugin works (smoke test)

Before installing into MiniMax Code, run the bundled smoke test to confirm the Plugin can talk to your server:

```bash
export ACP_HOME=/path/to/openclaw-mcode-acp
export ACP_TOKEN=<the token your server was started with>
python scripts/smoke.py
```

The smoke test (no MiniMax Code required) validates:

1. `$ACP_HOME` resolves to an existing directory containing `openclaw-skill/acp_tools.py`
2. The SDK imports without `ImportError`
3. The server's `/acp/health` returns HTTP 200 within 5 seconds
4. An inbox write/read roundtrip succeeds (using `peer_greet` + `inbox_read`)
5. No hardcoded absolute paths (`D:/openclaw-acp`, `/Users/x/openclaw-acp`, etc.) appear in any Skill `SKILL.md`

Exits 0 on full pass, 1 on any failure. CI-friendly (exits non-zero on any failed assertion).

## Data and network

- Calls `http://localhost:9999` (HTTP loopback only; no remote endpoints)
- Reads the Python SDK from a local checkout (no network)
- No telemetry, no remote services, no third-party APIs
- No tokens, credentials, or paid services

## Test evidence

Validated on 2026-08-15 against OpenClaw-mcode-ACP v7-bidir:

- Plugin-bundled `scripts/smoke.py`: 5/5 checks pass (verified in this PR — see CI workflow run linked below)
- InboxStore self-test: 6/6 assertions pass
- All 5 HTTP inbox endpoint tests pass (`/acp/inbox/write`, `/read`, `/ask`, `/answer`, `/sessions`)
- SDK sync smoke test passes (full write/read/ask/answer flow)
- Stub-mavis ↔ goudan end-to-end demo: 14 messages exchanged in ~3 seconds, including blocking questions and answers

### CI

A GitHub Actions workflow at `.github/workflows/openclaw-acp-bridge-smoke.yml` runs `scripts/smoke.py` on every push and PR targeting `main`. The workflow installs the SDK from a pinned commit of `antianqi/openclaw-mcode-acp` (matching the `v7-bidir+` contract above), sets up Python 3.11, exports `ACP_HOME`, and exits non-zero on any failed assertion. The latest run output is the source of truth for whether the Plugin works against the pinned server revision.

## Limitations

- This Plugin is **instructive** — MiniMax Code follows the Skills and calls Python via its shell tool. It does not inject code into MiniMax Code itself.
- For tightest integration, prefer running `mcode` via the ACP server CLI (`acp_cli.py`) instead of dispatching tasks manually.
- The blocking `ask` timeout defaults to 300 seconds. Longer waits require pushing progress first.

## See also

- Project home: https://github.com/antianqi/openclaw-mcode-acp
- Project intro (for sharing): https://github.com/antianqi/openclaw-mcode-acp/blob/main/docs/PROJECT_INTRO.md
- CHANGELOG (real bugs we hit and fixed): https://github.com/antianqi/openclaw-mcode-acp/blob/main/CHANGELOG.md