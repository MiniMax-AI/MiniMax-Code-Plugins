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
| `test/` | `node:test` unit tests |
| `package.json` | Project metadata + scripts |

## Configuration

All settings are environment variables. See
[SKILL.md § Configuration](SKILL.md#configuration-environment-variables)
and [`server/lib/config.js`](server/lib/config.js) for the canonical
list. Most relevant:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | HTTP listen port (default was `7890` before v0.5) |
| `HOST` | `0.0.0.0` | Bind address (override to `127.0.0.1` for loopback-only) |
| `TOKEN` | (empty) | Required token for non-local requests. **v1.0.1**: if unset, server auto-generates a 32-hex token on first start (see "Token auth" below). |
| `MCODE_WEBUI_SETTINGS_PATH` | `~/.mcode-webui/settings.json` | **v1.0.1**: override the settings file location (tests, non-default installs). |

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

- Default binds `0.0.0.0` — reachable from any device on the LAN. Use
  `HOST=127.0.0.1` for loopback-only mode.
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
