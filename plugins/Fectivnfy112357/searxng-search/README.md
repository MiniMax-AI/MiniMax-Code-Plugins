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

This skill has **two levels of network destinations**; the difference matters.

### Direct destination (the script itself)

The script makes a single HTTPS (or loopback HTTP) request to **your
configured SearXNG instance** — the `base_url` in your config. The
script does not contact any other host.

### Downstream destinations (the SearXNG instance, not the script)

Your SearXNG instance then forwards the **query string**, **language
code**, and **selected categories** to the upstream **engines** it has
been configured with (Google, Bing, DuckDuckGo, Brave, Baidu, etc., as
enabled by the instance operator). Those engines receive the request
content from your instance — the script does not see or control that
hop.

**Practical implication:** anything you put in the search query
(personal context, project names, internal jargon) reaches the engines
your instance is configured to use. This is true of any SearXNG client,
not something this skill introduces. If that is a concern, configure
your instance to use only engines you trust, or self-host engines
locally.

### Credentials and config

- Credentials for your instance (bearer token / basic auth, if any) live
  in your local config file. They are sent only to your instance — the
  script never sends them anywhere else.
- Use `$ENV_VAR` references in the config instead of writing tokens in
  plaintext, and `chmod 600` the file on POSIX systems. See
  `skills/searxng-search/references/configuration.md`.
- No telemetry, no third-party services run by this script.

## License

MIT
