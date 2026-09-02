#!/usr/bin/env python3
"""Parse Refworks/EndNote-style tagged exports (CNKI, Wanfang) to PaperDocument JSON.

Reads a .txt file of tagged records (one tag per line, e.g. "RT Journal
Article", "T1 Some title") and prints a JSON array of PaperDocuments:
{id, title, authors, year, venue, doi, url, abstract, source, retrieved_at}.

Tolerance rules: unknown tags are skipped; missing fields stay null;
records are separated by blank lines; a line that does not start with a
known 2-letter tag is treated as a continuation of the previous field.
"""

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone

# Tag -> PaperDocument field mapping (Refworks tag vocabulary).
TAG_RE = re.compile(r"^([A-Z][A-Z0-9])\s+(.*)$")
TITLE_TAGS = ("T1", "TI", "TT")          # primary / translated title
AUTHOR_TAGS = ("A1", "AU")                # primary authors, ";"-separated
JOURNAL_TAGS = ("JO", "JF", "T2", "JA")   # journal / secondary title
YEAR_TAGS = ("YR", "PY")                  # year
DATE_TAGS = ("FD",)                       # free date (fallback for year)
DOI_TAGS = ("DO", "DOI", "RID")           # DOI
ABSTRACT_TAGS = ("AB", "N2")              # abstract / notes-abstract
URL_TAGS = ("UL", "UR", "LK")             # URL / link
YEAR_RE = re.compile(r"(\d{4})")


def parse_records(text):
    """Split tagged text into a list of {tag: [values]} record dicts."""
    records, current, last_tag = [], {}, None

    def flush():
        nonlocal current
        if current:
            records.append(current)
            current = {}

    for raw in text.splitlines():
        line = raw.rstrip("\r\n")
        if not line.strip():  # blank line ends a record
            flush()
            last_tag = None
            continue
        m = TAG_RE.match(line)
        if m:
            tag, value = m.group(1), m.group(2).strip()
            current.setdefault(tag, []).append(value)
            last_tag = tag
        elif last_tag is not None:
            # Continuation line: append to the previous field's last value.
            current[last_tag][-1] += " " + line.strip()
        # else: preamble junk before the first tag -> skip
    flush()
    return records


def first(rec, tags):
    """Return the first present value among tags, else None."""
    for tag in tags:
        values = rec.get(tag)
        if values:
            return values[0].strip() or None
    return None


def all_values(rec, tags):
    """Return all values among tags as one flat list."""
    out = []
    for tag in tags:
        out.extend(v for v in rec.get(tag, []) if v.strip())
    return out


def split_authors(values):
    """Split author fields on ';' (Refworks/CNKI convention)."""
    authors = []
    for value in values:
        authors.extend(a.strip() for a in value.split(";") if a.strip())
    return authors or None


def extract_year(rec):
    """Get a 4-digit year from YR/PY, falling back to FD."""
    for candidate in [first(rec, YEAR_TAGS), first(rec, DATE_TAGS)]:
        if candidate:
            m = YEAR_RE.search(candidate)
            if m:
                return int(m.group(1))
    return None


def to_paper(rec, origin, retrieved_at):
    """Map one tagged record to a PaperDocument (missing fields -> null)."""
    title = first(rec, TITLE_TAGS)
    authors = split_authors(all_values(rec, AUTHOR_TAGS))
    doi = first(rec, DOI_TAGS)
    url = first(rec, URL_TAGS)
    if doi:  # normalize: strip resolver prefix, lowercase for the id
        doi = re.sub(r"^https?://(dx\.)?doi\.org/", "", doi.strip())
    if not url and doi:
        url = "https://doi.org/" + doi
    if doi:
        paper_id = "doi:" + doi.lower()
    else:  # no DOI: stable id from origin + title + first author
        key = (title or "") + "|" + (authors[0] if authors else "")
        digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:8]
        paper_id = "%s:%s" % (origin, digest)
    return {
        "id": paper_id,
        "title": title,
        "authors": authors,
        "year": extract_year(rec),
        "venue": first(rec, JOURNAL_TAGS),
        "doi": doi,
        "url": url,
        "abstract": first(rec, ABSTRACT_TAGS),
        "source": [origin],
        "retrieved_at": retrieved_at,
    }


def main():
    # Windows consoles often default to GBK; force UTF-8 to never crash.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(
        description="Parse Refworks-tagged bibliographic exports to PaperDocument JSON.")
    parser.add_argument("--input", required=True, help="Path to the tagged .txt export")
    parser.add_argument("--format", default="json", choices=["json"],
                        help="Output format (only json)")
    parser.add_argument("--origin", default="refworks",
                        help="Source label for PaperDocument.source, e.g. CNKI / Wanfang")
    args = parser.parse_args()

    try:
        with open(args.input, "r", encoding="utf-8-sig") as fh:  # tolerate BOM
            text = fh.read()
    except OSError as exc:
        print(json.dumps({"error": {"type": "io", "message": str(exc)}},
                         ensure_ascii=False))
        sys.exit(1)

    retrieved_at = datetime.now(timezone.utc).isoformat()
    records = parse_records(text)
    papers = [to_paper(rec, args.origin, retrieved_at) for rec in records]
    json.dump(papers, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
