---
name: skill-forge
description: Distill the current conversation into a reusable project-level skill. Use when the user says "save this as a skill", "remember this for next time", or when a task ended with 5+ exploratory steps, a non-obvious pitfall that was worked around, or a convention that will be reused.
---

# Skill Forge

Turn the pitfalls, conventions, and multi-step procedures worked out in this conversation into one reusable skill.

## Steps

1. **Decide whether it is worth it.** Continue only if at least one of these holds; otherwise say "nothing to distill here" and stop:
   - it took 5+ steps with trial and error,
   - a non-obvious pitfall was hit and worked around,
   - a convention or decision was made that will be reused.

2. **Find the boundary.** List the existing skills first:

   ```bash
   ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
   ls "$ROOT/.minimax/skills/" 2>/dev/null || echo "(this project has no skill directory yet)"
   ```

   ⚠️ Resolve the **repository root** before listing — a relative `.minimax/skills/` path
   silently misses when the Skill is triggered from a subdirectory, and the agent then
   concludes "this project has no skills" and creates a duplicate.
   If an existing skill already covers the topic → **extend that one, do not create a new one**.
   The skill list has a budget; duplicates dilute automatic triggering.

   ⚠️ The target is **this project's** `.minimax/skills/`, not the user-level skill directory.
   User-level skills are visible to every project; project-specific knowledge written there
   leaks into all of them.

   ⚠️ Do not guess which same-named skill wins. Read the `<available_skills>` block of the
   current session: it lists what is actually available, with its description.

3. **Name it.** kebab-case, and the name must say at a glance what it is for. Propose one and
   say why.

4. **Write the file** `.minimax/skills/<name>/SKILL.md` (repository root, so it goes into git):

   ```yaml
   ---
   name: <kebab-case>
   description: <say WHEN to use it, not what it is. Put the trigger conditions first.>
   ---
   ```

   Body requirements:
   - **Write the commands out in full** — never "run the appropriate command".
   - **State the criteria** — what counts as correct, what counts as wrong.
   - **Give pitfalls their own section**: symptom → cause → fix.
   - Do not open with "this skill is for …"; start with the content.
   - Keep it under 200 lines; longer means it should be split.

5. **Check the spec.** `name` must equal the directory name and `description` must be present —
   either one missing can cause the whole Skill to be dropped silently. `name` is kebab-case and
   matches the directory.

6. **Report.** One line: the path and what scenario it covers. Do not ask "anything else?".

## Anti-patterns

- ❌ Turning a one-off operation into a skill.
- ❌ Turning project facts into a skill ("this repo uses pnpm", "the test command is X") —
  those belong in memory, not in a skill.
- ❌ Pasting documentation as the body — without the pitfall you actually hit, it has no value.
- ❌ Writing filler to hit a quota — every skill costs budget in the per-turn skill list.
