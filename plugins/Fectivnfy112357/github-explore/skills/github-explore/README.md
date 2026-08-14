# github-explore

> Discovery + management wrappers around the `gh` CLI for AI coding agents.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-3776ab.svg)](https://www.python.org/)
[![Scripts: 11](https://img.shields.io/badge/scripts-11-brightgreen.svg)](#the-scripts)
[![Schemas: 3/11](https://img.shields.io/badge/schemas-3%2F11-yellow.svg)](scripts/schemas)
[![gh CLI required](https://img.shields.io/badge/gh-CLI-181717.svg?logo=github)](https://cli.github.com/)

[English](README.md) · [简体中文](README_zh.md)

---

## What is this

`github-explore` is an agent skill that turns "search GitHub for X" into structured, deduplicated, relevance-scored output. It wraps `gh search` and `gh repo view` with smart filters, semantic multi-axis exploration, and layered output designed to keep an agent's context window small.

When you ask an agent *"find multi-agent collaboration repos"*, you don't want a star-sorted dump of ollama, langchain, and a bunch of unrelated generic LLM frameworks. You want the canonical anchors (crewAI, autogen, MetaGPT, langgraph, camel, ChatDev, AutoGPT) surfaced first, with the protocol layer (A2A, ANP, ag-ui) as a separate axis, and `awesome-*` lists pushed to the bottom. That's what this skill does.

---

## Why it exists

Plain `gh search` has three structural problems for agent-driven research:

1. **Star-sorted default = giant noise.** A query for `"multi-agent"` returns ollama (180k★) and langchain (140k★) on top because GitHub sorts by popularity, not topical fit.
2. **No semantic axes.** "Search repos about Y" is a one-dimensional query. Real topics have multiple semantic facets (frameworks vs. protocols vs. patterns) that should be explored in parallel and then unioned.
3. **Output floods context.** `gh search repos --json` returns full bodies, dates, and license objects per repo. Piping 50 of these into an LLM wastes thousands of tokens.

`github-explore` addresses all three with a thin layer of Python around `gh`.

---

## Key features

- **Multi-axis exploration** — `explore.py` lets the agent define 2-4 semantic axes per topic, runs them in parallel, and unions results with a relevance score that combines cross-axis hits, canonical anchor recall, and awesome-list signals.
- **Smart defaults** — every discovery script filters forks and archived repos by default, enforces a minimum star floor, dedupes by `fullName`, and renders in a layered markdown summary (~3KB stdout).
- **Layered output** — full reports go to `%TEMP%/gh-explore-{topic}-{ts}.md` automatically; the agent reads the summary, and pulls the file only when it needs more detail. Default exploration drops your context from ~18KB to ~2KB.
- **Field-level contract** — `python scripts/<script>.py --schema` prints the output JSON structure for the four scripts that support it; the other six read their contract from `scripts/schemas/*.schema.json`.
- **No new CLI surface** — every script is a wrapper over `gh search` or `gh repo view`. You can drop the skill and run the same `gh` commands by hand; the value is in the filter, dedup, and relevance scoring.

---

## Quick start

```bash
# 1. Install the skill (Claude Code, Codex, Cursor, and 15+ agent CLIs)
npx skills add Fectivnfy112357/github-explore

# Hermes Agent users
hermes skills install https://raw.githubusercontent.com/Fectivnfy112357/github-explore/main/SKILL.md --force

# 2. Make sure gh CLI is authenticated
gh auth status

# 3. Try it — scripts live under the installed skill dir (e.g. ~/.claude/skills/github-explore/)
cd ~/.claude/skills/github-explore
python scripts/find_repos.py "vector database" --language python --min-stars 500
python scripts/explore.py "multi-agent" \
  --axis "framework|multi-agent framework in:readme; collaborative agents in:readme" \
  --axis "protocol|A2A agent protocol in:readme; agent-to-agent communication in:readme"
```

Each command writes a layered markdown summary to stdout (~3KB) and a full report to a temp file. Pass `--format json` for machine-readable output (explicit; piping does **not** auto-switch).

---

## The scripts

| Script | Purpose | `--schema` | Notes |
|---|---|---|---|
| `find_repos.py` | Smart repo search with multi-dimensional filters | ✅ | Default entry point. Multi-word free-text runs dual-scope (`in:readme` + default) for conceptual recall. |
| `explore.py` | Multi-axis topic exploration | ✅ | Agent defines axes inline. Outputs canonical anchors + cross-axis hits + top 5/axis. |
| `discover.py` | Auto-expand topics from a seed search | ❌ | Reads top seed results, extracts their topics, runs per-topic searches. Fast, opportunistic. |
| `trending.py` | Time-windowed trending repos | ❌ | Default 7d window; supports `--topic`, `--language`, `--min-stars`. |
| `repo_summary.py` | Deep dive on a single repo | ✅ | Topics, languages, recent activity, mentionable users, license. |
| `find_similar.py` | Alternatives to a given repo | ❌ | Cross-language option (`--no-language`). |
| `code_search.py` | GitHub code search by pattern | ❌ | `--repo`, `--org`, `--owner`, `--extension`, `--filename`. |
| `search_issues.py` | Issue/PR search | ❌ | `--state`, `--type`, `--label`, `--author`, `--assignee`. |
| `org_landscape.py` | Audit an entire org | ❌ | `--group-by {language,topic,activity,stars}`. |
| `_lib.py` | Shared helpers | n/a | `ensure_auth`, `gh_json`, `parse_since`, `print_schema`. Not for direct use. |
| `__init__.py` | Module docstring | n/a | Documents the scripts package. |

**`--schema` gap:** 6 of 11 scripts don't yet expose `--schema` as a CLI flag. The schema files for those 6 are still pending in `scripts/schemas/`. Until they're added, the four scripts with `--schema` and the existing `repo.schema.json` / `explore.schema.json` / `repo_summary.schema.json` files cover the most-used paths.

---

## Architecture

```
                  ┌─────────────────────────────────────────────┐
                  │           Agent (LLM, coder, etc.)         │
                  │  - reads SKILL.md for trigger + protocol   │
                  │  - decides which script + which axes       │
                  └──────────────────┬──────────────────────────┘
                                     │ python scripts/<name>.py [args]
                                     ▼
            ┌────────────────────────────────────────────────────┐
            │  scripts/  (10 entry points + _lib + __init__)    │
            │  ─────────────────────────────────────────────────│
            │  find_repos   explore   discover   trending       │
            │  repo_summary find_similar code_search            │
            │  search_issues org_landscape                       │
            │                                                    │
            │  shared: _lib.ensure_auth, _lib.gh_json,           │
            │          _lib.print_schema, _lib.parse_since       │
            └──────────────────┬─────────────────────────────────┘
                               │ subprocess.run(['gh', ...])
                               ▼
            ┌────────────────────────────────────────────────────┐
            │  gh CLI  (search repos / repo view / search code)  │
            │  Authenticated via gh auth status.                 │
            └──────────────────┬─────────────────────────────────┘
                               │
                               ▼
            ┌────────────────────────────────────────────────────┐
            │  GitHub REST + Search API                          │
            │  ~5000/hr core / ~30/min search (authenticated)    │
            └────────────────────────────────────────────────────┘

            Output:
            - stdout:  ~3KB layered markdown summary (default)
            - stdout:  full JSON when --format json (explicit)
            - disk:    %TEMP%/gh-explore-{topic}-{ts}.md (always)
```

**Two layers, one mental model.** Scripts handle discovery (search / dedup / score / render). Direct `gh` calls handle management (create / update / merge / label / workflow). The `references/commands-*.md` files document the management side without bloating `SKILL.md`.

---

## When to use what

| Task | Tool |
|---|---|
| Find repos about a topic | `find_repos.py "<query>"` |
| Map a field's full landscape | `explore.py "<topic>" --axis ...` |
| Auto-expand into related topics | `discover.py "<seed>"` |
| See what shipped recently | `trending.py --window 7d` |
| Read up on one repo | `repo_summary.py owner/repo` |
| Find alternatives | `find_similar.py owner/repo` |
| Where is this pattern used? | `code_search.py "<pattern>" --org ...` |
| Search issues / PRs | `search_issues.py "<query>"` |
| Audit an org | `org_landscape.py <org>` |
| Create a repo, open a PR, label, run CI | `gh <command>` (see `references/commands-*.md`) |

---

## Design decisions worth knowing

These are the non-obvious calls the skill makes, surfaced so you don't have to reverse-engineer them:

1. **`in:readme` is the default for multi-word free text.** Description is too short to disambiguate topics. `find_repos` runs two scopes and unions, with a relevance bonus for `in:readme` hits to keep canonical small projects above generic big repos.
2. **`--exclude` is a post-filter, not a query token.** GitHub's `-term` exclusion is unreliable for awesome lists and tutorials; this skill filters at the merge stage on `fullName` / `description` substrings.
3. **`awesome-*` directories are tagged `☰list` and heavily demoted**, not deleted. They're a different artifact (curation vs. code) and should appear below real projects but still be findable.
4. **Star sorting is a fallback, not a default.** `explore.py` orders by a relevance score that combines canonical-anchor recall, cross-axis hits, and a log-scaled star count. A 100★ canonical anchor always beats a 200k★ repo that merely mentions the topic.
5. **Output is layered, not inlined.** Stdout stays under ~3KB; full results go to a temp file. This is the single biggest context-saver when an agent loops through multiple topics.

---

## Contributing

Issues and pull requests are welcome. This is a personal skill that's been refactored over multiple real uses; the test surface is the scripts themselves, not a unit-test suite.

Before opening a PR:

1. Make sure the affected scripts still pass `python scripts/<name>.py --help` and (where supported) `--schema`.
2. If you add a new script, add a row to the [scripts table](#the-scripts) and consider whether it needs a schema file under `scripts/schemas/`.
3. Keep the layered-output convention: stdout summary + temp-file full report, no exceptions.

---

## License

MIT. See [LICENSE](LICENSE).

## Credits

Built and maintained by 贾晓源 ([@Fectivnfy112357](https://github.com/Fectivnfy112357)).
