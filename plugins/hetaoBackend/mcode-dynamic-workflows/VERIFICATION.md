# Verification — 0.8.0

Verified on macOS on 2026-09-18.

- Repository `npm run check`: 27 hosted plugins validated; 490 tests discovered, 470 passed, 20 platform/fixture skips, no failures. Includes this plugin's dependency-free packaged MCP smoke test.
- Isolated development copy: installed pinned dependencies from the public npm registry with install scripts disabled; `npm run build` succeeded and `npm test` passed all 54 applicable source checks. The installer-specific check is excluded because this public distribution has no installer.
- Rebuilt `dist/main.mjs`, `dist/sandbox.mjs`, `dist/quickjs.wasm`, `web/app.js` and `web/readable.css` match the committed runtime assets byte-for-byte.
- `npm run test:package` passed against the rebuilt bundle. The test connects through the declared stdio entry, lists 11 tools, creates a demo draft without execution, approves a controlled demo, observes a script failure, creates a repair draft, approves it, and verifies successful reuse with zero additional agent calls and the original failure record intact.
- Source checks cover schema parsing, raw-output preservation, review revisions, cache invalidation, frozen reuse snapshots, checkpoint recomputation, scheduler budgets, canonical workspace routing, process cwd, lifecycle/port persistence and local HTTP protections. Real CLI behavior is simulated where a controlled executor is used.
- Earlier 0.8.0 dashboard acceptance covered English/Chinese, 390px layout, repair editing, removing an upstream reuse selection, downstream reruns, result provenance and no console errors. The public dashboard assets are identical; this is not a new Desktop plugin-loader acceptance test.

Additional CI review: three focused dependency-boundary checks cover the exact CodeQL findings documented in `SECURITY_REVIEW.md`. The two failing repository Python argument-validation tests also pass locally with Pillow installed. CI now explicitly installs Pillow and a CJK font; Ubuntu confirmation comes from the PR check results.

Not verified: paid model execution, account authorization, real Windows/Linux MCode installation, or every supported host/plugin-loader version. Passing these checks does not establish correctness of model-generated findings or safety of side effects initiated by an authorized agent task.
