# Verification — 0.8.0

Verified on macOS on 2026-09-18.

- Repository `npm run check`: 27 hosted plugins validated; 490 tests discovered, 470 passed, 20 platform/fixture skips, no failures. Includes this plugin's dependency-free packaged MCP smoke test.
- Isolated development copy: regenerated the lockfile from public registry metadata, then installed pinned dependencies from the public npm registry with an empty cache and install scripts disabled; `npm run build` succeeded and `npm test` passed all 72 applicable source checks. The installer-specific check is excluded because this public distribution has no installer.
- Rebuilt `dist/main.mjs`, `dist/sandbox.mjs`, `dist/quickjs.wasm`, `web/app.js` and `web/readable.css` match the committed runtime assets byte-for-byte.
- `npm run test:package` passed against the rebuilt bundle. The test connects through the declared stdio entry, lists 11 tools, creates a demo draft without execution, approves a controlled demo, observes a script failure, creates a repair draft, approves it, and verifies successful reuse with zero additional agent calls and the original failure record intact.
- Source checks cover schema parsing, raw-output preservation, review revisions, cache invalidation, frozen reuse snapshots, checkpoint recomputation, scheduler budgets, canonical workspace routing, process cwd, lifecycle/port persistence and local HTTP protections. Real CLI behavior is simulated where a controlled executor is used.
- Earlier 0.8.0 dashboard acceptance covered English/Chinese, 390px layout, repair editing, removing an upstream reuse selection, downstream reruns, result provenance and no console errors. The final browser audit additionally covers historic deep links outside the 100-entry list and delayed selection, polling, error and pause responses. This is not a new Desktop plugin-loader acceptance test.

Final source regressions cover binary-byte cache invalidation, special filenames, bounded regular-file reads, split UTF-8 HTTP requests, manual CLI preflight diagnostics, recovery beyond 100 records, and exclusive state ownership after discovery lock loss, independent node schema identifiers/local references, and rejection by the false JSON Schema.

Process lifecycle regression checks use real, bounded Node CLI/descendant fixtures: cancellation with ignored and inherited pipes, SIGTERM-resistant descendants after parent exit, malformed protocol, watchdog cleanup after the leader exits, and an unrelated sibling that remains alive. Failure-injection checks cover Windows taskkill arguments/failure, unreadable process tables, zombie-only groups and `needs_attention` resume/repair gates. These are controlled local subprocesses, not paid MCode calls. A focused Windows CI job runs the applicable real subprocess checks.

Additional CI review: three focused dependency-boundary checks cover the exact CodeQL findings documented in `SECURITY_REVIEW.md`. The two failing repository Python argument-validation tests also pass locally with Pillow installed. CI now explicitly installs Pillow and a CJK font; Ubuntu confirmation comes from the PR check results.

Not verified: paid model execution, account authorization, real Windows/Linux MCode installation, or every supported host/plugin-loader version. Passing these checks does not establish correctness of model-generated findings or safety of side effects initiated by an authorized agent task.

## Mechanical claims

The machine-recheckable claims are FIXED ARGV DATA in `scripts/verify-claims.mjs` (spawned directly, no shell; `node` resolves to the running executable). Run `node scripts/verify-claims.mjs` from the plugin directory: one PASS/FAIL line per claim, exit 0 only when every claim matches its expected exit status (1 on the first mismatch, 2 on a tool error). The table below is a human-readable **mirror** of that data; `checks/claims.check.mjs` strictly validates the mirror (header, order, uniqueness, columns, full consumption — any malformed or smuggled row fails the suite). V-02/V-03 need development dependencies (`npm ci` first); V-04 runs after V-03 on a committed tree and detects drifted assets. Portability: POSIX/macOS (direct spawn of node/npm/git; Windows npm.cmd resolution is not claimed). Prose claims that are not mechanically expressible intentionally stay prose.

```verify
| id | command | expect |
|----|---------|--------|
| V-01 | node --test test/package.test.mjs | exit 0 |
| V-02 | npm test | exit 0 |
| V-03 | npm run build | exit 0 |
| V-04 | git diff --exit-code -- dist web THIRD_PARTY_NOTICES.txt | exit 0 |
```
