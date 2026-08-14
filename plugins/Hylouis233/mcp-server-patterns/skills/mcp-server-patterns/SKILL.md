---
name: mcp-server-patterns
description: Reference patterns for designing, evaluating, integrating, and debugging MCP servers. Use this Skill whenever the task involves deciding whether to add an MCP server, reviewing a server design, integrating one into a workflow, or diagnosing why one fails.
---

# MCP Server Patterns

Use this skill when evaluating, designing, or integrating MCP servers.

## Scope

This skill is for guidance and design review only. Do not change MCP settings, install or invoke
servers, rewrite configuration, authenticate to services, or send test requests. If the user asks
for implementation, provide a proposed plan or copyable steps and ask them to perform or authorize
the execution outside this Skill.

## Evaluate an MCP server with these questions

1. What problem does it solve better than direct tools or local agents?
2. Is it read-only, mutating, or both?
3. Who publishes the package or operates the endpoint, how is its identity verified, and is the
   selected version or endpoint authentic and trustworthy?
4. What authentication model does it require, and are the requested authorization scopes the
   least privilege needed for the advertised tools?
5. What data leaves the local machine?
6. What are the failure modes and retry expectations?
7. How will users discover and safely invoke it?
8. Does it overlap with MCP servers or native tools already present in the environment?

## Design checklist

- Clear tool boundaries.
- Stable input/output schemas.
- Good error messages.
- Minimal required secrets and least-privilege authorization scopes.
- Predictable latency.
- Explicit read vs write behavior.
- Safe defaults.
- Clear ownership of side effects.

## Integration checklist

- Avoid duplicating existing MCP coverage.
- Prefer the lightest tool that solves the task.
- Verify publisher/operator provenance, package or endpoint authenticity, version integrity, and
  ownership before recommending adoption.
- Document auth and environment requirements, including least-privilege scopes.
- Verify whether the server should be global or project-local.
- Decide whether it belongs in default workflows or specialist workflows only.
- Define when native agent tools are still preferable.

## Debugging checklist

- Ask the user to confirm whether the server is enabled; do not inspect or modify live settings.
- Ask the user to confirm that each required credential variable name is available to the actual
  server process environment (not merely the interactive shell); never request or expose values.
- Design the smallest possible reproduction request and identify its data and side effects, but do
  not execute it. Prefer a read-only operation against a sandbox or disposable test resource. If
  mutation is unavoidable, clearly warn about the exact side effect and require explicit user
  confirmation before asking them to run it and share a redacted result.
- Use the redacted result to distinguish application failures from transport failures such as
  process startup, DNS/TLS, connection, or protocol negotiation.
- Check whether a native tool already solves the same problem better.
- Classify the failure as transport, server/application, authentication/authorization, or client
  routing; retain the relevant transport subcategory when applicable.

## Good usage pattern

- Use MCP when it gives unique external access or structured remote capabilities.
- Do not add MCP just to wrap a local command that native tools already cover well.
- Prefer specialist or project-local MCP servers only when the default toolchain cannot
  provide the same value cleanly.

## Notes

- This is a knowledge skill only.
- It must not change hooks, settings, plugin state, or MCP configuration files.
- It must not invoke MCP servers, make network requests, authenticate, or handle credential values.
