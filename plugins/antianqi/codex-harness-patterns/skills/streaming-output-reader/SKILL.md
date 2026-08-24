---
name: streaming-output-reader
description: "Read long streaming responses (SSE / WebSocket chunks / `tail -f` / long-running commands) in a way that does not block, does not buffer the whole thing in context, and does not miss output. Use whenever a tool returns a stream that is too long for a single read, or whenever a single read would force the agent to wait instead of doing other work. Mirrors the `WebsocketSession.last_request` incremental pattern in codex-rs/core/src/client.rs and the `unified_exec` background-command pattern in codex-rs/core/src/unified_exec/."
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.0"
  inspired-by: https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs and core/src/unified_exec/
---

# Streaming Output Reader

Long outputs kill conversations. A 50,000-line log dump will fill any context window
in one read. The reflex is to `tail` the file or `read` a small slice — but that often
misses the **earliest** lines (errors at the start of a long run) and requires multiple
round trips to get a complete picture.

This Skill defines a single-pass read protocol: read in **bounded chunks**, keep a
**cumulative summary**, and stop when you have enough to act on.

## When to use

Activate when **any** of these is true:

- A tool returns output that **might** be longer than ~3000 tokens (the `tool-output-budget`
  threshold). Better to be cautious: read in chunks from the start.
- The tool offers an explicit streaming API (SSE, WebSocket chunks, `tail -f` with
  follow-mode, log subscription) and you are not using it.
- You are about to read a file you do not control the size of (build logs, test logs,
  process stdout, JSONL files).
- A previous read returned truncation / "output cut off" / "use offset to read more".

## When NOT to use

- The output is known to be small (< 100 lines). Just `read` or `cat` it in one go.
- The output is structured (JSON / CSV) and you need the **whole** thing to parse. Read
  it once with a guard ("first 3000 lines"), then if you need more, do a second
  targeted read.
- You are polling for a specific event ("did the file appear yet?"). That is a
  different pattern (`background-task` Skill + `read` with a wait).

## Process

1. **Estimate before reading.** If you do not know the size, use a low-cost probe
   (e.g. `wc -l file.log`, `ls -la file.log`, or `du -h`) to learn the byte / line count
   before reading content. This prevents "oh, 200 MB" surprises.
2. **Pick a chunk policy.** Default:
   - `head -N` for the first N lines (where N ≈ 200) — captures start-of-run errors
     and configuration.
   - `tail -N` for the last N lines (where N ≈ 50) — captures end-of-run status,
     exit messages, final stack trace.
   - `grep -B 2 -A 2 PATTERN` for targeted search — captures context around a known
     error or marker.
3. **Read once, in chunks, do not loop.** Three reads in a single response is
   acceptable; ten is not. After three reads, **stop and synthesize** — re-reading the
   same file in different windows is a sign the data is too noisy for the current
   approach, and the right answer is `ask-user` or `switch` to a different file.
4. **Maintain a cumulative summary as you read.** The summary is what the user sees;
   the raw chunks are scaffolding. After each chunk, append a one-line takeaway to the
   summary. The summary fits in your context; the raw output does not.
5. **Stop when you have enough to act on.** "Enough" means:
   - You can state the file's purpose and current state in one sentence.
   - You can identify any errors or anomalies.
   - You can answer the user's original question, OR you know what you would need to
     read next to answer it (and the next read is targeted, not another dump).
6. **If you cannot stop**, surface to the user with the cumulative summary, the
   question, and the trade-off (read more context? read a different file? ask the user?).

## Output contract

The user sees, in this order:

- One-line estimate of the file / stream size (if probed).
- A cumulative summary in this shape:

  ```text
  Stream summary: <one-line purpose>
  Chunks read: <N> (head 200 / tail 50 / grep 1)
  Key findings:
  - <line N>: <finding>
  - <line M>: <finding>
  Next step: <what to do with the findings, or what to read next if needed>
  ```

- (If you stopped because of step 6) the question and trade-off, not a silent loop.

## Example

```text
> wc -l /var/log/app/today.log
4287 /var/log/app/today.log

> head -200 /var/log/app/today.log
[200 lines read; key entries captured below]

> grep -B 2 -A 5 "ERROR" /var/log/app/today.log | tail -50
[50 lines of error context; summary below]

Stream summary: application startup with a 10-minute error burst at 14:23
Chunks read: 3 (head 200 / tail 50 / grep 1)
Key findings:
- 14:23:00 INFO service starting
- 14:23:14 ERROR connect ECONNREFUSED 10.0.0.5:5432 (database)
- 14:23:14 ERROR retry 1/3 ...
- 14:23:23 ERROR retry 3/3 exhausted; service degraded
- 14:33:00 WARN service continuing in degraded mode (DB read-only)

Next step: investigate why 10.0.0.5:5432 was unreachable at 14:23; the
service is now in a degraded state and the user may need to restart.
```

Counter-example (read too much, lost the thread):

```text
> read /var/log/app/today.log
[4000 lines, ~50K tokens; everything from the read is now in context]

> read /var/log/app/today.log
[duplicate, same 4000 lines]

> read /var/log/app/today.log
[duplicate, same 4000 lines — context is now full of redundant log]
```

The counter-example is the failure mode this Skill prevents. Three reads, no synthesis,
context full, no actionable conclusion.

## Common pitfalls

- **Do not `read` an unbounded file in one call.** Use `head`, `tail`, or `grep` first.
- **Do not loop reads.** Three is a hard cap. After three, you owe the user a
  synthesis, not a fourth read.
- **Do not skip the summary.** The raw chunks are scaffolding; the summary is the
  product. Without a summary, the user has to re-read everything you read.
- **Do not guess from a single chunk.** If the file is structured (timestamps, log
  levels), use grep to anchor on the structure, not just head/tail.
- **Do not re-read the same range.** If `head -200` did not show what you needed, do
  not read `head -200` again; read `grep PATTERN` or `sed -n '200,400p'`.
- **Do not stream to the user's chat verbatim.** The user wants the synthesis, not
  the raw bytes. Stream is for you; summary is for them.

## Verification checklist

- [ ] Did you estimate size before reading (if size was unknown)?
- [ ] Did you use a chunk policy (head / tail / grep) rather than a single `read`?
- [ ] Did you write a cumulative summary as you went, not after?
- [ ] Did you stop after at most 3 reads, even if you did not have the answer?
- [ ] Is the summary one-line purpose + findings + next step, not raw output?
- [ ] Did you surface to the user (with the question) if you could not stop on your own?
- [ ] Did you avoid re-reading the same range?
