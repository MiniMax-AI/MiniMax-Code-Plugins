# mcode-computer-use

Drive the user's desktop through a **noise-grid addressing protocol**:
the model sees a screenshot with two deterministic random-noise grids
overlaid, and issues clicks, scrolls, drags, and keyboard input via
`(color1, color2, pos, action)` tuples instead of raw pixel
coordinates.

This plugin bundles:

- A **trajectory summarizer** that fires every N turns (default 10)
  and lets the model replace older frames with text descriptions while
  keeping the originals on disk.
- A **private headless browser** backend (Chrome via CDP, Firefox via
  Marionette) that runs under the agent's own permissions — no
  OS-level screen-capture permission required.
- An **opt-in Chromium profile inheritance** flow that copies the
  user's Chrome profile (cookies, cache, login state) into a temp dir
  so the agent can drive a browser with the user's existing sessions.
- An **Agent Activity Dashboard** served on a random localhost port
  with SSE-driven live updates and inline permission UI.

## Install

```bash
cp -r mcode-computer-use ~/.mcode/plugins/local/
mcode plugin enable mcode-computer-use@local
```

## Three run modes

| Mode | Permission | Login state | Best for |
| --- | --- | --- | --- |
| OS desktop (`xdotool` etc.) | OS permission required | User's live session | Full desktop automation |
| Private Chrome (CDP) | None | Fresh, no cookies | Web automation without OS access |
| Inherited Chrome profile | None (after one-time consent) | User's existing session | Authenticated web tasks |

## Browser backends

| Backend | Permission | Login state | Caveat |
| --- | --- | --- | --- |
| Private Chrome (CDP) | None | Fresh | Works on any system with Chrome |
| Inherited Chrome profile | None (after consent) | User's existing session | Copies profile to temp; source untouched |
| Private Firefox (Marionette) | None | Fresh | Firefox 155+ has a Marionette bug — see below |

### Firefox 155 caveat

Firefox 155's headless mode ships with a Marionette TCP server that
accepts connections but **does not respond to WebDriver commands**
(known upstream regression). When you launch Firefox via this plugin
you'll get:

> `Marionette: WebDriver:NewSession timed out after 8000ms (Firefox
> 155+ in headless mode is known to not respond to legacy Marionette
> TCP commands; use BiDi via geckodriver instead)`

Workarounds:
- Install **geckodriver** separately (native binary, outside this
  plugin's "no native binaries" rule — install it yourself).
- Use Chrome instead — works without any extras.
- Use Firefox ESR 115 or older (Marionette still works there).

The Firefox launcher (`lib/cdp-firefox.mjs`) is in place and works
correctly on Firefox versions where Marionette is responsive.

## Required external tools (user-installed, NOT shipped)

| Mode | Linux | macOS | Windows |
| --- | --- | --- | --- |
| OS desktop | `grim` / `scrot` + `xdotool` | `screencapture` (built-in) + `cliclick` | PowerShell (built-in) |
| Private Chrome | `google-chrome` / `chromium` | `google-chrome` | `chrome.exe` |
| Inherited Chrome | same + your profile | same + your profile | same + your profile |
| Private Firefox | `firefox` (and optionally `geckodriver`) | same | same |

The plugin refuses to install any of these and fails fast with a
helpful error if any are missing.

## OS permissions (Mode 1 only)

- **macOS**: System Settings → Privacy & Security → Screen Recording
  → add your terminal. Accessibility → add your terminal.
- **Linux**: usually no prompt; some Wayland compositors require the
  user to grant screen capture explicitly.
- **Windows**: usually no prompt.

## MCP tools (Mode 1: OS desktop)

| Tool | Purpose |
| --- | --- |
| `grid_metadata` | First call of a session. Returns seed, palette, screen size, platform info. |
| `screenshot` | Captures the screen + overlays the noise grid. Returns the composite image + structured `{ seed, gridC, palette, w, h, turn, summary_every }`. |
| `click` | Click at `(color1, color2, pos)`. |
| `scroll` | Scroll at `(color1, color2, pos)` by `(dx, dy)`. |
| `drag` | Drag from one addressed pixel to another. |
| `type_text` | Type a string at the current cursor position. |
| `key_combo` | Synthesize a key combination. |
| `cursor_position` | Return the current cursor pixel. |
| `zoom` | Return a noise-free PNG of a region for reading dense text. |
| `retrieve_frame` | Re-inject a previously archived screenshot. |
| `record_summary` | Store a 1–3 sentence summary for a frame. |

## The noise-grid protocol

Two random-noise grids are overlaid on the screen:

- **Layer A**: square cells of size `C = 32 px`, aligned to (0, 0).
- **Layer B**: same cell size, offset by `(-C/2, -C/2)` so its cell
  (cx, cy) covers `[cx*C - C/2, (cx+1)*C - C/2)`. Every screen pixel
  falls in some Layer B cell.
- Each cell carries one color from a fixed 256-color palette.
- The two layers divide every macro cell of A into **4 sub-cells**
  (each 25% of the macro cell). Each sub-cell carries a unique
  `(color1, color2)` pair.

The model addresses any sub-cell on screen by:

```
{
  "color1": "#RRGGBB",   // Layer A color of the macro cell
  "color2": "#RRGGBB",   // Layer B color of the overlapping cell
  "pos":    [dx, dy],    // pixel offset from sub-cell center, range [-8, 7]
  "button": "left" | "right" | "middle"
}
```

The MCP server resolves the tuple to an exact pixel and dispatches the
input event.

## Trajectory summarization

Every `screenshot` call increments `state.screenshotCount`. On every
turn that's a multiple of `summary_every` (default 10; override via
`MCODE_COMPUTER_USE_SUMMARY_EVERY`), the next `screenshot` response
carries `structuredContent.summary_request`. The model should:

1. For each archived turn, call `record_summary({ turn, summary })`
   with a 1–3 sentence description.
2. Continue the task. The next `screenshot` returns a **noise-only**
   image (no full screen composite).
3. If a later turn requires looking back, call
   `retrieve_frame({ turn })` to re-inject the original archived image.

All archived frames live under `${PLUGIN_DATA}/trajectory/`. The plugin
enforces a 200 MB soft cap (oldest-first eviction).

## Agent Activity Dashboard

The plugin serves a small web dashboard on a random localhost port
via `lib/dashboard.mjs`. The URL is printed when the plugin starts
and pushed to the mcode notification channel. Open it in any browser
to see:

- **Live screen panel**: the model's current view (auto-refresh).
- **Current task**: what the model says it's doing.
- **Action log**: scrolling list of recent tool calls.
- **Trajectory indicator**: countdown to next summary.
- **Permissions panel**: inline "Allow / Decline" buttons for any
  consent requests the model raises.

Plain HTML + JS + SSE — no native window, no install.

## Private headless Chrome (Mode 2)

`lib/cdp.mjs` launches a private Chrome under the agent's permissions
and exposes a small JS API: `navigate`, `screenshot`, `click`,
`clickSelector`, `focusSelector`, `typeText`, `evaluate`, `close`.
The agent never needs OS-level screen capture.

```js
import { launchChrome } from './lib/cdp.mjs';
const ch = await launchChrome({ width: 1280, height: 720 });
await ch.navigate('https://example.com');
const png = await ch.screenshot();
await ch.focusSelector('input[name="q"]');
await ch.typeText('hello world');
await ch.evaluate('document.querySelector("input[name=q]").form.submit()');
await ch.close();
```

This is the path that works **without** any OS permission, on a
headless server, or in any environment where `screencapture` /
`grim` / xdotool are unavailable.

## Chromium profile inheritance (Mode 3)

`lib/profile.mjs` discovers installed Chromium-family profiles
(Chrome, Chromium, Brave, Edge) and copies them to a temp dir. The
copy is then used as the `--user-data-dir` of a private Chrome
instance, so the agent inherits cookies, cache, login state.

```js
import { listAllProfiles, copyChromiumProfile } from './lib/profile.mjs';
const all = await listAllProfiles();
// all.chromium[0].profiles → [ { name: 'Default', hasCookies: true, sizeMB: 432 } ]
const copied = await copyChromiumProfile({
  userDataDir: all.chromium[0].userDataDir,
  profileName: 'Default',
});
// copied.userDataDir is a temp dir owned by the agent
```

For Firefox the plugin does NOT use the user's profile. The Firefox
backend always runs a private, agent-owned profile (`mkdtempSync` +
delete on close). This is the explicit design choice — the user keeps
their Firefox private; the agent has its own.

## Tests

```bash
cd mcode-computer-use
node --test lib/*.test.mjs
```

Covers:
- PRNG determinism.
- Coordinate encoding (encodePixel).
- Round-trip decode within sub-cell tolerance.
- PNG codec encode/decode.
- Overlay / noise-only render produces valid PNG.

## Disclosure

- Captures the screen at every Mode 1 `screenshot` call.
- Writes archived PNGs to `${PLUGIN_DATA}/trajectory/` (200 MB cap).
- Writes dashboard events to memory; no remote network calls.
- Profile inheritance: source profile is read-only; copy lives in
  temp dir and is removed on close.
- Network: zero from this plugin.
- Native binaries: none shipped. Required CLI tools are user-installed.
