# PR #67: durable progress batching

The change preserves immediate progress delivery while preventing acknowledged cursors from
being reused after a process crash. SQLite stays in WAL mode with `synchronous=FULL`.

- Reserve 1024 sequence numbers in a separately committed high-watermark transaction before
  exposing a cursor. Recovery skips unused numbers; gaps are valid. Reservation failures expose
  no cursor. Lease exhaustion within an existing transaction fails rather than publishing an
  unreserved sequence.
- Durable events flush preceding progress and keep their own synchronous transaction.
- Failed batch commits restore the ordered buffer and roll back ledger updates, including a
  nested flush when its outer transaction fails.
- Shutdown attempts all cleanup. A failed flush still closes SQLite and releases the owner lock;
  the service reports failure through stderr and exit status.
- The public MCP test now stops its detached service before removing the temporary directory,
  fixing its Windows `EBUSY` cleanup failure without changing service lifetime behavior.

## Follow-up repair and local verification, October 11, 2026

These counts were measured on the `codex/pr67-durable-batching` worktree based on `3712fbcbc4102528cd1ed1f9a073be95d81753e3` before committing this revision. Post-commit rechecks are recorded separately; no same-head GitHub CI result is claimed.

- Residual failed transactions are rolled back before subsequent Store reads/writes, reservation, maintenance and close. Recovery failures are reported, not acknowledged as durable writes. Six dedicated residual-transaction checks cover acknowledged saves, duplicate/uncommitted events, saveStep/saveSetting, engine finish state, flush failure and leasing/FULL semantics.
- HTTP/dashboard `after` and MCP `afterSequence` share `parseEventCursor`. Defaults remain zero; negative, fractional, nonfinite and unsafe integers are rejected before wait/query. Boolean/array/object coercion is rejected too. Actual HTTP and bundled stdio MCP are exercised, including maximum safe integer and legal cursors.
- Web bundle generation normalizes the embedded example's CRLF to LF, so rebuilding on Windows does not drift from Linux committed output. `dist/main.mjs` and `web/app.js` are regenerated; the rebuilt artifacts were stable in a second build.
- Final Windows/Node 24.12.0 checks: **136 passed, 2 skipped, 0 failed** (138); public package check: **1 passed, 0 skipped**. The two existing skips require POSIX signal/process-group behavior. No paid model calls or live account operations were used.
- Local root validation with development `node_modules` present scans third-party README text and fails on a third-party placeholder. The separately staged delivery check excludes development environments/dependencies, matching shipped files; its result is recorded in the handoff evidence. The unrelated root validator is not weakened.

CI records the checked-out revision and has a manual dispatch entry; the existing source/package and Windows process jobs remain enabled. Exact-head CI remains pending until these repairs are committed and checked on that SHA. Stop old workspace services before reconnecting to the new package; an existing owner process does not reload itself just because dist changed.

## Local verification, October 9, 2026

Windows, Node 24.12.0:

- `npm test`: **124 passed, 2 skipped, 0 failed** (126 tests).
- `node --test checks/integrity.check.mjs checks/durability.check.mjs test/package.test.mjs`:
  **25 passed**. Includes a killed child whose memory-only progress was acknowledged by
  `workflow_wait`, reopen/cursor checks, FULL pragmas, commit injection and failed-close cleanup.
- Package build regenerated `dist/main.mjs`; unrelated generated output was restored.

## Repeatable performance comparison

Run `node scripts/benchmark-durable-batching.mjs` from this plugin directory.
The baseline reads Store source from repository commit `6481e4a`. Both modes require FULL and
verify all 1100 event rows and the integrity chain after writing. Five rounds on the same host:

| Mode | Times (ms) | Median (ms) |
| --- | --- | --- |
| FULL, commit every progress event | 2988.755, 2911.603, 2863.510, 3312.873, 3098.278 | 2988.755 |
| FULL, safe batching | 217.803, 198.446, 361.923, 163.422, 143.395 | 198.446 |

This microbenchmark is **15.06x faster**. It measures event persistence overhead, not whole
workflow/model latency. Progress may disappear if the process dies before its batch is committed;
durable state retains FULL semantics and future sequence numbers exceed the lost acknowledged
cursor. SIGKILL/transaction injection is not a physical power-loss test.

GitHub CI execution is separate from these local results; a pending approval is not a test pass.
