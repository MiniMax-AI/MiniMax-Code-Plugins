# easyloop

Self-orchestrating loop Skill for MiniMax Code. When the user invokes
**easyloop**, the model reads a fixed menu of loop patterns + quality
levels + optional plugins, picks what fits the task, and calls the
`finish_plugin_selection` MCP tool. The tool persists the selection
**along with each loop's one-line description** under a
`context_compacted_id`, then returns a short plan. From that point on,
the model carries only the id forward; the original menu can be
re-injected with `recall_selection("<id>")`.

Ships with three Skills: `easyloop`, `easyloop-prototype`,
`easyloop-release`.

## Install

```bash
cp -r easyloop ~/.mcode/plugins/local/
mcode plugin enable easyloop@local
```

## Loop catalog

13 loop patterns (12 standalone + 1 chain). Each ships with a one-line
description persisted alongside the selection:

| Loop | One-line description |
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

## Quality levels

| Quality | Iteration cap | Verify (tests/lint/type) | When to use |
| --- | --- | --- | --- |
| `prototype` | 5  | off | Spike / exploration; throwaway code |
| `release`   | 25 | on  | Production / ship-ready output |

## MCP tools

| Tool | Purpose |
| --- | --- |
| `finish_plugin_selection` | Persist selection, return `context_compacted_id` + plan. |
| `recall_selection` | Re-inject the original menu + saved plan for an id. |
| `log_iteration` | Append an iteration audit entry. |
| `list_selections` | List all selections saved in this session. |

## Sub-agent strategy

The Skill body instructs the model to:

- Use the `Task` tool (`task` / `delegate` / `spawn_agent`) with
  `run_in_background: true` for independent sub-tasks.
- Spawn 3–5 background scouts at a time for multi-file exploration.
- Aggregate results before the next iteration.
- For implementation, one background worker implements while the main
  thread prepares tests / lint.

## Copyable example prompt

> "easyloop: refactor `src/auth/` to use async/await end-to-end and ship."

The model will:
1. Read the menu.
2. Call `finish_plugin_selection({ loops: ["explore","refactor","test","review"], quality: "release", plugins: ["mcode-think-filter"], notes: "auth async/await" })`.
3. Carry only the id forward.
4. Spawn background scouts in parallel.
5. Iterate refactor + test cycles up to the 25-turn cap.
6. `recall_selection("<id>")` if it needs to look at the menu again.

## Tests

```bash
cd easyloop
node --test lib/*.test.mjs
```

Covers:
- Catalog has 12+ loops with descriptions.
- `renderMenu` covers every loop and quality.
- `validateSelection` rejects empty/unknown loops; accepts valid ones.
- `saveSelection` / `readSelection` round-trip with descriptions preserved.
- `readSelection` rejects malformed ids (path traversal guard).

## Disclosure

- Persists `selections/<id>.json` and `iterations.jsonl` under
  `${PLUGIN_DATA}`.
- Network: zero.
- Native binaries: none.
