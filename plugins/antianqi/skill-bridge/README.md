# skill-bridge

> Convert openclaw (and similar) skills into mavis/mcode-compatible skills, exposed as a stdio MCP server inside a portable Agent Plugin.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)](mcp.json)
[![Agent Plugins 1.0](https://img.shields.io/badge/Agent_Plugins-1.0-8b5cf6)](https://agent-plugins.org)

## Why

`openclaw` (and other agent frameworks) and `mavis` / `mcode` do not share a skill format. The hard parts are:

1. **Schema gap** — openclaw skills are 2-field frontmatter; mavis needs `descriptions.zh-Hans`, `displayNames`, `metadata`, locale keys.
2. **Encoding gap** — openclaw wrote Chinese as GBK and filenames as mojibake. mavis requires UTF-8.
3. **Path gap** — openclaw skills hardcode `C:\Users\Administrator\.openclaw\workspace\...` and `/tmp/CLI-Anything/...`. mavis needs parameterized paths.
4. **Platform gap** — openclaw assumes `bash` / `pip install -e .` / `python3` in PATH. mavis (especially on Windows) needs PowerShell equivalents.
5. **Discovery gap** — openclaw's staging directory is not in mavis's skill scan path. Copying files there does nothing.

**skill-bridge** turns "copy the folder and pray" into a deterministic pipeline: `detect` → `analyze` → `classify` → `transform` → `lint`, exposed as four MCP tools and driven by the matching Skill (`skills/skill-bridge/SKILL.md`).

## How it ships

This repository follows the [portable Agent Plugins 1.0 contract](https://github.com/hetaoBackend/MiniMax-Code-Plugins/blob/main/docs/plugin-compatibility.md):

```text
plugins/antianqi/skill-bridge/
├── plugin.json              # the plugin manifest
├── mcp.json                 # the stdio MCP server
├── server.mjs               # the MCP server itself
├── lib/                     # pure ESM, zero npm deps
├── skills/skill-bridge/     # the LLM-facing Skill
├── references/              # human-facing docs
├── examples/                # input + output demo
└── tests/                   # node --test
```

No `package.json`, no `node_modules`, no install step. The portable plugin is read by MiniMax Code exactly the way it is checked into `main`.

## What the MCP server exposes

The server speaks JSON-RPC over stdio. It declares four tools, named after the original v0.1 CLI subcommands:

| Tool | Returns |
| --- | --- |
| `detect(source)` | `{ encoding, originalEncoding, replaced, confidence, reason, text }` |
| `analyze(source)` | `{ frontmatter, body, hardcodedPaths, externalCommands, warnings, … }` |
| `classify(source)` | `{ tier, subTier, reason, recommendations }` |
| `convert(source, target_dir, force?, run_lint?)` | `{ ok, tier, subTier, written, warnings, lint }` |

`source` accepts an absolute path to a `SKILL.md` file or to a folder containing one. `target_dir` is the absolute path the converted skill should be written to. The transform step is **atomic** — re-running with the same `target_dir` is always safe.

The server requires only the Node.js that already ships with the host. It does not run `npm install`, does not register a global bin, does not write to the user's home directory.

## Try the demo

The plugin ships a single conversion demo under `examples/output/task-tracker/`. It is the result of running:

```text
convert(
  source      = "examples/input/task-tracker/SKILL.md",
  target_dir  = "examples/output/task-tracker"
)
```

Inspect the result:

```text
examples/output/task-tracker/
├── SKILL.md                  # mavis-schema-compliant frontmatter, parameterized paths
└── conversion-report.md      # what the converter changed and why
```

The original input is the openclaw `task-tracker` skill; the output is the same content brought up to the mavis schema. Open both side by side to see what the converter does.

## How it works

```text
input SKILL.md (openclaw, possibly GBK, possibly with C:\Users paths)
   │
   ▼
[detect]     TextDecoder('gb18030') — built into Node 22+, no npm dep
   │
   ▼
[analyze]    hand-rolled YAML subset parser, path/command pattern scan
   │
   ▼
[classify]   4-question decision tree → pure / pure-wrapped-fix / wrapped / abandon
   │
   ▼
[transform]  atomic backup-rename into <target_dir>; references/ split if body > 500 lines
   │
   ▼
[lint]       invokes the host-installed skill-creator lint in a tmpdir
   │
   ▼
output: mavis-compatible skill at <target_dir>
```

### The tiers (also see `references/compatibility-matrix.md`)

| Tier | What it is | What v0.2 does |
|---|---|---|
| `pure-translate` | Pure instruction, ASCII-clean, no hardcoded paths | Frontmatter enrichment only |
| `pure-wrapped-fix` | Pure instruction with hardcoded paths or GBK | Paths parameterized + encoding fixed + Windows notes added |
| `wrapped-*` | Needs an external CLI/API (Python, ComfyUI, Douyin, …) | **Not supported in v0.2.** v0.3 will emit a plugin skeleton. |
| `abandon` | Openclaw-only assumptions can't be removed | Do not import |

## Requirements

- Node.js 22.19+ or 24+ (matches the mcode engine). No other runtime.

## Data and network

- No network access.
- No credentials required.
- Reads the source file the caller provides.
- Writes only to the caller-provided `target_dir` and to a unique `os.tmpdir()/sb-lint-<pid>-<rand>/` directory that is removed after the lint step completes.

## Validation

```bash
# from the repository root
npm ci
npm run check
```

CI runs the same `npm run check` on `ubuntu-latest` against Node 22. The validator + `node --test` exercise this Plugin's lib, server, and conversion pipeline.

## Security

- No symlinks, native binaries, installers, or hidden telemetry.
- The transformer writes to a unique sibling `.staging-` directory first, then swaps it onto `target_dir` via `fs.rename`. If anything fails before the swap, `target_dir` keeps its previous content (or remains absent if it never existed).
- The lint step stages a temporary `.mjs` copy in `os.tmpdir()` and removes it in a `finally` block. v0.1 of this plugin accidentally wrote a staged file into the user's `~/.minimax/.builtin-skills/` directory; v0.2 fixes that regression and adds a regression test.

## License

Apache-2.0 — see [LICENSE](LICENSE). The transformer and parser are original work by [antianqi](https://github.com/antianqi); the `task-tracker` demo is the user's own content.
