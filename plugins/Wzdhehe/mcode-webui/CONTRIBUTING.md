# Contributing to Mcode Web UI

Thanks for your interest in Mcode Web UI! This document covers
the day-to-day contribution workflow. For the bigger picture (plugin
packaging, release process), see [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)
and [`plugins/Wzdhehe/mcode-webui/README.md`](plugins/Wzdhehe/mcode-webui/README.md).

## Code of conduct

Be kind. We review for substance, not for style preferences. If a
change makes the webui more correct / faster / easier to use, it's
in scope.

## Development setup

Requirements:

- **Node 22.19+** (uses `node:test`, `URL.parse`, `Blob.stream`)
- **Mcode CLI 0.1.4+** on `PATH` (or `MCODE_CMD` pointing to it)
- A POSIX-like shell on Windows: PowerShell 7+ or Git Bash

Clone and run:

```bash
git clone https://github.com/Wzdhehe/Mcode-webui.git
cd Mcode-webui
npm ci                    # devDependencies only (c8 — coverage)
npm test                  # unit + mocked checks + integration + matrix
npm run check             # docs / manifest alignment gate
npm run dev               # node server.js
# → http://127.0.0.1:8080/
```

`npm test` and `npm run check` **must pass** before opening a PR.

## Screenshots

The README references 5 PNGs under `docs/screenshots/` (startup, token
modal, chat streaming, tool call, session switch). When you make a UI
change that affects one of those screens:

1. Capture the new screen as PNG (any standard screenshot tool is fine;
   a 1.5× or 2× DPR capture is preferred for retina display).
2. Drop the file into `docs/screenshots/` using the existing filename
   scheme (`NN-<slug>.png`).
3. Update the alt text and "What it shows" row in
   [README.md → Screenshots](README.md#screenshots).
4. Run `npm run check` — the doc-alignment script asserts on the
   filenames referenced in README; if you rename a file without
   updating README the check fails.

## Common `npm test` failures

These are the failures that show up most often on PRs. If your
failure matches one of these, the fix is below — no need to open
an issue.

### C01. `better_sqlite3_not_loaded` / `Cannot find module 'better-sqlite3'`

`server/lib/db.js` resolves `better-sqlite3` via a hard-coded candidate
chain (env `MCODE_BETTER_SQLITE3` → `MCODE_CMD` relative → home layout
→ dev layout). If none of those paths exist on your machine, the
`server-startup.test.js` and `lib-db.test.js` suites fail with the
above error.

**Fix**:

1. Find where mcode's bundled `better-sqlite3` actually lives:
   ```bash
   find ~/ -path "*/node_modules/better-sqlite3" -type d 2>/dev/null | head -3
   ```
2. Point the env at it:
   ```bash
   export MCODE_BETTER_SQLITE3=/path/to/better-sqlite3
   npm test
   ```
3. If you can't find any `better-sqlite3` at all, install mcode
   (npm-global `mcode` or a dev checkout under `~/.minimax-code/`).
   The test suite skips the sqlite-backed tests when no better-sqlite3
   is present, so the rest of the suite should still pass.

### C02. Cross-OS path failures (`join` vs `path.posix.join`)

Tests that resolve filesystem paths fail on Windows with
`TypeError: must be string, not undefined` or
`EBADF: bad file descriptor`. The cause is usually code that
calls `path.join` (platform-aware) but the test fixture path was
built with `path.posix.join` (always `/`), or vice versa.

**Fix**:

- For repo-internal paths (fixtures, temp dirs): use
  `path.join(import.meta.dirname, ...)` — Node resolves it on both
  platforms.
- For user-supplied workspace paths: leave them as the user typed
  them; let `path.join` do its job.
- If a test passes on macOS / Linux but fails on Windows AppVeyor,
  check whether the test does any path comparison (`assert.equal(p, "/tmp/...")`)
  — replace with `path.normalize(p)` or compare just the basename.

### C03. `mock.module` does not take effect (Node 24.14 pitfall)

Symptom: a test sets up `t.mock.module(...)` for `lib/foo.js` and then
dynamically imports `lib/foo.js` inside the same `before((t) => ...)` —
the SUT still imports the real implementation. Only the
`--experimental-test-module-mocks` flag (`npm test` enables it) makes
the mock registration take effect.

**Fix**:

- Mocked suites live in `checks/*.check.mjs` (moved out of `test/` by
  the 2026-09-20 rigor fix: `t.mock.module` needs the flag, and the
  marketplace root gate executes everything under `test/` flagless).
  Run them via `npm test`, `npm run test:mocked`, or
  `node --experimental-test-module-mocks --test checks/<name>.check.mjs`.
- `test/*.test.js` is the flagless root-gate surface: a
  `t.mock.module` call added there fails the whole file under the
  marketplace gate. New flag-dependent tests belong in `checks/`.
- If you must call `node` directly, use the same flag list as
  `package.json#scripts.test`.

### C04. `MCODE_RUNTIME_DB` not set → tests mutate the real mavis sqlite

`server-startup.test.js` exercises `runStartupCleanup()` which can
touch the user's real `~/.minimax/v2/sqlite/runtime-state.sqlite`.
If you run the suite without `MCODE_RUNTIME_DB` pointed at a temp
file, the test may delete mcode sessions from your real DB.

**Fix**:

```bash
export MCODE_RUNTIME_DB="$(mktemp -d)/runtime-state.sqlite"
touch "$MCODE_RUNTIME_DB"
npm test
rm -rf "$(dirname "$MCODE_RUNTIME_DB")"
```

Nothing sets this env automatically — this plugin has no CI of its
own (see `docs/CI.md`); set it manually for local test runs.

## Repository layout

This repo has a **dual layout** — both copies are kept in sync:

```
Mcode-webui/                          # ← the development tree (root)
├── server/  public/  test/          # Node + frontend + tests
├── docs/                            # ARCHITECTURE, API, CAPABILITIES, …
├── acp.mjs, server.js, package.json
│
└── plugins/Wzdhehe/mcode-webui/     # ← the plugin artifact
    ├── server/  public/  test/      # ↑ real copies, not symlinks
    ├── docs/  references/  skills/
    ├── plugin.json  package.json  LICENSE
    ├── README.md  PR_DESCRIPTION.md
    └── SKILL.md                    # lives at skills/mcode-webui/SKILL.md
```

**Why two copies?** The community plugin registry takes the
`plugins/.../Mcode-webui/` tree as the submission. We keep it as a
real directory copy (not a junction or symlink — those break
zip-packaging and confuse `git log`).

The historical `setup:plugin` junction-setup script no longer exists
in this tree's `package.json`. The current script set is
`test` / `test:unit` / `test:integration`, `check` / `check:ci`,
`sbom`, and `coverage` (see `package.json#scripts` and `docs/CI.md`).

## Editing flow

1. **Edit at the repo root** (`server/`, `public/`, `test/`).
2. **Mirror the change to the plugin tree** — copy the changed files
   from `<root>/server/...` to `plugins/Wzdhehe/mcode-webui/server/...`,
   and the same for `public/`, `test/`, `docs/`. (There is no
   packaging script in the current script set; the sync is manual
   per PR.)
3. **Run the gate**:
   ```bash
   npm test
   npm run check
   ```
4. **Commit** with a conventional message (see below).
5. **Push** to a feature branch and open a PR.

## Commit message format

We loosely follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body — explain WHY, not what>
<footer — refs, BREAKING CHANGE, etc.>
```

Common types:

- `feat:` — new feature
- `fix:` — bug fix
- `refactor:` — internal change, no behavior diff
- `test:` — test-only change
- `docs:` — documentation only
- `chore:` — build / CI / tooling

Scope is the area (`server`, `public`, `plugin`, `acp`, `test`, `docs`).

Example:

```
fix(acp): retry session/fork once on "Method not found"

mcode 0.1.5 returns "Method not found" for session/fork on the
first attempt but accepts it on retry. One retry is enough in
practice; log + continue.
```

## Pull request checklist

- [ ] `npm test` passes (with `--experimental-test-module-mocks`)
- [ ] Flagless `node --test` also passes (dual-mode requirement — see
      `docs/CI.md`)
- [ ] `npm run check` is clean (docs / manifest alignment gate)
- [ ] Plugin tree (`plugins/.../Mcode-webui/`) is in sync with root
- [ ] No personal data in commit content (no IPs, no usernames, no
      real session IDs)
- [ ] New env vars documented in `docs/API.md` and `plugin.json`
- [ ] New endpoints / events documented in `docs/API.md`
- [ ] `CHANGELOG.md` updated under an "Unreleased" section
- [ ] If destructive behavior changes, the security note
      `plugins/.../references/SECURITY-NOTES.md` is updated (and
      `plugin.json`'s `extensions.securityNotes` summary stays in sync)

## Adding a new route / event / panel

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for recipes. The
short version:

- **Route**: drop a file in `server/routes/<name>.js` exporting
  `(req, res, deps) => …`, register in `server/router.js`.
- **SSE event**: emit via `state-bus` in the route; consume in
  `public/app/render.js`.
- **UI panel**: add a `state` slice in `public/app/state.js`,
  a renderer in `public/app/render.js`, a handler in
  `public/app/events.js`, and an i18n key in `public/app/i18n.js`.

## Style guide

- **ESM only** — no CommonJS, no `require()`.
- **No runtime npm deps** — only `devDependencies`. Everything
  runtime must be Node 22+ stdlib.
- **No silent failures** — every catch either re-throws, returns
  an explicit error response, or logs a warning with a `console.warn`
  tag. No `try { … } catch {}` blocks.
- **No fake UI buttons** — if mcode acp doesn't support a method
  (see `docs/CAPABILITIES.md`), don't render a button that
  pretends to work. Use a toast + skip.
- **i18n first** — every user-visible string in the frontend goes
  through `i18n.t()`. No inline English / Chinese literals.
- **Token-aware error messages** — never echo the request URL
  or headers into error bodies (token leak risk).

## Release process

1. Bump `version` in `package.json` (root + plugin copy).
2. Move "Unreleased" section in `CHANGELOG.md` to a dated
   versioned section.
3. Package the plugin tree. There is no `package:plugin` script in
   the current script set; the `plugins/Wzdhehe/mcode-webui/` tree
   itself is the submission artifact (see step 4).
4. Open a PR to the community registry
   [`MiniMax-AI/MiniMax-Code-Plugins`](https://github.com/MiniMax-AI/MiniMax-Code-Plugins)
   adding only the `plugins/Wzdhehe/mcode-webui/` tree (per the
   "one folder = one plugin" model — see the official README).
5. Tag the release: `git tag v1.X.Y && git push --tags`.

## Questions?

Open an issue. If it's about a plugin-submission process (reviewer
comments, manifest fields, etc.), tag it `plugin-registry`.
