---
name: 1toolring-tools
description: Discover, price and run pay-per-call third-party tools through 1ToolRing.
---

# 1ToolRing tools

Use this skill when the request needs live data instead of a guess: web search results, places and maps, product or supplier prices, stock/crypto/FX quotes, page scraping, jobs, weather, images, or AI media generation.

## Tools exposed by the `1toolring` MCP server

| Tool | Cost | Use it for |
|-|-|-|
| `discover_tools` | free | Search the catalog with a short intent such as `search`, `price`, `crypto`, `weather`, `places`. |
| `inspect_tool` | free | Read a tool's input schema and the exact price of the next call. |
| `run_tool` | paid | Execute the tool with arguments that match the schema. |
| `get_tool_run` | free | Re-read a run by id when a call is slow or you need the payload again. |

## Working rules

1. Always `discover_tools` first, then `inspect_tool` on the candidate before spending.
2. State the price from `inspect_tool` when a run is not trivial, and pick the cheaper tool when the user only needs the headline value.
3. Match the schema exactly; a rejected call wastes a round trip.
4. Never invent numbers. If the run returns nothing usable, say so plainly.
5. Balance and top-ups live at https://1toolring.com/pricing. A depleted balance is returned as an API error rather than an empty result.
