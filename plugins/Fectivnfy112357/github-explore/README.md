# github-explore

GitHub search, discovery, summarization and audit through the **gh CLI**,
backed by 9 zero-config Python scripts with relevance ranking, smart
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

## Capabilities & permissions

- **Read-only discovery (default).** The 9 entry-point Python scripts
  (`find_repos` / `discover` / `explore` / `trending` / `repo_summary` /
  `find_similar` / `code_search` / `search_issues` / `org_landscape`) only
  read GitHub data. They never create, modify or delete anything.
- **Opt-in write management (requires confirmation).** The skill can also
  drive `gh` management commands — create/update/delete/dispatch across
  repos, issues, PRs, workflows, secrets/variables, releases, org labels,
  gists, codespaces and SSH/GPG keys. Before any write command runs, the
  agent must state the exact **target**, the **impact** (including whether
  it is reversible), the **minimal data** it will change, and obtain your
  **explicit confirmation**. Read-only discovery is always the default.
- **Authentication diagnostics** use `gh auth status` only. The skill never
  prints tokens: `gh auth token` and `gh auth status --show-token` are not
  used, and `GH_TOKEN` must never be echoed.

## Data and network

- All API access goes through your **own authenticated gh CLI**
  (api.github.com REST, search and GraphQL; `git` remotes only for
  clone/fork operations). Quota limits apply (search ~30/min, core
  ~5000/hr) and the scripts stay within them (`--max-workers 2` default,
  retry on 403/429).
- **Permission scope** = whatever scopes your gh token already has; the
  plugin requests none and stores none.
- **Remote side effects** are limited to the opt-in write commands above;
  discovery scripts cause no remote changes.
- **Data flow**: queries and their results pass between your machine and
  api.github.com via the gh CLI. Markdown reports may be written to a local
  temp file (override with `--output`). No credentials are stored by this
  plugin; error output is redacted for credential patterns; no telemetry,
  no third-party services.

## Security model

- Default read-only; write operations require target / impact / minimal
  data disclosure and explicit user confirmation before execution.
- Token-displaying commands are removed; authentication diagnostics only
  use `gh auth status`; error paths redact credential-shaped output.

## License

MIT
