# Capabilities

> Source of truth for what this webui can and cannot do. Every row has
> a status (✅ works · ⚠ partial · ❌ blocked), a why, and where to
> look in the code.

The webui is bound by three constraints:
1. What mcode 0.1.5 acp exposes via JSON-RPC.
2. What the Node `http` / `child_process` APIs can do.
3. What the browser's `EventSource` and `fetch` can do.

Anything outside these three is either ❌ blocked (no workaround) or
⚠ partial (workaround exists, with caveats).

## 1. Core chat

| Feature | Status | Why / where |
|---|---|---|
| Multi-turn conversation with streaming deltas | ✅ | `mcode-acp.js` reads newline-delimited JSON; `state-bus.pushEvent` broadcasts `delta` events |
| Multi-line assistant responses | ✅ | `parseChatLines` joins delta chunks per turn |
| Tool calls (Bash, Read, Write, Edit, …) | ✅ | forwarded from acp `tool_call` events |
| Auto-collapse of completed tool output | ✅ | CSS-only, no logic |
| Markdown rendering (headings, lists, code) | ✅ | `lib/marked.min.js` vendored locally (no CDN) |
| Syntax highlighting in code blocks | ✅ | highlight.js (local copy) |
| Cancel mid-run | ⚠ | acp `session/cancel` returns "Method not found" in 0.1.5. The webui's `/api/protocol/cancel` falls back to SIGTERM on the subprocess. The acp session may emit a few extra events before dying. |
| Rewind / fork a message | ❌ | Not in mcode acp 0.1.5 |
| Edit a sent message and resend | ❌ | Not exposed by the acp protocol |
| Regenerate the last assistant response | ❌ | No acp method to discard a turn |
| Stream intermediate thinking (`<thinking>`) | ⚠ | Rendered if present in delta, but mcode 0.1.5 emits them as plain text — no structured separation |

## 2. Plan mode

| Feature | Status | Why / where |
|---|---|---|
| Enter plan mode (`/plan` slash) | ✅ | webui adds a `Plan: ` prefix to the prompt; mcode acp responds with a structured plan event |
| Plan review modal with options | ✅ | `renderPlan()` builds the modal; user choice goes through `/api/answer` |
| Plan with three or more options | ✅ | server returns `options` array; client renders N buttons |
| "Add context to revise" plan option | ✅ | `plan-add-context` textarea shown only when user picks option index 2 |
| Plan summary preview while still streaming | ⚠ | mcode acp emits `plan_summary` only on finalization. The webui shows the modal only after the plan event arrives. |
| Skip plan and go directly to execution | ✅ | option index 1 in the modal |

## 3. Permission prompts

| Feature | Status | Why / where |
|---|---|---|
| Session-level permission mode (`ask`/`auto`/`full`) | ✅ | `state.permissions`; webui sends `setMode` only via the `/api/protocol/set-mode` endpoint, which mcode 0.1.5 returns "Method not found" for. The mode shown is mcode's last-known value. |
| Per-tool permission prompt modal | ✅ | when acp emits a `permission` event, `checkModals()` opens `#perm-modal` |
| Approve / deny / always-allow-this-tool | ✅ | three options: `ask`, `auto`, `full`; sent via `/api/answer` |
| Pre-grant a tool for the rest of the session | ⚠ | same as mode setting; per-call only — there's no per-tool whitelist in mcode 0.1.5 |
| Custom rules (e.g. "Bash on /tmp is auto, rest is ask") | ❌ | mcode acp has no rule language |

## 4. Ask-user tool

| Feature | Status | Why / where |
|---|---|---|
| Modal question with 2-4 options | ✅ | `bindAskModal()` builds the modal from acp's `ask` event |
| Multi-select (checkboxes) | ✅ | acp `multiSelect: true` → webui renders checkboxes |
| Free-text "Other" input | ✅ | per-question "Other" field; sends via `/api/send {isAskAnswer:true}` |
| Skip / dismiss an ask | ✅ | the close button stores the question id in `DISMISSED_QUESTIONS` so it never re-appears in the same session |
| Re-show a dismissed question | ✅ | double-click the brand logo to clear `presentedKeys` |
| Re-prompt the same question | ⚠ | once a question id is in `DISMISSED_QUESTIONS`, the webui silently drops it. Clearing the set is a manual gesture. |
| Nested questions (one ask containing sub-questions) | ⚠ | the protocol supports a `questions` array; the webui renders them as separate modals queued one after another, not nested in a single modal. |
| Optional / required flag | ❌ | mcode 0.1.5 doesn't expose the optional flag — every question is treated as required |

## 5. Slash commands

| Feature | Status | Why / where |
|---|---|---|
| Built-in command list (`/help`, `/compact`, `/model`, …) | ✅ | mcode acp `session/commands` is fetched at connect; cached in `mcodeCommandsCache` |
| Command autocomplete on `/` | ✅ | `filterSlash()` builds the overlay; matches against `cmd` and `description_*` |
| Local (webui-side) commands | ✅ | `/exec` switches transport to mcode exec; `/clear` clears the chat UI without touching mcode |
| Hidden / experimental commands | ⚠ | the acp `commands` list returns everything mcode knows about. The webui has no `hidden` flag yet. |

## 6. Workspaces

| Feature | Status | Why / where |
|---|---|---|
| Switch workspace via picker | ✅ | `submitWorkspaceChange` POSTs to `/api/workspace` |
| Visual directory-tree browser (Windows drive roots) | ✅ | `/api/workspace/browse` lists children; `renderTreeNodes` builds the tree |
| Recent workspaces (last 5) | ✅ | `localStorage.webui_workspace_recents_v1` |
| Restore last workspace on reload | ✅ | `localStorage.webui_workspace_last_v1` → server `detect` then `change` on init |
| Lock workspace for the duration of a chat | ✅ | once a chat is started, the workspace chip is hidden; a new chat reopens the picker |
| Per-workspace git status (branch, dirty) | ⚠ | best-effort; the server shells out to `git status` once on workspace change. Errors are silently swallowed → the chip shows "—". |
| Symlink resolution in the directory browser | ❌ | `fs.readdir(..., {withFileTypes:true})` returns symlinks as `Dirent`; webui shows them as files. No symlink-follow option yet. |
| WSL path support | ❌ | `/api/workspace/browse` uses `path.join`, which on Windows is `\\`-aware but doesn't translate WSL `\\wsl$\…` paths |

## 7. Sessions

| Feature | Status | Why / where |
|---|---|---|
| Session list (sidebar) | ✅ | merged from `state.sessions` (webui JSON) + `state.mcodeSessions` (mcode sqlite) |
| Per-workspace session grouping | ✅ | `renderSessions()` groups by `workspace` field |
| Switch session on click | ✅ | `setActiveSession(id)` calls `/api/sessions/switch` |
| New chat from button | ✅ | opens the workspace picker first if no workspace is set |
| Delete session from sidebar | ✅ | two-tap confirm: `session-delete` button → 5-second confirm bar |
| Delete session in mcode sqlite too | ✅ | `/api/sessions/:id` DELETE handler calls `deleteMcodeSessionFromDb` (8 tables in a transaction) |
| Cleanup orphaned mcode sessions | ✅ | `/api/sessions/cleanup-orphans` lists mcode sessions not referenced by any webui session, then deletes them (scope: `orphans` or `all`) |
| Resume an mcode session opened in the TUI | ❌ | the acp session has a single owner; the webui shows a read-only banner when it detects a foreign owner |
| Cross-workspace session search | ⚠ | the search input filters the current list; it does not aggregate across workspaces. Switching the filter to a different workspace works. |
| Export a session to Markdown / JSON | ❌ | not in mcode acp; would require reading mcode's sqlite directly |

## 8. Token usage & quota

| Feature | Status | Why / where |
|---|---|---|
| Per-turn context window (% used) | ✅ | webui accumulates `delta` events; per-turn value is computed in `renderContext` |
| Cache read ratio | ✅ | parsed from acp `cache_read_input_tokens` |
| tok/s (current stream speed) | ✅ | computed over a rolling 2-second window from `delta` events |
| `mavis` runtime db per-turn context (last turn) | ✅ | `mavis-usage.js` reads `local_runtime_token_usage`; per-turn calculation in `lastTurnContextTokens` |
| `mmx quota show` parsed | ✅ | `usage.js` wraps the CLI; refreshes every 2 minutes (silent) and on manual click |
| Time-until-reset (5-hour + weekly) | ✅ | `formatResetTime()` displays `n小时m分` / `n天m小时` |
| Forecast exhaustion time | ❌ | not in mcode 0.1.5 quota data |

## 9. Attachments

| Feature | Status | Why / where |
|---|---|---|
| Click-to-upload button | ✅ | hidden `<input type=file>` opened by the attach button |
| Drag & drop into the chat area | ✅ | `chatArea.addEventListener('drop', …)` |
| Paste image from clipboard (Ctrl+V) | ✅ | `textarea.addEventListener('paste', …)` reads `clipboardData.files` |
| File path injection as `@file` | ✅ | `upload.js` saves to `MCODE_WEBUI_UPLOAD_DIR`; client injects `@/absolute/path` into the prompt |
| Image preview before send | ⚠ | filename only, no inline thumbnail. mcode acp accepts `@file` and decides rendering. |
| Multi-file attach (≥ 2 in one drop) | ✅ | `dataTransfer.files` iteration |
| Per-message attachment delete (×) | ✅ | `removeAttachment(idx)` |
| Resume upload after disconnect | ❌ | upload is sync (one-shot POST); no chunked upload support |

## 10. UI / UX

| Feature | Status | Why / where |
|---|---|---|
| Bilingual UI (zh-CN / en) | ✅ | `I18N.zh` / `I18N.en` tables; `t(key)` lookup |
| Light / dark theme | ✅ | `data-theme` on `<html>`; `prefers-color-scheme` initial value |
| Mobile responsive (< 900 px) | ✅ | CSS media queries; drawer layout for sidebar + right panel |
| Single column at < 600 px | ✅ | `flex-direction: column` |
| In-page debug log panel | ✅ | bottom-right black panel; copy / clear; 30-line ring buffer |
| Toast notifications | ✅ | `#toast-root` with 3-second auto-dismiss |
| Keyboard shortcuts (Ctrl+K focus, Esc close, …) | ✅ | global keydown handler in `attachEvents()` |
| Slash-command keyboard navigation (↑↓ Enter Tab) | ✅ | `slashInput.addEventListener('keydown', …)` |
| Dark mode respecting OS preference | ✅ | `prefers-color-scheme` media query at boot |
| Custom CSS themes | ❌ | no theme loader; would need a CSS-vars system |
| User-defined hotkeys | ❌ | shortcuts are hard-coded |

## 11. Network & access control

| Feature | Status | Why / where |
|---|---|---|
| HTTP server | ✅ | Node `http.createServer` |
| LAN sharing with on/off toggle | ✅ | runtime state in `settings.lanBroadcastEnabled`; closed by default for non-local IPs |
| Friendly 403 page when LAN is off | ✅ | `LAN_REJECT_HTML` template in `settings.js` |
| Token auth (`?token=` or `Authorization: Bearer`) | ✅ | `server.js` validates `req.url` and `req.headers.authorization`; if set, every request must include the token |
| Per-cid SSE channel | ✅ | one EventSource per browser tab; one mcode subprocess per cid |
| HTTPS | ❌ | would need a reverse proxy (nginx, caddy). Documented in the README. |
| mTLS / client cert | ❌ | same as above |
| Rate limiting | ❌ | not implemented; rely on LAN-only deployment + token auth |

## 12. Operations

| Feature | Status | Why / where |
|---|---|---|
| Zero npm install | ✅ | Node stdlib only |
| Configurable port via `PORT` env | ✅ | `config.js:34` |
| Configurable host via `HOST` env | ✅ | `config.js:36` |
| Configurable default model via `MCODE_MODEL` env | ✅ | `config.js:37` |
| Uncaught exception sink (`.server.err`) | ✅ | `installGlobalErrorHandlers` |
| Graceful shutdown on SIGTERM / SIGINT | ✅ | `mcode-acp.js` forwards signals to the child |
| systemd / Windows Service manifest | ❌ | out of scope; user is expected to use `pm2`, `nssm`, or run in a terminal |
| Hot reload of code | ❌ | restart the server |
| Health check endpoint | ✅ | `GET /api/health` returns `{ok:true, port, defaultModel, defaultWorkspace, mcodeCmd, mcodeVersion, maxConcurrent}` |

## 13. What mcode would need to add to enable the ❌ rows

- `set_mode` / `set_config_option` → mid-session permission switch in the UI
- `cancel` → true mid-flight cancellation, not just SIGTERM
- `fork` / `resume` / `rewind` → rewind/regenerate UI
- `request_permission` with structured rules → per-tool whitelist
- `session/message.delete` → "edit and resend"
- `session/export` → export to MD/JSON
- `tool_call.input.thumbnail` → inline image preview
- A quota metric with rate-of-use → forecast exhaustion time
- An optional flag on ask questions → optional questions
- A path-prefix resolver for WSL symlinks → WSL path support

These are upstream asks. See [docs/acp-goal-plan-status.md](acp-goal-plan-status.md)
for the historical list and the response from the mcode team.
