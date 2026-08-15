"""Shared helpers for github-explore skill scripts.

All scripts in this directory import from _lib. Keep the surface small.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence

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


# ---------- secret redaction ----------

# Credential shapes that must never reach the transcript. Applied to every
# stderr message emitted on error (see warn/die), so a token that leaks into
# gh output is masked instead of being echoed back to the agent or user.
# Each entry is (compiled_pattern, replacement). Order matters: more specific
# shapes (fine-grained PAT) come before generic ones (bearer / key=...).
_SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"github_pat_[A-Za-z0-9_]+"), "github_pat_***"),        # fine-grained PAT
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"), "ghx_***"),             # classic PAT
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{20,}"), r"\1***"),
    (re.compile(r"(?i)\b(token|password|passwd|secret|api[_-]?key)\b(\s*[:=]\s*)\S+"), r"\1\2***"),
    (re.compile(r"(?i)\b(GH_TOKEN|GITHUB_TOKEN)\s*=\s*\S+"), r"\1=***"),
]

def redact_secrets(text: str) -> str:
    """Mask credential-shaped substrings in `text`.

    Best-effort: only obvious credential shapes are redacted, so ordinary
    error text (repo names, URLs, rate-limit messages) passes through intact.
    """
    if not text:
        return text
    out = text
    for pat, repl in _SECRET_PATTERNS:
        out = pat.sub(repl, out)
    return out

# ---------- output ----------

def info(msg: str) -> None:
    """Progress message to stderr so stdout stays pipeable."""
    print(f"… {msg}", file=sys.stderr)


def warn(msg: str) -> None:
    print(f"⚠  {redact_secrets(msg)}", file=sys.stderr)


def die(msg: str, code: int = 1) -> None:
    print(f"✗ {redact_secrets(msg)}", file=sys.stderr)
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


@dataclass(frozen=True)
class Column:
    """One column in a `format_table` render.

    `key` is the dict key looked up on each row; `header` is the printed
    column title; `max_width=0` means no truncation.
    """

    key: str
    header: str
    max_width: int = 0

    def truncate(self, text: str) -> str:
        """Truncate `text` to `max_width`, appending '…' if shortened."""
        if self.max_width and len(text) > self.max_width:
            return text[: max(0, self.max_width - 1)] + "…"
        return text


def format_table(rows: List[Dict[str, Any]], columns: Sequence[Column]) -> str:
    """Render a fixed-width table from `rows` using the given `columns`."""
    if not rows:
        return "(no results)"

    widths: Dict[str, int] = {}
    for col in columns:
        cell_width = max(
            len(col.header),
            *(len(_cell(row.get(col.key))) for row in rows),
        )
        widths[col.key] = min(cell_width, col.max_width) if col.max_width else cell_width

    def _render_cell(row: Dict[str, Any], col: Column) -> str:
        return col.truncate(_cell(row.get(col.key))).ljust(widths[col.key])

    header_line = "  ".join(col.header.ljust(widths[col.key]) for col in columns)
    separator = "  ".join("-" * widths[col.key] for col in columns)
    body = "\n".join(
        "  ".join(_render_cell(row, col) for col in columns)
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

def is_excluded(repo: Dict[str, Any], min_stars: int = 5) -> bool:
    """Return True if `repo` should be dropped from discovery output.

    Filters archived repos, low-star forks, repos below the star floor, and
    description-less low-star repos. Accepts BOTH `stargazerCount` (gh repo
    view, singular) and `stargazersCount` (gh search repos, plural) for
    compatibility.
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
