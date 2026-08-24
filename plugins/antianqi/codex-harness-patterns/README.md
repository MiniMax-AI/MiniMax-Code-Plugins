# codex-harness-patterns

A focused collection of Skills distilled from the **OpenAI Codex harness v0.149.0** execution
model (`codex-rs/core/`). These Skills teach a MiniMax Code agent how to survive long-running
multi-step tasks without losing focus, blowing its token budget, stalling on serial work,
shipping unverified changes, burning context on bad sub-agent briefs, drifting from the
original goal, paying main-model prices for cheap-model work, losing track of which
sub-agent is doing what, failing on transient errors without a budget, reading streaming
output without filling context, or losing work at session end.

## v0.6.1 changelog (this release)

### Changed

**Trigger descriptions rewritten across all 18 Skills** for better LLM matching. Each
`description:` frontmatter field now uses a structured 4-line format:

```yaml
description: |
  <one-sentence purpose>.
  USE WHEN: <comma-separated concrete signals and keywords>.
  TRIGGER PHRASES: <user-original-language phrases the user might say>.
  SKIP WHEN: <anti-patterns where this skill does not apply>.
```

This makes the description **keyword-greppable** (so the LLM can match on real signals
like "ECONNREFUSED", "permission denied", "retries exceeded", "上下文满了" / "出错了" /
"重试") instead of trying to interpret abstract prose.

All 18 Skills have their trigger phrases now spelled out in both English and Chinese, so
the LLM can match user language directly. Skill versions bumped to `0.1.1` (or
`1.0.1` for the v1.0 skills).

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
| 1 | `tool-output-budget` | A tool returns output you suspect is too large to keep verbatim (large logs, JSON, fetched HTML, minified files). | v0.1.0 → 0.1.1 |
| 2 | `context-pressure-compact` | The task is multi-step and long; the running `todowrite` exceeds 5 items, or the agent has been reasoning for many turns. | v0.1.0 → v1.0.1 |
| 3 | `parallel-fanout` | The user task is clearly decomposable into 2+ independent sub-tasks (independent files, independent probes, independent analyses). | v0.1.0 → v1.0.1 |
| 4 | `plan-stream-emit` | The user task is non-trivial and the user has not yet approved a plan; emit a structured plan before touching files. | v0.1.0 → 0.1.1 |
| 5 | `review-mode` | A non-trivial sub-task has just finished and the work is about to be marked done; the user wants verification before relying on the result. | v0.2.0 → 0.2.1 |
| 6 | `delegate-with-context` | About to call `task` to hand off a sub-task; the full conversation history is too large to forward and a minimal-context brief would do. | v0.2.0 → v1.0.1 |
| 7 | `world-state-tracking` | The task is long enough that the agent has lost the thread at least once, or `context-pressure-compact` is about to be applied. | v0.2.0 → 0.2.1 |
| 8 | `background-task` | A command is expected to take > 30 seconds, or the user wants a long-running process to coexist with ongoing work. | v0.2.0 → 0.1.1 |
| 9 | `goal-persistence` | A non-trivial task has just been stated (set the goal); the user has redirected (update the goal); or a `context-pressure-compact` is about to be applied (alignment check). | v0.3.0 → v1.0.1 |
| 10 | `model-router` | About to call `task` for a non-trivial sub-task, or about to spend the main model on work a cheaper model could do. | v0.3.0 → 0.3.1 |
| 11 | `completion-audit` | About to say "done" / "complete" / "ship it" on a non-trivial task. Derives requirements, identifies authoritative evidence, verifies each. | v0.4.0 → 0.4.1 |
| 12 | `fork-context-decision` | About to call `task` to hand off a sub-task. Decides how much parent context to give the sub-agent via the `fork_turns` parameter. | v0.4.0 → 0.4.1 |
| 13 | `subagent-family-tracking` | Spawned a sub-agent (or have one running). Track the parent/child tree so you do not lose children, duplicate work, or leave anyone running. | v0.5.0 → 0.5.1 |
| 14 | `goal-token-budgeting` | The user set an explicit `token_budget` on a goal. Track running usage against the budget and report the final number on completion. | v0.5.0 → 0.5.1 |
| 15 | `error-recovery-strategy` | A tool call, sub-agent task, or external operation failed. Decide between retry / switch / fallback / ask-user / skip. | v0.6.0 → 0.6.1 |
| 16 | `retry-with-backoff` | About to retry a `transient` error. State the policy first: max attempts, base delay, max delay, jitter, total time budget. | v0.6.0 → 0.6.1 |
| 17 | `streaming-output-reader` | A tool returns a long stream (SSE / WebSocket / `tail -f` / large log). Read in bounded chunks, synthesize, never loop. | v0.6.0 → 0.6.1 |
| 18 | `session-handoff` | The session is ending (user stepping away, time up, about to compact). Write a handoff file so next session can pick up in 30 seconds. | v0.6.0 → 0.6.1 |

## Requirements

- **MiniMax Code** with Agent Plugins 1.0 support.
- **No Python, no Node, no external services.** These Skills are pure Markdown instructions; the
  agent applies them with its existing tools (`bash`, `read`, `write`, `edit`, `grep`, `glob`, `task`).
- **No MCP server, no network, no credentials.** This Plugin does not start any process or open any
  socket. It only adds Skill files to the agent.

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
