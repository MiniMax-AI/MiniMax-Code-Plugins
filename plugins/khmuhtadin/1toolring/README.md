# 1ToolRing

Pay-per-call access to thousands of tools from third-party providers through one 1ToolRing key: web search, maps and places, shopping and prices, market data (stocks, crypto, FX), web pages, images, weather, jobs and more. The price is shown before every call and failed calls are never charged. There is no subscription: you top up a prepaid balance and spend it per call.

## What you need

- A 1ToolRing account and API key from https://app.1toolring.com/keys (free sign-up, starter balance after email verification).
- MiniMax Code with this Plugin installed.

## MCP server

| | |
|-|-|
| Endpoint | `https://mcp.1toolring.com/mcp` (Streamable HTTP) |
| Auth | `Authorization: Bearer <your 1ToolRing API key>` |
| Tools | `discover_tools` (free), `inspect_tool` (free), `run_tool` (paid), `get_tool_run` (free) |
| Docs | https://docs.1toolring.com/overview/ |

The Plugin ships the server definition in `mcp.json` and a Skill that teaches the model the discover, inspect, run order. The API key is not stored in this package: fill it into the server headers in your client's MCP settings.

## Example prompts

- "Find a supplier price for a Raspberry Pi 5 and show the cheapest three options."
- "What is the weather in Pontianak tomorrow at 09:00?"
- "Search the web for the latest GLM release notes and summarise the changes."

## Network, data and side effects

- Every tool call goes over HTTPS to `https://mcp.1toolring.com/mcp`.
- Data sent: the arguments you pass to the tool (for example a search query or a URL to scrape).
- Paid calls debit your prepaid balance; the price is returned by `inspect_tool` before you spend.
- No local file writes, no command execution, no telemetry from this package.

## Licence and provenance

Plugin wrapper by Khaisa Studio (Khairul Muhtadin), MIT licensed. The hosted service is operated by Khaisa Studio. Source and examples: https://github.com/khmuhtadin/1toolring-mcp.
