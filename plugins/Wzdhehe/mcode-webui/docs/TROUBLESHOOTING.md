# Troubleshooting

> Common failures and how to fix them. Organized by symptom. Every
> entry has the error message you might see, the root cause, and the
> verified fix.

If the fix here doesn't work, enable the in-page debug log (bottom-right
of the webui) and check the right panel for SSE events. You can also
run `node --check public/app/main.js` to verify the file parses.

---

## Page loads but UI is blank

**Symptoms**: HTML loads, no red error block, but the sidebar is
empty and the right panel shows "—" everywhere.

**Cause**: the init() promise chain failed silently, or the SSE
connection never opened.

**Fix**:
1. Open devtools (F12) → Console → look for the `__DBG.log` entries
   at the bottom-right debug panel.
2. If you see `init: start` but not `init: state loaded`, the
   `/api/state` request is failing. Check the network tab.
3. If you see `init done` but the UI is still empty, the SSE
   connection is failing. Reload the page; the webui will
   reconnect.

## `⚠ webui JS 初始化失败: TypeError: Cannot read properties of null (reading 'addEventListener')`

**Symptoms**: full-page red error block in the browser with this
message and a stack trace ending in `attachEvents` or `init`.

**Cause**: the `main.js` script is referencing an HTML element that
was deleted in `index.html`, OR the `cache-bust?v=N` query is out
of date and the browser is running an old main.js.

**Fix**:
1. **Hard-reload** the page (Ctrl+Shift+R). This usually fixes it
   when the issue is stale cache.
2. If hard-reload doesn't help, check `git log --oneline -5` for
   recent commits to `public/index.html` and `public/app/main.js`.
   If main.js was updated but the cache-bust wasn't bumped, bump
   it (see `docs/DEVELOPMENT.md` § "Bump the cache-bust").
3. If the issue is a deleted element, the error message includes
   the line number. Look up the element ID in that line and
   either restore it in `index.html` or remove the JS reference.

## `Failed to load resource: net::ERR_CONNECTION_REFUSED` to `127.0.0.1:8080`

**Symptoms**: devtools shows the SSE or `/api/state` request failing
with "connection refused". UI shows "init fail" or is stuck on
"loading…".

**Cause**: the server is not running, or it's running on a different
port.

**Fix**:
1. Check the server is up: `curl http://127.0.0.1:8080/api/health`
   should return JSON.
2. If not running, start it: `cd webui; node server.js`.
3. If running on a different port, set `$env:PORT = <port>` and
   restart. Then update the URL in the browser.

## `/api/sessions` returns `{ok: true, count: 0}` but the UI shows sessions

**Symptoms**: the API call works and returns sessions, but the
webui's session list is empty.

**Cause**: the webui cached an older empty list. This usually
resolves itself on the next SSE `state` event, but if it's
persistent:

**Fix**: hard-reload the page.

## Sessions missing from the sidebar

**Symptoms**: you have mcode sessions in the TUI but they don't
appear in the webui's session list.

**Cause**: the webui's `state.mcodeSessions` is empty because
`acp-sessions` query failed or hasn't run yet. The webui queries
mcode sqlite via `GET /api/acp-sessions` on init.

**Fix**:
1. Check `curl 'http://127.0.0.1:8080/api/acp-sessions?cid=<your-cid>'`
   — should return a list of sessions.
2. If empty, the Mcode database is empty or the path is wrong.
   Check `$env:USERPROFILE\.minimax\v2\sqlite\runtime-state.sqlite`
   exists.
3. If the API returns sessions but the UI is empty, hard-reload.

## Plan mode modal won't dismiss

**Symptoms**: clicking "Skip" or pressing Esc doesn't close the
plan modal.

**Cause**: the click handler is calling `hidePlan()` but the SSE
event from Mcode hasn't arrived yet, so the next render re-opens
it.

**Fix**:
1. Wait 2-3 seconds for the SSE ack.
2. If it still doesn't dismiss, click "Skip" again — sometimes
   the first click is consumed by the focus ring and the second
   click hits the button.
3. If the modal is truly stuck, the underlying mcode state is
   stuck. Send any user message — the plan context will be
   superseded and the modal will close.

## Ask-user modal reappears after dismissal

**Symptoms**: you click "Skip" on the ask-user modal, then it pops
back up on the next message.

**Cause**: the webui stores the dismissed question id in
`DISMISSED_QUESTIONS` (localStorage). If you clear localStorage
or use a different CID, the dismissal is lost.

**Fix**:
- If the question reappears in the same session: don't clear
  localStorage. If you really need to, double-click the brand
  logo in the top-left to clear `presentedKeys` (this is the
  same as clearing `DISMISSED_QUESTIONS`).
- If the question reappears in a new session: that's by design.
  New session = new state.

## `Failed to load resource: 404` for `favicon.ico`

**Symptoms**: devtools shows a 404 for favicon.ico. Doesn't affect
functionality.

**Cause**: no favicon is served.

**Fix**: this is cosmetic, ignore it. Or add a `public/favicon.ico`.

## SSE connection drops every 30-60 seconds

**Symptoms**: the right panel freezes for a few seconds, then catches
up. devtools shows EventSource repeatedly closing and re-opening.

**Cause**: an intermediate proxy (nginx, cloudflare) is closing
the SSE connection. SSE has no keep-alive in the protocol, so
proxies may decide to close idle connections.

**Fix**:
- Set a longer proxy timeout: `proxy_read_timeout 3600s;` in nginx.
- Or deploy the webui behind a path that doesn't go through a
  proxy. For local dev, this is a non-issue.

## "mcode acp exited (code=null signal=SIGTERM)" in the console

**Symptoms**: the assistant stops mid-response. The chat shows
"agent stopped" toast.

**Cause**: the acp subprocess was killed. The most common reason
is a manual `/stop` click. The "code=null signal=SIGTERM" message
is from acp-exit's `child.on('exit')` listener and is informational.

**Fix**: this is normal after a `/stop`. If it's happening without
a `/stop`, check the server console for the actual exit reason.

## Mid-conversation cancellation doesn't actually stop the model

**Symptoms**: clicking the ⏹ button sends a cancel request but the
model keeps responding for several seconds.

**Cause**: mcode 0.1.5 acp does not implement `session/cancel`. The
webui's `/api/protocol/cancel` falls back to SIGTERM on the
subprocess, but the subprocess takes a moment to die and the
in-flight tool calls may complete first.

**Fix**: wait 2-3 seconds. The model will stop emitting tokens
shortly. If it doesn't, the subprocess is stuck — see "Stuck
Mcode subprocess" below.

## Stuck Mcode subprocess

**Symptoms**: webui shows "running" but no events arrive. The
`/api/stop` endpoint doesn't help.

**Cause**: the acp subprocess is deadlocked (mcode has a bug) or
is waiting on stdin and we're not feeding it.

**Fix**:
1. Open devtools → Network → find the `/api/events` EventSource.
   If it's still open, the issue is on the Mcode side.
2. Find the Mcode subprocess: `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*acp*" }`
3. Kill it: `Stop-Process -Id <PID> -Force`
4. The webui will spawn a fresh subprocess on the next message.

## "Cannot set properties of null" in the right panel

**Symptoms**: red error toast, right panel shows "—".

**Cause**: a render function is reading from a state field that
doesn't exist in the current state object. This usually happens
when a state update from Mcode is missing a field the webui
expects.

**Fix**: hard-reload to re-fetch the full state. The webui
defaults to safe rendering (`if (state.foo) …`) for known
optional fields, so this should be rare.

## Permission mode dropdown shows "—" or doesn't update

**Symptoms**: the mode chip in the right panel is stuck on "—"
or shows the wrong value.

**Cause**: Mcode's permission state isn't being reflected in
`state.permissions`. The webui reads this from the SSE
`state` events.

**Fix**:
1. Check `curl 'http://127.0.0.1:8080/api/state?cid=<cid>' | jq .permissions`
2. If empty, mcode hasn't reported the current permission mode.
   Send any message — the next SSE event will include it.
3. If the webui shows the wrong value, it's because mcode 0.1.5
   acp doesn't implement `session/set_mode`. The displayed value
   is the user's selection, but the actual mcode mode hasn't
   changed. This will fix itself when mcode implements the method.

## "Cannot read properties of undefined (reading 'listSessions')"

**Symptoms**: red error in the right panel when switching sessions.

**Cause**: stale reference to an old mcode-rpc function that was
renamed. If you see this, the webui was loaded from a stale
cache.

**Fix**: hard-reload. If it persists, check the network tab for
the main.js response — it should include the version comment
"v0.5.bx-NN".

## Server won't start: "EADDRINUSE :::8080"

**Symptoms**: `node server.js` exits with EADDRINUSE.

**Cause**: another process is already listening on port 8080.
Usually a previous webui process that didn't clean up.

**Fix**:
1. Find the conflicting process:
   ```powershell
   Get-NetTCPConnection -State Listen -LocalPort 8080
   ```
2. Kill it: `Stop-Process -Id <PID> -Force`
3. Or use a different port: `$env:PORT = 7891; node server.js`

## Token auth: 401 Unauthorized

**Symptoms**: every API call returns 401.

**Cause**: the server is running with `$env:TOKEN` set but the
client isn't sending it. Or the token mismatch.

**Fix**:
1. Check `curl http://127.0.0.1:8080/api/health` — should work
   without auth (health is exempt).
2. Check the URL the webui is using: it should have `?token=…`
   appended, OR the request should have `Authorization: Bearer …`.
3. The webui auto-injects the token from the URL query string.
   Make sure you opened `http://127.0.0.1:8080/?token=…`, not
   `http://127.0.0.1:8080/`.

## Server starts but no Mcode subprocess spawns

**Symptoms**: `/api/health` returns 200, but sending a message
does nothing.

**Cause**: the Mcode binary is not at the expected path. The
default is `<webui-root>/../../mcode.cmd` (which resolves to
`%USERPROFILE%\.minimax-code\mcode.cmd`).

**Fix**:
1. Verify the path: `Test-Path %USERPROFILE%\.minimax-code\mcode.cmd`
2. If it's elsewhere, set `$env:MCODE_CMD = 'C:\path\to\mcode.cmd'`
3. Restart the server.

## Webui is sluggish / typing lags

**Symptoms**: keystrokes take 100+ms to appear in the input box.

**Cause**: usually the chat is rendering a long history. The
`renderChat` function re-renders the entire chat on every state
update. Long chats (>500 messages) hit the limit.

**Fix**:
1. Start a new chat: the old chat is still in the history but
   not in the active view.
2. The webui has lazy rendering for tool calls; if the issue
   persists, the `state.chatHistory` is being mutated. Check
   the in-page debug log.
3. For very long histories, consider implementing virtualized
   scrolling (currently out of scope).
