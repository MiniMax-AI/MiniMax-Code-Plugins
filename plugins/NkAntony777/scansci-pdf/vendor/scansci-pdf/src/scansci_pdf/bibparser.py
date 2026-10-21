"""BibTeX file parser for bulk import."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any


def parse_bib_file(file_path: str | Path) -> list[dict[str, str]]:
    """Parse a .bib file and extract entries with DOIs.

    Returns list of dicts with keys: cite_key, doi, title, authors, year
    """
    path = Path(file_path)
    if not path.exists():
        return []

    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = path.read_text(encoding="latin-1")

    return parse_bib_text(content)


def parse_bib_text(content: str, *, require_doi: bool = True) -> list[dict[str, str]]:
    """Parse BibTeX text and extract entries.

    Args:
        content: BibTeX text content
        require_doi: If True (default), only return entries with DOI.
                     If False, return all entries.
    """
    entries = []
    # Find entry starts: @type{key,
    entry_start = re.compile(r"@(\w+)\s*\{([^,]+),", re.IGNORECASE)

    pos = 0
    while pos < len(content):
        m = entry_start.search(content, pos)
        if not m:
            break

        entry_type = m.group(1).lower()
        cite_key = m.group(2).strip()
        # Find matching closing brace
        brace_start = m.end()
        depth = 1
        i = brace_start
        while i < len(content) and depth > 0:
            if content[i] == '{':
                depth += 1
            elif content[i] == '}':
                depth -= 1
            i += 1
        body = content[brace_start:i - 1]

        entry = {"cite_key": cite_key, "type": entry_type}

        # Extract fields: key = {value} or key = "value" (handles nested braces)
        field_re = re.compile(r"(\w+)\s*=\s*", re.IGNORECASE)
        fpos = 0
        while fpos < len(body):
            fm = field_re.search(body, fpos)
            if not fm:
                break
            key = fm.group(1).lower()
            val_start = fm.end()
            if val_start < len(body) and body[val_start] == '{':
                depth = 1
                j = val_start + 1
                while j < len(body) and depth > 0:
                    if body[j] == '{':
                        depth += 1
                    elif body[j] == '}':
                        depth -= 1
                    j += 1
                value = body[val_start + 1:j - 1]
                fpos = j
            elif val_start < len(body) and body[val_start] == '"':
                end_q = body.find('"', val_start + 1)
                if end_q == -1:
                    break
                value = body[val_start + 1:end_q]
                fpos = end_q + 1
            else:
                m_num = re.match(r"[^,}\s]+", body[val_start:])
                if m_num:
                    value = m_num.group(0)
                    fpos = val_start + m_num.end()
                else:
                    break
            entry[key] = value.strip()

        if not require_doi or entry.get("doi"):
            entries.append(entry)

        pos = i

    return entries


def extract_dois_from_bib(file_path: str | Path) -> list[str]:
    """Extract DOIs from a .bib file."""
    entries = parse_bib_file(file_path)
    return [e["doi"] for e in entries if e.get("doi")]


def extract_dois_from_text(text: str) -> list[str]:
    """Extract DOIs from plain text (one per line or comma-separated)."""
    dois = []
    # Split by newline, comma, or semicolon
    for part in re.split(r"[,\n;]+", text):
        doi = part.strip()
        # Basic DOI pattern validation
        if re.match(r"^10\.\d{4,}/", doi):
            dois.append(doi)
    return dois
