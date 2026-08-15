#!/usr/bin/env python3
"""gh-org-landscape: scan an entire GitHub org and group repos by status/topic.

Examples:
  python org_landscape.py vercel --group-by language
  python org_landscape.py langchain-ai --group-by activity --include-archived
  python org_landscape.py microsoft --group-by topic --min-stars 100 --format markdown
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Dict, List

from _lib import (
    Column,
    detect_format,
    die,
    ensure_auth,
    format_table,
    gh_json,
    humanize_date,
    info,
    warn,
)


def classify_activity(pushed_at: str) -> str:
    """Active / maintained / dormant / dead based on last push."""
    if not pushed_at:
        return "unknown"
    try:
        dt = datetime.fromisoformat(pushed_at.replace("Z", "+00:00"))
    except ValueError:
        return "unknown"
    now = datetime.now(dt.tzinfo)
    age = now - dt
    if age < timedelta(days=90):
        return "active"
    if age < timedelta(days=365):
        return "maintained"
    if age < timedelta(days=730):
        return "dormant"
    return "dead"


def fetch_all_repos_via_api(org: str, max_workers: int = 6) -> List[dict]:
    """Use /orgs/{org}/repos paginated for a reliable JSON listing.

    Pages are fetched in parallel (REST pagination is slow for big orgs).
    NOTE: we use `?per_page=` query string instead of `-F` because `gh api`
    treats `-F` as form fields and may dispatch a non-GET method.

    The total repo count comes from `/orgs/{org}.public_repos` (one extra
    GET, ~50ms), which gives the exact page count so we know precisely when
    to stop. Without this, the old as_completed + break pattern could drop
    pages when the last partial page returned before a full one — page N's
    100 results were already submitted but never consumed.
    """
    REPO_JQ = (
        "[.[] | {"
        "name: .name, nameWithOwner: .full_name, "
        "description: .description, stargazersCount: .stargazers_count, "
        "forksCount: .forks_count, language: .language, "
        "pushedAt: .pushed_at, isArchived: .archived, isFork: .fork, "
        "isDisabled: .disabled, url: .html_url, topics: .topics, "
        "visibility: .visibility, updatedAt: .updated_at"
        "}]"
    )

    # Probe total count up front. 404 / no-access / empty org → bail.
    meta = gh_json([
        "api", f"/orgs/{org}",
        "--jq",
        "{public_repos: .public_repos, "
        "is_missing: (.message != null)}",
    ])
    if not meta or meta.get("is_missing"):
        return []
    total = int(meta.get("public_repos") or 0)
    if total == 0:
        return []

    # Cap at 5000 for safety — warn the user if we truncated.
    truncated = total > 5000
    pages = (min(total, 5000) + 99) // 100

    def fetch_page(p: int) -> List[dict]:
        try:
            return gh_json([
                "api",
                f"/orgs/{org}/repos?per_page=100&page={p}&type=public",
                "--jq", REPO_JQ,
            ]) or []
        except SystemExit:
            return []

    # Collect every page into a dict keyed by page number, then extend in
    # order. This avoids the as_completed + break ordering hazard: any
    # future that lands "after" the last expected page just adds an empty
    # list (or whatever the API returned) — no data is silently dropped.
    by_page: Dict[int, List[dict]] = {}
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {ex.submit(fetch_page, p): p for p in range(1, pages + 1)}
        for fut in as_completed(futures):
            by_page[futures[fut]] = fut.result()

    out: List[dict] = []
    for p in range(1, pages + 1):
        out.extend(by_page.get(p, []))

    if truncated:
        warn(
            f"org has {total} public repos; capped at 5000. "
            "Narrow filters (--include-forks, --include-archived, "
            "--min-stars) and re-run for a complete picture."
        )
    return out


def main() -> int:
    p = argparse.ArgumentParser(
        prog="gh-org-landscape",
        description="Scan a GitHub org and group repos by activity, language, or topic.",
    )
    p.add_argument("org", help="Org login (e.g. 'vercel', 'langchain-ai').")
    p.add_argument("--group-by", choices=["language", "topic", "activity", "stars"],
                   default="activity")
    p.add_argument("--min-stars", type=int, default=0)
    p.add_argument("--include-archived", action="store_true")
    p.add_argument("--include-forks", action="store_true",
                   help="Forks are excluded by default.")
    p.add_argument("--top-n", type=int, default=8,
                   help="How many top repos to show per group (default 8).")
    p.add_argument("--format", choices=["table", "json", "markdown"])
    args = p.parse_args()

    ensure_auth()
    info(f"listing repos for org: {args.org}")
    repos = fetch_all_repos_via_api(args.org)
    if not repos:
        die(f"No repos found for org {args.org!r} (or you lack access).")

    info(f"{len(repos)} repos fetched")
    # Filter
    before = len(repos)
    repos = [r for r in repos if (r.get("stargazersCount") or 0) >= args.min_stars]
    if not args.include_archived:
        repos = [r for r in repos if not r.get("isArchived")]
    if not args.include_forks:
        repos = [r for r in repos if not r.get("isFork")]
    info(f"after filters: {len(repos)} repos (dropped {before - len(repos)})")

    # Group
    groups: Dict[str, List[dict]] = defaultdict(list)
    for r in repos:
        if args.group_by == "language":
            key = r.get("language") or "(no language)"
        elif args.group_by == "topic":
            topics = r.get("topics") or []
            key = topics[0] if topics else "(no topic)"
        elif args.group_by == "stars":
            stars = r.get("stargazersCount") or 0
            if stars < 100:
                key = "<100"
            elif stars < 1000:
                key = "100-1k"
            elif stars < 10000:
                key = "1k-10k"
            else:
                key = "10k+"
        else:  # activity
            key = classify_activity(r.get("pushedAt"))
        groups[key].append(r)

    # Sort each group
    for key in groups:
        groups[key].sort(key=lambda r: -(r.get("stargazersCount") or 0))

    fmt = detect_format(args.format)

    # Summary
    summary = {
        "org": args.org,
        "total_repos": len(repos),
        "group_by": args.group_by,
        "groups": {
            k: {
                "count": len(v),
                "total_stars": sum((r.get("stargazersCount") or 0) for r in v),
                "top": [
                    {
                        "name": r.get("nameWithOwner"),
                        "stars": r.get("stargazersCount"),
                        "pushed": r.get("pushedAt"),
                        "description": r.get("description"),
                    }
                    for r in v[: args.top_n]
                ],
            }
            for k, v in sorted(groups.items(), key=lambda kv: -len(kv[1]))
        },
    }

    if fmt == "json":
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return 0

    if fmt == "markdown":
        print(f"# Org landscape: `{args.org}`\n")
        print(f"**{len(repos)} repos**, grouped by **{args.group_by}**\n")
        for g, info_block in summary["groups"].items():
            print(f"## {g}  ({info_block['count']} repos, "
                  f"{info_block['total_stars']:,} total ⭐)\n")
            for r in info_block["top"]:
                print(f"- **[{r['name']}](https://github.com/{r['name']})**  "
                      f"⭐{r['stars']}  pushed {humanize_date(r['pushed'])}")
                if r["description"]:
                    print(f"  {r['description'][:120]}")
            print()
        return 0

    # table: flat list across all groups
    print(f"# {args.org} — {len(repos)} repos, grouped by {args.group_by}\n")
    for g in sorted(groups, key=lambda k: -len(groups[k])):
        repos_g = groups[g][: args.top_n]
        print(f"\n## {g}  ({len(groups[g])} repos)\n")
        rows = [
            {
                "name": r.get("nameWithOwner", ""),
                "stars": r.get("stargazersCount", 0),
                "pushed": humanize_date(r.get("pushedAt")),
                "desc": r.get("description") or "",
            }
            for r in repos_g
        ]
        print(format_table(
            rows,
            [
                Column("name", "Repo", 40),
                Column("stars", "⭐", 7),
                Column("pushed", "Pushed", 10),
                Column("desc", "Description", 80),
            ],
        ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
