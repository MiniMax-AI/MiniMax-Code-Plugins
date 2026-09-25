# mcode-think-filter

Keep transcripts lean by steering the model so **only the last native
thinking block per turn** survives in the model context. Intermediate
scratch reasoning is routed into a single-line tool call that writes to
`${PLUGIN_DATA}/scratch/<turn>.md` — present on disk for audit, but not
in the model's transcript.

This is a **Skill + observer Hook** combo, not a transcript rewriter
(the hook system does not currently expose a transcript-edit hook).

## Install

```bash
cp -r mcode-think-filter ~/.mcode/plugins/local/
mcode plugin enable mcode-think-filter@local
```

## What it does

1. **Skill `think-final`** instructs the model:
   - One short native thinking block per turn (or two: mid-stream + final).
   - Intermediate scratch goes to `${PLUGIN_DATA}/scratch/<turn>.md` via
     a single-line tool call.
2. **PostToolUse Hook** (`io.minimax.mcode/hooks/scripts/trim-thinking.mjs`)
   reads each event payload, counts `thinkingBlocks` if present, and
   appends a compact record to `${PLUGIN_DATA}/state.json`. It never
   edits the transcript.
3. **PreCompact Hook** fires the same observer with `--phase pre-compact`
   so the user can see how many thinking blocks existed at compaction
   time. It returns `decision: "allow"` (no override).

## Limitations

- Best-effort: the model may emit more thinking than instructed. The
  Skill is the lever; the hook is observability.
- If the runtime later exposes a transcript-edit hook, the plugin can
  be extended to actually drop blocks.
- The count depends on the runtime exposing `thinkingBlocks` or
  `thinkingBlockCount` in the event payload. If neither is present, the
  record will have `thinkingBlockCount: null`.

## Copyable example prompt

> "Refactor `lib/utils.ts` and keep your thinking tight."

The model will:
1. Read the file.
2. Write intermediate scratch (if any) to `${PLUGIN_DATA}/scratch/<turn>.md`.
3. Edit the file.
4. End with a short final-thinking block summarizing what changed.

## Tests

This plugin has no `node --test` suite — its hooks are observer-only
and side-effect-free on the transcript. The user's audit is via
`${PLUGIN_DATA}/state.json`.

## Disclosure

- Writes only to `${PLUGIN_DATA}/state.json`.
- Network: zero.
- Native binaries: none.
