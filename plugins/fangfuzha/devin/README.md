# Devin

The Devin MCP server (`https://mcp.devin.ai/mcp`): private repository wikis,
wiki generation and the organization-wide `devin_*` tools - plus the same wiki
tools the public DeepWiki endpoint offers.

## Try it

```text
用 Devin 讲清楚这个私有仓库的鉴权流程：`<owner>/<repo>`
```

```text
把 Devin 索引过的仓库列出来
```

Expected result: the Agent lists the repository's wiki topics or answers a
focused question from the wiki, and reports the organization it acted in when
the result depends on it.

## What it does

This Plugin ships one MCP connection and one Skill:

- `devin` MCP server - the Devin endpoint `https://mcp.devin.ai/mcp`, which
  exposes `read_wiki_structure`, `read_wiki_contents`, `ask_wiki_question`,
  `list_wiki_repos`, `generate_wiki` and the organization-wide `devin_*`
  tools.
- `devin` Skill - the tool workflow, plus authentication and organization
  troubleshooting.

## Requirements

- Internet access to `mcp.devin.ai`.
- A Devin API key - the endpoint has no usable browser login.
- No local runtime and no extra executable.

## Authentication

The endpoint advertises an MCP OAuth 2.1 challenge, but its authorization server
publishes **no dynamic client registration endpoint**, so no browser login can
complete. The supported path is a Devin API key sent as
`Authorization: Bearer <key>` (create one at
https://app.devin.ai/settings/api-keys).

| Setting | Header | Purpose |
|---|---|---|
| `DEEVIN_API_KEY` | `Authorization: Bearer <key>` | Required. Authenticates the session and raises the limits. |
| `DEEVIN_ORG_ID` | `X-Org-Id` | Selects the Devin organization the organization-scoped tools act in. Unset resolves the first organization the key belongs to. |

Export both in the environment MiniMax Code runs in, then reconnect the MCP
service:

```bash
export DEEVIN_API_KEY="your-key"
export DEEVIN_ORG_ID="your-org-id"
```

If the environment route is not available, add the server yourself in the global
MCP settings with the URL `https://mcp.devin.ai/mcp` and the header
`Authorization: Bearer <key>`. Never paste a key into a chat.

The key is referenced through an environment variable and never written to the
repository.

## Relationship to the deepwiki plugin

This plugin **supersedes** the `deepwiki` plugin. It serves the same wiki tools
for public repositories and additionally covers private repositories, wiki
generation and the organization tools.

If both plugins are installed, **disable or remove `deepwiki`**: the tool names
collide, which makes tool selection ambiguous, and the public endpoint rejects
every request that carries an `Authorization` header, so `deepwiki` adds no
capability next to this plugin.

## Data and network

- `mcp.devin.ai` - the Devin MCP server. A call sends the repository name (and,
  for questions, the question text); Devin returns the wiki content. The API key
  travels only in the request header.
- `app.devin.ai` - where a user creates an API key, opened manually.
- No telemetry from this Plugin, no analytics, and no shipped credentials.

## Limitations

- Only repositories that Devin has indexed can be read, unless a wiki is
  generated on explicit request.
- Verify specifics (signatures, options, versions) against the actual source.

## License

Apache-2.0. See [LICENSE](LICENSE).
