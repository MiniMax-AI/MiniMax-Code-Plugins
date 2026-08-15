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
- Network access to your GitHub host — default `api.github.com`; `GH_HOST` redirects it (e.g. GitHub Enterprise Server, see "Data and network"; `--hostname` only exists on a few subcommands, not globally)

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
- **`GH_HOST` changes the network destination.** It applies to all
  `gh` subcommands (git-only operations still respect `git remote`,
  not `GH_HOST`). The default is `github.com`; if `GH_HOST=github.acme.com`
  is set (GHES on-prem) or `GH_HOST=acme.ghe.com` (GHEC tenancy), API
  calls / search / GraphQL go there instead. `--hostname` is **not a
  global flag** — it only exists on 11 subcommands (`gh auth *`,
  `gh api`, `gh attestation *`); use `GH_HOST=... gh <cmd>` as the
  universal pattern.
- **Credentials are per-host.** The `hosts.yml` store and keyring
  (`gh:<host>:<user>` namespace) key by host, so a PAT issued for one
  host will not authenticate to another (unless injected via env var —
  see next bullet).
- **Env var overrides follow a stricter rule:** `GH_TOKEN` /
  `GITHUB_TOKEN` are read only for `github.com` / `*.ghe.com` /
  `github.localhost`; GHES on-prem requires `GH_ENTERPRISE_TOKEN` /
  `GITHUB_ENTERPRISE_TOKEN`. Set `GH_TOKEN` on a GHES host and `gh`
  will silently fall back to `hosts.yml`, not your env var.
- **The skill does not validate, restrict or warn about `GH_HOST`**:
  you are responsible for confirming the target before any write
  command runs. Cross-host mistakes are equivalent to cross-credential
  leaks (issue on the wrong org, PR on the wrong repo, workflow
  triggered with the wrong token).
- **Permission scope** = whatever scopes your gh token already has; the
  plugin requests none and stores none.
- **Remote side effects** are limited to the opt-in write commands above;
  discovery scripts cause no remote changes.
- **Data flow**: queries and their results pass between your machine and
  the configured GitHub host via the gh CLI. Markdown reports may be
  written to a local temp file (override with `--output`). No credentials
  are stored by this plugin; error output is redacted for credential
  patterns (see "Error redaction" below); no telemetry, no third-party
  services.

## Error redaction (honest scope)

The 9 discovery scripts pipe `gh` errors through `_lib.redact_secrets()`,
so credential-shaped strings (`ghp_*`, `github_pat_*`, `Bearer *`,
`token=*`, `GH_TOKEN=*`, `GITHUB_TOKEN=*`) are masked before you see them.

The agent does **not** run the 9 scripts for every `gh` call — for
ad-hoc management commands it invokes `gh` directly via the Bash tool,
and that stderr is **not** auto-redacted. Before sharing such output,
pipe it through the redactor:

```bash
gh <cmd> 2>&1 | python scripts/redact_stderr.py
```

`redact_stderr.py` reuses the same regex set. Redaction is best-effort:
non-standard secret shapes can still slip through, so always scan the
output before pasting into a transcript.

## Security model

- Default read-only; write operations require target / impact / minimal
  data disclosure and explicit user confirmation before execution.
- Token-displaying commands are removed; authentication diagnostics only
  use `gh auth status`; error paths redact credential-shaped output.

## License

MIT
