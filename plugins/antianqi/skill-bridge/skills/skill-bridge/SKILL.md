---
name: skill-bridge
description: |
  Convert an openclaw (or similar) skill folder into a mavis/mcode-compatible
  skill via the bundled stdio MCP server `skill-bridge`. Use when the user
  wants to migrate a skill from openclaw, reuse a skill from another
  framework, or port a hand-written skill that does not follow the mavis
  schema. Do NOT use to create a brand-new skill from scratch (use
  `skill-creator` instead), or to lint/refine an existing mavis skill
  (use `skill-refiner`).
descriptions:
  zh-Hans: |
    通过内置的 stdio MCP server `skill-bridge`，把 openclaw（或类似框架）
    的 skill 转换为 mavis/mcode 兼容的 skill。需要迁移/移植/复用 skill 时使用。
displayNames:
  zh-Hans: Skill 移植桥
metadata:
  openclaw_compat: true
  auto-invoke: ""
---

# skill-bridge

Bring a non-mavis skill into the mavis world. The skill itself is the **thin LLM-facing layer**; the heavy lifting lives in the stdio MCP server declared in `mcp.json` at the plugin root.

The MCP server exposes four tools, named after the original v0.1 CLI subcommands:

| Tool | Purpose |
| --- | --- |
| `detect(source)` | Identify UTF-8 vs GBK; restore mojibake if needed. |
| `analyze(source)` | Full report: frontmatter, body, hardcoded paths, external commands. |
| `classify(source)` | One of `pure` (translatable), `pure-wrapped-fix`, `wrapped-*`, or `abandon`. |
| `convert(source, target_dir, force?, run_lint?)` | Run the full pipeline; write to `target_dir`. Lint runs unless `run_lint=false`. |

`source` accepts either an absolute path to a `SKILL.md` file or to a directory containing one. `target_dir` is an absolute path that will be created or replaced atomically.

## When to use this skill

- The user has an `openclaw` workspace (or any non-mavis skill bundle) and wants to use those skills inside mavis.
- The user found a skill on GitHub written in a different agent framework and wants to reuse it.
- The user wrote a `SKILL.md` themselves years ago and wants to bring it up to mavis's current schema.

Do **not** use this skill for:

- Creating a new skill from scratch → `skill-creator`
- Fixing or refining an existing mavis skill → `skill-refiner`
- Listing what skills are available → read `<available_skills>` from the system prompt

## Inputs to collect

- **Source path**: an absolute path to either a `SKILL.md` file or to a folder containing one. If the user gave a relative path, resolve it against the user's cwd before calling the tool.
- **Output path**: an absolute path for the converted skill. Default: a folder whose basename matches the kebab-case name. If the user names a scope:
  - user → `<homedir>/.minimax/skills/<name>/`
  - agent → `<homedir>/.minimax/agents/mavis/skills/<name>/`
  - project → `<repo>/.minimax/skills/<name>/`
- **Force overwrite (optional)**: only confirm with the user if the target already exists. The server is safe to re-run; `force` is informational.

## Procedure

1. **Detect** the source. Call `detect(source)` and inspect `encoding`.
   - If `encoding === "unknown"`, warn the user before continuing.
   - If `encoding === "gbk"` and `replaced === true`, tell the user the source was GBK and we restored it.
2. **Analyze** the full report. Call `analyze(source)` and check `hardcodedPaths` and `externalCommands`.
   - Non-empty `externalCommands` → the skill is likely `wrapped-*` (v0.2 only emits `pure`; stop and tell the user).
3. **Classify**. Call `classify(source)`. In v0.2, proceed only if `tier === "pure"`.
4. **Convert**. Call `convert(source, target_dir)`.
   - If the tool returns `ok: false` with `tier: "abandon"` or `tier: "wrapped"`, stop and explain why.
   - If `ok: true`, read `target_dir/conversion-report.md` and surface the `warnings` array to the user verbatim.
   - Skim `target_dir/SKILL.md`. If anything looks wrong (missing section, garbled encoding, broken path), tell the user **before** claiming success.
5. **Lint feedback**. The `convert` response already includes the `lint` object (`ok`, `code`, `stdout`, `stderr`). If `ok === false`, surface the lint output and do not claim the conversion is done.
6. **Tell the user** what was written, what to review, and how to use the new skill. Suggest `skill({name: "<converted-name>"})` to verify it loads.

## Output contract

- A directory at `target_dir` containing at minimum:
  - `SKILL.md` — mavis-schema-compliant
  - `conversion-report.md` — what was changed
  - optionally `references/<topic>.md` if the body was split

The server replaces `target_dir` atomically: at every observable point in time the directory is either the OLD content or the NEW content, never empty or half-written. Re-running with the same `target_dir` is always safe.

## Failure handling

- `tier: abandon` from `classify` → do not write; explain the reason to the user.
- `tier: wrapped` in v0.2 → tell the user the server only supports `pure` right now; v0.3 will add `wrapped`.
- `lint.ok === false` → do not claim success; show the `lint.stdout` and `lint.stderr` verbatim.
- `encoding === "unknown"` → ask the user to confirm the source is genuinely UTF-8 before writing.
- Target already exists → atomic replace happens by default; only ask the user if you want to confirm before overwriting.

## Examples

**Input**: `/path/to/openclaw/skills/task-tracker`

**Good path**:
1. `detect(...)` → `utf-8`, no replacement.
2. `classify(...)` → `pure / pure-wrapped-fix` (one hardcoded path group).
3. `convert(source, target_dir)` → `ok: true`, two warnings about path parameterization.
4. Confirm `lint.ok === true`, surface the two warnings to the user.

**Bad path**: copy the `SKILL.md` to `<homedir>/.minimax/agents/mavis/skills/<name>/` directly. The user's previous attempt at this failed because (a) the path is not in the mavis scan list and (b) GBK content was not detected.

## Additional resources

- `references/compatibility-matrix.md` — known openclaw skills and their tier
- `references/path-patterns.md` — the hardcoded path patterns we replace
- The MCP server itself: see `mcp.json` + `server.mjs` in the plugin root
- The plan that produced this skill: see the plugin's `README.md`
