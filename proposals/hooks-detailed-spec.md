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

Three classes of decisions appear in this companion and the rules for them differ:

- **Portable**: shared with `d86625d`; the portable proposal is authoritative.
- **Mcode-specific**: this companion adds or refines a behavior that the 0.2.4 runtime
  ships but the portable proposal intentionally does not. Marked inline as
  *Mcode-specific* or *0.2.4 specific* in the section that introduces it.
- **Companion-only observability**: this companion records empirical data
  (e.g. event name literal counts in `cli.js`, dual-client bridging) that is
  *evidence* for portable decisions, not portable decisions themselves. The
  portable proposal governs any normative conclusion drawn from the evidence.

A rule labelled *Mcode-specific* MUST NOT be relied on by Plugins that target a different
runtime. A rule labelled *Portable* MUST be honored by every `io.minimax.mcode` client. The
"ask" decision value on `PermissionRequest` (§ "Decision semantics") and the dual-client
bridging rules (§ "Dual-client bridging") are Mcode-specific; the closed-schema field
vocabulary (§ "Field vocabulary") is Portable.

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
The **0.2.4 confirmed?** column records whether the literal is referenced from the Runtime's
agent-event allowlist (the empirical `Wso` set plus the `hook-config-parser` dispatch path).
Events marked `forward` are observed in `cli.js` only as string literals; their wire contract
is reserved by the spec but their Runtime allowlist membership is still in flight.

| Event | `cli.js` count | Default dispatch | Decision-bearing | Native client bridge | 0.2.4 confirmed? |
| --- | --- | --- | --- | --- | --- |
| `PreToolUse` | 35 | per tool call | yes | CLAUDE, CODEX | yes |
| `PostToolUse` | 37 | per tool call | no | CLAUDE, CODEX | yes |
| `SessionStart` | 46 | per session resume | no | CLAUDE, CODEX | yes |
| `SessionEnd` | 98 | per session terminate | no | CLAUDE, CODEX | yes |
| `UserPromptSubmit` | 18 | per user turn | no | CLAUDE, CODEX | yes |
| `Stop` | 97 | per turn / agent stop | no | CLAUDE, CODEX | forward |
| `PreCompact` | 12 | before context compaction | no | CLAUDE, CODEX | forward |
| `Notification` | 66 | per system notification | no | CLAUDE, CODEX | forward |
| `SubagentStart` | 15 | per subagent start | no | CODEX | forward |
| `SubagentStop` | 13 | per subagent stop | no | CODEX | forward |
| `PermissionRequest` | 40 | before a permission decision | yes | CLAUDE, CODEX | forward |
| `PermissionDenied` | 3 | after a denied permission | no | CLAUDE, CODEX | forward |

The five `yes` events are the same five observed in the 0.2.4 `Wso` allowlist scraped from
`cli.js`. The seven `forward` events are the portable spec's reserved surface area; they
are wired into `cli.js` as string literals (e.g. decision-field handling, notification
routing) but their full agent-event dispatch path is expected to land alongside the
validator acceptance in the next Runtime release. A Plugin that needs `forward` events
should declare them anyway; if the 0.2.4 Runtime does not honor the event, the validator
and the portable spec are still authoritative.

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

For `PermissionRequest` the recognized shapes are:

- `{ "decision": "allow", "reason": "..." }` — permit the tool call without a TUI prompt.
- `{ "decision": "deny", "reason": "..." }` — reject the tool call (fail-closed equivalent).
- `{ "decision": "ask", "reason": "..." }` — **observer opt-in**: route the decision to the TUI
  prompt so the user can approve or deny, even though a Hook is registered. This value is
  added by this companion because the 0.2.4 Runtime default for `PermissionRequest` is
  fail-closed (`deny`), which makes a pure observer Hook indistinguishable from a denial and
  breaks the portable promise of "observe-only." With `ask`, an observer Hook can surface
  state (e.g. publish a `waiting` pill) without short-circuiting the user's decision.

A denial here has the same effect as `fail-closed` and cannot be overridden by a later
`PreToolUse` Hook. The portable default for `PermissionRequest` is therefore:

- If a Hook returns `allow`, `deny`, or `ask`, that decision wins.
- If a Hook is registered but does not return a `decision`, the runtime must still prompt the
  user (treat the absence of a decision as `ask`, not `deny`). The portable proposal's
  "Observe-only runtime semantics" floor is preserved: registering a Hook on
  `PermissionRequest` does not change the user-facing permission flow.

Three invariants apply to all decision-bearing events:

- Decisions are evaluated in declaration order within a Plugin. Earlier Handlers may constrain
  what later Handlers can decide. Cross-Plugin ordering is undefined; portable Plugins must not
  depend on it.
- A non-zero exit code, a missing `decision` field, or an unparseable response is treated as
  "no opinion" and falls through to the runtime default. The runtime default for `PreToolUse`
  is to allow; for `PermissionRequest` it is to ask the user (not deny) when any Hook is
  registered, and to fall back to the runtime's own permission owner otherwise. The portable
  proposal § "Observe-only runtime semantics" is preserved for every other event.
- **Mcode-specific.** An observer Hook on `PermissionRequest` SHOULD return `ask` (or no
  decision at all) and SHOULD NOT return `allow` or `deny` unless the Plugin is genuinely the
  permission owner. Returning `allow` from a status-publication Hook is a UX bug, not a
  feature. The portable proposal does not define the `ask` value; it is Mcode-specific.

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

The Runtime locates the hooks document at a fixed path inside the Plugin root:

```
${PLUGIN_ROOT}/io.minimax.mcode/hooks/hooks.json
```

`PLUGIN_ROOT` is the Runtime-reserved env var (see Field vocabulary below). Marketplace-installed
Plugins and locally-installed Plugins read from the same path inside their own root. The
Runtime does not write to the hooks document.

`PLUGIN_ROOT` and `PLUGIN_DATA` are independent roots. The hooks document lives under
`PLUGIN_ROOT`; Hook processes MAY write state under `PLUGIN_DATA`. The example
`examples/hello-mcode-hooks/io.minimax.mcode/hooks/scripts/record.mjs` writes to
`${PLUGIN_DATA}/state.json`; the validator treats each expansion token as containing
to its own root.

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

The `$schema` URL is **reserved** by this proposal but is not yet published. Plugins SHOULD
include the value shown above as a forward contract; the URL will be activated by MiniMax
before any client implementation is accepted. The companion requires the same reverse-domain
namespace `io.minimax.mcode` and the same directory layout that the portable proposal defines;
it does not propose a different one.

## Conformance evidence (additions to the portable proposal)

The portable proposal already lists ten conformance checks. This companion adds four,
all required for the runtime side:

- The full twelve-event catalog is delivered exactly once per matching lifecycle occurrence
  on the active native surface; this must be checked per (event, surface) pair.
- A `PreToolUse` Handler returning `{"decision":"deny","reason":"..."}` actually short-circuits
  the tool call in the 0.2.4 runtime, observed through `cli.js` decision-field handling.
- A `PermissionRequest` Handler returning `{"decision":"deny","reason":"..."}` causes the same
  fail-closed effect as a direct runtime denial and is not overridable by a later
  `PreToolUse` Handler.
- A `PermissionRequest` Handler that returns NO `decision` (or `{"decision":"ask",...}`) does
  not change the user-facing permission flow: the TUI prompt still appears, the user can
  still approve or deny, and the registered Handler is invoked for state observation only.
  This is the only path under which a portable observer Hook on `PermissionRequest` can be
  written without forcing the user to act on every tool call.

These four checks are observed-in-runtime evidence. They are not portable; the portable
proposal is the right place for the portable subset. The companion only records what the 0.2.4
runtime already does so that future portability work has a concrete target.

### End-to-end smoke (mcode-island v0.3.0, 2026-08-26)

The companion was exercised by the `mcode-island` Plugin on Windows 11 24H2 with
`@minimax-ai/code@0.2.4`. Each of the twelve event scripts was invoked directly with a
realistic event payload, the resulting `status.json` was read back, and the multi-writer
semantics with the Runtime's own status detector were observed:

```
step=SessionStart           got=idle       src=agent      expect=idle       OK
step=UserPromptSubmit       got=thinking   src=agent      expect=thinking   OK
step=PreToolUse-Bash        got=working    src=agent      expect=working    OK
step=PostToolUse-Bash       got=done       src=agent      expect=done       OK
step=PreToolUse-Read        got=working    src=agent      expect=working    OK
step=PostToolUse-Read       got=done       src=agent      expect=done       OK
step=PreCompact             got=thinking   src=agent      expect=thinking   OK
step=Stop                   got=done       src=agent      expect=done       OK
step=SubagentStart          got=working    src=agent      expect=working    OK
step=SubagentStop           got=done       src=agent      expect=done       OK
step=PermissionRequest      got=waiting    src=agent      expect=waiting    OK
step=PermissionDenied       got=error      src=agent      expect=error      OK
step=PreToolUse-self-push   got=error      src=agent      expect=error      OK   (no change, filter applied)
step=Notification           got=idle       src=agent      expect=idle       OK
step=SessionEnd             got=idle       src=agent      expect=idle       OK
----
summary: 15 pass, 0 fail
```

The `PreToolUse-self-push` case is the only one that intentionally does NOT change state: it
is a `Bash` invocation whose command contains `notify-island.ps1`, so the Hook filters the
self-push to avoid recursive state churn. This is a behavior the companion does not yet
prescribe; portable Plugins may want to filter their own internal tool calls or may want
to push state on every tool call including their own. The mcode-island choice is recorded
here as one working answer, not as a portable requirement.

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

## Validator scope and limitations

The static validator (`scripts/lib/validation.mjs`) is a shape check; it does not execute
Hook code and cannot observe runtime behavior. The boundary is explicit so reviewers and
Plugin authors know where the guarantee ends.

The validator **enforces**:

- `hooks.json` parses as JSON and is an object (closed schema; any unknown root field is
  rejected).
- `hooks.json` declares `$schema` as a non-empty string.
- Every key under `hooks` is one of the twelve PascalCase event names listed in
  § "Empirical event catalog".
- Each event value is a non-empty array of hook entries.
- Every hook entry's keys are in the closed `HOOK_ENTRY_FIELDS` allowlist; reserved
  internal discriminators (`type`, `shell`, `prompt`, `http`, `agent`, `script`,
  `function`) are rejected separately.
- Field types match the table in § "Field vocabulary".
- `command` is a bare executable or a contained `./` path.
- `env` does not contain `PLUGIN_ROOT` or `PLUGIN_DATA`; the runtime owns those.
- `cwd` (if present) is a contained `./` path or a `PLUGIN_ROOT` / `PLUGIN_DATA`
  expansion at the syntactic level.

The validator **does not enforce** (these are Runtime responsibilities, recorded here so
the boundary is explicit):

- Whether the Runtime actually honors a given event. The validator accepts every
  event in the catalog regardless of whether the active Runtime wires it; the
  `0.2.4 confirmed?` column in § "Empirical event catalog" records the gap.
- Whether the `$schema` URL is reachable or published. The validator accepts any
  non-empty string; a future minor revision of this proposal MAY tighten this to
  require a `https://minimax.io/schemas/...` prefix.
- Payload data values delivered to a Hook. The validator does not parse stdin;
  the example `record.mjs` deliberately persists only payload field names, not
  values. A portable observer SHOULD follow the same pattern unless the
  `PLUGIN_DATA` directory and the payload contract are both Mcode-specific and
  the Plugin declares this in its `SKILL.md`.
- Path safety at execution time. The example's `record.mjs` performs symlink
  and `..` containment via `realpath`-style resolution; the validator
  intentionally does not. Symlink, junction, reparse-point, and traversal
  escapes on `cwd` and on Plugin-supplied `args` are the Runtime's contract
  to enforce.
- Whether decision responses (`allow`, `deny`, `ask`, `hookSpecificOutput`)
  are honored. The validator does not invoke Hooks.
- Cross-Plugin ordering. The portable proposal § "Loading and failure isolation"
  already records that this is undefined.

## Open conformance gaps

CI coverage for the 0.2.4 event catalog is partial. The two CI tests in
`test/validation.test.mjs` that exercise the example `record.mjs` cover:

- `SessionStart` (via the "writes state under PLUGIN_DATA" test, once) and a
  ten-invocation loop on the same event (via the byte-cap test).

The remaining ten events — `PreToolUse`, `PostToolUse`, `SessionEnd`, `Stop`,
`UserPromptSubmit`, `PreCompact`, `Notification`, `SubagentStart`,
`SubagentStop`, `PermissionRequest`, `PermissionDenied` — are covered only by
the manual smoke in § "End-to-end smoke" (mcode-island v0.3.0, 2026-08-26,
Windows 11 24H2, `@minimax-ai/code@0.2.4`). That manual run is not
reproducible from CI today.

The path to close this gap is straightforward and is on the open decisions
list: add one CI test per missing event, each spawning
`record.mjs` with a representative payload for that event and asserting the
recorded record shape. The example `record.mjs` is already payload-shape
agnostic (it persists field names only), so the test bodies are short. Until
those tests land, the "End-to-end smoke" output above is the only evidence
that the events work end-to-end and the validator's claim to support all
twelve is not yet backed by CI.

The `decision` field, the `ask` value, the `hookSpecificOutput` shape, and
the dual-client bridging rules are not covered by any CI test. They are
backed by `cli.js` literal inspection only.

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
