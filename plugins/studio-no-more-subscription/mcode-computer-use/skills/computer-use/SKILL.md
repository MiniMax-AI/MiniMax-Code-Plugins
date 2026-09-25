---
name: computer-use
description: Drive the user's desktop through the mcode-computer-use MCP tools. Activates when the user asks to click something visible, automate an application, fill a form, test a UI flow, or interact with a window the model can see.
license: Apache-2.0
compatibility: Requires the mcode-computer-use plugin and the platform-specific tools listed in its README (screencapture/cliclick on macOS, grim|scrot + xdotool|ydotool on Linux, or PowerShell on Windows).
metadata:
  author: bro
  version: "0.1.0"
---

# Computer Use — Noise-Grid Address Protocol

You see a screenshot with **two overlaid noise grids**:

- **Layer A**: square cells (32 px) aligned to (0,0).
- **Layer B**: same size, offset by (16, 16) — i.e. half a cell.
- Where they overlap, each 16×16 sub-cell carries two colors: the
  Layer-A color (`color1`) and the Layer-B color (`color2`).

## Address → pixel

Any sub-cell on screen is uniquely addressed by `(color1, color2, pos)`:

| Field | Type | Meaning |
| --- | --- | --- |
| `color1` | `"#RRGGBB"` | Color of the Layer-A macro cell containing the target. |
| `color2` | `"#RRGGBB"` | Color of the Layer-B cell overlapping the target. |
| `pos`    | `[dx, dy]` | Pixel offset from the sub-cell center, range `[-8, 7]`. |

The MCP server resolves the tuple to an exact pixel and dispatches the
input. The palette is **fixed across sessions** but the grid **layout is
seeded per session** — so the same color pair may map to different
pixels across sessions; always re-call `screenshot` (and use the returned
`seed`/`palette` in `structuredContent`) when starting a new task.

## Tools (call exactly these names)

- `grid_metadata` — call once per session to learn the seed, palette, screen size, and platform info.
- `screenshot` — returns the composite image + structuredContent `{ seed, gridC, palette, w, h, turn, summary_every }`. The turn counter increments every call.
- `click` — `{ color1, color2, pos, button?, modifiers? }`.
- `scroll` — same address fields plus `dx, dy` (line counts, positive = down/right).
- `drag` — `{ from, to }` where each is `{ color1, color2, pos }`.
- `type_text` — `{ text, interval_ms? }`. Types at the current cursor position.
- `key_combo` — `{ keys }`. e.g. `["ctrl","c"]`.
- `cursor_position` — returns the current pixel coordinates.
- `zoom` — `{ region: [x0,y0,x1,y1] }`. Returns a noise-free PNG of that region for reading dense text.
- `retrieve_frame` — `{ turn }`. Re-injects a previously archived screenshot (used after summarization).
- `record_summary` — `{ turn, summary }`. Stores a 1–3 sentence summary for a frame.

## Recommended loop

1. `screenshot` → read the composite image, identify the target sub-cell's `(color1, color2)` by visual inspection.
2. `click` (or `scroll`/`drag`) with that address.
3. `screenshot` → confirm the UI responded.
4. Repeat until the task is done or stable.

Use `zoom` whenever a region contains dense text or small icons you cannot identify from the composite.

## Trajectory summarization

Every `summary_every` screenshots (default **10**), the next `screenshot` call returns `structuredContent.summary_request`. At that point:

1. For each prior archived turn, call `record_summary` with a 1–3 sentence summary.
2. The next `screenshot` returns a **noise-only** image (no full screen composite) so older frames no longer crowd the context.
3. If you need to look back at an old frame, call `retrieve_frame({ turn })`.

## Worked example

User: "Open Safari and search for 'mcode plugins'."

1. Call `screenshot`. Inspect the composite image; locate the Safari icon in the Dock.
2. Read its `(color1, color2)` from the noise overlay. Estimate `pos` near the icon's center.
3. `click({ color1, color2, pos, button: "left" })`.
4. `screenshot` again. If Safari is open, proceed; otherwise refine `pos`.
5. Once Safari is open and focused, use `key_combo({ keys: ["cmd","l"] })` to focus the address bar, then `type_text({ text: "https://google.com\n" })`.
6. `screenshot`, then `click` the search box, then `type_text`, then `key_combo({ keys: ["enter"] })`.
7. After the 10th `screenshot`, `record_summary` for each archived turn.

## Disclosure

- Sends a captured screen image to the model at every `screenshot` call.
- The MCP server writes PNGs to `${PLUGIN_DATA}/trajectory/` (default cap 200 MB; oldest frames are rolled out).
- The plugin does **not** ship native binaries; required CLI tools are user-installed.
