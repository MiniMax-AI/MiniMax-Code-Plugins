---
name: code-index
description: Locate symbols, definitions, references, files, and code patterns in the current project in milliseconds with a local code index instead of reading whole files or exploring directories. Use when the user asks where something is defined or used, wants to understand a file's structure, needs to find a file or a code pattern, or before editing or renaming code that depends on existing symbols. Do not scan the repository manually when these tools can answer the question.
license: Apache-2.0
compatibility: Requires MiniMax Code Agent Plugins 1.0 MCP support and Node.js 22+. The index is stored under PLUGIN_DATA and never leaves the machine. ripgrep accelerates search_code when installed; the built-in scanner works without it.
metadata:
  author: kevenhu001-cyber
  version: "0.1.0"
---

# Code Index

Use the bundled MCP tools to answer questions about the codebase from a cached local
index instead of reading whole files or walking directories. The index records every
indexed file plus its symbol definitions (functions, classes, methods, interfaces,
imports, ...) with exact `file:line:column` locations.

## Workflow (search-before-explore)

1. **Check the index first.** Call `index_status`. If `indexed` is false, call
   `build_code_index` before searching. The build is incremental and usually fast;
   only changed files are re-parsed.
2. **Where is X defined?** Call `search_symbol` with the symbol name (or a fragment).
   Read the returned `file:line` locations and snippets, then read only the specific
   lines you need — do not read the whole file.
3. **Understand a file without reading it.** Call `get_file_symbols` with the file
   path to see its structure (symbols + lines). Open the file only when you need
   bodies or surrounding context.
4. **Find usages before editing or renaming.** Call `find_references` with the exact
   symbol name to get every usage site plus the definitions. Never rename or remove a
   symbol without checking references first.
5. **Find a file.** Call `search_file` with a name or path fragment. Exact basename
   matches rank first.
6. **Find a code pattern.** Call `search_code` with a regular expression (optionally
   narrowed with `filePattern`). Results are capped; a `truncated: true` flag means
   more matches exist, so narrow the query before concluding.
7. Prefer these tools over reading files speculatively. If the index is missing
   symbols after recent edits, call `build_code_index` again to refresh it.

## Tool reference

| Tool | Purpose | Key arguments |
|---|---|---|
| `index_status` | Is the index built? stats | — |
| `build_code_index` | Build/refresh the index | `force` |
| `search_symbol` | Symbol definitions | `query`, `kind`, `caseSensitive`, `limit` |
| `find_references` | Usage sites + definitions | `name`, `caseSensitive`, `limit` |
| `search_file` | File discovery | `query`, `limit` |
| `search_code` | Regex text search | `query`, `filePattern`, `caseSensitive`, `limit` |
| `get_file_symbols` | File structure preview | `path` |

## Accuracy notes

- The extractor is regex-based (ctags-style), not a language server: it is fast and
  covers the common declaration shapes of 15+ languages, but may miss unusual
  declarations or report a method-like call as a method. Treat results as strong
  hints and verify with a targeted read when precision matters.
- Imports are indexed by module path (e.g. `node:http`, `std::collections::HashMap`),
  so substring searches like `HashMap` find them.
- Hidden files, `.git`/`node_modules`/build directories, symlinks, and everything
  ignored by the root `.gitignore` are never indexed. Files larger than 1 MiB are
  listed but not parsed.

## Failure handling

- `index_not_built`: call `build_code_index` first.
- `project_root_unavailable`: the active project directory could not be read.
- `query_required` / `name_required` / `path_required`: retry with a non-empty value.
- `invalid_regex`: the `search_code` pattern is not a valid regular expression.
- `file_not_in_index`: the path was not indexed (hidden/ignored/non-project file);
  use `search_file` to confirm the exact indexed path.
- `index_output_directory_unsafe`: PLUGIN_DATA points at a symlink; stop and tell the
  user to fix the Plugin data directory.
- A `truncated: true` result means the cap was hit — narrow the query rather than
  concluding the codebase has no more matches.

## Output style

Lead with the answer: symbol name, kind, and `file:line` locations. Keep snippets
short, list the most relevant definition first, and do not dump raw index JSON into
the conversation unless the user asks for it.
