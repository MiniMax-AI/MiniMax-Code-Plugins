---
name: hello-mcode-hooks-v04
description: Observer example for the mcode 0.4.0+ plugin format. Activates when a Plugin author needs a reference layout for inline Hooks under .claude-plugin/plugin.json.
---

# hello-mcode-hooks-v04

This is the canonical example Plugin for the mcode 0.4.0+ plugin format. It mirrors the
structure of `examples/hello-mcode-hooks/` (the v0.3.x example) but uses the new manifest
location, the inline `hooks` field, and a top-level Skill file.

The Hook entries record every `PreToolUse`, `SessionStart`, and `SessionEnd` event the runtime
delivers to a per-instance state file under the runtime-injected `PLUGIN_DATA` directory. The
script is a PowerShell observer that does not modify any tool input, does not change any
permission decision, and exits zero on every code path. The Hook is a structural reference for
new Plugin authors; it is not a working integration against the portable Agent Plugins 1.0
surface.

## Disclosure

This example contains:

- no credentials;
- no network access;
- no telemetry;
- no third-party services.

All state is local to the per-Plugin `PLUGIN_DATA` directory. The Hook script only writes to
that directory and exits.

## Cross-runtime note

This example ships a top-level `skills/SKILL.md` (used by mcode 0.4.0+) and a byte-identical
copy at `skills/hello-mcode-hooks-v04/SKILL.md` (used by the current validator and by the
v0.3.x runtime if it ever reads the new layout). The validator scans
`skills/<subdirectory>/SKILL.md`; the subdirectory copy is what satisfies that check until
the validator is updated to accept the top-level layout.
