# MCP Server Patterns

## The problem

Teams adopting MCP (Model Context Protocol) servers keep hitting the same failure classes:
duplicated servers that re-wrap capability the host already has, tools with unclear read/write
boundaries, missing auth documentation, and debugging sessions that cannot tell transport
failure from application failure. The knowledge to prevent this exists, but it is rarely written
down where the agent can use it at decision time.

This Plugin installs one reference Skill: checklists and questions for evaluating, designing,
integrating, and debugging MCP servers. It is guidance only — it never changes MCP settings.

## Try it

```text
Use the mcp-server-patterns skill and evaluate whether adding a GitHub MCP server makes sense
for this project.
```

Expected result: the agent walks the evaluation questions (does it beat direct tools, read-only
or mutating, auth model, what data leaves the machine, overlap with existing servers), states a
recommendation, and names the failure modes to expect.

## What the Skill does

- Evaluation: seven questions covering problem fit, read/write boundary, authentication, data
  egress, failure modes, discoverability, and overlap with existing tools.
- Design checklist: tool boundaries, stable schemas, good errors, minimal secrets, predictable
  latency, explicit read-vs-write behavior, safe defaults, side-effect ownership.
- Integration checklist: avoid duplicate coverage, lightest tool wins, document auth and
  environment, global vs project-local placement, default vs specialist workflow fit.
- Debugging checklist: confirm enabled, confirm credentials, minimal reproduction call,
  distinguish transport from application failure, check native-tool alternatives, and classify
  server-side vs auth vs client-routing failures.

## Requirements

- None. This is a knowledge Skill with no scripts and no MCP server of its own.

## Data and network

- No network access.
- No credentials required.
- Guidance only; it does not modify MCP configuration files.

## License

Apache-2.0. See [LICENSE](LICENSE).
