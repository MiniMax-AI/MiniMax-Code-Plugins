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

Install the server side from https://github.com/antianqi/openclaw-mcode-acp (see its `README.md` for `pip install -r requirements.txt` and `.\scripts\start_server.bat`).

## Verify the Plugin works (smoke test)

Before installing into MiniMax Code, run the bundled smoke test to confirm the Plugin can talk to your server:

```bash
export ACP_HOME=/path/to/openclaw-mcode-acp
export ACP_TOKEN=<the token your server was started with>
python scripts/smoke.py
```

The smoke test (no MiniMax Code required) validates: `$ACP_HOME` resolves, the SDK imports, the server's `/acp/health` is reachable, and an inbox write/read roundtrip works end-to-end. Exits 0 on full pass, 1 on any failure. CI-friendly.

## Data and network

- Calls `http://localhost:9999` (HTTP loopback only; no remote endpoints)
- Reads the Python SDK from a local checkout (no network)
- No telemetry, no remote services, no third-party APIs
- No tokens, credentials, or paid services

## Test evidence

Validated on 2026-08-14 against OpenClaw-mcode-ACP v7-bidir:

- InboxStore self-test: 6/6 assertions pass
- All 5 HTTP inbox endpoint tests pass (`/acp/inbox/write`, `/read`, `/ask`, `/answer`, `/sessions`)
- SDK sync smoke test passes (full write/read/ask/answer flow)
- Stub-mavis ↔ goudan end-to-end demo: 14 messages exchanged in ~3 seconds, including blocking questions and answers

## Limitations

- This Plugin is **instructive** — MiniMax Code follows the Skills and calls Python via its shell tool. It does not inject code into MiniMax Code itself.
- For tightest integration, prefer running `mcode` via the ACP server CLI (`acp_cli.py`) instead of dispatching tasks manually.
- The blocking `ask` timeout defaults to 300 seconds. Longer waits require pushing progress first.

## See also

- Project home: https://github.com/antianqi/openclaw-mcode-acp
- Project intro (for sharing): https://github.com/antianqi/openclaw-mcode-acp/blob/main/docs/PROJECT_INTRO.md
- CHANGELOG (real bugs we hit and fixed): https://github.com/antianqi/openclaw-mcode-acp/blob/main/CHANGELOG.md