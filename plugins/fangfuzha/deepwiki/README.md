# DeepWiki

AI-generated documentation and Q&A about **public** GitHub repositories, served by
the public DeepWiki MCP server (`https://mcp.deepwiki.com/mcp`).

## Try it

```text
facebook/react 的源码是怎么组织的？重点讲 reconciler 和调度。
```

Expected result: the Agent reads the repository's wiki structure and asks the
wiki a focused question, then answers with repository-level explanation and
names the repository it came from.

## What it does

This Plugin ships one MCP connection and one Skill:

- `deepwiki` MCP server - the official public DeepWiki endpoint
  `https://mcp.deepwiki.com/mcp`, which exposes `read_wiki_structure`,
  `read_wiki_contents` and `ask_wiki_question`.
- `deepwiki` Skill - the read-then-ask workflow, plus what to do when a call
  fails or the server is not connected.

## Requirements

- Internet access to `mcp.deepwiki.com`.
- No API key, no account, no local runtime, no extra executable.

## Authentication

None, on purpose. The public endpoint rejects every request that carries an
`Authorization` header, so this Plugin ships no credentials and no header. Never
add a key to this server - the endpoint answers with "Authentication is not
allowed on the public DeepWiki endpoint".

Private repositories, wiki generation (`generate_wiki`), `list_wiki_repos` and the
organization-wide `devin_*` tools are **not** available here.

## Relationship to the devin plugin

The `devin` plugin connects to `https://mcp.devin.ai/mcp`, which serves the same
wiki tools **plus** private repositories, wiki generation and the `devin_*`
organization tools. It therefore **supersedes this plugin**:

- Install `devin` when you need private repositories, generated wikis or
  organization tools - it also handles public repositories.
- If both plugins are installed, **disable or remove `deepwiki`**. The tool names
  collide (`read_wiki_structure`, `read_wiki_contents`, `ask_wiki_question`),
  which makes tool selection ambiguous, and the public endpoint can never
  authenticate, so it adds no capability next to `devin`.

## Data and network

- `mcp.deepwiki.com` - the public DeepWiki MCP server. A call sends the
  repository name (and, for questions, the question text); DeepWiki returns the
  wiki content. No credential is sent.
- No telemetry from this Plugin, no analytics, and no shipped credentials.

## Limitations

- Only repositories that DeepWiki has indexed can be read; for others the tool
  reports that no wiki exists.
- Verify specifics (signatures, options, versions) against the actual source.

## License

Apache-2.0. See [LICENSE](LICENSE).
