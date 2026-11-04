"""OA discovery sources: OpenAIRE, DOAJ.

These APIs find OA versions of papers that may not be indexed by Unpaywall/OpenAlex.
"""

from __future__ import annotations

import urllib.parse
from pathlib import Path
from typing import Any

import requests

from ..network import polite_delay, USER_AGENT, request_timeout, proxy_dict, select_proxy_for_url
from ..pdf_utils import download_pdf, is_plausible_pdf_url


def try_openaire(doi: str, output_path: Path, config: dict[str, Any]) -> dict[str, Any] | None:
    """Try OpenAIRE API for OA PDF.

    OpenAIRE aggregates European open access publications.
    Extracts PDF URLs from children records (DOAJ, PMC, etc.).
    """
    q = urllib.parse.quote(doi, safe="")
    url = f"https://api.openaire.eu/search/publications?doi={q}&format=json"
    try:
        polite_delay(config)
        s = requests.Session()
        s.trust_env = False
        s.headers.update({"User-Agent": USER_AGENT})
        resp = s.get(url, timeout=request_timeout(config),
                     proxies=proxy_dict(select_proxy_for_url(url, config)))
        if resp.status_code >= 400:
            return None

        data = resp.json()
        results = data.get("response", {}).get("results", {})
        if not results:
            return None

        publications = results.get("result", [])
        if isinstance(publications, dict):
            publications = [publications]

        for pub in publications:
            main = pub.get("metadata", {}).get("oaf:entity", {}).get("oaf:result", {})
            if not main:
                continue

            # Check access right
            access_right = main.get("bestaccessright", {})
            if isinstance(access_right, dict):
                if access_right.get("classid", "") != "OPEN":
                    continue

            # Extract URLs from children records
            children = main.get("children", {})
            child_results = children.get("result", [])
            if isinstance(child_results, dict):
                child_results = [child_results]

            for child in child_results:
                instance = child.get("instance", {})
                # Check for direct URL
                url_obj = instance.get("url", {})
                child_url = url_obj.get("$", "") if isinstance(url_obj, dict) else ""
                if child_url and child_url.startswith("http"):
                    polite_delay(config)
                    result = download_pdf(child_url, output_path, config, "OpenAIRE",
                                         require_pdf_like_url=False)
                    if result:
                        result["doi"] = doi
                        result["identifier"] = doi
                        return result

                # Check webresource URL
                webres = instance.get("webresource", {})
                if isinstance(webres, dict):
                    wr_url = webres.get("url", {})
                    child_url = wr_url.get("$", "") if isinstance(wr_url, dict) else ""
                    if child_url and child_url.startswith("http"):
                        polite_delay(config)
                        result = download_pdf(child_url, output_path, config, "OpenAIRE",
                                             require_pdf_like_url=False)
                        if result:
                            result["doi"] = doi
                            result["identifier"] = doi
                            return result
    except Exception:
        pass
    return None


def try_doaj(doi: str, output_path: Path, config: dict[str, Any]) -> dict[str, Any] | None:
    """Try DOAJ (Directory of Open Access Journals) for OA PDF.

    DOAJ indexes 20,000+ OA journals.
    API: https://doaj.org/api/v2/search/articles/doi:{doi}
    """
    url = f"https://doaj.org/api/v2/search/articles/doi:{doi}"
    try:
        polite_delay(config)
        s = requests.Session()
        s.trust_env = False
        s.headers.update({"User-Agent": USER_AGENT})
        resp = s.get(url, timeout=request_timeout(config),
                     proxies=proxy_dict(select_proxy_for_url(url, config)))
        if resp.status_code >= 400:
            return None

        data = resp.json()
        results = data.get("results", [])
        if not results:
            return None

        for item in results:
            bibjson = item.get("bibjson", {})

            # Check link field for fulltext URLs
            links = bibjson.get("link", [])
            for link in links:
                if isinstance(link, dict):
                    link_url = link.get("url", "")
                    link_type = link.get("type", "")
                    if link_type == "fulltext" and link_url and link_url.startswith("http"):
                        polite_delay(config)
                        dl_result = download_pdf(link_url, output_path, config, "DOAJ",
                                                require_pdf_like_url=False)
                        if dl_result:
                            dl_result["doi"] = doi
                            dl_result["identifier"] = doi
                            return dl_result
    except Exception:
        pass
    return None
