# API Indonesia

Official Indonesian public data through one MCP server: administrative regions down to villages and postal codes, region boundaries, public holidays and joint leave days, prayer times, Hijri dates, schools, universities, hospitals, BMKG earthquakes, weather, air quality, Bank Indonesia exchange rates, provincial minimum wage, NIK and NPWP format checks, QRIS parsing, rupiah formatting, halal (BPJPH), BPOM, DJKI trademarks, OJK lists, food prices, Transjakarta, KBBI, Al-Quran and Alkitab.

## What you need

- An API Indonesia account and API key from https://dashboard.apiindonesia.id/register (3,000 free credits on sign-up, no card).
- MiniMax Code with this Plugin installed.

## MCP server

| | |
|-|-|
| Endpoint | `https://mcp.apiindonesia.id/mcp` (Streamable HTTP, 84 tools) |
| Auth | `Authorization: Bearer aip_live_...` |
| Pricing | 2 credits per successful request, failed requests are not billed |
| Docs | https://docs.apiindonesia.id |

The Plugin ships the server definition in `mcp.json` and a Skill that explains how to pick the right tool and how to report missing records. The API key is not stored in this package: fill it into the server headers in your client's MCP settings. A REST API with the same data is available at `https://use.apiindonesia.id` using the `x-api-key` header.

## Example prompts

- "Which villages are in Kecamatan Pontianak Kota, with postal codes?"
- "Is 17 August 2027 a public holiday in Indonesia, and is there joint leave around it?"
- "Show BMKG earthquakes above magnitude 5 in the last 24 hours."
- "What is the minimum wage in West Kalimantan this year?"

## Network, data and side effects

- Every tool call goes over HTTPS to `https://mcp.apiindonesia.id/mcp`.
- Data sent: the arguments you pass (for example a region code or a date).
- No local file writes, no command execution, no telemetry from this package.

## Licence and provenance

Plugin wrapper by Khaisa Studio (Khairul Muhtadin), MIT licensed. The hosted service is operated by Khaisa Studio and serves data from official Indonesian sources. Source and examples: https://github.com/khmuhtadin/api-indonesia-examples.
