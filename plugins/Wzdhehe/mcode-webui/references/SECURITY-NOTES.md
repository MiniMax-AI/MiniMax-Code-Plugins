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

- **Binds `127.0.0.1` (loopback) by default** — LAN exposure is an
  explicit opt-in: the `HOST` env var (always wins) or the persisted
  `lanBind` setting (`POST /api/settings {lanBind: true}`, takes effect
  after restart). v2 security hardening (PR #55 review point 2); see §1.
- **CORS is trusted-origin reflection, not a wildcard** — only this
  server's own origins (loopback + LAN address while LAN sharing is on)
  plus the explicit `trustedOrigins` allowlist are ever trusted; a
  mutating request that carries an untrusted browser `Origin` is 403'd
  before every other gate, with no loopback exemption. See the CORS
  section below (PR #55 review point 1).
- **`?token=` query string** is supported as a Bearer-token equivalent for
  browser convenience. Browser URL bar can leak the token via history /
  referer / shoulder-surfing — prefer `Authorization: Bearer` header for
  any non-browser caller. The token-bearing `lanUrlWithToken` share URL
  is a **first-run bootstrap surface only** — after the operator
  acknowledges the token it is omitted entirely, and re-issued exactly
  once per rotation (§2.3).
- **`DELETE /api/sessions/:id` deletes the corresponding mcode session from
  your real mavis sqlite (`~/.minimax/v2/sqlite/runtime-state.sqlite`)**.
  Pass `?dryRun=true` first to preview. Outcomes are explicit —
  `deleted` / `already_absent` / `unsupported_schema` / `db_error` —
  and a SQL/IO failure never reports success (§3.1).
- **Reads `~/.minimax/v2/sqlite/runtime-state.sqlite`** (read-only) for
  real token usage. The plugin **never** writes that file.
- **Writes file uploads to `MCODE_WEBUI_UPLOAD_DIR`** (default
  `.webui-uploads/` next to the webui), inside a bounded streaming
  parser with request / file / quota limits (§3.2). No files outside
  that directory are written.
- **Workspace changes and directory browsing are contained** to allowed
  roots (default: user home + default workspace + system tmp;
  `MCODE_WEBUI_WORKSPACE_ROOTS` replaces the set). See §4.
- **No telemetry, no remote endpoints.** All processing is local.

---

## 1. Network exposure

| Surface | Default | Override | Notes |
|---------|---------|----------|-------|
| HTTP bind | `127.0.0.1:8080` | `HOST` / `PORT` env; persisted `lanBind` setting | v2 security hardening (PR #55 review point 2): the socket bind is loopback unless the operator explicitly opts into LAN exposure. Resolution order: env `HOST` (trimmed, non-empty) > `lanBind === true` → `0.0.0.0` > `127.0.0.1` (see `server/lib/config.js#resolveBindHost`). Existing deployments with an explicit `HOST` keep their bind unchanged. |
| LAN exposure opt-in | off | `POST /api/settings {lanBind: true}` (persisted; binds `0.0.0.0` on the next boot) or `HOST` env | The settings snapshot discloses the real exposure surface: `lanBind`, `bindHost` (what the next boot resolves to), `lanExposed`, `bindRestartPending`, and a bilingual `lanExposureNotice` string. |
| LAN broadcast toggle | `true` (UI) | `/api/settings` POST `{lanBroadcast: false}` | Server returns 403 with a friendly page when off and request is non-local. Toggle is **runtime**; resets to default on restart. |
| Browser origin boundary | trusted-origin reflection only | `trustedOrigins` setting (§ CORS) | Mutating requests (`POST` / `DELETE`) carrying an untrusted `Origin` header are 403'd before every other gate, **including the loopback exemption**. Origin-less clients (curl, MCP, CLI) are unaffected. |
| Outbound network | **none** | n/a | The webui does not call any external service. The only outbound traffic is the `mcode` CLI subprocess and `mmx quota show` (local binary). |
| Inbound auth | none (loopback) / `?token=` or `Authorization: Bearer` (non-loopback) | `TOKEN` env | See §3. |

**Loopback-default rationale (v2, PR #55 review point 2)**: this service
is a high-privilege surface (agent control, filesystem access, session
control). Network reachability must be the operator's explicit choice,
not a default. LAN sharing remains fully supported — a Kimi-Code-style
web UI opened on a phone / tablet / second laptop is a primary use
case — but it is now an opt-in: either the familiar `HOST` env var
(docker / deployment scripts keep working untouched) or the `lanBind`
setting persisted through the settings API. Upgrades are zero-surprise:
any deployment that already set an explicit `HOST` keeps exactly its
old bind; only previously-implicit `0.0.0.0` exposure moves to
loopback. When LAN exposure is (or is about to be) in effect, the
settings API discloses it via `lanExposed` / `bindRestartPending` /
`lanExposureNotice` rather than leaving the operator to infer it.

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
- **`lanUrlWithToken` is a first-run bootstrap surface only** (v2
  security fix, PR #55 review point 1): the token-bearing share URL is
  returned by `GET /api/settings` **only while the operator has not yet
  acknowledged the token** (`tokenAcknowledged === false`). After
  acknowledgment the field is omitted entirely — the UI falls back to
  the bare `lanUrl`. A fresh token-bearing URL is minted again only via
  token rotation (`resetToken`), which resets the acknowledgment and
  re-issues the URL exactly once. Previously the URL was re-served on
  every settings poll, a long-lived token-bearing URL re-leaked on each
  request.
- **Mitigation**: for programmatic callers always pass
  `Authorization: Bearer` header instead of a token URL.

### 2.4 Error-message redaction
- Token is never included in JSON responses, error bodies, or SSE
  payloads. Error responses follow `{ok: false, error: "<message>"}` —
  no request URL or headers are reflected.
- See `test/lib-config.test.js` and `test/lib-lan.test.js` for coverage
  of the redaction paths.

---

## CORS / 跨源资源共享 (Cross-Origin Resource Sharing)

> **Disclosure scope:** the wildcard CORS of earlier versions was
> removed in the v2 security hardening (PR #55 review point 1). This
> section makes the exact header values, the trusted-origin policy, the
> browser Origin/CSRF gate, and the operator-facing `trustedOrigins`
> knob explicit per [OWASP CORS Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#cross-origin-resource-sharing)
> and red-line 7 (披露完整性 / disclosure completeness).

### Configuration (verbatim)

CORS headers are decided per request at the top of
[`server/router.js`](server/router.js#handleRequest) — Gate 1:

```js
res.setHeader("Vary", "Origin");
if (originTrusted) {
  res.setHeader("Access-Control-Allow-Origin", originHeader); // verbatim reflection — never a wildcard
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
```

- **Verbatim reflection, no wildcard.** When the request's `Origin` is
  trusted, the caller's own origin is reflected in
  `Access-Control-Allow-Origin`. `*` is never emitted.
- **Untrusted or absent `Origin` → zero `Access-Control-*` headers** on
  any response, including the `OPTIONS` preflight short-circuit —
  preflight and actual response stay consistent, so a browser can never
  conclude an untrusted-origin read is permitted. Clients that send no
  `Origin` at all (curl, MCP, CLI, tests) never needed CORS headers and
  get none.
- **Every response carries `Vary: Origin`** — the response varies by
  request `Origin` whether or not headers are reflected, so caches key
  on it either way.
- `Authorization` stays in `Allow-Headers` (the v1.0.1 PR #16
  reviewer-required assertion) so trusted-origin browser clients can
  authenticate with `Bearer` headers.

### Trusted origins (the full set)

The trust set is built per request by
`server/lib/lan.js#buildTrustedOrigins`:

1. **The server's own serving origins, always**: `http://127.0.0.1:<port>`,
   `http://localhost:<port>`, `http://[::1]:<port>` (plus the port-less
   serialization on default ports 80/443). The SPA lives there; its
   same-origin `POST`s carry an `Origin` header that must pass.
2. **The LAN address origin, only while LAN sharing is enabled**
   (`lanBroadcast` on and the host has a LAN IP) — the SPA served over
   the LAN address is still this server's own code.
3. **The explicit `trustedOrigins` allowlist from settings** — see below.

### The `trustedOrigins` setting

`POST /api/settings {trustedOrigins: [...]}` persists an explicit
cross-origin allowlist; `GET /api/settings` returns it. Validation
(fail-closed, whole batch):

- `http`/`https` **origin serialization only** — `scheme://host[:port]`,
  no path, no query, no fragment, no userinfo; anything else rejects
  the batch.
- At most **16 entries**, each **1..200 chars** (after trim +
  lowercase). Entries are lowercased, trimmed, deduplicated.
- An invalid batch is **rejected 400 before any state changes** — a
  malformed allowlist can never partially widen the trust surface.
- A hand-corrupted `settings.json` allowlist is sanitized on load: only
  a fully valid list survives, otherwise it resets to `[]` (a corrupt
  file can never widen the CORS trust surface).

### Origin / CSRF gate (Gate 1b)

Browsers attach an `Origin` header to non-`GET` requests (same- and
cross-origin alike). **Any mutating request — method other than
`GET` / `HEAD` / `OPTIONS` — whose `Origin` is present but untrusted
is rejected 403 `{ok: false, error: "cross-origin request rejected"}`
before every other gate**: before the LAN gate, before token auth,
before rate limiting, before the read-only gate.

Crucially, the gate has **no loopback exemption**: socket locality
(`isLocalRequest` → token bypass) is an identity fact about the client
*machine*, not about the browser *page* that initiated the request. A
page on `evil.com` targeting `http://127.0.0.1:<port>` also arrives
over a loopback socket — it is "local", would bypass the token — and is
still rejected, because its `Origin` is not ours. Local-only
authentication no longer doubles as a browser cross-origin exemption.
`Origin: null` (sandboxed iframe) counts as present-but-untrusted, not
absent. Clients that send no `Origin` at all (curl, MCP, CLI) pass
through unchanged.

### History — the hole this closes

Through v2.0 the router set an unconditional
`Access-Control-Allow-Origin: *` (plus `Authorization` in
`Allow-Headers`) on **every** response. Combined with the local-request
token bypass, any web page could read API responses by simply targeting
`http://127.0.0.1:<port>` — the browser dialed loopback, the server saw
a "local" socket and skipped the token, and the wildcard let the page
read the body (including `GET /api/settings`' then token-bearing
`lanUrlWithToken`). Cross-origin authenticated request forgery with a
stolen token (URL query string, `localStorage`, XSS-injected state)
was likewise possible from any origin. Both halves are closed: wildcard
removed (reflection only) and mutating cross-origin requests 403'd
regardless of socket locality.

### Mitigations (recommended for operators)

In order of operational cost:

1. **Loopback-only bind** — the v2 default (see §1). Eliminates the
   entire cross-origin surface because the server is unreachable from
   any other device, let alone any other origin.
2. **Keep `trustedOrigins` minimal** — only add origins you actually
   serve the SPA from behind (e.g. a reverse proxy's external origin —
   see `docs/HTTPS-REVERSE-PROXY.md`). Every entry is a page that can
   drive authenticated mutating requests.
3. **Disable LAN broadcast** — `POST /api/settings {lanBroadcast:
   false}` (see §3.3). Server returns 403 with a friendly page for
   non-local requests. Kills the cross-device attack surface.
4. **Tighten the read-only gate** — flip on the read-only toggle
   (§9): `POST /api/settings {readOnly: true}` makes non-local
   `POST` / `DELETE` return 403.
5. **Rotate the token before any cross-origin exposure** — operators
   who open the server to the LAN should rotate the token (§9.3) so any
   previously-leaked value becomes inert. The new value is broadcast
   over SSE to live clients and stored in their `localStorage`.

### Cross-references

- §1 — bind defaults and LAN broadcast toggle
- §2.3 — Token in URL query string (related exfiltration vector)
- §3 — Destructive endpoints (`DELETE /api/sessions/:id`,
  `POST /api/settings {resetToken: true}`, `/api/debug/*`)
- §9 — Token auth gate + `auth.token_rotated` SSE broadcast
- `test/router-cors.test.js` — locks the trusted-origin policy
  (`test/lib-lan-origins.test.js` locks the trust-set builder)
- `docs/HTTPS-REVERSE-PROXY.md` — adding a reverse proxy's external
  origin to `trustedOrigins`

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
   modifying any file. Use this before committing. The dry-run counts
   are held to the same error-classification rules as the real delete
   (below) — a preview cannot fake success by silently undercounting.
2. **Atomicity**: the actual delete runs as ONE explicit SQLite
   `transaction()` — any non-absent per-table error throws out of the
   transaction body, better-sqlite3 issues `ROLLBACK`, and no partial
   delete ever commits. Either all tables update or none do.
3. **Outcome enumeration (no fake success)** — see below.

**Outcomes (v2 security fix, PR #55 review point 4)**: every
`deleteMcodeSessionFromDb` call resolves to exactly one verdict, and a
SQL/IO failure **never** reports success (the old code swallowed every
per-table error as if the table were merely absent and still returned
`ok:true` — real failures were indistinguishable from "mcode version
without this table"):

| Outcome | Meaning | Response |
|---|---|---|
| `deleted` | Transaction committed; rows were removed | `{ok: true, outcome: "deleted", log, totalRowsDeleted, tablesAbsent}` |
| `already_absent` | Transaction committed; nothing matched (the session simply held no rows — tables individually confirmed missing are skipped benignly, and only then when the "no such table" error is corroborated by the schema catalog on the live connection) | `{ok: true, outcome: "already_absent", …}` |
| `unsupported_schema` | A table exists but has no `session_id` key column (corroborated via `table_info()`) — this mcode version's schema is not one we know how to delete from; transaction rolled back | `{ok: false, reason: "unsupported_schema", table, error}` |
| `db_error` | Lock conflict (`SQLITE_BUSY`/`LOCKED`), prepare/run failure, or IO error; transaction rolled back | `{ok: false, reason: "db_error", error, code?}` |

A confirmed missing table requires **both** SQLite's `no such table`
error shape **and** the connection's `sqlite_schema` agreeing the table
truly does not exist — a `no such table` message while the catalog
still lists the table is NOT confirmed and surfaces as a real error.
The `session.delete` audit event carries the `outcome` (plus
`tablesAffected` / `tablesAbsent` / `totalRowsDeleted`); if the audit
write itself fails the call returns `{ok: false, reason:
"audit_write_failed"}` — rows may be gone, but the operator sees the
audit gap, never a clean success. Re-running DELETE on an
already-deleted sid yields `outcome: "already_absent"`, not an error.

**Default behavior unchanged**: real delete. `?dryRun=true` is opt-in.

### 3.2 File upload

`POST /api/upload` writes to `MCODE_WEBUI_UPLOAD_DIR` (default
`.webui-uploads/` next to the webui). Files are stored with their
original names plus a uuid prefix to prevent collisions. The directory
is created on demand; no symlink resolution is performed on the target
path (so a hostile `MCODE_WEBUI_UPLOAD_DIR=/etc` is the user's problem,
not the plugin's).

**Bounded streaming with three enforced limits (v2 security fix, PR
#55 review point 3)**: the multipart parser is a streaming state
machine — body bytes flow through a `Transform` chunk by chunk into a
temp-file write stream, so resident memory is O(chunk), never O(body).
(The old parser buffered the entire body in memory and wrote with one
synchronous call; a hostile client could OOM the server by POSTing a
large body.) Three limits are enforced **mid-stream** — an over-limit
byte is rejected the moment it is seen, not after the body is read:

| Limit | Default | Env override (positive integer) | Error code |
|---|---|---|---|
| Total request body | 50 MiB | `MCODE_WEBUI_UPLOAD_MAX_REQUEST` | `UPLOAD_REQ_TOO_LARGE` |
| Single file | 25 MiB | `MCODE_WEBUI_UPLOAD_MAX_FILE` | `UPLOAD_FILE_TOO_LARGE` |
| Upload-directory quota | 200 MiB | `MCODE_WEBUI_UPLOAD_QUOTA` | `UPLOAD_QUOTA_EXCEEDED` |

- Over-limit requests get **413** with `{ok: false, error, code}` — the
  message names the limit and the env knob that raises it — plus
  `Connection: close` (the body was deliberately not consumed).
- Malformed multipart / truncated bodies get **400**
  (`UPLOAD_MALFORMED`; aborted streams `UPLOAD_ABORTED`). Anything else
  is 500.
- The file lands at its final name only via `rename()` after the
  closing boundary and a clean stream end; any failure or abort unlinks
  the temp file — **no half-written artifact survives**.

There is no auth on upload other than the standard `TOKEN` gate.
Anyone who can reach the server can drop files into the upload dir
(within the limits above).

### 3.3 LAN broadcast toggle

`POST /api/settings {lanBroadcast: false}` disables LAN access at
runtime. No persistent state. Restarting the server re-resolves the
bind per §1 (env `HOST` > persisted `lanBind` > loopback `127.0.0.1`).

### 3.4 `/api/debug/*` (testing only)

Endpoints under `/api/debug/*` are gated by `DEBUG_INJECT=1`. The
two currently implemented routes are `inject` (force a server-side event
into the SSE stream for testing) and `state` (return server-internal
state for debugging). **Never set `DEBUG_INJECT=1` in production** — it
bypasses the standard error handling.

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
| `~/.minimax-code/webui/.webui-sessions.json` | read+write | webui-side session store (atomic write, corruption-explicit — see below). |
| `~/.minimax-code/webui/.webui-uploads/` | write | File upload target (configurable via `MCODE_WEBUI_UPLOAD_DIR`; bounded by the §3.2 limits). |
| `<user-selected workspace, within allowed roots>` | read+list | Workspace picker (`/api/workspace/browse`). Reads directory tree only, no execution. Contained — see below. |
| `~/.minimax/runtime/cwd.json` | read | mcode TUI's last cwd (used as workspace default). Read-only — never written. |

**No writes to user data outside the configured upload directory.**

### 4.1 Workspace containment (v2 security fix, PR #55 review point 5)

Previously any authenticated client could set the workspace to **any**
absolute directory on the host (where `mcode` then runs with the server
process's identity), and `/api/workspace/browse` would enumerate any
directory's contents. Now both surfaces are bounded by **allowed
roots**:

- A candidate workspace path is `resolve()`d and then passed through
  `realpathSync` (all symlinks resolved); the result must land **within
  an allowed root** to be accepted. Directory traversal (`../`)
  collapses during resolve; symlink escapes surface during realpath —
  both end up hitting the containment check. Rejections carry an
  **actionable error**: the offending path, the resolved real path when
  it differs (symlink), the current list of allowed roots, and the env
  knob that widens them.
- **Default allowed roots** = the user's home directory + the resolved
  default workspace + the system tmp directory (i.e. every legitimate
  landing spot of the previous default behavior; the default workspace
  already falls back to home, and scratch-workspace conventions live in
  tmp).
- **`MCODE_WEBUI_WORKSPACE_ROOTS` env** widens or narrows the set:
  segments separated by the platform path separator (`:` POSIX / `;`
  Windows); **setting it fully replaces the default set** (no implicit
  merging). Non-existent or unresolvable segments are skipped.
- `browse` shares the same boundary: only directories within allowed
  roots can be enumerated, and the root view (no `path` parameter)
  lists only the allowed roots themselves — previously POSIX enumerated
  all of `/` and Windows enumerated drive letters, an unrestricted
  directory-enumeration oracle for any client that could reach the
  server.
- Known residual (honest disclosure): the workspace is stored in its
  `resolve()` form, not the realpath-normalized form; if a symlink is
  re-pointed outside the allowed roots *after* validation passes, a
  narrow window remains — far narrower than the previous
  "any directory" surface.

### 4.2 Session-store persistence (v2 hardening, PR #55 review point 5)

The webui-side session store (`.webui-sessions.json`) is written
atomically and fails loud:

- **Atomic writes** — save writes a same-directory temp file
  (`.tmp`) then `rename()`s it into place (same directory → same
  filesystem → rename is atomic). The main file on disk is always
  either the complete old content or the complete new content; a crash
  mid-write can only leave a `.tmp` (cleaned on the next save), never a
  truncated half-written store.
- **Single-writer serialization** — the server is a single Node
  process (no cluster/fork/worker) and all persistence calls are
  synchronous, so two saves cannot interleave at the syscall level.
  (If an operator truly runs two instances, rename atomicity still
  prevents tearing; last writer wins.)
- **Corruption is explicit, not silent** — a `JSON.parse` failure (or a
  non-array root) no longer silently reads as an empty store (the old
  behavior: the next load-modify-save erased all real data — a
  data-loss chain). Instead the corrupt bytes are quarantined to
  `SESSIONS_DB.corrupted-<timestamp>` (the original file is left
  untouched), an actionable error is logged (quarantine path +
  recovery instructions), and the store is then treated as empty for
  the session-list contract. The old data survives intact in the
  quarantine copy for manual restoration, cutting the
  corrupt → empty → overwrite-save data-loss chain.

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

- `npm test` runs `node --experimental-test-module-mocks --test
  test/*.test.js checks/*.check.mjs test/integration/*.test.js
  test/matrix/*.test.js` (mocked suites live outside `test/` so the
  flagless marketplace root gate never trips on the mock flag — see
  docs/CI.md "Test layout and suite routing").
- No lint gate exists: the `lint` script was removed in the
  2026-09-20 rigor fix (this tree never contained an ESLint or
  Prettier config; a declared gate that never ran green was deleted
  along with its unused devDependencies — see docs/CI.md honesty
  notes).
- All tests use **temp file fixtures** (`mkdtempSync`). No test writes
  to the user's real `~/.minimax/` or `~/.mcode-webui/` directory unless
  `MCODE_RUNTIME_DB` / `MCODE_WEBUI_SETTINGS_PATH` env is explicitly
  overridden.
- v1.0.1 round 4: `MCODE_BETTER_SQLITE3` env override added to
  `server/lib/db.js::getMcodeBetterSqlite3()`. The hard-coded path to
  mcode's bundled `better-sqlite3` only works in the canonical
  dev layout (`<mcode-root>/webui/`); the env override lets users on
  registry-installed or non-canonical layouts point at the right
  binary explicitly. Resolution priority: env override > `$MCODE_CMD`
  derived > dev layout fallback.
- Cross-platform: there is **no CI matrix**. The only CI is the
  marketplace root gate (single ubuntu / Node 22 job: `npm ci` +
  `npm run check`, which recursively runs every file under `test/`
  flagless). Cross-platform verification is a manual local recipe —
  see docs/CI.md "Local matrix".

---

## 9. v1.0.1 — LAN sub-card: read-only / token auth

v1.0.1 adds a secondary card under the `LAN access` chip in the bottom-left
panel. It centralizes the three most-relevant security / access controls:

| Control | What it does | Where the state lives |
|---|---|---|
| **LAN access** (toggle) | On/off for the 403 gate on non-local requests (unchanged from v0.5.ap) | In-memory only; resets to `true` on restart (intentional — admins shouldn't get locked out) |
| **Read-only mode** (toggle) | When on, non-local `POST` / `DELETE` to `/api/*` return 403 `{error: "read-only mode"}`. `GET`, `HEAD`, `OPTIONS` are exempt. Local requests are always exempt. `/api/settings` is exempt (escape hatch) | Persisted to `~/.mcode-webui/settings.json` |
| **Token auth** (toggle) | When on, non-local requests must carry `?token=` or `Authorization: Bearer`. When off, the gate is bypassed even if a token is set (LAN-only deployment mode) | Persisted |
| **Token value + reset** | First-run: server generates a 32-hex-char token (`crypto.randomBytes(16).toString('hex')`) and writes it to `~/.mcode-webui/settings.json`. The token is **printed to stdout exactly once at first start** (not to `.server.log`). The settings card shows the token until the operator clicks "我已保存" (acknowledge). After acknowledgment, the server stops sending the token in `GET /api/settings` responses — only already-connected clients keep it. `Reset token` generates a new value, persists, broadcasts an `auth.token_rotated` SSE event so other connected clients update their `localStorage` + `Authorization` header live, and resets `tokenAcknowledged` to `false` (the new token is shown again). | Persisted to `~/.mcode-webui/settings.json` (mode 0600, atomic write via `.tmp` + rename) |

### 9.1 Token resolution priority (per request)

1. `process.env.TOKEN` (highest — escape hatch for `docker run -e TOKEN=...` deploys)
2. In-memory `expectedToken` synced from `settings.js` after `init()` / `rotateToken()`
3. Static `TOKEN` from `config.js` (fallback for tests)

If all three are empty, the token-auth gate is **fail-open** (back-compat with
the v1.0.1 "loopback-only / trusted LAN" deployment). To force-fail-secure
on first run, set `TOKEN=<value>` in the environment.

### 9.2 Token storage

- `~/.mcode-webui/settings.json` (mode 0600 on Unix; best-effort on Windows).
- File is **excluded from the webui process's standard logs** — `console.log`
  on first start is the only place the token is printed.
- Backup-on-corruption: if the file fails JSON.parse, the server renames it
  to `settings.json.bak` and starts with defaults (logs a warning).
- Override path for tests / non-default installs:
  `MCODE_WEBUI_SETTINGS_PATH=/some/other/settings.json`.

### 9.3 Token rotation — SSE `auth.token_rotated`

When the operator hits "Reset token" in the UI:

1. `POST /api/settings {resetToken: true}` (must already be authenticated)
2. Server generates new 32-hex token, writes to disk
3. Server broadcasts `event: auth.token_rotated\ndata: <new-token>\n\n` to
   every connected SSE client (the connection is already authenticated,
   so the token in cleartext over SSE is no worse than the periodic state
   push that also includes `currentToken` for the same window).
4. Server also broadcasts a regular state push (`currentToken` will be in
   the JSON body until the operator clicks "我已保存").
5. Clients that receive the SSE event update their `localStorage` and the
   live `HEADERS.Authorization` object in place — subsequent `fetch` calls
   automatically use the new token.
6. Clients on the old token that didn't get the SSE event (offline, etc.)
   will see 401 on their next request and need to manually re-open with
   the new token URL.

### 9.4 `currentToken` in `/api/settings` responses

- Returned **only when `tokenAcknowledged === false`**.
- After the operator clicks "我已保存", the server omits the token from
  subsequent responses. This is a deliberate trade-off: clients that lost
  their `localStorage` (e.g. cleared browser data) will need to either
  trigger a rotation (operator-visible) or look up the token in
  `~/.mcode-webui/settings.json`.
- A programmatic / CI caller that needs the token should call
  `POST /api/settings {resetToken: true}` to force a rotation and then
  read the response's `currentToken`.

### 9.5 Files added / modified in v1.0.1

- **NEW** `server/lib/settings.js` (substantially rewritten) — owns
  persistent settings + token generation + interface lookup.
- **NEW** `server/lib/auth.js` — adds `setExpectedToken`,
  `setTokenAuthEnabled`. Per-request token check still happens here.
- `server/lib/lan.js` — no change in v1.0.1 (kept the existing
  `detectLanIp` / `isLocalRequest` / `LAN_IP`).
- `server/router.js` — adds read-only gate (in addition to the existing
  LAN and token gates). Interface-allowlist gate was prototyped in
  v1.0.1 but removed before release per PR #16 reviewer scope.
- `server/routes/settings.js` — accepts new fields, handles rotation.
- `server/lib/state-bus.js` — adds `broadcastTokenRotated`; SSE state
  push now includes `readOnly`, `tokenEnabled`, `currentToken` (when
  not acknowledged), `tokenAcknowledged`, `tokenRotatedAt`.
- `public/app/state.js` — `HEADERS` is now a live-mutable object;
  new `setToken()` + SSE `auth.token_rotated` handler.
- `public/app/render.js` — `renderLanCardContent(settings)` exported.
- `public/app/events.js` — `#chip-lan` click toggles the sub-card
  (was: directly toggled `lanBroadcast`); new handlers for each control
  inside the card.
- `public/index.html` — `<div id="lan-card" hidden>` markup; CSS in
  `public/styles/main.css`.
- `public/app/i18n.js` — 22 new keys (`lan_card_*`).
- **NEW** `test/lib-settings.test.js` — persistence + new setters.
- **NEW** `test/router-readonly.test.js` — read-only gate logic.
- Extended `test/lib-auth.test.js` (`setExpectedToken`,
  `setTokenAuthEnabled`), `test/routes-settings.test.js` (new fields,
  `resetToken`, `acknowledgeToken`), `test/_setup.js` (mock shape).


---

## 8. Reporting issues

Security-relevant bugs: open a private advisory on the
[mavis/plugins GitHub repo](https://github.com/Wzdhehe/Mcode-webui/security/advisories)
(once published). Non-security bugs: use the issue tracker.
