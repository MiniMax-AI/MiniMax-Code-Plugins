# mcode-docs

English | [简体中文](./README.zh-CN.md)

**An overview and factual baseline for MiniMax Code (`mcode`).**

This plugin ships **no MCP server**. Its deliverables are a reusable Skill and a fully
static HTML documentation site (Chinese and English), readable offline by opening `site/index.html`
directly in a browser.

This documentation is not a feature list but a **factual baseline**: it walks through mcode's
usage forms, command surface, configuration, extension mechanisms and permission model, and gives
a verdict traceable to `VERIFICATION.md` for any "does mcode support X?" question. Capabilities
that were checked and found absent are stated as absent together with a substitute path, rather
than being omitted or guessed.

## Rationale

Material describing `mcode` is distributed across the packaged README, the official
open-source repository, runtime configuration files, and build artifacts. The principal
risk in this setting is not difficulty of retrieval but the adoption of plausible but
incorrect assertions. Three failure modes recur:

- `mcode mcp add`, `mcode skill list`, and similar subcommands are widely assumed to exist.
  Direct execution shows that **none of them are present**; the corresponding capabilities
  are provided through configuration files and TUI slash commands.
- The absence of `PreToolUse` in minified build artifacts is frequently taken as evidence
  that no hook system exists. The source shows the opposite: **eleven events** are defined,
  and they are **compatible with the Claude Code event model**.
- Filesystem snapshot rollback, Gist sharing, code formatters, and warming are often
  attributed to `mcode`. **None of these are implemented.**

This plugin resolves each of these points and, importantly, **retains the correction
records** in `VERIFICATION.md`, so that the derivation of every conclusion remains
inspectable rather than merely asserted.

## Evidence baseline

| Source | Version | Role |
| --- | --- | --- |
| Local installation `<npm root -g>/@minimax-ai/code` | **0.5.8** | Live `--help` execution, packaged README, actual runtime configuration |
| [`MiniMax-AI/minimax-code`](https://github.com/MiniMax-AI/minimax-code) `main` | **0.5.8** | Authoritative TypeScript definitions |

Feature definitions are taken from the **source**, which carries explicit types and is
therefore semantically unambiguous. **Live execution** serves a complementary purpose:
it establishes that a capability is genuinely present on the locally installed 0.5.8.
The ledger `VERIFICATION.md` grades every claim A–D by evidence strength.

## Contents

```
mcode-docs/
├── plugin.json                  # agent-plugins.org manifest
├── .minimax-plugin/plugin.json  # mcode marketplace manifest
├── .claude-plugin/plugin.json   # Claude-compatible manifest
├── VERIFICATION.md              # Evidence ledger: proof, counter-examples, corrections
├── icon.png
├── LICENSE
├── skills/mcode-docs/
│   ├── SKILL.md                 # Reusable Skill
│   └── reference/               # Nine reference documents
│       ├── commands.md          # Complete table of the TUI slash commands
│       ├── cli.md               # CLI, headless execution, ACP
│       ├── config.md            # Configuration structure and all known keys
│       ├── agents-skills.md     # Agents, skills, tools
│       ├── plugins.md           # Plugin container, manifest contract, hook system
│       ├── miniapp.md           # MiniApp contract, lifecycle, authoring
│       ├── mcp-tools.md         # MCP, attachments
│       ├── permissions.md       # Permission modes, Plan Mode, sessions
│       └── coverage.md          # Capability-boundary crosswalk against opencode v2
└── site/                        # Fully static HTML site (zh + en)
    ├── index.html               # Chinese, default entry
    ├── index.en.html            # English
    └── assets/{style.css, app.js}
```

## The documentation site

- **Entirely static.** No build step, no package manager, no MCP server, no CDN, and no
  network request of any kind.
- Operates under `file://`. The clipboard fallback path was verified explicitly.
- The visual system is derived from the **MiniMax platform documentation**
  (<https://platform.minimax.cn/docs/api-reference/api-overview>), with the component geometry
  and neutral-grey palette additionally measured pixel-by-pixel from the **platform.minimaxi.com
  documentation site** screenshots. Design tokens were extracted by measurement rather than by
  inspection: 404 CSS variables from the live page, supplemented by `getComputedStyle` on key
  elements and per-pixel sampling of official screenshots. Principal measured values:
  `--primary 24 30 37`, `--primary-light 74 222 128`, `--gray-100 #EEEEEF` as the default
  border, headings `#171717`, second-level headings and body links `#1E293B` at weight 600
  with underlining, body text `#3F3F3F` at 16px/24px, navigation `#707071`, inline code on
  `#EEEEEF@50%` with 2px 8px padding and a 6px radius, white code blocks at a 16px radius
  with 14px 16px padding, note boxes on `#EFF6FF` with a `#BFDBFE` border at a 16px radius,
  and 0.667px dividers. Screenshot-sampled component values: an 8px-radius `#E8E8E8` fill and a
  48px row height for the active sidebar item (no left rule, `#101113` text, `#2D2D2D` for the
  rest), a `#E5E5E5` 1px card border at a 12px radius, a centred 588×40 search field at a 10px
  radius, and a right-hand outline with no uppercase and no left rule (`#08090B` at weight 600 for
  the current entry, `#424242` for the rest).
- **Light theme by default.** The system `prefers-color-scheme` media query is deliberately
  not consulted on first visit. Dark mode is opt-in and the selection persists. The same rule
  governs language: `index.html` is always Chinese and `index.en.html` always English, with no
  automatic detection.
- Full-text search (`Cmd`/`Ctrl` + `K`), per-block copy controls, a scroll-tracking
  outline, and a mobile drawer.

## Usage

As a Skill: once the plugin is installed, the agent loads `mcode-docs` when the subject of
inquiry concerns mcode commands, configuration, agents, skills, plugins, hooks, MCP,
permissions, or sessions.

For direct reading: open `site/index.html` (Chinese) or `site/index.en.html` (English).

## Example

**Prompt**

```text
Does mcode have filesystem snapshots with point-in-time rollback?
I need to restore a file to how it looked 20 minutes ago.
```

**Expected result**

The agent answers that `mcode` has **no** global filesystem snapshot facility, and does
not stop at the denial. It states that `/history`, `/fork` and `/rewind` act on **sessions
and conversation history** rather than on the filesystem, so they are not a substitute; it
gives git as the supported alternative; and it cites both the ledger entry in
`VERIFICATION.md` and the manual section that settles the question. The answer separates
what was checked from what is assumed, rather than inferring from similarly named tools in
other agents.

## Documented scope

**Verified as implemented**, and documented in full: the TUI slash command table; the complete
CLI and headless flag set; ACP; the configuration structure and per-OS data directories; the
built-in agents and skills; the base tools; user-level and project-level MCP; the hook events
in the `MINIMAX`, `CLAUDE`, and `CODEX` formats; `PermissionMode`; Plan Mode; and session management.

**Verified as absent.** Each is stated explicitly in the documentation, together with the
supported alternative.

| Capability | Documented alternative |
| --- | --- |
| Filesystem snapshots and point-in-time rollback (opencode *Snapshots*) | Version control with git |
| Code formatters (opencode *Formatters*) | Explicit invocation of the project's own formatter by the agent |
| Gist and remote sharing (opencode *Sharing*) | `/export [path.md]` |
| A standalone policy engine (opencode *Policies*) | Least-privilege selection through `/permission` |
| Warming (opencode *Warming*) | Not required; the runtime manages model caching |
| *Migrate from V1* | Not applicable; upgrade through `mcode update` |
| Browser Use in the TUI/CLI | Not exposed there; Browser is a desktop-host capability |

> `/history`, `/fork`, and `/rewind` operate on **sessions and conversation history**. They
> are not a filesystem snapshot facility, and the two must not be conflated.

## Maintenance

Following a version increment, re-verify using the method recorded in `VERIFICATION.md`:

```bash
mcode --version
mcode <cmd> --help
git clone --depth 1 https://github.com/MiniMax-AI/minimax-code.git
```

Priority re-check targets: the two command registries
(`packages/tui/src/tui/commands/catalog.ts` and
`packages/tui/src/application/command-descriptors.ts`), `PLUGIN_HOOK_EVENTS`,
`PermissionMode`, and `MANIFEST_FIELDS`.

## License

[Apache-2.0](./LICENSE)
