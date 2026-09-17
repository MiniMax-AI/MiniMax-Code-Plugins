# MiniMax Code plugin compatibility

This document describes what MiniMax Code reads from an Agent Plugin. There are two runtime
layouts in active use:

- The **portable Agent Plugins 1.0** layout below is the cross-runtime baseline. It is what the
  validator checks and what mcode 0.3.x reads. It is also what mcode 0.4.0+ continues to accept
  when it is found on disk.
- The **v0.4.0+ plugin format** section below describes the Claude Code compatible layout that
  mcode 0.4.0+ adopts as the preferred form: the manifest moves to `.claude-plugin/plugin.json`
  and Hooks are inlined on the manifest. A Plugin that targets mcode 0.4.0+ exclusively should
  use this layout; a Plugin that targets both 0.3.x and 0.4.0+ should ship both layouts in
  parallel.

The full v0.4.0+ Hooks specification is in
[`proposals/hooks-v0.4-spec.md`](../proposals/hooks-v0.4-spec.md) and a working example is in
[`examples/hello-mcode-hooks-v04/`](../examples/hello-mcode-hooks-v04/).

## Portable package (Agent Plugins 1.0, mcode 0.3.x)

MiniMax Code reads the portable subset of Agent Plugins 1.0:

```text
plugin-root/
├── README.md                 # required by this community repository
├── LICENSE                   # required by this community repository
├── plugin.json
├── mcp.json                  # optional
└── skills/
    └── <skill-name>/
        └── SKILL.md
```

`plugin.json` must target:

```json
"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
```

The only required manifest fields are `$schema` and `name`. Adding `version`, `description`,
`author`, `homepage`, `repository`, `license`, and `keywords` improves catalog quality. Client
`extensions` may be present but are ignored by MiniMax Code.

## Skills

MiniMax Code discovers immediate child directories under `skills/` and reads each `SKILL.md`. The
frontmatter `name` must match its directory, use lowercase letters, digits and single hyphens, and be
at most 64 characters. `description` is required and must explain what the Skill does and when it
should activate.

## MCP

`mcp.json` must target:

```json
"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
```

Supported transports are:

- `stdio`, using an executable token plus optional arguments, environment, and contained working
  directory;
- `streamable-http`, using an HTTP(S) URL and optional headers; and
- `sse`, retained for compatible legacy HTTP+SSE servers.

MiniMax Code reserves `PLUGIN_ROOT` and `PLUGIN_DATA`. A plugin must not set those variables itself.
Do not embed tokens in environment values or headers. Generic OAuth configuration is not part of
this portable subset.

## v0.4.0+ plugin format (mcode 0.4.0+ runtime)

mcode 0.4.0+ (`@minimax-ai/code@0.4.0`, released 2026-09-11) adopts the Claude Code compatible
plugin shape as the preferred form. A Plugin that targets mcode 0.4.0+ exclusively uses this
layout; a Plugin that targets both 0.3.x and 0.4.0+ ships both layouts in parallel.

```text
plugin-root/
├── README.md                                  # required by this community repository
├── LICENSE                                    # required by this community repository
├── .claude-plugin/
│   └── plugin.json                            # the v0.4.0+ manifest, with inline `hooks`
├── io.minimax.mcode/                          # hook scripts, same layout as the portable package
│   └── hooks/
│       └── scripts/
│           └── *.ps1 | *.mjs | *.sh            # one script per event handler
└── skills/
    ├── SKILL.md                               # top-level single Skill (preferred for a focused Plugin)
    └── <plugin-name>/                         # subdir copy, for the v0.3.x runtime and the validator
        └── SKILL.md
```

The v0.4.0+ manifest is a single JSON object whose only strictly required field is `name`. The
full schema and the inline `hooks` shape are in
[`proposals/hooks-v0.4-spec.md`](../proposals/hooks-v0.4-spec.md); the short summary is:

- `name` (required): Plugin name; lowercase letters, digits, single hyphens.
- `version` (recommended): Semver; bump major for any breaking manifest change.
- `skills`: path or array of paths to Skill files, each relative to `.claude-plugin/` and
  starting with `./`. Top-level `skills/SKILL.md` is the recommended layout for a focused
  Plugin. A Plugin that ships a top-level Skill should also ship a `skills/<plugin-name>/SKILL.md`
  copy under a subdirectory whose name matches the Plugin's `name`, so the v0.3.x runtime and
  the current validator accept the package.
- `mcpServers`: same shape as the Agent Plugins 1.0 `mcpServers` field.
- `hooks`: inline hook definitions, replacing the v0.3.x `io.minimax.mcode/hooks/hooks.json`
  document. The 12 PascalCase event names (`SessionStart`, `SessionEnd`, `PreToolUse`,
  `PostToolUse`, `UserPromptSubmit`, `Stop`, `PreCompact`, `Notification`, `SubagentStart`,
  `SubagentStop`, `PermissionRequest`, `PermissionDenied`) and the per-event handler shape are
  identical to the v0.3.x spec; the layout change is the only difference. See the proposal for
  the full event table, the matcher rules, the `timeout` units, and the hook script conventions.

Three things bite Plugin authors migrating from the v0.3.x layout. The full lessons are in the
proposal; the short version is:

1. The manifest **must** live at `.claude-plugin/plugin.json`. A top-level `plugin.json` is
   ignored by mcode 0.4.0+.
2. The `skills` field must point at a path the snapshot builder can resolve. A path into a
   nested subdirectory whose name does not match the SKILL.md frontmatter `name` is silently
   dropped; the Plugin does not load, no diagnostic is emitted. Use `./skills/SKILL.md` for
   a single-Skill Plugin, or rename the subdirectory to match the frontmatter `name`.
3. Hooks **must** be inlined on the manifest under the `hooks` key. The
   `io.minimax.mcode/hooks/hooks.json` document is ignored by mcode 0.4.0+.

A working example with one PowerShell hook script and one top-level Skill is in
[`examples/hello-mcode-hooks-v04/`](../examples/hello-mcode-hooks-v04/). It ships both
`skills/SKILL.md` (for the v0.4.0+ runtime) and `skills/hello-mcode-hooks-v04/SKILL.md` (for
the validator and the v0.3.x runtime) as byte-identical copies, per the recommended
cross-version layout.

## Limits and unsupported capabilities

The runtime accepts at most 64 Skill directories and 8 MCP servers per Agent Plugin. Invalid Skills
or MCP entries are omitted with diagnostics; an invalid root manifest rejects the package.

The following are not currently public MCode Plugin capabilities in either runtime:

- custom Agents and Commands
- LSP configuration
- Apps or UI extensions
- generic OAuth setup
- host-specific fields hidden in `extensions`

Hooks and lifecycle scripts are **not** a portable Agent Plugins 1.0 capability, but mcode
0.4.0+ accepts them via the inline `hooks` field on `.claude-plugin/plugin.json`. Plugins that
target mcode 0.3.x use the experimental `io.minimax.mcode/hooks/hooks.json` document; that
document is the right reference for the 0.3.x runtime. See
[`proposals/hooks-v0.4-spec.md`](../proposals/hooks-v0.4-spec.md) and
[`proposals/hooks-detailed-spec.md`](../proposals/hooks-detailed-spec.md) for the two specs.

Hosted contributions may contain extra assets, but documentation must not imply that MiniMax Code
loads unsupported components. TUI Extensions are a separate product extension system, not an Agent
Plugin capability.
