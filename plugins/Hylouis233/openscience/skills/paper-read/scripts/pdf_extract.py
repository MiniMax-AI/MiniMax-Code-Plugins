#!/usr/bin/env python3
"""Extract text from a PDF file with an honest degradation chain.

Extractor priority:
  1. pdftotext (poppler) found on PATH -> subprocess call
  2. pypdf already installed in this Python environment -> import
  3. neither -> structured dependency_missing error (exit 2)

Never crashes with a traceback: failures print a structured error object
to stdout so the calling agent can record them. Exit codes:
0 = success, 1 = input/extraction failure, 2 = dependency missing.

Usage: pdf_extract.py --input <pdf> --format json [--pages 1-5]
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

SUBPROCESS_TIMEOUT = 120  # seconds per pdftotext run


def emit(obj, exit_code):
    """Print obj as pretty JSON to stdout and return the exit code."""
    # Windows consoles often default to GBK; force UTF-8 to never crash.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    json.dump(obj, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return exit_code


def parse_page_spec(spec):
    """Parse a '--pages' value like '1-5' (or '3') into (first, last)."""
    if not spec:
        return None, None
    parts = spec.split("-", 1)
    first, last = int(parts[0]), int(parts[-1])
    if first < 1 or last < first:
        raise ValueError(spec)
    return first, last


def extract_with_pdftotext(pdf, first, last):
    """Extract via poppler pdftotext; pages split on the form-feed mark."""
    cmd = ["pdftotext", "-enc", "UTF-8"]
    if first is not None:
        cmd += ["-f", str(first), "-l", str(last)]
    cmd += [str(pdf), "-"]  # trailing '-' writes text to stdout
    proc = subprocess.run(cmd, capture_output=True, timeout=SUBPROCESS_TIMEOUT)
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(detail or "pdftotext exited %d" % proc.returncode)
    chunks = proc.stdout.decode("utf-8", "replace").split("\f")
    if chunks and not chunks[-1].strip():  # drop the trailing empty chunk
        chunks.pop()
    start = first or 1
    pages = [{"page": start + i, "text": c.strip()} for i, c in enumerate(chunks)]
    return pages, "pdftotext"


def extract_with_pypdf(pdf, first, last):
    """Extract via pypdf; only pages inside [first, last] are returned."""
    from pypdf import PdfReader
    reader = PdfReader(str(pdf))
    pages = []
    for idx, page in enumerate(reader.pages, start=1):
        if first is not None and not (first <= idx <= last):
            continue
        pages.append({"page": idx, "text": (page.extract_text() or "").strip()})
    return pages, "pypdf"


def available_extractors():
    """Build the ordered extractor chain from what this environment has."""
    chain = []
    if shutil.which("pdftotext"):
        chain.append(extract_with_pdftotext)
    try:
        import pypdf  # noqa: F401 -- availability probe only
        chain.append(extract_with_pypdf)
    except ImportError:
        pass
    return chain


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="path to the PDF file")
    parser.add_argument("--format", default="json", choices=["json"])
    parser.add_argument("--pages",
                        help="1-based page range, e.g. 1-5 (default: all pages)")
    args = parser.parse_args(argv)

    try:
        first, last = parse_page_spec(args.pages)
    except ValueError:
        return emit({"error": {"type": "bad_pages", "message":
                               "invalid --pages %r; use e.g. 1-5" % args.pages}}, 1)

    pdf = Path(args.input)
    if not pdf.is_file():
        return emit({"error": {"type": "input_missing",
                               "message": "file not found: %s" % pdf}}, 1)

    chain = available_extractors()
    if not chain:
        return emit({"error": {"type": "dependency_missing", "message":
                               "no PDF extractor available: install poppler "
                               "(pdftotext on PATH) or run 'pip install pypdf'"}}, 2)

    failures = []
    for extract in chain:  # honest degradation: try each tier, record failures
        try:
            pages, name = extract(pdf, first, last)
            return emit({"path": str(pdf), "pages": pages, "extractor": name,
                         "chars": sum(len(p["text"]) for p in pages)}, 0)
        except Exception as exc:  # unreadable/corrupt PDF -> try next tier
            failures.append("%s: %s" % (extract.__name__, exc))
    return emit({"error": {"type": "extract_failed",
                           "message": "; ".join(failures)}}, 1)


if __name__ == "__main__":
    sys.exit(main())
