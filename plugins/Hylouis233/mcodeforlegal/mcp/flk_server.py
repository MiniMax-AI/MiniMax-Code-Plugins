#!/usr/bin/env python3
"""flk-mcp: a lightweight MCP stdio server for China's national law database.

Wraps the public (undocumented) JSON API of flk.npc.gov.cn, the official PRC
national database of laws and regulations. No API key required.

Upstream status (verified 2026-08-18 by live probing): the site is a Vue SPA
backed by RuoYi-style endpoints under /law-search/; the legacy /api/... ones
(and the wb.flk.npc.gov.cn file host) are dead. Endpoints used, all observed
from the site's own frontend:

  POST /law-search/search/list           search; body = conditions + paging
  GET  /law-search/search/flfgDetails    one record by its `bbbs` id
  GET  /law-search/prompts/search        title suggestions (for flk_check)

Lifecycle codes (`sxx`): 1 repealed, 2 amended, 3 effective, 4 not yet
effective. Field names have shifted before, so parsing is alias-based and
degrades instead of raising where possible.

Protocol: newline-delimited JSON-RPC 2.0 over stdio (MCP); notifications are
accepted and never answered. Politeness: >= 0.5 s between upstream requests,
20 s timeout, honest purpose-stating UA; reads public data at human pace --
never crawls, never batches, never bypasses access controls. Pure stdlib.
"""

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "flk-mcp"
SERVER_VERSION = "0.1.0"

BASE = "https://flk.npc.gov.cn"
LIST_URL = BASE + "/law-search/search/list"
DETAIL_URL = BASE + "/law-search/search/flfgDetails"
SUGGEST_URL = BASE + "/law-search/prompts/search"
# Body files (PDF/WORD) are OSS object keys; a signed reader URL for one is
# minted by GET {PREVIEW_API}?filePath=<oss path>. We return this endpoint URL
# rather than calling it, so one flk_detail costs exactly one upstream hit.
PREVIEW_API = BASE + "/law-search/amazonFile/previewLink"

USER_AGENT = (
    "flk-mcp/0.1.0 (+https://github.com/mcodeforlegal; "
    "legal research assistant, low-volume polite access)"
)
REQUEST_TIMEOUT_S = 20
MIN_INTERVAL_S = 0.5  # politeness: minimum gap between upstream requests
MAX_PAGE_SIZE = 20
TOC_LIMIT = 40  # cap on table-of-contents entries returned by flk_detail

# sxx code -> (Chinese label, stable English enum)
SXX_MAP = {
    1: ("已废止", "repealed"),
    2: ("已修正", "amended"),
    3: ("有效", "effective"),
    4: ("尚未生效", "not_yet_effective"),
}

# Highlight tags the search API embeds in titles, e.g. <em class='highlight'>.
_TAG_RE = re.compile(r"<[^>]+>")

# Module-level timestamp of the last upstream request (politeness gate).
_last_request_ts = 0.0


# ---------------------------------------------------------------------------
# Structured errors
# ---------------------------------------------------------------------------

class FlkError(Exception):
    """Structured upstream error.

    err_type is one of: network | parse | upstream_changed | not_found
    """

    def __init__(self, err_type, message):
        super().__init__(message)
        self.err_type = err_type
        self.message = message

    def as_dict(self):
        return {"error": {"type": self.err_type, "message": self.message}}


# ---------------------------------------------------------------------------
# HTTP layer (politeness + error taxonomy)
# ---------------------------------------------------------------------------

def http_request(url, payload=None):
    """GET `url`, or POST it with a JSON `payload`; return decoded JSON.

    Enforces the politeness interval, the timeout and the purpose-stating UA.
    Raises FlkError with a precise type on failure; never leaks raw urllib
    exceptions to callers.
    """
    global _last_request_ts

    wait = MIN_INTERVAL_S - (time.monotonic() - _last_request_ts)
    if wait > 0:
        time.sleep(wait)

    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Referer": BASE + "/search",
    }
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json;charset=UTF-8"

    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
            _last_request_ts = time.monotonic()
            if getattr(resp, "status", 200) != 200:
                raise FlkError("network", "HTTP %s from upstream" % resp.status)
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        _last_request_ts = time.monotonic()
        raise FlkError("network", "HTTP %s from upstream" % exc.code)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        _last_request_ts = time.monotonic()
        raise FlkError("network", "connection failed: %s" % exc)

    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        # The WAF occasionally answers bots with an HTML challenge page; that
        # also lands here, so the message names both possibilities.
        raise FlkError(
            "parse",
            "response was not valid JSON (%s); upstream may have changed "
            "or an anti-bot challenge was served" % exc,
        )


def unwrap(payload, context):
    """Peel the RuoYi envelope {code, msg, data|rows, total}; return content.

    code 200 means success; anything else is an application-level failure.
    """
    if not isinstance(payload, dict):
        raise FlkError("upstream_changed",
                       "%s: expected an envelope object" % context)
    code = payload.get("code")
    if code is not None and code != 200:
        raise FlkError("upstream_changed",
                       "%s: upstream returned code=%s msg=%s"
                       % (context, code, payload.get("msg")))
    return payload


def strip_tags(text):
    """Remove <em class='highlight'> and any other tags from a title."""
    return _TAG_RE.sub("", text or "").strip()


def lifecycle_of(sxx):
    """Map an sxx code to (Chinese label, English enum), tolerating strings."""
    try:
        return SXX_MAP.get(int(sxx), ("unknown", "unknown"))
    except (TypeError, ValueError):
        return ("unknown", "unknown")


# ---------------------------------------------------------------------------
# Upstream wrappers
# ---------------------------------------------------------------------------

def api_list(keyword, page, size, exact):
    """Search by title keyword. exact=True asks for an exact-title match."""
    body = {
        "searchRange": 1,            # 1 = search within titles
        "sxrq": [], "gbrq": [], "sxx": [],
        "searchType": 1 if exact else 2,   # 1 = precise, 2 = fuzzy
        "xgzlSearch": False,
        "searchContent": keyword,
        "orderByParam": {"order": "-1", "sort": ""},
        "flfgCodeId": [], "zdjgCodeId": [], "gbrqYear": [],
        "pageNum": page,
        "pageSize": size,
    }
    payload = unwrap(http_request(LIST_URL, body), "flk_search")
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise FlkError("upstream_changed",
                       "flk_search: missing rows array in response")
    return rows, payload.get("total", len(rows))


def api_detail(bbbs):
    """Fetch one record by its bbbs id."""
    url = DETAIL_URL + "?" + urllib.parse.urlencode({"bbbs": bbbs})
    payload = unwrap(http_request(url), "flk_detail")
    data = payload.get("data")
    if not data or not isinstance(data, dict):
        raise FlkError("not_found", "no record found for id %s" % bbbs)
    return data


def api_suggest(title):
    """Title suggestions used to help callers fix imprecise titles."""
    url = SUGGEST_URL + "?" + urllib.parse.urlencode({"title": title})
    payload = unwrap(http_request(url), "flk_suggest")
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    return [strip_tags(x.get("title")) for x in data
            if isinstance(x, dict) and x.get("title")]


def normalize_row(row):
    """Project one search row onto our stable output shape; None if unusable."""
    if not isinstance(row, dict):
        return None

    def first(*names):
        for name in names:
            value = row.get(name)
            if value not in (None, ""):
                return value
        return None

    item_id = first("bbbs", "id")
    title = strip_tags(first("title", "bt"))
    if not item_id or not title:
        return None
    status_cn, lifecycle = lifecycle_of(first("sxx", "status"))
    return {
        "id": item_id,
        "title": title,
        "office": first("zdjgName", "office", "zdjg"),
        "publish_date": first("gbrq", "publish", "f_bbrq_s"),
        "effective_date": first("sxrq"),
        "status": status_cn,
        "lifecycle": lifecycle,
        "type": first("flxz", "type", "f_flzl_s"),
    }


def flatten_toc(node, out, depth=0):
    """Flatten the detail `content` tree into [indent, title] pairs, capped."""
    if len(out) >= TOC_LIMIT or not isinstance(node, dict):
        return
    title = node.get("title")
    if title:
        out.append(("  " * depth) + strip_tags(str(title)))
    children = node.get("children")
    if isinstance(children, list):
        for child in children:
            flatten_toc(child, out, depth + 1)


def body_links(oss_file):
    """Turn the detail ossFile object into per-format preview links."""
    links = []
    if not isinstance(oss_file, dict):
        return links
    for fmt, key in (("pdf", "ossPdfPath"), ("word", "ossWordPath")):
        path = oss_file.get(key)
        if path:
            links.append({
                "format": fmt,
                "oss_path": path,
                "preview": PREVIEW_API + "?" + urllib.parse.urlencode(
                    {"filePath": path}),
            })
    return links


# ---------------------------------------------------------------------------
# Tool implementations (each returns a JSON-serializable dict)
# ---------------------------------------------------------------------------

def tool_flk_search(args):
    keyword = args.get("keyword")
    if not keyword or not isinstance(keyword, str):
        raise FlkError("parse", "flk_search requires a non-empty 'keyword' string")
    page, size = args.get("page", 1), args.get("size", 10)
    if not isinstance(page, int) or page < 1:
        raise FlkError("parse", "'page' must be a positive integer")
    if not isinstance(size, int) or not 1 <= size <= MAX_PAGE_SIZE:
        raise FlkError("parse",
                       "'size' must be an integer between 1 and %d" % MAX_PAGE_SIZE)

    rows, total = api_list(keyword.strip(), page, size, exact=False)
    hits = [h for h in (normalize_row(r) for r in rows) if h]
    return {
        "keyword": keyword.strip(), "page": page, "size": size,
        "total": total, "results": hits, "source": "flk.npc.gov.cn",
    }


def tool_flk_detail(args):
    item_id = args.get("id")
    if not item_id or not isinstance(item_id, str):
        raise FlkError("parse", "flk_detail requires a non-empty 'id' string")
    item_id = item_id.strip()

    data = api_detail(item_id)
    status_cn, lifecycle = lifecycle_of(data.get("sxx"))
    toc = []
    flatten_toc(data.get("content"), toc)
    return {
        "id": item_id,
        "title": strip_tags(data.get("title")),
        "office": data.get("zdjgName"),
        "type": data.get("flxz"),
        "publish_date": data.get("gbrq"),
        "effective_date": data.get("sxrq"),
        "status": status_cn,
        "lifecycle": lifecycle,
        "body_links": body_links(data.get("ossFile")),
        "toc_excerpt": toc,
        "toc_note": ("first %d entries of the official table of contents; "
                     "verify article text against the PDF/WORD body files"
                     % len(toc)),
        "source": "flk.npc.gov.cn",
    }


def tool_flk_check(args):
    title = args.get("title")
    if not title or not isinstance(title, str):
        raise FlkError("parse", "flk_check requires a non-empty 'title' string")
    title = title.strip()

    rows, _total = api_list(title, 1, 10, exact=True)
    for row in rows:
        hit = normalize_row(row)
        if hit and hit["title"] == title:
            return {
                "found": True,
                "id": hit["id"],
                "title": hit["title"],
                "status": hit["status"],
                "lifecycle": hit["lifecycle"],
                "publish_date": hit["publish_date"],
                "effective_date": hit["effective_date"],
                "office": hit["office"],
                "type": hit["type"],
                "source": "flk.npc.gov.cn",
            }

    suggestions = api_suggest(title)
    return {
        "found": False,
        "title": title,
        "note": ("Not found under this exact title. This does NOT mean the "
                 "document does not exist: the title may be imprecise "
                 "(missing the '中华人民共和国' prefix, abbreviations, "
                 "punctuation). Check the suggestions, retry with flk_search, "
                 "or verify manually via a commercial database."),
        "suggestions": suggestions,
        "source": "flk.npc.gov.cn",
    }


def _schema(properties, required):
    return {"type": "object", "properties": properties, "required": required}


_INT = {"type": "integer"}
_STR = {"type": "string"}

TOOLS = [
    {
        "name": "flk_search",
        "description": "Search the PRC national law database (flk.npc.gov.cn) "
                       "by title keyword; structured hits + lifecycle status.",
        "inputSchema": _schema({
            "keyword": {**_STR, "description": "title keyword"},
            "page": {**_INT, "minimum": 1, "default": 1},
            "size": {**_INT, "minimum": 1, "maximum": MAX_PAGE_SIZE,
                     "default": 10},
        }, ["keyword"]),
        "handler": tool_flk_search,
    },
    {
        "name": "flk_detail",
        "description": "Fetch one record by its flk id (bbbs): metadata, "
                       "lifecycle status, body-file preview links (PDF/WORD) "
                       "and a table-of-contents excerpt.",
        "inputSchema": _schema({
            "id": {**_STR, "description": "flk record id (bbbs)"},
        }, ["id"]),
        "handler": tool_flk_detail,
    },
    {
        "name": "flk_check",
        "description": "Check a statute by exact title: existence + lifecycle "
                       "status (effective / amended / repealed / "
                       "not_yet_effective / unknown). found:false never "
                       "means 'does not exist'.",
        "inputSchema": _schema({
            "title": {**_STR, "description": "exact document title"},
        }, ["title"]),
        "handler": tool_flk_check,
    },
]

TOOL_HANDLERS = {t["name"]: t["handler"] for t in TOOLS}
TOOL_LIST_PUBLIC = [{k: v for k, v in t.items() if k != "handler"} for t in TOOLS]


# ---------------------------------------------------------------------------
# MCP / JSON-RPC plumbing
# ---------------------------------------------------------------------------

def make_result(msg_id, result):
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def make_error(msg_id, code, message):
    return {"jsonrpc": "2.0", "id": msg_id,
            "error": {"code": code, "message": message}}


def handle_request(msg):
    """Dispatch one decoded JSON-RPC message; return a response dict or None."""
    if not isinstance(msg, dict) or "method" not in msg:
        return make_error(None, -32600, "invalid request")

    method, msg_id = msg.get("method", ""), msg.get("id")

    # Notifications are fire-and-forget: accept silently, never answer.
    if method.startswith("notifications/"):
        return None

    if method == "ping":
        return make_result(msg_id, {})

    if method == "initialize":
        return make_result(msg_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })

    if method == "tools/list":
        return make_result(msg_id, {"tools": TOOL_LIST_PUBLIC})

    if method == "tools/call":
        params = msg.get("params") or {}
        handler = TOOL_HANDLERS.get(params.get("name"))
        if handler is None:
            return make_error(msg_id, -32602,
                              "unknown tool: %s" % params.get("name"))
        try:
            data = handler(params.get("arguments") or {})
            content = [{"type": "text",
                        "text": json.dumps(data, ensure_ascii=False, indent=2)}]
            return make_result(msg_id, {"content": content, "isError": False})
        except FlkError as exc:
            # Tool-level failures travel as isError content, not protocol
            # errors, so the server loop keeps running.
            content = [{"type": "text",
                        "text": json.dumps(exc.as_dict(), ensure_ascii=False)}]
            return make_result(msg_id, {"content": content, "isError": True})
        except Exception as exc:  # last-resort guard: never crash the loop
            content = [{"type": "text",
                        "text": json.dumps(
                            {"error": {"type": "parse",
                                       "message": "unexpected: %s" % exc}},
                            ensure_ascii=False)}]
            return make_result(msg_id, {"content": content, "isError": True})

    return make_error(msg_id, -32601, "method not found: %s" % method)


def main():
    """Read newline-delimited JSON-RPC requests from stdin until EOF."""
    # MCP peers speak UTF-8 over pipes; on Windows the default pipe encoding
    # is the ANSI codepage (e.g. cp936), which would mangle CJK titles.
    # errors="replace" keeps one mangled line from crashing the loop.
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass  # non-reconfigurable stream: keep defaults
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            response = make_error(None, -32700, "parse error: line is not JSON")
        else:
            response = handle_request(msg)
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
