---
name: easyloop
description: Self-orchestrating loop Skill. When the user invokes easyloop, the LLM inspects the task, picks a loop pattern (explore/implement/test/debug/refactor/review/document/migrate/benchmark/security-audit/deps-update/release/chain), picks a quality level (prototype/release), and optionally enables extra plugins. The selection menu is then compacted out of context via the finish_plugin_selection MCP tool and stored under a context_compacted_id. The model proceeds with maximum parallelism via the Task tool.
license: Apache-2.0
compatibility: Requires easyloop plugin; benefits from the Task tool (`task`/`delegate`/`spawn_agent`) being available.
metadata:
  author: bro
  version: "0.1.0"
---

# EasyLoop — Self-Orchestrating Loop

When this Skill activates, you must:

1. **Call `get_menu`** first. It returns the live selection menu — every
   loop, quality level, AND every installed plugin (built-in + custom)
   with each plugin's one-line description from its `plugin.json`
   manifest. This is how you discover which custom plugins are
   available; this Skill body alone can't list them.
2. **Decide** which loops fit the task, which quality level, and which
   optional plugins to enable. Read each plugin's one-line description
   carefully — that's the only signal you have.
3. **Call `finish_plugin_selection`** with your choices as JSON. The
   tool persists your selection (including the chosen loops' AND
   plugins' descriptions) under a `context_compacted_id` and returns
   the short plan.
4. **Drop the menu text from your next turn's output.** Carry only the
   `context_compacted_id` and the returned plan. The original menu is
   re-injectable via `recall_selection("<id>")` if you need to look
   back.

## Loop catalog (static — always available)

| Loop | Description |
| --- | --- |
| `explore` | Read and understand unfamiliar code; return a compressed summary. |
| `implement` | Write new code from a spec or plan. |
| `test` | Run tests, interpret failures, fix them until green. |
| `debug` | Diagnose a known bug, isolate root cause, patch it. |
| `refactor` | Improve structure or clarity without changing behavior. |
| `review` | Read code or a diff and surface concrete defects. |
| `document` | Write or update docs, docstrings, READMEs, comments. |
| `migrate` | Port code between frameworks, languages, or major versions. |
| `benchmark` | Profile and optimize performance, memory, or bundle size. |
| `security-audit` | Check for known vulnerability classes and fix them. |
| `deps-update` | Upgrade dependencies safely with tests + lockfile. |
| `release` | Version bump, changelog, tag, publish artifacts. |
| `chain` | Combine multiple loops in sequence (recommended for non-trivial work). |

## Quality levels (static — always available)

| Quality | Iteration cap | Verify (tests/lint/type) | When to use |
| --- | --- | --- | --- |
| `prototype` | 5  | off | Spike / exploration; throwaway code |
| `release`   | 25 | on  | Production / ship-ready output |

## Optional plugins (DYNAMIC — call `get_menu` to see what's installed)

`get_menu` lists every plugin in the local marketplace with its
one-line description. The model picks which to enable for the current
task based on those descriptions. The two well-known ones from this
suite are auto-marked `(recommended)`:

- `mcode-computer-use` — GUI automation (screenshot, click, scroll, keyboard).
- `mcode-think-filter` — keeps transcripts lean.

Custom plugins (anything the user has dropped into the local marketplace)
are listed too, with their `description` field from `plugin.json`. If
you see a plugin whose description matches the task, you may select it.

## Call shape

```
finish_plugin_selection({
  loops:   ["explore", "implement", "test"],   // array of loop names
  quality: "release",                          // "prototype" or "release"
  plugins: ["mcode-think-filter"],            // optional; can be empty or include custom plugins
  notes:   "short human-readable plan"         // optional
})
```

The tool returns `{ context_compacted_id, replaced_chars, plan_text, selection }`.
`context_compacted_id` is the only thing you carry forward.

## After the call

- Run the chosen loops in sequence (use `chain` if multiple).
- Stay under `quality.iterationCap` turns.
- If `quality.verify` is true, run the project's tests + linter + type-check at
  the end of every implement/test/refactor cycle.
- For multi-file work, **spawn 3–5 background Task agents in parallel**
  per exploration round. Aggregate their results, then plan.
- If you need to look back at the menu, call
  `recall_selection("<context_compacted_id>")`.

## Parallelism

Use the Task tool (`task`/`delegate`/`spawn_agent`) with
`run_in_background: true` whenever sub-tasks are independent. Spawn
3–5 background scouts at a time for multi-file exploration, then
aggregate.

## Disclosure

- Persists `selections/<id>.json` and `iterations.jsonl` under
  `${PLUGIN_DATA}`.
- Network: zero.
- Native binaries: none.
