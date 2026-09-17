---
name: searxng-search
description: "Search the web using a self-hosted SearXNG instance. Use when users ask to search with SearXNG, or when web search is needed and a SearXNG instance is configured. Supports categories, engines, time range, and language filters."
license: MIT
allowed-tools:
  - Bash(python3 scripts/*)
---

# SearXNG Search Skill

Search the web using a SearXNG instance via its API.

## Network destinations

Two levels — both matter:

- **Direct (this script):** the script makes a single request to your
  configured `base_url`. HTTPS by default; plain HTTP is allowed only
  for loopback hosts (127.0.0.1, ::1, localhost) or for non-loopback
  hosts if the config contains `allow_insecure_http = true` (with a
  warning). If `auth.type` is set, the Authorization header travels to
  that single host and nowhere else. **Redirects are never followed**: a
  30x response is an error, because following a redirect could forward
  the Authorization header to a host you did not configure. Point
  `base_url` directly at the final endpoint (or front the instance
  with a same-origin reverse proxy).
- **Downstream (your SearXNG instance):** the instance then forwards
  the **query**, **language**, and **categories** to the engines it
  itself has been configured with (Google, Bing, DuckDuckGo, Brave,
  Baidu, etc., as enabled by the instance operator). This skill does
  not control that hop — it is a property of any SearXNG client. If
  query contents reaching the upstream engines is a concern, configure
  your instance to use engines you trust, or self-host engines locally.

## Configuration issues

This skill depends on a local SearXNG config file. Keep setup details out of this
file and load [references/configuration.md](references/configuration.md) only when needed.

If `scripts/search.py` reports configuration, auth, or instance setup errors,
read [references/configuration.md](references/configuration.md) before retrying. Common examples include:

- `ERROR: Config file not found`
- `ERROR: Invalid TOML ...` / `ERROR: Invalid JSON ...`
- `ERROR: base_url is required`
- `ERROR: Environment variable ... is not set`
- `ERROR: auth.token required for bearer auth`
- `ERROR: auth.user and auth.pass required for basic auth`
- `ERROR: Unknown auth.type ...`
- `ERROR: HTTP 401` / `ERROR: HTTP 403`

## Usage

Run the search script:

```bash
python3 scripts/search.py [OPTIONS] <query>
```

### Options

| Flag | Description |
|---|---|
| `-c, --categories` | Comma-separated categories (`general`, `news`, `images`, `videos`, `music`, `files`, `it`, `science`, `social media`) |
| `-e, --engines` | Comma-separated engines (`google`, `duckduckgo`, `bing`, etc.) |
| `-l, --language` | Language code (`en`, `zh-CN`, `ja`, etc.) |
| `-p, --page` | Page number (default: 1) |
| `-t, --time-range` | Time range: `day`, `month`, `year` |
| `-n, --max-results` | Max results to show (overrides config default) |
| `-s, --safesearch` | Safe search: `0` (off), `1` (moderate), `2` (strict) |

### Examples

```bash
# Basic search
python3 scripts/search.py "SearXNG documentation"

# Search news from the last day
python3 scripts/search.py -c news -t day "latest tech news"

# Search with specific engines, page 2
python3 scripts/search.py -e google,duckduckgo -p 2 "rust programming"

# Search in Chinese with more results
python3 scripts/search.py -l zh-CN -n 10 "开源搜索引擎"
```

## Best Practices

- **Technical topics** (programming, software, science, IT, etc.): Always use **English** as both the query language and search language (`-l en`), regardless of the user's input language. Translate the query to English if needed. English results are more comprehensive and up-to-date for technical content.
- **Chinese lifestyle topics** (food, travel, shopping, local services, social trends, etc.): In addition to the default search, run a **second search** with `-e baidu,sogou -l zh-CN` using a Chinese query to capture China-specific results. Merge and deduplicate results before presenting to the user.

## Workflow

1. User asks to search for something
2. Determine the topic type:
   - **Technical**: translate query to English if needed, search with `-l en`
   - **Chinese lifestyle**: run the default search first, then an additional search with `-e baidu,sogou -l zh-CN`
3. Run `scripts/search.py` with the query and any relevant filters
4. Present results to the user in a readable format
5. If user wants more results, use `-p` for pagination or `-n` for more per page
