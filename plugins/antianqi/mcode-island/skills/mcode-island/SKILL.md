---
name: mcode-island
description: Push the user's terminal out of focus to a Windows desktop Dynamic Island pill so the user can watch your work without switching back to mcode. On mcode 0.2.4+ with the `io.minimax.mcode` Hooks extension enabled (forward-compatible with MiniMax-Code-Plugins PR #20), every tool lifecycle event fires a script under `io.minimax.mcode/hooks/scripts/` automatically — the agent does not need to push states manually. On older mcode or when the extension is not yet active, fall back to calling `notify-island.ps1` before and after each tool call, or use `wrap-tool.ps1` for the bash path.
license: Apache-2.0
compatibility: Requires Windows 10/11 with PowerShell 5.1+ and the mcode-island widget running (started via `mcode-island start` or `autostart.ps1 -Enable`). Hook-driven mode additionally requires mcode 0.2.4+ with the `io.minimax.mcode` extension namespace accepted by the registry validator.
metadata:
  author: antianqi
  version: "0.3.0"
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

## Two ways to drive the pill

### Mode A — Hook-driven (mcode 0.2.4+ with `io.minimax.mcode`)

When mcode accepts the `io.minimax.mcode` client extension, the runtime spawns
the script under `io.minimax.mcode/hooks/scripts/<event>.ps1` for every matching
lifecycle event. The agent does **not** need to push state manually.

| event             | script                            | pill state  |
| ----------------- | --------------------------------- | ----------- |
| `SessionStart`    | `session-start.ps1`               | `idle`      |
| `SessionEnd`      | `session-end.ps1`                 | `idle`      |
| `UserPromptSubmit`| `user-prompt-submit.ps1`          | `thinking`  |
| `PreToolUse`      | `pre-tool-use.ps1`                | `working`   |
| `PostToolUse`     | `post-tool-use.ps1`               | `done`/`error` |
| `Stop`            | `stop.ps1`                        | `done`      |
| `PreCompact`      | `pre-compact.ps1`                 | `thinking`  |
| `Notification`    | `notification.ps1`                | `idle`      |
| `SubagentStart`   | `subagent-start.ps1` (CODEX only) | `working`   |
| `SubagentStop`    | `subagent-stop.ps1`  (CODEX only) | `done`      |
| `PermissionRequest`| `permission-request.ps1` (returns `{"decision":"allow"}` so the runtime's fail-closed default does not deny) | `waiting` |
| `PermissionDenied`| `permission-denied.ps1`           | `error`     |

The hooks conform to the portable spec proposed in
`MiniMax-Code-Plugins` PR #20. Each script reads the JSON event payload from
stdin, calls `notify-island.ps1` with the appropriate state, and exits 0
(decision-bearing events also write a JSON decision to stdout). Self-push
filtering prevents the pill from churning when the agent calls
`notify-island.ps1` directly through Bash.

If you are running on mcode 0.2.4+ and the pill is updating itself before you
push anything, Mode A is active. Otherwise fall through to Mode B.

### Mode B — Agent-pushed (legacy, always works)

For older mcode, or when the `io.minimax.mcode` extension is not yet active
(registry validator has not accepted the namespace), the agent pushes state
through `notify-island.ps1` directly. The `mcode-status-detect.ps1` detector
also infers state from the runtime's `ledger.jsonl` / `messages.jsonl`, so
the pill will still move — your manual pushes just sharpen the message and
cover edge cases (notably `ask_user`).

| moment                                                | state     | example message                |
| ----------------------------------------------------- | --------- | ------------------------------ |
| receive user task, start reasoning                    | `thinking`| (none)                        |
| about to invoke any tool                              | `working` | `"bash: npm test"`            |
| tool returned 0, before reporting back                | `done`    | `"3 files modified"`          |
| tool needs approval (e.g. permission prompt)          | `waiting` | `"bash: needs approval"`       |
| about to call `ask_user` (user must pick)             | `waiting` | `"ask_user: 2 options"`       |
| user answered `ask_user`, resuming work                | `done`    | `"ask_user answered"`         |
| tool failed / threw / non-zero exit                   | `error`   | `"compile failed: missing import"` |
| conversation idle, waiting for user                   | `idle`    | (none)                        |

**`ask_user` is a special tool** — the detector cannot infer it is a "wait for
user" moment (it looks like any other tool call to the session log). When in
Mode B, the agent MUST push `waiting` immediately before invoking `ask_user`,
and `done` immediately after the user answers; otherwise the pill will sit in
`working` (yellow/blue) while the user is actually being asked to decide. In
Mode A, the same coverage comes for free because `ask_user` is a tool call
that fires `PreToolUse`/`PostToolUse`.

**Never push the same state twice in a row** — the widget de-duplicates by
state+message. Push only on transitions, or include a fresh message each time.

## Copyable example (agent side, Mode B)

The plugin ships a thin wrapper `wrap-tool.ps1` that **publishes state only**
(it does NOT execute the command). Run the command via mcode's own bash tool,
then call `wrap-tool.ps1` to publish the outcome:

```powershell
# Step 1: announce "working" before invoking mcode's bash tool
& "<plugin install dir>\wrap-tool.ps1" -Tool bash -Command "npm test" -Description "run tests"

# Step 2: after mcode's bash tool returns, publish the outcome
& "<plugin install dir>\wrap-tool.ps1" -Tool bash -Command "npm test" -ExitCode $LASTEXITCODE
```

`$LASTEXITCODE` is interpreted as: `0` → `done`, codes in `-WaitingExitCodes`
(default `[1]`) → `waiting`, anything else → `error`. The wrapper returns the
exit code unchanged so the calling shell still sees it.

The wrapper accepts `-Tool bash|read|write|edit|glob|grep|web|task|notebook` and
emits a tool-specific `done` message (e.g. `read C:\path`, `edited file.cs`,
`npm test 完成`) so the pill text is informative. For read/write/edit/glob/grep
the wrapper itself does not execute the command — mcode's own tool does; this
script only publishes the state.

For other tools (read/write/edit) — and for any state push that is not a single
command — call `notify-island.ps1` directly:

```powershell
$plugin = "<plugin install dir>"   # directory that contains notify-island.ps1
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

After each push (or after each hook fires), the widget on the user's primary
display updates within ~400 ms (one polling cycle). On click, the originating
terminal tab regains focus. The widget is intentionally hard to kill: Alt+F4
hides it, not closes it, and `mcode-island show` re-raises the hidden window
in under 1 second.

## User-side management

```cmd
mcode-island                  REM start the widget (idempotent)
mcode-island stop             REM stop the widget
mcode-island status           REM show PID + recent log
mcode-island show             REM re-raise hidden widget
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
├── plugin.json                       # plugin manifest
├── README.md                         # full user-facing docs
├── LICENSE                           # Apache-2.0
├── mcode-island.ps1                  # WPF widget main loop
├── mcode-island.cmd                  # CLI shim (start/stop/status/...)
├── start-island.ps1                  # launch the widget in STA
├── stop-island.ps1                   # stop the widget
├── status-island.ps1                 # print widget state
├── show-island.ps1                   # re-raise hidden widget
├── pin-island.ps1                    # lock focus target to foreground
├── autostart.ps1                     # register/unregister Windows logon
├── notify-island.ps1                 # state-push helper (agents call this)
├── wrap-tool.ps1                     # all-in-one bash wrapper
├── mcode-status-detect.ps1           # runtime-state detector
├── io.minimax.mcode/                 # client extension (PR #20 spec)
│   └── hooks/
│       ├── hooks.json                # 12-event declaration
│       └── scripts/
│           ├── _lib.ps1              # shared helper
│           ├── session-start.ps1
│           ├── session-end.ps1
│           ├── user-prompt-submit.ps1
│           ├── pre-tool-use.ps1
│           ├── post-tool-use.ps1
│           ├── stop.ps1
│           ├── pre-compact.ps1
│           ├── notification.ps1
│           ├── subagent-start.ps1
│           ├── subagent-stop.ps1
│           ├── permission-request.ps1
│           └── permission-denied.ps1
├── skills/mcode-island/SKILL.md      # this file
└── assets/                           # screenshots used in the README
```

## Limitations and known constraints

- Windows 10/11 only (uses WPF, `user32`, and `kernel32` P/Invoke).
- Single widget per user session.
- Hook-driven mode requires mcode 0.2.4+ Runtime. The portable spec
  (`io.minimax.mcode` client extension) is still pending merge in
  `MiniMax-Code-Plugins` PR #20; until the registry validator accepts the
  namespace, the hooks subdirectory is dormant and the plugin falls back to
  Mode B (agent-pushed + detector).
- No hover-expand, no media-control integration yet — see the `v0.2` roadmap in
  the upstream issue tracker.
- `wrap-tool.ps1` is a **status publisher only** — it never executes the
  command itself (mcode's tool does). The agent still runs every read / write /
  edit through mcode and then calls `wrap-tool.ps1` to publish the outcome.
  This avoids shell-injection ambiguity from a prior `Invoke-Expression` design.
