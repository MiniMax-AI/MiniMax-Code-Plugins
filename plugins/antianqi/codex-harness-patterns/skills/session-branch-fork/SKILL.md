---
name: session-branch-fork
description: |
  Design a session-level fork / revert / recover / suspend mechanism over a paginated history with lineage tracking, immutable segments, global lock, ModelContext reconstruction, and bounded replay.
  USE WHEN: designing session persistence, building a "fork this conversation" feature, building "undo last N turns", building "suspend and resume later", implementing a paginated history with segment-level cursor, reconstructing ModelContext from disk, or any task involving "session as a git-like object graph".
  TRIGGER PHRASES: "session fork", "session branch", "thread fork", "thread rollback", "revert thread", "ThreadRollback", "SuspendTurnAndShutdown", "Op::RecoverTurn", "paginated history", "RolloutLineage", "ForkBoundary", "RolloutReferenceIndex", "ModelContext reconstruction", "ReverseJsonlScanner", "bounded replay", "git baseline", "writer lock", "subagent lineage".
  SKIP WHEN: single-session task state (use `world-state-tracking`), no need to undo, no need to fork.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.0"
  inspired-by: https://github.com/openai/codex/tree/main/codex-rs/thread-store/ (P-49/50/51/52 + P-67-77)
  changes-from-v0.0.0: "Initial design distilled from P-49/50/51/52 + P-67-77 deep-dive (Phase 0 错判修正 + Phase 1 Week 3)."
---

# Session Branch / Fork

Design a session-level fork / revert / recover / suspend system over a paginated
history. Mirrors `codex-rs/thread-store/`.

## When to use

Activate when designing:

- A "fork this session from turn N" feature.
- A "undo the last N turns" feature.
- A "suspend the running session, recover it later" feature.
- A paginated history with cross-segment cursors.
- A model-context reconstruction algorithm that doesn't re-read the entire history.

## When NOT to use

- Single-session task state → use `world-state-tracking`.
- No undo, no fork, no suspend needed → standard append-only history is enough.

## Process

### 1. Pick a `ThreadHistoryMode`

```rust
pub enum ThreadHistoryMode {
    Legacy,    // entire thread in one JSONL
    Paginated, // immutable segments, supports fork/revert
}
```

**Default to Legacy** for backward compatibility, but use Paginated for any new
thread. Paginated is what makes fork / revert / lineage work.

### 2. Define the immutable segment model

```rust
pub struct RolloutLineageSegment {
    pub rollout_id: ThreadId,
    pub rollout_path: PathBuf,
    pub start_ordinal: u64,
    pub end: Option<HistoryPosition>,    // byte offset
}

pub struct RolloutLineage {
    pub segments: Vec<RolloutLineageSegment>,
}
```

**Key invariants**:

- Segments are **immutable**. A new segment is created for any change.
- The lineage is a list of segments ordered from oldest to newest.
- Each segment knows its start ordinal and (optionally) its end offset.

### 3. Implement fork with `ForkBoundary`

```rust
pub enum ForkBoundary {
    Latest,                          // inherit source's latest durable state
    ThroughTurn(String),             // include this turn
    BeforeTurn(String),              // exclude this turn
}

pub struct PrepareForkParams {
    pub thread_id: ThreadId,
    pub boundary: ForkBoundary,
}

pub struct PreparedFork {
    pub source_thread_id: ThreadId,
    pub model_context: Arc<ModelContext>,
}
```

Fork flow:

1. Lock the source thread's lifecycle + writer.
2. Persist any pending items in the source.
3. Resolve the source's `RolloutLineage`.
4. Materialize each ancestor segment to SQLite (if not already).
5. Load the `ModelContext` for the chosen boundary.
6. Return a `PreparedFork` ready to be turned into a new thread.

### 4. Implement revert with CAS

```rust
pub struct RevertThreadParams {
    pub thread_id: ThreadId,
    pub before_turn_id: String,    // first turn EXCLUDED from retained history
}
```

Revert flow:

1. Lock lifecycle + writer + writer_lock_coordinator.
2. Resolve the current rollout from SQLite (`expected_sqlite_path` is the CAS anchor).
3. Read `SessionMeta` from the current rollout, verify `id == thread_id` and `history_mode == Paginated`.
4. Materialize any compressed lineage segments.
5. Create a new immutable rollout file referencing the retained prefix.
6. CAS the SQLite `rollout_path` to the new file.

**Critical contract**: `revert` only rolls back in-memory context. **It does not undo filesystem changes.** The client is responsible for undoing edits on disk.

### 5. Implement suspend + recover

```rust
Op::SuspendTurnAndShutdown { reply: oneshot::Sender<...> }
Op::RecoverTurn { thread_settings, reply: oneshot::Sender<...> }
```

Suspend flow (9 steps):

1. Lock `active_turn` and verify `task.kind == TaskKind::Regular`.
2. Snapshot descendants (not a seal; best-effort).
3. `live_thread.flush()` — persistence first; if it fails, leave the turn running.
4. Re-lock and re-verify kind (flush can yield).
5. Take the turn and task; cancel the cancellation token; cancel git enrichment.
6. `task.handle.detach()` with a `GRACEFULL_INTERRUPTION_TIMEOUT_MS` timeout.
7. `session.input_queue.clear_pending(&turn)` — pending input is NOT persisted.
8. `shutdown_session_runtime(session)` + `live_thread.flush()` + `live_thread.shutdown()`.
9. Emit `ShutdownComplete` event **only after** the writer is closed.

**Critical contract**: do NOT record a terminal turn event on suspend. This
intentionally leaves the turn's ID reclaimable, so `Op::RecoverTurn` can resume it.

### 6. Use a global lock for multi-process safety

When two Codexes might fork / revert the same thread, use a DB-level lease:

- `try_claim_global_phase2_job(thread_id, JOB_LEASE_SECONDS)` — single-writer.
- `heartbeat_global_phase2_job(ownership_token, JOB_LEASE_SECONDS)` — keep lease alive.
- On agent completion, re-verify ownership BEFORE `reset_git_repository` to avoid
  resetting someone else's work.

### 7. Reconstruct ModelContext with bounded replay

```rust
pub fn load_latest_model_context(store, params) -> StoredModelContext {
    let path = thread_rollout_resolver::resolve_current(...).await?;
    let session_meta = read_session_meta_line(path).await?;
    if session_meta.id != params.thread_id { return Err(InvalidRequest); }
    
    let mut scanner = ReverseJsonlScanner::new(file)?
        .with_max_record_bytes(MAX_ROLLOUT_LINE_BYTES);
    let mut scan = ModelContextScan::default();
    
    while let Some(outcome) = scanner.scan_next::<Value>()? {
        if let ScanOutcome::Parsed(value) = outcome {
            if scan.push(line) == ModelContextScanProgress::Complete {
                let items = scan.finish(session_meta);
                items.retain(|i| !matches!(i, RolloutItem::SessionMeta(_)));
                return Ok(StoredModelContext { items });
            }
        }
        // ScanOutcome::Rejected — skip bad line, do not abort
    }
    // No bounded cutoff found — fall back to full replay
}
```

Three guarantees:

- `ReverseJsonlScanner` reads from the END of the file — only the suffix is touched.
- `MAX_ROLLOUT_LINE_BYTES` prevents a single bad line from OOM-ing the reader.
- `ScanOutcome::Rejected` skips malformed lines; never aborts the whole read.
- If no bounded cutoff is found, fall back to the full replay (read entire file).

### 8. Run a Legacy → Paginated migration on startup

```rust
pub async fn migrate_rollouts_on_startup(store) {
    // Use a creation-ordered cursor in SQLite to check only newer rollout files
    // 48h lookback window catches files we skipped earlier
    // Fingerprint (size_bytes + modified_at_ns) skips empty/malformed rollouts
    // Use run marker to prevent overlapping migrations
    // Spawn subagent-aware bounded replay for subagent rollouts (don't copy
    // the parent's full history into every child)
}
```

### 9. Use a writer lock for serialization

`writer_lock_coordinator.acquire(thread_id)?` — guarantees that writes to a
single thread are serialized even across processes. Drop the lock when the
thread is closed.

### 10. Adopt the 3-state section / project model

```rust
pub struct UpdateProjectParams {
    pub project_id: String,
    pub name: Option<String>,                       // None = no change
    pub roots: Option<Vec<StoredProjectRoot>>,
    pub metadata: Option<BTreeMap<String, String>>,
}
```

Use `Option<Option<T>>` for 3-state: `None` = no change, `Some(None)` = clear,
`Some(Some(v))` = set.

## Output contract

A session-management system that follows this design:

- Threads have a `ThreadHistoryMode` (Legacy / Paginated).
- Paginated threads have a `RolloutLineage` of immutable segments.
- Fork accepts a `ForkBoundary` and returns a `PreparedFork`.
- Revert uses CAS on the SQLite rollout_path; creates a new immutable segment.
- Suspend + Recover are paired; suspend does NOT record a terminal event.
- Reconstruct ModelContext via reverse scan with bounded replay + byte cap + Rejected skip.
- Migration runs at startup with cursor in DB + fingerprint skip + 48h lookback.
- Multi-process safety via DB leases and writer lock coordinator.

## Common pitfalls

- **No `Paginated` history mode** → no fork / revert. New threads should default to Paginated.
- **Revert undoes filesystem** → it does not. Client is responsible.
- **Suspend records terminal event** → Recover can never resume. Don't.
- **Pending input persisted** → replay state is wrong. `clear_pending` on suspend.
- **Reverse scan reads whole file** → slow. Bounded replay + `MAX_ROLLOUT_LINE_BYTES`.
- **Migration on every startup reads all rollouts** → slow. Cursor + 48h lookback.
- **Two Codexes reverting simultaneously** → corruption. Lease / writer lock.
- **Reset git baseline with diff present** → deleted content stays in git objects. Delete diff first.
- **Single-type partial update vs. clear** → use `Option<Option<T>>` for 3-state.

## Example — fork from a turn

```text
# Source thread has 50 turns
fork_boundary = BeforeTurn("turn-30")
prepare_fork(thread_id, boundary) →
  1. Lock source lifecycle + writer
  2. Persist pending items
  3. Resolve lineage (5 segments)
  4. Materialize segments 1..4 to SQLite
  5. ModelContext = base + turns 1..29 (before turn-30)
  6. PreparedFork { source_thread_id, model_context }
new_thread = create_thread(forked_from_id = source.id, history_base = ModelContext.snapshot)
# New thread starts at turn 30, inherits turns 1..29 from ModelContext
```

## Verification checklist

- [ ] All new threads default to `ThreadHistoryMode::Paginated`.
- [ ] Fork accepts `ForkBoundary` (Latest / ThroughTurn / BeforeTurn).
- [ ] Revert uses CAS on the SQLite rollout path; creates a new immutable segment.
- [ ] Suspend flushes BEFORE canceling, and re-checks turn kind after flush.
- [ ] Suspend does NOT record a terminal turn event.
- [ ] Suspend clears pending input (input is not persisted).
- [ ] Suspend emits `ShutdownComplete` ONLY after `live_thread.shutdown()` returns.
- [ ] Reconstruct ModelContext via `ReverseJsonlScanner` with byte cap.
- [ ] Reconstruct skips `ScanOutcome::Rejected` without aborting.
- [ ] Migration uses SQLite cursor + fingerprint skip + 48h lookback.
- [ ] Multi-process safety: writer lock + DB lease + ownership token.
- [ ] Partial-update APIs use `Option<Option<T>>` for 3-state.
