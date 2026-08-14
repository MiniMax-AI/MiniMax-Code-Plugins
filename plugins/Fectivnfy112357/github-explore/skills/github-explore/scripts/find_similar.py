#!/usr/bin/env python3
"""gh-find-similar: find repositories similar to a given one.

Strategy:
  1. Get source repo's topics and primary language.
  2. Search for repos matching the same topics.
  3. Filter to same language, similar star tier, exclude forks/archived/self.
  4. Rank by topic overlap + star proximity.

Examples:
  python find_similar.py langchain-ai/langchain --limit 20
  python find_similar.py vercel/next.js --min-stars 5000 --format markdown
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from typing import List, Set

from _lib import (
    detect_format,
    die,
    ensure_auth,
    format_table,
    gh_json,
    humanize_date,
    info,
)


# `gh search repos` JSON: PLURAL stargazersCount/forksCount, no topics.
REPO_FIELDS = (
    "fullName,description,stargazersCount,forksCount,language,"
    "pushedAt,isArchived,isFork,url"
)


def fetch_source(owner_repo: str) -> dict:
    # `gh repo view` JSON: SINGULAR stargazerCount/forkCount, primaryLanguage,
    # repositoryTopics (list of {name} objects).
    fields = "nameWithOwner,description,stargazerCount,primaryLanguage,repositoryTopics,url"
    data = gh_json([
        "repo", "view", owner_repo,
        "--json", fields,
    ])
    if not data:
        die(f"Source repo not found: {owner_repo}")
    return data


def _extract_topics(repo_view: dict) -> List[str]:
    """Pull topic names out of `gh repo view` repositoryTopics structure."""
    out: List[str] = []
    for t in repo_view.get("repositoryTopics") or []:
        if isinstance(t, dict):
            n = t.get("name") or t.get("topic")
            if n:
                out.append(n)
        elif isinstance(t, str):
            out.append(t)
    return out


def star_tier(stars: int) -> tuple:
    """Return (lo, hi) bounds in the same star tier."""
    if stars < 100:
        return (0, 100)
    if stars < 500:
        return (100, 500)
    if stars < 1000:
        return (500, 1000)
    if stars < 5000:
        return (1000, 5000)
    if stars < 20000:
        return (5000, 20000)
    return (20000, max(20000, stars * 2))


def main() -> int:
    p = argparse.ArgumentParser(
        prog="gh-find-similar",
        description="Find repositories similar to a given one.",
    )
    p.add_argument("repo", help="owner/repo to find similar projects to")
    p.add_argument("--limit", type=int, default=15)
    p.add_argument("--min-stars", type=int, default=20)
    p.add_argument("--same-language", action="store_true", default=True,
                   help="Restrict to same language (default on)")
    p.add_argument("--no-language", dest="same_language", action="store_false")
    p.add_argument("--include-forks", action="store_true")
    p.add_argument("--format", choices=["table", "json", "markdown"])
    args = p.parse_args()

    ensure_auth()
    info(f"loading source: {args.repo}")
    src = fetch_source(args.repo)
    src_topics: List[str] = _extract_topics(src)
    src_lang = src.get("primaryLanguage") or ""
    if isinstance(src_lang, dict):
        src_lang = src_lang.get("name") or ""
    src_full = src.get("nameWithOwner") or args.repo
    src_stars = src.get("stargazerCount") or 0
    lo, hi = star_tier(src_stars)
    info(f"source topics: {src_topics}, language: {src_lang}, stars: {src_stars}")

    if not src_topics and not src_lang:
        die("Source repo has no topics or language; cannot compute similarity.")

    candidates: dict = {}

    # Strategy A: per-topic search (highest signal).
    # We don't pre-filter by star tier here because very popular repos have
    # almost no matches in a narrow tier; instead we collect candidates and
    # re-rank by topic overlap + star proximity + language at the end.
    # NOTE: `language:` MUST NOT be the first qualifier (gh then misparses).
    for topic in src_topics[:6]:
        q = f"topic:{topic} stars:>{args.min_stars} fork:false archived:false"
        if args.same_language and src_lang:
            q += f" language:{src_lang}"
        results = gh_json([
            "search", "repos", q, "--limit", "30", "--json", REPO_FIELDS,
        ]) or []
        for r in results:
            if r.get("fullName") == src_full:
                continue
            if not args.include_forks and r.get("isFork"):
                continue
            if r.get("isArchived"):
                continue
            if (r.get("stargazersCount") or 0) < args.min_stars:
                continue
            candidates.setdefault(r["fullName"], {"repo": r, "matched_topics": []})
            candidates[r["fullName"]]["matched_topics"].append(topic)

    # Strategy B: language-only search (fallback when topics yield little).
    if len(candidates) < args.limit and args.same_language and src_lang:
        q = f"stars:>{args.min_stars} fork:false archived:false language:{src_lang}"
        results = gh_json([
            "search", "repos", q, "--limit", "30", "--json", REPO_FIELDS,
        ]) or []
        for r in results:
            if r.get("fullName") == src_full:
                continue
            if r.get("isArchived") or (not args.include_forks and r.get("isFork")):
                continue
            if (r.get("stargazersCount") or 0) < args.min_stars:
                continue
            candidates.setdefault(r["fullName"], {"repo": r, "matched_topics": []})

    def score(entry: dict) -> float:
        r = entry["repo"]
        overlap = len(entry["matched_topics"])
        r_stars = r.get("stargazersCount") or 0
        r_lang = r.get("language") or ""
        # Same-language boost: 30 points if source lang matches.
        lang_bonus = 30 if (src_lang and r_lang and r_lang.lower() == src_lang.lower()) else 0
        # Closer stars = higher score (log scale).
        star_diff = abs(r_stars - src_stars)
        star_score = -math.log10(star_diff + 10)
        return overlap * 100 + lang_bonus + star_score

    ranked = sorted(candidates.values(), key=score, reverse=True)[: args.limit]

    fmt = detect_format(args.format)
    if fmt == "json":
        print(json.dumps(
            {
                "source": args.repo,
                "source_meta": {
                    "topics": src_topics,
                    "language": src_lang,
                    "stars": src_stars,
                },
                "similar": [
                    {
                        **entry["repo"],
                        "matched_topics": entry["matched_topics"],
                    }
                    for entry in ranked
                ],
            },
            indent=2, ensure_ascii=False,
        ))
        return 0

    if fmt == "markdown":
        print(f"# Similar to [{src_full}]({src.get('url', '')})\n")
        print(f"Source: ⭐{src_stars}  📝{src_lang}  "
              f"topics: {', '.join(f'`{t}`' for t in src_topics)}\n")
        for entry in ranked:
            r = entry["repo"]
            mt = entry["matched_topics"]
            print(f"- **[{r.get('fullName')}]({r.get('url')})**  "
                  f"⭐{r.get('stargazersCount', 0)}  📝{r.get('language') or '-'}  "
                  f"pushed {humanize_date(r.get('pushedAt'))}"
                  + (f"  _matched: {', '.join(mt)}_" if mt else ""))
            if r.get("description"):
                print(f"  {r['description'][:140]}")
        return 0

    rows = [
        {
            "name": e["repo"].get("fullName", ""),
            "stars": e["repo"].get("stargazersCount", 0),
            "lang": e["repo"].get("language") or "-",
            "matched": ", ".join(e["matched_topics"]) or "-",
            "desc": e["repo"].get("description") or "",
        }
        for e in ranked
    ]
    print(format_table(
        rows,
        [
            ("name", "Repository", 38),
            ("stars", "Stars", 7),
            ("lang", "Lang", 10),
            ("matched", "Matched topics", 28),
            ("desc", "Description", 60),
        ],
    ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
