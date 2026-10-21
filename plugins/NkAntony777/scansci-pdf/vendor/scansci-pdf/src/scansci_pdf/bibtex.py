"""BibTeX generation from Crossref metadata."""

from __future__ import annotations

import re
import urllib.parse
from typing import Any

from .network import fetch_json


def fetch_bibtex(doi: str, config: dict[str, Any]) -> str | None:
    """Fetch BibTeX entry for a DOI from Crossref."""
    q = urllib.parse.quote(doi, safe="")
    url = f"https://api.crossref.org/works/{q}"
    try:
        payload = fetch_json(url, config, headers={"Accept": "application/json"})
        if not payload:
            return None
        msg = payload.get("message", {})
        return _crossref_to_bibtex(msg, doi)
    except Exception:
        return None


def _crossref_to_bibtex(msg: dict[str, Any], doi: str) -> str | None:
    entry_type = _detect_entry_type(msg.get("type", ""))
    if not entry_type:
        entry_type = "article"

    cite_key = _make_cite_key(msg, doi)
    fields: dict[str, str] = {}

    # Title
    titles = msg.get("title", [])
    if titles:
        fields["title"] = _clean(titles[0])

    # Authors
    authors = msg.get("author", [])
    if authors:
        names = []
        for a in authors:
            family = a.get("family", "")
            given = a.get("given", "")
            if family and given:
                names.append(f"{family}, {given}")
            elif family:
                names.append(family)
        if names:
            fields["author"] = " and ".join(names)

    # Journal/Booktitle
    container = msg.get("container-title", [])
    if container:
        fields["journal"] = _clean(container[0])

    # Year
    parts = msg.get("published-print", msg.get("published-online", msg.get("created", {})))
    date_parts = parts.get("date-parts", [[]]) if isinstance(parts, dict) else [[]]
    if date_parts and date_parts[0]:
        fields["year"] = str(date_parts[0][0])

    # Volume, Issue, Pages
    if msg.get("volume"):
        fields["volume"] = str(msg["volume"])
    if msg.get("issue"):
        fields["number"] = str(msg["issue"])
    if msg.get("page"):
        fields["pages"] = msg["page"].replace("-", "--")

    # DOI
    fields["doi"] = doi

    # URL
    fields["url"] = f"https://doi.org/{doi}"

    # Publisher
    if msg.get("publisher"):
        fields["publisher"] = _clean(msg["publisher"])

    # Abstract
    if msg.get("abstract"):
        fields["abstract"] = _clean(msg["abstract"])

    return _format_bibtex(entry_type, cite_key, fields)


def _detect_entry_type(crossref_type: str) -> str:
    mapping = {
        "journal-article": "article",
        "proceedings-article": "inproceedings",
        "book-chapter": "incollection",
        "book": "book",
        "monograph": "book",
        "edited-book": "book",
        "reference-book": "book",
        "dissertation": "phdthesis",
        "report": "techreport",
        "posted-content": "misc",
        "proceedings": "proceedings",
    }
    return mapping.get(crossref_type, "article")


def _make_cite_key(msg: dict[str, Any], doi: str) -> str:
    authors = msg.get("author", [])
    first_author = ""
    if authors:
        first_author = authors[0].get("family", authors[0].get("given", ""))
    first_author = re.sub(r"[^A-Za-z]", "", first_author)[:6]

    parts = msg.get("published-print", msg.get("published-online", msg.get("created", {})))
    date_parts = parts.get("date-parts", [[]]) if isinstance(parts, dict) else [[]]
    year = str(date_parts[0][0]) if date_parts and date_parts[0] else "XXXX"

    titles = msg.get("title", [])
    first_word = ""
    if titles:
        words = re.findall(r"[A-Za-z]+", titles[0])
        if words:
            first_word = words[0][:6]

    key = f"{first_author}{year}{first_word}".lower()
    return key or doi.replace("/", "_").replace(".", "_")


def _clean(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text)
    text = text.replace("&", r"\&").replace("%", r"\%").replace("_", r"\_")
    text = text.replace("{", r"\{").replace("}", r"\}")
    return text.strip()


def _format_bibtex(entry_type: str, cite_key: str, fields: dict[str, str]) -> str:
    lines = [f"@{entry_type}{{{cite_key},"]
    for key, value in fields.items():
        lines.append(f"  {key} = {{{value}}},")
    lines.append("}")
    return "\n".join(lines)
