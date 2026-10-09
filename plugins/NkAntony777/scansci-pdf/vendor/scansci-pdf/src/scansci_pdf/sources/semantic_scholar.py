"""Semantic Scholar Open Access API source."""

from __future__ import annotations

import logging
import time
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import requests

from ..network import fetch_json, polite_delay
from ..pdf_utils import download_pdf, is_plausible_pdf_url

logger = logging.getLogger(__name__)

S2_API = "https://api.semanticscholar.org/graph/v1"
S2_FIELDS = "title,authors,year,abstract,externalIds,journal,citationCount,url"
_MAX_RETRIES = 3


@dataclass
class SearchResult:
    """A single search result from Semantic Scholar."""

    title: str = ""
    authors: list[str] = field(default_factory=list)
    year: int | None = None
    abstract: str = ""
    doi: str = ""
    arxiv_id: str = ""
    journal: str = ""
    citation_count: int = 0
    s2_url: str = ""
    paper_id: str = ""


def _s2_request(url: str, params: dict) -> dict | None:
    """Make a GET request to Semantic Scholar with retry on 429."""
    for attempt in range(_MAX_RETRIES):
        try:
            resp = requests.get(url, params=params, timeout=15)
            if resp.status_code == 404:
                return None
            if resp.status_code == 429:
                wait = 2 ** (attempt + 1)
                logger.warning("Rate limited by Semantic Scholar, retrying in %ds...", wait)
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            logger.warning("Semantic Scholar request failed: %s", e)
            if attempt < _MAX_RETRIES - 1:
                time.sleep(2)
            else:
                return None
    return None


def _parse_paper(item: dict) -> SearchResult:
    """Parse a Semantic Scholar API response item into a SearchResult."""
    ext_ids = item.get("externalIds") or {}
    authors_data = item.get("authors") or []
    journal_data = item.get("journal") or {}
    return SearchResult(
        title=item.get("title", ""),
        authors=[a.get("name", "") for a in authors_data if a.get("name")],
        year=item.get("year"),
        abstract=item.get("abstract") or "",
        doi=ext_ids.get("DOI", ""),
        arxiv_id=ext_ids.get("ArXiv", ""),
        journal=journal_data.get("name", "") if isinstance(journal_data, dict) else str(journal_data),
        citation_count=item.get("citationCount", 0),
        s2_url=item.get("url", ""),
        paper_id=item.get("paperId", ""),
    )


def search(
    query: str,
    limit: int = 10,
    year_range: str | None = None,
    fields_of_study: list[str] | None = None,
) -> list[SearchResult]:
    """Search for papers on Semantic Scholar."""
    params = {
        "query": query,
        "limit": min(limit, 100),
        "fields": S2_FIELDS,
    }
    if year_range:
        params["year"] = year_range
    if fields_of_study:
        params["fieldsOfStudy"] = ",".join(fields_of_study)

    data = _s2_request(f"{S2_API}/paper/search", params)
    if data is None:
        return []
    return [_parse_paper(item) for item in data.get("data", [])]


def get_paper(paper_id: str) -> SearchResult | None:
    """Get details for a specific paper by Semantic Scholar ID or DOI.

    paper_id: S2 paper ID, DOI (prefix with "DOI:"), or arXiv ID (prefix with "ARXIV:").
    """
    item = _s2_request(f"{S2_API}/paper/{paper_id}", {"fields": S2_FIELDS})
    if item is None:
        return None
    return _parse_paper(item)


def try_semanticscholar(doi: str, output_path: Path, config: dict[str, Any]) -> dict[str, Any] | None:
    q = urllib.parse.quote(doi, safe="")
    url = f"https://api.semanticscholar.org/graph/v1/paper/DOI:{q}?fields=openAccessPdf,externalIds"
    payload = fetch_json(url, config)
    if not payload:
        return None

    oa_pdf = payload.get("openAccessPdf")
    if isinstance(oa_pdf, dict):
        pdf_url = oa_pdf.get("url", "")
        if pdf_url and is_plausible_pdf_url(pdf_url):
            polite_delay(config)
            result = download_pdf(pdf_url, output_path, config, "SemanticScholar")
            if result:
                result["doi"] = doi
                result["identifier"] = doi
                return result

    ext_ids = payload.get("externalIds", {})
    if isinstance(ext_ids, dict):
        arxiv_id = ext_ids.get("ArXiv")
        if arxiv_id:
            arxiv_url = f"https://arxiv.org/pdf/{arxiv_id}.pdf"
            polite_delay(config)
            result = download_pdf(arxiv_url, output_path, config, "SemanticScholar(arXiv)", require_pdf_like_url=False)
            if result:
                result["doi"] = doi
                result["identifier"] = doi
                return result

    return None
