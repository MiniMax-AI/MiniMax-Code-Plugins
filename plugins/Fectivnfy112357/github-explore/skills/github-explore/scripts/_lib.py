"""Shared helpers for github-explore skill scripts.

All scripts in this directory import from _lib. Keep the surface small.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# ---------- stdout encoding ----------
# On Windows, PowerShell defaults to the OEM/ANSI code page (e.g. CP936/GBK),
# so UTF-8 output (★, ✓, →, etc.) renders as ?. Reconfigure stdout/stderr to
# UTF-8 so the agent and humans see the same bytes the script emits. Fail
# silently on Python < 3.7 or non-reconfigurable streams (CI logs etc.).
for _stream in (sys.stdout, sys.stderr):
    reconfigure = getattr(_stream, "reconfigure", None)
    if reconfigure is not None:
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

# ---------- gh invocation ----------

def run_gh(args: Sequence[str], timeout: int = 90) -> subprocess.CompletedProcess:
    """Run a `gh` command. Raises on failure unless check=False."""
    try:
        return subprocess.run(
            ["gh", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        die("`gh` CLI not found on PATH. Install from https://cli.github.com/")
    except subprocess.TimeoutExpired:
        die(f"gh command timed out after {timeout}s: gh {' '.join(args[:3])}...")


def gh_json(args: Sequence[str], timeout: int = 90) -> Any:
    """Run gh with --json and parse output. Returns None if empty."""
    result = run_gh(args, timeout=timeout)
    if result.returncode != 0:
        msg = (result.stderr or result.stdout or "").strip()
        die(f"gh command failed: gh {' '.join(args[:5])}...\n  {msg}")
    out = (result.stdout or "").strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError as e:
        die(f"Failed to parse gh JSON: {e}\nFirst 200 chars: {out[:200]}")


def gh_text(args: Sequence[str], timeout: int = 90) -> str:
    """Run gh and return stdout text."""
    result = run_gh(args, timeout=timeout)
    if result.returncode != 0:
        msg = (result.stderr or result.stdout or "").strip()
        die(f"gh command failed: gh {' '.join(args[:5])}...\n  {msg}")
    return result.stdout


def ensure_auth() -> None:
    """Verify gh is authenticated; exit with a clear message if not."""
    result = run_gh(["auth", "status"], timeout=10)
    if result.returncode != 0:
        die(
            "Not authenticated with GitHub. Run `gh auth login` first, "
            "or set GH_TOKEN environment variable."
        )


# ---------- output ----------

def info(msg: str) -> None:
    """Progress message to stderr so stdout stays pipeable."""
    print(f"… {msg}", file=sys.stderr)


def warn(msg: str) -> None:
    print(f"⚠  {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> None:
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(code)


# ---------- output schema (contract) ----------

def print_schema(schema_filename: str, script_label: str) -> None:
    """Print a script's output JSON schema (field contract) and exit 0.

    The schema files live in scripts/schemas/ and are the single source of
    truth for output structure. --schema lets the agent read the contract
    instead of guessing field names (fullName vs full_name, nested keys, ...).
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "schemas", schema_filename)
    if not os.path.exists(path):
        die(f"schema file not found: {path}")
    print(f"# {script_label} output schema (see scripts/schemas/{schema_filename})")
    with open(path, encoding="utf-8") as fh:
        print(fh.read())
    sys.exit(0)


def detect_format(args_format: Optional[str]) -> str:
    """Pick output format: explicit, else markdown.

    Default is markdown (was: table) so callers automatically get the layered
    summary + disk-written full report. table is still selectable via
    --format table; json via --format json.

    Note: we don't auto-switch to json when piped, because the typical caller
    is a terminal that captures stdout via PIPE (sys.stdout.isatty()==False).
    Silently switching them to JSON would skip the disk-write path and the
    user would never see the report landed.
    """
    if args_format:
        return args_format
    return "markdown"


def format_table(rows: List[Dict[str, Any]], columns: List[Tuple[str, str, int]]) -> str:
    """Render a fixed-width table.

    columns: list of (key, header, max_width). max_width=0 means no truncation.
    """
    if not rows:
        return "(no results)"

    widths: Dict[str, int] = {}
    for key, header, max_w in columns:
        cell_width = max(
            len(header),
            *(len(_cell(row.get(key))) for row in rows),
        )
        widths[key] = min(cell_width, max_w) if max_w else cell_width

    def _render_cell(row: Dict[str, Any], key: str, w: int) -> str:
        text = _cell(row.get(key))
        if w and len(text) > w:
            text = text[: max(0, w - 1)] + "…"
        return text.ljust(w)

    header_line = "  ".join(header.ljust(widths[key]) for key, header, _ in columns)
    separator = "  ".join("-" * widths[key] for key, _, _ in columns)
    body = "\n".join(
        "  ".join(_render_cell(row, key, widths[key]) for key, _, _ in columns)
        for row in rows
    )
    return f"{header_line}\n{separator}\n{body}"


def _cell(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, (list, tuple)):
        return ", ".join(str(x) for x in v)
    return str(v).replace("\n", " ")


# ---------- time helpers ----------

def parse_since(s: str) -> str:
    """Convert human duration to a GitHub-search date qualifier.

    Examples: '30d' -> '>2025-07-11', '6m' -> '>2025-02-10', '1y' -> '>2024-08-10'
    """
    if not s or len(s) < 2:
        raise ValueError(f"Invalid duration: {s!r}. Use e.g. 30d, 6m, 1y.")

    unit = s[-1].lower()
    try:
        n = int(s[:-1])
    except ValueError as e:
        raise ValueError(f"Invalid duration: {s!r}") from e

    now = datetime.now()
    if unit == "d":
        dt = now - timedelta(days=n)
    elif unit == "w":
        dt = now - timedelta(weeks=n)
    elif unit == "m":
        dt = now - timedelta(days=n * 30)
    elif unit == "y":
        dt = now - timedelta(days=n * 365)
    else:
        raise ValueError(f"Unknown unit {unit!r} in {s!r}. Use d/w/m/y.")
    return dt.strftime("%Y-%m-%d")


def humanize_date(iso: Optional[str]) -> str:
    """YYYY-MM-DD slice of an ISO timestamp; '' if None."""
    if not iso:
        return ""
    return iso[:10]


# ---------- repo filtering helpers ----------

def is_low_quality(repo: Dict[str, Any], min_stars: int = 5) -> bool:
    """Heuristic to drop demo/empty/archived repos from discovery output.

    Accepts BOTH `stargazerCount` (gh repo view, singular) and
    `stargazersCount` (gh search repos, plural) for compatibility.
    """
    stars = repo.get("stargazersCount") or repo.get("stargazerCount") or 0
    if repo.get("isArchived"):
        return True
    if repo.get("isFork") and stars < 50:
        return True
    if stars < min_stars:
        return True
    desc = (repo.get("description") or "").strip()
    if not desc and stars < 100:
        return True
    return False


def dedupe_repos(repos: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Dedupe by fullName, preserving order."""
    seen = set()
    out: List[Dict[str, Any]] = []
    for r in repos:
        key = r.get("fullName") or r.get("name")
        if key and key not in seen:
            seen.add(key)
            out.append(r)
    return out
