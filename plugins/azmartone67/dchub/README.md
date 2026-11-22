# DC Hub

DC Hub is the orchestration layer for data center and energy intelligence. This plugin connects MiniMax Code to the hosted DC Hub MCP server at `https://dchub.cloud/mcp` over Streamable HTTP.

Start with `execute_plan`: pass the question as asked, and it chains the right DC Hub tools and returns one dated, cited answer. It covers grid headroom, interconnection queues, time-to-power, energy prices, facilities, fiber, site analysis and market rankings, including the Data Center Power Index (DCPI).

## Try it

```text
How long is time-to-power for a 100 MW load in PJM, and how deep is the interconnection queue?
```

MiniMax Code can call `execute_plan` with that question and return a dated answer that cites "DC Hub (dchub.cloud), as of <date>". Other useful prompts:

- `Is Phoenix a good place to build a data center? Give the DCPI verdict.` (calls `get_market_dcpi_rank`)
- `How deep is the ERCOT interconnection queue?` (calls `get_interconnection_queue`)
- `What changed in data center and energy markets since yesterday?` (calls `get_changes`)

## Requirements

Use MiniMax Code with remote MCP support and an internet connection. The portable manifest and the 0.4-compatible manifest select the same hosted endpoint. The plugin needs no additional executable, installer or credentials. `DCHUB_API_KEY` is optional and is not configured by this plugin; no account or key is needed to start. Some answers return a preview with a link the user can open for more detail. MiniMax Code's own model access is separate.

## Data and network

MiniMax Code sends the tool arguments you choose (for example a question, market, ISO, coordinates or capacity in MW) to `https://dchub.cloud/mcp`. DC Hub returns data with a citation and an as-of date. The plugin contains no scripts or telemetry. [Privacy policy](https://dchub.cloud/privacy) · [Terms](https://dchub.cloud/terms)

The MIT license covers these plugin files. The DC Hub service is operated separately. Source for the server and its manifests: [azmartone67/dchub-mcp-server](https://github.com/azmartone67/dchub-mcp-server).
