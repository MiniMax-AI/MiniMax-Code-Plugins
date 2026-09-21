# mcode-webui CI

This document describes the gates that actually run against the
mcode-webui plugin, and how to reproduce every one of them locally.

> **Honesty note (2026-09-20, webui-rigor-fix batch H1).** Earlier
> revisions of this document described a plugin-owned GitHub Actions
> pipeline (`.github/workflows/ci.yml` inside this plugin directory)
> and claimed "8 CI runs per push". That claim was false: GitHub only
> reads workflow files from the repository root
> (`.github/workflows/`), so a workflow committed under
> `plugins/Wzdhehe/mcode-webui/.github/workflows/` never triggered —
> not once. The dead workflow file has been deleted, and this revision
> documents only what really executes. The historical matrix is
> retained below as a **local** cross-check recipe.

> **Honesty note (2026-09-20, webui-rigor-fix batch H2).**
> `package.json` previously declared `lint` (`eslint server/ test/`)
> and `format` (`prettier --write server/ test/`) scripts, and an
> earlier revision of this document listed them as "Step 6: lint /
> format". That gate never ran green even once: this plugin tree has
> never contained an `eslint.config.*` / `.eslintrc.*` or `.prettierrc`
> file (`git log --all -- 'plugins/Wzdhehe/mcode-webui/eslint.config.*'
> 'plugins/Wzdhehe/mcode-webui/.eslintrc*'
> 'plugins/Wzdhehe/mcode-webui/.prettierrc*'` returns zero commits),
> and ESLint 9+/10 hard-fails without a flat config — `npm run lint`
> exited 2 with "couldn't find an eslint.config.* file". A declared
> gate that never executed is worse than no gate, so both scripts have
> been removed from `package.json`. The related devDependencies
> (eslint / @eslint/js / globals / prettier) are left in place for
> now; if the gate is ever restored, add a real config first and prove
> it green before declaring it again.

> **Update (2026-09-20, webui-rigor-fix batch M1).** The four
> devDependencies named above (eslint / @eslint/js / globals /
> prettier) have now been uninstalled as well — no script and no
> config references them, so they were pure lockfile weight. Only
> `c8` remains (it backs `npm run coverage`). The restore condition
> is unchanged: re-add the tooling **together with** a real config
> and prove it green before declaring the gate again.

## What actually gates this plugin

The plugin lives in the `minimax-code-plugins` marketplace
repository. The only CI that runs against it is the workflow at the
**repository root**: `.github/workflows/ci.yml` (not in this
directory).

| Job | Runner | Node | Steps |
|---|---|---|---|
| `validate` | `ubuntu-latest` | 22 | `npm ci` → `npm run check` |

At the repository root, `npm run check` is `npm run validate && npm test`:

- **`validate`** (`scripts/validate.mjs`, marketplace root) — walks
  `examples/` and every `plugins/<owner>/<plugin>/` directory and
  validates each plugin's manifest and layout. This plugin passes as
  `plugin Wzdhehe/mcode-webui`.
- **`test`** (`node --test`, no path arguments) — Node's recursive
  test discovery executes **every** `.js` / `.mjs` file under any
  `test/` directory (the name does not matter — see the suite-routing
  section below). For this plugin that means the mock-free
  `test/*.test.js` set, `test/integration/*.test.js`,
  `test/matrix/*.test.js`, plus the `test/_setup.js` /
  `test/_analyze_sessions.mjs` helper files (zero-test files that
  exit cleanly). The mocked `checks/*.check.mjs` suites live outside
  `test/`, so the root gate never executes them — by design, they
  need the module-mocks flag.

Two consequences worth knowing:

1. The marketplace gate runs the plugin suite **without**
   `--experimental-test-module-mocks`. Everything under `test/` must
   therefore stay flag-clean: a bare `t.mock.module` call anywhere in
   `test/` TypeErrors the whole file under the root gate (that is
   exactly what the `checks/` migration fixed). Flag-dependent suites
   belong in `checks/` and run under the flagged plugin-local
   commands.
2. There is no matrix job, no smoke job, and no SBOM job in CI. Those
   checks live as local commands (below). `npm run check:ci` wires
   the same alignment script with a `--ci` argument; the script
   currently treats both invocations identically.

## Test layout and suite routing (2026-09-20, webui-rigor-fix M1)

**The discovery rule, as measured on this tree.** Node's recursive
test discovery (`node --test` with no path arguments — the marketplace
root gate) uses a **directory rule**: every `.js` / `.mjs` file under
a `test/` directory is executed as a test file, whatever its name.
Verified empirically: `test/_setup.js` (the shared mock helper) and
`test/_analyze_sessions.mjs` are picked up and executed by the root
gate (both exit cleanly with zero tests), and the one-shot fixture
generator — then at `test/fixtures/create-test-db.mjs` — was executed
on every gate pass too, rewriting the committed fixture DB (a
permanent false dirty in git) and crashing with `spawnSync sqlite3
ENOENT` on any runner without a `sqlite3` binary. It now lives at
`scripts/create-test-db.mjs`, outside the discovery rule. Renaming a
file does not help — only leaving the directory does.

**Why 22 suites moved to `checks/`.** Those suites depend on
`t.mock.module()`, which requires `--experimental-test-module-mocks`
(still an experimental flag through Node 26). Without the flag every
`t.mock.module` call throws `TypeError`, failing the whole file — so
the PR #55 head was red under the marketplace root gate even though
local flagged `npm test` was green. The fix moved all 22 mocked
suites from `test/<name>.test.js` to `checks/<name>.check.mjs`
(`.mjs` suffix per the marketplace's `hetaoBackend` plugin convention;
the `.check.` infix marks flag-dependent checks). Files outside a
`test/` directory are never discovered by the root gate. Only
relative imports were rewired (`./_setup.js` → `../test/_setup.js`,
one extra `..` at every server-dir anchor); zero test logic changed.

**Where each suite runs now:**

| Suite | Location | Flagless? | Gates that run it |
|---|---|---|---|
| mock-free unit | `test/*.test.js` | must be | marketplace root gate (`node --test`) and `npm run test:unit` |
| production wiring (W2) | `test/integration/chat-wiring.test.js` | must be | root gate and `npm run test:integration` |
| integration + matrix | `test/integration/*.test.js`, `test/matrix/*.test.js` | must be | root gate and `npm run test:integration` |
| mocked unit checks | `checks/*.check.mjs` | no — flag-gated by design | plugin-local `npm test` / `npm run test:mocked`; also run by the local matrix recipe (§Local matrix) and by the remote full gate (siinfer, Ubuntu 24.04 / Node 24) |

Consequences for writing tests:

- `npm run test:unit` is now **flagless**: the remaining `test/*.test.js`
  set has zero `t.mock.module` dependency (that is the point of the
  migration).
- `npm test` and `npm run test:mocked` still pass the flag; the flag
  is harmless to files that do not need it.
- New rule of thumb: a mock-free test belongs in `test/` (it joins
  the root gate); a test that needs `t.mock.module` belongs in
  `checks/*.check.mjs` (root gate never sees it, every local
  full-suite invocation does).

## Local reproduction

From `plugins/Wzdhehe/mcode-webui`:

```bash
# Step 0: install (lockfile-driven)
npm ci

# Step 1: docs/manifest alignment gate
npm run check        # scripts/check-docs-alignment.mjs
npm run check:ci     # same gate, CI invocation form

# Step 2: tests
npm run test:unit         # test/*.test.js — flagless (root-gate surface)
npm run test:mocked       # checks/*.check.mjs — module-mocks flag
npm run test:integration  # test/integration/*.test.js + test/matrix/*.test.js
npm test                  # full suite: unit + mocked checks + integration + matrix

# Step 3: flagless marketplace-root-gate surface (checks/ are
# flag-gated by design — see "Test layout and suite routing")
node --test test/*.test.js test/integration/*.test.js test/matrix/*.test.js

# Step 4: coverage (c8; exclusion list in package.json "c8" — see
# COVERAGE-REPORT.md §8 for the exclusion status)
npm run coverage

# Step 5: SBOM + CVE gate
npm run sbom                              # scripts/gen-sbom.mjs → sbom.cdx.json
npm audit --omit=dev --audit-level=low    # production CVE gate

# Step 6: smoke — boot the HTTP server and probe it
PORT=31877 HOST=127.0.0.1 TOKEN=dummy npm start &
sleep 5
curl -v http://127.0.0.1:31877/api/health
kill %1 || true
```

To reproduce the marketplace CI one-to-one, run from the repository
root:

```bash
npm ci
npm run check
```

## Local matrix

This is the cross-combination recipe inherited from the (never
executed) plugin workflow. Nothing runs it automatically today; it is
a manual checklist for when cross-platform or cross-Node-version
behavior is in question. **If this plugin is ever hosted in its own
repository, this table is the starting point for a real workflow
definition** — at that point the honesty note above no longer applies
and this section should be rewritten around the new workflow.

| Combination | Node | OS | Commands | Purpose |
|---|---|---|---|---|
| matrix cells 1–6 | 22, 24 | macOS, Linux, Windows | `npm ci` → `npm run check` → `npm test` | Cross-version cross-OS install + gates + suite |
| smoke | 22 | any | boot `npm start`, `curl /api/health`, kill | Server binds a socket and answers HTTP |
| SBOM + CVE | 22 | Linux | `npm run sbom` + `npm audit --omit=dev` | Manifest integrity + production CVE gate |

### Smoke test detail

The unit suite exercises pure logic. It does **not** confirm that
`node server.js` actually boots, listens, or responds over a real TCP
socket. The smoke recipe fills that gap:

```bash
PORT=31877 HOST=127.0.0.1 TOKEN=dummy nohup npm start > smoke.log 2>&1 &
echo $! > smoke.pid
sleep 5
curl -v http://127.0.0.1:31877/api/health
kill $(cat smoke.pid) || true
```

`/api/health` is the canonical probe because it requires no
authentication and returns 200 on a healthy bootstrap. One combination
suffices — the goal is only to prove the runtime listens.

## SBOM + CVE gate (local)

`npm run sbom` (`scripts/gen-sbom.mjs`) generates the CycloneDX 1.5
SBOM. It is zero-dep — only `node:fs`, `node:crypto`,
`node:url`/`node:path`. The `components[]` content is a pure function
of the on-disk tree; only `serialNumber` (random UUID) and
`metadata.timestamp` differ between runs:

- `metadata.component` — the root `mcode-webui` application.
- `components[]` — every entry under `node_modules/<pkg>/`, each with
  `name`, `version`, `licenses`, `hashes` (SHA-512 over the on-disk
  `package.json`), and a `purl` of the form
  `pkg:npm/<name>@<version>`.

Validate the round-trip parse locally:

```bash
node -e '
  const d = require("./sbom.cdx.json");
  if (d.bomFormat !== "CycloneDX") throw new Error("bomFormat");
  if (d.specVersion !== "1.5") throw new Error("specVersion");
  if (!Array.isArray(d.components)) throw new Error("components");
  console.log("components:", d.components.length);
'
```

### CVE gate and the waiver file

`npm audit --omit=dev --audit-level=low` is the gate. mcode-webui
ships **zero** runtime dependencies by design (all `devDependencies`
are dev tooling), so a non-zero exit is treated as a hard failure.
Production-runtime CVEs (artifacts of adding to `dependencies`) are
not waivable.

If a transitive **dev** dependency gains a CVE that cannot be
immediately upgraded, the waiver mechanism is `.cve-ignore.json`.
Each waiver entry must carry:

- `advisory_id` — GHSA-… or CVE-… identifier from `npm audit`,
- `waived_until` — ISO date 30 days from when the waiver was filed,
- `reason` — short human note ("waiting on upstream
  `<upstream-issue>`", "local mirror divergence", etc.).

## Adding a new dependency

1. Add it to `dependencies` or `devDependencies` in `package.json`,
   **then** run `npm install` locally to regenerate
   `package-lock.json`.
2. Do **not** commit only `package.json` — both files must move
   together. `npm ci` (and the marketplace gate) will error out
   otherwise.
3. If you added a **runtime** dep, the CVE gate is now stricter.
   Check `npm audit --omit=dev` before opening the PR.

## When a gate is red

| Failing gate | Likely cause | Direction |
|---|---|---|
| root `npm ci` | `package.json` / `package-lock.json` drift | Run `npm install` locally; commit both files together |
| root `validate` | Plugin manifest/layout violates marketplace rules | Read the `FAIL <plugin>` line; reconcile against root `scripts/lib/validation.mjs` |
| `npm run check` | Docs / code drift | Read the failing check in `scripts/check-docs-alignment.mjs` output and reconcile |
| `npm test` (flagged) or flagless `node --test` | Test regression, possibly mode-specific | Run `node --experimental-test-module-mocks --test checks/<name>.check.mjs` for mocked suites and the flagless `node --test test/<name>.test.js` for the root-gate surface; each must pass in its own gate |
| Smoke `GET /api/health` | Server does not boot, or `/api/health` missing | `npm start` locally, check `[webui] listening on ...` log |
| `npm audit` | Production-dep transitive CVE | Investigate upstream; production CVEs are not waivable |
| `npm run sbom` | Manifest missing or malformed | Run `node scripts/gen-sbom.mjs` locally; check `package.json` |

## Relationship to the refactor plan

Two acceptance criteria from
`SiHankor/.tmp/mcode-webui-refactor/PLAN-webui-v2-refactor.DRAFT.md`
were originally claimed here:

- **Criterion 5 — Reproducibility (lockfile + SBOM + CVE):** delivered
  as local tooling — `npm ci` pins the install, `scripts/gen-sbom.mjs`
  emits CycloneDX 1.5, the production-only `npm audit` gate and
  `.cve-ignore.json` waiver file are real and reproducible.
- **Criterion 6 — Testability (cross-Node/OS matrix):** delivered
  **only as the local matrix recipe above**. It is not executed by
  any CI system; the automated portion of criterion 6 is the
  marketplace root `validate` job (single ubuntu / Node 22
  combination running the full recursive suite).

Both still feed the §AP11 "docs/code drift can never silently
regress" guard that `scripts/check-docs-alignment.mjs` enforces.
