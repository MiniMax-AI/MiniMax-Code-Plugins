---
name: skill-bridge
description: |
  Convert an openclaw (or similar) skill folder into a mavis/mcode-compatible
  skill via the bundled `mcode-skill-bridge` CLI. Use when the user wants to
  migrate a skill from openclaw, reuse a skill from another framework, or
  port a hand-written skill that doesn't follow the mavis schema. Do NOT use
  to create a brand-new skill from scratch (use `skill-creator` instead),
  or to lint/refine an existing mavis skill (use `skill-refiner`).
descriptions:
  zh-Hans: |
    通过内置的 `mcode-skill-bridge` CLI，把 openclaw（或类似框架）的 skill
    转换为 mavis/mcode 兼容的 skill。需要迁移/移植/复用 skill 时使用。
displayNames:
  zh-Hans: Skill 移植桥
metadata:
  openclaw_compat: true
  auto-invoke: ""
---

# skill-bridge

Bring a non-mavis skill into the mavis world. The skill itself is the **thin LLM-facing layer**; the heavy lifting lives in the CLI `mcode-skill-bridge` (also shipped in this plugin).

## When to use this skill

- The user has an `openclaw` workspace (or any non-mavis skill bundle) and wants to use those skills inside mavis.
- The user found a skill on GitHub written in a different agent framework and wants to reuse it.
- The user wrote a SKILL.md themselves years ago and wants to bring it up to mavis's current schema.

Do **not** use this skill for:

- Creating a new skill from scratch → `skill-creator`
- Fixing or refining an existing mavis skill → `skill-refiner`
- Listing what skills are available → just read `<available_skills>` from the system prompt

## Inputs to collect

- **Source path**: an absolute path to either a skill folder (containing `SKILL.md`) or directly to a `SKILL.md` file. If the user gave a relative path, resolve it.
- **Output path (optional)**: where to write the converted skill. Default: `./out/<name>` next to the CLI invocation cwd. If the user names a scope (user/agent/project), use:
  - user → `~/.minimax/skills/<name>/`
  - agent → `~/.minimax/agents/mavis/skills/<name>/`
  - project → `<repo>/.minimax/skills/<name>/`
- **Force overwrite (optional)**: only if the target already exists and the user confirmed.

## Procedure

1. **Detect** the source.
   - Run `mcode-skill-bridge detect <source>`.
   - If encoding is `unknown`, warn the user before continuing.
   - If encoding is `gbk` and was converted, mention that the original was GBK and we restored it.

2. **Analyze** for the full report.
   - Run `mcode-skill-bridge analyze <source>`.
   - Check `hardcoded paths` and `external commands` counts.
   - If `external commands` is non-empty, the skill is likely `wrapped-*` (v0.1 only emits `pure`; tell the user and stop).

3. **Classify**.
   - Run `mcode-skill-bridge classify <source>`.
   - Note `tier` and `subTier`. In v0.1, proceed only if `tier == "pure"`.

4. **Convert**.
   - Run `mcode-skill-bridge convert <source> --out <target>`.
   - If the target exists and the user didn't say `--force`, stop and ask.
   - After the CLI writes files, read `<out>/conversion-report.md` and surface the warnings to the user.
   - Read `<out>/SKILL.md` and skim it. If anything looks wrong (missing section, garbled encoding, broken path), tell the user **before** claiming success.

5. **Lint** (optional but recommended).
   - The CLI runs lint by default. If `--no-lint` was passed, run it manually:
     `mcode-skill-bridge lint <target>`.
   - Lint `WARN` is OK; `FAIL` means do not claim the conversion is done.

6. **Tell the user** what was written, what to review, and how to use the new skill. Suggest `skill({name: "<converted-name>"})` to verify it loads.

## Output contract

- A directory at the chosen target path containing at minimum:
  - `SKILL.md` — mavis-schema-compliant
  - `conversion-report.md` — what was changed
  - optionally `references/<topic>.md` if the body was split

## Failure handling

- `tier: abandon` from classify → do not write; explain the reason to the user.
- `tier: wrapped` in v0.1 → tell the user the CLI only supports `pure` right now; point to plan §6 (v0.2 will add `wrapped`).
- Lint FAIL → do not claim success; show the lint output verbatim.
- Encoding `unknown` → ask the user to confirm the source is genuinely UTF-8 before writing.
- Target already exists without `--force` → stop, ask the user.

## Examples

**Input**: `/path/to/openclaw/skills/task-tracker`

**Good path**:
1. `mcode-skill-bridge detect /path/to/openclaw/skills/task-tracker` → utf-8, no replacement
2. `mcode-skill-bridge classify ...` → `pure / pure-wrapped-fix` (one hardcoded path group)
3. `mcode-skill-bridge convert /path/to/openclaw/skills/task-tracker --out ~/.minimax/agents/mavis/skills/task-tracker`
4. Confirm lint passed, surface 2 warnings about path parameterization.

**Bad path**: copy the SKILL.md to `~/.minimax/agents/mavis/skills/<name>/` directly. The user's previous attempt at this failed because (a) the path is not in the scan list and (b) GBK content was not detected.

## Additional resources

- `references/compatibility-matrix.md` — known openclaw skills and their tier
- `references/path-patterns.md` — the hardcoded path patterns we replace
- The CLI itself: `mcode-skill-bridge --help`
- The plan that produced this skill: see the GitHub repo's `docs/PLAN.md` (v0.1 ships with the plan inline in `README.md`).
