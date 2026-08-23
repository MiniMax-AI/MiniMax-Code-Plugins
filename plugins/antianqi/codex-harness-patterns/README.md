# codex-harness-patterns

A focused collection of Skills distilled from the **OpenAI Codex harness v0.149.0** execution
model (`codex-rs/core/`). These Skills teach a MiniMax Code agent how to survive long-running
multi-step tasks without losing focus, blowing its token budget, stalling on serial work,
shipping unverified changes, or burning context on bad sub-agent briefs.

## The problem

Long agentic sessions fail for predictable reasons:

- **Tool outputs explode** — `cat` on a 5,000-line log, or `curl` returning 1 MB of HTML, can fill
  the context in a single step.
- **Context drift** — after 30+ tool calls the model has lost track of the original goal, current
  state, and what still needs doing.
- **Serial work** — the model does A, then B, then C, when A, B, C are independent and could
  finish in one round trip.
- **No plan** — the model dives into a complex task without first surfacing a structured plan,
  so the user cannot course-correct early.
- **No review** — the model writes code, says "done", and ships a defect the user has to find.
- **Bloated sub-agent briefs** — the model dumps the full conversation history into a `task`
  call, paying the token cost twice.
- **No shared state** — long tasks have no persistent ground truth that survives context
  compaction, so the model keeps re-deriving "where are we?".
- **Foreground blocks** — the model `bash`es a 5-minute build, blocks the conversation, and
  times out.

OpenAI's Codex harness solves each of these with specific code (see
[`codex-rs/core/src/compact.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs),
[`utils/output-truncation/`](https://github.com/openai/codex/tree/main/codex-rs/utils/output-truncation),
[`session/turn.rs::run_turn`](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs),
[`context/world_state.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/context/world_state.rs))
and reports a 3× score lift on ARC-AGI-3 with the same model, just by changing the harness.
This Plugin packages those patterns as portable Skills.

## Try it

Install from `/plugins` → **Local**, then ask any of:

```text
"Read docs/internal-spec.md and summarize the data model — keep the full file off the main context"

"Refactor the auth subsystem across these 5 files. Plan first, then execute."

"Investigate why the test suite is flaky. Decompose into independent probes and run them in parallel."

"I'm at turn 35 of an open-source contribution. Compress the conversation so I can keep going."

"You just finished the migration — review your own diff for off-by-ones and edge cases."

"Spawn a sub-agent to scan the codebase for unused imports. Give it a tight brief, not the full history."

"Start a long dev server in the background so I can keep asking you things while it warms up."
```

**Expected result**: the agent picks the right Skill, follows the documented process, and produces
output that matches the Skill's output contract (see each Skill's `SKILL.md` for its specific
contract and example).

## What this Plugin adds

Eight Skills, all Skill-only (no MCP server, no network access):

| Skill | When to activate |
|---|---|
| `tool-output-budget` | A tool returns output you suspect is too large to keep verbatim (large logs, JSON, fetched HTML, minified files). |
| `context-pressure-compact` | The task is multi-step and long; the running `todowrite` exceeds 5 items, or the agent has been reasoning for many turns. |
| `parallel-fanout` | The user task is clearly decomposable into 2+ independent sub-tasks (independent files, independent probes, independent analyses). |
| `plan-stream-emit` | The user task is non-trivial and the user has not yet approved a plan; emit a structured plan before touching files. |
| `review-mode` | A non-trivial sub-task has just finished and the work is about to be marked done; the user wants verification before relying on the result. |
| `delegate-with-context` | About to call `task` to hand off a sub-task; the full conversation history is too large to forward and a minimal-context brief would do. |
| `world-state-tracking` | The task is long enough that the agent has lost the thread at least once, or `context-pressure-compact` is about to be applied. |
| `background-task` | A command is expected to take > 30 seconds, or the user wants a long-running process to coexist with ongoing work. |

## Requirements

- **MiniMax Code** with Agent Plugins 1.0 support.
- **No Python, no Node, no external services.** These Skills are pure Markdown instructions; the
  agent applies them with its existing tools (`bash`, `read`, `write`, `edit`, `grep`, `glob`, `task`).
- **No MCP server, no network, no credentials.** This Plugin does not start any process or open any
  socket. It only adds Skill files to the agent.

## Capabilities & permissions

- **Read-only by default** (these Skills only change how the agent shapes its own output and
  tool calls).
- **No file modification outside the agent's existing write surface.** The Skills may instruct
  the agent to use `write` / `edit` / `bash` to persist a compact summary, a plan file, or a
  world-state file, but only on paths the user already authorised through the active session.
- **No sub-agent launch without user intent.** `parallel-fanout` and `delegate-with-context`
  instruct the agent to use `task` for fan-out / delegation, but only when the user task is
  independently decomposable. The agent must still justify the decomposition in the plan
  and stop if the user says "do it one by one".

## Data and network

- **No network access.** This Plugin adds Skills only; it does not call out.
- **No credentials, tokens, env vars, or telemetry.** The agent does not need any of these to
  apply the Skills.
- **No data leaves your machine.** The Skills operate on whatever the agent can already see in
  the workspace.

## Security model

The Skills are read-only instructions. They cannot be used to exfiltrate data, run untrusted code,
or escalate privileges beyond the agent's existing capability set. The only side effect is the
agent choosing to use its existing tools (e.g. `write` a compact summary to disk) — exactly as
the user would do manually.

## How the Plugin is validated

The Plugin was developed against the official `npm run check` workflow (see
`docs/plugin-compatibility.md` in the upstream `MiniMax-Code-Plugins` repo). It declares only
the portable subset (Skills + manifest), includes a real example prompt in this README, and
carries an Apache-2.0 LICENSE matching the host repository.

## License

Apache-2.0
