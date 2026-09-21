# Borrow / Reuse Map: General Agent-Harness Patterns → mcode-webui v2

> **Author**: worker (A01 lease)
> **Date**: 2026-09-20
> **Subject**: Architectural patterns common to modern agent harnesses
> (Anthropic Claude Code, OpenAI Codex CLI, plus the "abstract harness"
> general pattern) that mcode-webui v2 could adopt, mapped to the gaps
> identified in [REVIEW-sihankor-baselines-2026-08-28.md][review] and the
> ROI ordering used in [BORROW-dsh-deepseek-harness-2026-08-28.md][dsh].
> **Status**: Working document, not a code change to ship.
> **Scope**: Reference only — patterns are publicly documented; no
> reference to private code from any of the three sources.

[review]: ./REVIEW-sihankor-baselines-2026-08-28.md
[dsh]: ./BORROW-dsh-deepseek-harness-2026-08-28.md

---

## TL;DR

This doc compares **general harness architecture patterns** (Anthropic
Claude Code, OpenAI Codex CLI, plus the abstract "what every agent
harness does" list) against mcode-webui v1.0.0 / v1.0.1. It is the
sibling doc to `BORROW-dsh-deepseek-harness-2026-08-28.md` (which is
narrower — only one upstream: deepseek-harness).

Six concrete borrows, ordered by SiHankor-baseline ROI:

| # | Borrow | Closes which baseline gap / UX gap |
|---|---|---|
| 1 | Append-only conversation transcript (Codex CLI `~/.codex/sessions/*.jsonl` pattern) | Baseline 4 + prohibition 4 (verifiability + tamper-proof event stream) |
| 2 | Per-cid permission-policy DSL with rule language (Claude Code `settings.json` `permissions.allow/deny` pattern) | Baseline 1 partial + UX #10 + prohibition 1 |
| 3 | Hook seam on the acp event stream (Claude Code `PreToolUse` / `PostToolUse` hook pattern) | Baseline 4 + prohibition 4 — enables Borrow 1 + Borrow 4 |
| 4 | Skills / capability manifest as runtime-discoverable modules (abstract harness "everything is a plugin" pattern) | UX #4, #6, #9 — also closes one outstanding entry in `plugin.json` |
| 5 | Project-scoped instruction file auto-injected into the prompt (Claude Code `CLAUDE.md` pattern) | UX — onboarding / consistency, no direct baseline |
| 6 | Subagent fan-out for backend batch ops (Claude Code `Task` tool pattern, server-side only) | UX #7 bulk delete, UX #6 streaming perf |

The single biggest takeaway: **Borrow 1 + Borrow 3 together close
Baseline 4 / prohibition 4 cleanly** — they are the same change as
`dsh Borrow 1 + 3`, just expressed in harness-general terms.

---

## 1. The three reference sources

| Source | What we draw from it | What we do NOT draw |
|---|---|---|
| **Anthropic Claude Code** | Hooks, permission DSL, CLAUDE.md memory, subagent `Task` tool, skills | Internal prompt templating, sandbox internals, MCP transport |
| **OpenAI Codex CLI** | Approval modes (`auto`/`edit`/`plan`), `~/.codex/sessions/*.jsonl` transcript shape, TOML config | Landlock/bwrap sandbox, TUI rendering internals, OAuth flow |
| **Abstract harness** | Loop (input→output→tool), tool registry, context management, capability discovery | Anything that requires a specific runtime |

The "abstract harness" column is the third source — a deliberately
generative list of what *every* agent harness has. This is the
defensible fallback when the public docs of either Claude Code or
Codex CLI are silent on a particular pattern.

**Hard rule**: this doc names patterns only. It does NOT claim to
describe internal code paths of either product. Where a pattern is
drawn from a specific product, the cite is the public docs / repo
README / well-known UX behavior. Where it's drawn from "abstract",
the cite is the mcode-webui capability map.

---

## 2. Borrow 1: Append-only conversation transcript (Codex CLI `~/.codex/sessions/*.jsonl`)

### Pattern (Codex CLI)

The Codex CLI stores each conversation as one append-only `.jsonl`
file under `~/.codex/sessions/<id>.jsonl`. Each line is one event
(user message, assistant delta, tool call, tool result, exec result).
The file is opened with `O_APPEND`; the CLI never seeks and never
rewrites. Reopening the session = `tail` the file from the start and
replay into the UI.

### What mcode-webui has today

- `~/.minimax-code/webui/.webui-sessions.json` — full-file overwrite
  on every session change (`server/lib/sessions.js`)
- The mcode sqlite db holds the actual conversation content (host-scope,
  not plugin-scope)
- The plugin itself does not write the transcript anywhere; it relays
  via SSE and forgets

### Borrow (plugin-scope)

Add `server/lib/transcript.js`:

- One NDJSON file per session at `~/.mcode-webui/transcripts/<sessionId>.ndjson`
- Append-on-event: `delta`, `chat`, `tool`, `exec`, `state` (only the
  fields the operator needs for replay — drop ephemeral `running.active`
  flips)
- Open with `O_APPEND`; never `writeFile`
- Reader: `transcript.read(sid)` returns a sync iterator that yields
  parsed events, used by a future "replay session" route

Wire-in points (existing files):
- `server/routes/chat.js` — every `pushStateFor(cid)` already builds
  the event; add one line that calls `transcript.append(sid, evt)`
- `server/lib/state-bus.js:140` — single chokepoint, ideal insertion site

### Effort

~250 lines: `transcript.js` (~150), call-site wiring (~50), tests (~50).

### ROI

**Highest of the six.** Same baseline impact as `dsh Borrow 1`
(closes Baseline 4 + prohibition 4). Smaller surface area than the
`dsh Borrow 1` schema because we don't need the full dsh `SessionEvent`
taxonomy — the SSE event types ARE the schema already.

---

## 3. Borrow 2: Per-cid permission-policy DSL (Claude Code `permissions.allow/deny`)

### Pattern (Claude Code)

`settings.json` carries a `permissions` block with three arrays:

```jsonc
{
  "permissions": {
    "allow": ["Read", "Edit(/workspace/**)", "Bash(npm test:*)"],
    "deny":  ["Bash(rm -rf:*)"],
    "ask":   ["Bash(git push:*)"]
  }
}
```

Rules are `(tool_name, glob)` pairs. The harness evaluates them in
order `deny → ask → allow`. Per-session overrides are layered on top
via `SessionStart` hook or `--session-permissions` flag.

### What mcode-webui has today

- One scalar mode: `state.permissions` ∈ `'ask'|'auto'|'full'|'plan'`
  (`server/routes/model.js#handleSetPermissions`)
- No per-tool rules (CAPABILITIES.md § 3 calls this out as ❌)
- No rule language (`CAPABILITIES.md` § 3 row "Custom rules" is ❌)

### Borrow (plugin-scope)

Refactor `server/lib/permissions.js` (new file, replaces inline logic
in `model.js`) into:

- A `Policy` object: `{ allow: Rule[], deny: Rule[], ask: Rule[] }`
- `Rule = { tool: string, pattern?: string }` where `pattern` is a
  glob compiled with `picomatch` (already vendored transitively in
  Node via `node:fs` glob — but verify; if absent, hand-roll a
  ~30-line globber for the subset we need)
- `evaluate(policy, tool, input)` returns `'allow'|'deny'|'ask'`
- Persist to `~/.mcode-webui/permissions.json` (same pattern as the
  existing `settings.json`)

Wire-in:
- `server/routes/model.js#handleSetPermissions` becomes "set policy
  + push state"
- `server/lib/acp-client.js` `McodeAcpClient.request('session/...')`
  path: evaluate policy *before* forwarding to mcode, and synthesize
  a `permission` SSE event when `ask` matches

### Effort

~250 lines: `permissions.js` (~180), wire-in (~40), tests (~30).

### ROI

**High.** Closes Baseline 1 (LLM is symbol generator, not governor)
partially: the policy is plugin-side, deterministic, and per-rule
auditable via the Borrow 1 transcript. Closes UX #10 (Plan mode
visualization) only partially — the policy alone doesn't render the
plan, but it's the data structure that the render needs.

---

## 4. Borrow 3: Hook seam on the acp event stream (Claude Code `PreToolUse` / `PostToolUse`)

### Pattern (Claude Code)

A "hook" is a user-defined shell command (or, in v2, a Node call) that
runs at a specific lifecycle point: `PreToolUse`, `PostToolUse`,
`SessionStart`, `SessionEnd`, `Stop`. The harness waits for the hook
to return and inspects the exit code to decide whether to proceed.
Multiple hooks can register for the same event; they run in declared
order.

The point of a hook seam: **the harness itself stays generic, and
domain-specific behavior is injected.** Plugin authors don't fork the
harness to add an audit log; they register a hook.

### What mcode-webui has today

- `state-bus.js` is the single chokepoint for SSE writes
  (`server/lib/state-bus.js:140`)
- No seam: each route handler calls `pushStateFor` directly
- Adding "log to disk" or "require user confirmation" today means
  editing every route handler

### Borrow (plugin-scope)

Add `server/lib/hooks.js`:

```js
// API shape (informal)
hooks.register('PreToolUse',   async (event, ctx) => { ... })
hooks.register('PostToolUse',  async (event, ctx) => { ... })
hooks.register('StateChange',  async (event, ctx) => { ... })
hooks.register('Authorize',    async (event, ctx) => { ... })  // for Borrow 2
hooks.run('PreToolUse', event, ctx)  // returns aggregated result
```

Wire-in:
- `server/lib/state-bus.js` `pushStateFor` → call `hooks.run('StateChange', …)`
  before writing
- `server/lib/acp-client.js` `McodeAcpClient` request path → call
  `hooks.run('PreToolUse', …)` after parsing the tool call from the
  delta event, before forwarding to mcode
- `server/lib/permissions.js` (Borrow 2) → `evaluate()` is itself
  invoked via the `Authorize` hook

### Effort

~200 lines: `hooks.js` (~120), wire-in (~50), tests (~30).

### ROI

**High.** The hook seam is the *infrastructure* that makes Borrows 1
and 2 cheap to compose. Without it, Borrow 1 needs a write site at
every push, and Borrow 2 needs a wrapper at every route handler. With
it, those wrappers go away.

---

## 5. Borrow 4: Skills / capability manifest as runtime-discoverable modules

### Pattern (abstract harness)

Every harness ships with a list of "things the agent can do" — slash
commands, tools, integrations. The right pattern is for this list to
be:

1. **Discoverable** at runtime (not hard-coded into the harness)
2. **Manifested** with metadata (name, description, version, hash)
3. **Composable** (one skill can depend on another's side effects)

The harness iterates the manifest at boot, builds an in-memory registry,
and exposes it to both the LLM (as tool descriptions) and the UI (as
slash command palette).

### What mcode-webui has today

- `plugin.json#capabilities` is a flat array of strings (CAPABILITIES.md
  § Tier 4 item 16 calls this out)
- `server/lib/slash.js` (304 lines) is a giant switch — no registry
- `state.commands` (ARCHITECTURE.md § 4) mirrors the acp
  `session/commands` response — but the plugin's own local commands
  (`/exec`, `/clear`) are baked into `slash.js`

### Borrow (plugin-scope)

Refactor `server/lib/slash.js` into:

```
server/lib/skills/
├── registry.js          # the in-memory registry
├── builtin/
│   ├── exec.js          # was: /exec branch in slash.js
│   ├── clear.js         # was: /clear branch
│   └── plan.js          # was: /plan branch
└── loader.js            # scans /skills/ + reads plugin.json#capabilities
```

Each builtin exports:

```js
module.exports = {
  cmd: '/exec',
  zh: '切换到 exec 传输',
  en: 'switch to exec transport',
  hint: '…',
  destructive: false,
  execute: async (args, ctx) => { ... }
}
```

`registry.js` builds the merged list, exposes it via `/api/protocol/capabilities`,
and `state.commands` reads from it.

### Effort

~400 lines: split (~250), registry (~100), tests (~50).

### ROI

**Medium.** No baseline closes directly, but the registry becomes the
canonical home for Borrow 5 (project-scoped skills) and the foundation
for Borrow 6 (subagent). Mirrors `dsh Borrow 3`.

---

## 6. Borrow 5: Project-scoped instruction file (Claude Code `CLAUDE.md`)

### Pattern (Claude Code)

When Claude Code starts a session in a directory, it walks up from the
workspace root looking for `CLAUDE.md` (and `CLAUDE.local.md`). The
content is auto-injected into the system prompt. The intent: project-
specific conventions ("always run `pnpm test`", "never commit without
running the linter") become part of the prompt without the user
having to paste them every session.

### What mcode-webui has today

- No `CLAUDE.md` analog
- Workspace metadata (`state.workspace`) carries `dir`, `branch`,
  `treeState` — but no project instructions
- The mcode host probably has its own version (host-scope, not
  plugin-scope)

### Borrow (plugin-scope)

Add `server/lib/workspace-instructions.js`:

- On `/api/workspace` change (existing route in `server/routes/workspace.js`):
  - Walk up from `workspace.dir` looking for `WEBUI.md` (uppercase,
    conventional — chosen over the lowercase variant `webui-instructions.md`)
  - Read each match; concatenate (with section headers naming the
    source directory)
  - Cache the result; refresh on `/api/workspace/refresh`
- Inject into the prompt in `/api/send`:
  - Prepend a `<workspace-instructions>` block before the user content
  - Marker the mcode host can use to strip on display

### Effort

~150 lines: walker (~50), cache (~30), inject in chat.js (~30), tests (~40).

### ROI

**Medium.** UX win, not a baseline fix. The hook seam (Borrow 3) is a
strict prerequisite: the inject should be a hook subscriber, not a direct
edit to `/api/send`.

---

## 7. Borrow 6: Subagent fan-out for backend batch ops (Claude Code `Task` tool)

### Pattern (Claude Code)

The `Task` tool lets the main agent spawn a subagent with a fresh
context, a subset of tools, and a goal. The subagent runs, returns
its result, and the main agent continues. The harness mediates:
the subagent's tool calls go through the same hook seam and the same
permission policy.

The subagent pattern is used for:
- **Parallelizable search** ("find all files matching X") → spawn N
  subagents, each with a `grep` tool, merge results
- **Specialized domains** ("write tests for this module") → spawn a
  test-writing subagent with read/edit/test tools
- **Sandboxed exploration** ("summarize this repo") → spawn a
  read-only subagent

### What mcode-webui has today

- The browser tab → mcode subprocess mapping is already 1-to-N: a tab
  has one subprocess, but multiple tabs share the same host (`server.js`)
- No subagent fan-out — the plugin does not spawn child mcode
  subprocesses
- Batch operations like "delete N sessions" are sequential in
  `/api/sessions/cleanup-orphans`

### Borrow (plugin-scope — narrow)

The plugin is a UI shell, not an agent orchestrator. Spawning an LLM-
driven subagent from inside the plugin is host-scope (mcode owns the
agent loop). The pattern translates cleanly to **a non-LLM backend
batch executor**:

- `server/lib/subagent.js` exposes `fanout(jobs, worker, opts)`
  where `worker` is a pure function, not an LLM call
- Use case: UX #7 bulk-delete (`server/routes/sessions.js` cleanup-
  orphans path): today iterates synchronously; with `fanout` becomes
  `Promise.all(jobs.map(fanout))` with a concurrency cap
- Use case: UX #6 chat list virtualization: not a fan-out, but a
  per-message subagent for hydration (off-topic; skip)

The "fanout" name overlaps with Claude Code's `Task` semantically but
the implementation is `Promise.all` + semaphore, not an LLM spawn.
We're borrowing the *shape*, not the LLM aspect.

### Effort

~150 lines: `subagent.js` (~100), wire-in to cleanup-orphans (~30),
tests (~20).

### ROI

**Medium-Low.** Closes UX #7 partially (parallel deletes), but is
mostly an internal refactor with no user-visible feature delta. Skip
unless UX #7 is on the v2 roadmap.

---

## 8. Candidate borrowings (deferred — not implemented in v2.0)

These patterns are real, but the v2.0 scope doesn't justify the
implementation cost.

| Pattern | Source | Why deferred |
|---|---|---|
| TUI rendering with `ink`-style streaming | Codex CLI | mcode-webui is web-only; the SSE state push is already the streaming API |
| TOML config (`~/.codex/config.toml` shape) | Codex CLI | `plugin.json#extensions.config` is already the config surface; TOML is a parallel format |
| OAuth / cloud auth flow | Codex CLI | mcode-webui is local-LAN-only; token is the only credential |
| Multi-user collaboration / shared sessions | Claude Code `tasks` | Host-scope (mcode would need to expose `session/share`) |
| Per-token cost attribution / forecast exhaustion | abstract harness | mcode 0.1.5 doesn't expose rate-of-use; CAPABILITIES.md § 8 ❌ |
| Vector index over conversation history | abstract harness | Off-topic for a chat UI shell |
| Sandbox / Landlock / bwrap | Codex CLI | Host-scope; plugin doesn't execute shell |
| `--patch` overlay for config (also `dsh Borrow 5`) | abstract harness | ROI too low until operators ask for per-deployment customization |

---

## 9. Patterns that do NOT translate to mcode-webui

| Pattern | Why not |
|---|---|
| **Claude Code internal prompt templating** | Private to Anthropic; we don't reverse-engineer |
| **Codex CLI Landlock / bwrap sandbox** | Host-scope (mcode executes shells, not the plugin) |
| **MCP server internal transport** | mcode-webui is an MCP *client*, not a server. Borrowing the server pattern would invert the relationship |
| **OAuth flow** | mcode-webui has no cloud identity; the only credential is the LAN token |
| **Cloud-backed conversation sync** | mcode-webui stores locally; cloud sync is out of scope |
| **TUI / terminal-native rendering** | mcode-webui is a browser SPA; the rendering surface is DOM, not blessed DOM or TUI |
| **Code generation / `apply_patch` style tool** | mcode already has its own editing tools (`Edit`, `Write`); a second editing primitive would conflict |
| **Voice / audio input** | mcode-webui doesn't do audio I/O; not in `ARCHITECTURE.md` boundaries (HTTP / EventSource / fetch) |
| **Workspace files indexing for search** | The mcode host does this; the plugin would re-do work the host already does |

These are *not* deferrals — they are *out of scope by design*. They
should not appear on a v2.x roadmap without a prior architectural
decision to expand mcode-webui's role beyond "UI shell for mcode".

---

## 10. Concrete next steps (in order of ROI)

If Wzdhehe is interested, the borrows translate to PRs roughly in
this order. The numbers line up with the `dsh` borrows for cross-
reference:

1. **Borrow 3** (hook seam) — ~200 lines, no UX change, unblocks 1 + 2.
   Lands first because Borrow 1 and 2 are cheaper with the seam in place.
2. **Borrow 1** (transcript) — ~250 lines, closes Baseline 4 +
   prohibition 4. Lands second because it depends on Borrow 3.
3. **Borrow 2** (permission DSL) — ~250 lines, closes Baseline 1
   partial + UX #10. Lands third; depends on Borrow 3.
4. **Borrow 4** (skills registry) — ~400 lines, mostly mechanical
   split of `slash.js`. Lands fourth; no baseline but unlocks
   Borrow 5 cleanly.
5. **Borrow 5** (project-scoped instructions) — ~150 lines, UX win,
   depends on Borrow 4.
6. **Borrow 6** (subagent fanout) — ~150 lines, internal refactor,
   depends on Borrow 4. Skip unless UX #7 is on the v2 roadmap.

Total scope for 1+2+3+4+5: ~1250 lines. That's the size of a
v2.0.0 next-major change.

---

## 11. Comparison with `dsh` borrows

Same ROI ordering, different reference source:

| Rank | harness-v2 (this doc) | dsh (sibling doc) |
|---|---|---|
| 1 (infrastructure) | Hook seam (Borrow 3) | — |
| 1 (audit) | Transcript (Borrow 1) | Append-only SessionEvent (Borrow 1) |
| 2 (governance) | Permission DSL (Borrow 2) | Per-request authorization (Borrow 2) |
| 3 (refactor) | Skills registry (Borrow 4) | Subsystem split (Borrow 3) |
| 4 (UX) | Project instructions (Borrow 5) | Patch overlay (Borrow 5) |
| 5 (optional) | Subagent fanout (Borrow 6) | — |

The two docs agree on **Borrow 1 + 2 + 3 ≈ 700 lines closing Baseline
1 partial + Baseline 4 + prohibition 4**. The `dsh` doc expresses
this as SessionEvent + authorization; this doc expresses it as
transcript + permission DSL + hook seam. Both are valid; the harness-
general framing is easier to defend to outside readers who don't
have dsh context.

---

## Change log

- 2026-09-20: Initial document. Compiled for the mcode-webui v2
  refactor planning cycle. Sources: public docs for Anthropic Claude
  Code and OpenAI Codex CLI, plus the abstract harness pattern list.
  No code references to private internals of either upstream.