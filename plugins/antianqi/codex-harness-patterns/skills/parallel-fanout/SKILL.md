---
name: parallel-fanout
description: "Decompose a clearly independent task into 2+ parallel sub-tasks and dispatch them with `task` in one round trip, then aggregate. Use when the user task can be split along a clean boundary (independent files, independent probes, independent analyses) and serial execution would take materially longer. Mirrors codex-rs FuturesUnordered fan-out in thread_manager.rs."
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/thread_manager.rs
---

# Parallel Fan-Out

When a task splits cleanly into 2+ independent sub-tasks, dispatch them in parallel and
aggregate. Skip when the sub-tasks have data dependencies or when serial execution is fast
enough that the overhead of fan-out is not worth it.

## When to use

Activate when **all** of the following hold:

- The user task has 2+ **independent** sub-tasks. Independent means: sub-task B does not need
  any output of sub-task A, and sub-task A does not need any output of sub-task B.
- Each sub-task is **bounded**: you can name what "done" looks like in one sentence.
- The estimated wall-clock time of serial execution is **at least 2×** the longest single
  sub-task. If one sub-task dwarfs the others, fan-out buys you little.
- The user has not said "do it one by one" / "step by step" / "sequentially please".

## When NOT to use

- The sub-tasks share state (e.g. all read/modify the same file in conflicting ways).
- The sub-tasks need each other's intermediate output (e.g. test plan A depends on the refactor
  in B).
- The total work is tiny (3 file edits); the orchestration overhead exceeds the savings.
- The user explicitly asked for serial work or a careful step-by-step walkthrough.
- You cannot articulate the boundary of each sub-task in one sentence. If you can't, you can't
  safely parallelise it.

## Process

1. **State the decomposition first** — before any tool call, write a fenced block that names
   the sub-tasks, their boundaries, and the aggregation step:

   ```markdown
   ## Fan-out plan

   **Sub-task 1**: <one-line description; bounded by — pass condition>
   **Sub-task 2**: <one-line description; bounded by — pass condition>
   **Sub-task 3**: <one-line description; bounded by — pass condition>

   **Aggregation**: <how the results are merged — a single file, a combined report, etc.>
   **Stop conditions**: <if any sub-task fails or contradicts another, what happens?>
   ```

2. **Dispatch in parallel** with `task`. Use `run_in_background: true` for each so they overlap
   in the same round trip. Pass a minimal-context brief to each — the original user request
   plus the specific sub-task boundary, NOT the full history.

3. **While waiting**, the orchestrating agent may draft the aggregation template (so the final
   merge is a fill-in, not a re-derivation).

4. **On all sub-tasks completing**:
   - Verify each met its pass condition.
   - If a sub-task drifted outside its boundary, **reject** and re-dispatch with a tighter
     brief. Do not absorb the drift.
   - If two sub-tasks produced conflicting facts (different numbers, different recommendations),
     surface the conflict to the user **before** aggregating. Do not silently pick one.

5. **Aggregate** into the agreed shape. Cite the source sub-task for each section so the user
   can drill in.

6. **Report** the wall-clock time saved if you have it (use timestamps from the sub-task
   responses). This is how you earn the right to fan out again.

## Output contract

The user sees, in this order:

- The Fan-out plan block (before any tool call).
- The list of dispatched sub-tasks (one line per `task` call).
- The pass/fail per sub-task.
- Any conflicts surfaced before aggregation.
- The aggregated result.
- (Optional) The wall-clock saving vs serial.

## Example

```markdown
## Fan-out plan

**Sub-task 1**: Audit dependencies in /repo/server/Cargo.toml for known CVEs.
   Pass condition: a table of {crate, version, advisory_id, severity}.
**Sub-task 2**: Audit dependencies in /repo/web/package.json for known CVEs.
   Pass condition: a table of {package, version, advisory_id, severity}.
**Sub-task 3**: List license of every direct dependency in /repo/server and /repo/web.
   Pass condition: a single table of {crate_or_package, license, copyleft_flag}.

**Aggregation**: Combine into a single SECURITY-REPORT.md at the repo root.
**Stop conditions**: If sub-task 1 or 2 finds a critical CVE, surface immediately and do not
wait for sub-task 3.
```

Then:

```text
> task(subagent=explore, run_in_background=true,
       prompt="Audit /repo/server/Cargo.toml direct dependencies ...")
> task(subagent=explore, run_in_background=true,
       prompt="Audit /repo/web/package.json direct dependencies ...")
> task(subagent=explore, run_in_background=true,
       prompt="List licenses of /repo/server and /repo/web direct deps ...")
```

## Common pitfalls

- **Do not fan out work that is too small.** A 200-line refactor is one task, not three.
- **Do not fan out work with hidden dependencies.** If sub-task 2 might need to read what
  sub-task 1 wrote, that's serial. Don't pretend.
- **Do not over-brief sub-tasks.** "Refactor the auth subsystem" is not a sub-task brief; it
  is the whole job. A sub-task brief names a file, a change, and a pass condition.
- **Do not under-brief.** "Look at the auth code" is not enough; the sub-agent will guess
  wrong. Always include the file paths and the pass condition.
- **Do not aggregate silently.** If two sub-tasks disagree, the user must see the conflict.
- **Do not fan out > 5 sub-tasks.** Beyond 5, the aggregation step becomes a bottleneck and
  context cost grows. For larger splits, ask the user first.

## Verification checklist

- [ ] Did you state the Fan-out plan block before any tool call?
- [ ] Is each sub-task truly independent (no shared state, no data flow between them)?
- [ ] Did you pass a minimal-context brief, not the full history?
- [ ] Did you use `run_in_background: true` so they overlap?
- [ ] Did you surface conflicts before aggregating?
- [ ] Did you cite the source sub-task for each section of the aggregation?
- [ ] Did the wall-clock savings actually justify the fan-out?
