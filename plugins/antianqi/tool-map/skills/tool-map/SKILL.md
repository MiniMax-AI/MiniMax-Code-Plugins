---
name: tool-map
description: Cross-platform inventory of CLI tools, scripts, and MCP servers installed on the user's machine. Use when the user asks what is installed, where a tool lives, or how to run something - read the cached summary first instead of re-walking the filesystem. Refresh the catalog with the bundled scan.mjs only when the user asks, just installed a tool, or the cached summary is missing a tool the user mentions.
---

# tool-map

This Plugin generates and refreshes a persistent inventory of the executable tools on the user's machine. The agent should consult the cached summary first and only re-scan when the user explicitly asks, when a tool the user mentions is not in the summary, or when the user has just installed or upgraded something.

## Where the inventory lives

The catalog is written to the Plugin data directory, exposed to the agent as `${PLUGIN_DATA}`. Three files are always written together:

- `${PLUGIN_DATA}/tools.summary.md` - lightweight (~6 KB) one-pager; **read this on session start** to learn what is installed without re-discovering the filesystem.
- `${PLUGIN_DATA}/tools.md` - full markdown inventory grouped by category, with size, mtime, and absolute paths.
- `${PLUGIN_DATA}/tools.json` - machine-readable JSON (same content as `tools.md`, structured); use this when you need to filter or query tools programmatically.

If `${PLUGIN_DATA}/tools.summary.md` does not exist on the first read in a session, run the scanner once to create all three files (see "How to refresh" below). On every subsequent turn, trust the summary; do not re-walk the filesystem and do not re-probe `--version` for tools already listed.

## How to refresh

To regenerate the inventory, run the bundled scanner:

```bash
node "${PLUGIN_ROOT}/scripts/scan.mjs"
```

The scanner walks known tool roots and the user's `$PATH`, probes a fixed list of well-known CLIs for `--version` (5 s timeout each, never throws), and writes all three files with bundle-level atomicity (two-phase commit: backup previous targets → write to staging → atomic rename per file → restore on failure). The scan is read-only and never modifies anything outside `${PLUGIN_DATA}`. Typical run: under 2 s on a developer workstation.

You may pass an optional output path to redirect the catalog (useful for testing):

```bash
node "${PLUGIN_ROOT}/scripts/scan.mjs" /tmp/my-inventory.md
```

When redirected, the scanner derives `tools.json` and `tools.summary.md` from the given path's stem (replace `.md` with `.json` and `.summary.md`).

## When to re-scan

Re-run the scanner when **any** of these is true:

- The user explicitly asks "what is installed?", "refresh the inventory", or "re-scan tools".
- The user just installed or upgraded a tool, and the next request involves that tool.
- The user mentions a tool that is not in the summary.
- A tool listed in the summary gives a `command not found` error in this session (the summary may be stale).

In all other cases, trust the summary. Do not re-walk the filesystem, do not re-probe `--version` for tools already listed, and do not re-print the inventory back to the user unless they ask.

## Cross-platform roots

The scanner walks these well-known locations, derived from the user's home directory and environment variables (no hardcoded absolute paths in source code):

- **Windows**: `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%APPDATA%\npm`, `%LOCALAPPDATA%\Microsoft\WindowsApps`, and the user's `~/.minimax-code`, `~/.minimax`, `~/.npm-global/bin`, `~/pwsh7_6`, `~/.Codex`, `~/.claude`.
- **macOS / Linux**: `~/.minimax-code`, `~/.minimax`, `~/.local/bin`, `~/.local/share/npm/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `~/.Codex`, `~/.claude`.

Plus everything on the user's `$PATH`. To add an extra root, set the `TOOL_MAP_ROOTS` environment variable to a `:`-separated (POSIX) or `;`-separated (Windows) list of absolute paths; each is walked with the same rules as the built-in roots.

## What the scanner reads and writes

- **Reads**: filesystem metadata (size, mtime, mode) for executables under known roots and `$PATH`; the first line of stdout for `tool --version` for a fixed list of 15 well-known CLIs (node, npm, pnpm, yarn, mcode, openclaw, clawhub, codex, git, python, python3, gh, docker, pwsh, powershell); `~/.gitconfig` for user/email; the list of filenames under `~/.ssh/` (NOT the key contents, NOT any other directory).
- **Writes**: `${PLUGIN_DATA}/tools.{md,json,summary.md}` (or the path given as `argv[2]`) only. Bundle-level atomicity: existing targets are backed up, new content is written to a staging directory, then each staging file is renamed onto its target. If any rename fails the previous catalog is restored and the staging/backup directories are removed.
- **Does not read**: the contents of any file under `~/.ssh/`; environment variable values that look like secrets; any registry, browser data, source code, or user documents.
- **Does not write**: any file outside the output directory; any user or host install area; any registry or config under `~/.config/`, `~/.minimax/`, or `~/.openclaw*/`.
- **Does not send**: any network request, any telemetry, any data to any third party. The scanner is fully offline.

## Side effects (subprocess execution)

The scanner's only side effect beyond writing the catalog files is **executing 15 well-known CLI programs** with `--version` (or, for PowerShell, a single read-only `$PSVersionTable.PSVersion.ToString()` call). This is a deliberate, declared behaviour — version strings make the catalog more useful.

- The exact set of executable names is hardcoded as `VERSION_PROBES` in `scripts/scan.mjs` and is mirrored in `ALLOWED_PROBE_NAMES`. Any probe request for a name outside the whitelist is refused inside `probeVersion` (fail-closed).
- Probes are run via `execFile`, not `shell`, on every platform. The program name and its single `--version` argument (or the `-NoProfile -Command $PSVersionTable.PSVersion.ToString()` triple for PowerShell) are passed as a separate argv, so a same-named wrapper on `$PATH` cannot be tricked into executing arbitrary code from shell metacharacters in the path.
- One Windows-only exception: `.cmd` and `.bat` shims are routed through `cmd.exe`. The Node.js 21.7.3 fix for CVE-2024-27980 refuses to spawn batch files via `execFile` without `shell: true`; this Plugin requires Node >= 22 so the fix is in force. The shell decision is per-program: the scanner walks `$PATH` and `$PATHEXT` to find the actual file the OS would execute, and sets `shell: true` only for programs whose resolved path ends in `.cmd` or `.bat`. Native `.exe` binaries (including `powershell.exe`) are spawned directly. POSIX always uses no shell.
- Every probe has a hard 5 s `execFile` timeout; timeouts, ENOENT, and non-zero exits are all swallowed. A tool that hangs longer than 5 s is simply omitted from the `core` versions table.
- No user input is ever passed to a probe. The whitelist is the single source of truth for what may run.

Review your `$PATH` and any same-named wrappers in the well-known roots before installing this Plugin if you consider arbitrary command execution a concern.

## Failure modes

- A tool's `cmd --version` hangs - the 5 s timeout aborts the probe; that tool is omitted from the `core` versions table but stays in the file-walk inventory.
- A directory is unreadable (permission denied, broken symlink) - skipped silently; the walk continues.
- Output path is on a different filesystem from the staging location - atomic rename still works because staging lives next to the target file, not in `os.tmpdir()`.
- `${PLUGIN_DATA}` is not set - the scanner falls back to `$XDG_DATA_HOME/tool-map` (or `~/.local/share/tool-map` when the env var is also unset).
- A mid-bundle rename fails (extremely rare: disk full, AV lock) - the previous catalog is restored from backup and the staging/backup directories are removed. The agent sees the same catalog it saw before the failed scan.
- `TOOL_MAP_ROOTS` contains a non-existent path - that path is skipped; the rest of the walk continues.
