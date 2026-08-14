# github-explore

GitHub search, discovery, summarization and audit through the **gh CLI**,
backed by 10 zero-config Python scripts with relevance ranking, smart
deduplication and quota-aware searching.

## The problem

Finding the right repositories on GitHub is noisy: broad searches drown in
high-star general-purpose repos, awesome-list directories mix with real
projects, and search quotas are easy to blow. github-explore packages a
proven discovery workflow — dual-scope semantic search, topic mining,
multi-axis field mapping with signal flags (canonical / awesome / list),
trending, similar projects, code/issue search and org audits — so an agent
can answer "what exists and what matters" in one skill.

## Try it

Install from `/plugins` → **Local**, then ask:

```text
find repos about vector databases written in Python
```

**Expected result**: a ranked, deduplicated list of repositories with
relevance scores, filtered of forks/archived/awesome-list noise, plus a
layered markdown summary (or `--format json` for pipelines).

Other examples:

```text
what's trending in LLM topics this month
give me an overview of langchain-ai/langchain
find projects similar to vercel/next.js
audit the vercel org by language
```

## Requirements

- Python 3.10+ (scripts are zero-dependency stdlib-only)
- [gh CLI](https://cli.github.com/) 2.x, authenticated (`gh auth login`)
- Network access to api.github.com

## Data and network

- Scripts call the GitHub API through your **own authenticated gh CLI**;
  quota limits apply (search ~30/min, core ~5000/hr) and the scripts are
  built to stay within them (`--max-workers 2` default, retry on 403/429).
- No credentials are stored by this plugin; it reuses the gh CLI's existing
  authentication.
- No telemetry, no third-party services.

## License

MIT
