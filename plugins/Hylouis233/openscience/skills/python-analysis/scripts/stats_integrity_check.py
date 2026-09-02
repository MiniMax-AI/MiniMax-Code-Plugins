#!/usr/bin/env python3
"""Deterministic numeric sanity checks for Markdown research reports.

Pure standard library. Scans Markdown files for common numeric mistakes:
  1. percentage   -- each percentage within 0-100; percentages on the same
                     line that look like a composition should sum to 100 +/- 0.5
  2. pvalue       -- p-value syntax (p<0.001 / p=0.xxx) and value within 0-1
  3. samplesize   -- every "N=<n>" in one file should use a consistent value
  4. ci           -- confidence interval lower bound must not exceed upper

Usage: python stats_integrity_check.py --path <file-or-dir> [--format json|text]
Exit code is 0 when no error-level issue is found, 1 otherwise.
"""

import argparse
import json
import re
import sys
from pathlib import Path

# --- regex patterns ---------------------------------------------------------

PCT_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*%")
# p<0.001 / p = 0.032 / p≤0.05 etc.; also catches p=1.2 (out of range).
PVAL_RE = re.compile(r"\bp\s*(<=|>=|≤|≥|<|>|=)\s*(\d+(?:\.\d+)?)")
NSIZE_RE = re.compile(r"\bN\s*=\s*(\d+)")
# 95% CI [1.2, 3.4] / 95% CI (0.1-0.9) / 95% CI: -0.3–0.8 / 95% 置信区间 [...]
CI_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*%\s*(?:CI|置信区间)\s*[:：]?\s*[\[\(（]?\s*"
    r"(-?\d+(?:\.\d+)?)\s*[,，–—-]\s*(-?\d+(?:\.\d+)?)\s*[\]\)）]?"
)

# A line's percentages are treated as a composition candidate only when
# their sum falls inside this window; otherwise they are assumed unrelated.
COMPOSE_MIN, COMPOSE_MAX = 95.0, 105.0
COMPOSE_TOL = 0.5


def iter_markdown_files(path):
    """Yield Markdown files: a single file, or *.md recursively under a dir."""
    p = Path(path)
    if p.is_file():
        yield p
    elif p.is_dir():
        yield from sorted(p.rglob("*.md"))


def check_percentages(lines, issues, loc):
    """Range-check every percentage; sum-check same-line compositions."""
    for lineno, line in enumerate(lines, 1):
        values = [float(m.group(1)) for m in PCT_RE.finditer(line)]
        for v in values:
            if v < 0 or v > 100:
                issues.append({
                    "check": "percentage", "location": f"{loc}:{lineno}",
                    "detail": f"percentage {v}% out of range 0-100",
                    "level": "error",
                })
        if len(values) >= 2:
            total = sum(values)
            if COMPOSE_MIN <= total <= COMPOSE_MAX and \
                    abs(total - 100.0) > COMPOSE_TOL:
                detail = (f"percentages {values} sum to {round(total, 2)}, "
                          f"expected 100±{COMPOSE_TOL}")
                issues.append({
                    "check": "percentage", "location": f"{loc}:{lineno}",
                    "detail": detail, "level": "warn",
                })


def check_pvalues(lines, issues, loc):
    """Validate p-value syntax and range."""
    for lineno, line in enumerate(lines, 1):
        for m in PVAL_RE.finditer(line):
            op, raw = m.group(1), m.group(2)
            value = float(raw)
            if value < 0 or value > 1:
                issues.append({
                    "check": "pvalue", "location": f"{loc}:{lineno}",
                    "detail": f"p{op}{raw} outside valid range 0-1",
                    "level": "error",
                })
            elif op == "=" and value == 0.0:
                issues.append({
                    "check": "pvalue", "location": f"{loc}:{lineno}",
                    "detail": "p=0.000 is impossible; write p<0.001 instead",
                    "level": "warn",
                })
            elif raw.count(".") and len(raw.split(".")[1]) > 3 and op == "=":
                issues.append({
                    "check": "pvalue", "location": f"{loc}:{lineno}",
                    "detail": f"p={raw} has >3 decimals; round or use p<0.001",
                    "level": "warn",
                })


def check_sample_sizes(lines, issues, loc):
    """All 'N=<n>' occurrences in one file should agree on the value."""
    hits = []  # (lineno, value)
    for lineno, line in enumerate(lines, 1):
        for m in NSIZE_RE.finditer(line):
            hits.append((lineno, m.group(1)))
    values = {v for _, v in hits}
    if len(values) > 1:
        where = ", ".join(f"line {ln}: N={v}" for ln, v in hits)
        issues.append({
            "check": "samplesize", "location": loc,
            "detail": f"inconsistent sample sizes ({where})", "level": "warn",
        })


def check_confidence_intervals(lines, issues, loc):
    """Lower bound of a confidence interval must not exceed the upper bound."""
    for lineno, line in enumerate(lines, 1):
        for m in CI_RE.finditer(line):
            lo, hi = float(m.group(2)), float(m.group(3))
            if lo > hi:
                issues.append({
                    "check": "ci", "location": f"{loc}:{lineno}",
                    "detail": f"CI bounds reversed: [{lo}, {hi}]",
                    "level": "error",
                })


def scan_file(path, root):
    """Run all checks on one file; return a list of issue dicts."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [{"check": "integrity", "location": str(path),
                 "detail": f"cannot read as UTF-8 ({exc})", "level": "error"}]
    lines = text.splitlines()
    loc = str(path.relative_to(root)) if root else str(path)
    issues = []
    check_percentages(lines, issues, loc)
    check_pvalues(lines, issues, loc)
    check_sample_sizes(lines, issues, loc)
    check_confidence_intervals(lines, issues, loc)
    return issues


def main():
    parser = argparse.ArgumentParser(
        description="Deterministic numeric checks for Markdown reports.")
    parser.add_argument("--path", required=True,
                        help="Markdown file or directory to scan.")
    parser.add_argument("--format", choices=["text", "json"], default="text",
                        help="Output format (default: text).")
    args = parser.parse_args()

    # Keep output readable on Windows GBK consoles.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    target = Path(args.path)
    if not target.exists():
        print(f"error: path not found: {target}", file=sys.stderr)
        sys.exit(2)
    root = target if target.is_dir() else target.parent

    issues = []
    for md in iter_markdown_files(target):
        issues.extend(scan_file(md, root))

    if args.format == "json":
        print(json.dumps({"issues": issues}, ensure_ascii=False, indent=2))
    else:
        if not issues:
            print(f"no issues found in {target}")
        for it in issues:
            print(f"[{it['level']}] {it['check']} @ {it['location']}: "
                  f"{it['detail']}")

    # Non-zero exit when any error-level issue exists (usable in pipelines).
    sys.exit(1 if any(i["level"] == "error" for i in issues) else 0)


if __name__ == "__main__":
    main()
