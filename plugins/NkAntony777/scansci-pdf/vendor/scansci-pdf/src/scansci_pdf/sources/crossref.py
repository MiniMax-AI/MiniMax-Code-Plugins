"""Crossref API source for publisher PDF links + page scraping."""

from __future__ import annotations

import re
import urllib.parse
from pathlib import Path
from typing import Any

import requests

from ..network import fetch_json, polite_delay, USER_AGENT, request_timeout, proxy_dict, select_proxy_for_url
from ..pdf_utils import download_pdf, is_pdf_file, success, _response_looks_pdf, is_plausible_pdf_url


def try_crossref(doi: str, output_path: Path, config: dict[str, Any]) -> dict[str, Any] | None:
    """Try Crossref API link field for direct PDF."""
    q = urllib.parse.quote(doi, safe="")
    url = f"https://api.crossref.org/works/{q}"
    try:
        payload = fetch_json(url, config, headers={"Accept": "application/json"})
        if not payload:
            return None
        message = payload.get("message", {})
        links = message.get("link", [])
        if not isinstance(links, list):
            links = [links]
        for link in links:
            if not isinstance(link, dict):
                continue
            content_type = link.get("content-type", "")
            link_url = link.get("URL", "")
            if "application/pdf" in content_type and link_url:
                polite_delay(config)
                result = download_pdf(link_url, output_path, config, "Crossref")
                if result:
                    result["doi"] = doi
                    result["identifier"] = doi
                    return result
    except Exception:
        pass
    return None


def try_crossref_page_scrape(doi: str, output_path: Path, config: dict[str, Any]) -> dict[str, Any] | None:
    """Resolve publisher landing page and scrape for PDF links.

    Inspired by PyPaperRetriever's approach:
    1. Resolve DOI → publisher page via doi.org redirect
    2. Scan <a> tags for .pdf hrefs
    3. Regex for JS-based redirects (window.open, href=, location=)
    4. Check data-pdf-url attributes
    """
    try:
        # Step 1: Resolve DOI to publisher URL
        polite_delay(config)
        s = requests.Session()
        s.trust_env = False
        s.headers.update({"User-Agent": USER_AGENT})
        doi_resp = s.head(f"https://doi.org/{doi}", allow_redirects=True,
                          timeout=10)
        if doi_resp.status_code >= 400:
            return None
        publisher_url = doi_resp.url

        # Step 2: Fetch publisher page
        polite_delay(config)
        page_resp = s.get(publisher_url, timeout=15, allow_redirects=True)
        if page_resp.status_code >= 400:
            return None

        html = page_resp.text
        base_url = page_resp.url

        # Step 3: Extract PDF URLs using multiple strategies
        pdf_candidates = _extract_pdf_urls(html, base_url)

        # Step 4: Try each candidate
        for pdf_url in pdf_candidates:
            try:
                polite_delay(config)
                result = download_pdf(pdf_url, output_path, config, "CrossrefPage",
                                     require_pdf_like_url=False)
                if result:
                    result["doi"] = doi
                    result["identifier"] = doi
                    return result
            except Exception:
                continue
    except Exception:
        pass
    return None


def _extract_pdf_urls(html: str, base_url: str) -> list[str]:
    """Extract candidate PDF URLs from publisher page HTML."""
    candidates: list[str] = []

    # Strategy 1: <a> tags with href ending in .pdf
    for match in re.finditer(r'href=["\']([^"\']*?\.pdf[^"\']*?)["\']', html, re.IGNORECASE):
        url = _resolve_url(match.group(1), base_url)
        if url:
            candidates.append(url)

    # Strategy 2: <a> tags with /pdf in path
    for match in re.finditer(r'href=["\']([^"\']*?/pdf[^"\']*?)["\']', html, re.IGNORECASE):
        url = _resolve_url(match.group(1), base_url)
        if url and url not in candidates:
            candidates.append(url)

    # Strategy 3: /article/file patterns (PLOS, Frontiers, etc.)
    for match in re.finditer(r'href=["\']([^"\']*?/article/file[^"\']*?)["\']', html, re.IGNORECASE):
        url = _resolve_url(match.group(1), base_url)
        if url and url not in candidates:
            candidates.append(url)

    # Strategy 4: type=printable or format=pdf in query
    for match in re.finditer(r'href=["\']([^"\']*?(?:type=printable|format=pdf)[^"\']*?)["\']', html, re.IGNORECASE):
        url = _resolve_url(match.group(1), base_url)
        if url and url not in candidates:
            candidates.append(url)

    # Strategy 5: data-pdf-url attribute
    for match in re.finditer(r'data-pdf[^=]*=["\']([^"\']+?)["\']', html, re.IGNORECASE):
        url = _resolve_url(match.group(1), base_url)
        if url and url not in candidates:
            candidates.append(url)

    # Strategy 6: JS-based redirects (window.open, location=, href=)
    js_patterns = [
        r'window\.open\(["\']([^"\']*?\.pdf[^"\']*?)["\']',
        r'(?:location|href)\s*=\s*["\']([^"\']*?\.pdf[^"\']*?)["\']',
    ]
    for pattern in js_patterns:
        for match in re.finditer(pattern, html, re.IGNORECASE):
            url = _resolve_url(match.group(1), base_url)
            if url and url not in candidates and is_plausible_pdf_url(url):
                candidates.append(url)

    # Strategy 7: <embed> or <iframe> with PDF src
    for match in re.finditer(r'<(?:embed|iframe)[^>]*src=["\']([^"\']*?\.pdf[^"\']*?)["\']', html, re.IGNORECASE):
        url = _resolve_url(match.group(1), base_url)
        if url and url not in candidates:
            candidates.append(url)

    return candidates


def _resolve_url(url: str, base_url: str) -> str | None:
    """Resolve relative URL to absolute, validate scheme."""
    if not url:
        return None
    try:
        resolved = urllib.parse.urljoin(base_url, url)
        parsed = urllib.parse.urlparse(resolved)
        if parsed.scheme not in ("http", "https"):
            return None
        return resolved
    except Exception:
        return None
