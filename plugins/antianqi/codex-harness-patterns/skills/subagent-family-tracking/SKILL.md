---
name: subagent-family-tracking
description: |
  Track parent/child thread tree of spawned sub-agents with Open/Closed status.
  USE WHEN: spawned one or more sub-agents, task description suggests a tree (sub-tasks, "for each of A/B/C", "5 stages"), user asks "what's your sub-agent doing right now" / "子 agent 都在干嘛", sub-agent may fan out, want to know "还在跑吗" / "还有几个没关", before declaring fan-out done (all children closed check).
  TRIGGER PHRASES: "子 agent 都在干嘛", "sub-agent", "子任务", "family tree", "who is running", "还在跑吗", "还有几个没关", "what's your sub-agent doing", "subagent family", "subagent tree", "all children closed".
  SKIP WHEN: sub-task is so cheap you'd just inline it, harness already exposes live sub-agent dashboard, you are the child not the parent.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.1"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/agent-graph-store/
---

# Sub-Agent Family Tracking

When you spawn sub-agents, you create a **family tree**: you are the parent, your spawned
agents are children, and your children's spawned agents are grandchildren. If you do not
track this tree explicitly, three failure modes are common:

1. **Lost child** — you spawn an agent, lose track of its `task_id`, and never read its
   result.
2. **Sibling duplication** — two children of yours do the same work, wasting tokens.
3. **Lingering child** — you move on to the next sub-task, leaving an old child running
   in the background, burning context budget.

This Skill codifies a **family-tracking file** so these failures are visible, not hidden.

## When to use

Activate when **any** of these is true:

- You are about to call `task` and the result of that call is "fire and wait," not "do it
  inline." (Inline calls don't need a tree.)
- You have already spawned one or more sub-agents in this session.
- The task description suggests a tree: "X has sub-tasks", "for each of A/B/C, ...",
  "the migration has 5 stages, each stage can be parallelised."
- A user asks "what's your sub-agent doing right now?" and you don't have an immediate
  answer.

## When NOT to use

- The sub-task is so cheap you would just inline it. (No sub-agent → no tree.)
- The harness already exposes a live dashboard of running sub-agents. (Use that instead.)
- You are the *child*, not the parent. Children don't track siblings; they only see their
  own parent.

## Process

1. **Pick a single, predictable path.** Default:
   `.minimax/agents/<thread-id>/subagents.md`. Different from the goal file (which is "what we
   are doing") and the world-state file (which is "where we are"); this is "who is
   working for us."
2. **Initialise the file on the first spawn** in this exact shape:

   ```markdown
   # Sub-agent family — <short task name>

   **Parent (you)**: <thread-id>
   **Last updated**: <ISO timestamp>

   ## Children

   | id | spawned_at | brief | status | result_summary |
   |----|------------|-------|--------|----------------|
   | <task_id> | <ISO> | <one-line brief> | open | (pending) |
   ```

3. **On every spawn**, add a row with `status: open` and a one-line brief.
4. **On every sub-agent completion**, update the row:
   - `status: closed` (or `closed-failed` if it didn't meet its pass condition)
   - `result_summary: <one line>`
5. **If a sub-agent spawns its own children**, append a sub-section for that child:

   ```markdown
   | <task_id> | <ISO> | <one-line brief> | open | (pending) |
     ## Children of <task_id>
     | grandchild-id | spawned_at | brief | status | result_summary |
     |---------------|------------|-------|--------|----------------|
   ```

6. **At every `context-pressure-compact`**, the compact summary must reference the family
   file by path, not duplicate it. The file is the ground truth.
7. **At the end of a fan-out aggregation** (see `parallel-fanout`), include a one-line
   "all children closed" check. If any are still `open`, surface that to the user — the
   aggregation is not safe to declare done while children are running.

## Output contract

The user sees:

- The family file's contents (full) at the start of any multi-agent task.
- A one-line status update per spawn / completion (e.g. "spawned task-7a3f for OIDC review,"
  "task-7a3f closed with PASS").
- A "all children closed" check at the end of any fan-out.

## Example

```markdown
# Sub-agent family — Auth refactor (OIDC alongside SAML)

**Parent (you)**: thread-7c2b
**Last updated**: 2026-08-23T23:55:00Z

## Children

| id | spawned_at | brief | status | result_summary |
|----|------------|-------|--------|----------------|
| task-3f1a | 23:40:00Z | Audit /repo/server/Cargo.toml for CVEs | closed | No critical CVEs; 2 moderate, listed in SECURITY-REPORT.md |
| task-4d2b | 23:40:00Z | Audit /repo/web/package.json for CVEs | closed | 1 critical CVE (CVE-2024-xxxx); surfaced immediately, did not wait for others |
| task-5e3c | 23:40:00Z | List licenses of /repo/server and /repo/web direct deps | open | (pending) |
```

After task-5e3c finishes:

```markdown
| task-5e3c | 23:40:00Z | List licenses of /repo/server and /repo/web direct deps | closed | 47 deps; 1 AGPL, 4 Apache-2.0, rest MIT — full table in SECURITY-REPORT.md |
```

If task-5e3c spawned a grandchild (e.g. for cross-checking an ambiguous license):

```markdown
| task-5e3c | 23:40:00Z | List licenses of /repo/server and /repo/web direct deps | closed | 47 deps; 1 AGPL, 4 Apache-2.0, rest MIT |
  ## Children of task-5e3c
  | task-5e3c-1 | 23:42:00Z | Cross-check `foo-1.0.0` license classification | closed | Confirmed AGPL-3.0 via SPDX registry |
```

## Common pitfalls

- **Do not skip the file "because it's only one sub-agent."** You will spawn another
  before you know it, and then you will not know which results came from which.
- **Do not put full sub-agent output in the table.** The table is the index. The full
  output lives in the sub-agent's own response (or a file it wrote). The table points to it.
- **Do not let the file grow unbounded.** A 500-line family file is no longer a tracking
  file. If it grows past ~80 lines, summarise closed children into a "Completed
  (summary)" section.
- **Do not confuse "open" with "running".** A sub-agent can be `open` and waiting on user
  input, or `open` and silently failed. "Closed" means the result was received and
  processed, not that the work succeeded.
- **Do not declare fan-out done while children are still open.** A `parallel-fanout` aggregation
  must wait for *all* children to close. The check is mechanical, not visual.
- **Do not let a child spawn grand-children without recording it.** If you do not capture
  the grandchild relationship, you cannot tell which child is responsible for which
  grandchild's result.

## Verification checklist

- [ ] Is the family file at a single, predictable path?
- [ ] Is it initialised with the full table shape on the first spawn?
- [ ] Does every spawn add a row with `status: open`?
- [ ] Does every completion update the row to `status: closed`?
- [ ] Are grand-children recorded in a sub-section under their parent?
- [ ] Is the file < ~80 lines? (Summarise old entries if not.)
- [ ] At every `context-pressure-compact`, is the file referenced by path (not
      duplicated)?
- [ ] At the end of any fan-out, is the "all children closed" check explicit?
