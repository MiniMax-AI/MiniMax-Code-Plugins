# Detailed Hooks specification for mcode 0.4.0+ runtime

Status: Companion proposal to `proposals/hooks.md` (commit `d86625d`) and the v0.3.x era
`proposals/hooks-detailed-spec.md` (PR #20, PR #36). Supersedes the v0.3.x hook shape with
the v0.4.0+ Claude Code compatible plugin format that `@minimax-ai/code@0.4.0` (npm,
2026-09-11) and later runtimes accept.

This document is the source of truth for Plugin authors writing against mcode 0.4.0+. The
v0.3.x `io.minimax.mcode/hooks/hooks.json` format is still accepted by the 0.3.10 / 0.3.11
runtimes and is documented in `proposals/hooks-detailed-spec.md`; that older spec is the
right reference for Plugin authors still targeting mcode 0.3.x and is **not** superseded
by the migration steps in this document.

## Relationship to the v0.3.x spec

The v0.3.x spec (`proposals/hooks-detailed-spec.md`, PR #20 with the PR #36 nested-shape fix)
defines the hook document at a fixed path inside the Plugin root:

```
${PLUGIN_ROOT}/io.minimax.mcode/hooks/hooks.json
```

mcode 0.4.0+ adopts the Claude Code compatible plugin format: the manifest moves to
`.claude-plugin/plugin.json`, the `hooks` field is inlined as a top-level object on the
manifest, and a separate `skills` field replaces the implicit `skills/<name>/SKILL.md`
discovery of the v0.3.x spec. The hook script location is unchanged
(`${PLUGIN_ROOT}/io.minimax.mcode/hooks/scripts/*.ps1` on Windows,
`*.mjs` / `*.sh` on other platforms), so existing hook scripts do not need to be rewritten
when migrating a Plugin from v0.3.x to v0.4.0+ — only the manifest shape and the skills
discovery path change.

A Plugin that targets mcode 0.4.0+ must use the v0.4.0+ format. A Plugin that targets
mcode 0.3.10 / 0.3.11 must use the v0.3.x format. There is no cross-version shim; the
plugin manifest reader is strict and silently drops the Plugin on a shape mismatch.

## Package shape

```
plugin-root/
├── README.md                                      (required by this community repository)
├── LICENSE                                        (required by this community repository)
├── .claude-plugin/
│   └── plugin.json                                (required, the manifest)
├── io.minimax.mcode/                              (v0.4.0+ hook scripts, mirroring v0.3.x layout)
│   └── hooks/
│       └── scripts/
│           └── *.ps1 | *.mjs | *.sh                (one script per event handler)
└── skills/                                        (top-level skills, see "Skills" below)
    └── SKILL.md                                   (one Skill is the typical minimum)
```

The `.claude-plugin/plugin.json` manifest is the new file. The top-level `plugin.json` from
the v0.3.x portable Agent Plugin 1.0 layout is **not** read by mcode 0.4.0+. Plugin authors
targeting mcode 0.4.0+ must move the manifest into `.claude-plugin/`.

## Manifest schema

The manifest is a single JSON object with the following fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Plugin name; lowercase letters, digits, single hyphens, no leading or trailing hyphen. |
| `version` | string | recommended | Semver. Bump major for any breaking manifest change. |
| `description` | string | recommended | One-sentence summary of what the Plugin does. |
| `author` | object | recommended | `{ name, url }`. Required disclosure in this community repository. |
| `license` | string | recommended | SPDX license identifier. |
| `homepage` | string | optional | Project URL. |
| `repository` | string | optional | VCS URL. |
| `keywords` | string[] | optional | Discovery tags. |
| `skills` | string \| string[] | optional | Path or paths to Skill files. See "Skills" below. |
| `mcpServers` | object | optional | MCP server definitions. Same shape as the Agent Plugins 1.0 `mcpServers`. |
| `hooks` | object | optional | Top-level hook definitions. See "Hooks" below. |

`name` is the only strictly required field. `skills` and `mcpServers` together must expose at
least one Skill or MCP server (the v0.3.x "Skill or MCP server required" check still applies;
the validator enforces it on the v0.4.0+ layout too).

Example manifest:

```json
{
  "name": "hello-mcode-hooks",
  "version": "0.1.0",
  "description": "Example Plugin that observes every mcode lifecycle event.",
  "author": { "name": "MCode Plugins contributors" },
  "license": "Apache-2.0",
  "skills": ["./skills/SKILL.md"],
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "powershell",
            "args": [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              "${PLUGIN_ROOT}/io.minimax.mcode/hooks/scripts/record-event.ps1"
            ],
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

## Skills

The `skills` field, when present, is either a single path string or an array of path
strings. Each path is relative to the manifest's directory (i.e. to
`.claude-plugin/`) and uses the `./` prefix. Two valid layouts are:

- **Top-level single Skill**: `skills/SKILL.md` at the Plugin root (one Skill, the typical
  case for a focused Plugin).
- **Per-Skill subdirectory**: `skills/<skill-name>/SKILL.md`, matching the v0.3.x layout.
  mcode 0.4.0+ accepts both, but Plugin authors who have a single Skill should prefer the
  top-level layout because it is shorter and matches the typical CLAUDE.md / SKILL.md
  convention that mcode 0.4.0+ uses for its built-in skills.

mcode 0.4.2 **silently drops** a Plugin whose `skills` field points into a nested
subdirectory (e.g. `["./skills/mcode-island/SKILL.md"]`) when the subdirectory's name does
not match the Skill frontmatter `name` field. The drop is silent: the Plugin does not
appear in the snapshot, no diagnostic is emitted, no hook fires. The Plugin author
sees the Plugin directory present on disk but the runtime acts as if it does not exist.
The empirical signature is `LOCAL_PLUGIN_NO_SUPPORTED_CAPABILITY` in
`scripts/snapshot-builder.ts:282-292` for the dropped Plugin.

To avoid the silent drop, point `skills` at a path that the snapshot builder can resolve:

- `./skills/SKILL.md` for a single-Skill Plugin, with the SKILL.md frontmatter `name` set
  to the same string as the Plugin's manifest `name`.
- `./skills/<skill-name>/SKILL.md` only when the subdirectory name matches the SKILL.md
  frontmatter `name`.

The validator (`scripts/validate.mjs`) currently scans for
`skills/<subdirectory>/SKILL.md` and rejects a Plugin that exposes zero Skills or MCP
servers. A Plugin that uses the top-level `skills/SKILL.md` layout must either also ship
a `skills/<some-dir>/SKILL.md` copy for the validator, or the validator must be extended
to recognize the top-level layout. The recommended workaround for a Plugin that wants
the v0.4.0+ runtime behaviour and the current validator behaviour is to ship both
`skills/SKILL.md` (used by the runtime) and `skills/<plugin-name>/SKILL.md` (a byte-identical
copy under a subdirectory whose name matches the Plugin's `name`; used by the validator
until the validator is updated). See "Migration from v0.3.x" below for an example.

## Hooks

The `hooks` field, when present, is an object whose keys are PascalCase event names and
whose values are arrays of handler entries. The schema is the same as the v0.3.10+ nested
shape from PR #36: each event has an array of `{ matcher, hooks: [{ type, command, args,
timeout }] }` objects, with `hooks[]` carrying the per-handler execution entry. Inline
in the manifest replaces the v0.3.x external `io.minimax.mcode/hooks/hooks.json`.

### Events

mcode 0.4.0+ ships the same 12 PascalCase events that the v0.3.x spec documents:

| Event | Default dispatch | Decision-bearing |
| --- | --- | --- |
| `PreToolUse` | per tool call | yes |
| `PostToolUse` | per tool call | no |
| `SessionStart` | per session resume | no |
| `SessionEnd` | per session terminate | no |
| `UserPromptSubmit` | per user turn | no |
| `Stop` | per turn / agent stop | no |
| `PreCompact` | before context compaction | no |
| `Notification` | per system notification | no |
| `SubagentStart` | per subagent start | no |
| `SubagentStop` | per subagent stop | no |
| `PermissionRequest` | before a permission decision | yes |
| `PermissionDenied` | after a denied permission | no |

The closed-schema field vocabulary and the per-handler entry shape are identical to the
v0.3.x spec and are enforced by `scripts/lib/validation.mjs`. The validator runs
unchanged on the inline-hooks shape; the v0.4.0+ format is a layout change, not a
schema change.

### Handler entry shape

Each entry under `hooks.<EventName>[]` has:

```json
{
  "matcher": "*",
  "hooks": [
    {
      "type": "command",
      "command": "powershell",
      "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "${PLUGIN_ROOT}/io.minimax.mcode/hooks/scripts/record-event.ps1"],
      "timeout": 5
    }
  ]
}
```

`command` is the executable token. On Windows, the value is typically `powershell` or
`pwsh` (or `node` for Node.js scripts). On POSIX, the value is typically `node` or
`sh`. `args` is an array of distinct process arguments; no shell interpretation is applied.
`timeout` is in seconds (the v0.3.x spec uses milliseconds; mcode 0.4.0+ accepts both
seconds and milliseconds but Plugin authors should pick one and stay consistent).

### Hook script conventions

Hook scripts receive one JSON event payload on stdin (one UTF-8 document, then EOF) and
write whatever side effects they want before exiting. The runtime does not parse the
payload; the script is free to ignore it. Convention from the v0.3.x spec carries over:

- Paths must use `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` env var expansion, not
  host-absolute paths. The runtime sets these to the Plugin's installation root and a
  per-Plugin data directory respectively.
- State writes under `${PLUGIN_DATA}` should use the staging-file rename pattern
  (`<file>.staging` → `<file>`) to avoid torn writes.
- Symlink and `..` containment should be enforced via `realpath`, not just `path.resolve`,
  on Windows where short / long path mismatches can fool a lexical check.
- The exit code, when non-zero, is treated as "no opinion" and the runtime falls back to
  its default behaviour. Observer hooks should swallow internal errors and exit 0.

An example PowerShell hook script is in
`examples/hello-mcode-hooks-v04/io.minimax.mcode/hooks/scripts/record-event.ps1`.

## Migration from v0.3.x

A Plugin that targets both mcode 0.3.10/0.3.11 and mcode 0.4.0+ must ship two layouts in
parallel. The runtime selects the layout that matches its version; older runtimes read
`plugin.json` and `io.minimax.mcode/hooks/hooks.json`, newer runtimes read
`.claude-plugin/plugin.json`.

The minimum-cost cross-version layout is:

```
plugin-root/
├── README.md
├── LICENSE
├── plugin.json                                  (v0.3.x manifest, Agent Plugins 1.0 schema)
├── .claude-plugin/
│   └── plugin.json                              (v0.4.0+ manifest, inline hooks)
├── skills/
│   ├── SKILL.md                                 (top-level, for v0.4.0+ runtime)
│   └── <plugin-name>/
│       └── SKILL.md                             (subdir copy, for v0.3.x runtime
│                                                 and for the current validator)
└── io.minimax.mcode/
    └── hooks/
        ├── hooks.json                           (v0.3.x hook document, optional in v0.4.0+)
        └── scripts/
            └── *.ps1 | *.mjs | *.sh              (shared hook scripts)
```

A Plugin that targets mcode 0.4.0+ exclusively can drop `plugin.json` and
`io.minimax.mcode/hooks/hooks.json` and keep only the `.claude-plugin/plugin.json`
manifest. **The hosted validator still requires both a top-level `plugin.json`
targeting the Agent Plugins 1.0 schema and a `skills/<subdir>/SKILL.md` copy**,
because `scripts/validate.mjs` reads the top-level `plugin.json` directly
(`scripts/lib/validation.mjs:310`) and iterates `skills/<subdir>/` for Skill
discovery (`scripts/lib/validation.mjs:321-324`). The example
`examples/hello-mcode-hooks-v04/` ships the dual layout for that reason: the
top-level `plugin.json` is a v0.3.x-compatible shim that satisfies the
validator, and `.claude-plugin/plugin.json` is the authoritative v0.4.0+
manifest. Once the validator is updated to read the v0.4.0+ layout, the
top-level shim and the subdir Skill copy can both be dropped.

## Common pitfalls (lessons learned)

These are the failure modes that bit mcode-island during the v0.3.x → v0.4.0+ migration.
Each one looks correct on inspection and only fails at runtime.

1. **Skills path points into a nested subdirectory that does not match the SKILL.md
   frontmatter `name` field.** The Plugin is silently dropped from the snapshot. The
   fix is to either rename the subdirectory to match the frontmatter `name`, or move the
   SKILL.md to the top level of `skills/`.

2. **Manifest lives at `plugin.json` instead of `.claude-plugin/plugin.json`.** mcode
   0.4.0+ only reads `.claude-plugin/plugin.json`. The Plugin is not loaded at all. The
   fix is to create the `.claude-plugin/` directory and move the manifest into it.

3. **Hooks live at `io.minimax.mcode/hooks/hooks.json` only, with nothing in the
   manifest.** mcode 0.4.0+ reads the `hooks` field from the inline manifest. The Plugin
   has hooks defined for the older runtimes but the newer runtime sees no hooks at all.
   The fix is to inline the `hooks` field in `.claude-plugin/plugin.json`. The
   `io.minimax.mcode/hooks/hooks.json` file becomes optional and can be retained for
   older-runtime compatibility.

4. **Hook command uses host-absolute paths.** `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are
   the only portable path tokens. Hard-coded `C:\Users\...` or `/home/...` paths break
   the moment the Plugin is installed somewhere else.

5. **SKILL.md has no `name` field in the frontmatter, or the `name` does not match the
   directory name.** mcode 0.3.x and earlier were lenient. mcode 0.4.0+ is strict. The
   validator also rejects it.

## Test evidence

Verified on mcode 0.4.2 (Windows 11, PowerShell 5.1) as part of the mcode-island v1.0.0
release. The empirical A/B test is the load-bearing evidence for the lessons above:

| Configuration | Hook fire? |
| --- | --- |
| `skills: ["./skills/mcode-island"]` (deep subdir path) | no, silent drop |
| `skills: ["./skills"]` + top-level `skills/SKILL.md` | yes, all 12 events |

The full commit history that produced this evidence is in the
`feat(mcode-island)!: rewrite plugin manifest for mcode 0.4.0+ runtime (v1.0.0)` commit
on the `proposal/mcode-island-0.4-hooks-rebuilt` branch. The companion PR is
[#38](https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/38).

## Open questions

These block merging this proposal into the portable Agent Plugins 1.0 surface.

- Confirm the top-level `skills/SKILL.md` layout is acceptable for portable
  cross-runtime Plugins, or whether a separate per-Skill subdirectory is mandatory
  for Agent Plugins 1.0.
- Confirm `hooks.timeout` units (seconds vs milliseconds) for the inline shape; the
  current validator accepts both, but the portable shape should pin one.
- Decide whether the `io.minimax.mcode/hooks/hooks.json` file is deprecated in 0.4.0+
  or merely ignored. The empirical answer is "ignored"; the policy answer is
  "deprecated for new Plugins, retained for cross-runtime compatibility".

## Primary sources

- [`@minimax-ai/code@0.4.0` CHANGELOG](https://www.npmjs.com/package/@minimax-ai/code?activeTab=code) — runtime release notes, 2026-09-11.
- [Agent Plugins 1.0 specification](https://agent-plugins.org/specification) — portable baseline.
- [Claude Code plugin manifest reference](https://docs.claude.com/en/docs/claude-code/plugins) — Claude Code plugin shape (the format mcode 0.4.0+ adopts).
- `proposals/hooks-detailed-spec.md` (commit `d86625d`, PR #20, PR #36) — v0.3.x spec this document supersedes for mcode 0.4.0+.
- [`docs/plugin-compatibility.md`](../docs/plugin-compatibility.md) — what this community repository advertises.
- [`docs/security-model.md`](../docs/security-model.md) — path safety and trust model.
- mcode-island v1.0.0 PR #38 — the empirical evidence base.
