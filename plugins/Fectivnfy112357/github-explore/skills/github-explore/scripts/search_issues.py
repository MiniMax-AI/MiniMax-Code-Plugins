#!/usr/bin/env python3
"""gh-search-issues: cross-repo issues/PRs search.

Examples:
  python search_issues.py "memory leak" --repo langchain-ai/langchain
  python search_issues.py "is:open is:issue label:bug" --org langchain-ai --state open
  python search_issues.py "performance regression" --language python --since 6m
  python search_issues.py "is:pr is:merged" --owner vercel --format markdown
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import List

from _lib import Column, detect_format, ensure_auth, format_table, gh_json, humanize_date, parse_since


# `gh search issues` JSON fields (note: commentsCount, not comments).
ISSUE_FIELDS = "number,title,state,author,updatedAt,labels,repository,url,isPullRequest,commentsCount"


def main() -> int:
    p = argparse.ArgumentParser(
        prog="gh-search-issues",
        description="Cross-repo issue and PR search.",
    )
    p.add_argument("query",
                   help="GitHub search query. Use qualifiers like "
                        "is:open is:issue, is:pr, label:bug, etc.")
    p.add_argument("--state", choices=["open", "closed", "merged", "all"],
                   help="Filter by state (added as qualifier).")
    p.add_argument("--type", choices=["issue", "pr"], help="Force is:issue or is:pr.")
    p.add_argument("--label", action="append", help="label:<x> (repeatable)")
    p.add_argument("--author", help="user:<x>")
    p.add_argument("--assignee", help="assignee:<x>")
    p.add_argument("--mentions", help="mentions:<x>")
    p.add_argument("--involves", help="involves:<x>")
    p.add_argument("--language", help="language:<x> (issue primary repo's language)")
    p.add_argument("--repo", help="repo:<owner/name>")
    p.add_argument("--owner", help="user:<owner>")
    p.add_argument("--org", help="org:<org>")
    p.add_argument("--since", help="Updated within Nd/Nw/Nm/Ny")
    p.add_argument("--no-assignee", action="store_true", help="no:assignee")
    p.add_argument("--no-label", action="store_true", help="no:label")
    p.add_argument("--sort", choices=["created", "updated", "comments"],
                   default="updated")
    p.add_argument("--order", choices=["asc", "desc"], default="desc")
    p.add_argument("--limit", type=int, default=30)
    p.add_argument("--format", choices=["table", "json", "markdown"])
    args = p.parse_args()

    ensure_auth()

    qualifiers = [args.query]
    if args.type == "issue":
        qualifiers.append("is:issue")
    elif args.type == "pr":
        qualifiers.append("is:pr")
    if args.state and args.state != "all":
        qualifiers.append(f"is:{args.state}")
    for lab in args.label or []:
        qualifiers.append(f"label:{lab}")
    if args.author:
        qualifiers.append(f"author:{args.author}")
    if args.assignee:
        qualifiers.append(f"assignee:{args.assignee}")
    if args.mentions:
        qualifiers.append(f"mentions:{args.mentions}")
    if args.involves:
        qualifiers.append(f"involves:{args.involves}")
    if args.language:
        qualifiers.append(f"language:{args.language}")
    if args.repo:
        qualifiers.append(f"repo:{args.repo}")
    if args.owner:
        qualifiers.append(f"user:{args.owner}")
    if args.org:
        qualifiers.append(f"org:{args.org}")
    if args.since:
        qualifiers.append(f"updated:>{parse_since(args.since)}")
    if args.no_assignee:
        qualifiers.append("no:assignee")
    if args.no_label:
        qualifiers.append("no:label")
    q = " ".join(qualifiers)

    results = gh_json([
        "search", "issues", q,
        "--limit", str(args.limit),
        "--sort", args.sort,
        "--order", args.order,
        "--json", ISSUE_FIELDS,
    ]) or []

    fmt = detect_format(args.format)
    if fmt == "json":
        print(json.dumps(results, indent=2, ensure_ascii=False))
    elif fmt == "markdown":
        print(f"# Issue/PR search: `{q}`\n")
        for r in results:
            repo = r.get("repository", {})
            full = repo.get("nameWithOwner", "")
            kind = "PR" if r.get("isPullRequest") else "Issue"
            url = r.get("url", "")
            print(f"- **[{full}#{r.get('number')}] {kind} {r.get('state')}** "
                  f"[{r.get('title')}]({url})")
            print(f"  updated {humanize_date(r.get('updatedAt'))}  "
                  f"comments {r.get('commentsCount', 0)}")
            labels = [lab.get("name") for lab in (r.get("labels") or [])]
            if labels:
                print(f"  labels: {', '.join(labels)}")
        return 0

    rows = []
    for r in results:
        repo = r.get("repository", {})
        labels = [lab.get("name", "") for lab in (r.get("labels") or [])]
        kind = "PR" if r.get("isPullRequest") else "I"
        rows.append({
            "kind": kind,
            "repo": repo.get("nameWithOwner", ""),
            "num": r.get("number", ""),
            "state": r.get("state", ""),
            "title": r.get("title") or "",
            "labels": ", ".join(labels),
            "updated": humanize_date(r.get("updatedAt")),
        })
    print(format_table(
        rows,
        [
            Column("kind", "K", 3),
            Column("repo", "Repo", 28),
            Column("num", "#", 6),
            Column("state", "State", 8),
            Column("title", "Title", 50),
            Column("labels", "Labels", 24),
            Column("updated", "Updated", 10),
        ],
    ))
    print(f"\n{len(results)} result(s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
