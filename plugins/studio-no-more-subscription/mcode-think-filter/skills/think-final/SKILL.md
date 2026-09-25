---
name: think-final
description: Activates when the user wants lean transcripts. Instructs the model to keep only the LAST thinking block per turn and route intermediate scratch reasoning through a single-line tool call that writes to PLUGIN_DATA/scratch.
license: Apache-2.0
compatibility: Requires mcode-think-filter.
metadata:
  author: bro
  version: "0.1.0"
---

# Think-Final: keep only the last thinking block per turn

Your native thinking blocks are visible in the transcript. Most of them
are intermediate scratch — they bloat context without helping the final
answer. This Skill steers you to keep the transcript lean.

## Rule

1. **Do not emit a native thinking block for every step.** When you
   would normally think through 3–5 sub-steps before a tool call, do
   **not** produce 3–5 thinking blocks.
2. **Put intermediate scratch reasoning into a single-line tool call**
   that writes to `${PLUGIN_DATA}/scratch/<turn>.md`:
   ```
   write(path="$PLUGIN_DATA/scratch/<turn>.md", body="<scratch>")
   ```
   or, if a write tool is unavailable, a one-shot `bash` that
   `cat`s the scratch to a file. The tool call's *content* carries the
   scratch; the tool *call* is not a thinking block and is not bloated.
3. **Reserve native thinking for the LAST decision step before a tool
   call** (or before your final assistant message). One short block,
   one paragraph, summarizing what you decided.
4. At the end of a turn, emit exactly **one** short final-thinking
   block (or zero) summarizing the turn's outcome. Do not recap each
   sub-step.

## What stays in the transcript

- All tool calls and tool results (these are essential).
- Native thinking blocks: at most **1–2 per turn** (one mid-stream,
  one final). Both should be short.
- The `${PLUGIN_DATA}/scratch/<turn>.md` files are on disk and are
  *not* part of the model transcript. The observer Hook in this plugin
  records how many thinking blocks you emitted in `state.json` so the
  user can audit.

## Failure modes

- If you emit many thinking blocks anyway, the observer Hook records
  the count in `state.json`; the user sees the deviation.
- If `${PLUGIN_DATA}` is read-only, the scratch write fails; fall back
  to a brief single-line note in your final thinking.

## Related

- The plugin's `PreCompact` Hook fires `decision: "allow"` and lets the
  runtime's own compaction trim. By keeping the transcript lean via
  this Skill, the natural compaction has less to trim.
