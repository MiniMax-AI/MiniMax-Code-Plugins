# searxng-search

Search the web through **your own self-hosted SearXNG instance** with a
zero-dependency Python script: categories, engines, time range, language and
safe-search filters, plus bearer/basic auth and TOML or JSON config.

## The problem

Web search inside an agent usually means a vendor API with credentials and
quotas. If you already run SearXNG (a privacy-respecting metasearch engine),
this skill gives the agent a first-class search tool against it — one config
file, no vendor SDK, no tracking.

## Try it

Install from `/plugins` → **Local**, configure your instance, then ask:

```text
search the web for the latest SearXNG documentation
```

**Expected result**: a formatted list of results (title, URL, snippet) from
your SearXNG instance, filtered by the requested category / time range /
language.

Direct usage:

```text
python3 scripts/search.py -c news -t day "latest tech news"
python3 scripts/search.py -e google,duckduckgo -p 2 "rust programming"
python3 scripts/search.py -l zh-CN -n 10 "开源搜索引擎"
```

## Requirements

- A **self-hosted SearXNG instance** reachable over HTTP(S) — you provide it;
  no public instance is bundled.
- Python 3.11+ (TOML config; legacy JSON config works on older Python).
- A config file at `~/.config/agents/searxng.toml` (or `$XDG_CONFIG_HOME`);
  see `skills/searxng-search/references/configuration.md` for all fields.

## Data and network

- The script talks **only to your configured SearXNG instance** (the
  `base_url` in your config). No other network destinations.
- Credentials for your instance (bearer token / basic auth, if any) live in
  your local config file; they are never sent anywhere else.
- No telemetry, no third-party services.

## License

MIT
