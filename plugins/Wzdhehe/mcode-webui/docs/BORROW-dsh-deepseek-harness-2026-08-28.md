# Borrow / Reuse Map: deepseek-harness → mcode-webui

> **Author**: @modacker
> **Date**: 2026-08-28
> **Subject**: Patterns in [deepseek-ai/deepseek-harness][dsh] that
> mcode-webui could learn from, mapped to the SiHankor-baseline gaps
> identified in [REVIEW-sihankor-baselines-2026-08-28.md][review]
> **Status**: Working document, not a code change to ship

[dsh]: https://github.com/deepseek-ai/deepseek-harness
[review]: ./REVIEW-sihankor-baselines-2026-08-28.md

---

## TL;DR

`deepseek-harness` (dsh) and mcode-webui share an ecosystem — both
talk to an LLM agent via ACP, both are "everything is a plugin"
in spirit — but they are NOT in a fork / copy relationship.
**Code is independent; the design space overlaps.**

dsh is a *monolithic* agent harness with deeply integrated packages
(`@deepseek-ai/dsh-<pkg>` workspaces). mcode-webui is a *single
plugin* for a different harness (mcode). The dsh patterns below are
selected precisely because they translate cleanly to a plugin-shaped
project — they don't require the full monorepo or Cordis.

Five concrete borrows, ordered by SiHankor-baseline ROI:

| # | Borrow | Closes which baseline gap |
|---|---|---|
| 1 | Append-only `SessionEvent` log (dsh's `core/session`) | Baseline 4 (verifiability) + prohibition 4 (audit trail) |
| 2 | Per-request "ask human" authorization (dsh's `credentials/authorization`) | Baseline 1 (LLM is symbol generator, not governor) |
| 3 | Subsystem split for slash / permission / ask-user / feedback (`interaction/` + `feedback/`) | UX gaps #4, #6, #9, #10 in the SiHankor review |
| 4 | Plugin manifest with `extensions.securityNotes` single source of truth (already done in mcode-webui) | None — mcode-webui already follows this |
| 5 | `dsh-style` Cordis patch overlay for mcode-webui config | Refactor opportunity, not a baseline fix |

---

## 1. The two are *not* in a fork relationship

| Dimension | dsh | mcode-webui |
|---|---|---|
| Form factor | Monorepo, ~30+ packages | Single plugin |
| Framework | Vendored Cordis (everything is a plugin) | Zero-dep Node stdlib |
| Process model | Plugins run in the same host process | Standalone Node process, talks to mcode over ACP |
| Plugin manifest | `cordis.yml` patch overlay + `package.json#dsh.bundle` | `plugin.json` (registry-format flat object) |
| Versioning | `0.1.1-rc.2`; pre-release, no compatibility shims | `1.0.0`; minted in PR #16 / #23 |
| Web UI tech | TS / Svelte-style components in `packages/web/web/` | Vanilla JS SPA in `public/app/` |
| Telemetry | `session-telemetry-otel` exists (opt-in) | Explicitly no telemetry, per `SECURITY-NOTES.md` |
| Auth | `ctx.authorization` seam with multi-flow credential acquisition | One TOKEN env var, ?token= query + Authorization header |

The user's question "是否有借鉴" — the answer is *in the design
language*, not in the code. Both teams converged on similar
patterns because both target the same problem (an LLM agent that
streams events to a browser). The borrowings below are patterns
mcode-webui can pick up; they are not "this code is already in dsh,
copy it".

---

## 2. Borrow 1: Append-only `SessionEvent` log (closes Baseline 4 + prohibition 4)

### What dsh has

`packages/core/session/` defines `SessionEvent` as an **append-only
log**: every event is a row, never updated, never deleted. The
SQLite-backed persistence (`packages/session/session-persistence-sqlite/`)
has a schema-17 detail:

- `events(session_id, seq)` composite primary key
- Sequence numbers are dense and monotonic
- Zstandard compression on payloads ≥ 4 KiB
- "A future ignorable logical event may therefore reuse a
  storage-tag name without being decoded as a packed row"
- "Normal appends never delete or replace an earlier event row"
- Forward and reverse read passes with corruption detection
- "Malformed packed row is all-or-nothing: committed corruption
  rejects, while a torn final row is deleted from its physical
  base during mutating recovery"

This is the **audit log** that mcode-webui lacks.

### What mcode-webui has today

- `~/.mcode-webui/settings.json` — full-file overwrite, no diff, no history
- `~/.minimax-code/webui/.webui-sessions.json` — full-file overwrite
- `~/.mcode-webui/.webui-sessions.json` — same pattern
- No event log anywhere; the closest is the chat history, which is
  user-visible content, not a system audit trail

### What to borrow (plugin-scope)

Add `server/lib/events.js` (a new file) that writes an
append-only NDJSON line to `~/.mcode-webui/events.ndjson` for every
state-changing action the webui performs:

```jsonc
// Schema (informal, inspired by dsh's SessionEvent)
{
  "seq": <monotonic>,
  "ts": <ISO-8601>,
  "actor": "user" | "mcode" | "system",
  "kind": "settings.write" | "sessions.create" | "sessions.delete" | "upload.create" | "slash.exec",
  "target": "<file path or session id>",
  "before_hash": "<sha256 of prev state file or 'null'>",
  "after_hash": "<sha256 of new state file or 'null'>",
  "cid": "<connection id from state-bus>",
  "data": { ...event-specific payload... }
}
```

Key properties to copy from dsh:

- **Append-only** — never update, never delete (except by retention policy)
- **Monotonic sequence** — easy to detect gaps
- **Hash-chained for tamper-evidence** — `after_hash` includes `prev_after_hash`
- **200ms write-behind window** — for high-frequency events (chat ticks)
- **Reverse + forward read passes** — for replay

Approximate effort: ~300 lines for the events module + tests, plus
~50 lines per write site (settings, sessions, upload, slash, db.delete).

This single change closes Baseline 4 (verifiability: traceable +
tamper-proof) and prohibition 4 (event stream).

---

## 3. Borrow 2: Per-request "ask human" authorization (closes Baseline 1)

### What dsh has

`packages/credentials/authorization/README.md` describes a pattern
that fits the SiHankor baseline 1 almost verbatim:

> Some credentials cannot be configured, only obtained: getting
> one means a conversation with a human — open this page, paste
> that code, pick an account. This seam owns that conversation
> and the lifecycle around it, and never the protocol.

Three properties of dsh's authorization that map cleanly onto
mcode-webui's needs:

1. **A flow is a plugin's knowledge of how to get its own
   credential.** — The same flow object owns the prompt, the
   commit, and the lifecycle. mcode-webui's `/api/answer` and
   `/api/permissions` endpoints are similar in spirit but are
   scattered.

2. **The flow owns the write.** `run()` resolving means the record
   is already committed through `ctx.credentials`; the seam
   confirms a commit it observed during the attempt. mcode-webui
   should similarly require that any governance action
   (`/delete-session`, `/reset-workspace`, etc.) is committed
   only after a *visible* user confirmation, not as a side effect
   of an LLM reply.

3. **The interaction travels with the request, not a registry.**
   "Whoever starts an authorization is the one who can talk to
   the human about it, so prompts reach exactly the surface that
   asked and a headless caller supplies an interaction that
   declines." This is a perfect fit for the per-cid SSE channels
   mcode-webui already has — instead of a global "ask user"
   mod, the prompt goes to the specific connection that initiated
   the request.

### What mcode-webui has today

- `/api/answer` — receives the user's answer (for ask-user tool)
- `/api/permissions` — sets a permission mode
- `/api/protocol/*` — mcode ACP shim
- No explicit "this requires user confirmation" envelope

### What to borrow (plugin-scope)

Add an `authorize(action, ctx)` helper in `server/lib/authorize.js`
that:

1. Sends a `needs_authorization` event to the requesting connection's
   SSE channel (via `state-bus.js`).
2. Blocks the action in a Promise.
3. Resolves when the user clicks allow/deny in the UI.
4. Times out with `AuthorizationDeclinedError` after N seconds
   (default 5 min).
5. Writes an `events.ndjson` line for both the request and the
   resolution (using Borrow 1).

Wrap destructive routes with this:

```js
// in routes/sessions.js
const r = await authorize({ action: 'delete-session', sessionId: id, ctx });
if (!r.ok) return;  // user declined or timed out
// ... existing delete logic
```

This is the cleanest way to enforce "the LLM cannot directly
modify knowledge/intent" (prohibition 1) without rewriting the
host.

Approximate effort: ~250 lines for the helper + 4-5 wrapping
sites.

---

## 4. Borrow 3: Subsystem split for slash / permission / ask-user / feedback

### What dsh has

`packages/interaction/` is a subsystem that owns the human-in-the-loop
surfaces. It contains:

| Package | Purpose |
|---|---|
| `interaction/commands` | Slash command handling |
| `interaction/permission-presets` | Permission policies |
| `interaction/tool-ask-user` | Mid-tool "ask user" |
| `interaction/user-approval` | User approval flow |
| `interaction/user-questions` | Question forms |

`packages/feedback/` is the *response* subsystem:

| Package | Purpose |
|---|---|
| `feedback/command-feedback` | Feedback on a slash command |
| `feedback/message-feedback` | Feedback on a chat message (thumbs up/down, comment) |

dsh separates **the act of asking** (`interaction/`) from **the
response on past acts** (`feedback/`). This is a clean conceptual
split.

### What mcode-webui has today

- `server/lib/slash.js` (304 lines) — all slash commands, mixed
  governance and non-governance
- `server/routes/model.js#handleAnswer` — receives answers
- `server/routes/model.js#handleSetPermissions` — sets permission modes
- No `feedback/` — no way for the user to rate a response
- No `user-questions/` — questions are ad-hoc

### What to borrow (plugin-scope)

Refactor the 304 lines of `slash.js` into four files mirroring dsh's
split:

- `server/lib/interaction/commands.js` — slash command dispatch
- `server/lib/interaction/permission-presets.js` — named permission policies
- `server/lib/interaction/tool-ask-user.js` — mid-tool `AskUser` modal handler
- `server/lib/interaction/user-questions.js` — typed question UI (text/choice/confirm)
- `server/lib/feedback/command-feedback.js` — emit feedback events
- `server/lib/feedback/message-feedback.js` — emit per-message feedback

Each file is the seam; the SSE channel for human prompts is the
single shared transport (already exists at `/api/events`).

The win is **decoupling the LLM-facing API from the UI**. Today
mcode-webui has the LLM directly write to its chat stream. After
this refactor:

- Slash commands can be UI-gated (per Borrow 2)
- Tool-ask-user becomes a typed modal (vs the current ad-hoc parsing)
- Feedback events get their own append-only log entry (per Borrow 1)

Approximate effort: ~600 lines, mostly mechanical split. This is a
meaty refactor — but the structural win is the same as dsh's
package boundary.

---

## 5. Borrow 4: `extensions.securityNotes` single source of truth (already done)

mcode-webui already follows this dsh pattern:

- `plugin.json#extensions.securityNotes` references `references/SECURITY-NOTES.md`
- `SKILL.md` TL;DR + link
- `README.md` (en) + `README.zh-CN.md` mention it

dsh's `docs/subsystems/credentials.md` and `packages/credentials/README.md`
use the same pattern. **No work needed**; this is a confirmation
that mcode-webui already converged on a dsh-shaped design choice.

---

## 6. Borrow 5: Patch-overlay model for config

### What dsh has

dsh's profile / bundle system is a sophisticated way to extend:

- A `profile` lists bundles in a fixed order
- A `bundle` is a Cordis config row + the code it mounts
- A `--patch` overlay targets a row by id and replaces its config
- Patches stack: home-level, profile-level, --patch command-level

The architecture doc says it directly:

> A patch targets a row by id and replaces its whole config, or
> inserts new rows. ... Any row it prints can be replaced by a
> patch of your own.

### What mcode-webui has today

`plugin.json#extensions.config` is a flat key→schema map (PORT,
HOST, TOKEN, MCODE_MODEL, etc.). The runtime layer is
`server/lib/config.js` (which we already read). There is no way
to *override* one of these without forking the plugin.

### What to borrow (plugin-scope — bigger refactor)

Introduce a `cordis.yml`-style patch file in
`~/.minimax-code/webui/cordis.patch.yml` (or `.json`) that the
plugin reads at startup. Schema:

```yaml
# ~/.minimax-code/webui/cordis.patch.yml
patches:
  - id: server
    config:
      port: 9090  # override default 8080
      host: 127.0.0.1
  - insert:
      - id: telemetry
        enabled: false
```

The plugin merges this with its built-in config; conflicts are
resolved by "patch wins". The user's own `/api/settings` runtime
toggles can write back into this file (with a lock to prevent
concurrent edits).

This is the right shape if mcode-webui grows a real "settings as
patch overlays" concept; it also makes per-deployment customization
(operator wants port 9090, wants to disable uploads) clean.

**Caveat**: dsh's patch model depends on Cordis's `Config.row` identity
tracking. mcode-webui would need to roll its own row-merge logic
since it doesn't use Cordis. That's ~150 lines for the merge
function, plus tests.

Approximate effort: ~500 lines including the merge function,
file I/O, lock, and tests. Skip unless the user is asking for
operator-level customization.

---

## 7. Things in dsh that do **not** translate to mcode-webui

| dsh concept | Why not applicable |
|---|---|
| `core/agent-loop` | dsh owns the agent loop; mcode-webui does not (mcode does) |
| `code-runtime` (multi-backend code execution) | dsh concern; mcode-webui is a UI shell, mcode chooses its runtime |
| `sandbox` (Landlock / bwrap) | dsh concern; mcode-webui has no execution authority |
| `session-telemetry-otel` | mcode-webui's `SECURITY-NOTES.md` explicitly says "no telemetry" |
| Cordis framework | mcode-webui's design constraint is "zero npm deps"; Cordis is the opposite |
| Patch overlay (Borrow 5) as a primary mechanism | Only worth it if the user actually needs operator customization |
| `goal/` / `plan/` packages | mcode-webui already has a `plan-mode` capability; the plan engine is mcode's job |

These are *not* borrowings; they are *out of scope* by design.

---

## 8. Concrete next steps (in order of ROI)

If Wzdhehe is interested, the borrows translate to PRs roughly in
this order:

1. **Borrow 1** (event log) — ~300 lines, closes Baseline 4 +
   prohibition 4, no UX change. Should land first.
2. **Borrow 2** (per-request authorization) — ~250 lines + 4-5
   wrap sites, closes Baseline 1 + prohibition 1. Lands second
   because it touches the routes layer.
3. **Borrow 3** (interaction/feedback subsystem split) — ~600
   lines, mostly mechanical, lands third. Could merge with
   Borrow 2 if combined.
4. **Borrow 4** (already done) — no work needed.
5. **Borrow 5** (patch overlay) — ~500 lines, skip unless
   operator customization is on the roadmap.

Total scope: ~1150–1650 lines for borrows 1+2+3. That's a
"v1.1.0 next-version" sized change, not a point release.

---

## Change log

- 2026-08-28: Initial document. Compiled from session exploration
  of `/Users/moc/Harnessies/deepseek-harness` and comparison with
  mcode-webui v1.0.0.
