#!/usr/bin/env python3
"""explore.py — multi-axis topic exploration.

For each axis (a semantic dimension of the topic), run parallel
`gh search repos` queries and group results by axis. The agent decides
what the axes are; this script just executes.

Per design rule: the script is mechanical, no LLM. The agent supplies axes
inline (or via shell alias / agent memory); the script does parallel searches
and groups output, plus soft validation signals (awesome-list cross-check,
cross-axis counts, canonical-anchor recall) to help the agent judge
completeness.

Key search gotchas this script knows about (the agent doesn't have to):
  1. `gh search` OR doesn't behave like you'd expect — `"A OR B"` returns
     0 results. Use `;` (or `OR` with spaces) to split into multiple
     queries; the script will run them and union.
  2. `in:readme` is way more powerful than `in:description` for semantic
     queries — many projects don't self-describe in their short description
     but DO mention the concept in their README. Default to `in:readme`.
  3. `topic:` is unreliable as a hard filter (projects tag themselves
     inconsistently). Prefer `stars:>=` over `topic:`.

Examples:
  # Inline axes (semicolon OR OR-with-spaces splits into multiple queries).
  # Query angles are chosen to be specific enough to skip the 100k+ star
  # general-purpose repos that flood `gh search` and push canonical mid-tier
  # projects out of the top results. Default --limit-per-axis is 20.
  python explore.py "multi-agent" \\
      --axis "framework|multi-agent framework; multi-agent orchestration; collaborative agents" \\
      --axis "protocol|A2A; ANP; agent-to-agent" \\
      --axis "self-eval|self-evolving agent; agent benchmark" \\
      --format markdown

  # OR with spaces is also recognized
  python explore.py "multi-agent" \\
      --axis "framework|multi-agent framework OR multi-agent orchestration OR collaborative agents"

  # Recommended: use in:readme for semantic queries (much more powerful than
  # in:description — many projects don't self-describe in their short desc
  # but DO mention the concept in their README)
  python explore.py "multi-agent" \\
      --axis "framework|multi-agent framework in:readme; collaborative agents in:readme"

  # Piped for further processing
  python explore.py "rag" --axis "framework|haystack OR langchain" \\
      --format json | jq '.axes[].repos[].fullName'

Axis spec format (CLI):
  "name|<queries>"   where <queries> is one or more search strings
                     separated by `;` (or ` OR ` with spaces).
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

from _lib import (
    detect_format,
    die,
    ensure_auth,
    format_table,
    gh_json,
    humanize_date,
    info,
    print_schema,
    warn,
)


# `gh search repos` JSON fields (PLURAL: stargazersCount, forksCount).
REPO_FIELDS = (
    "fullName,description,stargazersCount,forksCount,language,"
    "pushedAt,isArchived,isFork,url"
)

# Cached signal: do these manually-curated top projects appear in any axis?
# Used to give the agent a soft "did we get the well-known names?" signal
# without baking ground truth into the script. Curated at code-write time
# for a handful of canonical fields; not loaded from user-editable files.
# Format: topic-substring -> {set of owner/repo names expected to appear}
CANONICAL_ANCHORS: Dict[str, Set[str]] = {
    "multi-agent": {
        # Major multi-agent frameworks that any reasonable exploration should surface
        "crewAIInc/crewAI",
        "microsoft/autogen",
        "langchain-ai/langgraph",
        "FoundationAgents/MetaGPT",
        "OpenBMB/ChatDev",
        "camel-ai/camel",
        "Significant-Gravitas/AutoGPT",
    },
    "rag": {
        "deepset-ai/haystack",
        "langchain-ai/langchain",
        "run-llama/llama_index",
    },
    "agent": {
        "crewAIInc/crewAI",
        "Significant-Gravitas/AutoGPT",
        "langchain-ai/langgraph",
    },
}


@dataclass
class Axis:
    name: str
    queries: List[str]  # multiple search angles; results are unioned
    limit: int = 5
    min_stars: Optional[int] = None
    language: Optional[str] = None
    topic: Optional[str] = None
    exclude: List[str] = field(default_factory=list)  # generic noise terms

    def build_query(self, q: str) -> str:
        """Compose the actual gh query string for one search angle."""
        parts = [q]
        if self.topic:
            parts.append(f"topic:{self.topic}")
        if self.language:
            parts.append(f"language:{self.language}")
        if self.min_stars is not None:
            parts.append(f"stars:>={self.min_stars}")
        parts.append("fork:false")
        parts.append("archived:false")
        return " ".join(parts)


@dataclass
class AxisResult:
    axis: Axis
    repos: List[Dict[str, Any]] = field(default_factory=list)
    error: Optional[str] = None
    duration_ms: int = 0
    quality: Optional[Dict[str, Any]] = None  # observational metrics, set in main()


def parse_axis_spec(spec: str) -> Axis:
    """Parse 'name|q1[; q2[; q3]...]' from CLI into an Axis.

    The query side can be either a single string, a semicolon-separated list,
    or use `OR` (with spaces) as a synonym for `;`. All variants produce
    multiple search angles that the script will union.
    """
    if "|" not in spec:
        die(f"Invalid --axis spec: {spec!r}. Expected 'name|query'.")
    name, raw = spec.split("|", 1)
    queries = split_query_angles(raw)
    if not queries:
        die(f"Axis {name!r} has no queries in {spec!r}")
    return Axis(name=name.strip(), queries=queries)


def split_query_angles(s: str) -> List[str]:
    """Split a query string into multiple search angles.

    `;` is the explicit separator. ` OR ` (with spaces) is auto-split for
    convenience. Quoted phrases are preserved as-is.
    """
    # First, split on semicolons (explicit)
    pieces: List[str] = []
    for piece in s.split(";"):
        piece = piece.strip()
        if not piece:
            continue
        # Then, within each piece, split on " OR " (with spaces, conservative)
        if " OR " in piece:
            for sub in piece.split(" OR "):
                sub = sub.strip()
                if sub:
                    pieces.append(sub)
        else:
            pieces.append(piece)
    return pieces


def _gh_search_with_retry(args: List[str], max_attempts: int = 3) -> List[dict]:
    """Like gh_json but retries on rate-limit (HTTP 403/429) with backoff.

    Returns [] if all attempts fail. Does NOT sys.exit (so the calling axis
    can keep going and we just record an error for that query angle).
    Runs gh exactly once per attempt — no double subprocess on failure.
    """
    delay = 2.0
    last_err = ""
    for attempt in range(max_attempts):
        try:
            proc = subprocess.run(
                ["gh"] + args, capture_output=True, text=True, timeout=60,
            )
        except FileNotFoundError:
            die("`gh` CLI not found on PATH. Install from https://cli.github.com/")
        except subprocess.TimeoutExpired:
            last_err = "gh command timed out"
            return []
        if proc.returncode == 0:
            out = (proc.stdout or "").strip()
            if not out:
                return []
            try:
                parsed = json.loads(out)
            except json.JSONDecodeError as e:
                last_err = f"bad JSON: {e}"
                return []
            return parsed if isinstance(parsed, list) else []
        # Non-zero: inspect stderr to distinguish rate-limit from other errors.
        err = (proc.stderr or proc.stdout or "").strip()
        last_err = err
        if "rate limit" in err.lower() or "403" in err or "429" in err:
            warn(f"rate limit hit (attempt {attempt+1}/{max_attempts}), "
                 f"sleeping {delay:.0f}s")
            time.sleep(delay)
            delay *= 2
            continue
        return []
    warn(f"giving up after {max_attempts} attempts: {last_err[:80]}")
    return []


def _excluded(repo: Dict[str, Any], exclude: List[str]) -> bool:
    """True if repo's fullName/description contains any exclude term (ci)."""
    if not exclude:
        return False
    hay = f"{repo.get('fullName') or ''} {repo.get('description') or ''}".lower()
    return any(term.lower() in hay for term in exclude)


def _is_awesome_list(repo: Dict[str, Any]) -> bool:
    """Detect curated-list directories (awesome-* repos) as a soft signal."""
    fn = (repo.get("fullName") or "").lower()
    # owner/awesome-... or a bare awesome- prefix in the repo name
    base = fn.split("/")[-1]
    return base.startswith("awesome-") or base == "awesome"


def run_axis(axis: Axis) -> AxisResult:
    """Execute one axis's searches (one per query angle), union results,
    sort by stars, return top N. Safe to call from a thread."""
    started = time.monotonic()
    seen: Dict[str, Dict[str, Any]] = {}
    errors: List[str] = []
    for q in axis.queries:
        full_q = axis.build_query(q)
        repos = _gh_search_with_retry([
            "search", "repos", full_q,
            "--limit", str(axis.limit),
            "--json", REPO_FIELDS,
        ])
        if not repos:
            errors.append(f"q={q!r}: no results (rate limit?)")
        for r in repos:
            fn = r.get("fullName")
            if not fn:
                continue
            if fn not in seen:
                seen[fn] = r
    merged = sorted(seen.values(), key=lambda r: -(r.get("stargazersCount") or 0))
    # Generic noise filter (--exclude): applied post-merge so it works across
    # all query angles of this axis, and on the raw result set regardless of
    # how the query was phrased. Curated-list directories (awesome-*) are
    # tagged (not dropped) so the agent can see they're directories, not
    # projects — useful for resource/topic themes, noise for project themes.
    merged = [r for r in merged if not _excluded(r, axis.exclude)]
    for r in merged:
        if _is_awesome_list(r):
            r["_is_list"] = True
    merged = merged[: axis.limit]
    error_str = "; ".join(errors) if errors else None
    return AxisResult(
        axis=axis, repos=merged, error=error_str,
        duration_ms=int((time.monotonic() - started) * 1000),
    )


# ---------- awesome-list soft signal ----------

# Pattern to find owner/repo in markdown. Matches both:
#   [name](https://github.com/owner/repo)
#   https://github.com/owner/repo  (bare URL)
REPO_LINK_RE = re.compile(
    r'github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)'
)


def fetch_readme(full_name: str, timeout: int = 15) -> str:
    """Fetch a repo's README via the API; return decoded text or ''."""
    try:
        out = subprocess.run(
            ["gh", "api", f"/repos/{full_name}/readme", "--jq", ".content"],
            capture_output=True, text=True, timeout=timeout,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ""
    if out.returncode != 0 or not out.stdout.strip():
        return ""
    b64 = out.stdout.strip().strip('"')
    try:
        return base64.b64decode(b64).decode("utf-8", errors="replace")
    except Exception:
        return ""


def _slug_variants(topic: str) -> List[str]:
    """Generate slug variants for an awesome-list search.

    The awesome list for a multi-word topic might use any natural prefix:
        "self-hosted sso" → awesome-self-hosted-sso, awesome-self-hosted, awesome-sso
        "vector database" → awesome-vector-database, awesome-vector, awesome-vectors
        "ci cd"           → awesome-ci-cd, awesome-cicd, awesome-ci, awesome-cd
    We try the full slug, then progressively shorter prefixes.
    """
    words = topic.lower().split()
    # Drop tiny connector words that don't help naming ("to", "of", "for", ...).
    # Keep "self-hosted" etc. as one unit (it usually appears hyphenated).
    meaningful = [w for w in words if w not in {"a", "the", "of", "for", "in", "on", "and", "or"}]
    if not meaningful:
        meaningful = words
    variants: List[str] = []
    for end in range(len(meaningful), 0, -1):
        slug = "-".join(meaningful[:end])
        if slug not in variants:
            variants.append(slug)
        # Also try the joined-no-dash form
        no_dash = "".join(meaningful[:end])
        if no_dash not in variants:
            variants.append(no_dash)
    # Add the original topic (as the user typed it) and the topic with spaces
    # removed, in case the awesome list uses that exact name.
    for raw in (topic, topic.replace(" ", "")):
        if raw and raw not in variants:
            variants.append(raw)
    return variants


def find_awesome_list(topic: str) -> Optional[str]:
    """Search for an `awesome-<topic>` repo, return its full_name or None.

    Tries many slug variants (full slug, prefixes, no-dash, original) and
    picks the best match by name similarity, not just stars — a popular but
    unrelated awesome list (e.g. awesome-python) shouldn't win over a
    smaller but on-topic one.
    """
    variants = _slug_variants(topic)
    topic_lower = topic.lower().replace(" ", "-")
    topic_words = set(topic_lower.split("-")) - {"a", "the", "of", "for", "in", "on"}

    candidates: Dict[str, Dict[str, Any]] = {}
    for slug in variants:
        query = f"awesome-{slug}"
        try:
            results = gh_json([
                "search", "repos", query,
                "--limit", "3",
                "--json", "fullName,stargazersCount",
            ]) or []
        except SystemExit:
            continue
        for r in results:
            fn = r.get("fullName")
            if fn:
                candidates[fn] = r

    if not candidates:
        return None

    def _score(fn: str, stars: int) -> tuple:
        name = fn.split("/")[-1].lower()
        # Best: name starts with the full topic slug
        full_slug = "-".join(
            w for w in topic.lower().split() if w not in {"a", "the", "of", "for", "in", "on"}
        )
        if name == f"awesome-{full_slug}":
            rel = 100
        elif name.startswith(f"awesome-{full_slug}"):
            rel = 80
        # Good: name contains most topic words
        elif topic_words and sum(1 for w in topic_words if w in name) >= max(1, len(topic_words) - 1):
            rel = 60
        # OK: name starts with awesome- and contains a topic word
        elif name.startswith("awesome-") and any(w in name for w in topic_words):
            rel = 30
        # Weak: just an awesome-* repo
        elif name.startswith("awesome-"):
            rel = 0
        else:
            rel = -1
        # Sort key: relevance desc, stars desc, shorter name first (less generic)
        return (-rel, -stars, len(name))

    best_fn, best_r = min(candidates.items(),
                           key=lambda kv: _score(kv[0], kv[1].get("stargazersCount") or 0))
    # Don't return a weak "just any awesome-*" match — only return if at least
    # one topic word appears in the repo name, or the full slug matches.
    name = best_fn.split("/")[-1].lower()
    full_slug = "-".join(
        w for w in topic.lower().split() if w not in {"a", "the", "of", "for", "in", "on"}
    )
    has_topic_word = any(w in name for w in topic_words)
    if not (name.startswith(f"awesome-{full_slug}") or has_topic_word):
        return None
    return best_fn


def extract_repo_refs(readme_text: str) -> Set[str]:
    """Pull owner/repo pairs out of a README's GitHub links."""
    out: Set[str] = set()
    for m in REPO_LINK_RE.finditer(readme_text):
        owner, repo = m.group(1), m.group(2)
        # Skip self-references and non-repo paths
        if owner in {"sponsors", "orgs", "settings", "apps"}:
            continue
        if repo.endswith(".git") or "#" in repo or "?" in repo:
            repo = repo.split("#")[0].split("?")[0]
            if repo.endswith(".git"):
                repo = repo[:-4]
        out.add(f"{owner}/{repo}")
    return out


def build_awesome_set(topic: str) -> tuple[Optional[str], Set[str]]:
    """Returns (awesome_list_full_name_or_None, set_of_mentioned_repos)."""
    full = find_awesome_list(topic)
    if not full:
        return None, set()
    readme = fetch_readme(full)
    if not readme:
        return full, set()
    repos = extract_repo_refs(readme)
    # The awesome list itself isn't a project, drop it
    repos.discard(full)
    return full, repos


# ---------- annotation ----------

def annotate_results(
    results: List[AxisResult],
    awesome_repos: Set[str],
    canonical_for_topic: Set[str],
) -> None:
    """Mutate each repo dict in-place to add signal fields.

    Adds:
      _cross_axis_count: int — how many axes mention this repo
      _in_awesome: bool — whether the repo is mentioned in the awesome list
      _is_canonical: bool — whether it's in the canonical anchor set for this topic
    """
    # Cross-axis counts
    name_to_axes: Dict[str, List[str]] = {}
    for r in results:
        for repo in r.repos:
            fn = repo.get("fullName")
            if fn:
                name_to_axes.setdefault(fn, []).append(r.axis.name)
    for r in results:
        for repo in r.repos:
            fn = repo.get("fullName") or ""
            repo["_cross_axis_count"] = len(name_to_axes.get(fn, []))
            repo["_in_awesome"] = bool(awesome_repos) and fn in awesome_repos
            repo["_is_canonical"] = bool(canonical_for_topic) and fn in canonical_for_topic


def canonical_anchors_for(topic: str) -> Set[str]:
    """Look up the (small, code-curated) canonical anchor set for a topic."""
    t = topic.lower()
    for key, anchors in CANONICAL_ANCHORS.items():
        if key in t or t in key:
            return anchors
    return set()


def relevance_score(repo: Dict[str, Any]) -> float:
    """Compute a composite relevance score for sorting.

    Order of precedence (highest weight first), so a canonical anchor always
    beats a single-axis star monster regardless of stars:

        _is_canonical:    1_000_000  (known must-include; no penalty if missing)
        _backfilled:      100_000    (anchor only found via API backfill)
        _in_awesome:      10_000     (mentioned by topic's curated awesome list)
        _cross_axis:      * 1000     (each additional axis past first)
        star boost:       log10(stars+1) * 10   (within-tier tiebreaker)

    Tuned so that:
      - cross-axis hits beat single-axis hits even at 100x star difference
      - backfilled canonicals beat awesome-list hits
      - within the same tier, higher stars wins
    """
    s = 0.0
    if repo.get("_is_canonical"):
        s += 1_000_000
    if repo.get("_backfilled"):
        s += 100_000
    if repo.get("_in_awesome"):
        s += 10_000
    if repo.get("_is_list"):
        # Curated-list directories (awesome-*) are directories, not projects:
        # sink them hard (-1000, which even a 100k-star directory can't
        # overcome) so they drop behind every real project in project-discovery
        # themes. They're NOT hard-deleted — if a theme genuinely targets
        # directories (resource roundups), search them directly with
        # find_repos "awesome <topic>" instead of explore axes.
        s -= 1000
    cross = repo.get("_cross_axis_count") or 0
    if cross > 1:
        s += (cross - 1) * 1000
    stars = repo.get("stargazersCount") or 0
    # log10(1)=0, log10(100k)=5, log10(1M)=6 — keeps within-tier scaling sane
    s += math.log10(stars + 1) * 10
    return s


def backfill_canonical(
    results: List[AxisResult], canonical: Set[str]
) -> List[Dict[str, Any]]:
    """Fetch canonical anchors missing from every axis via `gh api`.

    Uses the core quota (5000/hr), NOT the search quota (30/min), so it still
    works right after a search rate-limit. Each fetched repo is tagged
    `_backfilled=True` so output can flag it as an anchor-only inclusion.
    """
    if not canonical:
        return []
    seen = {repo.get("fullName") for r in results for repo in r.repos}
    missing = sorted(canonical - seen)
    if not missing:
        return []
    backfilled: List[Dict[str, Any]] = []
    jq = (
        "{fullName: .full_name, description: .description, "
        "stargazersCount: .stargazers_count, forksCount: .forks_count, "
        "language: .language, pushedAt: .pushed_at, isArchived: .archived, "
        "isFork: .fork, url: .html_url}"
    )
    for fn in missing:
        try:
            out = subprocess.run(
                ["gh", "api", f"/repos/{fn}", "--jq", jq],
                capture_output=True, text=True, timeout=30,
            )
            if out.returncode != 0 or not out.stdout.strip():
                continue
            d = json.loads(out.stdout)
            d["_is_canonical"] = True
            d["_backfilled"] = True
            backfilled.append(d)
        except Exception:
            continue
    return backfilled


# ---------- output ----------


# ---------- axis quality metrics (observational, no verdict) ----------
#
# Three raw, theme-agnostic signals per axis. These are OBSERVATIONAL aids for
# the agent's own judgment, NOT an auto-verdict: validation on real topics
# showed heuristic scoring misfires on semantic themes (in:readme recall makes
# description-term matching unreliable), so we expose raw signals + a template
# hint and let the agent decide.

_QUAL_STOP = {
    "a", "the", "of", "for", "in", "on", "and", "or", "to", "with", "via",
    "from", "using", "ai", "agent", "agents", "system", "systems", "framework",
    "open", "source", "based", "build", "built", "making", "tools", "tool",
    "platform", "review", "survey", "readme", "protocol",
}
_QUAL_QUALIFIER = re.compile(
    r"^(in:|language:|topic:|stars:|pushed:|created:|org:|user:|-|fork:|archived:)"
)


def _significant_terms(queries: List[str]) -> Set[str]:
    """Extract discriminative terms from query angles (drop qualifiers/stopwords).

    Token regex allows digits (A2A, gpt4, R2R…) — [A-Za-z][A-Za-z0-9-]+.
    A hyphenated token is dropped only when ALL dash-segments are stopwords
    or too short: 'agent-to-agent' drops (segments agent/to/agent all stop),
    while 'human-agent' survives (segment 'human' is discriminative).
    """
    terms: Set[str] = set()
    for q in queries:
        for tok in re.findall(r"[A-Za-z][A-Za-z0-9-]+", q):
            t = tok.lower().strip("-")
            if not t or _QUAL_QUALIFIER.match(tok) or len(t) < 3:
                continue
            segs = t.split("-")
            if segs and all(s in _QUAL_STOP or len(s) < 2 for s in segs):
                continue
            terms.add(t)
    return terms


def axis_quality_metrics(axis_result: "AxisResult") -> Dict[str, Any]:
    """Compute raw observational signals for one axis (no aggregate verdict).

    Returns dict with semantic_hit_rate, list_dir_ratio, cross_axis_ratio,
    top3_giant, and a template hint string ('' when clean). The agent reads
    these and decides whether to refine the axis query.
    """
    repos = axis_result.repos
    n = len(repos)
    if n == 0:
        return {
            "semantic_hit_rate": 0.0, "list_dir_ratio": 0.0,
            "cross_axis_ratio": 0.0, "top3_giant": False,
            "hint": "empty axis (0 repos)",
        }
    terms = _significant_terms(axis_result.axis.queries)
    hits = 0
    for r in repos:
        hay = f"{r.get('fullName') or ''} {r.get('description') or ''}".lower()
        if any(t in hay for t in terms):
            hits += 1
    semantic = hits / n
    list_ratio = sum(1 for r in repos if r.get("_is_list")) / n
    cross_ratio = sum(
        1 for r in repos if (r.get("_cross_axis_count") or 1) > 1
    ) / n
    stars = sorted([r.get("stargazersCount") or 0 for r in repos], reverse=True)
    giant = n >= 3 and all(s > 50000 for s in stars[:3])

    hints: List[str] = []
    if list_ratio > 0.3:
        hints.append("目录占比高→加 --exclude awesome/tutorial，或此轴搜的是目录")
    if semantic < 0.2 and not giant:
        hints.append("描述命中查询词偏低→查询可能偏宽，缩到带限定词的具体表述")
    if giant:
        hints.append("top3 全是 5 万+ 巨仓→查询太宽退化为按 star 排序，换更具体语义")
    if cross_ratio < 0.05 and n >= 5:
        hints.append("几乎无跨轴命中→单轴召回，建议此轴与其他轴印证")
    if hints:
        h = "；".join(hints) + "（供判断，非定论）"
    else:
        h = ""

    return {
        "semantic_hit_rate": round(semantic, 2),
        "list_dir_ratio": round(list_ratio, 2),
        "cross_axis_ratio": round(cross_ratio, 2),
        "top3_giant": giant,
        "hint": h,
    }


def signal_tag(repo: Dict[str, Any]) -> str:
    """Render the soft-signal annotations as a short tag string."""
    n = repo.get("_cross_axis_count") or 0
    in_a = repo.get("_in_awesome")
    is_c = repo.get("_is_canonical")
    parts = []
    if n > 1:
        parts.append(f"↻{n}axes")
    if in_a:
        parts.append("✓awesome")
    if is_c:
        parts.append("★canonical")
    if repo.get("_is_list"):
        parts.append("☰list")
    if repo.get("_backfilled"):
        parts.append("⚑backfilled")
    return " · ".join(parts)


def render_markdown(
    topic: str,
    results: List[AxisResult],
    awesome_full: Optional[str],
    canonical: Set[str],
) -> str:
    """Layered summary view: signal tiers first, full data written to disk.

    Stdout content budget: ~2KB regardless of result size. Full per-repo
    markdown (descriptions, all 20-per-axis entries, raw signals) is written
    to a temp file so the agent can deep-read on demand via read_file.

    Tiers, in order:
      ★ canonical       known must-includes (sorted by score)
      ↻ cross-axis 2+   appeared in 2+ axes (strong relevance signal)
      top 5 per axis    first-look fallback per dimension
    """
    out: List[str] = [f"# Topic exploration: `{topic}`\n"]
    total_repos = sum(len(r.repos) for r in results)
    out.append(f"**{len(results)} axes · {total_repos} repos**")
    if awesome_full:
        out.append(
            f"  \n_awesome list reference: "
            f"[{awesome_full}](https://github.com/{awesome_full})_"
        )
    if canonical:
        found = len({
            repo.get("fullName")
            for r in results for repo in r.repos
            if repo.get("_is_canonical")
        })
        out.append(
            f"\n_canonical-anchor recall: {found}/{len(canonical)} "
            f"(see `★canonical` flag below — if low, results are likely incomplete)_"
        )
    out.append("")

    # Collect all unique repos with annotations for tiered view
    seen: Dict[str, Dict[str, Any]] = {}
    for r in results:
        for repo in r.repos:
            fn = repo.get("fullName")
            if fn and fn not in seen:
                seen[fn] = repo
            elif fn:
                # Merge: prefer the entry with stronger score
                if relevance_score(repo) > relevance_score(seen[fn]):
                    seen[fn] = repo

    def fmt_line(repo: Dict[str, Any]) -> str:
        name = repo.get("fullName", "")
        url = repo.get("url", "")
        stars = repo.get("stargazersCount", 0)
        lang = repo.get("language") or "-"
        tag = signal_tag(repo)
        tag_str = f"  · *{tag}*" if tag else ""
        return f"- **[{name}]({url})**  ⭐{stars}  📝{lang}{tag_str}"

    # Tier 1: canonical anchors (always shown)
    canon_repos = sorted(
        (r for r in seen.values() if r.get("_is_canonical")),
        key=lambda r: -relevance_score(r),
    )
    if canon_repos:
        out.append("\n## ★ canonical anchors\n")
        for repo in canon_repos:
            out.append(fmt_line(repo))

    # Tier 2: cross-axis (2+) hits — strong signal, deduped
    cross_repos = sorted(
        (r for r in seen.values()
         if (r.get("_cross_axis_count") or 0) >= 2
         and not r.get("_is_canonical")),
        key=lambda r: -relevance_score(r),
    )
    if cross_repos:
        out.append(f"\n## ↻ cross-axis hits ({len(cross_repos)})\n")
        for repo in cross_repos[:15]:
            out.append(fmt_line(repo))
        if len(cross_repos) > 15:
            out.append(f"_... {len(cross_repos) - 15} more in full report_")

    # Tier 3: top 5 per axis (excluding already-shown repos)
    shown = {r.get("fullName") for r in canon_repos + cross_repos[:15]}
    out.append("\n## top 5 per axis\n")
    for r in results:
        if r.error or not r.repos:
            continue
        # Repos already shown in tiers 1-2 are filtered out per axis
        axis_unique = [x for x in r.repos if x.get("fullName") not in shown]
        if not axis_unique:
            continue
        top = sorted(axis_unique, key=lambda x: -relevance_score(x))[:5]
        if not top:
            continue
        out.append(f"\n### {r.axis.name}{_quality_line(r)}\n")
        for repo in top:
            out.append(fmt_line(repo))
        shown.update(x.get("fullName") for x in top)

    return "\n".join(out) + "\n"


def _quality_line(r: AxisResult) -> str:
    """One-line observational quality note for an axis in markdown output."""
    q = r.quality or {}
    if not q or not r.repos:
        return ""
    bits = []
    if q.get("top3_giant"):
        bits.append("top3 全是巨仓")
    if q.get("list_dir_ratio", 0) > 0.3:
        bits.append(f"目录占比 {q['list_dir_ratio']:.0%}")
    if q.get("semantic_hit_rate", 0) < 0.2 and not q.get("top3_giant"):
        bits.append(f"描述命中率 {q['semantic_hit_rate']:.0%}")
    if q.get("cross_axis_ratio", 0) < 0.05 and len(r.repos) >= 5:
        bits.append("几乎无跨轴命中")
    if not bits:
        return ""
    return f"\n<sup>质量观察（供判断，非定论）：{'；'.join(bits)}</sup>\n"


def render_full(
    topic: str,
    results: List[AxisResult],
    awesome_full: Optional[str],
    canonical: Set[str],
) -> str:
    """Full per-axis markdown with descriptions. Goes to disk, not stdout."""
    out: List[str] = [f"# Topic exploration: `{topic}` (FULL)\n"]
    total_repos = sum(len(r.repos) for r in results)
    out.append(f"**{len(results)} axes · {total_repos} repos**")
    if awesome_full:
        out.append(
            f"  \n_awesome list reference: "
            f"[{awesome_full}](https://github.com/{awesome_full})_"
        )
    if canonical:
        found = len({
            repo.get("fullName")
            for r in results for repo in r.repos
            if repo.get("_is_canonical")
        })
        out.append(
            f"\n_canonical-anchor recall: {found}/{len(canonical)}_"
        )
    out.append("")

    for r in results:
        # Sort repos within each axis by score so readers see best first
        sorted_repos = sorted(r.repos, key=lambda x: -relevance_score(x))
        out.append(f"\n## {r.axis.name}  ({len(sorted_repos)} repos){_quality_line(r)}\n")
        if r.error:
            out.append(f"_error: {r.error}_\n")
            continue
        if not sorted_repos:
            out.append("_(no results)_\n")
            continue
        for repo in sorted_repos:
            name = repo.get("fullName", "")
            url = repo.get("url", "")
            stars = repo.get("stargazersCount", 0)
            lang = repo.get("language") or "-"
            pushed = humanize_date(repo.get("pushedAt"))
            tag = signal_tag(repo)
            tag_str = f"  · *{tag}*" if tag else ""
            out.append(
                f"- **[{name}]({url})**  ⭐{stars}  📝{lang}  "
                f"pushed {pushed}{tag_str}"
            )
            if repo.get("description"):
                out.append(f"  {repo['description'][:140]}")
    return "\n".join(out) + "\n"


def render_table(results: List[AxisResult]) -> str:
    def _axis_label(r: AxisResult) -> str:
        """Axis name + compact quality markers (observational, no verdict)."""
        q = r.quality or {}
        if not r.repos:
            return r.axis.name
        parts = [r.axis.name]
        if q.get("list_dir_ratio", 0) > 0.3:
            parts.append("☰d")
        if q.get("top3_giant"):
            parts.append("⇧巨仓")
        if (q.get("semantic_hit_rate", 0) < 0.2
                and not q.get("top3_giant")
                and len(r.repos) >= 3):
            parts.append("低命中")
        return " ".join(parts)

    rows: List[Dict[str, Any]] = []
    for r in results:
        if r.error:
            rows.append({"axis": _axis_label(r), "name": "(error)", "stars": 0,
                         "lang": "-", "pushed": "-", "desc": r.error,
                         "sig": "-"})
            continue
        if not r.repos:
            rows.append({"axis": _axis_label(r), "name": "(no results)", "stars": 0,
                         "lang": "-", "pushed": "-", "desc": "-", "sig": "-"})
            continue
        for repo in r.repos:
            rows.append({
                "axis": _axis_label(r),
                "name": repo.get("fullName", ""),
                "stars": repo.get("stargazersCount", 0),
                "lang": repo.get("language") or "-",
                "pushed": humanize_date(repo.get("pushedAt")),
                "desc": repo.get("description") or "",
                "sig": signal_tag(repo) or "-",
            })
    # Quality hints → stderr so stdout stays parseable.
    for r in results:
        q = r.quality or {}
        if q.get("hint"):
            warn(f"axis '{r.axis.name}' quality: {q['hint']}")
    return format_table(
        rows,
        [
            ("axis", "Axis", 22),
            ("name", "Repository", 36),
            ("stars", "⭐", 7),
            ("lang", "Lang", 10),
            ("pushed", "Pushed", 10),
            ("sig", "Signals", 22),
            ("desc", "Description", 60),
        ],
    )


# ---------- main ----------

def main() -> int:
    p = argparse.ArgumentParser(
        prog="explore",
        description=(
            "Multi-axis topic exploration: run parallel searches along "
            "agent-defined semantic dimensions and group results by axis. "
            "Outputs soft validation signals (awesome list, cross-axis, "
            "canonical anchors) for the agent to judge completeness."
        ),
    )
    p.add_argument("topic", nargs="?", default="",
                   help="Topic name (used as label, not searched).")
    p.add_argument("--axis", action="append", default=[],
                   help="Axis spec 'name|query' (repeatable).")
    p.add_argument("--limit-per-axis", type=int, default=20,
                   help="Default limit per axis (default 20). "
                        "With star-sort + high-volume general projects in the "
                        "result set, 8 misses canonical mid-tier projects; 20 is "
                        "the empirical sweet spot for gh search repos.")
    p.add_argument("--min-stars", type=int, default=None,
                   help="Default min stars for inline --axis specs.")
    p.add_argument("--max-workers", type=int, default=2,
                   help="Parallel axis searches (default 2). "
                        "GitHub search API allows 30 calls/minute authenticated; "
                        "default 2 keeps multi-axis searches safely under that. "
                        "Lower to 1 if you still hit 403/429 rate limits.")
    p.add_argument("--awesome", action="store_true",
                   help="Enable awesome-list soft validation (off by default "
                        "to save API quota).")
    p.add_argument("--full", action="store_true",
                   help="Print the full per-axis markdown to stdout instead "
                        "of the layered summary. The full report is also "
                        "always written to a temp file (see --output).")
    p.add_argument("--output", default=None, metavar="PATH",
                   help="Where to write the full markdown report. Default: "
                        "auto-named file under $TMPDIR. Implies --full.")
    p.add_argument("--exclude", action="append", default=[],
                   help="Exclude repos whose fullName or description contains "
                        "this term (case-insensitive, substring match). "
                        "Repeatable. Generic noise filter — e.g. "
                        "--exclude awesome to drop curated-list directories, "
                        "--exclude tutorial/demo to drop teaching repos.")
    p.add_argument("--format", choices=["table", "json", "markdown"])
    p.add_argument("--schema", action="store_true",
                   help="Print the output JSON schema (field contract) and exit.")
    args = p.parse_args()

    if args.schema:
        print_schema("explore.schema.json", "explore")
        return 0

    axes: List[Axis] = []
    for spec in args.axis:
        a = parse_axis_spec(spec)
        a.limit = args.limit_per_axis
        if a.min_stars is None:
            a.min_stars = args.min_stars
        a.exclude = list(args.exclude)
        axes.append(a)

    if not axes:
        die("Provide axes via --axis (repeatable).")

    ensure_auth()
    info(f"exploring '{args.topic}' across {len(axes)} axes")

    # Run axes in parallel
    results: List[AxisResult] = []
    with ThreadPoolExecutor(max_workers=args.max_workers) as ex:
        futs = {ex.submit(run_axis, ax): ax for ax in axes}
        for fut in as_completed(futs):
            r = fut.result()
            results.append(r)
            if r.error:
                warn(f"axis '{r.axis.name}': {r.error}")

    # Preserve original axis order
    order = {ax.name: i for i, ax in enumerate(axes)}
    results.sort(key=lambda r: order.get(r.axis.name, 999))

    # Awesome-list soft signal (off by default to save API quota)
    awesome_full: Optional[str] = None
    awesome_repos: Set[str] = set()
    if args.awesome:
        info("scanning awesome list for soft validation")
        awesome_full, awesome_repos = build_awesome_set(args.topic)
        if awesome_full:
            info(f"awesome list: {awesome_full} ({len(awesome_repos)} repos referenced)")
        else:
            warn("no awesome list found for topic; signals will be weaker")

    canonical = canonical_anchors_for(args.topic)

    annotate_results(results, awesome_repos, canonical)

    # Backfill canonical anchors that no axis surfaced (uses core API quota,
    # so it works even right after a search rate limit).
    backfilled = backfill_canonical(results, canonical)
    if backfilled:
        info(f"backfilled {len(backfilled)} missing canonical anchor(s) via API")
        results.append(AxisResult(
            axis=Axis(name="anchor-backfill (canonical)", queries=[]),
            repos=backfilled,
        ))

    # Observational quality metrics per axis (no verdict; agent decides).
    for r in results:
        r.quality = axis_quality_metrics(r)

    fmt = detect_format(args.format)
    if fmt == "json":
        print(json.dumps(
            {
                "topic": args.topic,
                "awesome_list": awesome_full,
                "awesome_repo_count": len(awesome_repos),
                "canonical_anchors": sorted(canonical),
                "axes": [
                    {
                        "name": r.axis.name,
                        "queries": r.axis.queries,
                        "effective_queries": [
                            r.axis.build_query(q) for q in r.axis.queries
                        ],
                        "duration_ms": r.duration_ms,
                        "error": r.error,
                        "quality": r.quality,
                        "repos": r.repos,
                    }
                    for r in results
                ],
            },
            indent=2, ensure_ascii=False,
        ))
        return 0

    if fmt == "markdown":
        full_md = render_full(args.topic, results, awesome_full, canonical)

        # Resolve target path
        if args.output:
            out_path = args.output
        else:
            slug = re.sub(r"[^A-Za-z0-9_-]+", "-", args.topic).strip("-") or "topic"
            ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
            out_path = os.path.join(
                tempfile.gettempdir(),
                f"gh-explore-{slug}-{ts}.md",
            )

        try:
            with open(out_path, "w", encoding="utf-8") as fh:
                fh.write(full_md)
        except Exception as e:
            warn(f"could not write full report to {out_path}: {e}")
            out_path = None

        # Choose stdout content based on --full
        if args.full:
            print(full_md)
        else:
            print(render_markdown(args.topic, results, awesome_full, canonical))

        if out_path:
            info(
                f"full report: {len(full_md)} bytes → {out_path}\n"
                f"  (read with read_file or any markdown viewer)"
            )
        return 0

    print(render_table(results))
    total = sum(len(r.repos) for r in results)
    print(
        f"\n{len(results)} axes · {total} repos"
        + (f" · awesome={awesome_full or 'none'}" if awesome_full else ""),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
