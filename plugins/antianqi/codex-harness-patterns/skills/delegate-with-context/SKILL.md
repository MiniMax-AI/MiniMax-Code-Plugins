---
name: delegate-with-context
description: |
  Hand off a sub-task to a sub-agent with a tight, complete brief in the `prompt` — not the full conversation history. Apply the 4-part message envelope (Task name / Sender / Task / Payload + return path).
  USE WHEN: about to call `task()` to hand off a sub-task, the full conversation history is too large to forward, a minimal-context brief would do, the previous sub-agent failed because the brief was incomplete.
  TRIGGER PHRASES: "delegate", "hand off", "sub-agent", "delegate this", "delegate to", "派给", "委派", "让 sub-agent 干", "把 ... 交给 ...".
  SKIP WHEN: the sub-task is so trivial a `read` will do, you are about to do the work yourself, the user explicitly wants you (not a sub-agent) to do it.
license: Apache-2.0
compatibility: Targets MiniMax Code 0.2.4 `task` tool. Verified against the bundled `cli.js` schema (`description` / `prompt` / `agent_name` / `run_in_background`). The 4-part envelope is host-neutral design; on mcode the envelope goes into the `prompt` string. `agent_name` is the canonical mcode spelling (`explore` / `worker` / `verifier`); `mavis` is the root agent, not a sub-agent.
metadata:
  author: antianqi
  version: "1.2.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs (InterAgentCommunication) and core/src/session/multi_agents.rs (CollabAgentSpawn); the 4-part envelope is the portable design; on mcode the envelope fills the `prompt` field
  changes-from-v1.1.0: "Replaced `subagent_type=` with the canonical mcode `agent_name=`. Replaced `brief=` with `prompt=`. Dropped `mavis` from the sub-agent list (mavis is the root). The 4-part envelope is unchanged but now lives inside the `prompt` string, not in a separate `brief` parameter. The host-pseudocode 'Codex-harness style' block was removed; the mcode 0.2.4 schema is now the only one shown."
---

# Delegate with Context

When handing off work to a sub-agent, the agent has two extremes:

1. **Forward everything**: the sub-agent sees the full parent history. Costs
   tokens, dilutes focus, may leak irrelevant detail.
2. **Forward nothing**: the sub-agent gets a one-line "go do X". The brief is
   almost always incomplete, and the sub-agent re-derives incorrectly.

This Skill is about the **middle ground**: a tight, complete, structured brief that
gives the sub-agent everything it needs and nothing it does not.

## mcode 0.2.4 surface

The `task` tool on mcode 0.2.4:

```text
task(
  description:    string,        // 3-5 word label, required
  prompt:         string,        // the brief, required
  agent_name:  "explore" | "worker" | "verifier",  // required
  run_in_background?: boolean    // optional
)
```

The 4-part envelope is **the design**; on mcode it goes into the `prompt`
string verbatim. `agent_name` is the canonical spelling. `agent_name=` is
accepted as a runtime alias but the Skills prefer the canonical form.

`mavis` is the root agent (the calling session itself), not a sub-agent. It
has no `agent.md` manifest and cannot be used as `agent_name`.

## When to use

Activate when **any** of these is true:

- You are about to call `task` to hand off a sub-task.
- The full conversation history is too large to forward (cost / focus).
- A previous sub-agent failed because the brief was incomplete.
- You want the sub-agent's work to be auditable against a written contract.

## When NOT to use

- The sub-task is so trivial a single `read` will do (no sub-agent needed).
- You are about to do the work yourself.
- The user explicitly wants you (not a sub-agent) to do it.

## Process

1. **Classify the sub-task** (see `fork-context-decision`):
   - Self-contained: `none` (just the brief in `prompt`).
   - Needs prior context: `N` or `all` → inline the prior turns into `prompt` before
     the brief.
2. **Pick the sub-agent type** from `{explore, worker, verifier}` based on what
   the sub-task needs (read / write+run / run-only).
3. **Write the 4-part envelope** below. The envelope is the **portable** part of
   the brief — host `task` tools all accept a brief string.
4. **Choose context level** (see `fork-context-decision`) and inline the chosen
   context into `prompt` before the envelope (or skip if `none`).
5. **Document the return path** — how the sub-agent should hand the result back.

## The 4-part envelope

Every sub-agent brief (the body of the `prompt` field) MUST have these 4 parts,
in order:

```text
Task name: <one short line, e.g. "investigate-lint-flake">
Sender:    <who is asking, e.g. "main agent (you)">
Task:     <one sentence: what the sub-agent must do>
Payload:  <the actual context, links, file paths, prior results>
Return:   <where the result goes, in what format>
```

Each part is mandatory. Skipping any one is the difference between a working
sub-task and a confused one.

### Field-by-field

| Field | Purpose | Bad | Good |
|---|---|---|---|
| Task name | The handle you'll refer to later. | `task1` | `investigate-lint-flake` |
| Sender | Who is asking, so the sub-agent knows the audience. | _(omitted)_ | `main agent` |
| Task | One-sentence scope. | `fix the tests` | `Investigate why test_lint.py flakes on Windows but not Linux. Produce a 1-paragraph root-cause analysis.` |
| Payload | The actual content the sub-agent needs. | `see above` | Links to the file, the prior turn's tool output, the user's exact request. |
| Return | Where the result goes, in what format. | _(omitted)_ | `Append a section to /notes/lint.md titled "## Windows flake root cause" with 1 paragraph.` |

## Common pitfalls

- **Omitting the return path** — the sub-agent finishes and has no idea what
  to do with the result. Always specify.
- **Putting the brief in `Task` and the question in `Payload`** — the sub-agent
  sees both, but the wrong field is the "one-sentence scope". Keep `Task`
  short.
- **Forwarding the full history when `none` would do** — costs tokens and
  dilutes focus. Decide first.
- **Using `agent_name="mavis"`** — mavis is the root agent, not a sub-agent.
  Use `explore` / `worker` / `verifier`.
- **Writing the envelope in a separate `brief=` field** — mcode 0.2.4 does not
  expose a `brief` field. Put it in `prompt`.

## Example

The example below is **MiniMax Code 0.2.4 `task` tool syntax**. The envelope
is the `prompt` body; the call shape is the only one that exists on mcode 0.2.4.

```text
> task(
    description="Investigate lint flake",
    agent_name="worker",   // or "explore" if read-only
    prompt="""
      Task name: investigate-lint-flake
      Sender:    main agent
      Task:     Investigate why <project>/tests/test_lint.py flakes on
                Windows but not Linux. Produce a 1-paragraph root-cause
                analysis.
      Payload:  <project>/tests/test_lint.py (line 47 is the failure);
                prior turn tool output (inlined above this prompt if
                context level > none).
      Return:   Append a section to <project>/notes/lint.md titled
                "## Windows flake root cause" with 1 paragraph.
    """
  )
```

The **envelope** is the design; on mcode the envelope fills the `prompt`
field. There is no separate `brief` parameter.

## Verification checklist

- [ ] Did you classify the sub-task (self-contained vs context-dependent)?
- [ ] Did you pick `agent_name` from `{explore, worker, verifier}`?
- [ ] Did you write all 4 envelope parts (Task name / Sender / Task / Payload / Return)?
- [ ] Did you specify the **return path** (where the result goes)?
- [ ] Did you choose the right context level (via `fork-context-decision`)?
- [ ] Did you put the envelope inside the `prompt` field (not a separate `brief`)?
