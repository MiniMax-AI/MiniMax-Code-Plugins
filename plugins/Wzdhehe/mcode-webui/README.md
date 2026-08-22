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
| `TOKEN` | (empty) | Required token for non-local requests |

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
