# Portable Hooks preview for MiniMax Code

Status: Proposal

Portable baseline: Agent Plugins 1.0

Related upstream discussion: [Portable Hooks Component Type #54](https://github.com/agentplugins/agent-plugins-spec/discussions/54)

This document proposes an experimental MiniMax Code client extension for lifecycle Hooks. It is a
design and implementation plan, not a supported Plugin capability. Documentation, validation, and
runtime support must all land with conformance evidence before MiniMax Code advertises Hooks as
available.

## Recommendation

MiniMax Code should not add `hooks` to the root `plugin.json` manifest or describe Hooks as an Agent
Plugins 1.0 component. Agent Plugins 1.0 defines exactly two portable component types: Skills and
MCP servers. Its design notes explicitly leave Hooks outside v1 because client formats and behavior
have not yet converged.

The standards-compliant preview path is:

1. keep `plugin.json`, Skills, and `mcp.json` conformant to Agent Plugins 1.0;
2. place the preview contract under a stable MiniMax-owned client-extension namespace;
3. align its declaration with upstream Discussion #54 instead of inventing another event model;
4. implement and test the same observable behavior in the MiniMax Code runtime; and
5. migrate to a root portable `hooks.json` only after an Agent Plugins release standardizes it.

The accurate compatibility claim during preview would be:

> Agent Plugins 1.0 compatible, with an experimental MiniMax Code Hooks extension aligned with the
> portable Hooks proposal.

It must not be shortened to “Agent Plugins 1.0 Hooks support.”

## Evidence for a portable floor

Upstream Discussion #54 reports production integrations across twelve agent clients and identifies
six recurring lifecycle points despite different native names, configuration formats, and delivery
mechanisms. It proposes a small observe-only declaration: run one command when one lifecycle event
occurs. The proposal intentionally leaves payloads, blocking, permissions, and output control for
later work.

MiniMax Code should adopt that small floor first:

| Portable event | Meaning |
| --- | --- |
| `session-start` | A session starts or resumes. |
| `turn-start` | The user starts a new agent turn. |
| `pre-tool-use` | A tool call is about to execute. |
| `post-tool-use` | A tool call has completed. |
| `turn-end` | The agent turn finishes or becomes idle. |
| `session-end` | The session terminates. |

The upstream discussion is active evidence, not a published standard. The current Agent Plugins
1.1 working draft still defines only Skills and MCP servers. MiniMax implementation evidence should
therefore be contributed back to that discussion without claiming that its outcome is already
decided.

## Goals

- Provide one inspectable declaration for common lifecycle side effects such as provenance,
  telemetry disclosed by the Plugin, cache warming, and cleanup.
- Preserve Agent Plugins 1.0 conformance while the portable proposal is unresolved.
- Reuse existing Agent Plugins subprocess and path-safety concepts where they apply.
- Isolate invalid configuration and runtime failures from independent Skills, MCP servers, and Hook
  entries.
- Make implicit code execution visible, explicitly authorized, bounded, auditable, and revocable.
- Keep the preview structurally close enough to the upstream proposal for a mechanical migration.

## Non-goals

The portable preview does not define:

- blocking, approval, denial, or permission decisions;
- tool-input or tool-result rewriting;
- model-context injection;
- portable stdin payloads;
- subagent, compaction, notification, worktree, or configuration-change events;
- HTTP, prompt, agent, MCP-tool, or asynchronous Hook handlers;
- cross-Plugin ordering dependencies; or
- a sandbox, marketplace trust level, or secret-distribution mechanism.

MiniMax-specific policy Hooks may be proposed after the observe-only floor is implemented. They
must use an explicitly separate profile and must not silently change the semantics of portable
events.

## Package layout

Agent Plugins client extensions use a stable reverse-domain namespace and a matching top-level
directory. If `minimax.io` is confirmed as the ownership root, the namespace can be
`io.minimax.mcode`:

```text
plugin-root/
├── plugin.json
├── skills/                         # optional Agent Plugins component
├── mcp.json                        # optional Agent Plugins component
└── io.minimax.mcode/               # experimental client extension
    └── hooks/
        ├── hooks.json
        └── scripts/
            └── record.mjs
```

The extension directory is sufficient for discovery. The root manifest does not need a redundant
activation field. If installation UI later requires extension metadata, it may be defined under
`extensions.io.minimax.mcode` without changing root Agent Plugins fields.

The namespace must be confirmed by the MiniMax specification owner before publication and remain
stable after release.

## Preview document

The preview should publish an immutable, MiniMax-controlled JSON Schema. This example canonical ID
is illustrative and must not be used by Plugins until the schema exists at that exact URL:

```json
{
  "$schema": "https://minimax.io/schemas/mcode-hooks/0.1.0/hooks.schema.json",
  "hooks": {
    "pre-tool-use": [
      {
        "command": "node",
        "args": [
          "${PLUGIN_ROOT}/io.minimax.mcode/hooks/scripts/record.mjs"
        ]
      }
    ],
    "turn-end": [
      {
        "command": "node",
        "args": [
          "${PLUGIN_ROOT}/io.minimax.mcode/hooks/scripts/record.mjs",
          "--state",
          "${PLUGIN_DATA}/state.json"
        ]
      }
    ]
  }
}
```

The schema should be closed and define only:

- required `$schema` and `hooks` root fields;
- the six published event keys;
- one or more entries per event;
- a required single-token `command`;
- optional string-array `args`;
- optional string-valued `env`; and
- optional contained `cwd`.

The final field set should track upstream Discussion #54. Any deliberate difference must be
documented with an interoperability reason and contributed upstream.

## Command execution

Hook commands reuse the safe parts of the Agent Plugins stdio MCP process contract, repeated here
as explicit MiniMax extension requirements:

- `command` is one executable token: a bare executable name or a contained `./` path. It is not a
  shell command string.
- `args` values are passed as distinct process arguments without shell interpretation.
- MiniMax Code provides absolute `PLUGIN_ROOT` and per-installed-instance `PLUGIN_DATA` values and
  prevents the Plugin from overriding them.
- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded once, non-recursively, only in fields allowed
  by the extension schema.
- Explicit working directories resolve within `PLUGIN_ROOT` or `PLUGIN_DATA` after real-path
  resolution. Symlink, junction, reparse-point, and traversal escapes are rejected.
- The client sanitizes the base environment instead of inheriting credentials and unrelated ambient
  variables by default.
- The client launches the Hook without a shell and enforces hard limits for time, stdin, stdout,
  stderr, process-tree lifetime, invocation count, and concurrency.

## Observe-only runtime semantics

Every preview event is observational:

- exit status, stdout, stderr, timeout, cancellation, and spawn failure cannot alter agent behavior;
- `pre-tool-use` cannot block, approve, or modify a tool call;
- `post-tool-use` cannot replace or redact the tool result;
- failed Hook commands produce bounded diagnostics and do not prevent other Hooks or components from
  loading or running; and
- `session-end` is best effort and cannot delay client shutdown beyond its client-owned budget.

MiniMax Code may send its native event payload as one UTF-8 JSON document on stdin, followed by EOF.
That payload must be versioned and documented for MiniMax Plugin authors, but it is not a portable
Agent Plugins payload while the upstream proposal leaves payloads client-defined. Stdout and stderr
are diagnostic-only in this preview.

Within one Plugin, handlers must run in declaration order. Observational handlers may run concurrently
across Plugins, but diagnostics must retain the event identifier, Plugin identity, handler index,
duration, and outcome. Plugins must not depend on cross-Plugin ordering.

## Loading and failure isolation

The loader should use the narrowest applicable failure boundary:

1. An invalid root `plugin.json` rejects the Plugin under the Agent Plugins core rules.
2. A namespace directory that resolves outside the Plugin root disables that extension and denies
   access to the escaped path.
3. Invalid JSON, an unsupported schema version, or invalid top-level `hooks.json` structure disables
   Hooks for that Plugin while valid Skills and MCP servers continue loading.
4. An invalid event entry skips only that entry and reports a diagnostic.
5. One Hook process failure does not disable other Hook entries or independent components.
6. Clients that do not implement `io.minimax.mcode` ignore the extension without validating it.

MiniMax-Code-Plugins currently requires at least one valid Skill or MCP server. Whether the community
registry will admit Hook-only Plugins is a separate publication-policy decision. If admitted, the
catalog must explain that Agent Plugins clients without the MiniMax extension may load no usable
component from such a package.

## Security and authorization

Hooks introduce implicit local code execution at lifecycle points and may receive sensitive prompt
or tool data. JSON Schema validation alone is insufficient.

MiniMax Code must:

- show Hook events, commands, data categories, network behavior, and requested workspace access
  before enabling them;
- leave executable Hooks disabled until a user or organization policy explicitly authorizes them;
- request authorization again when an update expands events, commands, data access, or other
  capabilities;
- avoid sending full transcripts, system prompts, secrets, or unrelated tool data by default;
- isolate `PLUGIN_DATA` by installed Plugin instance;
- redact sensitive payload and environment values from diagnostics and audit records;
- provide global disable, per-Plugin disable, and safe-mode recovery paths; and
- never run contributed Hook code during registry validation or CI.

The hosted repository must continue rejecting secrets, private endpoints, hidden telemetry,
symlinks, native binaries, and undisclosed installers. Static review must not be described as a
sandbox or complete security audit.

## Conformance evidence

Two suites are required and must be reported separately.

### Agent Plugins 1.0 core

- Root `plugin.json` continues targeting the published 1.0 schema.
- Unimplemented extension namespaces remain ignored without internal validation.
- A missing extension directory is valid absence.
- Invalid MiniMax Hooks do not prevent valid Skills or MCP servers from loading.
- All package paths remain inside the filesystem-resolved Plugin root.

### MiniMax Hooks preview

- valid and invalid schema fixtures, including unknown fields and unsupported versions;
- schema selection from a local supported-version table without fetching schemas during loading;
- mixed valid and invalid entries proving that one invalid entry does not block its valid siblings;
- exactly one preview-event delivery for each corresponding lifecycle occurrence, covering all six
  events over success, failure, cancellation, and session resume;
- exact argument boundaries proving no shell interpolation;
- placeholder, working-directory, real-path, symlink, and reserved-environment cases;
- timeout and process-tree cleanup without orphaned processes;
- bounded and redacted stdin, stdout, stderr, diagnostics, and audit data;
- disabled and unauthorized Hooks never executing;
- failed Hooks never changing agent or permission behavior; and
- a deterministic end-to-end fixture installed into a real MiniMax Code runtime.

Registry CI must remain static and must never execute Plugin Hook code.

## Implementation surfaces

### MiniMax-Code-Plugins

After runtime ownership and the preview contract are approved, this repository would need coordinated
changes to:

- `docs/plugin-compatibility.md` to separate the portable core from MiniMax client extensions;
- `docs/security-model.md` for implicit execution, consent, disclosure, and failure behavior;
- `scripts/lib/validation.mjs` for static extension-schema and path validation;
- `test/validation.test.mjs` for schema and isolation fixtures;
- an `examples/hello-mcode-hooks/` package; and
- README and contribution language that labels the capability experimental and non-portable.

Those changes must not merge before the matching runtime can be installed and tested.

### MiniMax Code runtime

The runtime owns:

- extension discovery and a local schema registry;
- install consent and capability-diff consent on update;
- lifecycle event mapping;
- a bounded process runner and observe-only dispatcher;
- timeout, cancellation, and process-tree cleanup;
- audit, diagnostics, and redaction;
- user and organization enablement policy; and
- end-to-end conformance fixtures across interactive, headless, background, and remote sessions that
  claim support.

Accepting `hooks.json` in this repository without the runtime work is not Hooks support.

## Promotion path

1. Confirm the MiniMax namespace, six-event observe-only scope, and runtime owner.
2. Add MiniMax's adoption intent, event mapping, and semantic gaps to upstream Discussion #54.
3. Publish the immutable preview schema and human-readable contract on a MiniMax-controlled domain.
4. Implement one `pre-tool-use` observe-only vertical slice with consent, diagnostics, and audit.
5. Implement the other five events and pass the MiniMax conformance fixtures.
6. Add coordinated registry validation, documentation, and an example; label the release experimental.
7. If Agent Plugins publishes a portable Hooks component, migrate the extension file to the standard
   root `hooks.json` and its canonical schema.

An upstream specification change must update normative prose, schemas, canonical identifiers, fixed
discovery locations, version rules, failure boundaries, examples, and the conformance checklist as
one conceptual surface. A schema-only pull request is insufficient.

Blocking decisions, context injection, payload standardization, additional events, and alternative
handler types require separate interoperability evidence and versioned proposals.

## Open decisions

- Confirm the permanent reverse-domain namespace.
- Identify the runtime owner and supported release channels.
- Decide whether Hook-only packages are eligible for the community registry.
- Document exact event mappings for main agents, subagents, parallel tools, resumed sessions, and
  background or remote execution.
- Define the MiniMax-native stdin payload and disclosure policy without presenting it as portable.
- Set client-owned resource budgets and update re-authorization rules.
- Decide which second client will run shared conformance fixtures before portable standardization.

## Primary sources

- [Agent Plugins 1.0 specification](https://agent-plugins.org/specification)
- [Agent Plugins client conformance checklist](https://agent-plugins.org/client-implementers/conformance)
- [Agent Plugins client extensions](https://agent-plugins.org/plugin-authors/client-extensions)
- [Agent Plugins contribution process](https://github.com/agentplugins/agent-plugins-spec/blob/main/CONTRIBUTING.md)
- [Agent Plugins Discussion #54: Portable Hooks Component Type](https://github.com/agentplugins/agent-plugins-spec/discussions/54)
- [MiniMax Code Plugin compatibility](../docs/plugin-compatibility.md)
- [MiniMax Code Plugin security model](../docs/security-model.md)
- [Capability proposal policy](README.md)
