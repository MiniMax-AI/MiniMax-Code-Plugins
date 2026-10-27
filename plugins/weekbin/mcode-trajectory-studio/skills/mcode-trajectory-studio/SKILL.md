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

1. `trajectory_list` — find a session. Returns metadata only, newest first. Filter by `agent`,
   `kind`, `parentSessionId`, or `sinceMs`.
   **`parentSessionId` reaches the sub-agent sessions a session dispatched**, and `"root"` gives
   the top-level ones. Every row carries `parentSessionId`, so you will often see a parent that has
   children and then want to look inside them — filter rather than paging the whole machine and
   picking them out, which on a busy machine is several calls over hundreds of rows to find what
   one call returns. It composes with `agent` and `kind`, so "the explore sub-agents of this
   session" is one call. An id that matches nothing returns an empty page; a blank or omitted one
   is no filter at all. `agent` is an **exact, case-sensitive** match against the agent names this
   machine actually used (`Explore` does not match a session stored as `explore`) — read
   the `agents` list on `trajectory_list`'s reply (`{name, count}` entries) rather than guessing.
   It is **not narrowed by the page's filters**, so it is still complete on a reply whose
   `sessions` list is empty — which is what tells you a filter value was wrong rather
   than that the machine is quiet. Each `count` is how many sessions match that name under
   this reply's own `includeArchived`, so it is the `total` you get after filtering on it,
   not a machine-wide tally. Archived sessions are hidden unless you
   pass `includeArchived: true`.
   `sinceMs` is a lower bound; pair it with **`untilMs`** for a range, because "the session from
   March" is a range and a lower bound alone answers it with everything since March. Both take
   **epoch milliseconds**, and the exact shape is on every row: `updatedAtMs` is the same clock, so
   read the format off any reply rather than guessing it. To turn a calendar day into the pair,
   compute local midnight of that day and of the next one and pass them as `sinceMs`/`untilMs` —
   `untilMs` is inclusive, so the day's own sessions are inside the range rather than excluded by
   an off-by-one at midnight.
   **`total` is how many sessions the filter matches, and `nextCursor` is how to reach the rest.**
   A single page is a slice, not the machine: a busy one holds hundreds of sessions and the page holds
   20. When looking for an older session — "last week's", "the one where I touched the parser" — pass
   `nextCursor` back as `cursor` until it is `null` rather than concluding from page one that no such
   session exists. `sinceMs` cannot help here: it only moves the window forward.
   **Do not page these tools by position.** There is no `offset` argument, and the reason is not
   tidiness: the list is newest-first by the same column the runtime rewrites when it writes to a
   session, so a walk by row number silently drops any session that moves while you are walking and
   still reports that it finished. Hand back the cursor verbatim. Every page of one walk describes the
   same instant, `walkPinnedAtMs`, so `total` and the rows agree; a session written to after page one is
   newer than that instant, leaves both the rows and the count, and is found by starting the walk again.
   **A cursor belongs to the walk that produced it** — the same query and the same filters. Handing
   one back after changing `agent`, `kind`, `parentSessionId`, `sinceMs`, `untilMs` or
   `includeArchived` returns page one of the *new* question with a `note` saying so, rather than a
   page that looks like a continuation and is not. Changing `limit` is fine: it decides how much is
   carried, not which rows match.
2. `trajectory_summary` — the dsh `sessionStats` equivalent for one session: `turns`, `steps`,
   `llmMs`, `toolMs`, `decodeMs`, `thinkingMs`, `inputTokens`/`cacheReadTokens`/`totalTokens`,
   `toolCalls`/`toolFailures`, `compactions`, `subagentTasks`, `assets`, and a `sources` breakdown.
   Omit `sessionId` for the most recently updated session. A non-zero `unreadableRows` means these
   totals describe fewer records than `trajectory_get` lists — say so if the two disagree.
   Check `warnings` before reading `subagentTasks`, `backgroundTasks` or `assets`: those are
   counts, so a total that could not be computed still arrives as `0`, and the warning is what
   separates "none ran" from "not counted". `toolMs` is `null` only when it is unavailable.
   **`errorMessage` is present only when the run stopped badly**, and it is the reason — the
   status word alone is not one. A session that failed on its first turn has one message row
   and `turns: 1`, so its numbers all read as "it started and did nothing" while the whole
   story is in this field: `ENOSPC: no space left on device, write`,
   `Mandatory V2 Agent prompt is missing: …`, `BYOK provider … upstream error: …`,
   `Local runtime restarted before this turn completed.` **When someone asks why a session
   failed, read this before reading anything else** — it is the same text `trajectory_list`
   and `trajectory_search` publish on the row, so you never have to page back to the list to
   find out.
   **`objective` is what the run was actually asked to do, and it is not the title restated.**
   The runtime records it in its own table and it was unreachable from here. On a measured
   machine the two share almost no vocabulary in **13 of 15** goal-bearing sessions — one is
   titled 同步本地与远程分支代码 and was asked to 继续深挖当前插件的方方面面可能存在的问题; another is
   titled 查询项目前后端架构 and was asked to 整理并落地一套更好的动画效果集成方案. A reader who infers the
   task from the title is wrong two times out of three, with nothing on any reply to say so.
   **`turnsFailedOrAborted` is how a session that looks clean admits it is not.** A turn that
   fails at intake writes **no message row at all**, so neither `turns` nor `errorMessage` nor
   `warnings` moves when one dies: on a measured machine 7 sessions carry 14 such turns and
   every one of them reads as a finished run with no error. `trajectory_ingress` is where to
   look; `ingressAvailable: false` means this runtime records no intake, and the two counts
   are then `null` rather than `0`.
   **Absent is the common case** (618 of 633 sessions record no goal) and is never the title:
   `goalAvailable: false` means this runtime has no such table, which is a different answer
   again. `goalTokensUsed` / `goalTimeUsedSeconds` are what the goal itself cost.
   **`assets` and `changedTurns` are different facts and neither stands in for the other.**
   `assets` counts files the session *delivered or attached*; `changedTurns` counts its turns that
   *recorded edits*. Measured on a machine where 351 sessions carry change records, **329 of them
   delivered zero assets** — so `assets: 0` is the usual answer for a session that rewrote a
   repository, and where both exist the two counts differ 19 times out of 22, in both directions.
   **Never read `assets: 0` as "the session did nothing."** Check `changedTurns`; when the question
   is about files, pick the tool by which of the two is meant. `changesAvailable: false` means the
   runtime records no change sets at all, so `changedTurns: 0` there means "not recorded", and the
   warning says so as well. **`unmatchedTurns` is the third number and it is not a `warning`:**
   how many of those change sets name a turn no message row carries. Both numbers are correct and
   they do not have to reconcile with `trajectory_turns` — see entry 5. Subtract it before paging
   by `turnId`.
3. `trajectory_turns` — **the progress view.** One row per turn: `turnId`, `count` (records in
   that turn), `llmMs`, `failureCount` (tool calls in that turn that failed), `firstMs` (when the
   turn started) and output tokens.
   **`firstMs` is what makes this a timeline.** The rows are in chronological order, so before it
   existed you could see that turn 40 came after turn 39 and could not say when either happened —
   dating one turn meant paging `trajectory_get` until a record carried a timestamp, which on a
   large session is paging the whole session. Use it to answer "what happened last", "what did I do
   on Tuesday", "which turn was after the deploy". `null` means the source records no time at all
   (an artifact with no timestamps), which is different from `0`.
   **`failureCount` is how you find what went wrong.** `trajectory_summary`'s `toolFailures` is a
   session-wide number with no way to drill into: without the per-turn count, "which turn broke"
   meant paging the whole session and inspecting `toolCalls[].ok` on every record — twenty-two pages
   and 1.4 seconds on a 21992-record session. Page the turns, keep the ones where it is above zero,
   then read those with `trajectory_get`'s `turnId`. It reconciles exactly: summed over every turn it
   equals `trajectory_summary`'s `toolFailures`, on the same terms as `count`/`llmMs` below. A turn
   that made no tool calls reads `0`; `null` means the source does not record failures at all (the
   artifact path), which is a different answer from "nothing failed". Reach for this instead of paging `trajectory_get` to work
   out how a run broke down — that costs one call per thousand records where this costs one call in
   total. `total` is how many turns the session has, so a one-turn page is not mistaken for a
   one-turn run. Summed over every turn, `count`/`llmMs`/`outputTokens` equal the session's
   `events`/`llmMs`/`decodeTokens` from `trajectory_summary`; both `outputTokens` and its alias
   `decodeTokens` are on each row so the reconciliation does not trip over a name.
   **Check `source`.** A session the projection has not indexed yet is folded from its own
   `messages.jsonl`, and there `llmMs`/`outputTokens` are `null` — the artifact recorded no
   duration and no usage, which is not the same as a turn that cost nothing. That path also
   has no `trajectory_summary` to reconcile against, since that tool answers
   `session_not_indexed` for such a session.
4. `trajectory_assets` — **which files, not how many.** `trajectory_summary` reports `assets: N`;
   this is the list behind that count — `path`, `name`, `role`, `sourceTag`, `msgId`,
   `artifactId` — one 2 ms query rather than a thousand event records scanned for paths that are
   already columns. Most sessions produced none, so `total: 0` with `available: true` is an ordinary
   answer. **Check `available` before reading an empty list**: `available: false` with a `note` means
   this runtime exposes no assets table, or the query failed, so the empty list means "not listed",
   not "none exist". `assetType` is null for most real rows — do not read a type into a null, and do
   not infer one from the extension. `path` is folded to `~`.
5. `trajectory_changes` — **what the run actually changed on disk, turn by turn.** The runtime
   records a change set per turn: every file added, modified or deleted, the line counts, and in
   `detailLevel: "full"` the unified diff. This is what answers "what did that session do to my
   code" — the transcript only holds what the agent *said* it did, which is the shape it intended
   rather than the shape that landed. Recorded for sessions that edited a repo and absent for the
   rest, so `total: 0` with `available: true` is ordinary; **`available: false` with a `note` means
   this runtime records no change sets, so the empty list means "not recorded"**. Files inside the
   workspace are stored relative to it and come back absolute; `path` narrows to a substring of the
   resolved path, and `pathMatchedNothing` says a filter found nothing rather than leaving you to
   guess. **Read `scratchFiles`** on the turn, or `matchedScratchFiles` for the session: more than half
   the entries in a real busy turn are temp-dir
   apply scripts, and a reader who is not told will read an 82-file turn as 82 repository edits.
   `status` and `revertedAtMs` are carried through as recorded and carry no signal on any runtime
   measured so far. `diff` is capped per file with `diffTruncated` saying when it was cut.
   **`changedTurns` counts change sets, not turns of the transcript, and they do not have to
   agree.** The runtime writes the two tables independently, so a change set can name a turn no
   message row carries — 307 of 1,417 on a measured machine, 11.8% of every file entry — and on
   7 of 351 sessions `changedTurns` is **larger** than the number of turns `trajectory_turns`
   lists (worst case 165 against 2). **`unmatchedTurns` on either reply is how many of those
   name a turn the transcript lacks**, and `turnInTranscript` on each row says the same per turn.
   They are real edits and stay in the list; use `changedTurns - unmatchedTurns` as the number
   of change sets you can page `trajectory_get` by `turnId` for. A `trajectory_get` by one of
   the unmatched ids returns no events and says why — `sessionTotal` carries the session's own
   record count, so an empty `total` there means "that turn is not in the transcript", not "the
   session is empty".
6. `trajectory_ingress` — **the turns the runtime took in, including the ones the transcript
   never saw.** One row per accepted turn: when it was accepted, in what order, what claimed
   it (`claimSource`), how long it sat in the queue (`queuedMs`), and how it ended (`status`).
   **Reach for this whenever a session reads as clean but should not.** On a measured
   machine 14 turns that **failed or aborted** appear in no message row at all, across 7
   sessions that every other tool reports with no error, no `errorMessage` and
   `warnings: []` — the transcript genuinely does not contain them, so nothing else can
   surface them. `failedOrAborted` is the count that ended badly;
   `missingFromTranscript` is the count the projection does not carry, and the two answer
   different questions — 13 turns on that machine *completed* and are equally invisible, so
   `inTranscript: false` alone does not mean "it died".
   **There is no reason field, because the runtime records none**: the table has sixteen
   columns and none says why a turn failed. This tool says that a turn died and when, never
   why, and a `reason` here would be a guess wearing a field name.
   `claimSource` is the only record of *who asked*: 668 of 2,466 turns on that machine came
   from a thread goal, and 1,603 carry no claim at all — reported as `null`, never attributed
   to the user. Most sessions record none, so `total: 0` with `available: true` is ordinary;
   `available: false` means this runtime cannot tell and `failedOrAborted` is `null`, not `0`.
   `status` narrows to one recorded status while `total` stays the session's own count.
7. `trajectory_find` — find records in **one session** whose text contains a query. Scoped to a
   session because that is where it is cheap: the same search across the whole machine measures
   seconds, while inside one session it is tens of milliseconds. The query is **literal** — `%` and
   `_` are matched as characters, not wildcards. Every hit carries the record's `index` in the same
   numbering `trajectory_get` pages in, so **read the hit with `offset: hit.index`** rather than
   paging to find it; `field` says whether the text was the message (`content`), the thinking, or
   neither (`other`), and on `other` the excerpt is taken from the tool call too, with
   `matchedToolCall` naming which half held the needle — `args` is what the model wrote, `result`
   is what came back. A shell result usually echoes the command line, so both halves often hold the
   same term; the argument wins there, because it is the half that says what was being done. **The parameter is `detailLevel`; `full` is what carries message text** — there is no other
   way to ask for it, and the default `summary` returns records with `contentLength` and no `content`
   at all. Any other value (`'nope'`, `'FULL'`, `detail`, `full: true`) is ignored and the reply comes
   back at `summary` with a `note` saying so; a guess that is not caught by the note looks exactly
   like a session that said nothing. `snippet` comes only in `full` detail, like every other message body,
   and it is quoted **around the match** on both sources — not from the start of the record, so on
   a long message the word you searched for is in it. `unindexedCaseMatch: true` means the session's rows were also folded in
   JavaScript, because the needle holds a non-ASCII letter with more than one case form (`ş`/`Ş`,
   `é`/`É`) and the indexed `LIKE` folds ASCII only. It costs far more than an indexed lookup on a
   big session, and it is not an error — it is the reason a match exists that the index could not
   see. It is absent otherwise, so its presence is the report. A needle with no case variants
   (`轨迹`, plain ASCII) never pays for the scan.
   A session the indexer has not reached yet is searched in its `messages.jsonl` artifact, and the
   reply's `source` says which store answered. `field`, `snippet` and `matchedToolCall` mean the
   same thing there as they do on the projection path, so a hit is not called `content` merely
   for coming off disk — the excerpt and the field describe the same text on either path. On that
   path `total` is `null` by design — the
   fold stops at the page boundary rather than paying for a whole-file count — so **`nextOffset`,
   not `total`, is how you know whether more matches exist**. Page until it is `null` there too.
8. `trajectory_get` — page through records in insert order. Use `offset`/`limit`; narrow with
   `turnId` **or `role`**, and pass `detailLevel: 'full'` for message text. Nothing else returns `content` or
   `thinking`: `summary` gives `contentLength` and omits both, so a reply you did not ask `full` for
   is not evidence the session contained no words. A value outside `summary`/`full` is ignored and the
   reply carries a `note` naming the level actually used. Read `nextOffset` and keep paging when you need the whole session. **A long session
   holds tens of thousands of records, so to read its *end* — "what happened at the end", "how did
   it finish" — do not page there: `trajectory_summary`'s `events` equals this tool's `total`, so the
   last page is one call at `offset: summary.events - limit`. That identity only holds unfiltered;
   under a `turnId` filter `total` is what matched, not the session.**
   **`role` is the filter to reach for before `full`.** Measured on the machine this was written
   against: `assistant` holds 112,290 of 116,304 rows and `user` holds **2,388** — 2.1%. One session
   carried 5,272 assistant records and **9** user ones. Asking "what did this conversation actually
   ask for, and how far did it get" without the filter meant walking all 5,343 and discarding:
   **27 calls and 24.6 MiB** for nine messages, at `full` detail, which is the level you are told
   not to widen to on your own. The same call with `role: 'user'` is **one call, 5.5 KiB, 5 ms.**
   `role: null` asks for the records carrying **no** role — a real group of 1,626 on that machine —
   and is *not* the same as omitting the argument. `total` is always what matched the filter, so a
   walk that reaches `nextOffset: null` has seen every record of that role and no others. Each record carries
   `inputKind` — `human`, `injected`, or `unknown`, and `null` on every non-user role — so you can
   tell a person's own words from context the harness injected. `unknown` means the runtime did not
   classify it; do not fold it into `injected`. Each record also carries `failureCount` and a
   `toolCalls` array where each entry has `name`, `ok`, `status`, the measured `durationMs` (null
   when the runtime recorded no task for that call), `taskId`, `agentName`, `childSessionId`, and —
   in `full` detail — `args` and `result`.
   `hasOutput` says whether the runtime recorded an output file for that call, so
   `trajectory_task_output` has something to read; it is about the *recording*, not about
   whether the call succeeded, and `taskId` is `null` on any call the runtime did not run
   as a background task — which is most calls in some sessions and none in others.
9. `trajectory_search` — full-text search over session ids, titles, agent names, statuses, session
   kinds, workspace paths, and **the per-session `purpose`**. A query is matched as a phrase,
   case-insensitively, inside one field. So `Spec review`
   matches that title and not a session whose title merely holds both words apart; `Documents`
   matches a `workspaceDir` containing it even though the reader typed a capital.
   **`purpose` is why this can be a content search at all.** The runtime writes the objective it
   dispatched a sub-agent with, and the index carries it — so a word from that objective matches a
   session whose *title* never mentions it. On a 633-session machine, 439 rows had one and 194 had
   none: the ones that do not are top-level sessions, and they are matched on their metadata alone.
   So a query drawn from a sub-agent's brief will find it, and the same query will not find a
   top-level session that merely discussed the same thing. That is the limit of the index, not a
   failed search, and the distinction is worth stating when a content query returns nothing.
   **A run's own `objective` is searched too, on a channel that is not the index.** The runtime's
   FTS table has no objective column at all, so this is a separate literal scan of the goal table,
   reported honestly as such: `objectivesIndexed` says whether it ran, rows it found carry
   `objectiveMatched: true` and the matching `objective` text, and `objectiveMatchedSessionIds`
   lists them. On a measured machine **every goal match was invisible to FTS** — five ordinary
   Chinese queries found 13 goal-matching sessions between them and the index found **none** of
   them, 0 of 15 goal-bearing sessions being reachable by a word from their own objective. So a
   query drawn from what a run was *asked* finds it even when its title says nothing about it.
   Objective rows ride on the page but never in `total` or the cursor: the walk is an index walk,
   and a cursor whose meaning depended on which source matched would be unusable. It also works
   with **no FTS5 at all**, which is when a machine can least afford to lose the field.
   **These queries are not selective.** The index covers exactly the columns people reach for, so
   an agent name or a common word can still match most of a machine — on 614 sessions `idle`
   matched 587 and `mavis` 187. `total` is the match count and `nextCursor` is the cursor for the
   rest, so **pass it back as `cursor` until it is null before saying how many sessions match**. A
   first page of 200 is a page, not an answer, and without `total` it was indistinguishable from one.
   Page this tool by cursor, never by row position — see the same warning on `trajectory_list`.
   **Check `ftsAvailable` and `note` before concluding anything from an empty result.** There are
   four reasons for `sessions: []`, and only one of them is "nothing matches":
   - FTS5 missing from the bundled SQLite (22.13.0–22.18.x, and every 23.x) — `ftsAvailable: false`
     with a `note`. That is "search is off", not "nothing matches".
   - the query failed — `ftsAvailable: true`, a `note` saying the search failed, and the result
     means "not searched". Report the failure; do not present it as an absence of matches.
   - this build's index does not carry the fields a match needs — a `note` saying so. Nothing
     was searched, and **retrying will not help**, because the cause is the schema rather than
     this call. Say the runtime cannot search, do not report a failure and do not retry.
   - the query ran and matched nothing — no `note`, and only then is an empty list a finding.
10. `trajectory_tasks` — background tasks and sub-agent dispatches owned by a session, with status,
   wall-clock duration, the command or objective, the sub-agent name, and the child session ID.
   This is the nested view. **The list is newest-first and paginated**: `total` is what the session
   owns, `returned` is what this page carried, and `nextOffset` is the cursor for the rest. A single
   page is the newest slice, not the whole list — `trajectory_tasks.failed` and `.subagents` count
   only the records this reply carried.
   **Check `tasksAvailable` before reading `total: 0`.** `true` means this session dispatched
   nothing; `false` means this installation has no task table at all and the question was never
   answered — a projection without one is not unusual on older runtimes, and the two answers
   look identical otherwise. `warnings` on this reply carries anything the store said while
   answering, including `task_count_failed`, whose whole text is that a `0` means "not counted".
11. `trajectory_task_output` — the tail of one task's captured output (bounded, `maxBytes` defaults
   to 16384). Use it to explain a failure without opening the session directory by hand.
   `available: false` with an empty `text` is a **successful** answer meaning no output was
   captured — not an error.
   **`bytes` is the size of the file on disk, not of what came back** — so on a truncated
   read it is far larger than the `text` you hold, and the amount you hold is
   `min(bytes, maxBytes)`. Do not read a long `bytes` beside a short `text` as a
   contradiction. `truncated: false` means you have the whole file; `truncated: true` means
   you have its last `maxBytes` bytes and nothing older. The text also passes a credential
   sweep on the way out, so its length is not the file's length either way — which is why
   `bytes` is the only size worth reading.
   **That sweep bounds the text at 64000 characters, and what it drops comes off the
   *front*.** So the text still ends where the log ends: raising `maxBytes` gives you more
   of the newest output, never less, and a `… [truncated N chars]` line at the end is how
   you know characters were dropped from the older end rather than the newer one.
12. `trajectory_studio` — start the local web panel and return its URL.
13. `trajectory_agent` — what a session was **configured with**: model, tool allowlist and denylist,
   MCP servers, skills, system prompt and project. It answers `present: false` for a session the
   runtime dispatched without an explicit definition, which is itself worth reporting: most
   sessions do carry one. Use this instead of opening the panel — the panel draws the same data for
   a human, but this is one call and stays in the conversation.

## A session id that names nothing is an error, not an empty session

Every tool that takes a `sessionId` refuses an id that matches no session, with
`session_not_found:<id>`. A typo, or an id remembered wrong, used to come back as the empty result
of a quiet session — `trajectory_find` reported `total: 0` for a session it had never searched.
**Never present an empty list from one of these tools as "that session had nothing in it."** The two
answers cannot both be true, and the error is how you tell them apart.

Two neighbouring cases that are *not* that error. A session the projection has not indexed yet is
read from its own `messages.jsonl` by `trajectory_get` and `trajectory_find`, and the reply's
`source` is `jsonl` — but `trajectory_summary` cannot fold timing or tokens out of a file that
never recorded them, so it answers `session_not_indexed:<id>` rather than a row of nulls.
And omitting `sessionId` means the most recently updated session, where an **empty string** is a
value you supplied and is refused rather than treated as "the latest".

## A session with no records is not a session that did nothing

There is a third case, and it is the one most likely to be reported wrongly. The projection
stores a **session row** for every session the runtime has heard of, and **message rows** only
for the ones it has indexed — two separate decisions. A session can have the first and not the
second, and when it does, every number the tools return is a correct count of nothing:
`trajectory_summary` gives `turns: 0, steps: 0, toolCalls: 0`, and `trajectory_get` and
`trajectory_turns` give `source: 'sqlite', total: 0`. Nothing is flagged, because nothing was
read and there is no error to raise.

So **check `recordsUnavailable` before reporting any session as empty, or before believing that
a search found nothing in it.** It appears on `trajectory_summary`, `trajectory_get`,
`trajectory_turns` and `trajectory_find` when the session row exists, the
projection holds no rows for it, and there is no `messages.jsonl` beside it either. That is a
statement about *this machine's records for this session*, not about the session's own output —
the work may well have happened and been lost, been pruned, or never indexed. On the machine
this was found on, 18 sessions were in this state, the oldest 128 days old and 9 of them
archived, several titled after work that plainly happened.

`trajectory_find` is where this bites hardest. **A `total: 0` from a search is the one answer
that cannot be taken at face value**, because "the query is absent from this session" and "no
record was ever searched" produce the identical reply. The tell is that the count does not move
with the query: on the machine above, `the` matches 22,207 records of a real session and zero of
an unreadable one.

The neighbouring case on the same session has its own field. When the projection has no rows but
the artifact **is** on disk, `trajectory_get` and `trajectory_turns` read it and answer
`source: 'jsonl'`; `trajectory_summary` still folds only the projection and so reports zeroes,
marked **`recordsInArtifact: true`**. That is not a contradiction to be resolved but a limit to
be stated: read the records with `trajectory_get`, and do not expect timings or token totals,
because an artifact never recorded them. Both fields are absent when records were read normally.

## Every list can be partial — read the completeness fields

These tools are bounded on purpose: a reply that quietly dropped records would describe an
incomplete read as a complete one. Each record list therefore carries fields saying what it left
out, and **an answer that ignores them can be confidently wrong**:

| Field | On | Means |
|---|---|---|
| `truncated` / `omitted` | every list | records were dropped from this reply; `omitted` counts them |
| `nextOffset` | `trajectory_get`, `trajectory_find`, `trajectory_turns`, `trajectory_tasks`, `trajectory_assets`, `trajectory_changes` | the cursor for the rest; `null` means you have them all |
| `nextCursor` | `trajectory_list`, `trajectory_search` | the cursor for the rest, passed back as `cursor`; `null` means you have them all. It belongs to the walk that produced it — pass it back with the same query and filters, or a `note` says the walk restarted |
| `note` | every tool | **something in the call did not do what you asked.** Read it before quoting numbers: a paging argument the tool does not take (`cursor` given to one of the five that page by `offset`, or `offset` to `trajectory_list`/`trajectory_search`) is ignored, so that reply is the **first page** however the argument read. A note can carry two facts — this one and the level actually used — and they are joined with `;`, so both must be read |
| `walkPinnedAtMs` | `trajectory_list`, `trajectory_search` | the instant every page of one walk describes, so `total` and the rows agree. A session written to after page one is newer than it and appears in neither — start the walk again to see it |
| `total` | `trajectory_list`, `trajectory_search`, `trajectory_turns`, `trajectory_assets`, `trajectory_changes` | how many the query or filter matches, independent of the page — compare against what you have paged through before concluding one does not exist. On `trajectory_changes` it stays the session's own change-set count even under a `path` filter, so the narrowing stays visible |
| `pageBytesTruncated` | `trajectory_get` | the read stopped early on the byte budget — nothing was omitted *from what was read* |
| `sessionTotal` | `trajectory_get` | **only when a filter matched nothing** — the session's own record count, so an empty `total` means "your filter is wrong", not "the session is empty" |
| `droppedOversized` / `malformedLines` | `trajectory_get` | records that exist on disk but could not be delivered |
| `taskIndexTruncated` | `trajectory_get` | the session owns more tasks than the index holds; older tool calls carry no timing |
| `ftsAvailable` | `trajectory_search` | whether search can run at all |
| `objective`, `goalAvailable`, `goalStatus`, `goalTokensUsed`, `goalTimeUsedSeconds` | `trajectory_summary` | what the run was asked to do, which is **not** the title — they share almost no vocabulary in 13 of 15 real pairs. Absent means no goal was recorded (the common case), never the title; `goalAvailable: false` means this runtime records none |
| `objectivesIndexed`, `objectiveMatched`, `objectiveMatchedSessionIds` | `trajectory_search` | whether the recorded objectives were searched, which rows they reached, and which field a row matched on. The runtime's index carries no objective column, so this is a separate literal scan — the only way to find a run by what it was asked rather than what it is called |
| `recordsUnavailable` | `trajectory_summary`, `trajectory_get`, `trajectory_turns`, `trajectory_find` | **the session exists and its records are not readable anywhere** — so every `0` in that reply counts nothing, and must not be reported as what the session did |
| `recordsInArtifact` | `trajectory_summary` | the projection had no rows but `messages.jsonl` does; the fold saw neither, so read the records with `trajectory_get` and expect no timings |
| `warnings` / `warningsDropped` | `trajectory_list` | reads that failed while building this answer — a `<what>_failed:` prefix and a note that a `0` in the same answer means "not counted", not "none" |
| `warnings` | `trajectory_summary` | an aggregate that could not be computed, so its `0` is not a finding |
| `turnsFailedOrAborted` / `turnsMissingFromTranscript` / `ingressAvailable` | `trajectory_summary` | accepted turns that ended badly, and accepted turns the transcript does not carry. `null` when the runtime records no intake — **never `0`**, which is the clean bill of health these exist to withhold. On a measured machine 14 dead turns sit in 7 sessions that report no error and no warnings |
| `statusCounts` / `claimCounts` / `inTranscript` / `queuedMs` / `claimSource` | `trajectory_ingress` | how the accepted turns ended, what claimed each one, whether the transcript carries it, and how long it waited. `claimSource: null` is an absent answer, not "the user"; `inTranscript: false` is not "it died" — 13 completed turns are equally invisible |
| `unmatchedTurns` / `turnInTranscript` | `trajectory_summary`, `trajectory_changes` | how many of the session's change sets name a turn the transcript does not carry, and the same fact per row. `changedTurns` counts change sets and `trajectory_turns` counts the turns its records name; the runtime writes the two independently, so on a measured machine `changedTurns` exceeds the turn total on 7 of 351 sessions. Both numbers are correct, the change sets behind this one are real edits, and it is deliberately **not** a `warnings` entry. Subtract it before paging `trajectory_get` by `turnId` |

When one of these is set, say the answer is partial **before** giving the numbers. If the user needs
the whole session, page until the tool's cursor is `null`.

## When a tool fails

A failed tool returns `isError: true` with a short code as its text. These are the ones you will
meet, and what each actually means:

| Code | Means |
|---|---|
| `unknown_session_id` | you passed an empty session id — fill the variable, do not retry empty |
| `invalid_session_id` | the session id was not a string |
| `session_not_found:<id>` | no session with that id exists at all; re-read `trajectory_list`, it may have been mistyped or archived |
| `session_not_indexed:<id>` | the session exists but the projection has not reached it yet, so its records are only in `messages.jsonl` — `trajectory_get` and `trajectory_find` still read it, but there are no timing or token totals to fold. Retry later rather than reporting the session as missing |
| `no_sessions_available` | the projection holds **no sessions at all** — a data-source problem, not a bad query |
| `unknown_tool:<name>` | you called a tool that does not exist; the thirteen above are the whole set |
| `studio_unavailable` | the panel could not start; the other twelve tools still work |
| `invalid_task_id` | the task id does not have the expected shape |

None of these mean "the session had no activity". That is a different claim, and `trajectory_get`'s
`source` field is what tells the two apart.

## Answering common questions

- **"How long did this session take?"** → `trajectory_summary`, then report `llmMs`, `toolMs`,
  `decodeMs`, and `steps`. Say that `llmMs + toolMs` is the machine time, not wall-clock elapsed.
- **"Why is it slow?"** → compare `llmMs` against `toolMs`; if tools dominate, call
  `trajectory_tasks`. **That list is newest-first and paginated**, so one page is a slice and not a
  ranking: before you call anything "the slowest", page on `nextOffset` until it is `null` (or say
  plainly that you are reporting the slowest of the newest `returned` of `total`).
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
- **"How was this session configured?"** → `trajectory_agent`. It returns the model, tool allowlist
  and denylist, MCP servers, skills, system prompt and project — the same data the Studio panel
  draws in its `Agent 与能力` panel, in one call and without sending the user to a browser. A
  session dispatched without an explicit definition answers `present: false`, which is a real
  finding rather than a missing read; offer the panel only when the user wants to browse rather
  than to know.
- **"Which files did this session deliver / hand back?"** → `trajectory_assets`. Delivered, **not
  edited** — for "what did it change" the answer is `trajectory_changes`, and `trajectory_summary`
  reports the two counts separately for exactly this reason. `trajectory_summary.assets`
  is the count and this is the list. Only a session that delivered or attached a file has any, so
  `total: 0` is the usual answer and a short list is normal; check `available` before reporting
  "nothing was produced" from an empty list. `path` is folded to `~`, so quote it as given rather
  than reconstructing an absolute path.
- **"What did this session actually change?"** → `trajectory_changes`. Reach for it **before**
  `trajectory_get` and before the panel whenever the question is about effect rather than
  narrative: it returns the files, the line counts and the real diff in one call, while the
  transcript carries only the agent's account of its own edits. Report `scratchFiles` when you
  quote a file count — on a real session more than half the entries are temp-dir apply scripts,
  so an 82-file turn is usually five repository edits. `matchedFiles` and `matchedScratchFiles`
  on the reply are **session-wide** over everything the filter matched, not this page's counts.
  Narrow a busy turn with `path` rather than by reading every diff, and add `detailLevel: "full"`
  only once you know the file. **When a question needs the transcript for a changed turn, subtract
  `unmatchedTurns` from `trajectory_summary.changedTurns`** — the rest name turns the transcript
  does not have, so `trajectory_get` with those ids returns nothing.
- **"How many turns?" / "which turn was expensive?"** → `trajectory_summary.turns` for the count,
  then `trajectory_turns` for the per-turn breakdown. Do not page `trajectory_get` to rebuild it.
- **"Where did the context go?"** → `trajectory_get` and read each record's `contextUsage`. The
  breakdown is `contextUsage.components`, an array whose entries carry a `kind` and a `tokens`
  count. The kinds observed in practice are `SYSTEM_PROMPT`, `MEMORY`, `TOOLS`, `SKILLS`,
  `MESSAGES` and `OTHER` — `OTHER` is present on essentially every record, not a rare leftover,
  so a breakdown that ignores it will not add up to `usedTokens`. Read `kind` off each entry
  rather than matching against a fixed list: the set belongs to the runtime, not to this tool.
  **Where a breakdown exists it sums exactly to `usedTokens`, so treat a mismatch as a fact
  about the data rather than something to reconcile. The case to watch is the opposite one:
  `components` can be an empty array while `usedTokens` is a real number** — measured across
  102,748 records on this install, 11 look like that, and every one of them carries
  `contextUsage.totalCountSource: 'LOCAL_ESTIMATE'` instead of the usual
  `'PROVIDER_USAGE_ANCHORED'`. That field is the one to read before explaining where the
  context went: an empty breakdown with a `LOCAL_ESTIMATE` total means the runtime could not
  attribute the tokens, not that the context was unused.

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
   "面板凭据无效" banner, the URL lost its fragment — reopen the URL the tool **already returned**,
   verbatim, fragment included. Do **not** call `trajectory_studio` again to "refresh" it: while the
   panel is running that call is idempotent and hands back the byte-identical URL, so you would loop
   on the same token and may report a restart that did not happen. A genuinely new capability
   requires stopping the panel first — `trajectory_studio` with `stop: true`, then calling it again.
   If no browser capability is available, give the user the URL and say the panel is running locally.
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
  Read `trajectory_get`'s `source` before describing an empty result: `sqlite` (the projection read
  the session and it has no rows), `jsonl` (read from the session's own artifact — timings are absent
  by construction, and `malformedLines`/`droppedOversized` count lines that could not be read),
  `unavailable` (no artifact for that session), or `error` (the read failed, with `error` beside it).
- **Time-to-first-token is not persisted by the runtime.** `trajectory_summary.ttftMs` is always
  `null` and must be reported as unavailable, never estimated.
- `decodeMs` is an approximation: `Σ(request_duration_ms − thinking_duration_ms)`.
- If `trajectory_list`'s `sqlite` boolean is false, say so plainly instead of reporting empty results
  as "no activity". (That field is named `sqlite` on the tool surface; `sqliteAvailable` is the
  `--doctor` and panel spelling, and neither of those is reachable from a tool call.)

## Boundaries

- Read-only: never edit, move, or delete anything under the session directories.
- The SQLite tables are an internal runtime detail. Missing tables or fields degrade to `null`;
  do not treat an absent field as proof that the event did not happen.
- Report what the tools returned. Do not infer message text from a `contentLength`.
