---
name: deepwiki
description: Use when the user asks how a public GitHub repository works, wants an overview or architecture of an unfamiliar codebase, or asks a question about a specific repository's code; also use when a DeepWiki tool call fails with an authentication/401 error or the server is not connected.
---

# DeepWiki

AI-generated documentation and Q&A about **public** GitHub repositories. Use it for
repository-level understanding.

## Tools

| Tool | Purpose |
|---|---|
| `read_wiki_structure` | List the documentation topics of a repository. Start here. |
| `read_wiki_contents` | Read the repository documentation (optionally one page). |
| `ask_wiki_question` | Ask a question about the repository, get an AI-powered answer. |

Tool names come from the server; trust the names in the tool list.

## Workflow

1. `read_wiki_structure` with `owner/repo` (for example `facebook/react`).
2. `read_wiki_contents` for the documentation itself or one page;
   `ask_wiki_question` for a specific question - usually the better first move.
3. Answer from the wiki and name the repository it came from.

## Scope and limitations

- Public repositories only, and **no authentication**: the public endpoint rejects
  every request that carries an `Authorization` header ("Authentication is not
  allowed on the public DeepWiki endpoint"). Never add credentials to it.
- Private repositories, `generate_wiki`, `list_wiki_repos` and the organization
  tools (`devin_*`) are **not** available here - they live on the Devin MCP
  endpoint, which the separate `devin` plugin covers.
- The `devin` plugin supersedes this one: it serves the same wiki tools for
  public repositories plus everything this endpoint cannot do. When both plugins
  are installed, disable or remove this plugin - the tool names collide and the
  public entry can never authenticate.
- If the wiki is missing for a repository, the tool says so - do not invent
  documentation, read the code instead.
- Verify specifics (signatures, options, versions) against the actual source.

## Troubleshooting

- Open the MiniMax Code MCP settings and check the `deepwiki` entry status and
  error text.
- A `401` or "Authentication is not allowed" message means an `Authorization`
  header was sent - the server needs none; check that no credential is configured
  for this plugin.
- The server being unreachable is a network or proxy problem, not a credential
  problem.
