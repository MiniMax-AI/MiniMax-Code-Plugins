# MiniMax Code Hooks 0.1

MiniMax Code Hooks 0.1 is a staged, versioned client-extension contract for Plugin authors who need
to declare observe-only commands at common agent lifecycle points. This community registry accepts
and statically validates the declaration alongside Agent Skills and MCP servers.

Hooks 0.1 is not an Agent Plugins 1.0 portable component. Other Agent Plugins clients may ignore it,
and a MiniMax Code build must advertise support for the exact Hooks schema before it executes the
extension. Registry acceptance validates the package contract; it does not prove that every released
client build implements it.

This repository does not yet link a MiniMax Code runtime implementation and end-to-end conformance
fixture for Hooks 0.1. Until it does, this is a registry-supported declaration format, not a claim
that a current MiniMax Code release executes Hooks.

## Package layout

Hooks use the Agent Plugins client-extension namespace `io.minimax.mcode`:

```text
plugin-root/
├── plugin.json
└── io.minimax.mcode/
    └── hooks/
        ├── hooks.json
        └── scripts/
            └── record.mjs
```

The root `plugin.json` continues to target Agent Plugins 1.0. Do not add a root `hooks` field. The
fixed Hooks configuration path is:

```text
io.minimax.mcode/hooks/hooks.json
```

`hooks.json` must target the published 0.1.0 schema:

```json
"$schema": "https://raw.githubusercontent.com/MiniMax-AI/MiniMax-Code-Plugins/main/schemas/io.minimax.mcode/hooks/0.1.0.schema.json"
```

Clients select supported behavior from that exact identifier using a local schema table. They must
not fetch a schema while loading a Plugin. The versioned schema file is immutable; any structural or
behavioral change requires a new identifier and file.

This document is the human-readable contract. If it conflicts with the published schema, this
document governs and the mismatch is a specification defect that must be corrected in a new pull
request without reassigning a published schema identifier.

## Configuration

This example records two event types with a bundled, dependency-free Node.js script:

```json
{
  "$schema": "https://raw.githubusercontent.com/MiniMax-AI/MiniMax-Code-Plugins/main/schemas/io.minimax.mcode/hooks/0.1.0.schema.json",
  "hooks": {
    "pre-tool-use": [
      {
        "command": "node",
        "args": [
          "${PLUGIN_ROOT}/io.minimax.mcode/hooks/scripts/record.mjs",
          "pre-tool-use"
        ]
      }
    ],
    "post-tool-use": [
      {
        "command": "node",
        "args": [
          "${PLUGIN_ROOT}/io.minimax.mcode/hooks/scripts/record.mjs",
          "post-tool-use"
        ],
        "cwd": "${PLUGIN_DATA}"
      }
    ]
  }
}
```

The document and every handler are closed objects. Unknown fields fail community-registry
validation.

### Events

Hooks 0.1 defines six exact event names:

| Event | Trigger |
| --- | --- |
| `session-start` | A supporting runtime attaches to a newly created or resumed top-level session. |
| `turn-start` | The runtime accepts user input and creates a new top-level agent turn. |
| `pre-tool-use` | One finalized top-level tool attempt exists, before permission evaluation or execution. |
| `post-tool-use` | The matching tool attempt reaches a terminal outcome, including success, failure, denial, timeout, or cancellation. |
| `turn-end` | The accepted top-level turn reaches completion, failure, or cancellation; transient idle and permission waits are not terminal. |
| `session-end` | The supporting runtime intentionally detaches from or closes the top-level session. |

Every event is observe-only. A Hook cannot block or approve an action, rewrite tool input or output,
inject model context, or change agent control flow. Those behaviors require a future versioned
contract.

MiniMax Code supports at most eight handlers for one event and 32 handlers across one Plugin. A
Hooks document must contain at least one event and every declared event must contain at least one
handler.

### Occurrence and delivery semantics

- A resume emits one new `session-start` for that runtime attachment, but does not replay events
  already emitted by an earlier attachment.
- Every top-level tool attempt emits one `pre-tool-use` and one matching `post-tool-use`. Permission
  denial, spawn failure, timeout, and cancellation still produce the matching terminal event. A
  retry is a new attempt and therefore a new pair.
- Parallel tool attempts each receive their own pair. Their events may interleave; no global order
  across attempts is defined.
- Subagent turns and tools do not emit Hooks 0.1 events. Background or remote execution emits events
  only when that execution is itself the top-level session in a runtime advertising this schema.
- For each emitted event occurrence, the runtime makes exactly one invocation attempt for every
  configured handler. Delivery is not durable and failed or interrupted handlers are not retried.
  An abrupt runtime or machine failure can prevent an attempt. `session-end` emission itself is best
  effort; its handlers are attempted in declaration order only while the shutdown budget remains,
  so later attempts may be omitted when shutdown wins.

### Handler fields

| Field | Required | Contract |
| --- | --- | --- |
| `command` | yes | One bare executable token or one contained Plugin-relative path beginning with `./`. Never a shell command string. |
| `args` | no | At most 64 string arguments, passed as distinct process arguments without shell parsing. |
| `env` | no | At most 64 portable environment names with string values. `PLUGIN_ROOT` and `PLUGIN_DATA` are reserved case-insensitively. |
| `cwd` | no | A contained `./` path, `${PLUGIN_ROOT}` path, or `${PLUGIN_DATA}` path. Defaults to the Plugin root. |

NUL bytes are invalid in process fields. A Plugin-relative executable, explicit working directory,
or bundled script must remain inside its filesystem-resolved root. Hosted Plugins cannot contain
symlinks.

## Runtime process contract

A compatible MiniMax Code build:

1. resolves `command` as one executable token and never sends it through a shell;
2. expands `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` once and non-recursively in `args`, `env` values,
   and `cwd`, but not in `command` or environment names; unknown placeholder-like text remains
   literal and no other environment expansion occurs;
3. supplies absolute `PLUGIN_ROOT` and per-installed-instance `PLUGIN_DATA` values after configured
   environment overlays, so a Plugin cannot override them;
4. uses the Plugin root as the default working directory;
5. sanitizes the base environment instead of exposing ambient credentials by default; and
6. enforces client-owned limits for time, stdin, stdout, stderr, process-tree lifetime, invocation
   count, and concurrency.

The client may send a MiniMax-native event object as one UTF-8 JSON document on stdin followed by
EOF. Hooks 0.1 does not standardize that payload. Plugin behavior intended to work across MiniMax
Code versions should use explicit arguments where possible and tolerate missing or unknown stdin
fields. A Hook must not persist prompt, transcript, tool input, or tool output unless its README
discloses that data flow.

Stdout, stderr, exit status, timeout, cancellation, and spawn failure are diagnostic-only. They
cannot change agent or permission behavior. `session-end` is best effort and cannot delay client
shutdown beyond the client's own budget.

Handlers within one Plugin run in declaration order. Plugins must not depend on ordering relative to
other Plugins.

The published JSON Schema enforces document shape and per-field/per-event limits. Standard JSON
Schema cannot express the sum of array lengths across six event properties, so the 32-handler total
is an explicit registry-validator and runtime requirement in addition to the schema.

## Validation and failure boundaries

Community CI validates every declared Hook entry and rejects an invalid contribution. It parses
configuration and source as data and never executes contributed Hook code.

Runtime implementations use narrower failure boundaries:

1. an invalid root `plugin.json` rejects the Plugin under Agent Plugins core rules;
2. an escaped or invalid `io.minimax.mcode` directory disables that extension;
3. invalid JSON, an unsupported schema, or an invalid Hooks document disables Hooks for that Plugin
   while valid Skills and MCP servers continue loading;
4. an invalid handler skips that handler without disabling valid siblings; and
5. one command failure does not disable later Hooks or independent components.

A client that does not implement the exact schema ignores the extension and should report that it is
unsupported. It must not guess compatibility from a similar version.

## Author checklist

Before submitting a Hook Plugin:

- use the fixed namespace path and exact schema identifier;
- keep `command` and `args` separate and avoid shell parsing in wrapper scripts;
- bundle inspectable source instead of installers or native binaries;
- document every event, executable, platform requirement, file write, network destination, and data
  category the Hook can receive or persist;
- provide a copyable lifecycle reproduction and expected result;
- make repeated execution safe and bound all stored data;
- do not include secrets, private endpoints, hidden telemetry, or personal data; and
- run `npm run check` without executing the Hook itself.

See [`examples/hello-mcode-hooks`](../examples/hello-mcode-hooks/) for a minimal Hook-only package.

## Portability and future versions

The six events and command declaration align with the active upstream
[Portable Hooks Component Type discussion](https://github.com/agentplugins/agent-plugins-spec/discussions/54).
That discussion is not a published Agent Plugins release. If Agent Plugins standardizes root
`hooks.json`, this extension can migrate only through an explicit new schema and documented package
change.

Blocking policy, context injection, portable payloads, subagent lifecycle, additional events, and
HTTP or model-backed handlers remain unsupported in 0.1.
