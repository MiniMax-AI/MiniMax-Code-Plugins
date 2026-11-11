# Mcode Web UI Plugin

> **Browser-based chat frontend for the Mcode agent runtime.**
> Streams `mcode acp` / `mcode exec` sessions in real time. Zero npm
> dependencies; runs on Node 22.19+.

This is the mcode-plugin-guide (Agent Plugins 1.0) packaging of the
[Mcode-webui](https://github.com/Wzdhehe/Mcode-webui) web frontend.

## Quick start

```bash
# 1. Install the plugin (per mavis / MiniMax Code plugin loader)
# 2. Set TOKEN (recommended on non-loopback networks)
export TOKEN="$(openssl rand -hex 16)"
# 3. Start the plugin
node server.js
# 4. Open in browser
#    http://127.0.0.1:8080/?token=$TOKEN
```

## What's in the box

| File | What |
|------|------|
| `plugin.json` | Agent Plugins 1.0 manifest (10 top-level fields, white-listed) |
| `SKILL.md` | This plugin's skill description (frontmatter + body) |
| `LICENSE` | MIT |
| `README.md` | This file |
| `references/SECURITY-NOTES.md` | **Canonical security disclosure** (read this before installing) |
| `docs/` | ARCHITECTURE, API, CAPABILITIES, DEVELOPMENT, TROUBLESHOOTING |
| `server/` | Node.js HTTP + SSE server |
| `public/` | Static frontend SPA |
| `test/` | `node:test` suites — flagless root-gate surface (see docs/CI.md) |
| `checks/` | mocked unit checks (`t.mock.module`; need the module-mocks flag) |
| `package.json` | Project metadata + scripts |

## Screenshots

The PNGs in `docs/screenshots/` are **real captures** taken against a
running v2.0.0 server (`PORT=8123 HOST=127.0.0.1 MCODE_CMD=/Users/moc/.minimax-code/bin/mcode`)
on 2026-09-20 with the ego-browser skill. The screenshots cover the five
most informative views of the webui: startup, mid-chat with the prior
"Greeting" session restored, the left-bottom settings panel (Dark / English
/ LAN Access), a typed-but-unsent prompt with the chat-input affordances,
and the post-send state showing the SSE delta stream.

| # | What it shows |
|---|---|
| 1 | **Startup** — the empty chat view on first launch: top bar with workspace / model / LAN chips, an empty conversation area, and the prompt input at the bottom. |
| 2 | **Mid-stream chat** — the webui rendering the "Greeting" session: history loaded, a streaming assistant response in progress over SSE, the in-page tok/s meter, and the per-turn context window chip. |
| 3 | **Settings panel** — the left-bottom card with Appearance (Dark), Language (English), and LAN Access toggles; clicking LAN Access flips `POST /api/settings` and broadcasts the change via `auth.token_rotated` SSE. |
| 4 | **Chat with prompt typed** — the input textarea showing a real user prompt ("Can you list the files in this workspace?") with the send/stop affordances, `/` slash-command hint, `@file` injection hint, and the `Enter to send` cue. |
| 5 | **Post-send + tool call** — the webui after Enter: the user message rendered in the chat, the assistant turn streaming, and (if the model chooses) the Bash / Read / Write tool-call block with structured argument preview and the auto-collapse arrow once the call finishes. |

### Inline previews

The image links below use relative paths to `docs/screenshots/`. They
resolve on the marketplace plugin tree at `plugins/Wzdhehe/mcode-webui/`.

![Startup screen — empty chat on first launch](docs/screenshots/01-startup.png)

![Mid-stream chat — Greeting session loaded, SSE deltas in flight](docs/screenshots/02-chat-session.png)

![Settings panel — Appearance / Language / LAN Access toggles](docs/screenshots/03-settings-panel.png)

![Chat input — typed prompt with send/stop affordances + slash hint](docs/screenshots/04-chat-typed.png)

![Post-send + tool call — user prompt rendered, assistant SSE deltas streaming, tool-call block unfolded](docs/screenshots/05-tool-call.png)

> Contributing a screenshot? See [CONTRIBUTING.md](CONTRIBUTING.md#screenshots).

## Capabilities

This plugin exposes 13 capabilities, declared in
[`plugin.json`](plugin.json) under `extensions.capabilities` and
described in full detail in [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md).
The names below are the canonical identifiers — keep them stable;
external registries / IDE integrations match on these strings.

| Capability | One-line |
|---|---|
| `chat-streaming` | SSE deltas from `mcode acp` rendered token-by-token |
| `tool-execution` | Bash / Read / Write / Edit forwarded from acp `tool_call` events |
| `plan-mode` | Plan review modal with `agree` / `skip` / `add context` options |
| `ask-user-tool` | 2-4 option question modal with `Other` free-text fallback |
| `permission-prompts` | `ask` / `auto` / `full` approval modal for tool calls |
| `workspace-switching` | Workspace picker + recent list + last-used restore |
| `session-management` | List / create / switch / delete webui sessions |
| `file-attachments` | Drag-drop / click / paste upload + `@path` injection |
| `quota-usage` | `mmx quota show` + per-turn context window display |
| `bilingual-ui` | zh-CN / en locale toggle via `t(key)` lookup tables |
| `lan-sharing` | Loopback default; LAN exposure via explicit opt-in (`HOST` env / `lanBind` setting) + runtime on/off toggle |
| `token-auth` | `?token=` / `Authorization: Bearer` for non-local requests |
| `mobile-responsive` | Drawer at <900px, single column at <600px |

CI asserts on every one of these names being mentioned in this README
and in [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) (see
`scripts/check-docs-alignment.mjs`).

## Configuration

All settings are environment variables. See
[SKILL.md § Configuration](SKILL.md#configuration-environment-variables)
and [`server/lib/config.js`](server/lib/config.js) for the canonical
list. Most relevant:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | HTTP listen port (default was `7890` before v0.5) |
| `HOST` | `127.0.0.1` | Bind address. **v2 (PR #55)**: default is loopback; LAN exposure is an explicit opt-in — set `HOST` (e.g. `0.0.0.0`) or the persisted `lanBind` setting (`POST /api/settings {lanBind: true}`, effective on restart). |
| `TOKEN` | (empty) | Required token for non-local requests. **v1.0.1**: if unset, server auto-generates a 32-hex token on first start (see "Token auth" below). |
| `MCODE_WEBUI_SETTINGS_PATH` | `~/.mcode-webui/settings.json` | **v1.0.1**: override the settings file location (tests, non-default installs). |
| `MCODE_WEBUI_UPLOAD_MAX_REQUEST` | `52428800` (50 MiB) | **v2 (PR #55)**: max total upload request body in bytes (positive integer; over-limit → 413). |
| `MCODE_WEBUI_UPLOAD_MAX_FILE` | `26214400` (25 MiB) | **v2 (PR #55)**: max single uploaded file in bytes (positive integer; over-limit → 413). |
| `MCODE_WEBUI_UPLOAD_QUOTA` | `209715200` (200 MiB) | **v2 (PR #55)**: total size cap for the upload directory in bytes (positive integer; over-limit → 413). |
| `MCODE_WEBUI_WORKSPACE_ROOTS` | (unset) | **v2 (PR #55)**: allowed roots for workspace containment, segments split on the platform path separator (`:` POSIX / `;` Windows). Unset = default set (user home + default workspace + system tmp); **setting it fully replaces the default set**. |

## Token auth (v1.0.1)

Token auth is the headline change in v1.0.1 — it addresses PR #16
reviewer feedback that `SECURITY-NOTES.md §2` documented
`?token=` / `Authorization: Bearer` but the code had no real auth
gate. v1.0.1 implements three pieces, each documented as a
separate concern below.

### Token auth: default-on

On first start with no `TOKEN` env set, the server **auto-generates
a 32-hex-char token** (`crypto.randomBytes(16).toString('hex')`),
persists it to `~/.mcode-webui/settings.json` (mode `0600` on Unix;
best-effort on Windows), and **prints it to stdout exactly once**
(never to `.server.log` — copy it from the terminal before it
scrolls off). The settings card in the bottom-left sub-card
shows the token on first open; until you click
"我已保存 / I have saved it", `GET /api/settings` and the SSE
state push keep including the `currentToken` field. Setting
`TOKEN` env still wins (the env path is unchanged — this is
purely additive).

### Token auth: reset + live broadcast

The settings card has a "重置 token / Reset token" button. Click
it → confirm → the server generates a new 32-hex value,
persists it, and **broadcasts an `auth.token_rotated` SSE
event** with the new token to every connected client. Each
client that receives the event updates its `localStorage`
(`webui_token` key) and the live `HEADERS.Authorization`
object **in place** — subsequent `fetch()` calls use the new
token automatically, no reload required. Offline clients
that missed the broadcast will get a `401` on their next
request, at which point they need to be re-sent the new URL
(with `?token=`) manually. `rotateToken` is **crash-safe**:
persists to disk first, then commits in-memory state; if
disk write fails, in-memory is rolled back and the API
returns `500`.

### Token auth: acknowledged state machine

After clicking "我已保存 / I have saved it" in the settings
card, the server records `tokenAcknowledged=true` and
**stops including `currentToken` in subsequent
`GET /api/settings` responses and SSE state pushes**. The
UI replaces the value/mask row with a `✓ 已保存 — 查看请点
"重置" / Saved — click "Reset" to view again` placeholder
(show / copy buttons disappear). To view the token again
you must hit "Reset token" (which produces a new value and
a new broadcast). The acknowledged flag prevents accidental
token disclosure in `/api/settings` responses if a stale
client or external monitor is scraping the endpoint. The
state is persisted alongside the token itself, so the
acknowledged flag survives server restarts.

## Security disclosure (READ THIS)

Full disclosure is in
[`references/SECURITY-NOTES.md`](references/SECURITY-NOTES.md). Key points:

- Default binds `127.0.0.1` (loopback). LAN exposure is an explicit
  opt-in: the `HOST` env var or the `lanBind` setting (restart-effective),
  disclosed live via `lanExposed` / `bindRestartPending` in the settings
  snapshot. CORS reflects trusted origins only — see the CORS section
  there for the `trustedOrigins` allowlist and the Origin/CSRF gate.
- `?token=` query string is supported for browser convenience. Prefer
  `Authorization: Bearer` header for any non-browser caller.
- `DELETE /api/sessions/:id` writes to the user's real mavis sqlite
  (`~/.minimax/v2/sqlite/runtime-state.sqlite`). Pass `?dryRun=true` to
  preview before committing.
- No telemetry, no remote endpoints, no third-party subprocesses.

## Documentation

| Doc | What |
|-----|------|
| [SKILL.md](SKILL.md) | Plugin skill description + trigger examples |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module topology, request lifecycle, SSE schema |
| [docs/API.md](docs/API.md) | Every HTTP endpoint with request/response schema |
| [docs/CAPABILITIES.md](docs/CAPABILITIES.md) | Capability matrix — what works, what doesn't |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Dev setup + how to add a route/UI panel |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common errors with verified fixes |

## License

MIT — see [LICENSE](LICENSE).

## Maintainer

- **Author**: Wzdhehe
- **Repository**: https://github.com/Wzdhehe/Mcode-webui
- **Homepage**: https://github.com/Wzdhehe/Mcode-webui
