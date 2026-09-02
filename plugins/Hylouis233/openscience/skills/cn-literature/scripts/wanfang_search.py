#!/usr/bin/env python3
"""Search the Wanfang Open Platform API and print PaperDocument JSON.

Credential comes from WANFANG_TOKEN; when missing, a structured
auth_missing error is printed instead of a traceback. Endpoint layout and
response fields follow the official docs (api.wanfangdata.com.cn); if the
upstream API changes shape this script reports upstream_changed rather
than guessing — adjust WANFANG_API_BASE / field mapping per current docs.
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
from datetime import datetime, timezone

WANFANG_API_BASE = "https://api.wanfangdata.com.cn"  # per official docs
SEARCH_PATH = "/search"  # endpoint path per official docs; verify before first use
REQUEST_TIMEOUT = 30     # seconds per HTTP request
MIN_INTERVAL = 0.5       # seconds between requests (politeness, <=2 req/s)
MAX_LIMIT = 50

_last_request_at = 0.0


class ApiError(Exception):
    """Classified failure: auth_missing|network|rate_limited|upstream_changed|parse."""

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


def emit_error(kind, message):
    """Print one structured error object and exit non-zero (never a traceback)."""
    print(json.dumps({"error": {"type": kind, "message": message}},
                     ensure_ascii=False))
    sys.exit(1)


def http_get_json(url, token):
    """GET a URL with the bearer token; return parsed JSON or raise ApiError."""
    throttle()
    headers = {
        "Authorization": "Bearer " + token,  # auth scheme per official docs
        "Accept": "application/json",
        "User-Agent": "openscience-cn-literature/0.1",
    }
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as resp:
            body = resp.read()
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise ApiError("auth_missing",
                           "WANFANG_TOKEN 无效或已过期 (HTTP %s)，请重新申请" % exc.code)
        kind = "rate_limited" if exc.code in (429, 503) else "network"
        raise ApiError(kind, "HTTP %s from Wanfang API" % exc.code)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ApiError("network", "request failed: %s" % exc)
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ApiError("parse", "response is not valid JSON: %s" % exc)


def extract_records(payload):
    """Pull the record list out of the response envelope (defensive); if the
    envelope shape is not a known layout, report upstream_changed."""
    if not isinstance(payload, dict):
        raise ApiError("upstream_changed", "top-level response is not an object")
    for key in ("records", "data", "results", "hits"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
        if isinstance(value, dict):  # one more nesting level, e.g. data.records
            for subkey in ("records", "results", "items", "list"):
                if isinstance(value.get(subkey), list):
                    return value[subkey]
    raise ApiError("upstream_changed",
                   "no record list found; check official docs for the new envelope shape")


def get_any(record, keys):
    """First non-empty string value among candidate keys, else None."""
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, list) and value:  # e.g. authors as objects
            names = [v.get("name") if isinstance(v, dict) else str(v) for v in value]
            names = [n for n in names if n]
            if names:
                return "; ".join(names)
    return None


def to_paper(record, retrieved_at):
    """Map one Wanfang record to a PaperDocument; unknown fields -> null.
    Candidate keys are defensive per the official docs; no match yields
    nulls, never fabricated values."""
    doi = get_any(record, ["doi", "DOI"])
    title = get_any(record, ["title", "Title", "title_zh"])
    authors_raw = get_any(record, ["authors", "creator", "author"])
    year_raw = get_any(record, ["year", "publish_year", "date"])
    year = None
    if year_raw:
        m = re.search(r"\d{4}", year_raw)
        if m:
            year = int(m.group(0))
    url = get_any(record, ["url", "link"])
    if not url and doi:
        url = "https://doi.org/" + doi
    return {
        "id": "doi:" + doi.lower() if doi else "wanfang:" + str(
            record.get("id") or record.get("record_id") or "unknown"),
        "title": title,
        "authors": [a.strip() for a in authors_raw.split(";")] if authors_raw else None,
        "year": year,
        "venue": get_any(record, ["journal", "source", "journal_title"]),
        "doi": doi,
        "url": url,
        "abstract": get_any(record, ["abstract", "abstract_zh", "summary"]),
        "source": ["wanfang"],
        "retrieved_at": retrieved_at,
    }


def main():
    # Windows consoles often default to GBK; force UTF-8 to never crash.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(
        description="Search Wanfang Open Platform and print PaperDocument JSON.")
    parser.add_argument("--query", required=True, help="Search query text")
    parser.add_argument("--limit", type=int, default=20,
                        help="Max records to return (capped at %d)" % MAX_LIMIT)
    parser.add_argument("--format", default="json", choices=["json"],
                        help="Output format (only json)")
    args = parser.parse_args()

    token = os.environ.get("WANFANG_TOKEN", "").strip()
    if not token:
        emit_error("auth_missing",
                   "未配置 WANFANG_TOKEN 环境变量。请到万方开放平台 "
                   "(api.wanfangdata.com.cn) 注册并按点计费开通后，export "
                   "WANFANG_TOKEN=<token> 再重试；或改用 CNKI/万方官网人工导出"
                   "题录 + parse_refworks.py 的流程。")

    limit = max(1, min(args.limit, MAX_LIMIT))
    query = urllib.parse.urlencode({"q": args.query, "limit": limit})
    url = WANFANG_API_BASE + SEARCH_PATH + "?" + query

    try:
        payload = http_get_json(url, token)
        records = extract_records(payload)
    except ApiError as exc:
        emit_error(exc.kind, exc.message)

    retrieved_at = datetime.now(timezone.utc).isoformat()
    papers = [to_paper(rec, retrieved_at) for rec in records[:limit]
              if isinstance(rec, dict)]
    json.dump(papers, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
