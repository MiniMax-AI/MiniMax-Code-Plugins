"""LibGen source with multi-mirror failover."""

from __future__ import annotations

import re
import time
import urllib.parse
from pathlib import Path
from typing import Any

from ..network import fetch, polite_delay
from ..pdf_utils import download_pdf

LIBGEN_MIRRORS = [
    "https://libgen.li",
    "https://libgen.bz",
    "https://libgen.gs",
    "https://libgen.rs",
    "https://libgen.st",
]


def try_libgen(doi: str, output_path: Path, config: dict[str, Any], use_tor: bool = False) -> dict[str, Any] | None:
    q = urllib.parse.quote(doi, safe="")
    for mirror in LIBGEN_MIRRORS:
        result = _try_libgen_mirror(doi, q, mirror, output_path, config, use_tor=use_tor)
        if result:
            return result
    return None


def _try_libgen_mirror(
    doi: str, q: str, mirror: str, output_path: Path, config: dict[str, Any], use_tor: bool = False
) -> dict[str, Any] | None:
    url = f"{mirror}/ads.php?doi={q}"
    # Slow-CDN lane: floor the timeouts (users run 3/7s for source racing —
    # the booksdl CDN drips and 503s) and allow a longer stream deadline.
    config = {
        **config,
        "connect_timeout": max(int(config.get("connect_timeout", 3)), 10),
        "read_timeout": max(int(config.get("read_timeout", 7)), 30),
        "download_deadline_seconds": max(int(config.get("download_deadline_seconds", 60)), 180),
    }
    # The li/bz frontends serve EMPTY 200 responses (Content-Length: 0) to
    # cookieless one-shot requests — the flow then finds no get.php link and
    # silently misses. Warm a session on the homepage first and hit ads.php
    # with its cookies + Referer; the page then renders normally
    # (field-verified 2026-09: li via proxy, bz also direct).
    try:
        import requests

        from ..network import USER_AGENT

        session = requests.Session()
        session.trust_env = False
        session.headers.update({"User-Agent": USER_AGENT})
        proxy = str(config.get("network_proxy", "") or "")
        if proxy:
            session.proxies = {"http": proxy, "https": proxy}
        try:
            session.get(f"{mirror}/", timeout=(10, 15))
        except Exception:
            pass  # warm-up is best effort — ads.php sometimes works bare
        resp = session.get(url, headers={"Referer": f"{mirror}/"},
                           timeout=(10, 25))

        # Fallback to browser on Cloudflare/403
        if resp.status_code in (403, 503):
            from ..browser_engine import solve_url, is_available
            if is_available(config):
                result = solve_url(url, config)
                if result:
                    solution = result.get("solution", {})
                    if solution.get("status", 0) < 400:
                        html = solution.get("response", "")
                    else:
                        return None
                else:
                    return None
            else:
                return None
        else:
            if resp.status_code >= 400:
                return None
            html = resp.text
        # booksdl CDN rotates nodes and 503s most requests (field 2026-09:
        # ~1-in-4 serves the PDF) — retry the same link a few times.
        for match in re.finditer(r'''href=["']([^"']*get\.php[^"']+)["']''', html, re.I):
            dl_path = match.group(1)
            dl_url = urllib.parse.urljoin(url, dl_path)
            result = None
            for attempt in range(4):
                polite_delay(config)
                result = download_pdf(dl_url, output_path, config, "LibGen",
                                      require_pdf_like_url=False, use_tor=use_tor)
                if result:
                    break
                time.sleep(2 + 2 * attempt)
            if result:
                result["doi"] = doi
                result["identifier"] = doi
                return result
        for match in re.finditer(r'''href=["']([^"']*\.pdf[^"']*)["']''', html, re.I):
            dl_path = match.group(1)
            if "get.php" in dl_path or dl_path.endswith(".pdf"):
                dl_url = urllib.parse.urljoin(url, dl_path)
                polite_delay(config)
                result = download_pdf(dl_url, output_path, config, "LibGen", require_pdf_like_url=False, use_tor=use_tor)
                if result:
                    result["doi"] = doi
                    result["identifier"] = doi
                    return result
    except Exception:
        pass
    return None
