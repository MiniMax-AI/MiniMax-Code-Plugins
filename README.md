<p align="center">
  <img src="assets/hero.svg" alt="MiniMax Code Plugins — one folder, one pull request, a new agent superpower" width="100%" />
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="CONTRIBUTING.md">Contribute</a> ·
  <a href="docs/plugin-compatibility.md">Plugin contract</a> ·
  <a href="SECURITY.md">Security</a>
</p>

<p align="center">
  <a href="https://github.com/hetaoBackend/MiniMax-Code-Plugins/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/hetaoBackend/MiniMax-Code-Plugins/ci.yml?branch=main&amp;style=flat-square&amp;label=build" alt="Build status" /></a>
  <img src="https://img.shields.io/badge/Agent_Plugins-1.0-8b5cf6?style=flat-square" alt="Agent Plugins 1.0" />
  <img src="https://img.shields.io/github/license/hetaoBackend/MiniMax-Code-Plugins?style=flat-square&amp;color=22c55e" alt="Apache-2.0 license" />
  <img src="https://img.shields.io/badge/PRs-welcome-ec4899?style=flat-square" alt="Pull requests welcome" />
</p>

## One folder is the release

MiniMax Code Plugins is the community home for Agent Plugins that run in MiniMax Code. Put a
portable Plugin under `plugins/<github-owner>/<plugin-name>`, open a pull request, and let CI check
the package users will actually install.

```text
fork  →  create  →  build  →  check  →  pull request  →  discover
```

No second repository. No catalog JSON. No commit pin to copy. Your Plugin source, docs, review, and
history live together.

## Ship your first Plugin

```bash
git clone https://github.com/<you>/MiniMax-Code-Plugins.git
cd MiniMax-Code-Plugins
npm install
npm run create -- <you>/my-first-plugin
```

The scaffold gives you a Skill-first Plugin:

```text
plugins/<you>/my-first-plugin/
├── plugin.json
├── README.md
├── LICENSE
└── skills/
    └── my-first-plugin/
        └── SKILL.md
```

Replace every `TODO`, then run:

```bash
npm run check
```

If it passes, open one pull request for that Plugin. Start with
[`CONTRIBUTING.md`](CONTRIBUTING.md) when you want the full review checklist.

## What can a Plugin add?

### Skills

Package reusable instructions, workflows, and domain knowledge. Skills are the fastest path from a
good prompt pattern to a capability anyone can install.

### MCP servers

Connect MiniMax Code to local tools or remote services with `stdio`, `streamable-http`, or `sse`.
Dependencies, accounts, network destinations, and data handling must be visible before install.

### Both

Use a Skill to teach the workflow and MCP to provide the tools. The portable package stays small:

```text
plugin-root/
├── plugin.json
├── mcp.json                  # optional
└── skills/                   # optional
```

This repository is for **Agent capabilities**. TUI Extensions are a separate system and are not
loaded from this package format.

## Install and use a Plugin

A Plugin is a portable folder that follows the Agent Plugins 1.0 contract. MiniMax Code reads the
folder directly — there is no catalog to register with and no commit to pin.

1. Choose a Plugin under [`plugins/<owner>/<name>`](plugins/) (or start with an
   [`examples/`](examples/) Plugin to try it out).
2. Copy that folder into your MiniMax Code Plugins location, or point MiniMax Code at its path.
3. Keep the required package shape intact:

   ```text
   plugin-root/
   ├── README.md
   ├── LICENSE
   ├── plugin.json
   ├── mcp.json        # optional
   └── skills/
       └── <skill-name>/
           └── SKILL.md
   ```

4. Reload the session. MiniMax Code then automatically:
   - reads every `skills/<skill>/SKILL.md` and activates the Skill when its `description` matches;
   - connects any `mcp.json` server over `stdio`, `streamable-http`, or `sse`.

MiniMax Code supplies `PLUGIN_ROOT` and `PLUGIN_DATA` to the Plugin for you; do not set them
yourself. For the exact supported contract, transport limits, and unsupported capabilities, see
[`docs/plugin-compatibility.md`](docs/plugin-compatibility.md).

Before installing, read the Plugin's own README for its example prompt, required executables or
accounts, network destinations, and data handling.

## The gate is simple

A contribution must:

- live at `plugins/<github-owner>/<plugin-name>`;
- include `plugin.json`, `README.md`, and `LICENSE`;
- expose at least one valid Skill or MCP server;
- document a copyable example, requirements, network access, and data use;
- contain no secrets, private endpoints, hidden telemetry, native binaries, or symlinks;
- pass `npm run check` and human review.

Passing review means the Plugin is available as community software. It is not a MiniMax endorsement
or a complete security audit. Read the source and requested capabilities before installing.

## Explore the project

- [`plugins/`](plugins/) — community Plugin source
- [`examples/hello-mcode`](examples/hello-mcode/) — smallest Skill Plugin
- [`examples/hello-mcode-mcp`](examples/hello-mcode-mcp/) — dependency-free stdio MCP
- [`docs/plugin-compatibility.md`](docs/plugin-compatibility.md) — exact supported contract
- [`docs/security-model.md`](docs/security-model.md) — validation and trust model
- [`docs/architecture.md`](docs/architecture.md) — hosted contribution architecture
- [`GOVERNANCE.md`](GOVERNANCE.md) — decisions and maintainer responsibilities

## Community preview

The contract is intentionally narrow while MiniMax Code's public Plugin surface stabilizes. Hooks,
custom Agents, Commands, LSP, Apps, generic OAuth, and TUI Extensions are not advertised as current
Agent Plugin capabilities.

Bring one useful capability. Make the example undeniable. Ship it in one pull request.

## License

Repository tooling and documentation use Apache-2.0. Every hosted Plugin includes and declares its
own open-source license.
