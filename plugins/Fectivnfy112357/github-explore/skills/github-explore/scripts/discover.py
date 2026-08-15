#!/usr/bin/env python3
"""gh-discover: given a keyword, expand into related topics and find top repos in each.

Strategy:
  1. Search repos matching the seed keyword.
  2. Aggregate topics from the top results.
  3. For each top topic, run a topic-scoped repo search.
  4. Dedupe, score, group output by topic.

Examples:
  python discover.py "vector database"
  python discover.py "agent framework" --depth 8 --per-topic 5 --language python
  python discover.py "terminal ui" --min-stars 200 --format markdown
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime
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
    is_excluded,
    parse_since,
)


# `gh search repos` JSON fields (note plural: stargazersCount, forksCount; no topics)
REPO_FIELDS = (
    "fullName,description,stargazersCount,forksCount,language,"
    "pushedAt,isArchived,isFork,url"
)


def search_repos(query: str, limit: int) -> List[dict]:
    return gh_json(
        ["search", "repos", query, "--limit", str(limit), "--json", REPO_FIELDS]
    ) or []


def fetch_topics(full_name: str) -> List[str]:
    """`gh search repos` doesn't expose topics; pull them from gh repo view.

    The field is `repositoryTopics` (a list of {name} objects).
    """
    try:
        data = gh_json([
            "repo", "view", full_name, "--json", "repositoryTopics",
        ])
    except SystemExit:
        return []
    if not data:
        return []
    topics_field = data.get("repositoryTopics") or []
    out: List[str] = []
    for t in topics_field:
        if isinstance(t, dict):
            n = t.get("name") or t.get("topic")
            if n:
                out.append(n)
        elif isinstance(t, str):
            out.append(t)
    return out


def expand_topics(
    seed_results: List[dict], depth: int, min_topic_count: int = 2
) -> List[str]:
    """Pick the top-N most common topics across seed results.

    `gh search repos` doesn't return topics inline, so we resolve them via
    per-repo `gh repo view` calls. We cap the lookups to keep this snappy.
    """
    counter: Counter = Counter()
    seed_for_topics = [r for r in seed_results if r.get("fullName")][:10]
    for r in seed_for_topics:
        for t in fetch_topics(r["fullName"]):
            counter[t] += 1
    candidates = [t for t, c in counter.most_common() if c >= min_topic_count]
    return candidates[:depth]


def score_repo(r: dict) -> float:
    """Higher = more relevant. Combines stars and recency signals."""
    stars = r.get("stargazersCount") or 0
    pushed = r.get("pushedAt") or ""
    recency_bonus = 0
    if pushed:
        try:
            year = int(pushed[:4])
            # Current year is read at runtime so the score doesn't go stale
            # on Jan 1 of next year (otherwise all repos get +50 penalty).
            recency_bonus = max(0, (datetime.now().year - year)) * -50
        except ValueError:
            pass
    return stars + recency_bonus


def main() -> int:
    p = argparse.ArgumentParser(
        prog="gh-discover",
        description="Expand a keyword into related topics + top repos per topic.",
    )
    p.add_argument("keyword", help="Seed keyword, e.g. 'vector database'.")
    p.add_argument("--depth", type=int, default=6,
                   help="How many related topics to expand into (default 6).")
    p.add_argument("--per-topic", type=int, default=4,
                   help="Repos per topic (default 4).")
    p.add_argument("--seed-limit", type=int, default=20,
                   help="Repos to use as topic seed (default 20).")
    p.add_argument("--language", help="Bias expansion to this language.")
    p.add_argument("--min-stars", type=int, default=20)
    p.add_argument("--pushed-since", help="Nd/Nw/Nm/Ny cutoff")
    p.add_argument("--include-forks", action="store_true")
    p.add_argument("--format", choices=["table", "json", "markdown"])
    args = p.parse_args()

    ensure_auth()

    info(f"seed search: {args.keyword!r}")
    seed_q = args.keyword
    if args.language:
        seed_q += f" language:{args.language}"
    if args.min_stars:
        seed_q += f" stars:>={args.min_stars}"
    if args.pushed_since:
        seed_q += f" pushed:>{parse_since(args.pushed_since)}"
    if not args.include_forks:
        seed_q += " fork:false"

    seed = search_repos(seed_q, args.seed_limit)
    if not seed:
        die(f"No seed results for: {args.keyword!r}")

    info(f"seed: {len(seed)} repos, extracting topics")
    topics = expand_topics(seed, args.depth)
    if not topics:
        die("Could not derive topics from seed. Try a more specific keyword.")

    info(f"expanded topics ({len(topics)}): {', '.join(topics)}")

    # Per-topic search
    grouped: Dict[str, List[dict]] = {}
    for topic in topics:
        q = f"topic:{topic} stars:>={args.min_stars} fork:false archived:false"
        if args.language:
            q += f" language:{args.language}"
        if args.pushed_since:
            q += f" pushed:>{parse_since(args.pushed_since)}"
        results = search_repos(q, args.per_topic * 3)
        # Quality filter
        results = [r for r in results if not is_excluded(r, min_stars=args.min_stars)]
        # NOTE: we don't filter self-echo (repo whose topic == seed keyword).
        # gh search repos doesn't return topics; doing the check would need
        # N+1 gh repo view calls per topic and slow discovery ~10x. The
        # recency + star filter is the actual quality gate.
        results.sort(key=score_repo, reverse=True)
        grouped[topic] = results[: args.per_topic]

    fmt = detect_format(args.format)

    if fmt == "json":
        print(json.dumps(
            {"seed_keyword": args.keyword, "topics": grouped},
            indent=2, ensure_ascii=False,
        ))
        return 0

    if fmt == "markdown":
        print(f"# Discovery: `{args.keyword}`\n")
        print(f"Expanded into {len(topics)} topics:\n")
        for topic, repos in grouped.items():
            print(f"## topic:`{topic}` ({len(repos)} repos)\n")
            for r in repos:
                name = r.get("fullName", "")
                url = r.get("url", "")
                stars = r.get("stargazersCount", 0)
                lang = r.get("language") or "-"
                pushed = humanize_date(r.get("pushedAt"))
                print(f"- **[{name}]({url})**  ⭐{stars}  📝{lang}  pushed {pushed}")
                if r.get("description"):
                    print(f"  {r['description'][:140]}")
            print()
        return 0

    # table
    rows = []
    for topic, repos in grouped.items():
        for r in repos:
            rows.append({
                "topic": topic,
                "name": r.get("fullName", ""),
                "stars": r.get("stargazersCount", 0),
                "lang": r.get("language") or "-",
                "pushed": humanize_date(r.get("pushedAt")),
                "desc": r.get("description") or "",
            })
    print(format_table(
        rows,
        [
            Column("topic", "Topic", 22),
            Column("name", "Repository", 38),
            Column("stars", "Stars", 6),
            Column("lang", "Lang", 10),
            Column("pushed", "Pushed", 10),
            Column("desc", "Description", 60),
        ],
    ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
