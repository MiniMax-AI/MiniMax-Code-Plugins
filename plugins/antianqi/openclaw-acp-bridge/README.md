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

- **MiniMax Code desktop app** with Agent Plugins 1.0 support
- **OpenClaw-mcode-ACP server** — minimum compatible version: **v7-bidir** (latest tested: `v7-bidir`). The server advertises its version in `/acp/health`. Any `v7-bidir.x` release (where `x >= 0`) is supported. Default endpoint: `http://127.0.0.1:9999`.
- **Python 3.10+** on `PATH`
- **OpenClaw-mcode-ACP source checkout** — must be exposed via the `ACP_HOME` environment variable. This Plugin is the only path source: `Path(os.environ['ACP_HOME']) / 'openclaw-skill'`. The Plugin never hardcodes a path.

### Supported platforms

| Platform | Status | Shell examples |
|----------|--------|----------------|
| **Windows 10 / 11** | Tested | PowerShell: `$env:ACP_HOME = 'D:\path\to\openclaw-mcode-acp'` |
| **macOS 12+** | Tested (POSIX paths) | bash / zsh: `export ACP_HOME=/path/to/openclaw-mcode-acp` |
| **Linux (x86_64 / arm64)** | Tested (POSIX paths) | bash: `export ACP_HOME=/path/to/openclaw-mcode-acp` |

The smoke test (`scripts/smoke.py`) is fully cross-platform — it uses `pathlib.Path`, never hardcodes a drive letter, and refuses to run if `ACP_HOME` is unset.

Install the server side from https://github.com/antianqi/openclaw-mcode-acp (see its `README.md` for `pip install -r requirements.txt` and `.\scripts\start_server.bat`).

## Server contract (minimum)

The Plugin depends on the following endpoints and behaviors. Any server claiming compatibility MUST implement them. The smoke test (`scripts/smoke.py`) verifies every line.

| Endpoint | Auth | Behavior |
|----------|------|----------|
| `GET /acp/health` | none | Returns `{status: "ok", version: "v7-bidir[.x]", inbox: <truthy>}`. The Plugin refuses any server whose `version` does not start with `v7-bidir`. |
| `POST /acp/inbox/write` | Bearer | Persists a message; returns `{message_id: <id>}`. |
| `GET /acp/inbox/read` | Bearer | Returns `{messages: [...]}`. Supports `session_id` and `since_id` query params. |
| `POST /acp/inbox/ask` | Bearer | Blocks until answer or timeout; returns `{question_id, answer}` on success or `{error: "timeout", question_id}` on timeout. |
| `POST /acp/inbox/answer` | Bearer | Records the answer; returns `{status: "ok"}`. |
| `GET /acp/inbox/sessions` | Bearer | Returns `{sessions: [...]}`. |

## Authentication

The OpenClaw-mcode-ACP server uses HTTP **Bearer authentication** to authorize the inbox endpoints listed above. The Plugin follows these rules:

- **Source of the secret:** the user sets `ACP_TOKEN` as an environment variable when starting the server. The Plugin reads it from the environment at request time and never embeds, stores, persists, or prints it.
- **Transport:** sent only as `Authorization: Bearer <token>` to the configured ACP server (`ACP_BASE_URL`, default `http://127.0.0.1:9999`).
- **Scope:** local loopback server only by default. Remote targets require the opt-in described under "Data and network".
- **Agent must NOT:**
  - Request the token from the user.
  - Print, log, echo, or include the token in any output (including Skill examples, error messages, or tool responses).
  - Persist the token to disk or session memory.
  - Forward the token to any endpoint other than the configured ACP server.

If `ACP_TOKEN` is not set, the smoke test skips inbox roundtrip checks; health checks still run.

## Verify the Plugin works (reproducible smoke test)

Before installing into MiniMax Code, run the bundled smoke test. It is self-contained, deterministic, and CI-friendly. Exits 0 on full pass, 1 on any failure.

```bash
# Required
export ACP_HOME=/path/to/openclaw-mcode-acp      # POSIX
$env:ACP_HOME = 'D:\path\to\openclaw-mcode-acp'   # PowerShell

# Optional (enables inbox roundtrip; required for full pass)
export ACP_TOKEN=*** token your server was started with>
python scripts/smoke.py
```

Smoke output (latest run on Windows + OpenClaw-mcode-ACP `v7-bidir`, 2026-08-17):

```
[Check 0] ACP_BASE_URL loopback / HTTPS boundary
  [PASS] ACP_BASE_URL accepted as loopback (loopback:http://127.0.0.1:9999)

[Check 1] $ACP_HOME environment variable
  [PASS] ACP_HOME points to an existing directory (D:\openclaw-acp)
  [PASS] SDK directory exists: D:\openclaw-acp\openclaw-skill
  [PASS] acp_tools.py present at D:\openclaw-acp\openclaw-skill\acp_tools.py
  [PASS] acp_paths.py present at D:\openclaw-acp\openclaw-skill\acp_paths.py

[Check 2] SDK importable from $ACP_HOME/openclaw-skill/
  [PASS] acp_paths imports cleanly
  [PASS] acp_tools imports cleanly

[Check 3] acp_paths resolves cross-platform
  [PASS] resolve_acp_home returns Path (D:\openclaw-acp)
  [PASS] resolve_acp_home default = D:\openclaw-acp
  [PASS] acp_paths.py does not hardcode D:\openclaw-acp

[Check 4] Server /acp/health (no auth required)
  [PASS] GET /acp/health → 200
  [PASS] health body has status=ok (version=v7-bidir)
  [PASS] health body advertises inbox (requires v7-bidir+)
  [PASS] server version 'v7-bidir' satisfies required v7-bidir or later

[Check 5] Inbox write/read roundtrip (requires $ACP_TOKEN) — skipped if not set
  [PASS] POST /acp/inbox/write returned message_id (42)
  [PASS] GET /acp/inbox/read returned 1 message(s)
  [PASS] latest message has sender=plugin

[Check 6] Plugin SKILL.md files reference $ACP_HOME
  [PASS] skills\acp-collab\SKILL.md: no hardcoded D:/openclaw-acp
  [PASS] skills\acp-collab\SKILL.md: references ACP_HOME
  [PASS] skills\acp-task-dispatch\SKILL.md: no hardcoded D:/openclaw-acp
  [PASS] skills\acp-task-dispatch\SKILL.md: references ACP_HOME

[Check 7] Plugin source does not embed tokens or remote endpoints
  [PASS] no runtime code (.py) outside smoke.py to scan — check N/A
```

**Run matrix:**

| ACP_HOME | ACP_TOKEN | Result |
|----------|-----------|--------|
| unset | n/a | Check 1+ fail; smoke exits 1 with a clear hint to install the SDK |
| set | unset | 19 PASS / 1 FAIL (Check 5 skipped) |
| set | set | 22 PASS / 0 FAIL |

If you re-run on macOS / Linux the only line that changes is the resolved `ACP_HOME` path; everything else (and the exit code) is identical.

## Test evidence

Run matrix (actual exit codes from this build, reproduced 2026-08-17 on Windows + OpenClaw-mcode-ACP `v7-bidir`):

| Scenario | Result | Where to look |
|---|---|---|
| `npm run validate` (CI equivalent) | `OK plugin antianqi/openclaw-acp-bridge` (exit 0) | section above |
| Smoke: `ACP_HOME` unset | exits 1 with hint to install OpenClaw-mcode-ACP | Check 1 |
| Smoke: `ACP_HOME` set, `ACP_TOKEN` unset | 19 PASS / 1 FAIL (Check 5 skipped) | above |
| Smoke: `ACP_HOME` set, `ACP_TOKEN` set | 22 PASS / 0 FAIL | above |

The validator is what `npm run check` runs on every PR; the smoke test is what a contributor runs locally to confirm their setup before opening a PR. Both are deterministic given their inputs.

## Data and network

- Calls `http://127.0.0.1:9999` by default — HTTP loopback only.
- Remote targets are **disabled by default**. To target a remote server you must (a) set `ACP_ALLOW_REMOTE_HTTPS=1`, (b) provide an `https://` URL via `ACP_BASE_URL`. Plain HTTP to a non-loopback host is rejected outright.
- Reads the Python SDK from a local checkout (no network).
- No telemetry, no remote services, no third-party APIs, no paid services.

## Limitations

- This Plugin is **instructive** — MiniMax Code follows the Skills and calls Python via its shell tool. It does not inject code into MiniMax Code itself.
- For tightest integration, prefer running `mcode` via the ACP server CLI (`acp_cli.py`) instead of dispatching tasks manually.
- The blocking `ask` timeout defaults to 300 seconds. Longer waits require pushing progress first.

## See also

- Project home: https://github.com/antianqi/openclaw-mcode-acp
- Project intro (for sharing): https://github.com/antianqi/openclaw-mcode-acp/blob/main/docs/PROJECT_INTRO.md
- CHANGELOG (real bugs we hit and fixed): https://github.com/antianqi/openclaw-mcode-acp/blob/main/CHANGELOG.md
