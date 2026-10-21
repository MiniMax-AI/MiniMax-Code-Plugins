"""CORE API source for institutional repository papers."""

from __future__ import annotations

import urllib.parse
from pathlib import Path
from typing import Any

from ..network import fetch_json, polite_delay
from ..pdf_utils import download_pdf, is_plausible_pdf_url, dedupe, iter_urls


def is_core_pdf_candidate(url: str) -> bool:
    if not is_plausible_pdf_url(url):
        return False
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    path = parsed.path.lower()
    if "core.ac.uk" in host and "/data-providers/" in path:
        return False
    return True


def extract_core_pdf_candidates(payload: dict[str, Any]) -> list[str]:
    return dedupe(url for url in iter_urls(payload) if is_core_pdf_candidate(url))


def try_core(doi: str, output_path: Path, config: dict[str, Any]) -> dict[str, Any] | None:
    q = urllib.parse.quote(f'doi:"{doi}"')
    url = f"https://api.core.ac.uk/v3/search/works?q={q}&limit=5"
    headers = {}
    if config.get("core_api_key"):
        headers["Authorization"] = f"Bearer {config['core_api_key']}"
    payload = fetch_json(url, config, headers=headers)
    if not payload:
        return None

    candidates = extract_core_pdf_candidates(payload)
    for pdf_url in candidates[: int(config.get("max_core_candidates", 3))]:
        polite_delay(config)
        result = download_pdf(pdf_url, output_path, config, "CORE")
        if result:
            result["doi"] = doi
            result["identifier"] = doi
            return result
    return None
