"""Title-to-DOI resolver via OpenAlex search with similarity matching."""

from __future__ import annotations

import logging
import time
from difflib import SequenceMatcher
from typing import Any

from .paperlist import PaperEntry

log = logging.getLogger(__name__)

TITLE_SIMILARITY_THRESHOLD = 0.75


def resolve_title_to_doi(title: str, config: dict[str, Any]) -> str | None:
    """Search OpenAlex by title and return best-matching DOI."""
    from .network import _get_session, request_timeout
    from .search import _reconstruct_abstract

    if not title or len(title) < 10:
        return None

    try:
        session = _get_session(config)
        resp = session.get(
            "https://api.openalex.org/works",
            params={"search": title, "per_page": 5},
            timeout=request_timeout(config),
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
    except Exception as exc:
        log.debug("Title search failed for '%s': %s", title[:50], exc)
        return None

    best_doi = None
    best_score = 0.0
    title_lower = title.lower().strip()

    for work in data.get("results", []):
        result_title = (work.get("title") or "").lower().strip()
        if not result_title:
            continue
        score = SequenceMatcher(None, title_lower, result_title).ratio()
        if score > best_score:
            best_score = score
            doi_raw = work.get("doi", "") or ""
            best_doi = doi_raw.replace("https://doi.org/", "") if doi_raw else None

    if best_score >= TITLE_SIMILARITY_THRESHOLD and best_doi:
        log.info("Resolved title '%s...' → %s (score=%.2f)", title[:40], best_doi, best_score)
        return best_doi

    log.debug("No match for '%s...' (best score=%.2f)", title[:40], best_score)
    return None


def batch_resolve(
    entries: list[PaperEntry],
    config: dict[str, Any],
    delay: float = 0.3,
) -> dict[str, Any]:
    """Batch resolve: fix DOI format + search by title for missing DOIs.

    Returns dict with 'entries' (resolved list) and 'stats'.
    """
    total = len(entries)
    fixed_unicode = 0
    resolved_by_title = 0
    already_has_doi = 0
    unresolvable = 0

    for i, entry in enumerate(entries):
        if entry.doi:
            already_has_doi += 1
            continue

        if not entry.title:
            unresolvable += 1
            continue

        # Search by title
        doi = resolve_title_to_doi(entry.title, config)
        if doi:
            entry.doi = doi
            resolved_by_title += 1
        else:
            unresolvable += 1

        # Rate limit for OpenAlex API
        if delay > 0 and i < total - 1:
            time.sleep(delay)

    return {
        "entries": entries,
        "stats": {
            "total": total,
            "already_has_doi": already_has_doi,
            "resolved_by_title": resolved_by_title,
            "unresolvable": unresolvable,
        },
    }
