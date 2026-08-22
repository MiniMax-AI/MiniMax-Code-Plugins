---
name: mcode-webui
description: 'Browser-based chat frontend for the mcode agent runtime. Streams mcode acp / exec sessions with real-time tool events, plan review, ask-user prompts, context usage, and quota. Zero npm dependencies; runs on Node 22+. Trigger on: "open mcode webui", "start the mcode webui", "launch mcode browser", "mcode webui status", "show mcode webui url".'
---

# mcode Web UI

> 🌐 Browser-based chat frontend for the mcode agent runtime.

- **Version**: 1.0.0
- **Author**: Wzdhehe
- **License**: MIT
- **Entry**: `server.js` (Node 22.19+)
- **Default port**: 8080 (LAN-accessible on `0.0.0.0`)

A Kimi-Code-style web UI for the mcode CLI. Streams `mcode acp` (Agent
Client Protocol) and `mcode exec` sessions to the browser in real time:
tool events, plan review, ask-user prompts, context usage bar, quota, and
session switching. Zero npm dependencies at runtime — only Node 22+ stdlib.

## When to use this Skill

Trigger when the user wants any of:

| User says | Skill should |
|-----------|--------------|
| "open mcode webui" / "start the mcode webui" | start `server.js` and tell the user the URL |
| "launch mcode browser" | start server + (optional) open browser |
| "mcode webui status" | report running / port / last error |
| "show mcode webui url" | print `http://<lan-ip>:8080/` |
| "mcode webui config" | list environment variables below |

Do not use this Skill for: editing the webui source code itself, debugging
the mcode agent runtime, or anything not about the webui HTTP/SSE server.

## Capabilities

13 capabilities, all implemented and live in v1.0:

- **chat-streaming** — SSE-delivered streamed model output
- **tool-execution** — bash / edit / read tool events shown inline
- **plan-mode** — mcode plan mode surfaced as collapsible right-panel
- **ask-user-tool** — multi-choice modal for tool `AskUserQuestion`
- **permission-prompts** — mcode acp `RequestPermission` shown as inline cards
- **workspace-switching** — sidebar chip + picker dialog
- **session-management** — list / new / switch / delete with mcode sid cross-reference
- **file-attachments** — multipart upload (10MB default, configurable)
- **quota-usage** — 5h + weekly usage fetched from mmx quota API
- **bilingual-ui** — zh-CN / en toggle, instant
- **lan-sharing** — `0.0.0.0` bind, optional `TOKEN` auth
- **token-auth** — `?token=` query + `Authorization: Bearer` header
- **mobile-responsive** — viewport + touch gestures

## Configuration (Environment Variables)

All optional. Defaults shown. See `server/lib/config.js` for full list.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | HTTP listen port (default was `7890` before v0.5) |
| `HOST` | `0.0.0.0` | bind address (loopback-only or all interfaces) |
| `TOKEN` | (empty) | if set, non-local requests must include `?token=` or `Authorization: Bearer` |
| `MCODE_MODEL` | `minimax_api/MiniMax-M3` | default model |
| `MCODE_CMD` | auto-detect | path to `mcode.cmd` / `mcode` binary |
| `MCODE_WEBUI_UPLOAD_DIR` | auto-detect | directory for uploaded attachments |
| `DEBUG_INJECT` | (empty) | set to `1` to enable `/api/debug/*` |

## Runtime

- **Node**: `>=22.19 <23 || >=24 <27`
- **Platforms**: Windows, Linux, macOS
- **Entry**: `server.js` (project root)
- **Default port**: 8080
- **Bind**: `0.0.0.0` (LAN-accessible by default; override `HOST` for loopback-only)

## Triggers (Real example prompts + expected results)

**Prompt 1** — User: `打开 mcode webui` (or "open mcode webui")

**Expected**:
1. Run `node server.js` (foreground or background, your call)
2. Wait for the SSE `open` log line on stdout
3. Tell the user: "webui running at http://127.0.0.1:8080/  (or http://<lan-ip>:8080/ for LAN)"

**Prompt 2** — User: `mcode webui status`

**Expected**:
1. Check if port 8080 is in use (`netstat -an | findstr 8080` on Win / `lsof -iTCP:8080` on Unix)
2. If listening: report "running" + URL; if not: report "not running"
3. Optionally read `C:\...\minimax-code\.server.err` for last error

**Prompt 3** — User: `配置 mcode webui 用端口 9000 绑定 127.0.0.1`

**Expected**:
1. Suggest the user set `PORT=9000 HOST=127.0.0.1` in their env
2. Explain the server must be restarted to pick up new env (process-level config)
3. Reference `server/lib/config.js` for the env-var names

## Security Notes

The full security disclosure is in
[`references/SECURITY-NOTES.md`](references/SECURITY-NOTES.md) — this is
the **single source of truth** for the plugin's network, credential,
destructive-operation, file-system, and process-model behavior.

TL;DR (read the full notes for details):

- Default bind `0.0.0.0` — set `HOST=127.0.0.1` for loopback-only.
- `?token=` query string supported for browser convenience; prefer
  `Authorization: Bearer` header for non-browser callers.
- `DELETE /api/sessions/:id` writes to the user's real mavis sqlite
  (`~/.minimax/v2/sqlite/runtime-state.sqlite`). Pass `?dryRun=true`
  first to preview.
- No telemetry, no remote endpoints. All processing is local.

## Endpoints (summary — full table in `docs/API.md`)

| Method | Path | Notes |
|--------|------|-------|
| GET    | `/api/health` | basic status, port + version |
| GET    | `/api/events` | SSE stream, all state changes |
| GET    | `/api/state` | current client state snapshot |
| GET / POST / DELETE | `/api/sessions[/:id\|/switch]` | session CRUD; `?dryRun=true` on DELETE for preview |
| POST   | `/api/send\|/stop\|/cmd` | chat pipeline |
| GET / POST | `/api/workspace[?/browse]` | workspace picker |
| GET / POST | `/api/settings` | runtime-tunable settings (LAN broadcast etc.) |
| POST   | `/api/upload` | multipart file upload |
| GET    | `/api/models`, POST `/api/set-model\|/permissions` | model + permission |
| GET / POST | `/api/usage[-real\|-trigger\|/refresh]` | quota / token usage |
| GET / POST | `/api/protocol/*` | mcode acp shim (set-mode, cancel, load, etc.) |
| GET / POST | `/api/debug/*` | gated by `DEBUG_INJECT=1` (testing only) |

For full request/response schema, error codes, and examples, see
`docs/API.md`. For architecture, see `docs/ARCHITECTURE.md`. For
contribution workflow, see `docs/DEVELOPMENT.md`.

## Files in this plugin

- `plugin.json` — Agent Plugins 1.0 manifest (10 top-level fields, white-listed)
- `skills/mcode-webui/SKILL.md` — this file (official skills/ layout)
- `LICENSE` — MIT
- `README.md` — user-facing quick start
- `docs/` — ARCHITECTURE, API, CAPABILITIES, DEVELOPMENT, TROUBLESHOOTING
- `server/` — Node.js HTTP + SSE server (real directory, kept in sync with project root)
- `public/` — static frontend SPA (real directory, kept in sync with project root)
- `test/` — node:test unit tests (real directory, kept in sync with project root)
- `package.json` — project metadata (copy of root)

## Development vs Release layout

- **In this repo (development)**: `plugins/Wzdhehe/mcode-webui/{server,public,test}`
  are **real directory copies** of the project-root `server/`, `public/`,
  `test/` (earlier revisions used Windows junctions; the trees have since
  been expanded). Keep both copies in sync when editing — the plugin tree is
  the source of truth for the release artifact.
- **For release** (the artifact pushed to the community plugin repo):
  `npm run package:plugin` copies the plugin tree into a real `dist/Wzdhehe/
  mcode-webui/` tree and zips it, verifying the output contains zero
  symlinks/junctions, satisfying the mcode-plugin-guide contract.

`npm run setup:plugin` is the historical junction-setup script; on the
current layout it is a no-op for existing directories.
