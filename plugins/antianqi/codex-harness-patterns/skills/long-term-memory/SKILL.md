---
name: long-term-memory
description: |
  Design a cross-session long-term memory system that extracts, consolidates, and cites durable knowledge from conversation rollouts.
  USE WHEN: building any system that needs to persist insights across sessions, designing "what should the next agent remember" pipelines, building memory workspaces with git baseline diffing, planning Phase 1/Phase 2 memory architectures, writing JSON-schema-constrained extraction prompts, deciding what NOT to write (no-op gate), or any task involving "memories that survive session boundaries".
  TRIGGER PHRASES: "long-term memory", "cross-session memory", "memory pipeline", "memory consolidation", "memory citation", "raw_memories.md", "MEMORY.md", "phase 1 extraction", "phase 2 consolidation", "watermark", "no-op gate", "git baseline diff".
  SKIP WHEN: single-session task state (use `world-state-tracking` instead), ephemeral/short task, no need to survive session boundaries, in-memory only.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.0"
  inspired-by: https://github.com/openai/codex/tree/main/codex-rs/memories/ and protocol/src/memory_citation.rs
  changes-from-v0.0.0: "Initial design distilled from P-78/79/80/84 deep-dive (Phase 1 Week 1)."
---

# Long-Term Memory

Design and operate a cross-session long-term memory system that survives session
boundaries. Mirrors the structure of Codex's `codex-rs/memories/` crate.

## When to use

Activate when designing any of:

- A pipeline that extracts structured facts from conversation rollouts and writes them to durable storage.
- A global consolidation pass that merges per-rollout facts into higher-level summaries without races.
- A citation protocol so a future agent can audit which memory came from which rollout.
- A "no-op gate" — the system MUST be allowed to write nothing when there is no durable learning.

## When NOT to use

- Single-session task state → use `world-state-tracking`.
- Real-time voice / streaming → out of scope.
- Forgetting-on-purpose privacy filters → out of scope.

## Process

A long-term memory system is built from four pieces. Build them in this order.

### 1. Phase 1 — per-rollout extraction (parallel, idempotent)

The writer of memories. Runs at session start (or on a schedule), claims bounded jobs from a queue, and for each:

- Loads the rollout (JSONL or DB-backed).
- Filters to memory-relevant response items.
- Prompts a model with a JSON schema producing `{raw_memory, rollout_summary, rollout_slug}`.
- Redacts secrets from the output.
- Persists to durable storage (DB row or file).

Hard rules:

- `#[serde(deny_unknown_fields)]` on the output struct so the model cannot add fields.
- Concurrency capped by a single constant (e.g. `CONCURRENCY_LIMIT = 8`). Use `futures::stream::iter(...).buffer_unordered(N)`.
- Lease/ownership token prevents two workers from re-extracting the same rollout.
- If a job fails, record the failure with a backoff; do not hot-loop.
- **Allow no-op**: the prompt MUST include the question "Will a future agent plausibly act better because of what I write here?" and an empty-output escape hatch. If the answer is no, write nothing.

### 2. Phase 2 — global consolidation (serial, single lock)

The reader of stage-1 outputs. Runs at session start, after Phase 1, with one global lock so two Codexes never consolidate simultaneously.

- Load top-N stage-1 outputs ranked by `usage_count` then `last_usage` (fallback `generated_at`).
- Filter by `last_usage >= now - max_unused_days` (otherwise stale).
- Sync the selected inputs into a workspace as `raw_memories.md` (ascending thread-id order, never usage-rank) and `rollout_summaries/<id>.md`.
- Prune stale rollout summaries and old extension resources.
- **Use git baseline as a cheap state machine**: `~/.codex/memories/.git/` keeps a `git diff` against the previous successful baseline. If there are no changes, mark success and exit.
- If there ARE changes, write `phase2_workspace_diff.md` and spawn an **internal consolidation sub-agent** with these hard constraints:
  - `cwd` = the memory root only.
  - `ephemeral = true`.
  - `features.disable(Collab / MemoryTool / Apps / Plugins)`.
  - `approval_policy = Never`.
  - `network_access = false` (or inheriting parent's `PermissionProfile::External`).
  - **Disabled from re-entering Phase 1**: `memories.generate_memories = false` and `use_memories = false`.

### 3. MemoryCitation protocol

When the model emits memory, it should be able to point at exact lines. Adopt this single-line format:

```
<citation_entries>
path/to/file.md:10-15 |note=[why this matters]
path/to/other.md:42-50 |note=[other context]
</citation_entries>
<rollout_ids>
thread-abc-123
thread-def-456
</rollout_ids>
```

Parse with `split_once` × 3 (location / `|note=[` / `]`). `try_from().ok()` style tolerance for malformed lines. De-duplicate `rollout_ids` with a `HashSet`.

### 4. Watermark

After successful Phase 2, write `new_watermark = max(claimed_watermark, max(source_updated_at))` to the DB. **Watermarks are monotonically increasing** — never move backwards. They are bookkeeping, not the dirty check (git workspace is).

## Output contract

A working long-term memory system should produce:

- `~/.codex/memories/MEMORY.md` — consolidated memory (Phase 2 agent writes).
- `~/.codex/memories/memory_summary.md` — first line is `v1` (version marker).
- `~/.codex/memories/raw_memories.md` — per-rollout raw memories in stable ascending thread-id order.
- `~/.codex/memories/rollout_summaries/<slug>.md` — one per selected rollout.
- `~/.codex/memories/phase2_workspace_diff.md` — temporary, deleted before baseline reset.
- `~/.codex/memories/.git/` — git baseline for cheap state machine.

## Common pitfalls

- **No-op gate skipped** → model hallucinates low-signal memories every session; memory file grows unbounded. The prompt MUST force the self-question.
- **Stable-key churn** → ordering by `usage_count` causes git to show a "change" every run even when content didn't change. Order by thread-id instead.
- **Reset baseline with diff present** → deleted content stays in git objects forever. Always remove `phase2_workspace_diff.md` BEFORE `reset_git_repository`.
- **Two Codexes consolidating simultaneously** → corruption. Use a single global lock, not optimistic concurrency.
- **Sub-agent with collab enabled** → infinite recursion. Disable `Feature::Collab` on the consolidation agent.
- **Sub-agent with network** → privacy leak. Force `network_access: false` in the sandbox policy.
- **No secrets redaction** → API keys in memory. Always call `redact_secrets` on model output before persisting.
- **Watermark moved backwards** → duplicate work. Use `max(claimed, max(newest_input))`.

## Example — minimal memory workflow

```text
# At session start
phase1::run(claimed_jobs)   # parallel, schema-constrained, redacted, leased
phase2::run(claim_global_lock)  # serial, single global lock
  if !git_diff.has_changes() { mark_success_no_workspace_changes; return; }
  write_workspace_diff(...)
  spawn_consolidation_agent(ephemeral, no_collab, no_network, no_memory_tool)
  handle(lease_heartbeat, validate_artifacts, reset_baseline, mark_succeeded)
```

## Verification checklist

- [ ] Phase 1: `deny_unknown_fields` schema; `buffer_unordered` concurrency cap; lease + ownership token; `redact_secrets`.
- [ ] Phase 1: prompt includes the "future agent plausibly act better" question and the empty-output escape.
- [ ] Phase 2: single global lock (DB lease or file lock); retry with backoff; never two simultaneous runs.
- [ ] Phase 2: spawn sub-agent with `ephemeral + features.disable(Collab) + no network + no memory tool`.
- [ ] Workspace: `raw_memories.md` is sorted by ascending thread-id, never by usage rank.
- [ ] Workspace: `phase2_workspace_diff.md` is removed BEFORE `reset_git_repository`.
- [ ] Watermark: monotonically increasing, never moves backwards.
- [ ] Citation: single-line `<path>:<line_start>-<line_end> |note=[<note>]` format; `try_from().ok()` tolerance.
- [ ] Trigger Phase 1/2 ONLY for non-ephemeral, non-sub-agent root sessions.
