# Project Guardrails

Let a **repository** declare its own rules — conventions, tool restrictions, and a session-start index — and have them enforced by a user-level plugin instead of by per-repository Hook configuration.

The gap this fills: project-level Hooks have to be switched on per repository, and editing them switches them off again. So "this repository brings its own constraints" is expensive to maintain, `AGENTS.md` can only hold static prose, and a new conversation that only says "continue" never sees the repository's todo ledger. Project Guardrails reads the repository's declaration for you and injects it deterministically.

Version **1.0.0** · MIT · one Skill plus three Hooks. Fully local: no network, no accounts, no data leaving the machine.

## Try it

Install and enable the plugin, then open a new conversation in your project:

> This repo uses pnpm — forbid `npm install` here, and tell the agent to use pnpm add instead.

Expected result: a rule is added to `<repo>/.agents/guardrails.json`, and the next `npm install` in that repository is blocked with the reason you wrote.

At the start of a session in a repository that has a ledger carrier:

> What is still open in this project?

Expected result: the answer starts with an injected `[entrypoints]` block that lists the unfinished rows and the document-size status, so the agent does not have to go looking for the ledger.

## What it installs

```text
plugins/benntqoo/project-guardrails/
├── plugin.json                       # portable Agent Plugins 1.0 manifest
├── .claude-plugin/plugin.json        # mcode 0.4.0+ manifest, inline Hooks
├── io.minimax.mcode/
│   ├── hooks/
│   │   ├── hooks.json                # Hook document for the 0.3.x layout
│   │   ├── scripts/                  # Hook entry scripts (Node.js)
│   │   └── lib/                      # shared Hook I/O, rule matching, ledger parsing
└── skills/
    └── project-guardrails/SKILL.md   # create, validate, and extend guardrails.json
```

### Three Hooks, three jobs

| Hook | Event | What it does |
|---|---|---|
| `session-rules.mjs` | `SessionStart` | Injects `context[]` — the repository's conventions. |
| `session-entrypoints.mjs` | `SessionStart` | Injects `entrypoints[]` — the todo-ledger index and the document-size status. |
| `pretooluse-guard.mjs` | `PreToolUse` | Applies `rules[]` as `deny` / `ask` before a tool runs. |

The two `SessionStart` entries are deliberately separate: each has its own failure domain, and
context injection is additive, so one failing never hides the other.

### Zero configuration

**Installed + a repository that has a ledger carrier (default `.agents/HANDOFF.md`) = the ledger
index and the size summary are injected automatically.** No configuration file needed.

| Situation | Behaviour |
|---|---|
| `entrypoints` is not written (or the file does not exist) | the **built-in convention set** is used |
| `entrypoints: [...]` is written | the configuration wins |
| `entrypoints: []` is written | **explicitly off** — "not written" and "written empty" are different things |

### The declaration file

```text
<repo>/.agents/guardrails.json     ← preferred (committable, shared across agents)
<repo>/.minimax/guardrails.json    ← fallback
```

The first file that exists and parses is used. With neither, `context` and `rules` do nothing while
the built-in `entrypoints` convention set still works.

> After writing, check `git check-ignore -v .agents/guardrails.json` — **it must print nothing**, or
> the declaration is lost on the next machine.

## Requirements

- Node.js **22 or newer**, available as `node` on the host's `PATH`. The Hooks are plain `.mjs`
  scripts; nothing is bundled or installed.
- A MiniMax Code host that loads local Hooks. Hook configuration is snapshotted at session start —
  **start a new conversation after installing**.
- Windows, macOS, and Linux are all supported; the scripts only use Node built-ins.

## Data and network

- **No network access.** The plugin never opens a socket.
- **No credentials, no accounts, no paid services.**
- **No telemetry is sent anywhere.** Each Hook appends one line to `${PLUGIN_DATA}/telemetry.jsonl`
  (512 KB / 2000 lines, auto-rotated) so a silent failure is still diagnosable on your own machine.
  Set `PLUGIN_TELEMETRY=off` to disable it.
- **Files it reads or writes:**
  - reads the repository's `guardrails.json`, the ledger carrier, `doc-budget.json`, and `AGENTS.md`
    (read-only);
  - writes only `${PLUGIN_DATA}`; **it never writes to your repository** — the declaration is written
    by the Skill, on your instruction, and the Hooks only read it.

## Compatibility notes

- The package ships **both** Hook layouts: `io.minimax.mcode/hooks/hooks.json` for the 0.3.x runtime,
  and inline `hooks` in `.claude-plugin/plugin.json` for mcode 0.4.0+. Runtime 0.4.0+ reads only the
  inline manifest, so the 0.3.x document alone would leave you with no Hooks at all.
- The PreToolUse decision is emitted in **both** documented shapes — the portable top-level
  `decision`/`reason` and the MiniMax `hookSpecificOutput.permissionDecision` — so the same script
  works on either runtime.
- The Skill is a plain `SKILL.md` file and loads on every runtime.

## Known limits

- **This is a guardrail against slips, not a security boundary.** Deleting the file, or using a tool
  the rule does not cover, bypasses it. Do not rely on it for secrets or permissions.
- **Regular expressions have no sandbox.** A pathological user pattern can be slow; the only
  mitigation is the 20000-character cap on the matched text.
- **The `PreToolUse` Hook starts a process per tool call.** With dozens of calls per turn that adds
  up; narrow the matcher to `"bash|write|edit"` if it bothers you.
- **When the working directory is the user's home directory the rules are skipped**, so a rule can
  never leak into every project at once.

## Licensing

MIT, see [LICENSE](LICENSE). The Hook scripts are derived from the author's earlier `zcode-plugin`
project (also MIT, Copyright (c) 2026 Jrtou).
