# crossplug

Bidirectional plugin converter between **DSH** (DeepSeek Harness) and **mcode** (MiniMax Code / pi).

## The problem

Migrating a plugin between AI coding tools usually means rewriting it for the
target tool's plugin system. crossplug converts plugins in **both directions**
while keeping the original logic intact (runtime bridging): the source plugin
code runs unmodified inside the converted package, and every mapping decision
is recorded in `CONVERSION-REPORT.md`.

## Commands

The converter core lives in `core/` inside this plugin (zero npm dependencies).
Every command is fully local and writes **only** to the directory you pass via `--out`.

```text
node core/run.js dsh2mcode <preset目录|插件源码文件> [--out <dir>]   # DSH → mcode
node core/run.js mcode2dsh <extension文件|插件包目录> [--out <dir>] [--host]  # mcode → DSH
node core/run.js list --side dsh|mcode      # 只读列出两侧已安装插件
node core/run.js version                    # 版本
```

## Try it

Install the plugin from `/plugins` → **Local**, then use the slash command:

```text
/convert-plugin dsh2mcode ~/.dsh/.agent-presets/my-agent
```

**Expected result**: an agent-plugins.org 1.0.0 package (`plugin.json` +
`skills/`) in `./out/`, ready to copy to `~/.minimax/plugins/<name>/`, plus a
`CONVERSION-REPORT.md` explaining every mapped row.

## Requirements

- Node.js 18+ (the converter core is zero-dependency CommonJS)
- For mcode output: MiniMax Code with Agent Plugins 1.0 support
- For DSH output: DeepSeek Harness with agent presets or host composition

## Data, network and side effects

- **No network access.** Conversion and listing are fully local.
- **No credentials, no telemetry, no external services, no subprocesses.**
  The package never executes `npm`, `git`, or any other child process.
- **Reads**: the input path you pass, plus (only for `list`) a read-only scan
  of `~/.dsh/.agent-presets`, `~/.minimax/plugins`, and `~/.pi/agent/extensions`.
- **Writes**: only inside the `--out` directory of `dsh2mcode`/`mcode2dsh`
  (existing files with the same name are overwritten; other files in that
  directory are left untouched). No user configuration or plugin directory
  (`~/.dsh`, `~/.minimax`, `~/.pi`) is ever modified.
- **No installer is bundled.** Community-plugin policy forbids installers that
  write into user homes; installation is manual: copy the converted package to
  the target directory, then refresh the plugin list (`/plugins` → Ctrl+R) or
  restart the tool.

## Automated tests

`core/run.test.mjs` runs with the repository test runner (`npm test` → `node --test`)
and covers input path boundaries, output-overwrite behavior, symlink / path-
traversal safety, loadability of generated manifests and MCP servers, and
failure behavior that never destroys pre-existing directories.

## License

Apache-2.0