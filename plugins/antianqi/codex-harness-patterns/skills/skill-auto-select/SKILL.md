---
name: skill-auto-select
description: |
  Design a Skill (or Plugin) that an LLM agent can reliably discover, select, and invoke based on its description, with explicit selection syntax, name-collision handling, and three-layer matching.
  USE WHEN: authoring a new skill for a Plugin, designing skill frontmatter, deciding between structured `UserInput::Skill` vs implicit `$skill-name` mention, handling duplicate skill names, picking between path-precise and name-based matching, or any task involving "make my skill actually get picked up by the agent".
  TRIGGER PHRASES: "skill selection", "skill auto-pick", "$skill-name mention", "skill description", "skill metadata", "SkillMetadata", "ExplicitSkillLookup", "three-layer matching", "name collision", "ambiguous skill name".
  SKIP WHEN: writing a one-shot script (use `error-recovery-strategy` or similar task skill), skill is human-only (no agent invocation), skill is bundled and not selectable.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.0"
  inspired-by: https://github.com/openai/codex/tree/main/codex-rs/skills/ (P-85/86/87/88/89/92)
  changes-from-v0.0.0: "Initial design distilled from P-85/86/87/88/89/92 deep-dive (Phase 1 Week 2)."
---

# Skill Auto-Select

Design a Skill (or a whole Plugin) so an LLM agent can reliably discover it, decide
it is the right one, and invoke it. Mirrors the design of Codex's `codex-rs/skills/`
runtime, which is what this very Plugin is mimicking.

## When to use

Activate when designing:

- A new skill's frontmatter (`name`, `description`, `short_description`, `interface`, `dependencies`, `policy`).
- A skill marketplace or registry where multiple skills may collide on name.
- A path-based discovery surface (logical discovery path vs canonical path).
- An explicit-vs-implicit invocation model (structured input vs `$name` mention vs shell command invocation).

## When NOT to use

- Skills that are bundled, not selectable (e.g. always-on system skills). Use a different distribution model.
- One-shot scripts that should never be auto-selected. Use task skills (`error-recovery-strategy`, `plan-stream-emit`).

## Process

### 1. Write the 11-field SkillMetadata

Every skill should expose at minimum these fields:

| Field | Type | Purpose |
|---|---|---|
| `name` | `String` (≤ 64 chars) | Canonical name, used in mentions and uniqueness checks. |
| `description` | `String` (≤ 128 chars) | One-line purpose, used by LLM to decide "is this for me?". |
| `short_description` | `Option<String>` | UI label, used in lists. |
| `interface` | `Option<SkillInterface>` | UI metadata (`display_name`, `icon`, `brand_color`, `default_prompt`). |
| `dependencies` | `Option<SkillDependencies>` | Declared external tools (MCP / function / etc). |
| `policy` | `Option<SkillPolicy>` | `allow_implicit_invocation` (default `true`), `products`. |
| `path_to_skills_md` | `AbsolutePathBuf` | Host-side canonical path. |
| `scope` | `SkillScope` | Source: `User` / `System` / `Plugin` / etc. |
| `plugin_id` | `Option<String>` | If from a marketplace plugin. |
| `remote_plugin_id` | `Option<String>` | If remote. |
| (system) | `enabled` | Computed from `disabled_paths`. |

In your frontmatter, the **only fields that matter for LLM matching** are `name` and
`description`. The other fields matter for the runtime.

### 2. Write a keyword-greppable description (v0.6.1 format)

```yaml
description: |
  <one-sentence purpose>.
  USE WHEN: <comma-separated concrete signals and keywords>.
  TRIGGER PHRASES: <user-original-language phrases the user might say>.
  SKIP WHEN: <anti-patterns where this skill does not apply>.
```

Why:

- The LLM matches on real signals (`ECONNREFUSED`, `permission denied`, `retries exceeded`, "上下文满了" / "出错了" / "重试"), not abstract prose.
- `USE WHEN` and `TRIGGER PHRASES` are greppable substrings; `SKIP WHEN` reduces false positives.
- Bilingual (English + Chinese) descriptions match user language directly.

### 3. Adopt three-layer matching

When a user types `$skill-name` or `[$skill-name](path)`:

```text
Layer 1 — canonical path:    /path/to/skills/SKILL.md
Layer 2 — discovery path:    skill://skill-name/SKILL.md  (logical)
Layer 3 — plain name:         skill-name                   (only if unambiguous)
```

Rules:

- Layer 1 wins if path matches canonical.
- Layer 2 wins if path matches discovery path AND Layer 1 missed.
- Layer 3 wins ONLY if `skill_count == 1 && connector_count == 0` (uniqueness check via `name_counts`).
- If a structured `UserInput::Skill` already matched some name, **block** that name from Layer 3 (`blocked_plain_names`).

Complexity target: `O(T + (N_s + N_t) * S)` time, `O(S + M)` space (T = text length, S = skill count, M = mentions per input). With ~20 skills and 1KB text, this is sub-millisecond.

### 4. Provide explicit invocation syntax

Two syntaxes, both supported:

```text
$skill-name                                  # plain
[$skill-name](skill://path/SKILL.md)         # linked
```

Exclude environment variables from being mistaken for skills (`is_common_env_var($HOME)` → true, skip). Support the 5 tool mention kinds with 4 path prefixes:

```text
app://app-id/...
mcp://server/tool
plugin://plugin-id/...
skill://skill-name/...
SKILL.md (literal filename)
```

### 5. Detect implicit invocation in shell commands

Before doing the explicit three-layer match, also detect when a shell command references a skill script or document:

```rust
detect_implicit_skill_invocation_for_command(outcome, command, workdir)
```

- Tokenize (Windows: PowerShell; Unix: shlex).
- Look for `python` / `node` / `bash` / `sh` / `pwsh` invocations.
- Look for `Read` operations on `scripts/` or `references/`.
- Match by path (scripts dir → skill) and by doc (read path → skill).

### 6. Cache the loaded snapshot

Use a `SkillRootSnapshotCache<Root>` trait so the loader can re-use a parsed snapshot:

```rust
pub trait SkillRootSnapshotCache<Root>: Send + Sync {
    fn get(&self, root: &Root) -> Option<LoadedSkillRoot>;
    fn insert(&self, root: Root, snapshot: LoadedSkillRoot);
}
```

`SkillRootSnapshots` is `Arc<dyn SkillRootSnapshotCache<Root>>` with identity-based
`Hash` / `Eq` (uses `Arc::ptr_eq`). Cache key safety: clones share the same `Arc`,
so identity equality holds.

### 7. Load with errors-as-data

`LoadedSkillRoot { skills, errors: Vec<SkillError>, ... }` — never let one bad skill
kill the whole root. Collect errors and surface them at the top.

## Output contract

A skill that follows this design:

- Has a 64-char-max `name` and a greppable 128-char-max `description`.
- Supports both `$name` plain and `[$name](path)` linked mention.
- Three-layer matching with uniqueness check on plain name.
- Implicit invocation detection in shell commands.
- Cached snapshot with identity-based hashing.
- Errors collected per-skill, never aborting the whole root.

## Common pitfalls

- **Plain name on a duplicate** → ambiguous; ignored. Always provide a path or qualify with the structured form.
- **Description too abstract** → LLM cannot match. Use the 4-line `USE WHEN / TRIGGER PHRASES / SKIP WHEN` format with concrete keywords.
- **Bypassing the uniqueness check** → two skills fire from one mention. Always require `skill_count == 1`.
- **Forgetting `is_common_env_var`** → `$HOME` / `$PATH` become "skill mentions". Filter them.
- **Loading all skills on every mention** → slow. Use `SkillRootSnapshotCache`.
- **Frontmatter name > 64 chars** → rejected by parser. Count your characters.
- **Skills with `description: ""` → MissingField error**. Description is mandatory.

## Example — minimal frontmatter

```yaml
---
name: my-skill
description: |
  Detect a specific failure mode in the running session and recover.
  USE WHEN: ECONNREFUSED, permission denied, retries exceeded, "can't connect" / "出错了" / "重试" / "权限".
  TRIGGER PHRASES: "recover", "retry failed", "switch tool", "ask me", "出错了", "重试".
  SKIP WHEN: short task, in middle of dictating.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: you
  version: "0.1.0"
---

# My Skill

... the actual instructions ...
```

## Verification checklist

- [ ] Frontmatter has `name` (≤ 64) and `description` (≤ 128, ≥ 1, non-empty after `sanitize_single_line`).
- [ ] Description uses the 4-line `USE WHEN / TRIGGER PHRASES / SKIP WHEN` format.
- [ ] Description is bilingual if your users write in multiple languages.
- [ ] Three-layer matching is implemented: canonical path → discovery path → unique plain name.
- [ ] `name_counts` is built once per selection and consulted for uniqueness.
- [ ] `is_common_env_var` filters out `$HOME` / `$PATH` etc.
- [ ] Implicit invocation detection tokenizes per-platform (PowerShell vs shlex).
- [ ] Snapshot cache is identity-based (`Arc::ptr_eq`).
- [ ] Load errors are collected per-skill, never abort the root.
