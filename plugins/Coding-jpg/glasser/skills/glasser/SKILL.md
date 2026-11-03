---
name: glasser
description: Use for paid data research, company research, SEO, web search or local business data when the task requires a provider that is not already available. Use the official Glasser CLI to discover endpoints and inspect current prices before any approved paid request.
---

# Research with Glasser CLI

This is a CLI-oriented adaptation of the official Glasser plugin for MiniMax
Code. It contains instructions only. It does not bundle an MCP connection,
a server, an installer, or credentials. Official upstream:
https://github.com/glasser-ai/plugins .

## Prerequisites

Use an already installed official Glasser CLI. The official package is
`@glasser-ai/cli` and requires Node.js 22 or newer. Refer to the upstream
setup instructions if it is missing. Do not run installation commands
without the user's authorization. Follow the official documentation at
https://glasser.ai/docs and https://glasser.ai/docs/mcp-server for product
behavior. Do not assume MiniMax Code supports generic OAuth MCP setup.

## Workflow

1. Confirm the user's question, target and scope. If an existing tool already
   provides the needed capability, use it first.
2. Check authentication with `glasser balance`. If the CLI reports missing
   or rejected authentication, use the documented `glasser login` flow with
   the user. Never request a key in chat or commit it to a file.
3. Discover endpoints: `glasser search -q "<research capability>"`.
4. Inspect a candidate: `glasser inspect -p <provider> -e <endpoint>`.
   Read its inputs, current price and outcome-specific charge conditions.
5. Present the proposed request and price and obtain approval before any paid
   execution. Use the CLI's own help and the inspected schema for the exact
   run syntax; do not invent options. Start with small input scope.
6. Report the actual outcome, provider, charge and limitations. Follow the
   documented run status handling for the selected endpoint. Do not perform
   speculative paid retries, bulk runs or scope expansion.

## Example

Ask: "Find a suitable endpoint for competitor keyword research for the domain
and market I provide. Show the schema and price first. Do not execute a paid
request until I approve it."

Expected result before approval: endpoint candidates, an inspected input
contract and a proposed small request with current pricing. No paid data
request should run merely to demonstrate that the Skill is loaded.

## Data and billing

Authenticated data requests go to Glasser and its selected provider. The
MiniMax host may process prompts and returned data under its own policies.
Use only task-appropriate authorized data. The plugin is MIT-licensed;
Glasser's service is separately metered. Empty and failed outcomes follow
the selected endpoint's charge terms, not a blanket free-call promise.

Support: support@glasser.ai
Privacy: https://glasser.ai/privacy-policy
Service terms: https://glasser.ai/terms-of-service
