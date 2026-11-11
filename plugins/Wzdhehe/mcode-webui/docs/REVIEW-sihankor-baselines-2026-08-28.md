# Review: SiHankor Baselines & UX Improvements — mcode-webui v1.0.0

> **Author**: @modacker (review perspective, not a code change to ship)
> **Date**: 2026-08-28
> **Subject**: mcode-webui plugin at MiniMax-AI/MiniMax-Code-Plugins#23
> **Status**: Working document, not part of any merged commit yet
> **Audience**: Wzdhehe (plugin author), hetaoBackend (reviewer), modacker
> (round-5/round-6 fix author)

This document captures a review of mcode-webui against (a) the five
SiHankor engineering baselines, (b) the five engineering prohibitions,
and (c) a broader UX/interaction improvement list. It does **not**
propose code changes that the plugin author has not consented to; it
is meant as input for the next round of review.

The original PR was [MiniMax-AI/MiniMax-Code-Plugins#16][#16] (now
superseded by [PR #23][#23]). The round-5 / round-6 commits on #23
fixed the originally reported db-path blocker; this review goes
further and is the basis for the recommendations below.

[#16]: https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/16
[#23]: https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/23

---

## Part 1 — Plugin vs Host responsibility (the meta-frame)

Before applying the SiHankor baselines, a critical observation:

**mcode-webui is a *plugin* that wraps the mcode agent runtime.** mcode
is the host LLM agent; the plugin is a UI shell. This framing matters
because most of the SiHankor baselines are about *governance* — and
in a plugin/host split, governance sits with the host, not the
plugin.

| Concern | Whose problem |
|---|---|
| mcode writes to its own sqlite directly | **mcode host** — the plugin can only observe, not gate |
| mcode emits anomaly events | **mcode host** — plugin can only relay what mcode exposes |
| mcode's internal audit trail | **mcode host** — plugin cannot intercept internal writes |
| Slash command surface | **mcode host** — plugin just relays |
| Webui's own settings / sessions / upload writes | **plugin** — these are plugin-internal state, fully governable |
| Webui's own UI onboarding / token / alerting | **plugin** — fully governable |

The findings below are split into **plugin-scope** (mcode-webui can
fix) and **host-scope** (needs mcode team / Wzdhehe to fix).

---

## Part 2 — SiHankor Engineering Baselines

Five baselines, mapped to plugin-scope findings only. Host-scope
items are noted in Part 4.

### Baseline 1 — Deterministic programs are the sole executors of governance

> LLM is a symbol-material generator only. Governance operations are
> executed by deterministic programs.

| Status | Finding | File |
|---|---|---|
| ⚠️ borderline | `handleSend` lets mcode output become `cs.chat` entries directly — LLM-generated content is treated as data, with no audit. | `server/routes/chat.js:115-129` |
| ✓ ok | Webui's own settings / sessions CRUD are deterministic handlers. | `server/routes/settings.js`, `server/routes/sessions.js` |
| ✗ host | mcode itself writes to `runtime-state.sqlite` without webui gating. | mcode host, not plugin |

**Plugin-scope recommendation**: none — the borderline case is
inherent to the LLM-as-actor design. The fix would be to introduce a
plugin-side message ingest that *mirrors* mcode's output into
plugin-owned storage with metadata, but that's a refactor, not a
quick fix.

### Baseline 2 — Information flood (LLM generation vs human attention)

| Status | Finding | File |
|---|---|---|
| ✗ high | `pushStateFor(cid)` fires on every chat turn; full state goes out via SSE. No diff, no batching, no rate-limit. Long sessions = KB per push. | `server/routes/chat.js:51, 146` + `server/lib/state-bus.js` |
| ✗ high | First-run token printed to stdout in a 14-line ASCII box. Token may end up in shell history / Docker log / systemd journal / screen-share. | `server.js:55-66` |
| ⚠️ moderate | `console.log` per request / per stop. Every chat send logs. | `server/routes/chat.js:84, 106` |

### Baseline 3 — Human attention only to anomaly signals

| Status | Finding | File |
|---|---|---|
| ✗ missing | No dedicated anomaly channel. Errors get appended to `cs.chat` as `! [error] msg`, mixed with normal flow. | `server/routes/chat.js:141` |
| ✗ missing | All errors / warnings go to `console.warn` (stderr). No view-layer alert system. | multiple |
| ⚠️ moderate | First-run token is a "must-see" signal that goes to stdout, not to a view. | `server.js:55-66` |

### Baseline 4 — Verifiability constraints (traceable / checkable / tamper-proof)

| Status | Finding | File |
|---|---|---|
| ✗ missing | No append-only event log. All writes (settings / sessions / uploads / db.js deletes) are silent. | global |
| ✗ high | `settings.json` is full-file overwrite, no diff, no transaction, no checksum. Concurrent `POST /api/settings` would race. | `server/lib/settings.js` |
| ✗ high | `sessions.json` same full-file overwrite pattern. | `server/lib/sessions.js` |
| ⚠️ moderate | `runStartupCleanup` deletes mcode sessions on startup — no user confirmation. | `server/cleanup.js` |

### Baseline 5 — Governance extension reduces LLM participation

| Status | Finding | File |
|---|---|---|
| ✗ host | mcode is the LLM and writes its own state directly. Webui does not mediate. | mcode host |
| ⚠️ moderate | Slash commands can be triggered by the LLM (mcode sees `/delete-session` in user input and runs it). Some slash actions are governance-flavored. | `server/lib/slash.js` (304 lines, full read pending) |

---

## Part 3 — SiHankor Engineering Prohibitions

| Prohibition | Status | Evidence |
|---|---|---|
| LLM must not directly modify knowledge/intent | ✗ host | mcode writes to its own db without webui gating |
| Use of non-reproducible multi-agent output as governance basis | ✓ clean | Webui has no multi-agent surface |
| Stacking LLM calls to substitute deterministic verification | ✓ clean | Settings / sessions CRUD are deterministic |
| All governance operations must write to event stream, tamper-proof | ✗ missing | No event log anywhere |
| Humans only intervene via views, not raw logs | ⚠️ | First-run token to stdout; errors to stderr — no view-layer anomaly system |

---

## Part 4 — Plugin-scope fixes the plugin author can ship

Ranked by impact × ease. Effort estimates are honest ranges.

### Tier 1 — Big impact, half a day (P0)

#### 1. Token onboarding flow — replace stdout dump with first-run modal

**Problem**: `server.js:55-66` prints token to stdout in a 14-line
ASCII box. Token can leak via shell history, Docker log, systemd
journal, screen share.

**Fix**:
- `server.js`: keep only `console.log("token persisted to: <path>")`.
- Frontend SPA: when `?onboarding=1` query is present (or `tokenAcknowledged: false` from `/api/settings`), show a modal that:
  - displays the token in a copy-to-clipboard box
  - displays the LAN URL
  - **requires the user to click "I have saved this token" before it closes**
  - on click, POSTs acknowledgement to `/api/settings` to set `tokenAcknowledged: true`
  - then redirects to clean URL (drops `?token=` query — see #2)

**Effort**: ~200 lines (frontend modal + small server tweak).

#### 2. URL `?token=` — drop query on first validated access

**Problem**: `SECURITY-NOTES.md:18-20` itself acknowledges that
`?token=` leaks via browser history, referer header, shoulder-surf.

**Fix**:
- First request with `?token=`: server validates, sets an httpOnly
  cookie or session-bound state, then 302-redirects to the same path
  without the query string.
- Subsequent requests: SPA uses `Authorization: Bearer` header, never
  sends token in URL.
- Onboarding modal (item 1) explains why the header is better.

**Effort**: ~100 lines (server side redirect + client side refactor).

#### 3. Anomaly channel — independent of state / chat

**Problem**: Errors get appended to chat as `! [error] msg`. User
has to scan the whole conversation to find them.

**Fix**:
- New `server/lib/alerts.js` (parallel to state-bus)
- New SSE channel `/api/alerts` (parallel to `/api/events`)
- Replace `console.warn` for user-facing errors with `pushAlert({level, msg, src})`
- Frontend: top-right bell icon with unread count, click → toast history
- chat row's `! [error]` becomes a *secondary* indicator that highlights when an alert is live

**Effort**: ~300 lines across server + frontend.

#### 4. Slash command autocomplete in chat input

**Problem**: `server/lib/slash.js` is 304 lines with many commands,
but typing `/` in the chat input shows no autocomplete.

**Fix**:
- Frontend: listen for `/` keypress in chat input, show a
  command palette (name + one-line description)
- Tab to complete, Enter to send
- Mark **governance actions** (`/delete`, `/clear`, `/reset`) with a
  ⚠️ icon and a "must be invoked from UI" gate

**Effort**: ~150 lines frontend + ~50 lines server for command metadata export.

### Tier 2 — Medium impact, 1-2 days

#### 5. Chat list virtualization + SSE batching

**Problem**: `pushStateFor(cid)` sends full state on every change. Long
sessions = unperformant.

**Fix**:
- Frontend virtual list (only render visible messages)
- SSE: 60Hz `requestAnimationFrame` coalescing in the public/app/events.js
- Optionally: server-side state diffs (only push what changed) — bigger refactor

**Effort**: ~250 lines.

#### 6. Tool call fold/expand

**Problem**: mcode tool calls show as `▲ tool_name args` in chat, hard
to read args/result.

**Fix**:
- Click to expand → JSON syntax-highlighted input + output
- Failed tools: red border + retry button
- Copy-as-cURL button (for reproducing in terminal)

**Effort**: ~200 lines.

#### 7. Session list — search, sort, bulk delete

**Problem**: Session list shows all sessions, no filter, no sort, no
bulk operations.

**Fix**:
- Sticky search input (filter by title)
- Sort dropdown: updatedAt / createdAt / title
- Multi-select mode for bulk delete (with confirm modal)

**Effort**: ~150 lines.

#### 8. Mobile LAN access — QR code in desktop settings card

**Problem**: Mobile users on the LAN need the URL with token. Currently
they have to manually type it (or scan from text in a chat).

**Fix**:
- Settings card: "Show QR code for mobile" button
- Generates `http://<lan-ip>:8080/?token=<current-token>` as QR
- Modal warns: "QR contains the token; don't share or screenshot"

**Effort**: ~80 lines + a small QR library (or vanilla inline SVG).

#### 9. Plan mode visualization

**Problem**: `plan-mode` capability + `/api/protocol/set-mode` exist,
but plan review UX is unclear.

**Fix**:
- When in plan mode, chat shows a sticky banner: "📋 Plan mode — review before approve"
- Plan steps listed as checkboxes
- Per-step approve / reject (instead of all-or-nothing)
- Submit to mcode to proceed with approved steps

**Effort**: ~250 lines.

#### 10. Ask-user modal

**Problem**: `ask-user-tool` capability exists. `chat.js` has
`isAskAnswer` handling, but the UX path is unclear.

**Fix**:
- Ask prompts become a centered modal, not a chat line
- Input types differ: confirm (yes/no), choice (radio/select), text (input)
- 5-minute default timeout with countdown
- Auto-cancel on timeout sends rejection back to mcode

**Effort**: ~200 lines.

### Tier 3 — Nice to have, weekend

#### 11. i18n coverage check + add `ja-JP` / `ko-KR`

`public/app/i18n.js` exists. Verify all UI strings flow through it
(error messages, buttons, status). Add ja-JP and ko-KR for the
broader East Asian user base. ~half a day.

#### 12. Global search palette (Cmd+K)

Cross-session full-text search, click result to jump to the message.
~1 day.

#### 13. SSE connection state indicator

Top-bar dot: green/yellow/red. Auto-reconnect with backoff. ~half a day.

#### 14. Multi-tier tokens (READ_TOKEN, WRITE_TOKEN)

Mobile devices get READ_TOKEN (read-only); desktop gets WRITE_TOKEN.
Settings card to mint each. ~half a day.

#### 15. Settings card grouping + search

`lib/settings.js` (485 lines) manages a JSON file. UI should group
(Network / Security / Display / Advanced), with search and reset-to-default. ~1 day.

### Tier 4 — Documentation & metadata

#### 16. `plugin.json` capabilities — add description field

Currently 13 capabilities are bare strings. Add `description` to
each so the registry viewer can show what they mean. ~30 min.

#### 17. `CONTRIBUTING.md` / `PR_DESCRIPTION.md` — fill in local setup

Add a "How to run the plugin locally + run tests" section if missing.
Include common `npm test` failure modes. ~30 min.

#### 18. README screenshots / GIFs

Currently README has no images. Add a small gallery: startup → token
modal → chat → tool call → session switch. ~1 hour with screen-capture.

---

## Part 5 — Host-scope items (need mcode team to ship)

These are out of plugin scope but documented for the next conversation
with the mcode team:

1. **mcode emits `event:anomaly`** — webui forwards to `/api/alerts`
2. **mcode emits `event:audit`** — webui forwards to event log
3. **mcode exposes `permission:request` hook** — for governance
   actions to require webui-side confirmation
4. **mcode slash commands surface** — currently the LLM can trigger
   `/delete` etc. by parsing user input. The host should expose a
   `requires_confirmation: true` flag on commands that the plugin
   can enforce.

---

## Test verification (modacker env)

```
Before round 6: 387 pass / 4 fail / 2 skipped
After round 6:  391 pass / 0 fail / 2 skipped
```

The 4 previously-failing integration tests were the
`deleteMcodeSessionFromDb` happy-path / table-missing cases that
required a real `better-sqlite3` binary. Round 6 added a
`<home>/.minimax-code/lib/node_modules/...` standard-install
candidate that hits the actual install location on macOS dev boxes.

---

## Change log

- 2026-08-28: Initial document. Compiled from session review against
  SiHankor engineering baselines + UX heuristics.
