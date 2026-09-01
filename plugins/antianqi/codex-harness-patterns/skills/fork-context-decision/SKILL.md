---
name: fork-context-decision
description: |
  Decide how much parent context to include in a sub-agent's `prompt` before spawning it. Pick "all / N turns / brief only" explicitly, not by accident.
  USE WHEN: about to call `task()` to hand off work, designing a multi-agent flow, sub-agent failed and debugging whether cause was over- or under-forking, user said "give it the full history" / "no history" / "just the brief" / "don't carry context" / "深度 fork" / "不要带 context".
  TRIGGER PHRASES: "fork 深度", "give it the full history", "深 fork", "no history", "just the brief", "不要带 context", "fork 0", "fork all", "完全独立会话", "轻量 context".
  SKIP WHEN: sub-task is trivial (one-line read), you have already decided "no context" (no decision to make).
license: Apache-2.0
compatibility: Targets MiniMax Code 0.2.4 `task` tool. Verified against the bundled `cli.js` schema (`description` / `prompt` / `agent_name` / `run_in_background`). `agent_name` is the canonical mcode spelling; `agent_name` is accepted as an alias by mcode's normaliser but the Skills prefer the canonical form. The mcode `task` tool has no `history` / `fork_turns` / `context_size` parameter — all context sharing is done by what you write into the `prompt` string itself.
metadata:
  author: antianqi
  version: "0.3.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/session/multi_agents.rs (design principle; the 3 fork modes are portable; the prompt-content decision is host-neutral)
  changes-from-v0.2.0: "Removed the v0.2.0 `history=N` PLACEHOLDER — the mcode 0.2.4 `task` tool has no context-sharing parameter, so the 3 fork modes (all / N / none) are now expressed by what the calling agent writes into the `prompt` (full conversation dump / last N turns inline / brief only). Replaced `subagent_type=` with the canonical mcode `agent_name=`. Dropped `mavis` from the subagent list because `mavis` is the root agent (it has no `agent.md` subagent manifest and cannot be used as `agent_name`); the 3 actual mcode sub-agent types are `explore` / `worker` / `verifier`."
---

# Fork Context Decision

How much parent context to pass to a sub-agent is the **single largest cost lever** in
multi-agent work. Too much and you double the model's context; too little and the
sub-agent cannot do its job because it cannot see what came before. Pick wrong either
way, the work slows down or silently fails.

This Skill codifies the decision so the agent makes it explicitly, not by accident.

## The hard fact about mcode 0.2.4

The mcode 0.2.4 `task` tool **has no parameter for context sharing**. The
canonical schema is:

```text
task(
  description: string,        // 3-5 word label, required
  prompt:      string,        // the task itself, required
  agent_name: string,      // "explore" | "worker" | "verifier", required
  run_in_background?: boolean // optional
)
```

`agent_name` is accepted as a runtime alias (the normaliser at `cli.js:j6c` converts
it to `subagent_type`) but the canonical form is `agent_name`. There is **no
`history=`, no `fork_turns=`, no `context_size=`** — the calling agent has full
control of what the sub-agent sees by writing it into the `prompt` string. So
the 3 fork modes (all / N / none) become a `prompt` content decision, not a
parameter.

## mcode 0.2.4 sub-agent types

The mcode 0.2.4 `task` tool accepts three sub-agent types as the value of
`agent_name=`. The on-disk path of each sub-agent's manifest is
host-internal (varies across installs and platforms) and is **not**
part of the public runtime contract. The Skills in this plugin rely on
the `agent_name` parameter, not on any on-disk manifest path; do not
hard-code `assets/agents/<name>/agent.md` or similar layouts.

| `agent_name` | Tools | Use when |
|---|---|---|
| `explore` | `read`, `grep`, `glob`, `web_fetch` | Read-only investigation; cannot write or run commands. |
| `worker` | `read`, `write`, `edit`, `bash`, `grep`, `glob`, `todowrite`, `web_fetch`, `website_deploy` | Implementation; full read/write/run. |
| `verifier` | `read`, `grep`, `glob`, `bash`, `web_fetch` | Has `bash` but **no `write` / `edit` / `website_deploy`**: can run checks, cannot modify. |

`mavis` is the **root** agent (different layout: `modes/`, `skills/`,
persona files). It is not an `agent_name` value; the calling session
already *is* mavis. The v0.2.0 list that included `mavis` as a sub-agent
option is removed.

## When to use

Activate when **any** of these is true:

- You are about to call `task` (or any sub-agent spawn) to hand off a sub-task.
- You are designing a multi-agent flow (`parallel-fanout`, `delegate-with-context`).
- A previous sub-agent failed and you are debugging whether the cause was over- or
  under-forking.
- You are about to spawn a sub-agent and feel unsure whether to pass context or not.

## When NOT to use

- The sub-agent tool does not accept any context / fork parameter (then the decision
  is forced; skip).
- The sub-task is so trivial that the cost difference is noise (a one-line `read`).
- You have already decided "no context" (no decision to make).

## The decision

Three choices, ordered by cost. Each is implemented by what you write into
the `prompt` field.

| Choice | What the sub-agent sees (in `prompt`) | Use when |
|---|---|---|
| **`all`** | The full parent conversation history, inlined or attached. | Sub-agent must reason about a prior decision, debug an earlier failure, or reuse a result the parent has already computed. |
| **`N`** (integer) | The last N turns, inlined. | Sub-agent needs recent context but not the full history. |
| **`none`** (or `0` / `brief`) | Only the brief you write inline. | Sub-task is self-contained; the brief is enough. |

### Pseudo-cost table

| Choice | Token cost | Sub-agent accuracy on context-dependent tasks | Sub-agent accuracy on self-contained tasks |
|---|---|---|---|
| `all` | 100% | high | low (distracted by noise) |
| `N` | moderate | high (if N is enough) | high |
| `none` | minimal | low | high (focused) |

## Process

1. **Classify the sub-task**. Does it need to see any prior turn?
   - If **yes**: choose `all` or `N`.
   - If **no**: choose `none` and write a self-contained brief.
2. **If you chose `N`**: pick the smallest N that still works.
   - Start at 3. If the sub-agent asks for more context, bump to 5, then 10, then `all`.
3. **Build the `prompt`** for the chosen level:
   - `all` → concatenate the entire prior conversation, then append the brief.
   - `N` → concatenate the last N turns verbatim, then append the brief.
   - `none` → just the brief, no prior content.
4. **Document the choice in the brief**:
   - `Context level: <all | N | none>`
   - `Reason: <one sentence>`
5. **If the sub-agent fails**, retry with the next higher N before changing anything
   else. A `none` that failed is almost always a brief problem, not a context
   problem — but try `N=3` first because the cost is small.

## Output contract

After activating this Skill, the next `task` call MUST:

- Pick a `agent_name` from `{explore, worker, verifier}` based on what the
  sub-task needs (read / write+run / run-only).
- Include a `description` (3-5 word label).
- Build the `prompt` according to the chosen context level.
- Either inline the context (for `N` or `all`) or start the `prompt` with the
  brief header:

```text
# Sub-task brief
Context level: <all | N | none>
Reason: <one sentence>
Sub-agent type: <explore | worker | verifier>
<the actual brief>
```

## Common pitfalls

- **Defaulting to `all` "to be safe"** — costs you every turn, and dilutes the
  sub-agent's focus. Only use `all` if you have a concrete reason.
- **Defaulting to `none` "to save cost"** — the sub-agent re-derives from the brief,
  and the brief is often wrong. The cost saved is the cost of the bug.
- **Not documenting the choice** — a future reviewer (or you, tomorrow) cannot tell
  why `N=3` was chosen. Document or it didn't happen.
- **Changing the brief without changing `N`** — if the brief is wrong, more context
  doesn't help. Fix the brief first.
- **Writing a single tool call expecting the host to manage history** — mcode 0.2.4
  does not auto-attach prior conversation. The decision is in the call you write.
- **Using `agent_name="mavis"`** — mavis is the root agent, not a sub-agent.
  Use `explore` / `worker` / `verifier`.

## Example

The example below uses **MiniMax Code 0.2.4 `task` tool syntax**. The 3 fork
modes are demonstrated; the `prompt` content is what changes between them.

```text
# Context level: none
# Sub-agent: worker (writes files)
# Cost: minimal
> task(
    description="Investigate lint flake",
    agent_name="worker",
    prompt="""
      Context level: none
      Reason: this is a self-contained repro request.
      Sub-agent type: worker

      Investigate why <project>/tests/test_lint.py line 47
      flakes on Windows but not Linux. Write a 1-paragraph
      root-cause analysis to <project>/notes/lint.md under
      "## Windows flake root cause".
    """
  )

# Context level: N=3
# Sub-agent: worker
# Cost: 3 prior turns inlined
> task(
    description="Diagnose test failure",
    agent_name="worker",
    prompt="""
      Context level: 3
      Reason: the previous tool output is the most likely
      cause; the sub-agent needs to see it.
      Sub-agent type: worker

      === last 3 turns (verbatim) ===
      <turn -3: user request>
      <turn -2: read of test_lint.py>
      <turn -1: bash pytest run with failure at line 47>

      Investigate the line 47 failure and write a fix to
      <project>/tests/test_lint.py.
    """
  )

# Context level: all
# Sub-agent: explore (read-only)
# Cost: 100% of parent context
> task(
    description="Audit earlier decision",
    agent_name="explore",
    prompt="""
      Context level: all
      Reason: the sub-agent must reason about a decision
      made 12 turns ago.
      Sub-agent type: explore

      === full prior conversation (verbatim) ===
      <entire conversation history>

      Find every place we used 'json.dumps(indent=2)' and
      confirm the output matches the user's earlier spec.
    """
  )
```

The **decision** (3 turns vs full history vs brief only) is the same; the
**implementation** is what you put in the `prompt` string.

## Verification checklist

- [ ] Did you classify the sub-task before choosing?
- [ ] Did you pick the smallest N that works (not jumping straight to `all`)?
- [ ] Did you pick a `agent_name` from `{explore, worker, verifier}`?
- [ ] Did you document the context level in the brief header?
- [ ] Did you build the `prompt` so the sub-agent actually sees the chosen context?
- [ ] If the sub-agent failed, did you bump N before changing the brief?
