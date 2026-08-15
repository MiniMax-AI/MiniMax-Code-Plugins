---
name: minimax-code-trajectory
description: Inspect privacy-aware timelines for local MiniMax Code sessions. Use when the user asks to review a task trajectory, diagnose a prior local session, summarize tool or token activity, inspect compaction/failure events, or compare recent session metadata without opening raw ledger files.
license: Apache-2.0
compatibility: Requires MiniMax Code Agent Plugins 1.0 MCP support, Node.js 22+, and local-runtime v2 session artifacts.
metadata:
  author: hetaoBackend
  version: "0.1.0"
---

# MiniMax Code Trajectory

Use the bundled read-only MCP tools to inspect MiniMax Code session ledgers. Do not search the
filesystem manually when the tools can answer the request.

## Workflow

1. If the user did not provide a session ID, call `list_minimax_sessions` with the smallest useful
   limit. Use the first result unless the user asks to choose another session.
2. Call `get_minimax_trajectory` with `detailLevel: "summary"` and a bounded `maxRecords` value.
3. Report the event sequence, session state, failures, message/tool counts, compactions, token usage,
   and parser warnings that answer the user's question.
4. Distinguish observed ledger facts from inference. A missing event does not prove an action never
   happened outside the retained ledger.

## Privacy boundary

- Use `summary` by default. It intentionally omits conversation text, thinking, tool arguments and
  results, titles, absolute paths, file identifiers, hashes, credentials, and raw records.
- Use `detailLevel: "full"` only after the user explicitly asks to inspect message content in this
  conversation. State that bounded redacted previews will enter the active conversation before the
  call.
- Never claim `full` is a raw export. It still omits thinking, tool arguments/results, attachments,
  raw metadata, and absolute paths.
- Do not ask for credentials or broaden the data directory. If the desired profile is not found,
  tell the user to launch MiniMax Code with the matching `MINIMAX_DATA_DIR` or `MAVIS_DATA_DIR`.

## Failure handling

- `sessions_root_missing`: the selected profile has no local-runtime v2 sessions yet, or the wrong
  data directory is active.
- `session_not_found`: list recent sessions and ask the user to choose an available ID.
- `ledger_missing`: the manifest still exists but its trajectory ledger has been removed; choose a
  session returned by `list_minimax_sessions` instead.
- `malformed_jsonl_line`: report that a complete ledger record was corrupt; do not invent it.
- `incomplete_tail_ignored`: the session may still be writing; explain that the final partial record
  was ignored safely.
- `oversized_jsonl_line`: a record exceeded the 2 MiB safety cap and was omitted. Do not treat the
  returned trajectory as complete.
- `symlink_artifact_rejected`: stop. Do not follow or read the symlink target.

## Output style

Lead with the result, then include the session ID, time range, high-signal event counts, failure or
compaction facts, tool/token observations, and warnings. Keep raw JSON out of the answer unless the
user explicitly requests it.
