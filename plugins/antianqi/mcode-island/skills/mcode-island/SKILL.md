---
name: mcode-island
description: Push the user's terminal out of focus to a Windows desktop Dynamic Island pill so the user can watch your work without switching back to mcode. Use when starting long-running bash/edit/read operations, when a tool needs user approval (waiting), on success (done), or on failure (error). Pair every agent bash / read / write / edit call with a corresponding `notify-island.ps1` state push.
license: Apache-2.0
compatibility: Requires Windows 10/11 with PowerShell 5.1+ and the mcode-island widget running (started via `mcode-island start` or `autostart.ps1 -Enable`).
metadata:
  author: antianqi
  version: "0.1.0"
---

# mcode-island — 桌面灵动岛状态通知

让用户在不切回 mcode 窗口的情况下，从桌面顶部悬浮 pill 上看到你（agent）的实时工作状态。

## What it looks like

A 320×60 pill anchored to the top center of the primary display, always-on-top, dark
theme. Six states with distinct color and motion:

| state      | color          | icon | meaning                          |
| ---------- | -------------- | ---- | -------------------------------- |
| `idle`     | gray           | —    | waiting for user input           |
| `thinking` | yellow pulse   | —    | reasoning, no tool call yet      |
| `working`  | blue pulse     | ⚙    | actively running a tool          |
| `waiting`  | orange         | ?    | tool needs user approval / input |
| `done`     | green          | ✓    | step finished, more to do        |
| `error`    | red            | ✕    | tool or step failed              |

Click the pill to switch focus back to the originating terminal tab. Run
`mcode-island pin` from inside a terminal to fix the focus target explicitly
(useful when the auto-detected HWND is wrong, e.g. Windows Terminal multi-tab).

## When to push each state

| moment                                                | state     | example message                |
| ----------------------------------------------------- | --------- | ------------------------------ |
| receive user task, start reasoning                    | `thinking`| (none)                        |
| about to invoke any tool                              | `working` | `"bash: npm test"`            |
| tool returned 0, before reporting back                | `done`    | `"3 files modified"`          |
| tool needs approval (e.g. permission prompt)          | `waiting` | `"bash: needs approval"`       |
| tool failed / threw / non-zero exit                   | `error`   | `"compile failed: missing import"` |
| conversation idle, waiting for user                   | `idle`    | (none)                        |

**Never push the same state twice in a row** — the widget de-duplicates by
state+message. Push only on transitions, or include a fresh message each time.

## Copyable example (agent side)

The plugin ships a thin wrapper `wrap-tool.ps1` that handles state transitions
automatically. Wrap every `bash` invocation through it:

```powershell
# Instead of: bash "npm test"
& "$PSScriptRoot\wrap-tool.ps1" -Tool bash -Command "npm test" -Description "run tests"

# state flow this triggers: working("bash: run tests") → done("bash 完成") | error(...) | waiting(...)
```

For other tools (read/write/edit) — and for any state push that is not a single
command — call `notify-island.ps1` directly:

```powershell
$plugin = Split-Path -Parent $PSScriptRoot   # <plugin install dir>
& "$plugin\notify-island.ps1" -State thinking
& "$plugin\notify-island.ps1" -State working  -Message "read source tree"
& "$plugin\notify-island.ps1" -State done     -Message "indexed 142 files"
& "$plugin\notify-island.ps1" -State error    -Message "compile failed: missing import"
& "$plugin\notify-island.ps1" -State waiting  -Message "permission prompt"
```

`<plugin install dir>` is the directory that contains `notify-island.ps1`.
Substitute the absolute path your user installed the plugin at. The Skill body
deliberately avoids hard-coded paths so any user / any install location works.

## Expected result

After each push, the widget on the user's primary display updates within
~400 ms (one polling cycle). On click, the originating terminal tab regains
focus. The widget is intentionally hard to kill: Alt+F4 hides it, not closes
it, and `mcode-island show` re-raises the hidden window in under 1 second.

## User-side management

```cmd
mcode-island                  REM start the widget (idempotent)
mcode-island stop             REM stop the widget
mcode-island status           REM show PID + recent log
mcode-island show             REM re-raise hidden window
mcode-island pin              REM lock focus target to current foreground window
mcode-island unpin            REM clear focus target
mcode-island autostart-on     REM register for Windows logon
mcode-island autostart-off    REM unregister
```

To enable login auto-start, the user runs once:

```powershell
& "<plugin install dir>\autostart.ps1" -Enable
```

This writes to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` — no admin
rights required.

## Runtime data

All widget state lives under `%APPDATA%\mcode-island\`:

| file             | purpose                                               |
| ---------------- | ----------------------------------------------------- |
| `status.json`    | current state (widget polls this every 400 ms)        |
| `caller.json`    | originating terminal HWND / PID (for click-to-focus)  |
| `config.json`    | pill position, size, opacity (saved on drag)          |
| `widget.pid`     | widget process PID (used by start/stop/status)        |
| `island.log`     | append-only state transition history                  |
| `widget.log`     | widget internal debug log                             |
| `show.signal`    | transient file written by `mcode-island show`         |

No data leaves the local machine. The plugin does not make any network request.

## What is in this package

```
mcode-island/
├── plugin.json                    # plugin manifest
├── README.md                      # full user-facing docs
├── LICENSE                        # Apache-2.0
├── mcode-island.ps1               # WPF widget main loop
├── mcode-island.cmd               # CLI shim (start/stop/status/...)
├── start-island.ps1               # launch the widget in STA
├── stop-island.ps1                # stop the widget
├── status-island.ps1              # print widget state
├── show-island.ps1                # re-raise hidden widget
├── pin-island.ps1                 # lock focus target to foreground
├── autostart.ps1                  # register/unregister Windows logon
├── notify-island.ps1              # state-push helper (agents call this)
├── wrap-tool.ps1                  # all-in-one bash wrapper
├── skills/mcode-island/SKILL.md   # this file
└── assets/                        # screenshots used in the README
```

## Limitations and known constraints

- Windows 10/11 only (uses WPF and `presentationframework`).
- Single widget per user session.
- No hover-expand, no media-control integration yet — see the `v0.2` roadmap in
  the upstream issue tracker.
- `wrap-tool.ps1` only wraps `bash`. For `read` / `write` / `edit` the agent
  must call `notify-island.ps1` itself before and after the tool call.
