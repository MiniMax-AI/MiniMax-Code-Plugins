# web-research

End-to-end web research for MiniMax Code: search the web via Tavily (keyless, no API key required) and fetch each URL with a free-first cascade — **defuddle → Tavily `/extract` → mcode in-app browser**. One Skill, one Python entry point, no bash required.

## The problem it solves

Research inside an agent usually means three separate tool calls, three failure modes, and a manual paste-into-context step. This plugin collapses the whole flow into a single Skill invocation that the agent runs end-to-end and then summarises.

## Try it

After installing the plugin, ask the agent:

> 调研一下向量数据库的最新进展，5 篇文章，输出到 ./research-output

**Expected result**: a directory `./research-output/` containing `01-…md` through `05-…md`, each with a one-line tag (`[defuddle]` / `[tavily extract]` / `[browser required]`) on stderr. The agent then summarises the files in chat. Direct invocation:

```bash
python3 skills/web-research/scripts/research.py "向量数据库 最新进展" 5 ./research-output
```

Single-URL form:

> fetch https://example.com/article and summarise

The agent uses the cascade directly. If defuddle is missing or fails, it transparently falls back to Tavily `/extract`; if both fail, the agent re-fetches with the mcode in-app browser tool.

## Dependencies and supported platforms

| Component | Required | How to get it |
| --- | --- | --- |
| Python 3.8+ | yes | system / `pyenv` / `conda` |
| Network access to `https://api.tavily.com` | yes | outbound HTTPS |
| `TAVILY_API_KEY` env var | **no** | optional — only for higher rate limits |
| `defuddle` CLI (`npm i -g defuddle`) | **no but recommended** | fallback layer 2 (Tavily `/extract`) works without it |
| `mcode` in-app browser tool | **no but recommended** | fallback layer 3 — built into MiniMax Code |
| `bash` | **no** | the pipeline is pure Python; no shell required |

Tested on Windows (Python 3.13, Node 22, no bash required), macOS 13+, and Linux (Python 3.11+).

**The plugin never installs any of these for you.** It only checks for `defuddle` with `command -v defuddle` and prints a one-time notice to stderr if the binary is absent.

## Network and data behavior

This plugin talks to three network destinations, in order:

1. **`https://api.tavily.com/search`** (Tavily Search, keyless by default) — sends the user's `query` to Tavily. Tavily then forwards the query to the upstream search engines it is configured with (Google, Bing, etc.). The script never follows HTTP redirects; a 3xx is an error. No telemetry is sent by this script. Authorization: optional `TAVILY_API_KEY` Bearer, or `X-Tavily-Access-Mode: keyless`.
2. **`https://api.tavily.com/extract`** (Tavily Extract, keyless by default) — sends the URL chosen by the user to Tavily for raw-content extraction. Same redirect policy and auth model as above.
3. **The user-provided URL** (via defuddle or mcode browser) — defuddle fetches the page server-side via its own HTTP client; the mcode browser tool navigates the page in the in-app browser panel.

**No third-party telemetry. No silent network calls.** The plugin writes only to:
- The user-specified output directory (default `./research-output`).

**No credentials in the repo.** `TAVILY_API_KEY` is read from the process environment only and is never logged or echoed. There are no native binaries, no symlinks, no installer scripts, and no `~/.mcode*` writes.

**Rate limits.**
- Tavily keyless (`/search` and `/extract`) is free but rate-limited. On 429, the script surfaces Tavily's message and exits that URL with the browser-required marker.
- defuddle has no rate limit; it just times out per the user's network.

**If you bring your own `TAVILY_API_KEY`**, the key is sent **only** to `https://api.tavily.com/*` over HTTPS. It is never sent to defuddle, the browser tool, or any other destination.

## Files

```text
plugins/<owner>/web-research/
├── plugin.json
├── README.md
├── LICENSE
└── skills/
    └── web-research/
        ├── SKILL.md
        └── scripts/
            ├── research.py
            ├── tavily_search.py
            └── tavily_extract.py
```

## Compliance

- No secrets, private endpoints, hidden telemetry, native binaries, or symlinks.
- All third-party network destinations are disclosed above.
- All third-party code is original to this plugin (the Tavily keyless header convention is documented publicly by Tavily).
