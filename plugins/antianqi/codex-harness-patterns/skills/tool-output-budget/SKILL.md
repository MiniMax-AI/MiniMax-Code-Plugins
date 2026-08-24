---
name: tool-output-budget
description: |
  Truncate oversized tool output so it does not blow the agent's context window.
  USE WHEN: tool output > 3000 tokens, line > 500 chars, large log, JSON array, minified code, fetched HTML, verbose npm/cargo/test output, `cat` of a big file, "truncated" / "output cut off" / "use offset to read more" message.
  TRIGGER PHRASES: "输出太长", "context 满了", "log 太大", "截断", "truncate", "output cut off", "读不完", "太大了", "context 撑爆", "too long".
  SKIP WHEN: output is small (<100 lines), output is the user-facing final answer, output is structured and needs full parse (read once with a guard).
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.1"
  inspired-by: https://github.com/openai/codex/tree/main/codex-rs/utils/output-truncation
---

# Tool Output Budget

Keep oversized tool output out of the main context. Replace it with a token-aware summary plus the
parts most likely to matter.

## When to use

Use this Skill **immediately after** any of these tool calls, before quoting the output in your
next response:

- `bash` returns output that looks like a large log, JSON array, HTML page, or `cat` of a long
  file (e.g. `cat huge.log`, `npm test 2>&1`, `kubectl get ... -o yaml`).
- Any tool returns a single line longer than ~500 characters (typical of minified JS, base64
  blobs, very wide CSV).
- The tool succeeded but the user did not ask for the full payload.

## When NOT to use

- The user explicitly asked for "the whole thing" or "every line".
- The output is small (< ~3000 tokens). Trust the tool as-is.
- You genuinely need the exact bytes (e.g. computing a hash, doing a byte-equal diff). Quote the
  output verbatim and explain why truncation is unsafe.

## Process

1. **Estimate the size.** If the tool already returned a byte count, use that. Otherwise, count
   newlines and pick the longest line. A line of ~80 characters is roughly 20 tokens.
2. **Decide to truncate if** any of the following hold:
   - Total estimated tokens > 3000 (default threshold).
   - Any single line > 500 characters.
   - Output structure is a long JSON array, log dump, or fetched HTML.
3. **Pick what to keep.** Default: **head 200 lines + tail 50 lines + 1 marker line**. Adapt:
   - For `cat` of a known file, prefer **tail** (errors and stack traces usually live at the end).
   - For a JSON array, prefer **head** (the schema is at the top; the agent only needs a few
     sample items).
   - For a fetched HTML page, prefer the **head** (metadata, title) plus a 1-line tag count
     summary; do not keep the body.
4. **Format the replacement** as a single fenced block:

   ```text
   [truncated by tool-output-budget]
   kept: lines 1-200 of 1234 (head) + lines 1185-1234 of 1234 (tail)
   skipped: 834 middle lines
   estimated total tokens: ~5500
   file path on disk: <path>     # only if the tool output came from a real file
   ```

5. **Hand back the original file path when you have it.** The user may want you to re-read a
   specific range later, and you can use `read` with explicit `offset` / `limit` for that.
6. **Do not silently retry the same tool.** Truncation is a one-shot decision per tool result.

## Output contract

Every time you apply this Skill, the user's next message should see exactly this shape:

- A short preamble explaining what was truncated and why (one sentence).
- A fenced code block with the kept head + tail + marker line.
- (Optional, only if a real file exists) The path to re-read for the full content.

## Example

```text
> cat /var/log/app.log

[truncated by tool-output-budget]
kept: lines 1-200 of 4821 (head) + lines 4771-4821 of 4821 (tail)
skipped: 4621 middle lines
estimated total tokens: ~6800
file path on disk: /var/log/app.log

# last 5 of tail (the part the user usually wants)
2026-08-23T22:47:01Z ERROR connection refused 10.0.4.7:5432
2026-08-23T22:47:02Z ERROR retrying (1/3)
2026-08-23T22:47:05Z ERROR connection refused 10.0.4.7:5432
2026-08-23T22:47:08Z WARN  giving up; will retry on next request
2026-08-23T22:47:08Z INFO  request 7d4e failed: upstream unavailable
```

## Common pitfalls

- **Don't truncate error output that contains the answer.** If the user asked "why did the test
  fail", the failure line is in the tail of the test runner output. Keep tail, drop head.
- **Don't truncate `cat` of source code you need to edit.** Use `read` with `offset`/`limit` for
  surgical access; keep the full code in the next step's tool call.
- **Don't estimate size from newlines alone.** A 1-line 50 KB minified file is one "line" but
  ~12,000 tokens. Check the longest line first.
- **Don't loop.** If you truncated, the next tool call should *act* on the result, not re-run
  the same command with the same expectation.

## Verification checklist

- [ ] Did you estimate tokens or bytes before deciding?
- [ ] Is the marker line present and clear about how much was skipped?
- [ ] Did you keep the part most likely to matter (head for structure, tail for errors)?
- [ ] If a real file path exists, did you hand it back to the user?
- [ ] Did the user's next step actually use the truncated result?
