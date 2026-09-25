---
name: computer-use-trajectory
description: Activate when the user asks to compact, summarize, or look back on a long computer-use session. Explains the after-N-turns summarization contract and the retrieve_frame flow.
license: Apache-2.0
compatibility: Requires mcode-computer-use.
metadata:
  author: bro
  version: "0.1.0"
---

# Computer-Use Trajectory Summarization

This Skill describes the contract for keeping long computer-use sessions
manageable. It is automatically loaded alongside the `computer-use`
Skill; you do not need to invoke it explicitly.

## When summarization triggers

Every `screenshot` call increments `state.screenshotCount`. After
`screenshotCount % summary_every === 0` (default `summary_every = 10`,
override via `MCODE_COMPUTER_USE_SUMMARY_EVERY`), the next `screenshot`
response carries `structuredContent.summary_request = { ... }`.

## What the model does

1. For each `frames_to_summarize` turn, write 1–3 sentences that capture
   what was on screen and what action was taken. Call
   `record_summary({ turn, summary })` once per frame.
2. Continue the task. The next `screenshot` returns a **noise-only**
   image (no underlying screen pixels) so older frames no longer
   consume context.
3. If a later turn requires looking back, call
   `retrieve_frame({ turn })` to re-inject the original archived image.
   Only one frame at a time — pull what you need, then continue.

## Failure modes

- `record_summary` is idempotent: re-calling it overwrites the prior
  summary for that turn.
- `retrieve_frame` returns `found: false` if the turn is older than the
  trajectory cap (default 200 MB, oldest-first eviction). In that case
  write `null` for that turn in any later aggregation.
- If `summary_every` is too small for the task, the model may lose
  signal. Bump the env var to 20–30 for tasks that need many frames per
  step.

## Storage

All state lives at `${PLUGIN_DATA}`:
- `state.json` — counters, sessionStartedAt.
- `trajectory/<turn>.png` — archived composite screenshots.
- `trajectory/summaries.jsonl` — one JSON object per recorded summary.
