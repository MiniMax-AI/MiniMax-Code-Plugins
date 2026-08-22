# Security Notes — Mcode Web UI Plugin

> **Canonical security disclosure for the Mcode-webui plugin.**
>
> Per mcode-plugin-guide [red-line 7 / 披露完整性](https://github.com/Fectivnfy112357/mcode-plugin-guide/blob/main/references/red-lines.md),
> this file is the **single source of truth**. The `SKILL.md`, `plugin.json`,
> `README.md`, and PR description all reference this file by link — do NOT
> duplicate the disclosure text inline (drift risk). If a disclosure changes
> here, only this file needs to be updated.
>
> Audience: anyone evaluating whether to install this plugin, plus reviewers
> of the upstream PR.

---

## TL;DR

- **Binds `0.0.0.0` by default** — reachable from any device on your LAN.
  Set `HOST=127.0.0.1` for loopback-only.
- **`?token=` query string** is supported as a Bearer-token equivalent for
  browser convenience. Browser URL bar can leak the token via history /
  referer / shoulder-surfing — prefer `Authorization: Bearer` header for
  any non-browser caller.
- **`DELETE /api/sessions/:id` deletes the corresponding mcode session from
  your real mavis sqlite (`~/.minimax/v2/sqlite/runtime-state.sqlite`)**.
  Pass `?dryRun=true` first to preview.
- **Reads `~/.minimax/v2/sqlite/runtime-state.sqlite`** (read-only) for
  real token usage. The plugin **never** writes that file.
- **Writes file uploads to `MCODE_WEBUI_UPLOAD_DIR`** (default
  `.webui-uploads/` next to the webui). No files outside that directory
  are written.
- **No telemetry, no remote endpoints.** All processing is local.

---

## 1. Network exposure

| Surface | Default | Override | Notes |
|---------|---------|----------|-------|
| HTTP bind | `0.0.0.0:8080` | `HOST` / `PORT` env | `0.0.0.0` is a deliberate default — browser/phone/LAN access is the primary use case. On a public / untrusted network, set `HOST=127.0.0.1` immediately. |
| LAN broadcast toggle | `true` (UI) | `/api/settings` POST `{lanBroadcast: false}` | Server returns 403 with a friendly page when off and request is non-local. Toggle is **runtime**; resets to default on restart. |
| Outbound network | **none** | n/a | The webui does not call any external service. The only outbound traffic is the `mcode` CLI subprocess and `mmx quota show` (local binary). |
| Inbound auth | none (loopback) / `?token=` or `Authorization: Bearer` (non-loopback) | `TOKEN` env | See §3. |

**`0.0.0.0` rationale**: A Kimi-Code-style web UI is meant to be opened in
a browser — on the host, on a phone on the same Wi-Fi, on a tablet. A
loopback-only default would force every user to reconfigure before first
use. The trade-off is documented; the override is one env var away.

**No upstream model API calls from the webui itself.** The webui is a
front-end for `mcode acp` / `mcode exec`, which handles the model call.
The webui only forwards stdin / parses stdout / renders the SSE stream.

---

## 2. Credentials & secrets

### 2.1 What the plugin reads
- `TOKEN` env (if set) — used to gate non-local requests. Not echoed back
  in any response or log line.
- `mcode acp` / `mcode exec` process output (model streaming, tool events).
  Not persisted to disk by the webui.

### 2.2 What the plugin does NOT do
- Does **not** read `~/.ssh/`, `~/.aws/`, `~/.config/gh/`, or any other
  tool's credential directory.
- Does **not** parse shell history.
- Does **not** offer an `--api-key` / `--show-token` style flag. The only
  way to configure the auth token is the `TOKEN` environment variable.

### 2.3 Token in URL query string
- Browser opens `http://<host>:8080/?token=<TOKEN>` and the webui
  auto-injects the token into every `fetch` / `EventSource` call as
  `?token=` AND as `Authorization: Bearer`.
- **Risk**: query string ends up in browser history, server access logs
  (if any proxy / dev-tools captures it), and `Referer` headers sent to
  any external resource (none, in our case, but the webui's static files
  are served same-origin so `Referer` stays on-host).
- **Mitigation**: use the in-UI `LAN access` chip to copy a URL that
  includes the token, but for programmatic callers always pass
  `Authorization: Bearer` header instead.

### 2.4 Error-message redaction
- Token is never included in JSON responses, error bodies, or SSE
  payloads. Error responses follow `{ok: false, error: "<message>"}` —
  no request URL or headers are reflected.
- See `test/lib-config.test.js` and `test/lib-lan.test.js` for coverage
  of the redaction paths.

---

## 3. Destructive operations

### 3.1 `DELETE /api/sessions/:id` — **cross-deletes into mavis sqlite**

When a webui session is deleted, the plugin ALSO deletes the
corresponding row from `local_runtime_sessions` (and 31 related tables)
in `~/.minimax/v2/sqlite/runtime-state.sqlite` — the **real mavis
runtime database** the user shares with their `mavis` desktop install.

**Why**: `mcode acp` `session/delete` returns "Method not found" (a known
mcode 0.1.4 protocol gap). Without a server-side cross-delete, the
mcode side would keep orphaned sessions forever. v1.0 extended the
table list from 9 to 32: the Mcode schema has 33 session-keyed tables,
and the old 9-table list left `local_runtime_message_rows` (message
bodies), `local_runtime_token_usage`, and `local_runtime_pi_history_rows`
orphaned. Only `questionnaire_requests` is deliberately skipped (not
`local_runtime_*`-prefixed, ownership unclear).

**Mitigations**:
1. **Preview first**: `DELETE /api/sessions/<id>?dryRun=true` returns
   `{ok: true, dryRun: true, log: [...], totalRows: N}` without
   modifying any file. Use this before committing.
2. **Atomicity**: the actual delete runs in a SQLite `transaction()` —
   either all 32 tables update or none do. No partial state.
3. **FK table awareness**: missing tables (older mcode schema) are
   swallowed per-table, not as a transaction-wide failure.
4. **Idempotent**: re-running DELETE on an already-deleted sid is a
   no-op (`{ok: true, log: []}`).

**Default behavior unchanged**: real delete. `?dryRun=true` is opt-in.

### 3.2 File upload

`POST /api/upload` writes to `MCODE_WEBUI_UPLOAD_DIR` (default
`.webui-uploads/` next to the webui). Files are stored with their
original names plus a uuid prefix to prevent collisions. The directory
is created on demand; no symlink resolution is performed on the target
path (so a hostile `MCODE_WEBUI_UPLOAD_DIR=/etc` is the user's problem,
not the plugin's).

There is no auth on upload other than the standard `TOKEN` gate.
Anyone who can reach the server can drop files into the upload dir.

### 3.3 LAN broadcast toggle

`POST /api/settings {lanBroadcast: false}` disables LAN access at
runtime. No persistent state. Restarting the server reverts to the
`HOST` env (default `0.0.0.0`).

### 3.4 `/api/debug/*` (testing only)

Endpoints under `/api/debug/*` are gated by `DEBUG_INJECT=1`. They
include `set-headers` (override response headers for testing) and
`crash-now` (force a server crash). **Never set `DEBUG_INJECT=1` in
production** — it bypasses the standard error handling.

### 3.5 mcode acp subprocess cache

`server/lib/acp-client.js` spawns a long-lived `mcode acp` child
process. If the webui process is killed without cleanup, the child
is orphaned until the Mcode runtime's own TTL kicks in (typically
30 minutes for the mavis-managed subprocess). The webui attempts
`SIGTERM` + 3s grace + `SIGKILL` on `process.on('exit')` and
`process.on('SIGINT')`, but a hard kill (`kill -9` the webui, OS
crash) leaves the child.

---

## 4. File-system access

| Path | Access | Purpose |
|------|--------|---------|
| `~/.minimax/v2/sqlite/runtime-state.sqlite` | **read-only** (sqlite3 `-readonly`) | Real token usage for the usage panel. See `server/lib/mavis-usage.js`. |
| `~/.minimax-code/webui/.webui-sessions.json` | read+write | webui-side session store. |
| `~/.minimax-code/webui/.webui-uploads/` | write | File upload target (configurable via `MCODE_WEBUI_UPLOAD_DIR`). |
| `<user-selected workspace>` | read+list | Workspace picker (`/api/workspace/browse`). Reads directory tree only, no execution. |
| `~/.minimax/runtime/cwd.json` | read | mcode TUI's last cwd (used as workspace default). Read-only — never written. |

**No writes to user data outside the configured upload directory.**

---

## 5. Process model

- Single Node process; default model HTTP server.
- One child process per active session (`mcode acp`). Persists across
  turns, killed on session switch / delete / server shutdown.
- One child process for `mcode quota` reads (short-lived, ~1s).
- No third-party subprocesses.

---

## 6. Host capability assumptions

- **Node 22.19+** (uses `node:test` module, `URL.parse`, `Blob.stream`).
- **Mcode CLI 0.1.4+** for `mcode acp` (default transport).
- **sqlite3 binary** on PATH (or one of the platform fallback paths —
  see `server/lib/config.js#detectSqlite3Bin`).
- **mavis 0.1.0+** desktop install (provides the runtime sqlite). If
  mavis is not installed, the usage panel shows "no data" instead of
  crashing.

If any of these are missing, the plugin degrades gracefully (warning
log + a disabled feature) — it does not crash.

---

## 7. Testing & reproducibility

- `npm test` runs `node --experimental-test-module-mocks --test test/*.test.js`.
  261 passing tests, 1 skipped, 0 failing on a clean checkout.
- `npm run lint` — ESLint flat config, 0 warnings on a clean checkout.
- All tests use **temp file fixtures** (`mkdtempSync`). No test writes
  to the user's real `~/.minimax/` directory unless `MCODE_RUNTIME_DB`
  env is explicitly overridden.
- Cross-platform: tests pass on Windows + Linux + macOS (CI matrix
  Node 22 + 24).

---

## 8. Reporting issues

Security-relevant bugs: open a private advisory on the
[mavis/plugins GitHub repo](https://github.com/Wzdhehe/Mcode-webui/security/advisories)
(once published). Non-security bugs: use the issue tracker.
