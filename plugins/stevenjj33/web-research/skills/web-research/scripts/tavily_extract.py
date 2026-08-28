#!/usr/bin/env python3
"""Tavily /extract in keyless mode (default) or with an optional API key.

Single file, Python 3.8+ stdlib only. No third-party deps.

Usage:
    python3 tavily_extract.py --url "https://example.com/article"
                              [--output out.md]   # default: stdout
                              [--format md|json]  # default: md
                              [--use-keyless true|false]

Env:
    TAVILY_API_KEY  (optional) — Bearer unless --use-keyless true.
"""
import argparse
import json
import os
import sys
import urllib.request

# Force UTF-8 stdout so the script works on Windows PowerShell GBK terminals.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except (AttributeError, OSError):
    pass

TAVILY_URL = "https://api.tavily.com/extract"


def load_key() -> str | None:
    key = os.environ.get("TAVILY_API_KEY")
    if key:
        return key.strip() or None
    return None


def tavily_extract(url: str, use_keyless: bool) -> dict:
    use_keyless_mode = use_keyless
    api_key = None
    if not use_keyless_mode:
        api_key = load_key()
        if not api_key:
            print("Warning: TAVILY_API_KEY not set, falling back to keyless access",
                  file=sys.stderr)
            use_keyless_mode = True

    payload = {"urls": [url]}
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
        raise SystemExit(f"Tavily /extract returned non-JSON: {body[:300]}")

    # Tavily /extract returns {"results":[{url, raw_content}], "failed_results": [...]}
    results = obj.get("results") or []
    failed = obj.get("failed_results") or []
    if failed and not results:
        raise SystemExit(f"Tavily /extract failed for {url}: {failed[:1]}")
    if not results:
        raise SystemExit(f"Tavily /extract returned no content for {url}")
    first = results[0]
    return {
        "url": first.get("url", url),
        "raw_content": first.get("raw_content", ""),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--output", "-o", default=None,
                    help="Write markdown to this file instead of stdout")
    ap.add_argument("--format", default="md", choices=["md", "json"])
    ap.add_argument("--use-keyless", type=lambda s: s.lower() != "false", default=True)
    args = ap.parse_args()

    res = tavily_extract(url=args.url, use_keyless=args.use_keyless)

    if args.format == "json":
        out_text = json.dumps(res, ensure_ascii=False, indent=2)
    else:
        # Tavily /extract does not return clean markdown. Wrap as a code block so
        # downstream summarisation can still parse the text. Users who want
        # cleaner output should use defuddle.
        body = (res.get("raw_content") or "").rstrip()
        out_text = f"# {res.get('url', args.url)}\n\n```\n{body}\n```\n"

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(out_text)
    else:
        sys.stdout.write(out_text)
        if not out_text.endswith("\n"):
            sys.stdout.write("\n")


if __name__ == "__main__":
    main()
