#!/usr/bin/env python3
"""gh-code-search: cross-repo code search with optional file/language/org scope.

Examples:
  python code_search.py "def authenticate" --language python --limit 20
  python code_search.py "useEffect" --owner vercel --extension tsx
  python code_search.py "TODO" --org langchain-ai --format json
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import List

from _lib import Column, detect_format, ensure_auth, format_table, gh_json, humanize_date


# `gh search code` available JSON fields (no `size`, no `language`).
CODE_FIELDS = "path,repository,textMatches"


def main() -> int:
    p = argparse.ArgumentParser(
        prog="gh-code-search",
        description="Cross-repository code search with smart scope filters.",
    )
    p.add_argument("query", help="Search expression; gh will pass to GitHub code search.")
    p.add_argument("--language", help="Restrict to language (e.g. python, go).")
    p.add_argument("--extension", help="File extension (e.g. py, ts, tsx).")
    p.add_argument("--repo", help="Limit to a single owner/repo.")
    p.add_argument("--owner", help="Limit to an owner (user or org).")
    p.add_argument("--org", help="Alias for --owner for orgs.")
    p.add_argument("--filename", help="Match by filename glob, e.g. *_test.go")
    p.add_argument("--path", help="Restrict to a path prefix.")
    p.add_argument("--min-stars", type=int, default=0)
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--format", choices=["table", "json", "markdown"])
    args = p.parse_args()

    ensure_auth()

    qualifiers = [args.query]
    if args.language:
        qualifiers.append(f"language:{args.language}")
    if args.extension:
        qualifiers.append(f"extension:{args.extension}")
    if args.filename:
        qualifiers.append(f"filename:{args.filename}")
    if args.path:
        qualifiers.append(f"path:{args.path}")
    if args.repo:
        qualifiers.append(f"repo:{args.repo}")
    if args.owner:
        qualifiers.append(f"user:{args.owner}")
    if args.org:
        qualifiers.append(f"org:{args.org}")
    q = " ".join(qualifiers)

    results = gh_json([
        "search", "code", q, "--limit", str(args.limit), "--json", CODE_FIELDS,
    ]) or []

    # Optional post-filter by repo stars (code search doesn't support star qualifier)
    if args.min_stars > 0 and results:
        repo_names = {r.get("repository", {}).get("nameWithOwner") for r in results}
        repo_names.discard(None)
        if repo_names:
            star_map: dict = {}
            for full in repo_names:
                try:
                    info_data = gh_json([
                        "repo", "view", full,
                        "--json", "stargazerCount,fullName",
                    ])
                    if info_data:
                        star_map[full] = info_data.get("stargazerCount", 0) or 0
                except SystemExit:
                    star_map[full] = 0
            results = [
                r for r in results
                if star_map.get(r.get("repository", {}).get("nameWithOwner", ""), 0)
                >= args.min_stars
            ]

    fmt = detect_format(args.format)
    if fmt == "json":
        print(json.dumps(results, indent=2, ensure_ascii=False))
    elif fmt == "markdown":
        print(f"# Code search: `{q}`\n")
        for r in results:
            repo = r.get("repository", {})
            path = r.get("path", "")
            print(f"## [{repo.get('nameWithOwner', '')}]({repo.get('url', '')}) — `{path}`")
            for tm in r.get("textMatches") or []:
                frag = tm.get("fragment", "")
                print("```")
                print(frag)
                print("```")
            print()
    else:
        rows = []
        for r in results:
            repo = r.get("repository", {})
            frag = ""
            for tm in r.get("textMatches") or []:
                frag = (tm.get("fragment") or "").replace("\n", " ")
                if len(frag) > 70:
                    frag = frag[:69] + "…"
                break
            rows.append({
                "repo": repo.get("nameWithOwner", ""),
                "path": r.get("path", ""),
                "snippet": frag,
            })
        print(format_table(
            rows,
            [
                Column("repo", "Repo", 32),
                Column("path", "Path", 38),
                Column("snippet", "Snippet", 70),
            ],
        ))
    print(f"\n{len(results)} result(s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
