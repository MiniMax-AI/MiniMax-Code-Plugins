# Community Plugins

This directory is the source of truth for community Agent Plugins published through this repository.

```text
plugins/
└── <github-owner>/
    └── <plugin-name>/
        ├── plugin.json
        ├── README.md
        ├── LICENSE
        ├── mcp.json          # optional
        ├── skills/           # optional
        └── io.minimax.mcode/ # optional MiniMax Code Hooks extension
            └── hooks/hooks.json
```

Create a contribution from the repository root:

```bash
npm run create -- <github-owner>/<plugin-name>
```

Replace every `TODO`, run `npm run check`, and open one pull request for one Plugin. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for review and security requirements.

A Plugin must contain at least one valid Skill, MCP server, or MiniMax Code Hook. Hook authors should
start with [`examples/hello-mcode-hooks`](../examples/hello-mcode-hooks/) and read the complete
[`Hooks 0.1 contract`](../docs/hooks.md). Hooks are currently a staged registry declaration; this
repository does not yet certify a MiniMax Code runtime build that executes them.
