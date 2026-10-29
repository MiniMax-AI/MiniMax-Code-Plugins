#!/usr/bin/env python3
"""research.py — end-to-end web research pipeline (Python, no bash dependency).

Step 1: Tavily /search (keyless) — find candidate URLs.
Step 2: For each URL, cascade fetch with one of:
  1. defuddle (CLI, free, no rate limit) when installed
  2. Tavily /extract (keyless, rate-limited) as fallback
  3. marker file — model re-fetches with the mcode in-app browser tool

Usage:
    python3 research.py "<query>" [max_results=5] [output_dir=./research-output]

Example:
    python3 research.py "向量数据库 最新进展" 5 ./research-output
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Force UTF-8 stdout/stderr so this works on Windows PowerShell GBK terminals.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

SCRIPT_DIR = Path(__file__).resolve().parent


def find_defuddle() -> str | None:
    """Cross-platform PATH lookup (Windows .cmd shims included)."""
    return shutil.which("defuddle")


def slugify(url: str, max_len: int = 80) -> str:
    s = re.sub(r"^https?://", "", url)
    s = re.sub(r"[/:?#&=]+", "_", s)
    s = re.sub(r"[^A-Za-z0-9._-]", "_", s)
    return s[:max_len] or "page"


def search_urls(query: str, max_results: int) -> list[str]:
    """Step 1: Tavily /search in keyless mode → list of URLs."""
    r = subprocess.run(
        [sys.executable, str(SCRIPT_DIR / "tavily_search.py"),
         "--query", query,
         "--max-results", str(max_results),
         "--format", "brave"],
        capture_output=True, text=True, timeout=60,
        encoding="utf-8", errors="replace",
    )
    if r.returncode != 0:
        print(f"[error] tavily_search.py failed: {r.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    import json
    try:
        d = json.loads(r.stdout)
    except json.JSONDecodeError as e:
        print(f"[error] tavily_search.py returned non-JSON: {e}", file=sys.stderr)
        sys.exit(1)
    urls = []
    for item in d.get("results", []):
        u = str(item.get("url") or "")
        if u.startswith(("http://", "https://")):
            urls.append(u)
        else:
            print(f"[skipped non-url result] {u[:40]}", file=sys.stderr)
    return urls


def fetch_with_defuddle(url: str, out_path: Path, defuddle_bin: str) -> bool:
    r = subprocess.run(
        [defuddle_bin, "parse", url, "--md", "-o", str(out_path)],
        capture_output=True, text=True, timeout=60,
        encoding="utf-8", errors="replace",
    )
    return r.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0


def fetch_with_tavily_extract(url: str, out_path: Path) -> bool:
    r = subprocess.run(
        [sys.executable, str(SCRIPT_DIR / "tavily_extract.py"),
         "--url", url, "--output", str(out_path)],
        capture_output=True, text=True, timeout=60,
        encoding="utf-8", errors="replace",
    )
    return r.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("query", help="research query")
    ap.add_argument("max_results", nargs="?", type=int, default=5)
    ap.add_argument("output_dir", nargs="?", default="./research-output")
    args = ap.parse_args()

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Layer 1 presence check (one-time notice, never auto-install)
    defuddle_bin = find_defuddle()
    if defuddle_bin:
        print(f"[info] defuddle found at {defuddle_bin}", file=sys.stderr)
    else:
        print("[notice] defuddle CLI not found. Falling back to Tavily /extract for every URL. "
              "Install with `npm i -g defuddle` to use the free layer.",
              file=sys.stderr)

    # Step 1: search
    print(f"[search] query={args.query!r} max_results={args.max_results}", file=sys.stderr)
    urls = search_urls(args.query, args.max_results)
    if not urls:
        print("[error] search returned no URLs", file=sys.stderr)
        return 1
    print(f"[search] got {len(urls)} URLs", file=sys.stderr)

    # Step 2: cascade-fetch each URL
    written = 0
    for i, url in enumerate(urls, 1):
        fname = f"{i:02d}-{slugify(url)}.md"
        fpath = out_dir / fname
        layer = None

        if defuddle_bin:
            if fetch_with_defuddle(url, fpath, defuddle_bin):
                layer = "defuddle"
            else:
                print(f"[defuddle failed, falling back] {url}", file=sys.stderr)

        if layer is None:
            if fetch_with_tavily_extract(url, fpath):
                layer = "tavily extract"
            else:
                print(f"[tavily extract failed, marking for browser] {url}", file=sys.stderr)

        if layer is None:
            fpath.write_text(
                f"<!-- needs mcode browser: {url} -->\n"
                f"<!-- defuddle+ Tavily /extract both failed to parse this URL. "
                f"Re-fetch with the mcode in-app browser tool. -->\n",
                encoding="utf-8",
            )
            layer = "browser required"
            print(f"[browser required] {url}", file=sys.stderr)
        else:
            print(f"[{layer}] {url}", file=sys.stderr)

        written += 1

    print(f"\nWrote {written} files to {out_dir} (defuddle={'yes' if defuddle_bin else 'no'}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
