---
name: model-router
description: |
  Classify sub-task complexity (cheap / medium / main) and decide whether to spawn a sub-agent at all. On MiniMax Code 0.2.4 the `task` tool does not expose per-call model selection, so the 3-tier rubric here is a thinking framework for session-level model choice and a "do I really need a sub-agent?" gate, not a per-call `model_config_id` field.
  USE WHEN: about to spawn a sub-agent for non-trivial work, about to spend the main model on something a cheap model could do, "do this with the cheap model" / "用便宜模型" / "不要用主模型" / "sub-task 不重" / "small task" / "小任务".
  TRIGGER PHRASES: "用便宜模型", "cheap model", "use the cheap model", "小任务用便宜模型", "不要用主模型", "用本地模型", "sub-task 不重", "小任务", "this is just a", "小 case 用便宜".
  SKIP WHEN: sub-task IS the main task, mcode 0.2.4's `task` tool does not expose a per-call model field, sub-task is genuinely synthesis / design / cross-file reasoning.
license: Apache-2.0
compatibility: Targets MiniMax Code 0.2.4. **The mcode 0.2.4 `task` tool does NOT expose a `model_config_id` parameter or any other per-call model-routing field.** Verified against the bundled `cli.js` canonical schema (only `description` / `prompt` / `subagent_type` / `run_in_background`). Model selection on mcode 0.2.4 is **session-level** (chosen at session start via the host's `model` flag / interactive picker). This Skill therefore reframes the original 3-tier rubric into a session-level thinking framework and a sub-agent gate, not a per-`task()` argument.
metadata:
  author: antianqi
  version: "0.4.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/ and codex-rs/models-manager/ (design principle only; the 3-tier classification is portable; the mcode 0.2.4 surface for model selection is session-level, not per-task)
  changes-from-v0.3.3: "Removed the v0.3.3 claim that 'MiniMax Code's `task` tool accepts `model_config_id` directly' — that was wrong. The canonical mcode 0.2.4 `task` schema has no per-call model field; the only model-routing surface on 0.2.4 is session-level (the host's `model` config at session start). The 3-tier rubric is preserved as a thinking framework and as a sub-agent gate ('don't spawn a sub-agent if the work is `cheap` enough that the calling session's current model could do it in 2 tool calls'), but no `model_config_id` is passed in any `task()` call. The Example section is reframed to match the actual mcode 0.2.4 surface."
---

# Model Router

The main model is expensive and slow. Most sub-tasks a long agent spawns are not
"main-model expensive" — they are lookups, transforms, summaries, or pattern matches. The
Codex harness routes those to cheaper models and reserves the main model for synthesis and
hard reasoning.

On **mcode 0.2.4** specifically, the `task` tool does **not** expose a per-call model
parameter. The 3-tier rubric below is therefore a **thinking framework for session-level
model choice and a sub-agent gate**, not a per-`task()` argument. The Skills keep the
classification because the cost-of-thought question is the same; they just do not pretend
mcode 0.2.4 routes per call.

## The hard fact about mcode 0.2.4

The canonical mcode 0.2.4 `task` schema:

```text
task(
  description:    string,        // required
  prompt:         string,        // required
  subagent_type:  "explore" | "worker" | "verifier",  // required
  run_in_background?: boolean    // optional
)
```

**No `model_config_id`, no `model`, no `reasoning_effort`, no per-call tier.** Model
selection on mcode 0.2.4 is session-level (chosen at session start via the host's
`model` flag / interactive picker — the same model is used for the whole session,
including every `task` call). Trying to pass `model_config_id="..."` is rejected
by the strict validator in `cli.js:B6c` (the only allowed keys are the four above).

The v0.3.3 wording "MiniMax Code's `task` tool accepts `model_config_id` directly"
was wrong. The cost-of-thought question (cheap / medium / main) is still worth
asking; just not as a per-`task()` argument.

## When to use

Activate when **any** of these is true:

- You are about to spawn a sub-agent and the work is non-trivial.
- You are about to spend the main model on a work step that has clearly bounded
  complexity (a lookup, a transform, a reformat, a coverage report).
- A sub-task failed and you are about to retry; consider whether the brief was
  bad, not whether a stronger model would help (mcode cannot route per call).
- A batch of N similar sub-tasks is about to run; classify them once and decide
  whether to spawn at all (the sub-agent gate).

## When NOT to use

- The sub-task *is* the main task (no delegation happening). You are already on
  the right model.
- The sub-task requires the same context the main thread has, and you cannot
  pass a minimal-context brief (see `fork-context-decision`). A sub-agent with
  no context will fail — do it yourself.
- The user explicitly said "use the main model for this" or "don't downgrade the
  model" (no-op on mcode 0.2.4 anyway, but respects the user's framing).

## Process

1. **Classify the sub-task** into one of three tiers, before deciding whether to
   spawn a sub-agent at all:

   | Tier | When to use | Examples |
   |---|---|---|
   | **`cheap`** | Bounded, single-shot, the brief fully specifies success. No synthesis, no judgement. | reformat a file, list files matching a glob, count lines, parse a JSON, run a deterministic script, copy a file with substitutions |
   | **`medium`** | Multi-step but well-scoped, the brief is the only context needed. Some judgement, no synthesis of new ideas. | summarise a long doc, refactor a single function, write tests for a known spec, review a single PR |
   | **`main`** | Requires synthesis, judgement across multiple sources, or stakes that make cheap-model mistakes costly. | design an API, evaluate tradeoffs, debug a multi-file interaction, write code that needs to satisfy a spec the agent has to interpret |

   If unsure, classify up — `main` is the safe default.

2. **Decide whether to spawn at all** (the sub-agent gate, on mcode 0.2.4):
   - If the work is **`cheap`** AND the calling session can do it in 2 tool calls
     (one `read` / `grep` / `bash` + one `write` / nothing), **do not spawn**.
     The cost of the spawn (the sub-agent's bootstrap, the brief round-trip) is
     higher than just doing the work.
   - If the work is **`medium`** or **`main`**, spawn with the appropriate
     `subagent_type` (`explore` / `worker` / `verifier`).
   - The model that runs the sub-agent is the same as the calling session's
     model — there is no per-call tier routing on mcode 0.2.4.

3. **State the tier and the spawn decision in the sub-task brief** so a human
   reviewer can see why you spawned (or did not spawn):

   ```markdown
   ## Sub-task brief
   ...

   **Tier**: cheap | medium | main
   **Spawn decision**: doing-it-myself | task(subagent_type=...)
   **Reason**: <one sentence>
   ```

4. **If the sub-task returns a "I can't do this"**, do not silently retry on the
   same call. Re-classify: either the brief is wrong (rewrite it) or the work is
   harder than the tier suggested (re-classify up). On mcode 0.2.4 "going up a
   tier" means ending the session and restarting on a stronger model, not passing
   a different parameter — call this out to the user.

5. **Record the actual spend** if the harness surfaces per-call token counts.
   After a fan-out, note in the aggregation how much of the total was cheap-vs-
   medium-vs-main. This is how you learn the right tier for each sub-task shape.

## Output contract

The user sees, in this order:

- For every spawn decision: the tier and the spawn reason (one line each).
- For the fan-out aggregation: a one-line "X cheap / Y medium / Z main" summary.
- For upgrades (cheap → medium → main on a retry): a one-line reason plus the
  user-facing cost (on mcode 0.2.4: "this needs main; please restart the
  session on a stronger model").

## Example

The example below is **MiniMax Code 0.2.4 `task` tool syntax**. The
`model_config_id` argument is **deliberately not shown** because mcode 0.2.4
does not accept it.

```text
[planning] 1 cheap call: list all *.rs files in <repo>/src/auth/ that
            import `tokio::sync::Mutex`.
            — tier: cheap (deterministic glob + grep, no judgement)
            — spawn decision: DO NOT SPAWN. 1 read + 1 grep is faster than
              the sub-agent bootstrap.

[execution] 1 medium call: refactor auth/callback.rs to extract the SAML
            response parser.
            — tier: medium (multi-step refactor, brief is the spec)
            — spawn decision: task(subagent_type="worker")
            — model: same as calling session (mcode 0.2.4 has no per-call
              model field)

> task(
    description="Refactor SAML parser",
    subagent_type="worker",
    prompt="""
      Tier:        medium
      Spawn:       task(subagent_type=worker)
      Task name:   refactor-saml-parser
      Sender:      main agent
      Task:        Extract the SAML response parser from
                   <repo>/src/auth/callback.rs lines 80-140 into
                   <repo>/src/auth/saml.rs as a free function.
      Payload:     <repo>/src/auth/callback.rs (lines 80-140);
                   <repo>/src/auth/mod.rs (re-export point).
      Return:      Write the new file <repo>/src/auth/saml.rs and
                   update <repo>/src/auth/mod.rs. Run
                   `cargo test --lib auth` and confirm green.
    """
  )

[execution] 1 main call: design the OidcProvider trait given the existing
            IdP interface and the OIDC spec. Resolve the
            "extend IdP vs new sibling" question.
            — tier: main (synthesis + cross-source judgement)
            — spawn decision: this is the main task; no spawn.
            — model: session-level main model.
```

## Common pitfalls

- **Do not default to main.** The default is the most expensive answer. The
  skill exists to move work *off* main, not to confirm the obvious.
- **Do not route synthesis to cheap.** Synthesis requires judgement, cheap
  models hallucinate on it, and you will pay more on the retry.
- **Do not classify by token count of the sub-task input.** Classify by *what
  the sub-task is* (lookup vs synthesis). A 50,000-token doc summary is
  `medium`, not `cheap`, even though the input is large.
- **Do not pass `model_config_id` in a `task()` call on mcode 0.2.4.** The
  strict validator in `cli.js:B6c` rejects it; only `description` / `prompt` /
  `subagent_type` / `run_in_background` are allowed. Model selection is
  session-level on 0.2.4.
- **Do not retry a failed sub-task on the same tier without re-classifying.**
  A cheap-model failure on a synthesis-class task is a classification error;
  the fix is to re-classify up, not to rephrase the brief.
- **Do not hide the tier from the user.** The tier is part of the contract —
  they should be able to see "this is cheap because…" and disagree.

## Verification checklist

- [ ] Did you classify the sub-task into cheap / medium / main before spawning?
- [ ] Did you decide whether to spawn at all (the sub-agent gate)?
- [ ] Did you state the tier and the spawn reason in the brief?
- [ ] Did you avoid passing `model_config_id` in the `task()` call (not supported
      on mcode 0.2.4)?
- [ ] If the sub-task failed, did you re-classify (not just rephrase)?
- [ ] If you ran a fan-out, did you record "X cheap / Y medium / Z main" in the
      aggregation?
