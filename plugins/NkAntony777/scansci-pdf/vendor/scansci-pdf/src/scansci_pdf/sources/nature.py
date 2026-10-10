"""Nature.com direct PDF download."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from ..network import fetch
from ..pdf_utils import download_pdf


def try_nature_direct(doi: str, output_path: Path, config: dict[str, Any]) -> dict[str, Any] | None:
    if not doi.startswith("10.1038/"):
        return None
    article_id = doi.replace("10.1038/", "")
    pdf_url = f"https://www.nature.com/articles/{article_id}.pdf"
    result = download_pdf(pdf_url, output_path, config, "NatureDirect", require_pdf_like_url=False)
    if result:
        result["doi"] = doi
        result["identifier"] = doi
        return result

    article_url = f"https://www.nature.com/articles/{article_id}"
    try:
        resp = fetch(article_url, config)
        if resp.status_code < 400:
            html = resp.text
            pdf_pattern = re.compile(r'href=["\'](/articles/[^"\' ]*\.pdf[^"\' ]*)["\']', re.I)
            for match in pdf_pattern.finditer(html):
                dl_url = f"https://www.nature.com{match.group(1)}"
                result = download_pdf(dl_url, output_path, config, "NatureDirect", require_pdf_like_url=False)
                if result:
                    result["doi"] = doi
                    result["identifier"] = doi
                    return result
    except Exception:
        pass
    return None
