# hello-mcode-hooks-v04

A minimal Plugin that demonstrates one Skill and one inline Hook entry under the
mcode 0.4.0+ plugin format.

## What this example demonstrates

- A `.claude-plugin/plugin.json` manifest with the `hooks` field inlined (no
  external `io.minimax.mcode/hooks/hooks.json` document).
- A top-level Skill at `skills/SKILL.md` plus a byte-identical subdirectory
  copy at `skills/hello-mcode-hooks-v04/SKILL.md`. The top-level copy is what
  mcode 0.4.0+ reads; the subdirectory copy is what the current validator
  (`scripts/validate.mjs`) and the v0.3.x runtime read.
- An observer PowerShell hook script that records `PreToolUse`, `SessionStart`,
  and `SessionEnd` events to a per-instance state file.
- Atomic, cross-platform state file writes under the runtime-provided
  `PLUGIN_DATA` directory, using a staging-file rename.
- Path resolution that uses runtime-injected environment values
  (`${PLUGIN_ROOT}`, `${PLUGIN_DATA}`), not host-absolute literals.

This example is the v0.4.0+ counterpart of
[`examples/hello-mcode-hooks/`](../hello-mcode-hooks/). It targets mcode 0.4.0+
exclusively. For a Plugin that must run on both mcode 0.3.x and mcode 0.4.0+,
ship both layouts in parallel (see
[`proposals/hooks-v0.4-spec.md`](../../proposals/hooks-v0.4-spec.md) for the
recommended cross-version layout).

## Layout

```text
hello-mcode-hooks-v04/
├── README.md
├── LICENSE
├── plugin.json                # v0.3.x-compatible shim, satisfies the hosted validator
│                              # (top-level $schema: agent-plugins.org/.../1.0.0)
├── .claude-plugin/
│   └── plugin.json            # v0.4.0+ manifest, inline `hooks` (the authoritative file)
├── skills/
│   ├── SKILL.md               # top-level, used by mcode 0.4.0+
│   └── hello-mcode-hooks-v04/ # subdir copy, used by the validator and
│       └── SKILL.md           # the v0.3.x runtime
└── io.minimax.mcode/
    └── hooks/
        └── scripts/
            └── record-event.ps1
```

The two `plugin.json` files are the v0.3.x / v0.4.0+ dual-shipment pattern. The
top-level `plugin.json` is the v0.3.x Agent Plugins 1.0 manifest; it is what
the current hosted validator (`scripts/validate.mjs`) reads. The
`.claude-plugin/plugin.json` is the v0.4.0+ Claude Code compatible manifest
with inline `hooks`; it is what mcode 0.4.0+ reads. Both have the same
`name` field so the runtime and the validator agree on the Plugin's
identity. Once the validator learns the `.claude-plugin/plugin.json`
layout, the top-level shim can be dropped.

## Manifest

The `.claude-plugin/plugin.json` manifest declares three inline hook handlers
(`PreToolUse`, `SessionStart`, `SessionEnd`) plus a `skills` field that points
at both the top-level Skill and the subdirectory copy. The `name` field is the
only strictly required field; the rest are recommended for catalog quality.
The full schema is in
[`proposals/hooks-v0.4-spec.md`](../../proposals/hooks-v0.4-spec.md).

## Hook entry

The hook entry is one `record-event.ps1` invocation per event. The script
reads the event payload from stdin (one UTF-8 JSON document, then EOF, per the
v0.4.0+ spec) and appends a compact record to `${PLUGIN_DATA}/state.json` using
a staging-file rename. No tool input rewriting, no permission decisions, no
network access, no telemetry, no host-absolute paths.

## Validation expectations

- `npm run check` runs the validator against this example. The validator
  accepts the v0.4.0+ layout and reads the subdirectory Skill copy
  (`skills/hello-mcode-hooks-v04/SKILL.md`).
- The script resolves all paths from `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`
  only. There is no host-absolute path, no credential, no telemetry, no
  network call.
- The Hook entry is recognized as an inline field on the manifest. There is no
  external `hooks.json` document to validate.

## Disclosure

This example contains:

- no credentials;
- no network access;
- no telemetry;
- no third-party services.

The same disclosure is repeated in `skills/SKILL.md` per the
`hello-mcode-hooks` plugin convention.
