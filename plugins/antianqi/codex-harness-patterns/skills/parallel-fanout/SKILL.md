---
name: parallel-fanout
description: |
  Dispatch 2+ independent sub-tasks in parallel via `task` and aggregate.
  USE WHEN: 2+ independent sub-tasks, each bounded and well-defined, serial would take 2x longer than longest sub-task, user said "并行" / "parallel" / "fan out" / "spawn agents", multiple independent files/probes/analyses, "for each of A/B/C" / "分头做" / "拆开".
  TRIGGER PHRASES: "并行", "parallel", "fan out", "spawn agents", "分头做", "一起做", "for each", "分别", "拆开并行", "一起跑".
  SKIP WHEN: sub-tasks share state, sub-tasks depend on each other's output, total work is tiny (< 3 edits), user said "one by one" / "step by step" / "sequentially" / "一个一个来".
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "1.0.1"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/session/multi_agents.rs and core/src/thread_manager.rs
  changes-from-v0.1.0: "Added explicit-spawn principle (P-20: spawn is opt-in, not auto); added `max_concurrency` awareness; cross-referenced `fork-context-decision` for per-sub-task cost control; cross-referenced `delegate-with-context` for the brief."
---

# Parallel Fan-Out

When a task splits cleanly into 2+ independent sub-tasks, dispatch them in parallel and
aggregate. Skip when the sub-tasks have data dependencies, when serial execution is fast
enough that the overhead of fan-out is not worth it, or when the user has not opted in to
multi-agent work.

**v1.0 update**: makes explicit that fan-out is an *opt-in decision* (mirroring Codex's
`MultiAgentMode::ExplicitRequestOnly` default), and ties fan-out to the cost-control
machinery in `fork-context-decision`.

## When to use

Activate when **all** of the following hold:

- The user task has 2+ **independent** sub-tasks. Independent means: sub-task B does not need
  any output of sub-task A, and sub-task A does not need any output of sub-task B.
- Each sub-task is **bounded**: you can name what "done" looks like in one sentence.
- The estimated wall-clock time of serial execution is **at least 2×** the longest single
  sub-task. If one sub-task dwarfs the others, fan-out buys you little.
- The user has **opted in** to multi-agent work for this task. See "Opt-in principle" below.
- The user has not said "do it one by one" / "step by step" / "sequentially please".

### Opt-in principle (from Codex MultiAgentMode)

Codex ships in `MultiAgentMode::ExplicitRequestOnly`: the agent does not spawn sub-agents
on its own — only when the user explicitly asks or the system instruction is set. We follow
the same default:

- **Default**: do not fan out. Do the work yourself, or in sequence.
- **Opt-in triggers** (any one is enough):
  - The user says "并行" / "fan out" / "do these in parallel" / "spawn agents".
  - The user has set an AGENTS.md / system instruction that says "use sub-agents for this
    class of task."
  - The task is so large that serial execution would obviously exceed the user's patience
    (judgment call — be conservative).

When in doubt, ask the user before fan-out. The cost of a wrong fan-out is wasted sub-agent
spend; the cost of a wrong serial is just a few extra turns.

## When NOT to use

- The sub-tasks share state (e.g. all read/modify the same file in conflicting ways).
- The sub-tasks need each other's intermediate output (e.g. test plan A depends on the refactor
  in B).
- The total work is tiny (3 file edits); the orchestration overhead exceeds the savings.
- The user explicitly asked for serial work or a careful step-by-step walkthrough.
- You cannot articulate the boundary of each sub-task in one sentence. If you can't, you can't
  safely parallelise it.
- The user has not opted in to multi-agent work and the task is small enough to do
  directly.

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
   **Concurrency cap**: <N sub-tasks max in flight at once; default 5>
   ```

2. **For each sub-task, decide `fork_turns`** (see `fork-context-decision` Skill):
   - Self-contained sub-task (look up, reformat, list) → `none`
   - Sub-task depends on recent parent decisions → `N` (small)
   - Sub-task is a continuation of the same debugging session → `all` (rare)

3. **Dispatch in parallel** with `task`. Use `run_in_background: true` for each so they overlap
   in the same round trip. Pass a **minimal-context brief** to each (see
   `delegate-with-context` Skill) — not the full history.

4. **Respect the concurrency cap.** If the user task has 8 sub-tasks and `max_concurrency`
   is 5, dispatch 5, wait for one to finish, then dispatch the next. Do not fan out
   unboundedly — the harness and the user's patience both have limits.

5. **While waiting**, the orchestrating agent may draft the aggregation template (so the final
   merge is a fill-in, not a re-derivation).

6. **On all sub-tasks completing**:
   - Verify each met its pass condition.
   - If a sub-task drifted outside its boundary, **reject** and re-dispatch with a tighter
     brief. Do not absorb the drift.
   - If two sub-tasks produced conflicting facts (different numbers, different recommendations),
     surface the conflict to the user **before** aggregating. Do not silently pick one.

7. **Aggregate** into the agreed shape. Cite the source sub-task for each section so the user
   can drill in.

8. **Report** the wall-clock time saved if you have it (use timestamps from the sub-task
   responses). This is how you earn the right to fan out again.

9. **Before declaring the whole task done**, run a `completion-audit` (separate Skill) on
   the aggregated result. Fan-out is exactly the kind of work that produces confident-looking
   but unverified deliverables.

## Output contract

The user sees, in this order:

- The Fan-out plan block (before any tool call), including the concurrency cap.
- The list of dispatched sub-tasks (one line per `task` call) with the chosen `fork_turns`.
- The pass/fail per sub-task.
- Any conflicts surfaced before aggregation.
- The aggregated result.
- (Optional) The wall-clock saving vs serial.
- A `completion-audit` on the final aggregation before declaring done.

## Example

```markdown
## Fan-out plan

**Sub-task 1**: Audit dependencies in /repo/server/Cargo.toml for known CVEs.
   Pass condition: a table of {crate, version, advisory_id, severity}.
   fork_turns: none (look-up only).
**Sub-task 2**: Audit dependencies in /repo/web/package.json for known CVEs.
   Pass condition: a table of {package, version, advisory_id, severity}.
   fork_turns: none.
**Sub-task 3**: List license of every direct dependency in /repo/server and /repo/web.
   Pass condition: a single table of {crate_or_package, license, copyleft_flag}.
   fork_turns: none.

**Aggregation**: Combine into a single SECURITY-REPORT.md at the repo root.
**Stop conditions**: If sub-task 1 or 2 finds a critical CVE, surface immediately and do not
wait for sub-task 3.
**Concurrency cap**: 3 (we have 3 sub-tasks, all run in parallel).
```

Then:

```text
> task(subagent=explore, run_in_background=true, fork_turns=0,
       prompt="Audit /repo/server/Cargo.toml direct dependencies ...")
> task(subagent=explore, run_in_background=true, fork_turns=0,
       prompt="Audit /repo/web/package.json direct dependencies ...")
> task(subagent=explore, run_in_background=true, fork_turns=0,
       prompt="List licenses of /repo/server and /repo/web direct deps ...")
```

## Common pitfalls

- **Do not fan out by default.** Codex ships in `MultiAgentMode::ExplicitRequestOnly` —
  spawn is opt-in, not auto. Follow the same default.
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
- **Do not skip the completion audit on the aggregation.** Fan-out produces more text
  to be wrong about, not less. A confident-looking aggregated report is still unverified
  until the audit is run.
- **Do not pick `all` for fan-out sub-tasks.** Fan-out sub-tasks should default to
  `none` (look-up only) or small `N` (recent context). See `fork-context-decision`.
- **Do not exceed the concurrency cap.** If `max_concurrency=5` and you have 8 sub-tasks,
  batch them, not all at once.

## Verification checklist

- [ ] Did the user opt in (or is the task so large that opt-in is the only reasonable read)?
- [ ] Did you state the Fan-out plan block before any tool call, including the
      concurrency cap?
- [ ] Is each sub-task truly independent (no shared state, no data flow between them)?
- [ ] Did you pass a minimal-context brief, not the full history? (`delegate-with-context`)
- [ ] Did you choose `fork_turns` for each sub-task explicitly? (`fork-context-decision`)
- [ ] Did you use `run_in_background: true` so they overlap?
- [ ] Did you respect the concurrency cap (no unbounded fan-out)?
- [ ] Did you surface conflicts before aggregating?
- [ ] Did you cite the source sub-task for each section of the aggregation?
- [ ] Did you run a `completion-audit` on the aggregation before declaring done?
- [ ] Did the wall-clock savings actually justify the fan-out?
