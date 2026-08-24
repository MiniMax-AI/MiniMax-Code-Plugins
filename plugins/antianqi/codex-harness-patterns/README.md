# codex-harness-patterns

A focused collection of Skills distilled from the **OpenAI Codex harness v0.149.0** execution
model (`codex-rs/core/`). These Skills teach a MiniMax Code agent how to survive long-running
multi-step tasks without losing focus, blowing its token budget, stalling on serial work,
shipping unverified changes, burning context on bad sub-agent briefs, drifting from the
original goal, paying main-model prices for cheap-model work, losing track of which
sub-agent is doing what, failing on transient errors without a budget, reading streaming
output without filling context, or losing work at session end.

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
- **No proof of done** — the model marks a task complete from memory, not from evidence.
- **Bloated sub-agent briefs** — the model dumps the full conversation history into a `task`
  call, paying the token cost twice.
- **No shared state** — long tasks have no persistent ground truth that survives context
  compaction, so the model keeps re-deriving "where are we?".
- **Foreground blocks** — the model `bash`es a 5-minute build, blocks the conversation, and
  times out.
- **Goal drift** — the original user request gets silently replaced by an inferred goal, and
  the agent ends up doing a side quest with confident justification.
- **Model over-spend** — the agent uses the main model for routine lookups and transforms
  that a cheap model could handle in a fraction of the time and cost.
- **Sub-agent context over-spend** — the agent gives every sub-agent the full history when a
  small brief would do.
- **Lost sub-agents** — the agent spawns 3 children, loses track of which is which, and either
  duplicates work or never reads a child's result.
- **Runaway goal cost** — the user sets a token budget for a goal; the agent blows past it
  without surfacing the warning.
- **Silent retry** — the agent retries a `deterministic` error (permission denied, file not
  found) three times in a row, burning the same error each time.
- **Streaming overflow** — the agent reads an unbounded stream in one go, filling the
  context with raw bytes instead of a summary.
- **Session loss** — the user steps away; next session starts with no idea what was in
  progress.

OpenAI's Codex harness solves each of these with specific code (see
[`codex-rs/core/src/compact.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs),
[`utils/output-truncation/`](https://github.com/openai/codex/tree/main/codex-rs/utils/output-truncation),
[`session/turn.rs::run_turn`](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs),
[`context/world_state.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/context/world_state.rs),
[`ext/goal/templates/goals/continuation.md`](https://github.com/openai/codex/blob/main/codex-rs/ext/goal/templates/goals/continuation.md),
[`ext/goal/src/accounting.rs`](https://github.com/openai/codex/blob/main/codex-rs/ext/goal/src/accounting.rs),
[`model-provider-info/`](https://github.com/openai/codex/tree/main/codex-rs/model-provider-info),
[`agent-graph-store/`](https://github.com/openai/codex/tree/main/codex-rs/agent-graph-store),
[`code-mode/src/grpc_session/reconnect.rs`](https://github.com/openai/codex/blob/main/codex-rs/code-mode/src/grpc_session/reconnect.rs),
[`state/src/runtime/recovery.rs`](https://github.com/openai/codex/blob/main/codex-rs/state/src/runtime/recovery.rs))
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

"Set the goal of this thread: migrate the auth subsystem to OIDC alongside SAML. Drift-check before
each non-trivial change."

"This sub-task is a one-shot file reformat — use the cheap model for it."

"Before you say 'done' on the auth refactor, run a completion audit. Show me the evidence for each requirement."

"I'm about to spawn 4 sub-agents. Decide the fork_turns for each — full history or just the brief?"

"Show me the sub-agent family tree — which are still running?"

"This goal has a 20,000-token budget. Tell me at 50% / 80% / 100%."

"The bash command just failed with 'permission denied'. Retry? Switch tool? Ask me?"

"Read this 50K-line build log without filling the context. Stream-read it and summarize."

"It's the end of the day. Write a handoff file so tomorrow's session can pick up."
```

**Expected result**: the agent picks the right Skill, follows the documented process, and produces
output that matches the Skill's output contract (see each Skill's `SKILL.md` for its specific
contract and example).

## What this Plugin adds (v0.6.0, 18 Skills)

Eighteen Skills, all Skill-only (no MCP server, no network access):

| # | Skill | When to activate | v |
|---|---|---|---|
| 1 | `tool-output-budget` | A tool returns output you suspect is too large to keep verbatim (large logs, JSON, fetched HTML, minified files). | v0.1.0 |
| 2 | `context-pressure-compact` | The task is multi-step and long; the running `todowrite` exceeds 5 items, or the agent has been reasoning for many turns. | v0.1.0 → v1.0 |
| 3 | `parallel-fanout` | The user task is clearly decomposable into 2+ independent sub-tasks (independent files, independent probes, independent analyses). | v0.1.0 → v1.0 |
| 4 | `plan-stream-emit` | The user task is non-trivial and the user has not yet approved a plan; emit a structured plan before touching files. | v0.1.0 |
| 5 | `review-mode` | A non-trivial sub-task has just finished and the work is about to be marked done; the user wants verification before relying on the result. | v0.2.0 |
| 6 | `delegate-with-context` | About to call `task` to hand off a sub-task; the full conversation history is too large to forward and a minimal-context brief would do. | v0.2.0 → v1.0 |
| 7 | `world-state-tracking` | The task is long enough that the agent has lost the thread at least once, or `context-pressure-compact` is about to be applied. | v0.2.0 |
| 8 | `background-task` | A command is expected to take > 30 seconds, or the user wants a long-running process to coexist with ongoing work. | v0.2.0 |
| 9 | `goal-persistence` | A non-trivial task has just been stated (set the goal); the user has redirected (update the goal); or a `context-pressure-compact` is about to be applied (alignment check). | v0.3.0 → v1.0 |
| 10 | `model-router` | About to call `task` for a non-trivial sub-task, or about to spend the main model on work a cheaper model could do. | v0.3.0 |
| 11 | `completion-audit` | About to say "done" / "complete" / "ship it" on a non-trivial task. Derives requirements, identifies authoritative evidence, verifies each. | v0.4.0 |
| 12 | `fork-context-decision` | About to call `task` to hand off a sub-task. Decides how much parent context to give the sub-agent via the `fork_turns` parameter. | v0.4.0 |
| 13 | `subagent-family-tracking` | Spawned a sub-agent (or have one running). Track the parent/child tree so you do not lose children, duplicate work, or leave anyone running. | v0.5.0 |
| 14 | `goal-token-budgeting` | The user set an explicit `token_budget` on a goal. Track running usage against the budget and report the final number on completion. | v0.5.0 |
| 15 | `error-recovery-strategy` | A tool call, sub-agent task, or external operation failed. Decide between retry / switch / fallback / ask-user / skip. | **v0.6.0 (new)** |
| 16 | `retry-with-backoff` | About to retry a `transient` error. State the policy first: max attempts, base delay, max delay, jitter, total time budget. | **v0.6.0 (new)** |
| 17 | `streaming-output-reader` | A tool returns a long stream (SSE / WebSocket / `tail -f` / large log). Read in bounded chunks, synthesize, never loop. | **v0.6.0 (new)** |
| 18 | `session-handoff` | The session is ending (user stepping away, time up, about to compact). Write a handoff file so next session can pick up in 30 seconds. | **v0.6.0 (new)** |

## v0.6.0 changelog

### Added

- `error-recovery-strategy` Skill — 4-bucket classification (transient / deterministic / stale / unknown) → 5-action decision tree (retry / switch / fallback / refresh-then-retry / ask-user / skip). Mirrors the `code-mode` reconnect philosophy and the `MultiAgentMode::ExplicitRequestOnly` opt-in principle.
- `retry-with-backoff` Skill — explicit retry policy: max 3 attempts, base 2s, max 30s, full jitter, 60s total budget. Respects `Retry-After`. Hard ceiling, no silent extension. Always escalates on exhaustion.
- `streaming-output-reader` Skill — read in bounded chunks (head / tail / grep), write a cumulative summary, stop after at most 3 reads. Mirrors the `WebsocketSession.last_request` incremental pattern and the `unified_exec` background-command pattern.
- `session-handoff` Skill — at session end, write a structured handoff file (verbatim goal, state file references, done/in-progress items, next concrete step, critical paths, "might be wrong" risks). Mirrors `state/runtime/recovery.rs` (DB-backed resume) and the `rollout_migration_state` migration.

Total Skills: 18 (14 from v0.5.0 + 4 new).

## v0.5.0 changelog (prior)

### Added

- `subagent-family-tracking` Skill.
- `goal-token-budgeting` Skill.

### Updated

- `context-pressure-compact` v1.0.
- `delegate-with-context` v1.0.

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
  the agent to use `write` / `edit` / `bash` to persist a compact summary, a plan file, a
  world-state file, a goal file, a family file, a handoff file, or a usage log, but only on
  paths the user already authorised through the active session.
- **No sub-agent launch without user intent.** `parallel-fanout`, `delegate-with-context`, and
  `fork-context-decision` instruct the agent to use `task` for fan-out / delegation, but only
  when the user task is independently decomposable **and** the user has opted in to
  multi-agent work.
- **No model switching that the harness does not support.** `model-router` only works if the
  underlying `task` tool exposes `model_config_id` (or equivalent). If the harness does not
  support model routing, the Skill degrades to "classify the sub-task" and the model choice
  follows whatever default the harness provides.

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
