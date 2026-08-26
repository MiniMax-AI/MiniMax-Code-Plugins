# MiniMax Code plugin compatibility

## Package contract

MiniMax Code Plugins accepts the portable Agent Plugins 1.0 subset plus the versioned MiniMax Code
Hooks 0.1 client extension:

```text
plugin-root/
├── README.md                         # required by this community repository
├── LICENSE                           # required by this community repository
├── plugin.json
├── mcp.json                          # optional Agent Plugins component
├── skills/                           # optional Agent Plugins component
│   └── <skill-name>/
│       └── SKILL.md
└── io.minimax.mcode/                 # optional MiniMax Code client extension
    └── hooks/
        └── hooks.json
```

A hosted contribution must expose at least one valid Skill, MCP server, or MiniMax Code Hook.
Hook-only packages are accepted, but Agent Plugins clients that do not implement the MiniMax
extension may load no usable component from them.

Hooks 0.1 is currently a staged registry declaration. This repository does not yet link a MiniMax
Code runtime build and end-to-end fixture certified to execute it, so package acceptance must not be
presented as current runtime availability.

## Manifest

`plugin.json` must target:

```json
"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
```

The only required manifest fields are `$schema` and `name`. Adding `version`, `description`,
`author`, `homepage`, `repository`, `license`, and `keywords` improves catalog quality. The community
repository additionally requires a declared license for hosted Plugins.

Do not add a root `hooks` field. Agent Plugins 1.0 client-specific files belong under their stable
reverse-domain directory. The registry recognizes `io.minimax.mcode/hooks/hooks.json`, and only a
compatible runtime advertising its exact schema may interpret it. Other extension namespaces remain
ignored unless separately documented.

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

MiniMax Code reserves `PLUGIN_ROOT` and `PLUGIN_DATA`. A Plugin must not set those variables itself.
Do not embed tokens in environment values or headers. Generic OAuth configuration is not part of
this portable subset.

## Hooks

MiniMax Code Hooks is a client extension, not an Agent Plugins 1.0 portable component. The fixed
configuration path is:

```text
io.minimax.mcode/hooks/hooks.json
```

The document must target the exact 0.1.0 schema:

```json
"$schema": "https://raw.githubusercontent.com/MiniMax-AI/MiniMax-Code-Plugins/main/schemas/io.minimax.mcode/hooks/0.1.0.schema.json"
```

Hooks 0.1 supports six observe-only lifecycle events and command handlers with optional `args`,
`env`, and `cwd`. It does not support blocking, approvals, tool rewriting, model-context injection,
or portable event payloads. Read the complete [`Hooks 0.1 contract`](hooks.md) before contributing.

Community validation recognizes the package and rejects every invalid declared handler. A MiniMax
Code build executes the extension only when it advertises support for this exact schema. Registry
acceptance does not imply that every current or older client build can run it.

The schema covers document shape and per-event limits. Because JSON Schema cannot sum array lengths
across event properties, the repository validator separately enforces the normative 32-handler
Plugin total.

## Limits and failure boundaries

MiniMax Code accepts at most:

- 64 Skill directories per Plugin;
- 8 MCP servers per Plugin;
- 8 Hook handlers for one event; and
- 32 Hook handlers across one Plugin.

Community CI rejects invalid declared components so broken packages do not enter the hosted
catalog. Runtime implementations use narrower failure boundaries: invalid Skills, MCP entries, and
Hook handlers are omitted with diagnostics while independent valid components continue loading. An
invalid root manifest rejects the package.

## Unsupported capabilities

The following are not current MiniMax Code Agent Plugin capabilities:

- blocking or context-producing Hooks and lifecycle scripts;
- custom Agents and Commands;
- LSP configuration;
- Apps or UI extensions;
- generic OAuth setup; and
- undocumented host-specific fields hidden in `extensions`.

Hosted contributions may contain assets used by supported components, but documentation must not
imply that MiniMax Code loads unsupported content. TUI Extensions are a separate product extension
system, not an Agent Plugin capability.
