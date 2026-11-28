---
name: skill-audit
description: Audit the skill library for count, spec compliance, name shadowing, and overlapping scope. Use when the user says "audit my skills", "are there too many skills", "are any of these duplicated", or "is this skill written correctly". Read-only diagnosis; never modify anything by itself.
---

# Skill Audit

Audit the skill library. **Read-only diagnosis — do not modify anything**; what to change is the user's call.

By default, look only at **this project's** `.minimax/skills/`; include the user-level skill directory
only when the user explicitly asks for it.

## Why this matters

The host injects the list of available skills (name plus a description summary) into every turn.
Once that list exceeds the context budget, the surplus skills are listed **by name only, without
their descriptions** — the model can no longer tell when to use them, and automatic triggering
collapses. There is no UI warning for that cliff; only an audit finds it.

## Checks

### 1. Inventory and count

Resolve the repository root and the project skill directory:

```bash
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
ls -la "$ROOT/.minimax/skills/" 2>/dev/null || echo "(this project has no .minimax/skills/)"
```

Report three counts separately:

- **real directories** — the ones that actually consume budget;
- **symbolic links** (`lrwxrwxrwx`) — point them at their source and check the target still resolves;
- the total.

### 1b. Name shadowing (only when both scopes are checked)

When the same name exists in the user-level skill directory and in the project's
`.minimax/skills/`, do not infer which one wins from a rule — read the current session's
`<available_skills>` block. It lists what is actually available and with which description.
Report every collision and let the user decide whether to rename the project copy or edit the
user-level one.

### 2. Spec compliance

| Field | Requirement | Consequence of a violation |
|---|---|---|
| `name` | required, and equal to the directory name | **the whole Skill can be dropped** |
| `description` | required, non-empty | missing → dropped |
| other fields | optional | silently ignored |

```bash
D="$ROOT/.minimax/skills"
for f in "$D"/*/SKILL.md; do
  [ -e "$f" ] || continue
  n=$(basename "$(dirname "$f")")
  d=$(grep -m1 '^description:' "$f" | wc -c)
  printf "%-30s desc=%s\n" "$n" "$d"
done
```

Also check the body length: a very large body is truncated on load.

### 3. Overlapping scope

⚠️ **Do not judge duplication by keyword counts.** A skill repeating a word only means that word
is its topic.

Judge it by reading the sections: the question is

> **Is the same fact, or the same command, actually written in both files?**

### 4. Description quality

Spot-check `description`: does it say **when to use** it? A description that only says what it is
gets ignored.

## Output format

```
## Count
N real + M links = X total

## Non-compliant (these Skills can be dropped silently)
| skill | problem | fix |

## Overlapping scope (confirmed by reading the text)
| skill A | skill B | what overlaps | suggestion |

## Description quality
| skill | current description | problem |

## Suggestions
(nothing is applied automatically)
```
