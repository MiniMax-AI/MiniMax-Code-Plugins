# tool-map - persistent tool inventory

> A cross-platform inventory of CLI tools, scripts, and MCP servers installed on the user's machine. Generates a persistent three-file catalog (lightweight summary, full markdown, machine JSON) so the agent can answer "do I have X?", "where is Y?", "how do I run Z?" without re-scanning the filesystem every session.

## Try it

After installing the Plugin, the agent will activate the `tool-map` Skill on any question about installed tools. On the first session, ask the agent to read the summary, or trigger a refresh:

```text
What CLI tools do I have installed? Where is pnpm?
```

```text
Refresh my tool inventory - I just installed a new package manager.
```

```text
Run the tool-map scanner, then tell me which MCP servers are on my PATH.
```

The first invocation generates `${PLUGIN_DATA}/tools.summary.md`, `${PLUGIN_DATA}/tools.md`, and `${PLUGIN_DATA}/tools.json` (one `node` process, typically under 2 seconds). Subsequent turns read the summary without re-scanning.

## How it works

This is a **Skill-only Plugin** containing one Skill and one bundled scanner:

- `skills/tool-map/SKILL.md` - tells the agent to consult the cached summary on session start, refresh only when needed, and how to invoke the scanner.
- `scripts/scan.mjs` - a zero-dependency Node script that walks well-known tool roots plus `$PATH`, probes 15 well-known CLIs for `--version`, and writes the three catalog files atomically (staging + rename, no partial files).
- `scripts/smoke.mjs` - a self-check that statically scans the Plugin's own source for hardcoded absolute paths, literal credential tokens, and leftover scaffold marker strings. Exits non-zero on any violation.

**Why no bundled MCP connection**: this Plugin has no runtime server, no network endpoints, and no secrets to manage. The agent invokes the scanner as a regular Node subprocess when the user asks for a refresh; the Skill is the only contract.

## Requirements

- **Node.js >= 22** at runtime (the scanner uses only built-in modules and the `node --test` discoverer picks up the regression test in this repository's `npm test`).
- The Plugin data directory, exposed as `${PLUGIN_DATA}` to the agent. The scanner falls back to `~/.local/share/tool-map` (XDG_DATA_HOME compliant) when `${PLUGIN_DATA}` is unset.
- A POSIX-like shell or `cmd.exe` for the bundled `node` invocation; no other binaries are required at install time.

## Supported platforms

| Platform | Status | Notes |
| --- | --- | --- |
| Windows 10 / 11 (PowerShell 5.1+ or pwsh 7) | Supported (primary) | Drives, `%ProgramFiles%`, `%APPDATA%`, `%LOCALAPPDATA%` resolved from environment. |
| macOS 12+ (bash / zsh) | Supported | `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin` walked. |
| Linux x86_64 / arm64 | Supported | `~/.local/bin`, `~/.local/share/npm/bin`, `/usr/local/bin` walked. |

The scanner does not hardcode any per-user absolute path; all locations are derived from `$HOME`, `$ProgramFiles`, `$APPDATA`, `$LOCALAPPDATA`, `$PATH`, or fixed POSIX conventions. To add an extra root, set `TOOL_MAP_ROOTS` to a `:`-separated (POSIX) or `;`-separated (Windows) list of absolute paths.

## Data and network

This Plugin itself:

- **Makes no network requests.** The scanner is fully offline. It does not contact any registry, index, API, or third-party service.
- **Ships no credentials.** No API token, no OAuth client, no per-user secret, no shared key. The `~/.ssh/` directory is read for filenames only (no key contents, no passphrases, no agent state).
- **No telemetry.** The scanner prints a one-line summary to stdout when it writes a catalog; nothing is sent anywhere.
- **No third-party services.** No SDK, no analytics endpoint, no error reporter, no remote MCP server. The Plugin is self-contained.
- **No data uploaded.** The catalog lives entirely in the Plugin data directory. Nothing leaves the host.

The scanner reads (read-only):

- Filesystem metadata (size, mtime, mode) for executables under the configured roots.
- The first line of stdout for `tool --version` for 15 well-known CLIs (node, npm, pnpm, yarn, mcode, openclaw, clawhub, codex, git, python, python3, gh, docker, pwsh, powershell). Each probe has a 5 s timeout and never throws.
- `~/.gitconfig` for the `user.name` and `user.email` fields (treated as public identity, displayed in the summary).
- The list of filenames under `~/.ssh/` that match `id_*` (without `.pub`). File contents are never read.

The scanner writes (only):

- `${PLUGIN_DATA}/tools.md`, `${PLUGIN_DATA}/tools.json`, `${PLUGIN_DATA}/tools.summary.md` (or whatever path is passed as `argv[2]`). Writes are **bundle-atomic**: every existing target file is first moved to a private backup directory, then the new contents are written into a staging directory, then each staging file is renamed onto its target. If any rename fails, the previous catalog is restored from backup and the staging / backup directories are removed. See `scripts/scan.mjs:atomicWriteBundle` and the `TOOL_MAP_FAIL_AT_RENAME` regression test for the failure-path behaviour.

## Side effects

The scanner's only side effect beyond the catalog files is **subprocess execution** of 15 well-known CLI programs. This is a deliberate, declared behaviour — the catalog is more useful when the agent can see actual installed versions, not just file existence. To make the policy explicit:

- **Whitelisted names only.** The exact set of programs that may be spawned is hardcoded as `VERSION_PROBES` in `scripts/scan.mjs` and the same set is exposed as `ALLOWED_PROBE_NAMES`. Any future caller that would probe a name not in the whitelist is rejected inside `probeVersion` (fail-closed). Adding a new probe requires editing `VERSION_PROBES`.
- **Probes are `execFile`, not `shell`.** The scanner passes the program as a separate argv (`execFileP('node', ['node', '--version'], ...)`), so it cannot be tricked into running a different program by a wrapper named `node` that contains shell metacharacters in its path.
- **5-second timeout, no exceptions.** Every probe runs under a hard 5 s `execFile` timeout and any error (timeout, ENOENT, non-zero exit) is swallowed. A wrapper that hangs longer than 5 s is omitted from the `core` versions table; nothing else is affected.
- **No arguments beyond `--version`** (or the single read-only `pwsh -NoProfile -Command $PSVersionTable.PSVersion.ToString()` for PowerShell). The scanner never passes user input as a CLI argument.

Review your `$PATH` and any same-named wrappers in the well-known roots before installing this Plugin if you consider arbitrary command execution a concern. The full source of `probeVersion` and `VERSION_PROBES` is in `scripts/scan.mjs`.

## Limitations

- The catalog is a snapshot, not live. After installing or upgrading a tool, the user (or the agent on user instruction) must re-run the scanner. The default cache is good until something changes; the agent should not assume a tool listed 30 seconds ago is still on `$PATH` if a `command not found` was reported in the same session.
- `--version` probes use a 5 s timeout. A tool that hangs longer than that is omitted from the `core` versions table but stays in the file-walk inventory (so the agent still knows the file exists).
- The walk has a safety cap of 5000 entries; very large tool collections (e.g. a build farm with thousands of node_modules shims) are truncated. Raise `MAX_RESULTS` in `scripts/scan.mjs` if you need more.
- Files larger than 50 MB are skipped (CUDA SDKs, game engines, etc.) to keep the catalog readable.
- On POSIX, an entry is only listed if the file has at least one execute bit set (`mode & 0o111`). On Windows the execute bit is ignored (per platform convention).
- The scanner does not enumerate npm packages, pip packages, or system packages. It finds executables on disk, not installable artifacts.

## Test evidence

Run from the repository root (this directory's parent):

```text
$ npm run check
OK   example hello-mcode
OK   example hello-mcode-mcp
OK   plugin Fectivnfy112357/github-explore
OK   plugin hetaoBackend/minimax-code-trajectory
OK   plugin HopeYin/dida365
OK   plugin HopeYin/ticktick
OK   plugin Hylouis233/mcp-server-patterns
OK   plugin Hylouis233/search-first
OK   plugin Hylouis233/verification-loop
OK   plugin antianqi/tool-map
tests 7
pass 7
fail 0
```

```text
$ node --test test/tool-map.test.mjs
> scan.mjs writes the three catalog files atomically (~700ms)
> scan.mjs JSON has the expected schema (~700ms)
> scan.mjs writes nothing outside the output directory (~700ms)
> scan.mjs leaves no staging files on success (~700ms)
> scan.mjs completes with an empty PATH and still produces a valid catalog (~110ms)
> smoke.mjs exits 0 against the plugin source tree (~35ms)
> atomicWriteBundle rolls back when a mid-bundle rename fails (~10ms)
> atomicWriteBundle is idempotent on the happy path (no residue, all 3 present) (~5ms)
> ALLOWED_PROBE_NAMES is exactly the 15 declared names (<1ms)
> POSIX: a .sh file without the execute bit is not reported as a tool (<1ms)
> POSIX: case-distinct tool names on case-sensitive filesystems are kept distinct (<1ms)
> XDG_DATA_HOME is honoured when PLUGIN_DATA is unset (~700ms)
tests 12
pass 12
fail 0
```

`npm run check` runs `npm run validate` (the Plugin shape validator, hardened to the rules proposed in PR #4) and then `npm test` (which discovers `test/tool-map.test.mjs` via the `node --test` runner). The bundled `scripts/smoke.mjs` exits 0 against the Plugin's own source tree, confirming no hardcoded paths, no literal credentials, and no leftover scaffold markers. The 12-case test suite covers the v0.2.0 review blockers end-to-end: bundle-level atomicity (with a deterministic mid-bundle failure path), the 15-name whitelist, `XDG_DATA_HOME` precedence, execute-bit filtering, and case-sensitive dedup.

## Links

- Issue tracker: https://github.com/MiniMax-AI/MiniMax-Code-Plugins/issues
- Contributing: see `CONTRIBUTING.md` in the repository root.
- License: Apache-2.0. See `LICENSE` in this directory.
