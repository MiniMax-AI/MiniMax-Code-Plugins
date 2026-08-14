# crossplug

Bidirectional plugin converter between **DSH** (DeepSeek Harness) and **mcode** (MiniMax Code / pi).

## The problem

Migrating a plugin between AI coding tools usually means rewriting it for the
target tool's plugin system. crossplug converts plugins in **both directions**
while keeping the original logic intact (runtime bridging): the source plugin
code runs unmodified inside the converted package, and every mapping decision
is recorded in `CONVERSION-REPORT.md`.

## Try it

Install the plugin from `/plugins` → **Local**, then use the slash command:

```text
/convert-plugin dsh2mcode ~/.dsh/.agent-presets/my-agent
```

**Expected result**: an agent-plugins.org 1.0.0 package (`plugin.json` +
`skills/`) in `./out/`, ready to copy to `~/.minimax/plugins/<name>/`, plus a
`CONVERSION-REPORT.md` explaining every mapped row.

Other directions:

```text
/convert-plugin mcode2dsh ./some-mcode-plugin          # pi/mcode extension → DSH agent preset
/convert-plugin mcode2dsh ./some-mcode-plugin --host   # → DSH host plugin (all sessions)
/convert-list                                         # list plugins on both sides
```

## Requirements

- Node.js 18+ (the converter core is zero-dependency CommonJS)
- For mcode output: MiniMax Code with Agent Plugins 1.0 support
- For DSH output: DeepSeek Harness with agent presets or host composition

## Data and network

- **No network access.** Conversion is fully local (reads local files only).
- **No credentials required.**
- No telemetry, no external services.

## License

Apache-2.0
