---
name: project-guardrails
description: Manage this repository's guardrails.json (create, validate, or extend its rules). Use when the user says "add a rule to this repo", "forbid npm here", "show me the project guardrails", or asks to check whether a guardrails file is valid. The declaration lives in <repo>/.agents/guardrails.json.
---

# Project Guardrails

Manage the repository's `guardrails.json` — its project conventions, its tool rules, and its session-start index.

## Background (one sentence)

Project-level Hooks in MiniMax Code have to be switched on per repository in **Settings → Hooks → Project**,
and editing the declaration switches them off again, so "this repository brings its own constraints" is
expensive. This plugin is a **user-level** plugin (its Hooks dispatch directly) that reads the
repository's declaration file on its behalf — so the repository gets the last word again.

**Where the declaration lives (first match wins)**: `<repo>/.agents/guardrails.json` → `<repo>/.minimax/guardrails.json`.
`.agents/` is preferred because it is the cross-agent shared directory and therefore survives a clone;
`.minimax/` is the fallback. After writing it, check:
`git check-ignore -v .agents/guardrails.json` — **it must print nothing**.

## File format

```json
{
  "version": 1,
  "context": [
    "This project uses pnpm, not npm",
    "Commit messages are written in English, without a Co-Authored-By trailer"
  ],
  "rules": [
    {
      "tool": "bash",
      "pattern": "\\bnpm\\s+(install|i|add)\\b",
      "action": "deny",
      "reason": "This project uses pnpm; npm install writes a package-lock.json"
    },
    {
      "tool": "write",
      "pattern": "\\.env$",
      "action": "ask",
      "reason": "Confirm: do you really want to write .env?"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `context[]` | Plain-text conventions, injected at session start. **No tool restriction** — this is for the rules you would otherwise keep in `AGENTS.md` but want to manage per project. |
| `rules[].tool` | Tool name, case-insensitive. `*` or omitted = every tool; `bash\|write` is also accepted. |
| `rules[].pattern` | Regular expression. **Case-insensitive by default**; set `"ignoreCase": false` to turn that off. |
| `rules[].action` | `deny` (block) or `ask` (ask for confirmation). **Any other value is ignored.** |
| `rules[].reason` | The reason shown when the rule fires. Say *why*, or people will look for a way around it. |

The native tool names in MiniMax Code are **lowercase**: `bash`, `read`, `write`, `edit`, `task`.
`"Bash"` also matches (both sides are lower-cased before comparison), but write the native name.

The matched text: `bash` matches `command`; file-writing tools match `file_path` and the content
fields; when neither is available it falls back to the whole `tool_input` JSON. Matching is capped
at 20000 characters per call.

## `entrypoints[]` — the session-start index

This fills a different gap: Skills are tools you call on demand, so they do not load at session
start, and a new conversation that only says "continue" never sees the repository's todo ledger.
`entrypoints` pushes the ledger index and the document-size status into the session **deterministically**.

**This block is an optional override, not a requirement.** Without it the plugin uses its built-in
convention set: when the repository has a ledger carrier file, it injects the ledger section
("first level-2 heading" → "first dated heading") plus a one-line size summary. So it is **zero
configuration** by default. The carrier location comes from `ledger.path` in `<repo>/doc-budget.json`
(default `.agents/HANDOFF.md`) — **do not assume a fixed file name**; older repositories declare
their own. Write this block only to change `file` / `from` / `to`, to add more blocks, or to switch
it off.

```json
{
  "entrypoints": [
    { "id": "handoff-ledger", "label": "Todo ledger", "kind": "markdown-table",
      "file": ".agents/HANDOFF.md", "from": "## Todo ledger",
      "statuses": ["🔴", "🟡", "⏳"], "maxRows": 20, "maxChars": 1800 },
    { "id": "budget", "label": "Document size", "kind": "budget", "config": "doc-budget.json" }
  ]
}
```

Key points (details in the plugin README):

- **Read-only, an index and not a copy** — what gets injected is `（file:from-to lines）` plus a title
  summary; the body is always re-read with the file-reading tool.
- **Completed rows never appear** — a row whose text contains `~~` is dropped (the "unfinished
  projection" invariant). Rows whose status symbol is filtered out by `statuses` are dropped silently
  and do not count as "no status".
- **`from` ends at the next heading of the same or a higher level** — real ledgers hang their table
  under a `###` sub-group, and truncating at any heading would lose the table entirely.
- **`from` defaults to the first level-2 heading** (which is what the built-in set uses).
- **One source of truth for the thresholds** — the `budget` block reads `<repo>/doc-budget.json`, the
  same file the repository's size-gate script uses. Without that file, built-in defaults apply.
- **`entrypoints: []` (an empty array) explicitly switches it off** — different from omitting the
  field, which uses the built-in convention set.

## Steps

1. **Locate the repository root.** It has to be the root: the declaration is only read from
   `.agents/` or `.minimax/` **at the repository root** (the former wins).

   ```bash
   ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
   echo "root = $ROOT"
   for p in "$ROOT/.agents/guardrails.json" "$ROOT/.minimax/guardrails.json"; do
     [ -f "$p" ] && { echo "found: $p"; cat "$p"; }
   done
   [ -f "$ROOT/.agents/guardrails.json" ] || [ -f "$ROOT/.minimax/guardrails.json" ] || echo "(no guardrails.json yet)"
   ```

2. **Dispatch on the user's intent:**

   - **Create** — read the repository's existing sources of truth (`AGENTS.md`, `.agents/`, recent
     commits), propose 3–8 conventions that **will really be reused**, and write them into `context`
     with `rules` left as an empty array. Tell the user "rules is empty, nothing is blocked yet".
     **Do not write `entrypoints` by default** — without it the built-in convention set applies, so
     writing it means copying the defaults by hand. Only write it when the user explicitly wants a
     different carrier / `from` / `to`, or wants to switch it off. When changing it, give the
     `handoff-ledger` example and **confirm** the ledger heading (`from`) and the status symbols with
     the user; to switch it off, write `"entrypoints": []`.
   - **Validate** — validate only, change nothing: does the JSON parse, does every `pattern` compile
     as a regular expression, is every `action` legal. Report each entry; for a broken one, say
     **which entry and what is wrong**. **Do not fix it on the side.**
   - **Anything else (a natural-language description)** — translate it into a rule and append it to
     `rules` (or to `context`, if it is really a convention rather than a behaviour to block).
     Before writing, explain which regular expression you intend to use, what it will match and
     what it might catch by accident, and **get confirmation first**.

3. **Validate the file you just wrote**:
   `node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"))' <file>`

## Rules

- **Keep regular expressions narrow.** A rule that breaks the normal development flow is worse than
  no rule — people switch the plugin off.
- **Use `deny` sparingly**; `ask` fits most cases: leave the judgement to the person in front of it
  instead of hard-coding it in the configuration.
- **This is not a security boundary.** It prevents slips, not attacks. Anyone who deletes the file
  bypasses it. Do not rely on it for secrets or permissions.
- **Prefer `.agents/guardrails.json`** (committable, shared across agents); `.minimax/` is only the
  fallback. After writing, run `git check-ignore -v <path>` — **it must print nothing**, or the
  declaration is lost on the next machine.
- **Only change that one file** (creating the directory if needed). **Do not** touch `AGENTS.md` and
  **do not** touch source code.
- Every entry in `context` must be **a sentence that makes sense on its own** — it is injected into a
  session that has no other context.
