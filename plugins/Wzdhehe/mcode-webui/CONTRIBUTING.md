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
npm install               # only devDeps (eslint, prettier, c8)
npm test                  # 382 unit tests + 1 skipped (383 total)
npm run lint              # eslint flat config, must be 0 warnings
npm run dev               # node server.js
# → http://127.0.0.1:8080/
```

`npm test` and `npm run lint` **must pass** before opening a PR.

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

`npm run setup:plugin` is a no-op on the current layout (it used to
create junctions; the trees have been expanded since).

## Editing flow

1. **Edit at the repo root** (`server/`, `public/`, `test/`).
2. **Mirror the change to the plugin tree** — copy the changed files
   from `<root>/server/...` to `plugins/Wzdhehe/mcode-webui/server/...`,
   and the same for `public/`, `test/`, `docs/`.
   (The `package:plugin` script does this for you, but a
   per-PR manual sync is fine for small changes.)
3. **Run the gate**:
   ```bash
   npm test
   npm run lint
   npm run validate:plugin
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

- [ ] `npm test` passes (382 + 1 skipped)
- [ ] `npm run lint` is clean (0 warnings)
- [ ] `npm run validate:plugin` is clean (mirrors official gate)
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
3. `npm run package:plugin` — produces `dist/Wzdhehe/mcode-webui/`
   + `dist/Wzdhehe/Mcode-webui.zip`.
4. Open a PR to the community registry
   [`MiniMax-AI/MiniMax-Code-Plugins`](https://github.com/MiniMax-AI/MiniMax-Code-Plugins)
   adding only the `plugins/Wzdhehe/mcode-webui/` tree (per the
   "one folder = one plugin" model — see the official README).
5. Tag the release: `git tag v1.X.Y && git push --tags`.

## Questions?

Open an issue. If it's about a plugin-submission process (reviewer
comments, manifest fields, etc.), tag it `plugin-registry`.
