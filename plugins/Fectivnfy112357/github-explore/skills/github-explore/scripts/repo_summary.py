#!/usr/bin/env python3
"""gh-repo-summary: one-shot overview of a repository.

Examples:
  python repo_summary.py langchain-ai/langchain
  python repo_summary.py vercel/next.js --format markdown
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
    gh_json,
    humanize_date,
    info,
    print_schema,
)


# `gh repo view` JSON fields (camelCase, SINGULAR stargazerCount/forkCount).
REPO_FIELDS = (
    "nameWithOwner,name,description,stargazerCount,forkCount,watchers,"
    "primaryLanguage,languages,licenseInfo,defaultBranchRef,"
    "isArchived,isFork,isPrivate,createdAt,updatedAt,pushedAt,"
    "homepageUrl,url,owner,repositoryTopics,latestRelease,mentionableUsers"
)


def fetch_repo(owner_repo: str) -> Dict[str, Any]:
    return gh_json(["repo", "view", owner_repo, "--json", REPO_FIELDS])


def fetch_open_issues_count(owner_repo: str) -> int:
    """`gh repo view` doesn't expose openIssuesCount; pull it from the API."""
    data = gh_json(["api", f"/repos/{owner_repo}"]) or {}
    return int(data.get("open_issues_count") or 0)


def fetch_recent_issues(owner_repo: str, limit: int) -> List[dict]:
    fields = "number,title,state,author,updatedAt,labels,url"
    return gh_json([
        "issue", "list", "--repo", owner_repo, "--limit", str(limit),
        "--state", "all", "--json", fields,
    ]) or []


def fetch_recent_prs(owner_repo: str, limit: int) -> List[dict]:
    fields = "number,title,state,author,updatedAt,isDraft,url"
    return gh_json([
        "pr", "list", "--repo", owner_repo, "--limit", str(limit),
        "--state", "all", "--json", fields,
    ]) or []


def _lang_name(v: Any) -> str:
    """primaryLanguage is {name, ...}; pull name safely."""
    if isinstance(v, dict):
        return v.get("name") or ""
    return v or ""


def _topics_list(v: Any) -> List[str]:
    """repositoryTopics is a list of {name, ...}."""
    out: List[str] = []
    for t in v or []:
        if isinstance(t, dict):
            n = t.get("name") or t.get("topic")
            if n:
                out.append(n)
        elif isinstance(t, str):
            out.append(t)
    return out


def _normalize_languages(v: Any) -> Dict[str, int]:
    """`gh repo view --json languages` is a list of {size, node: {name}} objects.

    Normalize to {name: bytes} for rendering. Empty input or wrong shape → {}.
    """
    out: Dict[str, int] = {}
    if isinstance(v, dict):
        # Already in the right shape (from /repos/{}/languages API)
        return {str(k): int(val) for k, val in v.items()}
    if not isinstance(v, list):
        return out
    for entry in v:
        if not isinstance(entry, dict):
            continue
        size = entry.get("size")
        node = entry.get("node") or {}
        name = node.get("name") if isinstance(node, dict) else None
        if name and size is not None:
            out[name] = int(size)
    return out


def _license(v: Any) -> str:
    if isinstance(v, dict):
        return v.get("spdxId") or v.get("name") or ""
    return v or ""


def _default_branch(v: Any) -> str:
    if isinstance(v, dict):
        return v.get("name") or ""
    return v or ""


def _user_login(v: Any) -> str:
    if isinstance(v, dict):
        return v.get("login") or ""
    return v or ""


def fmt_languages(lang_dict: Dict[str, int], top: int = 5) -> str:
    if not lang_dict:
        return "-"
    total = sum(lang_dict.values()) or 1
    parts = sorted(lang_dict.items(), key=lambda x: -x[1])[:top]
    return ", ".join(f"{name} {bytes_ * 100 // total}%" for name, bytes_ in parts)


def render_markdown(
    repo: dict,
    open_issues: int,
    issues: list,
    prs: list,
    langs: dict,
) -> str:
    out = []
    name = repo.get("nameWithOwner") or repo.get("name") or ""
    out.append(f"# {name}\n")
    if repo.get("description"):
        out.append(f"> {repo['description']}\n")
    if repo.get("homepageUrl"):
        out.append(f"Homepage: {repo['homepageUrl']}\n")

    out.append("## At a glance\n")
    out.append(f"- **URL:** {repo.get('url', '')}")
    out.append(f"- **Stars:** ⭐ {repo.get('stargazerCount', 0)}")
    out.append(f"- **Forks:** 🍴 {repo.get('forkCount', 0)}")
    out.append(f"- **Watchers:** 👀 {repo.get('watchers') or 0}")
    out.append(f"- **Open issues:** {open_issues}")
    primary = _lang_name(repo.get("primaryLanguage"))
    out.append(f"- **Primary language:** {primary or '-'}")
    out.append(f"- **Languages:** {fmt_languages(langs)}")
    lic = _license(repo.get("licenseInfo"))
    if lic:
        out.append(f"- **License:** {lic}")
    branch = _default_branch(repo.get("defaultBranchRef"))
    if branch:
        out.append(f"- **Default branch:** {branch}")
    out.append(f"- **Created:** {humanize_date(repo.get('createdAt'))}")
    out.append(f"- **Last push:** {humanize_date(repo.get('pushedAt'))}")
    out.append(f"- **Last update:** {humanize_date(repo.get('updatedAt'))}")
    if repo.get("isArchived"):
        out.append("- **Status:** ⚠ archived")
    if repo.get("isFork"):
        out.append("- **Status:** fork")

    topics = _topics_list(repo.get("repositoryTopics"))
    if topics:
        out.append("\n## Topics\n")
        out.append(" ".join(f"`{t}`" for t in topics[:20]))

    rel = repo.get("latestRelease")
    if isinstance(rel, dict):
        out.append("\n## Latest release\n")
        out.append(
            f"- **{rel.get('tagName') or rel.get('name') or '-'}** "
            f"({humanize_date(rel.get('publishedAt'))})"
        )
        if rel.get("url"):
            out.append(f"- {rel['url']}")

    out.append(f"\n## Recent issues ({len(issues)})\n")
    for i in issues[:8]:
        out.append(
            f"- #{i.get('number')} [{i.get('state')}] "
            f"**{i.get('title')}** "
            f"— {humanize_date(i.get('updatedAt'))}"
        )

    out.append(f"\n## Recent PRs ({len(prs)})\n")
    for pr in prs[:8]:
        draft = " (draft)" if pr.get("isDraft") else ""
        out.append(
            f"- #{pr.get('number')} [{pr.get('state')}]{draft} "
            f"**{pr.get('title')}** "
            f"— {humanize_date(pr.get('updatedAt'))}"
        )

    users = [_user_login(u) for u in (repo.get("mentionableUsers") or [])]
    users = [u for u in users if u]
    if users:
        out.append("\n## Mentionable users\n")
        for u in users[:8]:
            out.append(f"- {u}")

    return "\n".join(out) + "\n"


def main() -> int:
    p = argparse.ArgumentParser(
        prog="gh-repo-summary",
        description="One-shot overview of a repository.",
    )
    p.add_argument("repo", nargs="?", default="", help="owner/repo")
    p.add_argument("--issues", type=int, default=8, help="Recent issues to show")
    p.add_argument("--prs", type=int, default=8, help="Recent PRs to show")
    p.add_argument("--no-issues", action="store_true", help="Skip recent issues/PRs")
    p.add_argument("--format", choices=["table", "json", "markdown"])
    p.add_argument("--schema", action="store_true",
                   help="Print the output JSON schema (field contract) and exit.")
    args = p.parse_args()

    if args.schema:
        print_schema("repo_summary.schema.json", "gh-repo-summary")
        return 0

    if not args.repo:
        die("No repo given. Usage: repo_summary.py owner/repo [options]  (or --schema)")

    ensure_auth()
    info(f"fetching repo: {args.repo}")
    repo = fetch_repo(args.repo)
    if not repo:
        die(f"Repo not found or not accessible: {args.repo}")

    issues: List[dict] = []
    prs: List[dict] = []
    if not args.no_issues:
        info("fetching recent issues")
        issues = fetch_recent_issues(args.repo, args.issues)
        info("fetching recent PRs")
        prs = fetch_recent_prs(args.repo, args.prs)

    info("fetching open issues count + languages")
    open_issues = fetch_open_issues_count(args.repo)
    # repo view returns `languages` as [{size, node: {name}}, ...]; normalize it.
    langs = _normalize_languages(repo.get("languages"))
    if not langs:
        # Fallback to /repos/{}/languages which returns {name: bytes} directly
        langs = gh_json(["api", f"/repos/{args.repo}/languages"]) or {}

    fmt = detect_format(args.format)
    if fmt == "json":
        print(json.dumps({
            "repo": repo,
            "open_issues_count": open_issues,
            "languages": langs,
            "recent_issues": issues,
            "recent_prs": prs,
        }, indent=2, ensure_ascii=False))
        return 0

    if fmt == "markdown":
        print(render_markdown(repo, open_issues, issues, prs, langs))
        return 0

    # table — minimal at-a-glance
    name = repo.get("nameWithOwner") or repo.get("name")
    print(f"# {name}")
    if repo.get("description"):
        print(f"> {repo['description']}\n")
    print(f"  URL:           {repo.get('url')}")
    print(f"  Stars:         {repo.get('stargazerCount', 0)}")
    print(f"  Forks:         {repo.get('forkCount', 0)}")
    print(f"  Open issues:   {open_issues}")
    primary = _lang_name(repo.get("primaryLanguage"))
    print(f"  Primary lang:  {primary or '-'}")
    print(f"  Languages:     {fmt_languages(langs)}")
    lic = _license(repo.get("licenseInfo"))
    if lic:
        print(f"  License:       {lic}")
    print(f"  Created:       {humanize_date(repo.get('createdAt'))}")
    print(f"  Last push:     {humanize_date(repo.get('pushedAt'))}")
    topics = _topics_list(repo.get("repositoryTopics"))
    if topics:
        print(f"  Topics:        {', '.join(topics[:10])}")
    if repo.get("isArchived"):
        print("  Status:        ARCHIVED")
    print(f"\n  Recent issues: {len(issues)} shown in markdown output (--format markdown)")
    print(f"  Recent PRs:    {len(prs)} shown in markdown output (--format markdown)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
