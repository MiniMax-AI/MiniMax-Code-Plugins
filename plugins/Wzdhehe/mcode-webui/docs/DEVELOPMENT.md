# Development

> How to work on this codebase. Audience: someone who has the repo
> cloned and wants to add a feature, fix a bug, or understand the
> codebase well enough to review PRs.

## Setup

Requirements:
- Node 22.19+ or 24+ (project enforces in `package.json` `engines`)
- mcode 0.1.4+ installed and on `PATH` (or pointed to via `MCODE_CMD`)
- For SQLite (used in session cleanup): `better-sqlite3` is loaded
  lazily, so it's not required at install, only at runtime when you
  hit the cleanup endpoint. The `SQLITE3_BIN` env var points to a
  precompiled binary if you need to read the db manually.

Zero npm install. Clone, run:
```powershell
cd ~/.minimax-code/webui
node server.js
# → http://127.0.0.1:8080
```

If you want a debug session (verbose SSE, no cache, injectable events):
```powershell
$env:DEBUG_INJECT = '1'
node server.js
```

## Code structure (recap from ARCHITECTURE.md)

- `server.js` — 100 lines of bootstrap. Don't add features here.
- `server/router.js` — declarative route table. Add your route here.
- `server/routes/*.js` — one file per URL family. Each exports
  `async function handleXxx(req, res, ctx, pathname)`.
- `server/lib/*.js` — pure modules. One concern each.
- `public/app/main.js` — single ES module frontend. ~4200 lines,
  no build step.
- `public/styles/main.css` — single stylesheet.
- `public/index.html` — markup only.

## Adding a new HTTP endpoint

1. Create `server/routes/foo.js`:

   ```js
   // server/routes/foo.js
   import { pushStateFor, getClient } from '../lib/state-bus.js'
   import { fail, ok } from '../lib/util.js'  // if you have one

   export async function handleFoo(req, res, ctx, pathname) {
     const cid = ctx.cid
     if (!cid) return fail(res, 400, 'cid required')

     const body = await readJsonBody(req)
     if (!body) return fail(res, 400, 'invalid JSON')

     // do the work…

     // if it mutates state:
     pushStateFor(cid, { /* delta */ })
     // for one-off SSE messages, see `pushOnlineCount` / `broadcastTokenRotated`

     return ok(res, { /* response */ })
   }
   ```

2. Wire it in `server/router.js`:

   ```js
   import * as fooRoute from './routes/foo.js'
   …
   { method: 'POST', match: (p) => p === '/api/foo', handler: fooRoute.handleFoo },
   ```

3. If the webui calls it, add a helper in `public/app/main.js`:

   ```js
   async function apiFoo(payload) {
     const r = await fetch('/api/foo' + API_SUFFIX, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json', ...HEADERS },
       body: JSON.stringify(payload),
     })
     return r.json()
   }
   ```

4. **Don't write to `clientState.state` directly** from a route handler.
   Use `pushStateFor(cid, …)` so the change is broadcast on the SSE
   channel and the client is the source of truth.

## Adding a new SSE event type

1. Define the event shape in `docs/ARCHITECTURE.md § 5` (SSE event schema).
2. In the transport layer (`mcode-acp.js` or `mcode-exec.js`), translate
   the raw mcode event to your normalized event:
   ```js
   yield { type: 'foo', … }
   ```
3. The transport layer pushes events via `pushStateFor(cid, …)` (state
   snapshots) or `broadcastTokenRotated(token)` (one-off event) which
   go onto the SSE channel.
4. In `public/app/main.js`, handle the event in the SSE message
   handler in `connect()` and update `state.foo` accordingly.
5. If the event needs UI, add a render function `renderFoo()` and call
   it from `render()`.

## Adding a new UI panel

1. Add the panel markup to `public/index.html` (near related panels).
2. Add i18n keys to BOTH `I18N.zh` and `I18N.en` (use a consistent
   prefix: `panel_foo_title`, `panel_foo_empty`).
3. In `public/app/main.js`:
   - Add an entry to the `els` DOM cache in `init()`.
   - Add a `renderFoo()` function that reads from `state` and writes
     to `els.fooPanel`.
   - Call `renderFoo()` from `render()`.
4. Add CSS to `public/styles/main.css` scoped under `.foo-panel`.

## Adding a slash command (webui-side)

These are commands the webui handles itself without forwarding to mcode
(used for things like `/clear`, `/exec`).

1. In `server/lib/slash.js`, add an entry:
   ```js
   { cmd: '/foo', handler: handleFoo, hidden: false }
   ```
2. `handleFoo` receives `(content, ctx)` and returns either:
   - `null` (not handled, forward to mcode)
   - `{ handled: true, response: '…' }` (handled, send to user as a
     synthetic message)
3. The webui displays `response` as if it came from mcode.

## Adding a mcode-translated slash command

If you want a slash command that maps to an mcode command, you don't
add code — mcode returns the command list via `session/commands` and
the webui already renders it. Just make sure mcode knows about the
command; the webui picks it up on connect.

## Testing without mcode

1. Set `$env:DEBUG_INJECT = '1'` before `node server.js`.
2. Open `http://127.0.0.1:8080/?debug=1` (or just check the right
   panel — the debug panel is always visible).
3. In the browser console:
   ```js
   await fetch('/api/debug/inject' + API_SUFFIX, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ type: 'delta', text: 'hello from test' })
   })
   ```
4. The injected event appears in the right panel and in the SSE
   stream.

You can also call `__DBG.log('whatever')` from the console — it shows
up in the bottom-right debug panel.

## Database inspection

The webui-side session store is plain JSON:
```powershell
Get-Content "$env:USERPROFILE\.minimax-code\webui\.webui-sessions.json" | ConvertFrom-Json
```

The mcode-side session store is SQLite:
```powershell
& "$env:USERPROFILE\anaconda3\Library\bin\sqlite3.exe" `
  "$env:USERPROFILE\.minimax\v2\sqlite\runtime-state.sqlite" `
  ".tables"
& "$env:USERPROFILE\anaconda3\Library\bin\sqlite3.exe" `
  "$env:USERPROFILE\.minimax\v2\sqlite\runtime-state.sqlite" `
  "SELECT id, title, cwd FROM local_runtime_sessions ORDER BY updated_at DESC LIMIT 10"
```

## Common tasks

### Bump the cache-bust
After changing `public/app/main.js`:
1. Edit `public/index.html` line `<script src="/app/main.js?v=N">`.
2. Bump N. (Current value: see the comment above the script tag.)

### Change the default port
```powershell
$env:PORT = 8080
node server.js
```

### Enable LAN sharing
Two options:
- Web UI: bottom-left "局域网访问" button
- API: `POST /api/settings {lanBroadcast: true}`

### Debug a stuck mcode subprocess
The webui keeps one subprocess per CID. If it's stuck:
```powershell
# find the cid
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*acp*" } |
  Select-Object ProcessId, CommandLine

# kill it (replace PID)
Stop-Process -Id 12345 -Force
```

The webui will spawn a fresh one on the next send.

### Re-enable LAN after locking yourself out
The `/api/settings` endpoint is exempt from the LAN guard by design.
From any machine on the LAN, even with `lanBroadcast: false`:
```bash
curl -X POST http://192.168.1.50:8080/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"lanBroadcast": true}'
```

## Style guide

- **Server**: no semicolons, single quotes, 2-space indent, ESM.
  - Use `import` not `require`.
  - Top-level `await` is fine in scripts, not in modules — wrap in
    `async function main()` if needed.
- **Client** (`main.js`): same conventions. No build step, so
  prefer features that work in evergreen browsers without polyfills.
- **Comments**: explain *why*, not *what*. If the code does what its
  name says, no comment needed. If a workaround is needed, the
  comment should reference the upstream issue.
- **i18n**: any user-visible string goes through `t('key')`. No
  hard-coded Chinese or English in `main.js` outside the I18N
  tables.
- **CSS**: prefer CSS custom properties for theming. New
  components: define vars in `:root` (light) and `[data-theme=dark]`
  (dark).

## Code review checklist

Before sending a PR:

- [ ] `node --check server.js` passes
- [ ] `node --check public/app/main.js` passes
- [ ] No new hard-coded user-visible strings (everything via `t(...)`)
- [ ] No direct writes to `clientState.state` (use `pushStateFor`)
- [ ] If a new endpoint, documented in `docs/API.md`
- [ ] If a new event type, documented in `docs/ARCHITECTURE.md § 5`
- [ ] If a new UI panel, both `zh` and `en` i18n keys present
- [ ] Cache-bust bumped if `main.js` changed
- [ ] No new npm deps without discussion

## Repository hygiene

- Don't commit `.server.err`, `.server.log`, `node_modules`, etc.
  The `.gitignore` covers these.
- Don't commit probe scripts to the root. The `probes/` directory
  is a scratch space for one-off diagnostic scripts; clean it
  after use.
- Commit messages: imperative mood, present tense ("add X", not
  "added X"). Reference the issue if there is one.
