#!/usr/bin/env python3
"""gh-trending: repos created or recently active within a time window.

Examples:
  python trending.py --window 7d --language rust
  python trending.py --window 1m --topic llm --min-stars 100
  python trending.py --window 3m --sort stars --format markdown
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import List

from _lib import (
    detect_format,
    die,
    ensure_auth,
    format_table,
    gh_json,
    humanize_date,
    parse_since,
)


# `gh search repos` uses PLURAL field names; no topics in search JSON.
REPO_FIELDS = (
    "fullName,description,stargazersCount,forksCount,language,"
    "createdAt,pushedAt,isArchived,isFork,url"
)


WINDOW_PRESETS = frozenset({
    "1d", "3d", "7d", "14d", "30d",
    "1w", "2w", "1m", "3m", "6m", "1y",
})


def main() -> int:
    p = argparse.ArgumentParser(
        prog="gh-trending",
        description="Find repos that are trending within a time window.",
    )
    p.add_argument("--window", default="7d",
                   help="Lookback window (e.g. 7d, 1m, 3m, 1y). Default 7d.")
    p.add_argument("--by", choices=["created", "pushed"], default="pushed",
                   help="Filter on creation date or last push (default pushed).")
    p.add_argument("--language", help="language:<x>")
    p.add_argument("--topic", action="append", help="topic:<x> (repeatable)")
    p.add_argument("--min-stars", type=int, default=10)
    p.add_argument("--max-stars", type=int, help="Cap upper star count to find rising stars")
    p.add_argument("--sort", choices=["stars", "updated", "created"], default="stars")
    p.add_argument("--order", choices=["asc", "desc"], default="desc")
    p.add_argument("--limit", type=int, default=30)
    p.add_argument("--format", choices=["table", "json", "markdown"])
    args = p.parse_args()

    ensure_auth()

    if args.window not in WINDOW_PRESETS and not (
        len(args.window) >= 2 and args.window[-1] in "dwmy" and args.window[:-1].isdigit()
    ):
        die(f"Invalid --window: {args.window!r}. Use e.g. 7d, 1m, 3m, 1y.")

    cutoff = parse_since(args.window)
    qual = []
    if args.by == "created":
        qual.append(f"created:>{cutoff}")
    else:
        qual.append(f"pushed:>{cutoff}")
    if args.language:
        qual.append(f"language:{args.language}")
    for t in args.topic or []:
        qual.append(f"topic:{t}")
    if args.min_stars is not None:
        qual.append(f"stars:>={args.min_stars}")
    if args.max_stars is not None:
        qual.append(f"stars:<={args.max_stars}")
    qual.append("fork:false")
    qual.append("archived:false")
    q = " ".join(qual)

    results = gh_json([
        "search", "repos", q,
        "--limit", str(args.limit),
        "--sort", args.sort,
        "--order", args.order,
        "--json", REPO_FIELDS,
    ]) or []

    fmt = detect_format(args.format)
    if fmt == "json":
        print(json.dumps(results, indent=2, ensure_ascii=False))
    elif fmt == "markdown":
        print(f"# Trending (last {args.window}, by {args.by})\n")
        print(f"Query: `{q}`\n")
        for r in results:
            name = r.get("fullName", "")
            url = r.get("url", "")
            stars = r.get("stargazersCount", 0)
            lang = r.get("language") or "-"
            date_field = "pushedAt" if args.by == "pushed" else "createdAt"
            date = humanize_date(r.get(date_field))
            print(f"- **[{name}]({url})**  ⭐{stars}  📝{lang}  {args.by} {date}")
            if r.get("description"):
                print(f"  {r['description'][:140]}")
    else:
        rows = [
            {
                "name": r.get("fullName", ""),
                "stars": r.get("stargazersCount", 0),
                "lang": r.get("language") or "-",
                "date": humanize_date(
                    r.get("pushedAt") if args.by == "pushed" else r.get("createdAt")
                ),
                "desc": r.get("description") or "",
            }
            for r in results
        ]
        print(format_table(
            rows,
            [
                ("name", "Repository", 42),
                ("stars", "Stars", 7),
                ("lang", "Lang", 12),
                ("date", args.by.capitalize(), 10),
                ("desc", "Description", 80),
            ],
        ))
    print(f"\n{len(results)} result(s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
