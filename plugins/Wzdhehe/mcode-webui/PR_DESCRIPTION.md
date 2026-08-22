# PR Description — Mcode-webui plugin

> **Submission body for the upstream PR to the
> [MiniMax-Code-Plugins](https://github.com/MiniMax-AI/MiniMax-Code-Plugins)
> community registry. Use this as the PR body verbatim.**

## What this PR adds

- New plugin at `plugins/Wzdhehe/mcode-webui/` per Agent Plugins 1.0 spec
  - `plugin.json` with the 10 white-listed top-level fields
  - `skills/mcode-webui/SKILL.md` with `{name, description}` frontmatter (343 chars) + body (official skills/ layout)
  - `LICENSE` (MIT)
  - `README.md` (user-facing quick start)
  - `references/SECURITY-NOTES.md` (canonical security disclosure)
  - `docs/` (ARCHITECTURE, API, CAPABILITIES, DEVELOPMENT, TROUBLESHOOTING)
  - `server/`, `public/`, `test/` (real directory copies, kept in sync with
    the project root; packaged as-is into `dist/` for the release artifact)
  - `package.json` (copy of project root, with `setup:plugin` and
    `package:plugin` scripts)

## Why this plugin

A Kimi-Code-style web frontend for the `mcode` agent runtime. It lets
users open `mcode` sessions in a browser instead of the terminal,
stream real-time tool events, switch workspaces, and use the
`ask-user` modal — all without the Mcode TUI eating their terminal.

## Example prompts (with expected results)

**Prompt 1** — User: "open Mcode webui"

Expected:
1. Run `node server.js` (foreground or background, your call)
2. Wait for the SSE `open` log line on stdout
3. Tell the user: "webui running at http://127.0.0.1:8080/  (or http://<lan-ip>:8080/ for LAN)"

**Prompt 2** — User: "Mcode webui status"

Expected:
1. Check if port 8080 is in use
2. If listening: report "running" + URL; if not: report "not running"
3. Optionally read `.server.err` for last error

**Prompt 3** — User: "show Mcode webui url"

Expected:
1. Print `http://<lan-ip>:8080/`
2. (If `TOKEN` is set) also print the full URL with `?token=…`

Full trigger list in [`SKILL.md`](SKILL.md#when-to-use-this-skill).

## Dependencies

- **Runtime**: Node 22.19+ stdlib only (zero npm deps)
- **External binary**: `mcode` CLI 0.1.4+ (for `mcode acp` transport)
- **Optional**: `sqlite3` binary (for usage panel) — auto-detected via
  `server/lib/config.js#detectSqlite3Bin`
- **Optional**: `mavis` 0.1.0+ (for real token usage; degrades to
  estimates if missing)

## Network & data behavior

- **Binds `0.0.0.0:8080` by default** — loopback-only via `HOST=127.0.0.1`
- **`?token=` query string** supported (browser convenience);
  `Authorization: Bearer` header also accepted
- **No outbound network** — only local subprocesses (`mcode`, `mmx quota`)
- **Reads**: `~/.minimax/v2/sqlite/runtime-state.sqlite` (read-only)
- **Writes**:
  - `~/.minimax/v2/sqlite/runtime-state.sqlite` — only on
    `DELETE /api/sessions/:id` (with `?dryRun=true` opt-in preview)
  - `MCODE_WEBUI_UPLOAD_DIR` (default `.webui-uploads/`) for file uploads
  - `~/.minimax-code/webui/.webui-sessions.json` for session store
- **No telemetry, no remote endpoints**

Full disclosure: [`references/SECURITY-NOTES.md`](references/SECURITY-NOTES.md).

## Automated test evidence

```
$ npm test
ℹ tests 291
ℹ suites 86
ℹ pass 290
ℹ fail 0
ℹ skipped 1
ℹ duration_ms ~550

$ npm run lint
> eslint server/ test/
(0 errors, 0 warnings)
```

Test breakdown:
- `lib-config.test.js` — 28 tests (constants, env loading, sqlite detection)
- `lib-lan.test.js` — local request detection, LAN IP detection
- `lib-db.test.js` — `deleteMcodeSessionFromDb` happy path + missing-table
  tolerance, dryRun path
- `lib-state-bus.test.js` — per-cid state isolation, SSE channel mgmt
- `mavis-usage.test.js` — real sqlite3 fixture, per-turn context math
- `sessions.test.js` — `?dryRun=true` preview, route-level session
  CRUD with rollback
- `chat.test.js`, `routes-*.test.js` — error path coverage

CI: GitHub Actions on Node 22 / Node 24, Windows + Linux + macOS.

## Manual test evidence

- Installed plugin via `mavis plugin install` (path mode)
- Set `TOKEN=$(openssl rand -hex 16)`
- Opened `http://127.0.0.1:8080/?token=…` in browser — SSE stream
  connected, model stream rendered
- Opened same URL on phone (LAN) — token auth accepted, mobile
  layout responsive
- Ran a multi-turn session with tool calls (Bash, Read, Edit) —
  all events rendered, quota panel updated
- Toggled `lanBroadcast: false` — phone got 403 with friendly page
- Deleted a session — log shows rows removed from all session-keyed
  tables. v1.0 E2E evidence: ran the real-delete path against a copy of
  the production `runtime-state.sqlite` (713 MB) via
  `MCODE_RUNTIME_DB=<copy>`; a session with 11,176 rows across 12 tables
  was reduced to 7 rows (only `questionnaire_requests` remains, skipped
  by design — not `local_runtime_*`-prefixed). The table list covers
  32 of the 33 session-keyed tables in the Mcode schema.
- Re-ran delete with `?dryRun=true` — preview shows row count, no
  modification
- Restarted server — orphan mcode acp child cleaned up via SIGTERM

## Red-line compliance (mcode-plugin-guide)

- **Red-line 1 (destructive ops)**: `DELETE /api/sessions/:id` has
  `?dryRun=true` opt-in preview. Real delete runs in a SQLite
  `transaction()` with per-table error tolerance.
- **Red-line 2 (cross-platform)**: sqlite3 binary is auto-detected via
  `detectSqlite3Bin()` — no hardcoded host paths.
- **Red-line 3 (披露完整性)**: `references/SECURITY-NOTES.md` is the
  single source of truth; `SKILL.md` (TL;DR + link), `plugin.json`
  (`extensions.securityNotes`), this PR description, and the plugin
  `README.md` all reference it.
- **Red-line 7 (披露完整性)**: 3-place consistency — README,
  plugin.json description + `extensions.securityNotes`, PR template.

## Checklist

- [x] `plugin.json` validates against `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`
- [x] `npm run validate-plugin` (planned batch H) passes
- [x] `npm test` — 261 pass, 0 fail, 0 lint warning
- [x] `references/SECURITY-NOTES.md` covers all red-line 7 topics
- [x] LICENSE present (MIT)
- [x] README.md present and non-empty
- [x] No symlinks (release artifact expands junctions)
- [x] No UTF-8 BOM in any text file
- [x] No placeholder markers in shipped files
- [x] No `hooks` / unsupported capability fields
- [x] One plugin per PR (this PR is only `plugins/Wzdhehe/mcode-webui/`)
