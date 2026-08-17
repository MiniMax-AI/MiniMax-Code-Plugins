# Code Index

> A local-first code index that lets MiniMax Code locate symbols, definitions,
> references, and files in milliseconds instead of reading whole files or
> scanning the repository.

When an agent works in a large codebase it tends to read big chunks of files just
to find what it needs — slow, and every file read costs tokens. This Plugin builds
a cached local index of the active project and exposes search tools so the agent
can jump straight to the right `file:line` for any function, class, method,
interface, or import, find every usage of a symbol before renaming it, and grep
code patterns without a full-repo exploration loop.

The design is informed by the architecture of existing open-source code search MCP
servers — notably [LLMTooling/code-search-mcp](https://github.com/LLMTooling/code-search-mcp)
(symbol index + text search + persistent index cache) and
[Consiliency/Code-Index-MCP](https://github.com/Consiliency/Code-Index-MCP)
(local-first indexing). This implementation is written from scratch on Node's
standard library so the Plugin runs with `node ./server.mjs` and no install step;
it does not copy those projects' source code.

## Install and use

This Plugin is a portable Agent Plugins 1.0 package made of a Skill and an MCP
server. To use it in MiniMax Code:

1. Copy the `kevenhu001-cyber/code-index` folder into your MiniMax Code Plugins
   location, or point MiniMax Code at its path. The simplest way is the bundled
   registration script, which checks Node 22+, validates the package, and copies
   the folder into place:

   ```bash
   cd plugins/kevenhu001-cyber/code-index
   node register.mjs                                  # auto-detect the plugins directory
   node register.mjs --dir "C:\Users\you\.minimax\plugins"   # explicit target
   ```

   MiniMax Code's local plugins directory is typically `~/.mavis/v2/plugin-cache`
   (Windows: `%USERPROFILE%\.mavis\v2\plugin-cache`). If auto-detection does not
   find it, pass the path with `--dir` or set `MINIMAX_CODE_PLUGINS_DIR`.
2. Reload the session. MiniMax Code reads `mcp.json` and starts the server
   automatically over `stdio` with `node ${PLUGIN_ROOT}/server.mjs`. Note that
   MiniMax Code — like other Agent Plugins 1.0 hosts — launches the server with
   the **plugin root** as its working directory, not the active project. The
   server never indexes its own plugin directory; when the project cannot be
   auto-detected, the first `build_code_index` call must pass the project path
   as the `root` argument (the bundled Skill teaches the agent to do this).
   MiniMax Code also loads the `code-index` Skill from `skills/`.
3. Make sure Node.js 22+ is on `PATH`. Optionally install `rg` (ripgrep) to
   accelerate `search_code`; the built-in scanner works without it.
4. Ask the agent to use the skill — see the prompt under "Try it" below.

The index is cached under the Plugin data directory (`PLUGIN_DATA`), or in
`.code-index/` inside the project when `PLUGIN_DATA` is unavailable; it is
rebuilt incrementally. After large edits, ask the agent to run
`build_code_index` again to refresh it (the server does not watch files).
Override the cache location with the `CODE_INDEX_DATA_DIR` environment variable.

## Try it

```text
Use the code-index skill. Build the index for this project, then tell me where
authenticateUser is defined and every place it is called. Do not read whole files.
```

Expected result: the agent calls `build_code_index` (passing `root` — the
project's absolute path — when the server cannot auto-detect it), then
`search_symbol` and `find_references`, and answers with `file:line` locations
and short snippets.

## Capabilities

- `index_status` — reports whether the project index exists and its stats.
- `build_code_index` — scans the project and builds/refreshes the index, cached
  under `PLUGIN_DATA`. Incremental by default: only changed files are re-parsed
  (size+mtime fast path, SHA-1 hash verification). Accepts an optional `root`
  argument for hosts that launch the server from the plugin directory.
- `search_symbol` — finds symbol definitions by name (exact → prefix → substring),
  optionally filtered by kind, with snippets.
- `find_references` — finds every usage site of a symbol plus its definitions;
  use before renaming or removing code.
- `search_file` — finds files by basename or path fragment.
- `search_code` — regex text search over indexed source files; uses ripgrep when
  available, otherwise a built-in scanner.
- `get_file_symbols` — lists a file's symbol structure without reading the file.
- `code-index` Skill — teaches the search-before-explore workflow so the agent
  stops scanning the repository manually.

## How it works

- The indexer walks the project with a skip list (`.git`, `node_modules`, build
  and cache directories, ...), never follows symlinks, never indexes hidden files
  (which keeps `.env` and other dotfiles out), and respects the root `.gitignore`
  (common patterns: `!` negation, `/` anchors, `*`/`**`/`?` globs, directory
  patterns).
- Symbol extraction is a ctags-style, regex-based engine with brace-depth (or
  Python/Ruby indent) tracking to classify methods inside class-like bodies. It
  covers JavaScript, TypeScript, Python, Java, Go, Rust, C/C++, C#, Kotlin,
  Swift, Dart, PHP, Ruby, Shell, and Lua; other extensions are listed in the index
  with their language but not parsed.
- The index is a single JSON document under `PLUGIN_DATA` (or `.code-index/` in
  the project when `PLUGIN_DATA` is unavailable) containing per-file metadata
  (path, language, size, line count, symbols) and a symbol → definitions map.
  Searches read the cached index; reference and text searches scan the indexed
  files directly with an in-memory bounded text cache.

## Project root resolution

The server indexes whichever project the host points it at, in this order:

1. the `root` argument of `build_code_index` / `index_status`;
2. the MCP `roots` announced by the host (when the host sends them);
3. the `CODE_INDEX_ROOT` environment variable;
4. the root remembered from an earlier build — in memory for the current
   session, persisted next to the index under `PLUGIN_DATA` for the next one;
5. the nearest ancestor of the server's working directory containing a project
   marker (`.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`);
6. the server's working directory itself.

MiniMax Code launches plugin MCP servers from the plugin root (Agent Plugins
1.0 spec default), so steps 5-6 would only ever resolve to the plugin's own
folder. The server therefore **never indexes the plugin directory**: when no
earlier source resolves the project, calls fail with `workspace_root_unknown`
and the agent must supply the `root` once. After that, every search tool in the
session reuses the resolved root without repeating it.

## Limits

- Heuristic extraction, not a language server: unusual declarations may be missed
  and some calls may look like methods. Treat results as strong hints.
- At most 20,000 files are indexed; files over 1 MiB are listed but not parsed.
- Go block imports (`import (` ... `)`) and C++ template declarations are not
  captured. Imports are indexed by module path.
- No file watching: after significant edits, call `build_code_index` to refresh.

## Data and network

- Reads only the resolved project root and writes only the index under
  `PLUGIN_DATA` (or `.code-index/` in the project when `PLUGIN_DATA` is
  unavailable); a symlinked data directory is rejected. The server never pins
  itself to `PLUGIN_ROOT` and refuses to index the plugin's own directory.
- No network access, no telemetry, no credentials. The optional ripgrep
  acceleration runs `rg` locally against indexed source files only.
- Hidden files, symlinks, and gitignored paths are never read or indexed.

## Requirements

- MiniMax Code with Agent Plugins 1.0 MCP support.
- Node.js 22+ on `PATH` (the server uses only Node standard-library modules).
- Optional: `rg` (ripgrep) on `PATH` to accelerate `search_code`; the built-in
  scanner works without it.

## Development and verification

```bash
node --test plugins/kevenhu001-cyber/code-index/test/*.test.mjs
npm run check
```

The tests use isolated temporary projects and Plugin data directories. They cover
symbol extraction across languages, incremental rebuilds, gitignore/skip handling,
all search tools, MCP protocol handling, and the real stdio process boundary.

## License

Apache-2.0. See [LICENSE](LICENSE).
