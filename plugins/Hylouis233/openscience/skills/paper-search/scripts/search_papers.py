#!/usr/bin/env python3
"""Search academic paper APIs and print unified PaperDocument JSON.

Providers: OpenAlex, Crossref, arXiv. On success prints a JSON array of
PaperDocuments; on failure prints one structured error object instead of
a traceback, so the calling agent can record it in a search manifest.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

# Set PAPER_SEARCH_CONTACT to your email; it is sent in the politeness
# User-Agent header. Default is an RFC 2606 example address.
CONTACT_EMAIL = os.environ.get("PAPER_SEARCH_CONTACT", "you@example.com")
USER_AGENT = "science-literature-paper-search/1.0 (mailto:%s)" % CONTACT_EMAIL
REQUEST_TIMEOUT = 30   # seconds per HTTP request
MIN_INTERVAL = 0.5     # seconds between requests (politeness)
MAX_LIMIT = 50

ATOM = "{http://www.w3.org/2005/Atom}"        # Atom feed namespace
ARXIV = "{http://arxiv.org/schemas/atom}"     # arXiv extension namespace

_last_request_at = 0.0


class ProviderError(Exception):
    """Classified provider failure; kind is network | rate_limited | parse."""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind
        self.message = message


def throttle():
    """Enforce the minimum interval between outgoing HTTP requests."""
    global _last_request_at
    wait = MIN_INTERVAL - (time.monotonic() - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.monotonic()


def http_get(url):
    """Fetch a URL and return raw bytes; raise ProviderError on failure."""
    throttle()
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        kind = "rate_limited" if exc.code in (429, 503) else "network"
        raise ProviderError(kind, "HTTP %s from %s" % (exc.code, url))
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ProviderError("network", str(exc))


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def clean(text):
    """Collapse whitespace in free-text fields coming from the APIs."""
    return re.sub(r"\s+", " ", text or "").strip()


def paper(pid, title, authors, year, venue, doi, url, abstract, source):
    """Build one PaperDocument dict with the shared field set."""
    return {
        "id": pid,
        "title": title,
        "authors": authors,
        "year": year,
        "venue": venue,
        "doi": doi,
        "url": url,
        "abstract": abstract,
        "source": [source],
        "retrieved_at": now_iso(),
    }


def invert_abstract(index):
    """Rebuild plain text from OpenAlex's abstract_inverted_index."""
    if not index:
        return None
    positions = {}
    for word, offsets in index.items():
        for offset in offsets:
            positions[offset] = word
    return " ".join(positions[i] for i in sorted(positions))


def search_openalex(query, limit):
    """Query the OpenAlex /works endpoint and map hits to PaperDocuments."""
    params = urllib.parse.urlencode({
        "search": query,
        "per-page": limit,
        "mailto": CONTACT_EMAIL,
    })
    data = http_get("https://api.openalex.org/works?" + params)
    try:
        payload = json.loads(data)
    except ValueError as exc:
        raise ProviderError("parse", "invalid JSON: %s" % exc)
    results = []
    for work in payload.get("results", []):
        doi = (work.get("doi") or "").replace("https://doi.org/", "")
        authors = [a.get("author", {}).get("display_name", "")
                   for a in work.get("authorships", [])]
        location = work.get("primary_location") or {}
        venue = (location.get("source") or {}).get("display_name")
        results.append(paper(
            pid=work.get("id") or ("https://doi.org/" + doi if doi else None),
            title=clean(work.get("display_name")),
            authors=[a for a in authors if a],
            year=work.get("publication_year"),
            venue=venue,
            doi=doi or None,
            url=location.get("landing_page_url") or work.get("id"),
            abstract=invert_abstract(work.get("abstract_inverted_index")),
            source="openalex",
        ))
    return results


def search_crossref(query, limit):
    """Query the Crossref /works endpoint and map hits to PaperDocuments."""
    params = urllib.parse.urlencode({
        "query": query,
        "rows": limit,
        "mailto": CONTACT_EMAIL,
    })
    data = http_get("https://api.crossref.org/works?" + params)
    try:
        payload = json.loads(data)
    except ValueError as exc:
        raise ProviderError("parse", "invalid JSON: %s" % exc)
    items = (payload.get("message") or {}).get("items") or []
    results = []
    for item in items:
        doi = item.get("DOI") or ""
        authors = [" ".join(p for p in (a.get("given"), a.get("family")) if p)
                   for a in item.get("author", [])]
        date_parts = (item.get("issued") or {}).get("date-parts") or []
        year = date_parts[0][0] if date_parts and date_parts[0] else None
        container = item.get("container-title") or []
        results.append(paper(
            pid="https://doi.org/" + doi if doi else item.get("URL"),
            title=clean((item.get("title") or [""])[0]) or None,
            authors=[a for a in authors if a],
            year=year,
            venue=container[0] if container else None,
            doi=doi or None,
            url=item.get("URL"),
            abstract=clean(item.get("abstract")) or None,
            source="crossref",
        ))
    return results


def search_arxiv(query, limit):
    """Query the arXiv Atom API and map entries to PaperDocuments."""
    params = urllib.parse.urlencode({
        "search_query": "all:" + query,
        "start": 0,
        "max_results": limit,
    })
    data = http_get("http://export.arxiv.org/api/query?" + params)
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise ProviderError("parse", "invalid Atom XML: %s" % exc)

    def text_of(entry, tag, ns=ATOM):
        node = entry.find(ns + tag)
        return clean(node.text) if node is not None and node.text else None

    results = []
    for entry in root.findall(ATOM + "entry"):
        arxiv_url = text_of(entry, "id")
        published = text_of(entry, "published") or ""
        authors = [clean(a.findtext(ATOM + "name"))
                   for a in entry.findall(ATOM + "author")]
        results.append(paper(
            pid=arxiv_url,
            title=text_of(entry, "title"),
            authors=[a for a in authors if a],
            year=int(published[:4]) if published[:4].isdigit() else None,
            venue=text_of(entry, "journal_ref", ARXIV) or "arXiv preprint",
            doi=text_of(entry, "doi", ARXIV),
            url=arxiv_url,
            abstract=text_of(entry, "summary"),
            source="arxiv",
        ))
    return results


PROVIDERS = {
    "openalex": search_openalex,
    "crossref": search_crossref,
    "arxiv": search_arxiv,
}


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--query", required=True, help="search query string")
    parser.add_argument("--provider", required=True, choices=sorted(PROVIDERS))
    parser.add_argument("--limit", type=int, default=10,
                        help="max results, 1-%d (default 10)" % MAX_LIMIT)
    parser.add_argument("--format", default="json", choices=["json"])
    return parser.parse_args(argv)


def emit(obj, exit_code):
    """Print obj as pretty JSON to stdout and return the exit code."""
    # Windows consoles often default to GBK; force UTF-8 to never crash.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    json.dump(obj, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return exit_code


def main(argv=None):
    args = parse_args(argv)
    limit = max(1, min(args.limit, MAX_LIMIT))
    try:
        papers = PROVIDERS[args.provider](args.query, limit)
    except ProviderError as exc:
        kind, message = exc.kind, exc.message
    except Exception as exc:  # defensive: never crash the calling pipeline
        kind, message = "parse", "unexpected error: %s" % exc
    else:
        return emit(papers, 0)
    # Structured failure, not a crash: the caller records it in the manifest.
    return emit({"error": {"provider": args.provider,
                           "type": kind, "message": message}}, 1)


if __name__ == "__main__":
    sys.exit(main())
