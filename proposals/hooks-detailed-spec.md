# Detailed Hooks specification for the `io.minimax.mcode` extension

Status: Companion proposal to `proposals/hooks.md` (commit `d86625d`).

Portable baseline: Agent Plugins 1.0.

This document extends the portable Hooks preview proposed in `proposals/hooks.md` with the
runtime-evidenced event catalog, decision semantics, and field vocabulary actually shipped in
`@minimax-ai/code@0.2.4` (npm, 2026-08-24). It is a design and conformance target, not a supported
Plugin capability. Registry merge of this proposal must remain blocked on the runtime
conformance fixtures listed in `proposals/hooks.md` § "Conformance evidence" — the proposal
*adds* the precision needed to write those fixtures, it does not bypass them.

## Relationship to the portable proposal

`proposals/hooks.md` (commit `d86625d`, hetaoBackend) is the primary portable proposal. This
companion document covers the same `io.minimax.mcode` namespace and the same six-event floor but
records the empirical event catalog, decision vocabulary, and dual-client bridging that the
MiniMax Code 0.2.4 runtime already ships. Where the two documents disagree, the portable
proposal governs for upstream Agent Plugins alignment; this companion governs for the observed
runtime. The two should be merged into a single normative spec before any client moves out of
preview.

## Scope added by this companion

- Full twelve-event catalog observed in the 0.2.4 runtime, with PascalCase keys that match
  `cli.js` event names.
- Decision and `hookSpecificOutput` semantics for events that can short-circuit agent behavior
  (`PreToolUse`, `PermissionRequest`).
- Dual-client bridging for the two native agent surfaces the 0.2.4 runtime already bridges
  (`CLAUDE`, `CODEX`), so Plugin authors can write one hook and have it run for either surface.
- Conformance field list (`matcher`, `pattern`, `regex`, `glob`, `timeout`, `timeoutMs`, `once`)
  drawn from the same source.
- Worked validator and example extension that are the minimum needed for CI to enforce the
  proposal.

This companion does not redefine portability, namespaces, or the observe-only floor. It
constrains and extends them.

## Empirical event catalog (cli.js v0.2.4)

The following event keys are present in the 0.2.4 `cli.js` bundle. The counts reflect the number
of literal string occurrences, which is a lower bound on the surface area of each event.

| Event | `cli.js` count | Default dispatch | Decision-bearing | Native client bridge |
| --- | --- | --- | --- | --- |
| `PreToolUse` | 35 | per tool call | yes | CLAUDE, CODEX |
| `PostToolUse` | 37 | per tool call | no | CLAUDE, CODEX |
| `SessionStart` | 46 | per session resume | no | CLAUDE, CODEX |
| `SessionEnd` | 98 | per session terminate | no | CLAUDE, CODEX |
| `Stop` | 97 | per turn / agent stop | no | CLAUDE, CODEX |
| `UserPromptSubmit` | 18 | per user turn | no | CLAUDE, CODEX |
| `PreCompact` | 12 | before context compaction | no | CLAUDE, CODEX |
| `Notification` | 66 | per system notification | no | CLAUDE, CODEX |
| `SubagentStart` | 15 | per subagent start | no | CODEX |
| `SubagentStop` | 13 | per subagent stop | no | CODEX |
| `PermissionRequest` | 40 | before a permission decision | yes | CLAUDE, CODEX |
| `PermissionDenied` | 3 | after a denied permission | no | CLAUDE, CODEX |

Two design consequences follow directly from the empirical surface:

1. `SessionEnd`, `Stop`, and `Notification` are the most referenced events. They are the
   common targets for cleanup, audit, and provenance Hooks. Any non-portable spec that omits
   them is missing the bulk of observed use.
2. `PreToolUse` and `PermissionRequest` are the only decision-bearing events. A spec that
   forces every event into the observe-only floor either drops these two events or quietly
   re-introduces decision semantics through the `hookSpecificOutput` channel. This companion
   recommends the explicit path: declare decision semantics on the events that carry them and
   observe-only on the rest.

`SessionEnd` and `Stop` are listed separately because in the 0.2.4 runtime they are distinct
event sources: `Stop` is per turn / agent stop, `SessionEnd` is per session terminate. The
portable proposal collapses them into one event; this companion preserves the distinction but
recommends that portable Plugins subscribe to both as if they were one, because the runtime may
emit either in a given lifecycle.

## Decision semantics

Decision-bearing events are not pure observers. They accept a typed response that the runtime
honors before continuing the agent loop.

For `PreToolUse` the runtime recognizes at least the following response shapes, observed in
`cli.js`:

- `{ "decision": "allow", "reason": "..." }` — proceed with the tool call.
- `{ "decision": "deny", "reason": "..." }` — reject the tool call and inject the reason into
  the agent transcript.
- `{ "hookSpecificOutput": { ... } }` — typed per-event payload; the only documented shape in
  0.2.4 is for `PreToolUse` and contains a modified tool input. The exact field set is
  MiniMax-defined and outside the portable floor.

For `PermissionRequest` the recognized shapes are the same, with `allow` / `deny` mapped to the
runtime's permission owner (`Permission Core` in 0.2.4). A denial here has the same effect as
`fail-closed` and cannot be overridden by a later `PreToolUse` Hook.

Two invariants apply to all decision-bearing events:

- Decisions are evaluated in declaration order within a Plugin. Earlier Handlers may constrain
  what later Handlers can decide. Cross-Plugin ordering is undefined; portable Plugins must not
  depend on it.
- A non-zero exit code, a missing `decision` field, or an unparseable response is treated as
  "no opinion" and falls through to the runtime default. The runtime default for `PreToolUse`
  is to allow; for `PermissionRequest` it is to deny. The portable proposal § "Observe-only
  runtime semantics" is preserved for every other event.

## Dual-client bridging

The 0.2.4 runtime contains code paths for two native agent surfaces — `CLAUDE` and `CODEX`.
Plugins that target `io.minimax.mcode` Hooks are written once and the runtime selects the
appropriate native event and payload shape per surface. Plugins do not need to know which
surface is active.

The bridging rules are:

- `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `Stop`, `UserPromptSubmit`,
  `PreCompact`, `Notification`, and `PermissionRequest` are bridged on both surfaces.
- `SubagentStart` and `SubagentStop` are bridged only on the `CODEX` surface in 0.2.4. A Plugin
  that subscribes to them on a `CLAUDE` surface receives no deliveries. The portable proposal
  lists subagent events among the non-portable non-goals, which is consistent with this
  asymmetry.
- `PermissionDenied` is bridged on both surfaces but is rarely emitted in 0.2.4 (`cli.js`
  count: 3). Plugins should treat it as advisory, not authoritative, and rely on the deny
  decision returned by `PermissionRequest` for security-relevant behavior.

A Plugin that requires a specific surface must declare it in the `extensions.io.minimax.mcode`
block; the field name and surface identifiers are reserved for a follow-up proposal because
they are not portable and the 0.2.4 runtime does not yet read them.

## Field vocabulary

The companion locks down the field names the validator must accept under each handler entry.
Field names are taken from `cli.js` literals and are therefore not negotiable; portable Plugins
that use any field outside this list are not portable, by definition.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `command` | string | yes | — | Single executable token, bare name or contained `./` path. Not a shell string. |
| `args` | string[] | no | `[]` | Distinct process arguments. No shell interpretation. |
| `env` | record<string,string> | no | `{}` | Additional environment. `PLUGIN_ROOT` and `PLUGIN_DATA` are reserved. |
| `cwd` | string | no | `${PLUGIN_ROOT}` | Contained working directory; symlink, junction, reparse-point, and traversal escapes are rejected. |
| `matcher` | string | no | `"*"` | Tool name pattern for `PreToolUse` / `PostToolUse`; supports `regex` and `glob` syntax. |
| `pattern` | string | no | — | Alias of `matcher`; both names appear in `cli.js`. |
| `regex` | boolean | no | `false` | If `true`, interpret `matcher` as a regular expression. |
| `glob` | boolean | no | `false` | If `true`, interpret `matcher` as a glob pattern. |
| `timeout` | number | no | `30000` | Hard timeout in milliseconds. `timeoutMs` is accepted as an alias. |
| `timeoutMs` | number | no | — | Alias of `timeout`. |
| `once` | boolean | no | `false` | If `true`, the runtime delivers this handler at most once per session. |

Reserved field names that the validator must reject: `type`, `shell`, `prompt`, `http`, `agent`,
`script`, `function`. These appear in `cli.js` as internal handler-kind discriminators and are
not part of the portable extension.

## Document shape

The `hooks.json` document must satisfy:

```json
{
  "$schema": "https://minimax.io/schemas/mcode-hooks/0.1.0/hooks.schema.json",
  "hooks": {
    "PreToolUse": [
      { "command": "node", "args": ["${PLUGIN_ROOT}/io.minimax.mcode/hooks/scripts/audit.mjs"] }
    ]
  }
}
```

The schema URL is illustrative. It must be owned by MiniMax, versioned, and immutable once a
client implements against it. The companion requires the same reverse-domain namespace
`io.minimax.mcode` and the same directory layout that the portable proposal defines; it does
not propose a different one.

## Conformance evidence (additions to the portable proposal)

The portable proposal already lists ten conformance checks. This companion adds three more,
all required for the runtime side:

- The full twelve-event catalog is delivered exactly once per matching lifecycle occurrence
  on the active native surface; this must be checked per (event, surface) pair.
- A `PreToolUse` Handler returning `{"decision":"deny","reason":"..."}` actually short-circuits
  the tool call in the 0.2.4 runtime, observed through `cli.js` decision-field handling.
- A `PermissionRequest` Handler returning `{"decision":"deny","reason":"..."}` causes the same
  fail-closed effect as a direct runtime denial and is not overridable by a later
  `PreToolUse` Handler.

These three checks are observed-in-runtime evidence. They are not portable; the portable
proposal is the right place for the portable subset. The companion only records what the 0.2.4
runtime already does so that future portability work has a concrete target.

## Out of scope (still)

The portable proposal § "Non-goals" remains authoritative. This companion does not authorize:

- tool-input rewriting outside `PreToolUse`;
- model-context injection;
- portable stdin payload shapes;
- HTTP, prompt, agent, or async handlers;
- cross-Plugin ordering guarantees;
- secret distribution, sandboxing, or marketplace trust levels.

A Plugin that needs any of these must file a follow-up proposal that links back to this
companion and to the portable proposal.

## Open decisions

These block merging this companion into the portable proposal. They are a subset of the
portable proposal's open decisions, with two additions:

- Confirm that the twelve-event catalog is the target surface for portability, not just an
  observed interim.
- Decide whether `hookSpecificOutput` is in scope for the portable proposal or remains
  MiniMax-defined.

## Primary sources

- `proposals/hooks.md` (commit `d86625d`) — portable Hooks preview.
- [`@minimax-ai/code@0.2.4` CHANGELOG](https://www.npmjs.com/package/@minimax-ai/code?activeTab=code) — runtime release notes, 2026-08-24.
- `cli.js` from `@minimax-ai/code@0.2.4` (npm tarball) — event name, decision, and field vocabulary.
- [Agent Plugins 1.0 specification](https://agent-plugins.org/specification) — portable baseline.
- [Agent Plugins client extensions](https://agent-plugins.org/plugin-authors/client-extensions) — reverse-domain namespace convention.
- [Agent Plugins Discussion #54: Portable Hooks Component Type](https://github.com/agentplugins/agent-plugins-spec/discussions/54) — upstream alignment.
- [`docs/plugin-compatibility.md`](../docs/plugin-compatibility.md) — current compatibility claim.
- [`docs/security-model.md`](../docs/security-model.md) — current security claim.
