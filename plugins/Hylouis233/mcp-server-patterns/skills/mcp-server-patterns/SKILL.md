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
3. What authentication model does it require?
4. What data leaves the local machine?
5. What are the failure modes and retry expectations?
6. How will users discover and safely invoke it?
7. Does it overlap with MCP servers or native tools already present in the environment?

## Design checklist

- Clear tool boundaries.
- Stable input/output schemas.
- Good error messages.
- Minimal required secrets.
- Predictable latency.
- Explicit read vs write behavior.
- Safe defaults.
- Clear ownership of side effects.

## Integration checklist

- Avoid duplicating existing MCP coverage.
- Prefer the lightest tool that solves the task.
- Document auth and environment requirements.
- Verify whether the server should be global or project-local.
- Decide whether it belongs in default workflows or specialist workflows only.
- Define when native agent tools are still preferable.

## Debugging checklist

- Ask the user to confirm whether the server is enabled; do not inspect or modify live settings.
- Ask the user to confirm whether required credential variables are set; never request or expose
  their values.
- Design the smallest possible reproduction request, including what data it would send, but do not
  execute it. Ask the user to run it and share a redacted result.
- Use the redacted result to distinguish transport failures from application failures.
- Check whether a native tool already solves the same problem better.
- Confirm whether the failure is server-side, auth-related, or client-routing related.

## Good usage pattern

- Use MCP when it gives unique external access or structured remote capabilities.
- Do not add MCP just to wrap a local command that native tools already cover well.
- Prefer specialist or project-local MCP servers only when the default toolchain cannot
  provide the same value cleanly.

## Notes

- This is a knowledge skill only.
- It must not change hooks, settings, plugin state, or MCP configuration files.
- It must not invoke MCP servers, make network requests, authenticate, or handle credential values.
