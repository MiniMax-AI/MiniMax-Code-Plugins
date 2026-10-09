Thanks for identifying the durability issues. SQLite WAL is restored to synchronous=FULL.
Progress batching remains, but sequences are now leased through an independently committed
high watermark before publishing a cursor. After a crash, unused lease values are skipped,
so workflow_wait(afterSequence) cannot skip future durable events due to cursor reuse.

Failed batch commits restore the ordered buffer and roll back ledger writes, including nested
flushes in a failed outer transaction. Shutdown attempts every cleanup step; a flush error
still closes SQLite/releases the owner lock and is reported through stderr/exit status.

Local verification: 124 tests passed, 2 platform skips; 25 focused integrity/durability/package
tests passed, including a killed process after workflow_wait acknowledged memory-only progress.
The Windows public MCP test also now stops its detached service before temporary-directory
cleanup. Build output is updated.

The repeatable 1100-event, five-round comparison against commit 6481e4a checks FULL, row counts
and ledger integrity in both modes: median 2989 ms with per-event commits versus 198 ms with
safe batching (15.06x). This measures persistence overhead, not end-to-end workflow latency.
REVIEW-NOTES.md documents that progress can still be lost before batch commit, while cursors
are never reused and durable state retains FULL semantics. No physical power-loss or GitHub
CI pass is claimed from these local tests.
