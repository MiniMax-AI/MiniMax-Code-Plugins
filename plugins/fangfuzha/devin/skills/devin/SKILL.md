---
name: devin
description: Use when the user needs the Devin MCP server - private repository documentation, generating a repository wiki, listing the repositories DeepWiki has indexed, or running the organization-wide devin_* tools (sessions, automations, code scans, billing tags, integrations). Also use when a Devin tool call fails with an authentication, 401, or missing-organization error.
---

# Devin MCP

The Devin MCP server (`https://mcp.devin.ai/mcp`) covers everything the public
DeepWiki endpoint does not: private repositories, wiki generation and the
organization-wide `devin_*` tools.

## Tools

Wiki tools (same names as the public DeepWiki server):

| Tool | Purpose |
|---|---|
| `read_wiki_structure` | List the documentation topics of a repository. |
| `read_wiki_contents` | Read the repository documentation (optionally one page). |
| `ask_wiki_question` | Ask a question about the repository. |
| `list_wiki_repos` | List the repositories that have a DeepWiki index. |
| `generate_wiki` | Generate a codebase wiki. **Only when the user explicitly asks for it.** |

Organization tools (`devin_*`): sessions, automations, code scans, billing tags,
campaigns, playbooks, integrations, knowledge, MCP server management and more.
Tool names come from the server; trust the names in the tool list.

## Workflow

1. Pick the tool by intent: `read_wiki_structure` to see the topics,
   `ask_wiki_question` for a specific question, `read_wiki_contents` for the
   documentation itself, `list_wiki_repos` to find indexed repositories,
   `generate_wiki` only on an explicit request.
2. For a `devin_*` tool, make sure the target organization is the intended one.
3. Report the organization you acted in when the result depends on it.

## Authentication

This server has **no usable OAuth flow** - its authorization server publishes no
dynamic client registration endpoint, so no browser login can complete. It
authenticates with a **Devin API key**, sent as `Authorization: Bearer <key>`.

1. Open the MiniMax Code MCP settings and check the `devin` entry status and
   error text.
2. If the key is missing or wrong, ask the user to set `DEEVIN_API_KEY` in the
   environment MiniMax Code runs in, then reconnect the MCP service. The key
   comes from https://app.devin.ai/settings/api-keys. Never ask them to paste a
   key into the chat.
3. If the environment route is not available, ask the user to add the server in
   the global MCP settings with the header `Authorization: Bearer <key>` and the
   URL `https://mcp.devin.ai/mcp`.
4. An invalid key is only rejected when a tool is called, so a connected server
   can still fail at call time - read the tool error before assuming the key is
   fine.

## Organization

`DEEVIN_ORG_ID` (sent as `X-Org-Id`) selects the Devin organization the
organization-scoped tools act in. Without it the server resolves the first
organization the key belongs to, and one request targets a single organization.
A wrong or missing organization surfaces as "requires an organization-scoped API
context, but no org_id could be resolved" or as a "not found" result - treat both
as an organization problem first.

## Relationship to the deepwiki plugin

This plugin **supersedes** the `deepwiki` plugin: it serves the same wiki tools
for public repositories and adds private repositories, wiki generation and the
organization tools.

- If both plugins are installed, **disable or remove `deepwiki`**. The tool
  names collide (`read_wiki_structure`, `read_wiki_contents`,
  `ask_wiki_question`), which makes tool selection ambiguous, and the public
  endpoint rejects every `Authorization` header, so `deepwiki` adds no
  capability next to this plugin.
- Never point a single server entry at both endpoints: the public DeepWiki
  endpoint rejects any request that carries an `Authorization` header, so the
  two must stay separate servers.

## Notes

- Public repositories can be served by this plugin alone; the separate
  `deepwiki` plugin is only needed when no API key is available.
- Verify specifics (signatures, options, versions) against the actual source.
