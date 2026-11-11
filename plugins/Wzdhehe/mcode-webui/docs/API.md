# HTTP API reference

> Complete enumeration of every endpoint. REST is JSON unless noted; the
> only SSE endpoint is `/api/events`.

All non-API routes return static files (`server.js` → `serveStatic` /
`serveIndex`).

## Conventions

- **Base URL**: `http://127.0.0.1:8080` (or LAN IP if enabled)
- **Path prefix**: `/api/`
- **Content-Type**: `application/json; charset=utf-8` for both request and response
- **Auth header**: if `TOKEN` env is set, every request must include either
  - query: `?token=…`
  - header: `Authorization: Bearer …`
  - 401 if missing or wrong
- **CID**: each request should include `?cid=<uuid>` to identify the webui
  tab. The webui injects this automatically; if missing, the server falls
  back to the `default` CID.
- **Errors**: every error response is `{ok: false, error: 'human-readable message'}`
  with an appropriate 4xx/5xx status. Some legacy endpoints still return
  `{ok: true, …}` even on soft failures — those are called out below.

---

## Health

### `GET /api/health`

Returns server status. No auth required, no CID required.

**Response 200**
```json
{
  "ok": true,
  "port": 8080,
  "defaultModel": "minimax_api/MiniMax-M3",
  "defaultWorkspace": "C:\\Users\\you\\.minimax-code\\webui",
  "mcodeCmd": "C:\\Users\\you\\.minimax-code\\mcode.cmd",
  "mcodeVersion": "0.1.2",
  "maxConcurrent": 3
}
```

---

## State & SSE

### `GET /api/state`

Returns the current `state` object for this CID. See
[ARCHITECTURE.md §4](ARCHITECTURE.md) for the full shape.

**Response 200**
```json
{ "ok": true, "version": "0.1.3", "running": {"active": false}, … }
```

### `GET /api/events`

Server-Sent Events stream for this CID. The connection stays open
indefinitely. Events are listed in
[ARCHITECTURE.md §5](ARCHITECTURE.md).

**Response 200** (`Content-Type: text/event-stream`)
```
event: state
data: {"version":"0.1.3","running":{"active":false},…}

event: delta
data: {"text":"hello","isPartial":true}

event: exec
data: {"status":"ok","durationMs":12345}
```

The connection is held open until the client closes it (`EventSource.close()`)
or the server shuts down. No automatic reconnect from the server side;
the webui handles reconnection with exponential backoff.

---

## Chat

### `POST /api/send`

Send a user message. Spawns (or reuses) the mcode subprocess for this CID
and streams the result via SSE.

**Request**
```json
{
  "content": "refactor the workspace picker to use a tree",
  "attachments": ["@C:\\path\\to\\file.py"],
  "isAskAnswer": false
}
```

- `content` (string, required) — the user message. May include `@path`
  references to attachments; the webui injects these automatically.
- `attachments` (string[], optional) — list of `@path` strings to
  prepend to the content. The webui populates this from the attachment
  UI; you usually don't pass it directly.
- `isAskAnswer` (bool, optional) — when `true`, the content is the
  answer to an active `ask_user` question. Set by the ask modal
  automatically.

**Response 200** `{ok: true}` immediately. The actual response is
streamed via `/api/events`.

**Errors**
- 409 if `state.running.active === true` (already running)
- 400 if `content` is empty

### `POST /api/stop`

Cancel the current run. Best-effort: tries `session/cancel` via acp
(unimplemented in 0.1.5), then SIGTERM, then SIGKILL after 2s.

**Request** `{}`

**Response 200** `{ok: true}`

### `POST /api/cmd`

Send a raw slash command (e.g. `/compact`, `/clear`). The server sends
the command to mcode and streams the result.

**Request**
```json
{ "cmd": "/compact" }
```

**Response 200** `{ok: true}`

---

## Sessions

### `GET /api/sessions`

List webui sessions + mcode sessions (merged, deduplicated).

**Response 200**
```json
{
  "ok": true,
  "count": 12,
  "sessions": [
    { "id": "uuid", "title": "…", "workspace": "C:\\…", "mcodeSessionId": "mvs_…", "updatedAt": 1234567890 }
  ]
}
```

### `POST /api/sessions`

Create a new webui session. Optionally tied to a workspace.

**Request**
```json
{ "workspace": "C:\\path\\to\\project" }
```

**Response 200** `{ok: true, id: "uuid"}`

### `POST /api/sessions/switch`

Switch to an existing session. Loads its chat history and (if linked)
re-attaches to the mcode session.

**Request**
```json
{ "id": "uuid" }
```

**Response 200** `{ok: true}`

### `POST /api/sessions/cleanup-orphans`

Delete mcode sessions that no webui session references. Two scopes:

- `scope: "orphans"` (default) — only delete mcode sessions with no
  webui reference. The currently-active session is always preserved.
- `scope: "all"` — delete every mcode session, then re-link webui
  sessions that had a `mcodeSessionId` (which now points to a deleted
  session — they become "webui-only" again).

**Request**
```json
{ "scope": "orphans" }
```

**Response 200**
```json
{
  "ok": true,
  "scope": "orphans",
  "total": 37,
  "targets": 18,
  "deleted": 18,
  "failed": 0,
  "log": ["deleted mvs_5103ca…", "deleted mvs_88c796…", …]
}
```

### `DELETE /api/sessions/:id`

Delete a webui session AND its linked mcode session (if any). The mcode
deletion is a single SQLite transaction across the 32 session-keyed
`local_runtime_*` tables (plus `local_runtime_sessions`) — any
non-absent per-table error rolls the whole transaction back.

Pass `?dryRun=true` to preview the mcode-side impact without modifying
anything.

**Response 200** (main path)
```json
{
  "ok": true,
  "deleted": "uuid",
  "matchKind": "webuiId",
  "dryRun": false,
  "remaining": 11,
  "mcodeDbDel": {
    "ok": true,
    "outcome": "deleted",
    "log": ["local_runtime_sessions:1", "local_runtime_message_rows:42", "…"],
    "totalRowsDeleted": 57,
    "tablesAbsent": 0
  }
}
```

**`mcodeDbDel.outcome` — explicit verdicts (no fake success)**:

| outcome / reason | Meaning |
|---|---|
| `deleted` | Transaction committed; rows were removed. |
| `already_absent` | Transaction committed; nothing matched for this sid (tables individually missing are skipped only when the schema catalog confirms the absence). |
| `unsupported_schema` (`ok:false`, `reason`) | A table exists but has no `session_id` key column; rolled back, `table` names it. |
| `db_error` (`ok:false`, `reason`) | Lock conflict (`SQLITE_BUSY`/`LOCKED`), prepare/run failure, or IO error; rolled back. |
| `audit_write_failed` (`ok:false`, `reason`) | Rows may be gone but the audit event could not be recorded — surfaced, never a clean success. |

The `session.delete` audit event carries the `outcome`
(`tablesAffected` / `tablesAbsent` / `totalRowsDeleted`). On the orphan
path (`mvs_*` id with no webui session), a failed mcode delete answers
**500** with the same `mcodeDbDel` failure object embedded; on the main
path the 200 body's `mcodeDbDel.ok` / `outcome` fields are the source
of truth for the mcode-side result.

**Response 404** `{"ok": false, "error": "session not found"}` — id
matches neither a webui session nor an `mvs_*` pattern.

### `GET /api/acp-sessions`

Raw mcode session list (from sqlite). No webui merge.

**Response 200** `{ok: true, sessions: [...]}`

### `GET /api/acp-session-title?sessionId=mvs_…`

Get the title of an mcode session.

**Response 200** `{ok: true, title: "…"}`

---

## Workspace

### `POST /api/workspace`

Change the workspace for the current CID.

**Request**
```json
{
  "dir": "C:\\path\\to\\project",
  "syncTui": true
}
```

- `dir` (string, required) — absolute path
- `syncTui` (bool, optional) — also write the path to `cwd.json` so the
  mcode TUI sees it
- `action: "detect"` — instead of changing, return the current TUI cwd
- `action: "useTui"` — copy the TUI's cwd to webui
- `action: "reset"` — restore webui's default workspace

**Response 200** `{ok: true, dir: "…", branch: "main", treeState: "clean"}`

### `GET /api/workspace/browse?path=…`

List a directory for the tree browser.

**Request** query: `?path=C:\\Users` (omit for drive roots on Windows
or `/` for Linux)

**Response 200**
```json
{
  "ok": true,
  "path": "C:\\Users",
  "children": [
    { "name": "Public", "path": "C:\\Users\\Public", "isDir": true }
  ]
}
```

When `path` is omitted, the root view lists only the **allowed roots**
(🔒 v2 — see below); the response keeps its platform-compatible shape:
- Windows: `roots: ["C:\\Users\\you", …]` (the allowed roots), `dir: null`
- POSIX: `dir: "/"`, `roots: ["/home/you", "/tmp", …]`, `children: []`

**🔒 v2 workspace containment (PR #55 review point 5)**: a candidate
path is `resolve()`d and symlink-resolved (`realpath`), and must land
within an allowed root — default allowed roots are the user's home
directory + the default workspace + the system tmp directory. The
`MCODE_WEBUI_WORKSPACE_ROOTS` env var (path-separator-separated
segments) **fully replaces** the default set. Out-of-root paths —
including `../` traversal and symlink escapes — are rejected with an
actionable error naming the resolved path, the allowed roots, and the
env knob. Both this endpoint and `POST /api/workspace` enforce the same
boundary.

---

## Settings

### `GET /api/settings`

Returns the full settings snapshot. **This endpoint is exempt from
the LAN guard** — it's how a remote user toggles LAN back on after
locking themselves out. The same snapshot is also pushed via SSE on
state changes (see [ARCHITECTURE.md §5 SSE state push](./ARCHITECTURE.md#5-sse-state-push)).

**Response 200** (🆕 v1.0.1, 🔒 v2 security — PR #55 review)
```json
{
  "ok": true,
  "lanBroadcast": true,
  "port": 8080,
  "host": "127.0.0.1",
  "lanIp": "192.168.1.50",
  "lanUrl": "http://192.168.1.50:8080",
  "lanUrlWithToken": "http://192.168.1.50:8080/?token=…",  // 🔒 v2 — FIRST-RUN BOOTSTRAP ONLY: present while tokenAcknowledged=false, omitted entirely after ack (UI falls back to lanUrl); re-issued once per rotation
  "localUrl": "http://127.0.0.1:8080",
  "lanBind": false,                // 🔒 v2 — persisted LAN-bind opt-in; true binds 0.0.0.0 on next boot (env HOST still wins)
  "bindHost": "127.0.0.1",         // 🔒 v2 — what the NEXT boot resolves to (env HOST > lanBind > loopback)
  "lanExposed": false,             // 🔒 v2 — effective bind is not loopback
  "bindRestartPending": false,     // 🔒 v2 — setting no longer matches the live socket; never true when env HOST owns the bind
  "lanExposureNotice": "",         // 🔒 v2 — bilingual exposure disclosure (non-empty when exposed / pending)
  "trustedOrigins": [],            // 🔒 v2 — explicit cross-origin allowlist for CORS reflection (see below)
  "mcodeCmd": "C:\\…\\mcode.cmd",
  "mcodeVersion": "0.1.2",
  "defaultWorkspace": "C:\\…",
  "defaultModel": "minimax_api/MiniMax-M3",
  "readOnly": false,                // 🆕 v1.0.1 — read-only mode toggle
  "tokenEnabled": true,             // 🆕 v1.0.1 — token auth master switch (default true)
  "currentToken": "…",              // 🆕 v1.0.1 — auto-generated 32-hex token; "" after tokenAcknowledged=true
  "tokenAcknowledged": false,       // 🆕 v1.0.1 — operator has confirmed they saved the token
  "tokenRotatedAt": 1724259600000   // 🆕 v1.0.1 — ms-since-epoch of the last rotation
}
```

Notes on the 🔒 v2 fields:

- `host` stays the **actual boot-time bind**; `bindHost` recomputes
  what the next boot would resolve to from current state
  (`resolveBindHost`: env `HOST` > `lanBind` > `127.0.0.1`).
- `trustedOrigins` is the explicit CORS allowlist — origins listed here
  are reflected verbatim in `Access-Control-Allow-Origin` in addition
  to the server's own serving origins (loopback + LAN address while
  LAN sharing is on). See
  [SECURITY-NOTES CORS](../references/SECURITY-NOTES.md#cors--cross-origin-resource-sharing).

Fields `currentToken` and `tokenAcknowledged` are persisted to
`~/.mcode-webui/settings.json` (mode `0600` on Unix). `currentToken`
and `lanUrlWithToken` are **omitted after `tokenAcknowledged=true`** —
the server only ships the token while the operator still has a copy of
it in the UI.
`MCODE_WEBUI_SETTINGS_PATH` env overrides the file location.

### `POST /api/settings`

Update one or more settings. v1.0.1 expanded the payload — any
combination of the fields below is settable in one request.
**Always exempt from the LAN guard AND the read-only gate** (so the
admin can always toggle things remotely, even in read-only mode).

**v2 request — all settable fields** (🆕 v1.0.1, 🔒 v2 security — PR #55 review)
```json
{
  "lanBroadcast": true,            // (existing) LAN on/off
  "lanBind": true,                 // 🔒 v2 — persisted LAN-bind opt-in; binds 0.0.0.0 on next boot (restart-effective)
  "trustedOrigins": ["https://webui.example.com"],  // 🔒 v2 — explicit CORS allowlist; replaces the stored list wholesale
  "readOnly": true,                // 🆕 v1.0.1 — toggle read-only mode
  "tokenEnabled": false,           // 🆕 v1.0.1 — toggle token auth master switch
  "resetToken": true,              // 🆕 v1.0.1 — generate new token + broadcast auth.token_rotated SSE
  "acknowledgeToken": true         // 🆕 v1.0.1 — operator confirms they saved the token; server stops sending it
}
```

`trustedOrigins` validation (fail-closed, whole batch): `http`/`https`
origin serialization only (`scheme://host[:port]` — no path / query /
userinfo), at most 16 entries of 1..200 chars each; an invalid batch is
rejected **400 before any state changes** (a malformed allowlist can
never partially widen the CORS surface).

**Responses**

- `200 {"ok":true, "changed":true, …}` — at least one field was updated
- `200 {"ok":true, "tokenRotated":true, "currentToken":"…", "tokenAcknowledged":false, "tokenRotatedAt":…}` — special response for `resetToken:true` (returns the new value so the caller can update its localStorage)
- `200 {"ok":true, "changed":false}` — no field actually changed
- `400 {"ok":false, "error":"invalid origin: …"}` (and similar) — `trustedOrigins` batch failed validation
- `500 {"ok":false, "error":"…"}` — only on `rotateToken` disk write failure (rare)

---

## Upload

### `POST /api/upload`

Multipart file upload. Saves to `MCODE_WEBUI_UPLOAD_DIR` and returns
the absolute path. 🔒 v2 security (PR #55 review point 3): the parser
is a bounded streaming state machine (memory O(chunk), never O(body)),
with three limits enforced mid-stream:

| Limit | Default | Env override (positive integer) | Error code |
|---|---|---|---|
| Total request body | 50 MiB | `MCODE_WEBUI_UPLOAD_MAX_REQUEST` | `UPLOAD_REQ_TOO_LARGE` |
| Single file | 25 MiB | `MCODE_WEBUI_UPLOAD_MAX_FILE` | `UPLOAD_FILE_TOO_LARGE` |
| Upload-directory quota | 200 MiB | `MCODE_WEBUI_UPLOAD_QUOTA` | `UPLOAD_QUOTA_EXCEEDED` |

**Request** `multipart/form-data` with a `file` field.

**Response 200**
```json
{
  "ok": true,
  "path": "C:\\…\\.webui-uploads\\screenshot.png",
  "name": "screenshot.png",
  "size": 12345
}
```

(`size` is the stored byte count; the file lands at its final name only
via `rename()` after a clean stream end — failures leave no
half-written artifact.)

**Errors** — status is mapped from the error code, and the code is
echoed in the body so the client sees WHICH limit fired:

```json
{ "ok": false, "error": "file exceeds size limit: 26214401 > 26214400 bytes (adjust MCODE_WEBUI_UPLOAD_MAX_FILE to allow more)", "code": "UPLOAD_FILE_TOO_LARGE" }
```

- `413` + `Connection: close` — `UPLOAD_REQ_TOO_LARGE` /
  `UPLOAD_FILE_TOO_LARGE` / `UPLOAD_QUOTA_EXCEEDED` (the over-limit
  body was deliberately not consumed)
- `400` — `UPLOAD_MALFORMED` (malformed / truncated multipart) /
  `UPLOAD_ABORTED` (client tore the stream)
- `500` — anything else (disk I/O, audit write, unknown)

---

## Model

### `GET /api/models`

Returns the builtin + currently-configured model list.

**Response 200**
```json
{
  "ok": true,
  "current": "minimax_api/MiniMax-M3",
  "models": [
    { "id": "minimax_api/MiniMax-M3", "label": "MiniMax-M3", "provider": "minimax_api" }
  ]
}
```

If the list is empty, the response includes a `hint` field pointing
the user at the mcode TUI for model configuration.

### `POST /api/set-model`

Change the model for the current CID.

**Request**
```json
{ "model": "minimax_api/MiniMax-M3" }
```

**Response 200** `{ok: true, model: "…"}`

### `POST /api/permissions`

Change the session-level permission mode.

**Request**
```json
{ "permissions": "ask" }
```

- `permissions` (string) — one of `ask`, `auto`, `full`, `plan`

**Response 200** `{ok: true, permissions: "ask"}`

> Note: mcode 0.1.5 acp does not implement `session/set_mode`. The
> webui's UI shows the mode the user selected, but the underlying mcode
> session does not change. This is logged in the server console as
> `[mcode-rpc] UNSUPPORTED session/set_mode`. Will start working when
> mcode implements the method.

### `GET /api/permissions-modes`

List the available permission modes.

**Response 200** `{ok: true, modes: ["default", "bypassPermissions", "auto", "off", "read", "full"]}`

### `POST /api/answer`

Respond to an active permission / plan / ask_user prompt.

**Request**
```json
{ "type": "permission", "option": "ask" }
```

- `type` (string) — `permission` | `plan` | `planmode` | `ask`
- `option` (string) — depends on type:
  - `permission`: `ask` | `auto` | `full`
  - `plan`: `agree` | `skip` | `add`
  - `planmode`: `continue` | `deny`
  - `ask`: `esc` (skip) | `<index>` (option) | `<text>` (free-form)

**Response 200** `{ok: true}`

---

## Usage

### `GET /api/usage` and `POST /api/usage` and `POST /api/usage-trigger`

Fetch the current `mmx quota show` snapshot. `POST /api/usage-trigger`
also triggers a fresh fetch from the CLI. `GET /api/usage` and
`POST /api/usage` return the cached value if recent.

**Response 200**
```json
{
  "ok": true,
  "remaining": 91,
  "resetAt": 1234567890,
  "weeklyResetAt": 1234567890,
  "fetchedAt": 1234567890,
  "source": "mmx"
}
```

### `GET /api/usage-real`

Fetch per-turn context usage from the `mavis` runtime db. This is the
source of truth for "已用 N / 占比 N%" in the right panel.

**Response 200**
```json
{
  "ok": true,
  "lastTurnContextTokens": 12345,
  "lastInputTokens": 1000,
  "lastCacheReadTokens": 500,
  "lastCacheWriteTokens": 200,
  "lastOutputTokens": 800,
  "contextLimit": 524288,
  "model": "MiniMax-M3",
  "ts": 1234567890
}
```

### `POST /api/refresh`

Re-fetch quota + per-turn context. The webui calls this when the user
clicks the "刷新" button in the usage popover.

**Response 200** `{ok: true}`

---

## Protocol (acp shim)

These endpoints wrap the acp protocol methods that the webui *can*
call. Methods that mcode 0.1.5 doesn't implement return 501 with
`{code: 'unsupported'}`.

### `POST /api/protocol/set-mode`

Calls `session/set_mode`. **Currently returns 501** (mcode 0.1.5).

### `POST /api/protocol/set-config-option`

Calls `session/set_config_option`. **Currently returns 501**.

### `POST /api/protocol/cancel`

Calls `session/cancel`. **Currently returns 501** (falls back to
SIGTERM on the subprocess).

### `POST /api/protocol/load-session`

Calls `session/load`. Works in 0.1.5.

**Request** `{sessionId: "mvs_…", cwd: "C:\\…"}`

### `POST /api/protocol/activate-session`

Calls `session/activate`. **Currently returns 501**.

### `GET /api/protocol/list-sessions`

Calls `session/list`. Works in 0.1.5.

### `GET /api/protocol/capabilities`

Returns the list of acp methods the webui knows about and their
support status. Used by the webui to decide which UI controls to
enable.

**Response 200**
```json
{
  "ok": true,
  "agentInfo": { "name": "mcode", "title": "mcode", "version": "0.1.5" },
  "supported": ["session/new", "session/list", "session/load", "session/prompt", "session/close"],
  "unsupported": ["session/set_mode", "session/set_config_option", "session/cancel", …]
}
```

---

## Debug (gated)

### `POST /api/debug/inject`

Inject a fake event into the SSE channel for a CID. Used for testing
the UI without a real mcode subprocess.

**Request**
```json
{ "cid": "uuid", "type": "delta", "text": "hello" }
```

**Response 200** `{ok: true}`

**Gating**: this endpoint only works if `DEBUG_INJECT=1` is set in the
server's environment. The server logs a warning every time it's
called. Production deployments should leave the env unset.

### `GET /api/debug/state`

Returns the full per-cid state including internal flags. Same
`DEBUG_INJECT` gating.

---

## Static

### `GET /`

Returns `public/index.html`.

### `GET /<file>`

Returns the file from `public/` if it exists. Served by `serveStatic`.
Cache headers: `public, max-age=3600`. The HTML/JS/CSS paths
embed a `?v=N` cache-bust query string; bump it in `index.html` when
you want clients to refetch.

---

## Error responses

All errors follow one of these shapes:

```json
{ "ok": false, "error": "human-readable message" }
```

```json
{ "ok": false, "code": "unsupported", "error": "mcode 0.1.5 acp does not implement session/set_mode" }
```

```json
{ "ok": false, "error": "LAN 访问已关闭。在本机打开设置开启。" }
```

The HTTP status is appropriate to the cause (400 / 401 / 403 / 404 / 409 / 413 / 500 / 501).
