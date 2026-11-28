# Skill Forge

Distill what a hard-won multi-step task just taught you into a **project-level** skill, then keep that skill library honest: re-read a skill you used, and fix it the moment you notice it is wrong.

The gap this fills: an agent can solve a tricky problem once and then lose the method. Skills are the only place that method can survive. Skill Forge gives the agent the **timing** (when to distill) and the **audit** (when the library has rotted), on top of the authoring mechanics a generic skill-creator already teaches.

Version **1.0.0** · MIT · two Skills plus two Hooks. Fully local: no network, no accounts, no telemetry beyond an opt-out local counter.

## Try it

Install and enable the plugin, then open a new conversation in your project:

> We just spent a while working out why the Windows build kept losing its file handles. Turn that into a skill for this project.

Expected result: the agent writes `<repo>/.minimax/skills/<kebab-name>/SKILL.md` and reports the path in one line. The skill captures the symptom, the root cause, and the fix — not a copy of the documentation.

To audit an existing library:

> Audit the skill library for this project: duplicates, spec violations, and skills whose descriptions no longer say when to use them.

Expected result: a read-only report — entity count, non-compliant skills, confirmed overlaps, weak descriptions. Nothing is modified; you decide what to fix.

## What it installs

```text
plugins/benntqoo/skill-forge/
├── plugin.json                       # portable Agent Plugins 1.0 manifest
├── .claude-plugin/plugin.json        # mcode 0.4.0+ manifest, inline Hooks
├── io.minimax.mcode/
│   ├── hooks/
│   │   ├── hooks.json                # Hook document for the 0.3.x layout
│   │   ├── scripts/                  # Hook entry scripts (Node.js)
│   │   └── lib/                      # shared Hook I/O and project resolution
└── skills/
    ├── skill-forge/SKILL.md          # distill the current task into a skill
    └── skill-audit/SKILL.md          # read-only health check of the skill library
```

### The three rules it enforces

1. **Distill when you are done** — after 5+ exploratory steps, after working around a non-obvious pitfall, or after fixing a convention that will be reused: write the skill. Do not ask "should I save this?".
2. **Re-read what you used** — if the session invoked a skill, read it again before finishing and fix stale commands, wrong tool names, or missing steps in the same turn.
3. **Fix what you read** — if a `SKILL.md` has a typo or a dead path, fix it on the spot instead of only reporting it.

### Hooks

| Event | Script | What it does |
|---|---|---|
| `Stop` | `stop-skill-nudge.mjs` | If the turn looks like it produced a reusable method (a completion signal, a lesson signal, and a concrete path) and the reply never mentions a skill, it asks the agent to distill or to explain why not. |
| `SessionStart` (`compact`, `clear`) | `session-skill-rules.mjs` | Re-injects the three rules after context compaction, when they may have been squeezed out. |

The Stop nudge is deliberately conservative and throttled to **one push per session**: it writes its counter to `${PLUGIN_DATA}`, and it stands down whenever `stop_hook_active` is true so a nudge can never loop.

## Requirements

- Node.js **22 or newer**, available as `node` on the host's `PATH`. The Hooks are plain `.mjs` scripts; nothing is bundled or installed.
- A MiniMax Code host that loads local Hooks. Hook configuration is snapshotted at session start — **start a new conversation after installing**.
- Windows, macOS, and Linux are all supported; the scripts only use Node built-ins.

## Data and network

- **No network access.** The plugin never opens a socket.
- **No credentials, no accounts, no paid services.**
- **No telemetry is sent anywhere.** Each Hook appends one line to `${PLUGIN_DATA}/telemetry.jsonl` (512 KB / 2000 lines, auto-rotated) so a silent failure is still diagnosable on your own machine. Set `PLUGIN_TELEMETRY=off` to disable it.
- **Files it reads or writes:**
  - reads the current conversation's last assistant message and working directory;
  - writes only inside `<repo>/.minimax/skills/` (the skill you asked it to create) and `${PLUGIN_DATA}`;
  - never writes to `AGENTS.md`, source code, or anything outside the project.

## Compatibility notes

- The package ships **both** Hook layouts: `io.minimax.mcode/hooks/hooks.json` for the 0.3.x runtime, and inline `hooks` in `.claude-plugin/plugin.json` for mcode 0.4.0+. Runtime 0.4.0+ reads only the inline manifest, so the 0.3.x document alone would leave you with no Hooks at all.
- The Skills are plain `SKILL.md` files and load on every runtime.
- The nudge asks the agent to continue one more turn through a `Stop` decision. If a host treats `Stop` as observe-only, the nudge simply does not fire — the Skills still work, since the Skill is the primary channel and the Hook is only a safety net.

## Licensing

MIT, see [LICENSE](LICENSE). The Hook scripts are derived from the author's earlier `zcode-plugin` project (also MIT, Copyright (c) 2026 Jrtou).
