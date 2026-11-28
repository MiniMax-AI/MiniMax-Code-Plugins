# Memory Loop

Close the **memory loop**: the facts a project taught you should still be there in the next session — not as a log nobody reads, but as context the agent actually starts with.

The gap this fills: a memory file that is written but never injected is a dead file. Memory Loop makes the loop close in three stages — collect on every turn, distil when it matters, inject at every session start — and keeps all of it **inside your repository**, so it travels with `git clone` instead of dying on one machine.

Version **1.0.0** · MIT · one Skill plus two Hooks. Fully local: no network, no accounts, no data leaving the machine.

## Try it

Install and enable the plugin, then open a new conversation in your project:

> Distill the memory candidates from this project into MEMORY.md — keep the conventions we will reuse and drop the one-off narration.

Expected result: the agent reads the candidates, keeps only the reusable facts, rewrites `MEMORY.md` grouped by topic, and reports how many candidates it kept versus dropped.

At the start of the next conversation, the project memory is already in context — no recap needed:

> What are this project's conventions?

Expected result: the answer comes from the injected `MEMORY.md` block, not from re-reading files.

## What it installs

```text
plugins/benntqoo/memory-loop/
├── plugin.json                       # portable Agent Plugins 1.0 manifest
├── .claude-plugin/plugin.json        # mcode 0.4.0+ manifest, inline Hooks
├── io.minimax.mcode/
│   ├── hooks/
│   │   ├── hooks.json                # Hook document for the 0.3.x layout
│   │   ├── scripts/                  # Hook entry scripts (Node.js)
│   │   └── lib/                      # shared Hook I/O, project resolution, candidate store
└── skills/
    └── memory-loop/SKILL.md          # distil candidates into MEMORY.md
```

### The three stages

| Stage | Who | What happens |
|---|---|---|
| ① Collect | `Stop` hook (automatic) | A turn that changed a file or made a decision, and that names a concrete path, contributes one candidate to this project's `candidates.jsonl`. Content fingerprints remove duplicates. |
| ② Distil | `memory-loop` Skill (on request) | The model reads the candidates, decides which are worth keeping, and rewrites `MEMORY.md`. |
| ③ Inject | `SessionStart` hook (automatic) | `MEMORY.md` is injected into the conversation, plus a notice when candidates are still pending. |

Stage ② is deliberately manual: a script cannot judge whether a fact is worth keeping, and hard-coding
that judgement only produces noise.

### Where things live

```text
<repo>/.agents/memory/
├── candidates.jsonl   ① the raw candidates for this project (deduplicated)
├── MEMORY.md          ② the distilled long-term memory (this is what gets injected)
└── state.json         the distillation cursor {"distilled": N}
```

The directory sits inside the repository, so the whole memory travels with `git clone` and is
reviewable in a diff. A repository may relocate it through `memory.dir` in
`.agents/guardrails.json`; the hooks and the Skill both resolve it the same way, and the resolved
path is published in the session-start injection.

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
  - reads the current conversation's last assistant message and working directory;
  - writes only `<repo>/.agents/memory/` (candidates, `MEMORY.md`, the cursor) and `${PLUGIN_DATA}`;
  - never writes to `AGENTS.md`, source code, or anything outside the project.

## Compatibility notes

- The package ships **both** Hook layouts: `io.minimax.mcode/hooks/hooks.json` for the 0.3.x runtime,
  and inline `hooks` in `.claude-plugin/plugin.json` for mcode 0.4.0+. Runtime 0.4.0+ reads only the
  inline manifest, so the 0.3.x document alone would leave you with no Hooks at all.
- The Skill is a plain `SKILL.md` file and loads on every runtime.
- The plugin root reaches the Skill through the session-start injection, so no absolute path is
  hard-coded anywhere in the package. The same copy works in any install location and on any machine.

## Licensing

MIT, see [LICENSE](LICENSE). The Hook scripts are derived from the author's earlier `zcode-plugin`
project (also MIT, Copyright (c) 2026 Jrtou).
