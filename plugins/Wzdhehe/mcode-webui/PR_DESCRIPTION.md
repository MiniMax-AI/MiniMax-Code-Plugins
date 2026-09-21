# PR Description — Mcode-webui plugin

> **Submission body for the upstream PR to the
> [MiniMax-Code-Plugins](https://github.com/MiniMax-AI/MiniMax-Code-Plugins)
> community registry. Use this as the PR body verbatim.**

## What this PR adds

- New plugin at `plugins/Wzdhehe/mcode-webui/` per Agent Plugins 1.0 spec
  - `plugin.json` (version `2.0.0`) with the 10 white-listed top-level fields
  - `skills/mcode-webui/SKILL.md` with `{name, description}` frontmatter
  - `LICENSE` (MIT)
  - `README.md` (user-facing quick start + 5 real screenshots in `docs/screenshots/`)
  - `references/SECURITY-NOTES.md` (canonical security disclosure)
  - `docs/` (ARCHITECTURE, API, CAPABILITIES, DEVELOPMENT, TROUBLESHOOTING,
    BORROW-harness-v2, MATH-skeleton-webui-v2, ANTI-PATTERNS-FIX-PLAN,
    PROJECT-CHARTER-webui-v2, VERIFICATION-REPORT, HTTPS-REVERSE-PROXY, CI)
  - `server/`, `public/`, `test/`, `checks/`, `scripts/` (real directories, kept
    in sync with the project root; packaged as-is into `dist/` for the release
    artifact. `checks/` holds the module-mocked suites that need
    `--experimental-test-module-mocks` and are therefore excluded from the
    marketplace root gate's flagless discovery — see docs/CI.md)
  - `package.json` (copy of project root, with `test` / `test:unit` /
    `test:mocked` / `test:integration`, `check` / `check:ci`, `coverage`, and
    `sbom` scripts)

## v2.0.0 changes from v1.x (industrialization)

This PR supersedes PR #16, which was the v1.0.0 marketplace submission
(28 days open, 4 `CHANGES_REQUESTED` reviews from @hetaoBackend). v2.0.0
addresses each of those reviews structurally rather than by patch:

| @hetaoBackend review on #16 | v2.0.0 fix | Where |
|---|---|---|
| Review 1 — `server/auth.js` missing v1.0.1 setter exports | `setExpectedToken` / `setTokenAuthEnabled` / `markFirstRunNotified` all exported + `isFirstRun` reads persisted state | `server/lib/auth.js` (B03 + §6.2 reconcile) |
| Review 2 — `server/lib/db.js:24-34` hard-coded `better-sqlite3` resolver | 4-tier candidate resolver (`MCODE_BETTER_SQLITE3` env → `MCODE_CMD` reverse-walk → `~/.mcode-webui/db-resolver.json` → built-in fallback) | `server/lib/db.js` (C01) |
| Review 3 — `SECURITY-NOTES.md` env vars not exported by `config.js`; `?token=` vs `Authorization` header inconsistency | 4 SECURITY-NOTES env vars now exported (`MCODE_WEBUI_UPLOAD_DIR` / `MCODE_WEBUI_SETTINGS_PATH` / `MCODE_BETTER_SQLITE3` / `DEBUG_INJECT`); `scripts/check-docs-alignment.mjs` is now a CI gate that asserts the 3-way consistency (README + plugin.json + SECURITY-NOTES ↔ router.js + config.js) on every PR | `server/lib/config.js` (§6.2) + `scripts/check-docs-alignment.mjs` (B05) |
| Review 4 — marketplace-side sync not done; 3 prior findings still outstanding | Marketplace plugin tree fully rewritten in this PR (every file in `plugins/Wzdhehe/mcode-webui/` is new or modified); 3 prior findings closed by structural changes; round-8 CSRF fix from `Wzdhehe/Mcode-webui` is included | this PR + BORROW-harness-v2 / ANTI-PATTERNS-FIX-PLAN docs |

Beyond closing the prior reviews, v2.0.0 adds 9 industrial-grade properties
backed by 19 implementation leases (see
[`docs/VERIFICATION-REPORT.md`](docs/VERIFICATION-REPORT.md) for the
headline summary and [`docs/PROJECT-CHARTER-webui-v2.md`](docs/PROJECT-CHARTER-webui-v2.md)
for the charter):

| # | Property | Where |
|---|---|---|
| 1 | **Verifiability** — append-only NDJSON event stream + SHA-256 hash chain | `server/lib/events.js` (B01) + 18 hook sites |
| 2 | **Observability** — independent anomaly SSE channel + bell-icon data feed | `server/lib/alerts.js` + `server/routes/alerts.js` (B02) |
| 4 | **Governability** — per-request `authorize(action, ctx)` Promise, 5-minute default fail-closed, 16 hook sites | `server/lib/authorize.js` (B03) |
| 5 | **Reproducibility** — `package-lock.json` + CycloneDX 1.5 SBOM + npm-audit integration | `scripts/gen-sbom.mjs` + `docs/CI.md` local gates (C02) |
| 6 | **Testability** — dual-mode `node --test` suite (with / without `--experimental-test-module-mocks`) + local cross-Node/OS matrix recipe | `docs/CI.md` (C02) + marketplace root `validate` CI |
| 7 | **Discoverability** — 13 `plugin.json` capabilities each carry a `description` (204-286 chars); CONTRIBUTING.md has a "Common npm test failures" section | `plugin.json` + `README.md` + `CONTRIBUTING.md` (B05) |
| 8 | **Math-grounded architecture** — every subsystem carries a citation to a `sih-math` theorem (PROB-018 / ORD-022 / TOP-008 / ALG-001 / etc.) | `docs/MATH-skeleton-webui-v2-2026-09-20.md` (A02) |
| 9 | **Single source of truth** — `scripts/check-docs-alignment.mjs` exits 0 in CI after the v2 reconcile | `scripts/check-docs-alignment.mjs` (B05) + §6 reconcile |

New capabilities (added on top of v1.x):

- **Chat list virtualization** for ≥200 messages (B01 + C04)
- **Cross-workspace session search** via `/api/sessions/search?q=…` (B05 + C05)
- **Session export to Markdown / JSON** via `/api/sessions/:id/export` (C06)
- **Quota forecast** via `/api/usage/forecast` — least-squares linear fit with R² confidence (C07)
- **Token-onboarding modal** — replaces the v1.0.1 stdout 14-line ASCII box with a UI modal gated by `MCODE_WEBUI_TOKEN_STDOUT=1` env (C08)
- **Per-{IP, token} rate limiting** with `MCODE_WEBUI_RATE_LIMIT` / `_BURST` env (C03)
- **HTTPS reverse-proxy docs** for nginx / caddy / Traefik 2 (C03)

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
ℹ tests 834
ℹ suites 38
ℹ pass 828
ℹ fail 4            # pre-existing better-sqlite3 NODE_MODULE_VERSION 141↔147
                     # ABI drift on the runner; reproducible across all plugin
                     # releases since v0.5. Repro: `npm rebuild better-sqlite3`.
ℹ skipped 2
ℹ duration_ms ~700

$ npm run check
$ node scripts/check-docs-alignment.mjs
[1/6] plugin.json → README.md + docs/CAPABILITIES.md  ✓
[2/6] README.md + docs/API.md → server/router.js      ✓
[3/6] docs/API.md → server/lib/config.js env exposure ✓
[4/6] references/SECURITY-NOTES.md env vars → config.js ✓
[5/6] plugin.json round-trip parse + capability shape   ✓
[6/6] known drift: cleanup-orphans endpoint consistency ✓

OK all checks passed.   (exit 0)

$ npm run sbom
$ node scripts/gen-sbom.mjs
bomFormat: CycloneDX
specVersion: 1.5
components: 115    (zero runtime deps; 115 transitive dev deps)

$ npm audit --omit=dev --audit-level=low
0 vulnerabilities
```

Coverage (via `c8` against `server/lib/**/*.js` + `scripts/**/*.mjs`):

```
All files         : 92.93% lines / 82.99% branches / 100% functions
db.js (C01)       : 81.69% lines / 76.08% branches
events.js (B01)   : 92.12% lines / 78.78% branches
markdown.js (C06) : 100%   lines / 83.58% branches
quota-forecast.js : 97.18% lines / 88.63% branches
rate-limit.js     : 99.20% lines / 87.80% branches
```

Test breakdown (selected):
- `lib-events.test.js` — 27 tests (NDJSON atomic write, monotonic seq, hash chain)
- `lib-events-hash.test.js` — 8 tests (tamper detection, chain restore)
- `lib-alerts.test.js` — 20 tests (3 levels, 60s dedup, ring buffer, **dedup survives ring wrap** + **audit payload survives** — regression coverage added in commit 8f2e86b after V01 review)
- `routes-alerts.test.js` — 6 tests (SSE replay, heartbeat, close)
- `lib-authorize.test.js` — 20 tests (whitelist, timeout, per-cid cleanup)
- `lib-interaction.test.js` — 37 tests (commands parser, permission presets, ask-user modal)
- `lib-feedback.test.js` — 12 tests (command feedback, message thumbs)
- `check-docs-alignment.test.js` — 15 tests (live integration, drift round-trip)
- 5 unit-edge suites from D01 — 130 tests (db resolver / rate limit / markdown / quota / events concurrency)
- 4 integration suites from D02 — 38 tests (router-boot / sse-channel / event-chain / transports matrix / check-docs)

CI: the marketplace repository's root GitHub Actions workflow (ubuntu,
Node 22) runs `npm ci && npm run check`, which recursively executes this
plugin's suite. There is no plugin-owned workflow — the gates that
actually run are documented in `docs/CI.md`. Local full suite:
`npm run check:ci && npm test && npm run sbom && npm audit`.

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
- [x] `npm test` — 828 pass, 4 fail (pre-existing better-sqlite3 ABI), 2 skipped
- [x] `npm run check` — exit 0 (all 6 alignment groups green)
- [x] `npm run sbom` — CycloneDX 1.5 emitted, 115 components
- [x] `npm audit` — 0 vulnerabilities
- [x] Coverage — 92.93% lines / 82.99% branches / 100% functions
- [x] `references/SECURITY-NOTES.md` covers all red-line 7 topics + 4 env-var exports
- [x] LICENSE present (MIT)
- [x] README.md present + 5 real screenshots in `docs/screenshots/`
- [x] No symlinks (release artifact expands junctions)
- [x] No UTF-8 BOM in any text file
- [x] No placeholder markers in shipped files
- [x] No `hooks` / unsupported capability fields
- [x] One plugin per PR (this PR is only `plugins/Wzdhehe/mcode-webui/`)
- [x] `Closes #16` (the v1.0.0 marketplace submission) — merge of this PR auto-closes #16
