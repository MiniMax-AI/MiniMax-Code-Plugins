#!/usr/bin/env python3
"""gh-find-repos: comprehensive repository search with smart filters.

By default, multi-word free-text queries are wrapped with `in:readme` for
much better conceptual recall (e.g. "self-hosted sso" → finds zitadel,
goauthentik/authentik instead of unrelated trip-planner repos). This
auto-wrapping is disabled when you pass any narrowing qualifier
(`--language`, `--topic`, `--owner`, `--org`, `--license`, `--pushed-since`,
`--created-since`) — in those cases `in:readme` would let awesome-list
repos dominate over actual projects. Pass `--no-semantic` to opt out
manually.

When the query has no narrowing qualifier AND returns fewer than 5 hits,
the script prints a stderr hint pointing at `explore.py` with explicit
axes — that's the right tool for conceptual topics.

Examples:
  python find_repos.py "vector database" --language python --min-stars 1000
  python find_repos.py "cli" --topic terminal --topic rust --pushed-since 6m
  python find_repos.py "rag framework" --min-stars 500 --format markdown
  python find_repos.py "llm agent" --max-stars 5000 --format json
  python find_repos.py "self-hosted sso" --min-stars 200   # in:readme auto
  python find_repos.py "deno" --min-stars 500               # single-word, no wrap
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List

from _lib import (
    detect_format,
    die,
    ensure_auth,
    format_table,
    gh_json,
    humanize_date,
    parse_since,
    print_schema,
)


# NOTE: `gh search repos` uses PLURAL field names (`stargazersCount`, `forksCount`)
# and does NOT expose `topics` (use gh repo view --json repositoryTopics for those).
REPO_FIELDS = (
    "fullName,description,stargazersCount,forksCount,language,"
    "pushedAt,isArchived,isFork,url,license"
)

# Soft-relevance bonus applied to the star-based sort when the dual-scope
# union overflows the limit. Without it, high-star general-purpose repos
# whose README merely mentions the query words (e.g. ollama for
# "observability platform") crowd out lower-star but on-topic projects
# (hyperdx, OneUptime...). Mechanical, topic-agnostic:
#   rel 0: no query word in name/description (README-only hit)
#   rel 1: some query word in name/description
#   rel 2: ALL query words in name/description
#   +1    if the repo was found by BOTH scopes (name/desc AND readme)
# Bonus is in "star-equivalents"; 3000 ≈ small-to-mid project, so it can
# beat a similar-sized noise repo but never a 100k+ general-purpose one.
REL_BONUS = 3000


def build_qualifiers(args: argparse.Namespace) -> List[str]:
    """Build a single search query string from args.

    When --semantic (default) and the user gave a multi-word free-text
    query without any narrowing qualifier, we ALSO want the
    in:name,description search (the implicit default) — different topics
    benefit from different scopes:
      - "self-hosted sso", "edge runtime framework" → in:readme wins
      - "vector database", "observability platform" → in:name,description wins
    Returning a list of two query strings lets the caller run both and
    union the results, getting the best of both worlds. The list has
    length 1 in the narrow / single-word / explicit-in: cases.
    """
    def _add_core_filters(parts: List[str]) -> List[str]:
        if args.language:
            parts.append(f"language:{args.language}")
        for t in args.topic or []:
            parts.append(f"topic:{t}")
        if args.min_stars is not None:
            parts.append(f"stars:>={args.min_stars}")
        if args.max_stars is not None:
            parts.append(f"stars:<={args.max_stars}")
        if args.pushed_since:
            parts.append(f"pushed:>{parse_since(args.pushed_since)}")
        if args.created_since:
            parts.append(f"created:>{parse_since(args.created_since)}")
        if not args.include_forks:
            parts.append("fork:false")
        if not args.include_archived:
            parts.append("archived:false")
        if args.license:
            parts.append(f"license:{args.license}")
        if args.owner:
            parts.append(f"user:{args.owner}")
        if args.org:
            parts.append(f"org:{args.org}")
        if args.good_first_issues:
            parts.append("good-first-issues:>0")
        if args.help_wanted:
            parts.append("help-wanted-issues:>0")
        return parts

    has_narrow = any([
        args.language, args.topic, args.owner, args.org,
        args.license, args.pushed_since, args.created_since,
        args.max_stars,
    ])
    user_has_in = "in:" in args.query
    words = args.query.split()

    if args.semantic and not has_narrow and not user_has_in and len(words) >= 2:
        # Dual-scope: one search with in:readme, one with default scope.
        # Caller will union + dedupe.
        return [
            " ".join(_add_core_filters([f"{args.query} in:readme"])),
            " ".join(_add_core_filters([args.query])),
        ]
    return [" ".join(_add_core_filters([args.query]))]


def _relevance(repo: Dict[str, Any], terms: List[str]) -> int:
    """0-2 soft relevance from name/description text match against query words."""
    text = ((repo.get("description") or "") + " " + (repo.get("fullName") or "")).lower()
    if all(t in text for t in terms):
        return 2
    if any(t in text for t in terms):
        return 1
    return 0


def render_table(results: list) -> str:
    rows = [
        {
            "name": r.get("fullName", ""),
            "stars": r.get("stargazersCount", 0),
            "forks": r.get("forksCount", 0),
            "lang": r.get("language") or "-",
            "pushed": humanize_date(r.get("pushedAt")),
            "desc": r.get("description") or "",
        }
        for r in results
    ]
    return format_table(
        rows,
        [
            ("name", "Repository", 42),
            ("stars", "Stars", 7),
            ("forks", "Forks", 6),
            ("lang", "Language", 12),
            ("pushed", "Pushed", 10),
            ("desc", "Description", 80),
        ],
    )


def render_markdown(results: list, query: str) -> str:
    out = [f"# Repository Search: `{query}`\n", f"**{len(results)}** results\n"]
    for r in results:
        name = r.get("fullName", "")
        url = r.get("url", "")
        stars = r.get("stargazersCount", 0)
        lang = r.get("language") or "-"
        pushed = humanize_date(r.get("pushedAt"))
        lic = r.get("license")
        if isinstance(lic, dict):
            lic = lic.get("spdxId") or lic.get("name")
        out.append(f"## [{name}]({url})")
        out.append(
            f"⭐ {stars}  ·  🍴 {r.get('forksCount', 0)}  ·  "
            f"📝 {lang}  ·  pushed {pushed}"
            + (f"  ·  {lic}" if lic else "")
        )
        if r.get("description"):
            out.append(f"\n{r['description']}\n")
    return "\n".join(out)


def main() -> int:
    p = argparse.ArgumentParser(
        prog="gh-find-repos",
        description="Smart GitHub repository search with multi-dimensional filters.",
    )
    p.add_argument("query", nargs="?", default="",
                   help="Free-text query; qualifiers like language:python also work.")
    p.add_argument("--semantic", action="store_true", default=True,
                   help="(default on) For multi-word free-text queries, search "
                        "in:readme for better conceptual recall. Pass --no-semantic "
                        "to disable, or include an explicit in: qualifier in --query.")
    p.add_argument("--no-semantic", dest="semantic", action="store_false",
                   help="Disable the default in:readme wrapping for free-text queries.")
    p.add_argument("--language", help="language:<x>")
    p.add_argument("--topic", action="append", help="topic:<x> (repeatable)")
    p.add_argument("--min-stars", type=int, help="stars:>=<n>")
    p.add_argument("--max-stars", type=int, help="stars:<=<n>")
    p.add_argument("--pushed-since", help="pushed within Nd/Nw/Nm/Ny")
    p.add_argument("--created-since", help="created within Nd/Nw/Nm/Ny")
    p.add_argument("--license", help="license:<spdx-id>")
    p.add_argument("--owner", help="user:<owner>")
    p.add_argument("--org", help="org:<org>")
    p.add_argument("--include-forks", action="store_true")
    p.add_argument("--include-archived", action="store_true")
    p.add_argument("--good-first-issues", action="store_true",
                   help="good-first-issues:>0")
    p.add_argument("--help-wanted", action="store_true",
                   help="help-wanted-issues:>0")
    p.add_argument("--limit", type=int, default=30)
    p.add_argument("--format", choices=["table", "json", "markdown"])
    p.add_argument("--schema", action="store_true",
                   help="Print the output JSON schema (field contract) and exit.")
    args = p.parse_args()

    if args.schema:
        print_schema("repo.schema.json", "gh-find-repos")
        return 0

    if not args.query:
        die("No query given. Usage: find_repos.py QUERY [options]  (or --schema)")

    ensure_auth()
    queries = build_qualifiers(args)

    # Run each query, union + dedupe by fullName.
    # This is what lets us cover both "vector database" (in:name,description
    # wins) AND "self-hosted sso" (in:readme wins) without the agent having
    # to know which mode to pick.
    seen: Dict[str, Dict[str, Any]] = {}
    scope_hits: Dict[str, int] = {}
    for q in queries:
        batch = gh_json(
            ["search", "repos", q, "--limit", str(args.limit), "--json", REPO_FIELDS]
        ) or []
        for r in batch:
            fn = r.get("fullName")
            if not fn:
                continue
            if fn in seen:
                scope_hits[fn] += 1
            else:
                seen[fn] = r
                scope_hits[fn] = 1
    # Annotate soft relevance, then sort with the bonus so on-topic
    # mid-tier projects aren't crowded out by README-collision noise.
    terms = [w for w in args.query.lower().split() if len(w) > 1]
    for fn, r in seen.items():
        r["_rel"] = _relevance(r, terms) + (1 if scope_hits[fn] > 1 else 0)
    results = sorted(
        seen.values(),
        key=lambda r: -((r.get("stargazersCount") or 0) + (r.get("_rel", 0) * REL_BONUS)),
    )[: args.limit]
    q = " | ".join(queries) if len(queries) > 1 else queries[0]

    fmt = detect_format(args.format)
    if fmt == "json":
        print(json.dumps(results, indent=2, ensure_ascii=False))
    elif fmt == "markdown":
        print(render_markdown(results, q))
    else:
        print(render_table(results))

    print(f"\n{len(results)} result(s) for: {q}", file=sys.stderr)

    # Sparse-result guidance: when a conceptual free-text query returns few
    # hits, it usually means the topic is multi-dimensional and a single
    # search can't cover it. Surface a hint to stderr so the agent can
    # escalate to explore.py with axes.
    # The hint is suppressed when the user has explicitly narrowed (so a
    # focused query with 0 hits is a true miss, not a coverage problem).
    has_narrow = any([
        args.language, args.topic, args.owner, args.org,
        args.license, args.pushed_since, args.created_since,
        args.max_stars,
    ])
    if not has_narrow and len(results) < 5 and fmt != "json":
        print(
            f"\n  hint: only {len(results)} result(s) — this looks like a "
            "conceptual topic. Try `explore.py` with explicit axes for better "
            "coverage, e.g.\n"
            f"    python explore.py {shlex_quote(args.query)} "
            '--axis "<dim1>|<queries>" --axis "<dim2>|<queries>"',
            file=sys.stderr,
        )
    return 0


def shlex_quote(s: str) -> str:
    """Tiny stdlib-free shell-quote for the hint message."""
    if not s or all(c.isalnum() or c in "-_./=" for c in s):
        return s
    return '"' + s.replace('"', '\\"') + '"'


if __name__ == "__main__":
    sys.exit(main())