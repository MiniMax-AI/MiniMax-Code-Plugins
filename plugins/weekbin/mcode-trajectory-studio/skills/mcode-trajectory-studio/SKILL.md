---
name: mcode-trajectory-studio
description: Inspect and visualize MiniMax Code session trajectories from the local runtime's read-only SQLite projection. Use when the user asks what happened in a session, why a task was slow or expensive, how many turns or tool calls a run took, which tools failed, how much wall-clock time went to the model versus tools, where context was spent, when compaction ran, which sub-agents were dispatched, or wants an interactive timeline of a session. Trigger phrases include "轨迹", "trajectory", "这个会话花了多久", "为什么这么慢", "调用了哪些工具", "session 时长/轮次", "看看某个 session".
license: Apache-2.0
metadata:
  author: weekbin
  version: 0.1.3
---

# MiniMax Code Trajectory Studio

Read-only trajectory inspection for local MiniMax Code sessions. The Plugin reads the
runtime's own SQLite projection and never writes to session storage.

## Pick the detail level first

| Level | Returns | When |
|---|---|---|
| `summary` (default) | roles, turn IDs, timings, token usage, tool **names** and statuses | Any question about duration, cost, turns, failures, structure |
| `full` | additionally message text, thinking, tool **arguments**, tool **results** | Only after the user explicitly asks to see content |

Never widen to `full` on your own. The user's session content is theirs; ask before returning it.

## Tools

1. `trajectory_list` — find a session. Returns metadata only, newest first. Filter by `agent`
   (`mavis`, `explore`, `worker`, `verifier`), `kind`, or `sinceMs`.
2. `trajectory_summary` — the dsh `sessionStats` equivalent for one session: `turns`, `steps`,
   `llmMs`, `toolMs`, `decodeMs`, `thinkingMs`, `inputTokens`/`cacheReadTokens`/`totalTokens`,
   `toolCalls`/`toolFailures`, `compactions`, `subagentTasks`, `assets`, and a `sources` breakdown.
   Omit `sessionId` for the most recently updated session.
3. `trajectory_get` — page through records in insert order. Use `offset`/`limit`; narrow with
   `turnId`. Read `nextOffset` and keep paging when you need the whole session. Each record carries
   `inputKind` (`human` / `injected`) so you can tell a person's own words from context the harness
   injected, `failureCount`, and a `toolCalls` array where each entry has `name`, `ok`, `status`,
   the measured `durationMs` (null when the runtime recorded no task for that call), `taskId`,
   `agentName`, `childSessionId`, and — in `full` detail — `args` and `result`.
4. `trajectory_search` — full-text search over titles, agent names, statuses, and workspace paths.
5. `trajectory_tasks` — background tasks and sub-agent dispatches owned by a session, with status,
   wall-clock duration, the command or objective, the sub-agent name, and the child session ID.
   This is the nested view.
6. `trajectory_task_output` — the tail of one task's captured output (bounded). Use it to explain a
   failure without opening the session directory by hand.
7. `trajectory_studio` — start the local web panel and return its URL.

## Answering common questions

- **"How long did this session take?"** → `trajectory_summary`, then report `llmMs`, `toolMs`,
  `decodeMs`, and `steps`. Say that `llmMs + toolMs` is the machine time, not wall-clock elapsed.
- **"Why is it slow?"** → compare `llmMs` against `toolMs`; if tools dominate, call
  `trajectory_tasks` and report the slowest tasks by `durationMs`.
- **"Why did this task fail?"** → `trajectory_tasks` to find the failed row, then
  `trajectory_task_output` for its captured output.
- **"What tools ran / what failed?"** → `trajectory_get` (summary) and read `toolCalls[].name` plus
  `toolCalls[].ok`; `ok !== true` means the call did not succeed. **A non-zero exit is not always a
  real failure** — `grep` exits 1 on "no matches". Before reporting a failure, check the result text
  in `full` detail for a `Traceback`, `[stderr]`, or `is_error: true`; only those are hard failures.
  A call can also carry `ok: true` while its output contains a Traceback, so read the text, not just
  the status.
- **"What did the sub-agents do?"** → `trajectory_tasks`, then filter `kind === 'subagent'`; each row
  carries `agentName`, `description`, and `childSessionId`. Pass that child ID back into
  `trajectory_summary` or `trajectory_get` to inspect the sub-agent's own trajectory.
- **"How was this session configured?"** → the Studio panel shows an `Agent 与能力` panel with the
  model, tool allowlist, skills and system prompt, read from the runtime's session agent definition.
  It is present only for sessions the runtime dispatched with an explicit definition.
- **"How many turns?"** → `trajectory_summary.turns`, then `trajectory_get` to show per-turn
  totals from the `turnId` grouping.
- **"Where did the context go?"** → `trajectory_get` and read each record's `contextUsage`
  component breakdown (SYSTEM_PROMPT / MEMORY / TOOLS / SKILLS / MESSAGES).

## Open the Studio panel

When the user wants to browse a trajectory themselves:

1. Call `trajectory_studio` with the `sessionId` to focus. It returns a `url` on `127.0.0.1` whose
   **fragment carries a capability token** (`#t=…`).
   - Open that URL **verbatim, including the `#t=` fragment**. Do not strip the fragment, do not
     re-encode it, do not "clean up" the URL, and do not hand-edit the port. The token is the only
     thing that lets the page read anything: without it every API route answers `403` and the panel
     loads an empty shell.
   - It is a **per-process credential, not a public link.** Do not write it into a log, a commit, an
     issue, a chat message, or any file. If the user needs the panel again in a later session, call
     `trajectory_studio` again — a new call in a new process returns a new token, and a URL from a
     previous process will be refused.
   - Note that the URL arrives inside a tool result, and the runtime persists tool results and sends
     the context on later turns — so the token is in the transcript whether or not you repeat it.
     That is why it is process-scoped: it stops working the moment this MCP server exits, and the
     panel is loopback-only. Do not widen it; just open the URL and say nothing more about it. If the
     user wants a capability that never enters a model context, tell them to run
     `node server/main.mjs --serve` in a terminal instead — that URL is printed only to them.
   - Two sessions get two panels with two separate tokens. One session's URL cannot open another's
     panel; if the user is looking at the wrong panel, start one for the session they mean.
2. Find the host's browser skill in the current Skill catalog — for example
   `browser-use:control-in-app-browser` only if that exact name is listed. Load it, then open the
   returned URL with the host's browser tool.
3. Confirm the page actually rendered before reporting success. If the page shows the
   "面板凭据无效" banner, the URL lost its fragment — call `trajectory_studio` again and open the
   fresh URL. If no browser capability is available, give the user the URL and say the panel is
   running locally.
4. The panel only reads session data, but starting it **opens a loopback listener**: `trajectory_studio`
   is the one tool here that is not read-only, so do not present it as a pure read. It bound to
   `127.0.0.1` and stops when the MCP connection closes. Call `trajectory_studio` with `stop: true`
   only if the user asks to shut it down.

## Secrets

- Everything returned by these tools has already been through the redactor, but treat it as
  sensitive anyway: `full` detail is message text, tool arguments and tool results, and those
  routinely quote credentials even after redaction.
- What the redactor covers: credential *shapes* (private key blocks, connection strings, headers and
  schemes, provider-prefixed and length-anchored tokens, JWTs), credential-named *keys* including
  camelCase variants, and both the plain and the backslash-escaped form of a key/value pair — the
  escaped form matters because the runtime stores tool results as JSON *text*, so their credentials
  arrive as `\"api_key\":\"…\"`.
- What it does not cover, so do not rely on it: a high-entropy string with no label and no provider
  shape; personal data beyond e-mail addresses and phone numbers (and those are masked only on this
  MCP path, not in the panel); an absolute path under a root the user has not configured for folding.
  If a `full` payload contains any of those, say so rather than passing it on as if it were clean.
- Prefer `summary` detail. Ask before requesting `full` detail, and never paste a `full` payload into
  a file, a commit, or a message that leaves the machine.
- If you notice a credential that survived redaction, report the string to the user as a redaction
  gap rather than working around it — do not quietly ignore it, and do not reproduce the secret more
  widely than the user already has it.

## Data source notes

- Primary source is `<dataDir>/v2/sqlite/runtime-state.sqlite`, opened `mode=ro`. `<dataDir>` is
  `MINIMAX_DATA_DIR`, else `MAVIS_DATA_DIR`, else `~/.minimax`.
- Sessions the projection has not indexed fall back to `messages.jsonl`; timings are then missing.
  The `source` field on `trajectory_get` reports which path was used.
- **Time-to-first-token is not persisted by the runtime.** `trajectory_summary.ttftMs` is always
  `null` and must be reported as unavailable, never estimated.
- `decodeMs` is an approximation: `Σ(request_duration_ms − thinking_duration_ms)`.
- If `sqliteAvailable` is false, say so plainly instead of reporting empty results as "no activity".

## Boundaries

- Read-only: never edit, move, or delete anything under the session directories.
- The SQLite tables are an internal runtime detail. Missing tables or fields degrade to `null`;
  do not treat an absent field as proof that the event did not happen.
- Report what the tools returned. Do not infer message text from a `contentLength`.
