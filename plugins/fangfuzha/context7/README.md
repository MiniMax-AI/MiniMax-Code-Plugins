# Context7

Current, version-accurate documentation for libraries, frameworks, SDKs and cloud
services, served by the Context7 MCP server.

## Try it

```text
Next.js 15 的 middleware 里怎么读 cookie？
```

```text
React 19 的 `use` hook 现在稳定了吗？官方迁移说明是什么？
```

Expected result: the Agent resolves the library through Context7, queries the
focused question, and answers from the returned documentation instead of from
memory. Version-specific behavior and setup steps come from the docs, and the
Agent says so when the docs do not cover a question.

## What it does

This Plugin ships one MCP connection and one Skill:

- `context7` MCP server — the official Context7 endpoint
  `https://mcp.context7.com/mcp/oauth`, which exposes `resolve-library-id` and
  `query-docs`.
- `context7` Skill — the resolution and query workflow, plus what to do when a
  call fails with `401 Unauthorized`.

## Requirements

- Internet access to `mcp.context7.com`.
- A free Context7 account for the OAuth sign-in. The endpoint answers every
  unauthenticated request with `401 Unauthorized` and points the client at the
  protected-resource metadata, so the runtime has to complete an OAuth 2.1
  authorization-code flow (PKCE) once.
- No API key, no local runtime, no extra executable.

## Authentication

The Plugin contains no credentials. The MCP entry has no `Authorization` header
on purpose, so the client performs the OAuth flow instead of treating the server
as already authenticated.

1. Open the MiniMax Code MCP settings, find the `context7` entry and start the
   authorization action.
2. Sign in to Context7 in the browser that opens.
3. Reconnect the service and retry the call.

If the client does not offer an authorization action for a plugin-provided
server, add the server yourself in the global MCP settings with the URL
`https://mcp.context7.com/mcp/oauth` and complete the browser login there.
Never paste a token into a chat.

## Data and network

- `mcp.context7.com` — the Context7 MCP server. A query sends the library name
  or library ID and the question text; Context7 returns documentation content.
- `context7.com` — the OAuth sign-in page opened during authorization.
- No telemetry from this Plugin, no analytics, and no shipped credentials.

## License

Apache-2.0. See [LICENSE](LICENSE).
