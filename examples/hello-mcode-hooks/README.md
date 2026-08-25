# hello-mcode-hooks

A minimal Plugin that ships one Skill and one experimental `io.minimax.mcode` Hook entry under
the Agent Plugins 1.0 portable Hooks preview.

## What this example demonstrates

- A Skill-only Agent Plugin (the "hello-hooks" Skill).
- A single Hook entry in `io.minimax.mcode/hooks/hooks.json` that observes `SessionStart`,
  `SessionEnd`, and `PreToolUse`.
- Atomic, cross-platform state file writes under the runtime-provided `PLUGIN_DATA` directory.
- Path resolution that uses runtime-injected environment values, not host-absolute literals.

This example is not a working integration; it is a structural reference. MiniMax Code 0.2.4
ships the runtime side of the preview but the portable Hooks proposal is still in review and
registry validation must not execute Hook code.

## Layout

```text
hello-mcode-hooks/
├── README.md
├── LICENSE
├── plugin.json
├── skills/
│   └── hello-hooks/
│       └── SKILL.md
└── io.minimax.mcode/
    └── hooks/
        ├── hooks.json
        └── scripts/
            └── record.mjs
```

## Hook entry

The Hook entry is one `record.mjs` invocation per event. The script reads the event payload
from stdin (one UTF-8 JSON document, then EOF, as proposed in `proposals/hooks.md` § "Observe-only
runtime semantics") and appends a compact record to `${PLUGIN_DATA}/state.json` using a
staging-file rename. No tool input rewriting, no permission decisions, no network access, no
telemetry.

## Validation expectations

- `plugin.json` continues to target the published Agent Plugins 1.0 schema and remains valid
  under `scripts/validate.mjs`.
- `io.minimax.mcode/hooks/hooks.json` is recognized as an experimental client extension
  namespace. The validator accepts it but does not require it.
- The script resolves all paths from `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` only.

## Disclosure

This example contains:

- no credentials;
- no network access;
- no telemetry;
- no third-party services.

The same disclosure is repeated in `skills/hello-hooks/SKILL.md` per the
`hello-mcode-hooks` plugin convention.
