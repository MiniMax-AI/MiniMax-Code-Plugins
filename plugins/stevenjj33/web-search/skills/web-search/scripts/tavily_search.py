#!/usr/bin/env python3
"""Tavily /search in keyless mode (default) or with an optional API key.

Single file, Python 3.8+ stdlib only. No third-party deps.

Usage:
    python3 tavily_search.py --query "latest AI news" [--max-results 5]
                             [--include-answer] [--search-depth basic|advanced]
                             [--format raw|brave|md]
                             [--use-keyless true|false]

Env:
    TAVILY_API_KEY  (optional) — if set, sent as Bearer unless --use-keyless true.
"""
import argparse
import json
import os
import sys
import urllib.request

# Force UTF-8 stdout so the script works on Windows PowerShell GBK terminals.
# Tavily responses contain zero-width spaces (\u200b) and other CJK characters
# that the legacy GBK codec cannot encode.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except (AttributeError, OSError):
    pass

TAVILY_URL = "https://api.tavily.com/search"


def load_key() -> str | None:
    key = os.environ.get("TAVILY_API_KEY")
    if key:
        return key.strip() or None
    return None


def tavily_search(query: str, max_results: int, include_answer: bool,
                  search_depth: str, use_keyless: bool) -> dict:
    api_key = None
    use_keyless_mode = use_keyless

    if not use_keyless_mode:
        api_key = load_key()
        if not api_key:
            print("Warning: TAVILY_API_KEY not set, falling back to keyless access",
                  file=sys.stderr)
            use_keyless_mode = True

    payload = {
        "query": query,
        "max_results": max(1, min(max_results, 10)),
        "search_depth": search_depth,
        "include_answer": bool(include_answer),
        "include_images": False,
        "include_raw_content": False,
    }
    if api_key and not use_keyless_mode:
        payload["api_key"] = api_key

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if use_keyless_mode:
        headers["X-Tavily-Access-Mode"] = "keyless"

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(TAVILY_URL, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8", errors="replace")

    try:
        obj = json.loads(body)
    except json.JSONDecodeError:
        raise SystemExit(f"Tavily returned non-JSON: {body[:300]}")

    out = {"query": query, "answer": obj.get("answer"), "results": []}
    for r in (obj.get("results") or [])[:payload["max_results"]]:
        out["results"].append({
            "title": r.get("title"),
            "url": r.get("url"),
            "content": r.get("content"),
        })
    if not include_answer:
        out.pop("answer", None)
    return out


def to_brave_like(obj: dict) -> dict:
    return {
        "query": obj.get("query"),
        "results": [
            {"title": r.get("title"), "url": r.get("url"), "snippet": r.get("content")}
            for r in obj.get("results", []) or []
        ],
        **({"answer": obj["answer"]} if "answer" in obj else {}),
    }


def to_markdown(obj: dict) -> str:
    lines = []
    if obj.get("answer"):
        lines.append(obj["answer"].strip())
        lines.append("")
    for i, r in enumerate(obj.get("results") or [], 1):
        title = (r.get("title") or "").strip() or r.get("url") or "(no title)"
        url = r.get("url") or ""
        snippet = (r.get("content") or "").strip()
        lines.append(f"{i}. {title}")
        if url:
            lines.append(f"   {url}")
        if snippet:
            lines.append(f"   - {snippet}")
    return "\n".join(lines).strip() + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", required=True)
    ap.add_argument("--max-results", type=int, default=5)
    ap.add_argument("--include-answer", action="store_true")
    ap.add_argument("--search-depth", default="basic", choices=["basic", "advanced"])
    ap.add_argument("--format", default="raw", choices=["raw", "brave", "md"])
    ap.add_argument("--use-keyless", type=lambda s: s.lower() != "false", default=True)
    args = ap.parse_args()

    res = tavily_search(
        query=args.query,
        max_results=args.max_results,
        include_answer=args.include_answer,
        search_depth=args.search_depth,
        use_keyless=args.use_keyless,
    )

    if args.format == "md":
        sys.stdout.write(to_markdown(res))
        return
    if args.format == "brave":
        res = to_brave_like(res)
    json.dump(res, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
