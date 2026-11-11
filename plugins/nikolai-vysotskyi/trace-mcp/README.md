# trace-mcp

Code intelligence for MiniMax Code: one MCP tool call returns callers, callees, and framework edges across the repo, so the agent stops reading files one by one to answer "what uses this".

Upstream source: https://github.com/nikolai-vysotskyi/trace-mcp

## Try it

```text
Find every caller of `validateHostedPluginDirectory` in this repo and tell me what breaks if I change its signature.
```

Expected result: the agent calls the trace-mcp search and impact tools and answers with the call sites plus the blast radius, without opening each file. On an unindexed project the agent runs `trace init` once first, then answers the same way.

## Requirements

- Node.js 22 or newer on `PATH`.
- `npx` on `PATH`. `mcp.json` starts the server as `npx -y trace-mcp@3.31.5` with no other arguments, so the exact validated version is resolved from the npm registry on every launch: a stale global install or any other same-named `PATH` entry is never consulted, and npm verifies the tarball integrity on download. Every trace-mcp release additionally ships with Sigstore provenance (`npm audit signatures`). The `env` block pins the runtime further: no daemon auto-spawn, no self-update, no usage ping (see Runtime below). Offline fallback: a pre-installed `trace-mcp` binary works if `trace-mcp --version` prints 3.31.5 or newer — minus the registry guarantee above, so prefer the `npx` form.
- macOS, Linux, or Windows.
- No account, no paid service, no API key.

## Runtime: which code answers, and how to check

`initialize` reports the version of the process that answers it — with the
shipped `env` block that is the pinned `trace-mcp@3.31.5` process, on every
launch. Three facts bound what that process may do behind the handshake:

- Trace-mcp can execute calls on a background daemon (loopback HTTP,
  default port 3741, e.g. the desktop app's) instead of in-process. Left at
  defaults, a session proxies to a daemon it finds there — and
  `TRACE_MCP_NO_DAEMON=1` alone only stops *spawning* one, not proxying to
  one already running. This plugin therefore additionally points
  `TRACE_MCP_DAEMON_PORT` at port 48171, which it never binds: the daemon
  health poll cannot match, so no foreign backend is ever adopted, even when
  the user runs a desktop daemon on 3741. Verified live: with a newer daemon
  on 3741, the pinned session still answered `3.31.5` (see Smoke below).
- `TRACE_MCP_NO_AUTO_UPDATE=1` disables the self-update that would
  otherwise replace the running install mid-session.
- `TRACE_MCP_TELEMETRY=off` disables the daily usage ping for sessions
  launched through this plugin (remove the line to restore the documented
  default ping described under Data and network).

To audit a running setup independently: `initialize` gives the launcher
version, and `curl http://127.0.0.1:3741/health` reports a reachable
daemon's own version and pid (`{"status":"ok","version":"…","pid":…}`).
If both report the pinned version, launcher and backend coincide.

## Data and network (as shipped by this plugin)

- As launched by this plugin's `mcp.json`, the server makes no network
  calls at all: the usage ping is forced off (`TRACE_MCP_TELEMETRY=off`)
  and the self-update check is disabled, so there is nothing to phone home
  to. The code index is built and kept on the user's machine; source code
  never leaves it.
- Two opt-in features change that, and neither is enabled by default: cloud embedding providers sit behind an explicit consent gate (`~/.trace/consent.json`, granted per provider) and send code excerpts to the configured provider; OTLP/Langfuse export sends spans to a backend you configure. Enabling either is a deliberate step outside this package's defaults.
- Without the plugin's `env` overrides (plain `trace-mcp` defaults), up to one anonymous usage ping per day goes to Google's GA4 Measurement Protocol endpoint: a persistent locally-generated UUID (stored in `~/.trace/telemetry-state.json`), the trace-mcp version and previous version, install/upgrade signal, Node major, OS platform, timezone country, MCP client name and the model it mostly drove, number of indexed repositories, machine class (arch, cores, RAM in whole GB, kernel version), tool preset and advertised tool count, aggregate tool-call/saved-token deltas, and daemon start/crash counters. No code, no paths, no file names, no query content, no IP. Full field list: https://trace-mcp.com/privacy.html. Turn it off with `TRACE_MCP_TELEMETRY=off`, or with `"telemetry": { "usage_ping": false }` in `~/.trace/.config.json`. Suppressed automatically in CI.
- No other network access with default settings. No credentials in the package.

## Writes

Write surfaces fall into four groups. Nothing below writes without being
called; read-only calls (`search`, `get_outline`, `plan_refactoring`, …)
never touch disk beyond the local index they read.

**1. Checkout edits — six tools, all `dry_run: true` by default.** The
server advertises them only under the `dev` preset (`load_tools`), never
under default, and each call previews first and writes nothing until
re-called with `dry_run: false`:

- `apply_rename` — renames a definition plus every reference in one operation, after collision detection. Past 20 files the apply fails closed (`success: false`, `Rename affects N files (>20). Pass confirm_large: true to proceed.`) and returns the preview so the call can be re-issued deliberately.
- `apply_codemod` — pattern rewrites (AST-aware on TypeScript/JavaScript, regex fallback elsewhere). Same >20-file `confirm_large` gate as rename, same fail-closed shape.
- `extract_function` — extracts a line range into a named helper (single file, TypeScript/JavaScript). Rejects multi-return slices with a structured error instead of guessing; lowers `confidence` on shadowed-variable cases.
- `apply_move` — moves a symbol between files, or renames/moves a file, updating imports.
- `change_signature` — adds, removes, renames, or reorders parameters and updates call sites.
- `remove_dead_code` — deletes one symbol after verifying it is dead (multi-signal detection or zero incoming edges), and warns about orphaned imports.

`plan_refactoring` previews any rename/move/extract/signature change without touching files — the read-only way to review blast radius first.

Two limits, stated plainly: applied edits are not rolled back automatically (a failed type-check after the fact is reported, not reverted — review the preview, or version-control the checkout), and every file argument is confined to the indexed project root (out-of-root paths are rejected before any write; writes addressed through symlinks pointing outside the root are refused at write time — both verified against the pinned 3.31.5, see Smoke).

**2. Your own tool config — two tools.** `apply_startup_recommendations`
(`dry_run: true` by default) acts on the *user's* setup, not the indexed
checkout: it can disable an unused MCP server in the client config, move an
unused skill aside, or delete duplicated instruction lines. Every write
lands a restorable backup first, and `rollback_startup_recommendations`
undoes one apply byte-for-byte (latest backup by default).

**3. Local state under `~/.trace/` — never the checkout.** Decision memory
(`remember_decision` and friends) persists to `decisions.db`; agent task
state (`trace_state_*`) to `state.db`; learned ranking weights
(`tune_weights`, itself `dry_run: true` by default and inert unless
telemetry is enabled) to `tuning.jsonc`; packed corpora
(`build_corpus`/`delete_corpus`) to `corpora/`; graph checkpoints
(`snapshot_graph`) to the snapshots store; the startup-recommendation
backups above to their backup dir. Index maintenance (`reindex`,
`register_edit`, `embed_repo`, `subproject_sync`, …) rewrites only the
local index and is idempotent — re-running converges to the same state.

**4. Content returned in-band, not written.** `generate_docs`,
`generate_sbom`, and the various `export_*` tools return the generated
document as the call result; they create no files. (Their non-readonly
protocol annotations are conservative.) `visualize_graph` and
`visualize_subproject_topology` are the exception: they write one HTML
file and return its `outputPath`.

The refactoring and codemod skills need the checkout tools visible: under the server's default preset they are hidden (`Tool "apply_rename" is not available in this session's tool preset`), so load the `dev` preset first (`load_tools`).

## Smoke: reproducing the executable claims

`smoke/exact-pin-smoke.mjs` (Node 22+, stdlib only) spawns the pinned
build over stdio with the same environment `mcp.json` ships, against a
scratch fixture with an outside-root canary, and asserts: the handshake
version equals the pin; the default surface holds 29 tools with no
mutators while `dev` holds 46 with `dry_run` defaulting to true;
a read call resolves the fixture and writes nothing; rename dry-run
previews and the >20-file apply fails closed; traversal and symlink
writes are refused with the canary intact; one real `extract_function`
applies (execution is local, not stubbed); and no telemetry state is
written. `smoke/last-run.jsonl` is the transcript of the latest passing
run (14/14, 2026-09-26, with a newer third-party daemon present on the
default port to prove the session does not adopt it):

```sh
node smoke/exact-pin-smoke.mjs [--pin trace-mcp@3.31.5]
```

## Skills and MCP

Skills (each directory matches its frontmatter `name`): `trace-mcp` (routing: call trace-mcp instead of reading files when exploring a codebase), `trace-mcp-refactoring` (risk assessment and cross-file renames), `trace-mcp-codemod` (bulk mechanical edits), `trace-mcp-pre-commit` (security, quality-gate, and antipattern checks before committing).

MCP: one stdio server, `trace-mcp`. Upstream counts: 182 tools, 81 languages, 88 framework integrations.

## License

MIT. See [LICENSE](LICENSE).
