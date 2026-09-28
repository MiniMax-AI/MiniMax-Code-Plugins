**English** | [简体中文](README.zh-CN.md)

# MCode Trajectory Studio

> A read-only flight recorder for local MiniMax Code sessions, backed by the runtime's own
> SQLite projection, with an interactive local Studio panel.

MiniMax Code's local runtime mirrors every session into a SQLite projection at
`<dataDir>/v2/sqlite/runtime-state.sqlite`. This Plugin reads that projection strictly read-only
and turns it into structured trajectory summaries plus a browsable timeline — so you can answer
"how long did this take", "where did the time go", "which tools ran and which failed", "how many
turns and steps", "where did the context budget go", "when did compaction run", and "which
sub-agents were dispatched" — without opening the raw session files.

## Try it

```text
Use the mcode-trajectory-studio skill to summarize my most recently updated session:
turns, steps, LLM versus tool wall-clock time, tool failures, and compactions.
```

Expected result: the agent calls `trajectory_summary`, reports the folded statistics, and names
`ttftMs` as unavailable rather than estimating it.

```text
Open the Trajectory Studio panel for that session so I can look at the timeline myself.
```

Expected result: the agent calls `trajectory_studio`, receives a `127.0.0.1` URL carrying a
per-process capability fragment, and opens it verbatim in the host browser. The panel shows a time
overview, a per-turn record table, an inspector for each record, filters, and the background-task
list.

## Capabilities

| Tool | Purpose |
|---|---|
| `trajectory_list` | Recent sessions with non-content metadata; filter by agent, kind, or time |
| `trajectory_summary` | dsh `sessionStats`-equivalent fold: turns, steps, `llmMs`, `toolMs`, `decodeMs`, tokens, tool calls and failures, compactions, sub-agents, assets, trigger sources |
| `trajectory_get` | Paged trajectory records; `summary` or `full` detail |
| `trajectory_search` | Full-text search over titles, agents, statuses, and workspace paths |
| `trajectory_tasks` | Background tasks and sub-agent dispatches with status, duration, command or objective, sub-agent name, and child session ID |
| `trajectory_task_output` | Bounded tail of one task's captured output |
| `trajectory_studio` | Start or stop the local Studio panel. The only tool here that is **not** read-only: it opens a loopback listener and mints a capability, so a client must prompt rather than auto-approve |

The Studio panel is built as a narrative rather than a stack of rows. Each surface answers one
question and does not repeat another surface's answer:

| Surface | Answers |
|---|---|
| **Agent 与能力** | What was this session configured with — model, tool allowlist, skills, system prompt |
| **统计条** | What are the session totals — turns, steps, LLM/tool/decode wall-clock, tokens, failures |
| **时间轴** | Where in time did it happen — navigation and zoom only, no text |
| **轨迹流** | What happened — one scannable line per message and per tool call |
| **检查器** | The full detail of exactly one selected row |

- **Sidebar** is a minimal tree. Sessions group by **git repository**, not by path:
  `git rev-parse --git-common-dir` folds every worktree of one project into a single collapsible
  group, so a long-lived repository does not fragment across the sidebar. Directories outside a git
  tree fall back to path grouping. **Sub-agent sessions nest under the session that dispatched them**,
  recursively, with a caret to expand — so a fan-out reads as a tree instead of a flat list of
  look-alike task sessions. Rows carry only a caret and a title; agent, branch, workspace and age
  live in the tooltip, and expansion state persists across reloads.
- **Timeline** uses three lanes sharing one zoomable axis — `INPUT` (human messages in blue,
  harness-injected context in violet), `MODEL` (requests split into thinking and output segments)
  and `TOOLS` (measured task spans in orange, gaps derived from record spacing in grey and labelled
  as derived). Wheel zooms, drag pans, double click resets.
- **Sidebar rows toggle on the whole row**, not just the caret: clicking a collapsed parent
  selects and opens it, clicking the selected open parent closes it. The agent filter is a dropdown
  whose options are read from the data (`mavis`, `verifier`, `explore`, … as configured on that
  machine), because sub-agent presets differ per install.
- **Stream** merges messages and tool calls into one narrative: `TOOL bash ▸ {payload} ⇉ {result}`
  with the measured duration, an agent badge for sub-agents, and a one-click jump into the
  sub-agent's own session. Injected context is visually distinct from things the user typed.
  Filter by human input, injected context, tool calls, or failures only; filter by turn ID or text.
- **Themes**: light and dark, defaulting to the OS preference and switchable with one click.
  Compact 2px radii throughout, and thin scrollbars via both the standard properties and the
  WebKit pseudo-elements.
- **Turn headers lead with a human ordinal** (`第 3 轮`) and keep the runtime's turn ID as
  secondary text.
- **Performance**: the stream renders 150 rows and appends the next batch as you scroll, rows are
  cached and filtering never rebuilds the DOM, text filters are debounced, and turn totals are folded
  server-side so a paged view still shows whole-turn numbers. A session switch on a 600-row session
  went from ~700 ms with 227 ms main-thread stalls to ~120 ms with none. Very large sessions
  (10k+ records) had a separate problem: the statistics fold re-parsed every row's JSON in a
  correlated subquery, so it now expands `tool_calls` in a single join and caches folded totals
  against the session's `updated_at_ms` — a revisit costs 1 ms instead of 383 ms. Records are
  paged from the server (200 at a time) instead of fetching 1000 with full content up front, and
  the timeline reads a separate compact projection so the axis always covers the whole session.
- **Inspector** is tabbed: 概要 (hierarchy, status, token usage, context split), 载荷 (tool arguments
  or message body), 结果 (result text plus a **failure evidence** block), 计时 (recorded instant,
  request/thinking/decode time, and whether the tool duration was measured or absent), and Schema.
- **Failure localisation** is first-class: the header carries a `⚠ N 处失败（定位）` jump, the stream
  marks each failure inline, and the result tab separates **hard** failures (Traceback, stderr,
  `is_error`) from **soft** ones (a non-zero exit code, which is often just `grep` finding nothing).
  A call can report success while its output contains a Traceback, so the classification reads the
  text, not only the status code.

## What this reads

| Source | Path | Used for |
|---|---|---|
| SQLite projection | `<dataDir>/v2/sqlite/runtime-state.sqlite` | Primary. Opened `mode=ro`; never written. |
| Session artifact | `<dataDir>/v2/sessions/YYYY/MM/DD/<stamp>-<id>/messages.jsonl` | Fallback for sessions the projection has not indexed, and for content when a projection field is absent. |

`<dataDir>` resolves in this order: `MINIMAX_DATA_DIR`, `MAVIS_DATA_DIR`, then `~/.minimax` —
where `~` is `HOME`, or `USERPROFILE` on Windows. Nothing about the location is baked in.

Inside the data directory the Plugin tries the canonical layout first —
`v2/sqlite/runtime-state.sqlite` and `v2/sessions` — and falls back to a short list of
alternative layouts before giving up, so a build that arranges its files differently is still
readable. A hit outside the canonical layout is reported as a warning rather than passing
silently, and `--doctor` prints the path that was actually opened on this machine.

### Fields worth knowing

- `usage.request_duration_ms` — per-request model wall-clock time (`llmMs`).
- `thinking_duration_ms` — thinking-phase duration per record.
- `tool_calls[].tool_call_args`, `tool_call_result_data`, `tool_call_status` — tool input, output,
  and status (a status other than `2` did not succeed).
- `local_runtime_background_tasks` — `created_at_ms`/`ended_at_ms` give exact tool and sub-agent
  wall-clock time (`toolMs`).
- `kind: compaction` records carry `messagesBefore`/`messagesAfter` and `tokensBefore`/`tokensAfter`.
- `context_usage.components` — per-request split of SYSTEM_PROMPT / MEMORY / TOOLS / SKILLS / MESSAGES.
- `source` — what triggered the model call: `api`, `thread-goal`, `questionnaire`,
  `background-task`, `task`, `agent`, `greeting`.
- `local_runtime_sessions_fts` — FTS5 index over session metadata.

## Honest limitations

- **Time-to-first-token is not persisted by the runtime.** `ttftMs` is always `null` and is never
  estimated. The Studio overview uses a thinking segment versus output segment instead.
- **`decodeMs` is an approximation**: `Σ(request_duration_ms − thinking_duration_ms)`.
- The `local_runtime_*` tables are an internal runtime detail. Every optional table, column, and
  JSON field is probed before use and degrades to `null`; a future runtime change should reduce
  fidelity rather than break the Plugin. If SQLite is unreadable the Plugin falls back to
  `messages.jsonl`, where timing fields are absent.
- Tool wall-clock time is only available for calls that the runtime recorded as background tasks;
  `toolMs` therefore covers those, not every inline call.
- The projection indexes sessions as they are written. A very recent session may not be present
  yet; the JSONL fallback covers that case.
- **SQLite needs write access to the *directory*, even for a read-only connection**, because a WAL
  database requires its `-shm` file to exist. On a read-only mount, or when the data directory
  belongs to another user, the projection cannot be opened: the Plugin reports
  `sqlite_unavailable:attempt to write a readonly database` and falls back to `messages.jsonl`,
  where the timing fields are absent. Reading a live WAL database that another process is writing
  works normally.

## Privacy

- The Plugin is **read-only**: it never writes to, moves, or deletes session storage, and it creates
  no files of its own. It holds no state on disk at all.
- The Studio panel **binds `127.0.0.1` only**, and the address is a constant with no override — no
  environment variable, argument, or config key can widen it.
- Every API route requires a **capability token**, minted fresh per process with 256 bits of CSPRNG
  entropy and handed to the caller in the URL's fragment (`#t=…`). It lives in memory for the life of
  the MCP server process and is never written anywhere. Two consequences worth knowing:
  - The fragment never reaches the server, so the capability stays out of request logs, out of
    `Referer` for asset requests, and out of anything the server can echo. Open the URL **exactly as
    returned** — a URL without `#t=…` loads the page shell and no data.
  - mcode runs one MCP server per session, so two sessions get two panels with two capabilities, and
    one session's URL cannot open the other's panel.
- The Host check, the Origin check, and the `Sec-Fetch-Site` check are retained, but they are
  cross-site request forgery defences, not authorization: they stop a web page, not a local process.
  The capability is what stops a local process. Static assets ship a deny-by-default CSP
  (`script-src 'self'`, no inline script, no remote origin) and every node the page renders is built
  with `createElement` and written with `textContent` — a session body is text, never markup.
- `summary` detail returns no message text, thinking, tool arguments, or tool results.
- `full` detail is opt-in and passes through a **two-tier** secret redactor. The shape a credential
  actually takes on disk is a JSON document stored inside a JSON string — tool results live in
  `tool_call_result_data` as *text* (109,462 of 118,109 rows in a real projection) — so it reaches the
  redactor escaped, as `{\"api_key\":\"…\"}`:
  - **Tier A (structured).** A string value that parses as JSON is walked again as structured data and
    judged by key name. The string is rewritten only when a redaction actually fired, so the JSON tool
    results in the panel are never reformatted to protect nothing.
  - **Tier B (escape-aware text rules).** The key/value rule tolerates any number of backslashes on
    either delimiter and re-emits them, so it also fires on text that is not valid JSON at all
    (truncated, or interleaved with prose).
- The text rules cover private key blocks, credentials inline in a connection string (including a
  password that itself contains `@`), the whole `Authorization` header, a bare scheme and token,
  provider-prefixed keys (`sk-`, `ghp_`, `glpat-`, `xox*` …), length-anchored tokens (`github_pat_`,
  `npm_`, `hf_`, Google `AIza`, `ya29.`), AWS key ids, an Azure `AccountKey=`, an unlabelled JWT, and
  key/value pairs.
- Credential *keys* are matched by word boundary rather than by an exact name list, so camelCase
  variants such as `clientSecret`, `refreshToken`, `accessToken`, `authToken`, `apiSecret` and
  `xApiKey` are redacted too, while counters (`inputTokens`) and addressing identifiers (`sessionId`)
  survive. Task descriptions and commands are redacted at the data source, and session titles have
  credential substrings removed in place. Every outbound payload is swept once more at the boundary,
  and the MCP **error branch goes through that same sweep** — an egress that is only redacted when it
  succeeds is not a boundary.
- The rules are **idempotent**: text swept three times (data source, per record, egress) equals text
  swept once, so a marker cannot grow a character per pass.
- **Personal data is masked only on the egress that leaves the machine.** An MCP result reaches a model
  context, so that sweep also masks e-mail addresses and phone numbers. The panel is the reader's own
  screen, where masking a customer's address would destroy the answer they opened it for, so the panel
  stays faithful.
- **Path folding.** The home directory, the data directory (`MINIMAX_DATA_DIR`, including a deployment
  that places it outside the home directory) and any extra root named in
  `MCODE_TRAJECTORY_REDACT_ROOTS` are collapsed to `~` **wherever they appear** — inside a warning
  string, and in the doubled-backslash form a Windows path takes inside a JSON column. Another
  account's home keeps its shape and loses the name (`/home/<user>/…`). That setting can only fold
  more, never less, so it is not a configuration surface that can weaken anything.
- Responses are **bounded by total size, not only per string**: an event page is trimmed to a byte
  budget and reports `truncated`/`omitted` so the client pages on `nextOffset` instead of assuming it
  received everything. That budget applies to **every record-list tool** — `trajectory_tasks` with
  `limit: 2000` was the one that could still return tens of megabytes — and to the panel's task list.
  The cursor is the first record the caller did **not** get, not the first one the server read, so a
  trimmed page resumes where it actually stopped instead of skipping the records in between.
- The SQLite read also has a **per-row ceiling** (8 MiB), measured in **UTF-8 bytes**: a row past it
  is reported as `oversized` with its byte count rather than parsed into the process or silently
  dropped. (`length()` on a TEXT column counts characters, so the test is cast to BLOB — otherwise a
  row of 4-byte code points passes the cap at a quarter of its real size.)
  A JSONL record with no newline can never grow the read buffer past the 2 MiB line cap — the buffer is
  capped as chunks arrive, not after the fact — and lines dropped by that cap are reported in
  `droppedOversized`.
- The **JSONL fallback pages like SQLite does**, rather than re-reading the artifact from the top and
  reporting the first page as the whole file. Its `total` is `null`: the fold stops one record past a
  full page, so it never counts the file it deliberately did not read.
- Diagnostics are bounded too: `warnings` keeps the most recent 64 entries and reports how many were
  dropped in `warningsDropped`.
- Filesystem containment canonicalizes every traversed component, refuses a symlinked final
  component, and — on Linux — re-verifies the opened descriptor via `/proc/self/fd` so an intermediate
  directory swapped between canonicalization and open is refused. Where `/proc` is unavailable
  (macOS, Windows) that residual race is the documented, accepted limit: it needs a same-UID process
  to win a microsecond window, and such a process can already read the file directly.
- The one place the Plugin runs an external command is `git rev-parse` (used to fold one repository's
  worktrees into a single group). It receives an **allowlisted environment** rather than the whole
  `process.env`, so no credential the host exports is inherited, and `core.fsmonitor` and the
  credential helper are fixed off. (Measured: an `alias.rev-parse` planted in a repository's own
  `.git/config` cannot shadow the builtin.)
- Nothing is uploaded anywhere; there are no network destinations and no telemetry.

### Known limits

Stated plainly, rather than left to look covered:

- The redactor recognises credential **shapes** and credential-named **keys**. A high-entropy string
  with no label and no provider shape is not a credential to it.
- PII masking covers e-mail addresses and phone numbers only, and only on the MCP egress. Names,
  postal addresses and customer names are out of pattern range.
- An absolute path under a root you did not configure (say `/mnt/customers/<account>/…`) is returned
  verbatim — including `workspaceDir` in `summary` detail. Add it to `MCODE_TRAJECTORY_REDACT_ROOTS`
  to fold it.
- **The panel capability travels into the session transcript with the tool result.**
  `trajectory_studio` returns the URL carrying `#t=…`, the runtime persists tool results in session
  storage, and the context is sent to the model service on later turns. What contains it is that the
  capability is **process-scoped** (it exists only in that MCP server's memory) and the panel is
  loopback-only, so it is unreachable once the process ends. If you want no capability in a model
  context at all, start the panel yourself with `node server/main.mjs --serve` — the URL is then
  printed only to your terminal.
- `--doctor` prints the data directory and the database path verbatim on purpose: it is the diagnostic
  you read and decide whether to share, and folding those paths would remove what makes it useful.


## Requirements

- MiniMax Code 0.4.0+ (`mcode`) with Agent Plugin and MCP support.
- **Node.js 22.13.0 or newer** on `PATH` — the hard floor, because `node:sqlite` only exists, without
  `--experimental-sqlite`, from that release. Below it the Plugin exits with that sentence rather than
  a module-resolution error.
- **Verified range: `>=22.19 <23 || >=24 <27`** — the same range mcode itself declares in its
  `engines` field. The Plugin mirrors it rather than inventing its own, so the two can never disagree.
- **Full-text search additionally needs FTS5 in the bundled SQLite**, which is *not* monotonic in the
  Node version — measured:

  | Node | Bundled SQLite | FTS5 |
  |---|---|---|
  | 22.12.0 | — | `node:sqlite` absent entirely |
  | 22.13.0 | 3.47.2 | absent |
  | 22.15.0 | 3.49.1 | absent |
  | 22.19.0 | 3.50.4 | present |
  | 22.21.1 | 3.50.4 | present |
  | 23.4.0 | 3.47.1 | absent |
  | 23.11.0 | 3.49.1 | absent |
  | 24.0.0 | 3.49.1 | present |
  | 24.19.0 | 3.53.3 | present |

  Inside the verified range FTS5 is always present, so `trajectory_search` works. In
  22.13.0–22.18.x and all of 23.x the Plugin still runs, but search degrades to no matches with an
  explicit warning instead of throwing.
- The Plugin ships **no dependencies and no native module**, so it adds no ABI constraint of its own.
  mcode writes the projection with `better-sqlite3` (a native module bound to one Node ABI); the
  Plugin reads that same SQLite file with the runtime's built-in `node:sqlite` instead of a second,
  differently-bound copy. Only SQLite's own on-disk format is shared.
- A local runtime with the v2 SQLite projection, or v2 session artifacts for the fallback path.
- A host browser capability for automatic panel opening; without it the panel URL still works.

### Supported platforms

- **Linux** (`x86_64`, Node.js 24.19.0, mcode 0.4.12) — the full test suite, the MCP handshake and
  the Studio panel were exercised there.
- **macOS and Windows** — the whole suite was run on `windows-latest` and `macos-latest` during
  this review round, with 0 failures on both (see the evidence table below for the exact numbers and
  for what that first non-Linux run found). No platform-specific handling is needed: paths go
  through `node:path`, the home directory resolves
  from `HOME` or `USERPROFILE`, `git` is invoked with `execFile` and an argument array rather than
  a shell, and the SQLite driver is Node's built-in `node:sqlite`. Node.js 22.13.0+ is required on
  every platform. Worth noting for anyone reading the test suite: its first run off Linux found
  three platform assumptions, all of them in the tests rather than the Plugin — a temporary path
  compared before canonicalization (`/var` on macOS, a short `RUNNER~1` path on Windows), a
  POSIX-only assertion about a resolved data directory, and a temporary directory removed while
  SQLite still held the file open (`EBUSY` on Windows, harmless on POSIX).
- The Node matrix above was measured by running the Plugin's own suite on each release, not inferred
  from release notes. Those runs reported **115 pass / 0 fail** on 22.19.0, 22.21.1, 24.0.0, 24.16.0
  and 24.19.0, and **114 pass / 0 fail / 1 skipped** on 22.13.0, 22.15.0, 23.4.0 and 23.11.0 — the
  single skip being the FTS5 search test, which reports itself as skipped rather than failing. That is
  why the floor and the FTS5 boundary are stated as two separate numbers. The suite has since grown to
  166 cases (see the table below); the *capability* boundaries these rows establish are unaffected,
  because they are properties of the runtime rather than of the tests.
  `tools/compat-matrix.mjs` re-checks this table on demand and asserts it rather than printing it.
  The moving `22.x` and `24.x` lines are not pinned here because they resolve to a new release
  several times a year; they were 22.23.2 / SQLite 3.51.3 and 24.20.0 / SQLite 3.53.4 when this
  row was last checked.
- `git` is optional. It is used only to group sessions by repository; without it, grouping falls
  back to workspace paths.

### Test evidence

```bash
npm run validate                                 # the repository validator
cd plugins/weekbin/mcode-trajectory-studio
node --test                                      # the Plugin suite
node tools/compat-matrix.mjs                     # assert this Node behaves as claimed
node server/main.mjs --doctor                    # data-source diagnostics against this machine
node tools/panel-e2e.mjs                         # seed a hostile session and serve the panel
```

Three claims in the manifest would otherwise only be prose, so they ship with a script instead
of a promise. `tools/compat-matrix.mjs` runs the suite under whatever Node executes it and fails
unless this release behaves the way the manifest says it does: it asserts `fail === 0`, that the
skip count matches whether this runtime's SQLite has FTS5, and that every skip is the FTS5 search
test. It was mutation-checked — an injected failure and an injected unrelated skip both make it
exit 1 — so a green run means something.

| Verified with | Result |
|---|---|
| `compat-matrix` on Node `24.19.0` (latest run) | 166 tests, 166 pass, 0 fail, 0 skipped (FTS5 present, SQLite 3.53.3) |
| `compat-matrix` on Node `22.13.0` (previous revision) | 115 tests, 114 pass, 0 fail, 1 skipped (FTS5 absent, SQLite 3.47.2) |
| `compat-matrix` on Node `22.19.0`, `22.23.2`, `24.0.0`, `24.20.0` (previous revision) | 115 tests, 115 pass, 0 fail, 0 skipped |
| `node --test` on `windows-latest` and `macos-latest` (previous revision) | 115 tests, 0 fail on both |
| `node server/main.mjs --doctor` on Node `22.12.0` | refuses to start, naming the floor and `node:sqlite` |

Rows marked "previous revision" are the numbers actually measured then and are left as they were. The
suite has grown from 115 in those rows to 166 as the fixes' canaries were added; the latest pass
contributed 28 cases — escaped-form redaction and idempotence, the MCP error branch and its own sweep,
the per-row and warning bounds, the git child environment, root parsing, the panel's privacy default,
and the JSONL drop-count case. Re-measured green on Node `24.19.0`. The other Node releases and the
Windows/macOS runners have not been re-run since, so the next CI run covers them.
| `node server/main.mjs --doctor` on Node `22.12.0` | refuses to start, naming the floor and `node:sqlite` |

The last three rows were run on Windows and macOS for the first time during this review round, and
that run is the reason the suite still changes: it found three platform assumptions **in the tests**
(a temporary path compared before canonicalization — `/var` on macOS, a short `RUNNER~1` path on
Windows — a POSIX-only assertion about a resolved data directory, and a temporary directory removed
while SQLite still held the file open, which is `EBUSY` on Windows and harmless on POSIX). All three
are fixed here.

This Plugin deliberately adds no workflow to this repository: how the project spends its CI minutes
and what runs on its runners is the maintainers' call, not a contributor's. The job definitions we
used — a Node matrix, a `windows-latest`/`macos-latest` pair, and the floor guard — are written out
in the pull request so they can be adopted, adapted, or ignored.

The Plugin's own tests cover the SQLite reads, the JSONL fallback, the git grouping (including a
real worktree merge), input provenance, the tool-call/task join, the agent definition lookup,
redaction, the MCP protocol surface, the module graph (that it is acyclic, that no client
surface imports the orchestrator, and that every relative import resolves), client
formatting edge cases, the local panel's request fences and error contract, path portability
(no machine-local path is hardcoded, and the projection is found in a non-canonical layout), and
the package declarations (both manifests and the MCP descriptor, version coherence, package hygiene
and the size limits).

Five suites exist because the previous revision was exploitable in ways its tests did not cover, and
each one is written so that "refuse everything" cannot pass it:

- **`containment.test.mjs`** plants a canary outside the data directory and reaches for it through a
  symlinked task directory, a two-hop link, a relative link, a symlinked `output.log`, a symlinked
  session directory, and a symlinked `messages.jsonl`. Every case asserts the canary is absent *and*
  that the read is reported unavailable, with a positive control alongside that must still succeed.
  It also pins the resource behaviour: a large unterminated JSONL line takes the incremental buffer
  cap's discard path (`droppedOversized`), a line after it still folds, and the post-open gate refuses
  a descriptor that resolves outside the root while falling back to the documented boundary where
  `/proc` is absent.
- **`redact.test.mjs`** pins each encoding that used to escape: JSON object forms, nested envelopes,
  the **escaped** form (`{\"api_key\":\"…\"}` — the runtime stores tool results as JSON text, so this
  is what a credential actually looks like on disk), double escaping, `Authorization: Bearer …`,
  `Basic`, `proxy-authorization`, a header inside a shell command, a tool-call description, and the
  camelCase credential keys (`clientSecret`, `refreshToken`, `accessToken`, `authToken`, `apiSecret`,
  `xApiKey`) that an exact-name set leaked. Each asserts the secret is gone *and* that the surrounding
  payload survives, that the identifiers the API is keyed on (`sessionId`) and the usage counters
  (`inputTokens`) are not mistaken for credentials, that a home path is collapsed wherever it appears,
  and that the depth and aggregate-byte bounds hold. Four assertions are properties rather than
  examples: idempotence (`redact(redact(x)) === redact(x)`) over the whole corpus × four option sets,
  that no sweep ever grows a marker a bracket at a time, that a truncation marker is stable across
  sweeps, and that a JSON string with nothing to redact is returned **byte-identical** — tier A must
  not reflow the reader's data to protect nothing. Over-redaction is pinned too: `npm_config_registry`
  and `HF_HOME` must survive, a 13-digit epoch must not be read as a phone number, and a connection
  string whose password contains `@` must not leak the tail the earlier rule left behind.
- **`panel-security.test.mjs`** covers the capability (the old fixed header alone is now 403, a
  wrong-length value is refused without throwing, a repeated header is refused, the right one is
  accepted and not echoed), process isolation (one panel's capability does not open another's), the
  loopback bind plus unreachability on every non-loopback interface and a peer-address fence, and a
  mutation-checked scan that fails if any shipped asset ever uses a markup injection sink.
- **`protocol.test.mjs`** spawns the real MCP server over stdio, the way mcode does, and drives it as
  a client: version negotiation, the seven declared tools and their annotations, a call against a
  fixture projection, full detail redacted on the wire (including structured credential keys that only
  the key name can catch, and a credential hidden inside a tool *result* — stored, as the runtime
  stores it, as JSON text behind an escaped key), **the failure branch swept through the same path as
  the success branch**, a reply trimmed to its byte budget with `truncated`/`omitted` reported,
  unknown tool and unknown method, a notification left unanswered, `--doctor`, and the lifecycle —
  closing stdin has to end the process *with the panel running*, because a listener left behind leaks
  a port on every session. Every wait is bounded, so a server that stops answering fails the suite
  instead of hanging it.
- **`node-version.test.mjs`** asserts the floor and the verified range, that the FTS5 claim matches an
  actual `CREATE VIRTUAL TABLE … USING fts5` on whatever runtime is executing, that all four
  declarations state the same numbers, and that no native module is pulled in.

The panel was additionally driven end to end with a browser: session switching, tree expansion,
timeline navigation, all inspector tabs, the theme toggle and the failure-evidence block, at five
viewport widths, and a session seeded with `<img src=x onerror=…>` in its body and tool arguments to
confirm it renders as text with no script execution. The repository suite runs the same validator CI
runs.

The security hardening re-checked the affected surface in a real browser (`tools/panel-e2e.mjs` driven
by a browser, with `<img src=x onerror=…>`, `<svg onload=…>` and `"><script>…</script>` planted in the
session): at the default `summary` detail the first paint fetches **no message text at all** (the
toggle is unchecked and no payload is in the DOM); after ticking 显示正文 all three payloads render as
**literal text**, the DOM holds **zero** `on*` inline handlers, zero `javascript:` URLs, no `<img>` and
no `<svg onload>`, and the console stays clean; a credential is already `[redacted]` by the time it
reaches the page (a `ghp_…` in the session title arrives as `[redacted]`); no token in `localStorage`
and no cookie; and the response headers are the `default-src 'none'` CSP plus `no-referrer`. The
five-viewport matrix and the theme/timeline items are from the earlier round and were not re-run. The
checklist `tools/panel-e2e.mjs` prints was updated for the new `summary` default — left as it was, it
would suggest the payload should be visible on load.

## Install

This repository hosts Plugins as source. Point MiniMax Code at this directory as a local Plugin, or
copy `plugins/weekbin/mcode-trajectory-studio/` into your Plugin directory. The MCP server entry
starts automatically.

### How the package is declared

The package follows the same layout as every other Plugin merged into this repository — the
separate Marketplace-submission layout (`.minimax-plugin/plugin.json` plus `*.mcp.json`) is
not shipped here:

| File | Purpose |
|---|---|
| `plugin.json` | the portable Agent Plugins registry manifest |
| `.claude-plugin/plugin.json` | the mcode 0.4.0+ layout; points at the Skill and declares the MCP server |
| `mcp.json` | the MCP descriptor the runtime reads |
| `skills/mcode-trajectory-studio/SKILL.md` | the one Skill, under a directory named for it |

The runtime manifest points at the nested Skill path directly, so exactly one SKILL.md ships
rather than a second copy. `tests/plugins/mcode-trajectory-studio/smoke.test.mjs` audits the
package against this layout, with negative injection so the audit cannot pass by accident.

## Diagnostics

```bash
node server/main.mjs --doctor   # resolved data dir, SQLite/FTS availability, latest session stats
node server/main.mjs --serve    # run the Studio panel standalone on 127.0.0.1
```

## Code layout

The Plugin ships no dependencies and no build step, and the source is split by layer
so that no file has to hold more than one concern:

- `server/` — `config` · `json` · `sqlite` · `fsutil` (foundations), `redact` · `git`
  (services), `sessions` · `stats` · `tasks` · `events` · `search` · `jsonl` (domain),
  `store` (facade), then `mcp` · `http` · `main` (interface). Domain modules take the
  `Store` facade as their first argument, so the layer graph stays a DAG.
- `web/` — `app.js` only boots; the surfaces live in `web/js/`: `state` · `bus` ·
  `format` · `icons` · `results` (leaves), `api` · `storage` · `theme` · `banner` ·
  `intents` (foundations), `sidebar` · `capability` · `stats` · `timeline` · `stream` ·
  `inspector` (surfaces), and `flow` · `controller` · `wire` (orchestration). Surfaces
  announce an intent on the bus rather than importing the action, so the client graph
  is acyclic too — a property a test enforces. The panel is served as ES modules.
- `test/` — `store.test.mjs` (the data layer and the MCP surface),
  `modules.test.mjs` (the import graph is acyclic and every import resolves), and
  `format.test.mjs` (client formatting edge cases). The package audit lives in the
  repository at `tests/plugins/mcode-trajectory-studio/smoke.test.mjs`.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Design notes

The research and interface comparison behind this Plugin — including why the runtime SQLite
projection is used instead of session JSONL artifacts — is recorded in [DESIGN.md](DESIGN.md).
