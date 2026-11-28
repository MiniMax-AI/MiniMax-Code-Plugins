---
name: memory-loop
description: Distill collected memory candidates into the project's long-term MEMORY.md. Use when the user says "distill the memory", "turn the candidates into memory", "this is worth remembering", or when a session starts with a [memory-loop] notice that candidates are pending.
---

# Memory Loop

Turn the memory candidates collected during the session into the project's long-term memory, `MEMORY.md`.

## Why this step exists

A candidate file holds **raw reply fragments**, not memory: the Stop hook only applies a mechanical
test (a file-change or decision signal plus a concrete path) and stores the first 400 characters of
the reply. Injecting that verbatim is long and noisy.
**Semantic distillation is the one step a script cannot do and a model must** — this Skill is it.

## Where the paths come from (important: never guess them)

Both the memory directory and the plugin root are published in the **`[memory-loop]` block injected at
session start**. It contains three lines:

```
[memory-loop] Project long-term memory (<memoryDir>/MEMORY.md): ...
[memory-loop] N candidate(s) waiting to be distilled (M in total, <memoryDir>/candidates.jsonl).
[memory-loop] Plugin root (the distillation Skill calls the CLI from here): <plugin root>
```

**Take both absolute paths from that block** (plugin root → where the CLI lives, `memoryDir` → where
the memory lives). Do not assume a location and do not assemble one: a repository may relocate the
memory directory through `memory.dir` in `guardrails.json`, and the hook resolves it the same way.

With the block at hand, the only source of truth for the path is the hook module — always call it:

```bash
ML="<plugin root>/hooks/lib/project.mjs"
node "$ML" status                        # → JSON: {root, memoryDir, candidates, distilled, pending}
```

`memoryDir` is absolute; use its output for every read and write instead of a relative path (a
relative path misses when the Skill is triggered from a subdirectory). If the output contains an
`error` field the call failed — **stop and report it, do not fall back to a guessed path**.

**No injected block** (the project has no memory yet) → there is nothing to distill. If the user
still asks for a cleanup, work in the default project location `<repo>/.agents/memory/` and say
that a `memory.dir` override cannot be confirmed in that case; the cursor `state.json` must then be
written by hand as `{"distilled": <line count of candidates.jsonl>}`.

## Steps

1. **Get the path and the current state.**

   ```bash
   node "$ML" status
   ```

   Note `memoryDir` (call it `$MEM` below) and read the current memory:

   ```bash
   cat "$MEM/MEMORY.md" 2>/dev/null || echo "(none)"
   ```

2. **The user only wants the status** → report the candidate count, the current memory and the
   distillation progress (`pending`), and stop there.

3. **Read the candidates and judge each one.** Keep a candidate when it satisfies any of:
   - a convention or decision that **will be reused**;
   - a **non-obvious** pitfall that was hit and worked around (record the cause, not just the symptom);
   - an established fact about an external system (path, port, account, command).

   Drop: process narration, one-off task descriptions, closing summaries, and anything `git log`
   already records.

4. **Write `$MEM/MEMORY.md`.** Rules:
   - **Group by topic, not by time** — chronological order helps nobody retrieve anything.
   - One short line per entry, scannable.
   - Duplicate of an existing entry → **merge** it in; obsolete entry → **delete** it.
   - Keep the whole file under ~200 lines. When it is too long, cut the emptiest entries, not the oldest.
   - Keep `<!-- memory-loop -->` as the first line so the file is recognisable and countable.

5. **Advance the distillation cursor** (so SessionStart stops repeating the notice) — again through
   the hook module:

   ```bash
   node "$ML" commit                      # cursor = current candidate line count; prints the same JSON
   ```

6. **Report**: how many candidates were read, how many kept, how many dropped, and the new line
   count of `MEMORY.md`.

## Rules

- **Do not move the candidates into `MEMORY.md` wholesale** — that is a transcript, not a distillation,
  and it only makes the context more expensive.
- **Unsure whether a candidate is worth keeping** → ask; do not keep it by default.
- **Only touch files under `memoryDir`.** Do not modify `AGENTS.md` and do not modify source code.
- **Trust only the output of `node "$ML" status`.** This document, the README and your own memory of
  the layout can all be stale; when the hook and the Skill read different directories the
  distillation fails **silently** (the hook writes candidates nobody reads, and neither side errors).
- If many candidates cover the same topic (the same thing explained five times) → merge them into
  one entry and say so in the report.
