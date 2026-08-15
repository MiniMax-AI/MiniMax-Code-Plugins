#!/usr/bin/env python3
"""SearXNG Search Script - Search the web via a SearXNG instance.

Reads a local TOML (or legacy JSON) config, builds a request against the
user's configured SearXNG instance, and prints the results as markdown.

Security model:
  - Default scheme: HTTPS. Plain HTTP is allowed only for loopback hosts
    (127.0.0.1, ::1, localhost) or for non-loopback hosts if the config has
    an explicit `allow_insecure_http = true` (with a strong warning).
  - Auth values can be referenced via `$ENV_VAR` / `${ENV_VAR}` so the
    plaintext never lives in the config file.
  - All error output is run through `redact_secrets` so a token that
    leaks into a server response body is masked before reaching stderr.
  - On POSIX, a config file readable beyond the owner (mode & 0o077) is
    flagged with a warning.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python < 3.11
    tomllib = None


# ---------- error / progress helpers ----------

# Credential shapes that must never reach the transcript. Same pattern set
# as the github-explore skill (PR #8) so the agent learns one redaction
# grammar across skills. Order matters: the most specific label-shaped
# patterns run first so the whole token is masked in one pass, not
# partially replaced and then bypassed.
_SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{20,}"), r"\1***"),
    (re.compile(r"(?i)(authorization:\s*basic\s+)[A-Za-z0-9+/=]+"), r"\1***"),
    (re.compile(r"github_pat_[A-Za-z0-9_]+"), "github_pat_***"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"), "ghx_***"),
    (re.compile(r"(?i)\b(token|password|passwd|secret|api[_-]?key)\b(\s*[:=]\s*)\S+"), r"\1\2***"),
    (re.compile(r"(?i)\b(GH_TOKEN|GITHUB_TOKEN|SEARXNG_TOKEN|SEARXNG_USER|SEARXNG_PASS)\s*=\s*\S+"), r"\1=***"),
]


def redact_secrets(text: str) -> str:
    """Mask credential-shaped substrings in `text`.

    Best-effort: only obvious credential shapes are masked, so ordinary
    error text (URLs without embedded tokens, JSON error bodies, rate-limit
    messages) passes through intact.
    """
    if not text:
        return text
    out = text
    for pat, repl in _SECRET_PATTERNS:
        out = pat.sub(repl, out)
    return out


def die(msg: str, code: int = 1) -> None:
    """Print a redacted error to stderr and exit."""
    print(f"ERROR: {redact_secrets(msg)}", file=sys.stderr)
    sys.exit(code)


def warn(msg: str) -> None:
    """Print a redacted warning to stderr."""
    print(f"WARN: {redact_secrets(msg)}", file=sys.stderr)


def info(msg: str) -> None:
    """Progress message to stderr so stdout stays pipeable."""
    print(f"… {msg}", file=sys.stderr)


# ---------- config loading ----------

def check_file_permissions(path: str) -> None:
    """Warn if `path` is readable beyond the owner (POSIX only).

    On platforms that don't expose POSIX mode bits (Windows, where
    `os.stat().st_mode` is a synthetic mode not derived from real ACLs),
    the check is skipped — restricting the file must be done via
    Properties → Security. The docstring was previously aspirational;
    the implementation now matches.
    """
    if os.name != "posix":
        return
    try:
        mode = os.stat(path).st_mode
    except OSError:
        return
    if mode & 0o077:
        warn(
            f"Config file {path} is readable beyond the owner (mode {oct(mode & 0o777)}). "
            "Run `chmod 600` (or platform equivalent) to restrict access."
        )


def load_config():
    config_dir = os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))
    config_dir = os.path.join(config_dir, "agents")
    toml_file = os.path.join(config_dir, "searxng.toml")
    json_file = os.path.join(config_dir, "searxng.json")

    if os.path.isfile(toml_file):
        config_file = toml_file
        if tomllib is None:
            die(
                f"TOML config found at {config_file}, but this Python does not support TOML. "
                "Upgrade to Python 3.11+ or remove the TOML config to use legacy JSON fallback."
            )

        try:
            with open(config_file, "rb") as f:
                config = tomllib.load(f)
        except tomllib.TOMLDecodeError as e:
            die(f"Invalid TOML in {config_file}: {e}")
    elif os.path.isfile(json_file):
        config_file = json_file
        try:
            with open(config_file) as f:
                config = json.load(f)
        except json.JSONDecodeError as e:
            die(f"Invalid JSON in {config_file}: {e}")
    else:
        die(
            f"Config file not found: {toml_file} (legacy JSON fallback path: {json_file}). "
            'Create TOML config with at minimum: base_url = "https://your-searxng-instance.com"'
        )

    if not config.get("base_url"):
        die(f"base_url is required in {config_file}")

    validate_base_url(config["base_url"], config)
    check_file_permissions(config_file)
    return config


def resolve_env(value: str) -> str:
    """Resolve `$ENV_VAR` or `${ENV_VAR}` references in a string.

    If the variable is unset, exit with a clear error. We do NOT fall back
    to using the literal `$VAR` text — that would silently send a
    malformed Authorization header.
    """
    if not value:
        return value
    if value.startswith("$"):
        var_name = value.lstrip("$").strip("{}")
        resolved = os.environ.get(var_name)
        if not resolved:
            die(f"Environment variable {var_name} is not set")
        return resolved
    return value


# ---------- URL validation ----------

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost", "0.0.0.0", "[::1]"})


def validate_base_url(url: str, config: dict) -> None:
    """Validate the configured base_url and exit on policy violation.

    Policy:
      - HTTPS is always accepted.
      - Plain HTTP to a loopback host is accepted silently (common dev
        setup behind a local reverse proxy).
      - Plain HTTP to a non-loopback host is rejected unless the config
        contains `allow_insecure_http = true`. When the opt-in is set, a
        strong warning is emitted because Authorization headers and query
        strings will travel in cleartext.
      - Schemes other than http/https are rejected.
    """
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError as e:
        die(f"base_url could not be parsed: {e}")
    scheme = (parsed.scheme or "").lower()
    host = (parsed.hostname or "").lower()
    if scheme not in ("http", "https"):
        die(f"base_url scheme must be http or https, got {scheme!r}")
    if not host:
        die("base_url is missing a host")
    if scheme == "https":
        return
    # scheme == "http"
    if host in _LOOPBACK_HOSTS:
        return
    if config.get("allow_insecure_http") is True:
        warn(
            f"base_url uses plain HTTP for non-loopback host {host!r}. "
            "Authorization headers and search queries will travel in cleartext. "
            "Switch to https:// unless you have a specific reason to keep HTTP."
        )
        return
    die(
        f"base_url uses plain HTTP for non-loopback host {host!r}, which is "
        "rejected by default (Authorization headers would travel in cleartext). "
        "Use https://, point at a loopback address, or set `allow_insecure_http = true` "
        "in the config (NOT recommended)."
    )


# ---------- request building ----------

def build_request(config: dict, args: argparse.Namespace) -> urllib.request.Request:
    base_url = config["base_url"].rstrip("/")

    params = {
        "q": args.query,
        "format": "json",
        "pageno": str(args.page),
    }

    categories = args.categories or config.get("default_categories")
    if categories:
        params["categories"] = ",".join(categories) if isinstance(categories, list) else categories

    engines = args.engines or config.get("default_engines")
    if engines:
        params["engines"] = ",".join(engines) if isinstance(engines, list) else engines

    language = args.language or config.get("default_language")
    if language:
        params["language"] = language

    safesearch = args.safesearch if args.safesearch is not None else config.get("default_safesearch")
    if safesearch is not None:
        params["safesearch"] = str(safesearch)

    time_range = args.time_range or config.get("default_time_range")
    if time_range:
        params["time_range"] = time_range

    url = f"{base_url}/search?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url)

    auth = config.get("auth", {})
    auth_type = auth.get("type", "")
    if auth_type == "bearer":
        token = resolve_env(auth.get("token", ""))
        if not token:
            die("auth.token required for bearer auth")
        req.add_header("Authorization", f"Bearer {token}")
    elif auth_type == "basic":
        user = resolve_env(auth.get("user", ""))
        password = resolve_env(auth.get("pass", ""))
        if not user or not password:
            die("auth.user and auth.pass required for basic auth")
        credentials = base64.b64encode(f"{user}:{password}".encode()).decode()
        req.add_header("Authorization", f"Basic {credentials}")
    elif auth_type:
        die(f"Unknown auth.type '{auth_type}'. Use 'bearer' or 'basic'.")

    headers = config.get("headers", {})
    for key, value in headers.items():
        req.add_header(key, value)

    if "User-Agent" not in headers and "user-agent" not in {h.lower() for h in headers}:
        req.add_header(
            "User-Agent",
            "searxng-search-skill/1.0 (+https://github.com/Fectivnfy112357/MiniMax-Code-Plugins)",
        )

    return req


# ---------- result formatting ----------

def format_results(data: dict, max_results: int, page: int):
    answers = data.get("answers", [])
    if answers:
        print("# Answers\n")
        for a in answers:
            answer = a if isinstance(a, str) else a.get("answer", "")
            if answer:
                print(f"> {answer}\n")

    for ib in data.get("infoboxes", []):
        name = ib.get("infobox", "")
        content = ib.get("content", "")
        if name:
            print(f"# Infobox: {name}\n")
        if content:
            print(f"{content}\n")
        for attr in ib.get("attributes", []):
            print(f"- **{attr['label']}:** {attr['value']}")
        urls = ib.get("urls", [])
        if urls:
            print()
            for u in urls:
                official = " (official)" if u.get("official") else ""
                print(f"- [{u['title']}{official}]({u['url']})")
        print()

    results = data.get("results", [])
    if not results:
        print("No results found.")
        return

    print("# Results\n")
    for r in results[:max_results]:
        title = r.get("title", "Untitled")
        url = r.get("url", "")
        content = r.get("content", "")
        engines = r.get("engines", [])
        category = r.get("category", "")
        score = r.get("score", 0)
        date = r.get("publishedDate")

        print(f"## [{title}]({url})")
        if content:
            print(f"\n{content}")
        meta = []
        if engines:
            meta.append(f"engines: {','.join(engines)}")
        if category:
            meta.append(f"category: {category}")
        if score:
            meta.append(f"score: {score}")
        if date:
            meta.append(f"date: {date}")
        if meta:
            print(f"\n*{' | '.join(meta)}*")
        print()

    suggestions = data.get("suggestions", [])
    if suggestions:
        print(f"**Suggestions:** {', '.join(suggestions)}\n")

    corrections = data.get("corrections", [])
    if corrections:
        print(f"**Corrections:** {', '.join(corrections)}\n")

    total = len(results)
    shown = min(max_results, total)
    print("---")
    print(f"Showing {shown} of {total} results (page {page})")


# ---------- main ----------

def main():
    parser = argparse.ArgumentParser(description="Search the web using SearXNG")
    parser.add_argument("query", nargs="+", help="Search query")
    parser.add_argument("-c", "--categories", help="Comma-separated categories (e.g. general,news,images)")
    parser.add_argument("-e", "--engines", help="Comma-separated engines (e.g. google,duckduckgo)")
    parser.add_argument("-l", "--language", help="Language code (e.g. en, zh-CN)")
    parser.add_argument("-p", "--page", type=int, default=1, help="Page number (default: 1)")
    parser.add_argument("-t", "--time-range", choices=["day", "month", "year"], help="Time range filter")
    parser.add_argument("-n", "--max-results", type=int, help="Maximum results to display")
    parser.add_argument("-s", "--safesearch", type=int, choices=[0, 1, 2], help="Safe search level: 0, 1, 2")

    args = parser.parse_args()
    args.query = " ".join(args.query)

    config = load_config()

    if args.max_results is None:
        args.max_results = config.get("default_max_results", 5)

    timeout = config.get("timeout", 30)

    req = build_request(config, args)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode()
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode() if e.fp else ""
        except Exception:
            body = ""
        die(f"HTTP {e.code}: {body[:500]}")
    except urllib.error.URLError as e:
        die(f"Request failed: {e.reason}")
    except TimeoutError:
        die(f"Request timed out after {timeout}s")

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        die(f"Invalid JSON response from SearXNG. Response: {body[:500]}")

    if "error" in data:
        die(f"SearXNG returned error: {data['error']}")

    format_results(data, args.max_results, args.page)


if __name__ == "__main__":
    main()
