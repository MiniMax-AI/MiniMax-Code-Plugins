---
name: model-router
description: |
  Classify sub-task complexity (cheap / medium / main) and pick matching `model_config_id`.
  USE WHEN: about to call `task()` for non-trivial sub-task, about to spend main model on work cheap model could do, "do this with the cheap model" / "用便宜模型" / "不要用主模型" / "sub-task 不重" / "small task", sub-task is routine lookup / reformat / list / reformat-only, "this is just a grep" / "this is just a reformat" / "小任务".
  TRIGGER PHRASES: "用便宜模型", "cheap model", "use the cheap model", "小任务用便宜模型", "不要用主模型", "用本地模型", "sub-task 不重", "小任务", "this is just a", "小 case 用便宜".
  SKIP WHEN: sub-task IS the main task (no delegation), sub-agent tool does not support `model_config_id`, sub-task is genuinely synthesis / design / cross-file reasoning.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.1"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/ and codex-rs/models-manager/
---

# Model Router

The main model is expensive and slow. Most sub-tasks a long agent spawns are not
"main-model expensive" — they are lookups, transforms, summaries, or pattern matches. The
Codex harness routes those to cheaper models and reserves the main model for synthesis and
hard reasoning.

This Skill codifies that routing: before every `task` call, classify the sub-task and pick
the right `model_config_id`. The savings are not theoretical — the same model router that
gave Codex a 6× token reduction on context compaction works the same way on delegation.

## When to use

Activate when **any** of these is true:

- You are about to call `task` and the sub-task is non-trivial.
- You are about to spend the main model on a work step that has clearly bounded
  complexity (a lookup, a transform, a reformat, a coverage report).
- A sub-task failed and you are about to retry; consider whether a stronger model would
  help, or whether the brief was just bad.
- A batch of N similar sub-tasks is about to run; one model call to classify them
  first, then route each.

## When NOT to use

- The sub-task *is* the main task (no delegation happening). You are already on the
  right model.
- The sub-task requires the same context the main thread has, and you cannot pass a
  minimal-context brief. A cheap model with no context will fail — route to main.
- The user explicitly said "use the main model for this" or "don't downgrade the
  model".

## Process

1. **Classify the sub-task** into one of three tiers, before writing the brief:

   | Tier | When to use | Examples |
   |---|---|---|
   | **`cheap`** | Bounded, single-shot, the brief fully specifies success. No synthesis, no judgement. | reformat a file, list files matching a glob, count lines, parse a JSON, run a deterministic script, copy a file with substitutions |
   | **`medium`** | Multi-step but well-scoped, the brief is the only context needed. Some judgement, no synthesis of new ideas. | summarise a long doc, refactor a single function, write tests for a known spec, review a single PR |
   | **`main`** | Requires synthesis, judgement across multiple sources, or stakes that make cheap-model mistakes costly. | design an API, evaluate tradeoffs, debug a multi-file interaction, write code that needs to satisfy a spec the agent has to interpret |

   If unsure, classify up — `main` is the safe default.

2. **Pick the `model_config_id`** for the tier:

   - `cheap` → the cheapest model the harness exposes (often a haiku-class or local model).
   - `medium` → the same model family as `main` but at the lowest reasoning effort, or a
     mid-tier model.
   - `main` → the user's main model at its default reasoning effort.

   The exact names depend on the harness; the principle is: cheapest that can succeed.

3. **Pass the model config explicitly** in the `task` call. Do not rely on default
   routing — the default is the main model, which is the wrong answer for `cheap` and
   `medium` tiers.

4. **State the tier in the sub-task brief** so a human reviewer can see why you picked
   that model:

   ```markdown
   ## Sub-task brief
   ...

   **Model tier**: cheap   (reformat-only, no judgement needed)
   ```

5. **If the sub-task returns a "I can't do this"** (cheap model could not satisfy the
   brief), do not silently retry on the same tier. Re-classify up, and explain to the
   user *why* the sub-task was harder than the tier suggested.

6. **Record the actual spend** if the harness surfaces per-call token counts. After a
   fan-out, note in the aggregation how much of the total was `cheap` vs `medium` vs
   `main`. This is how you learn the right tier for each sub-task shape.

## Output contract

The user sees, in this order:

- For every `task` call: the tier and the chosen `model_config_id` (one line each).
- For the fan-out aggregation: a one-line "X cheap / Y medium / Z main" summary.
- For upgrades (cheap → medium → main on a retry): a one-line reason.

## Example

```text
[planning] 1 cheap call: list all *.rs files in /repo/src/auth/ that import `tokio::sync::Mutex`.
            — tier: cheap (deterministic glob + grep, no judgement)
            — model_config_id: anthropic-haiku-3

[execution] 1 medium call: refactor auth/callback.rs to extract the SAML response parser.
            — tier: medium (multi-step refactor, brief is the spec)
            — model_config_id: anthropic-sonnet-4 with reasoning_effort=low

[execution] 1 main call: design the OidcProvider trait given the existing IdP interface
            and the OIDC spec. Resolve the "extend IdP vs new sibling" question.
            — tier: main (synthesis + cross-source judgement)
            — model_config_id: anthropic-sonnet-4 with reasoning_effort=high

[aggregation] spend summary: 1 cheap / 1 medium / 1 main. 78% of the work was on the
            main call; the other two ran in <2s.
```

## Common pitfalls

- **Do not default to main.** The default is the most expensive answer. The skill exists
  to move work *off* main, not to confirm the obvious.
- **Do not route synthesis to cheap.** Synthesis requires judgement, cheap models
  hallucinate on it, and you will pay more on the retry. If in doubt, tier up.
- **Do not classify by token count of the sub-task input.** Classify by *what the
  sub-task is* (lookup vs synthesis). A 50,000-token doc summary is `medium`, not
  `cheap`, even though the input is large.
- **Do not skip the explicit `model_config_id`.** The default in most harnesses is
  the main model. If you do not pass a config, you have routed to `main`.
- **Do not retry a failed sub-task on the same tier without re-classifying.** A cheap
  model failure on a synthesis-class task is a classification error; the fix is to
  move up a tier, not to rephrase the brief.
- **Do not hide the tier from the user.** The tier is part of the contract — they
  should be able to see "this is cheap because…" and disagree.

## Verification checklist

- [ ] Did you classify the sub-task into cheap / medium / main before writing the brief?
- [ ] Did you pass the `model_config_id` explicitly in the `task` call?
- [ ] Did you state the tier in the sub-task brief?
- [ ] If the sub-task failed, did you re-classify (not just rephrase)?
- [ ] If you ran a fan-out, did you record "X cheap / Y medium / Z main" in the
      aggregation?
- [ ] Did the cheap-model portion actually run on the cheap model (not silently
      re-routed to main)?
- [ ] Did the savings justify the routing decision (i.e. was the work appropriate for
      the tier you picked)?
