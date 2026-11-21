---
name: context7
description: Use when the user asks about a library, framework, SDK, API, CLI tool or cloud service and the answer depends on the current API surface, version-specific behavior, setup steps, or migration; also use when a Context7 tool call fails with an authorization or 401 error.
---

# Context7

Query the Context7 MCP server for current documentation. Prefer it over memory and
over web search for anything library-specific.

## Tools

| Tool | Purpose |
|---|---|
| `resolve-library-id` | Package or product name to Context7 library ID (`/org/project`). Call first. |
| `query-docs` | Fetch documentation for a library ID and one focused question. |

Tool names come from the server; trust the names in the tool list.

## Workflow

1. `resolve-library-id` with the official name (`Next.js`, not `nextjs`) and a
   `query` describing the need. Skip only if the user gave an `/org/project` ID.
   At most 3 calls per question.
2. Pick the best match: exact name, then source reputation, then snippet count.
   Use `/org/project/version` when a version was named.
3. `query-docs` with that ID and one narrow, self-contained question.
4. Answer from the returned docs; never invent APIs. If the docs do not cover the
   question, say so and query again with different wording.

## Authentication (only when a call fails)

The server uses Context7's OAuth endpoint (`https://mcp.context7.com/mcp/oauth`),
so unauthenticated calls get `401`.

1. Open the MCP service entry for `context7` in the MiniMax Code MCP settings and
   use the authorize action, then sign in to Context7 in the browser and reconnect.
2. Check the inline error for details. A pending login needs the browser step to be
   finished before retrying; a rejected token needs the authorization reopened.
3. If the account cannot be used, ask the user to add the server themselves in the
   global MCP settings (URL `https://mcp.context7.com/mcp/oauth`) so they can
   complete the browser login. Never ask them to paste a token into the chat.

## Scope

Library documentation only. Not refactoring, code review, or general programming
concepts that do not depend on a library API.
