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
    The set of *exact* secrets used for the current request is tracked
    so that even short/non-shape-matching tokens are masked (shape-based
    patterns are a fallback, not the primary defense).
  - HTTP redirects are blocked entirely. A 30x response raises
    HTTPError with a "redirect blocked" diagnostic. This prevents the
    default urllib redirect handler from forwarding Authorization
    headers to a different origin (e.g. an initial loopback URL
    returning 302 to a different port), and prevents silent HTTPS→HTTP
    downgrades. Configure base_url to point at the final endpoint, or
    front the instance with a same-origin reverse proxy.
  - HTTPError bodies for authentication-class status codes (401, 403,
    407) are NOT echoed to stderr. These responses frequently reflect
    back the credentials the server saw, and the shape-based redaction
    can be bypassed by tokens that don't match a known pattern.
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

# Per-process registry of exact credential strings used by the current
# request. `redact_secrets` masks these BEFORE applying shape-based
# patterns, so even a short token that doesn't match any known shape
# is removed from the transcript. Cleared on every call to
# `reset_active_secrets` (driven by `load_config`).
_active_secrets: set[str] = set()


def reset_active_secrets() -> None:
    """Clear the per-request secret registry.

    Called by `load_config` so a config reload does not let an old
    secret linger in the redaction set indefinitely.
    """
    _active_secrets.clear()


def register_secret(value: str) -> None:
    """Record `value` as a secret to mask in any subsequent error output.

    No-op for empty values. The set is deduplicated, so a token that
    was registered once does not need to be re-registered on each call.
    """
    if not value:
        return
    _active_secrets.add(value)


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
    """Mask credential substrings in `text`.

    Two-pass strategy:
      1. Exact substitution of every value registered via
         `register_secret` (the actual token/password/basic-credential
         used for the current request). This catches short or otherwise
         shape-non-conforming secrets that pattern matching would miss.
      2. Shape-based pattern matching for stray credentials that escaped
         the registry (e.g. embedded in a third-party server response
         that the script never used).

    Best-effort: ordinary error text (URLs without embedded tokens,
    JSON error bodies, rate-limit messages) passes through intact.
    """
    if not text:
        return text
    out = text
    # Pass 1: exact secret values from the active registry. Sort by
    # length descending so a substring secret is replaced before its
    # containing string (e.g. "abc" before "abcdef").
    for secret in sorted(_active_secrets, key=len, reverse=True):
        if secret and secret in out:
            out = out.replace(secret, "***")
    # Pass 2: shape-based fallback.
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


# ---------- config loading ----------

def _require_int(config: dict, key: str, default: int) -> int:
    """Return `config[key]` if it is an integer, otherwise exit clearly.

    TOML is typed, but a hand-edited config can contain `timeout = "30"`
    or `default_max_results = "5"`. Passing such a value to urllib (or
    using it to slice results) raises a raw `TypeError` traceback that
    bypasses the redacted-error pipeline; fail with a clear message
    instead. Booleans are rejected too (`True` is an `int` subclass).
    """
    value = config.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        die(
            f"config field {key!r} must be an integer, "
            f"got {type(value).__name__} ({value!r})"
        )
    return value


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
    # Fail fast on wrong-typed numeric fields instead of surfacing a raw
    # TypeError from urllib or from result slicing later.
    _require_int(config, "timeout", 30)
    _require_int(config, "default_max_results", 5)
    # Drop any secrets left over from a previous run; the new config
    # will re-register its own values during build_request.
    reset_active_secrets()
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


# ---------- request execution (safe opener) ----------

# Upper bound on how many bytes we will read from the instance before
# failing. SearXNG search responses are typically a few hundred KB at
# most; an unbounded read lets a misbehaving or hijacked endpoint exhaust
# memory/disk. The error body read is capped with the same constant.
MAX_RESPONSE_BYTES = 10 * 1024 * 1024  # 10 MiB

# Status codes whose response body we suppress. These codes mean
# "authentication challenge" and the response body frequently reflects
# back the credentials the server saw, in arbitrary shapes that a
# pattern-based redactor cannot reliably cover. Combined with the
# exact-secret registry in `redact_secrets`, suppressing the body for
# these codes closes the residual leak surface.
_AUTH_ERROR_CODES = frozenset({401, 403, 407})


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Block all 3xx responses with a clear diagnostic.

    Rationale: the default `urllib.request.HTTPRedirectHandler` will
    transparently re-issue the request to a `Location:` URL, INCLUDING
    the `Authorization` header from the original request. A misconfigured
    `base_url` (e.g. an instance fronted by a load balancer that 302s to
    a different port) would leak the Bearer/Basic token to a host the
    user never explicitly trusted. It also permits silent HTTPS→HTTP
    downgrades, which violates the same-origin HTTPS guarantee the
    validator establishes for the initial request.

    Instead of trying to police every hop (same-origin? same-port?
    same-scheme? didn't the user already pass validation for the *first*
    URL?), we reject all redirects and tell the user to point `base_url`
    at the final endpoint, or front the instance with a same-origin
    reverse proxy.
    """

    _REDIRECT_LABELS = {
        301: "301 Moved Permanently",
        302: "302 Found",
        303: "303 See Other",
        307: "307 Temporary Redirect",
        308: "308 Permanent Redirect",
    }

    def _block(self, req, code, msg, headers):
        # Show a *safe* form of Location: scheme://host[:port]/path, no
        # query or fragment, so the diagnostic is useful without
        # potentially echoing embedded credentials.
        loc_raw = headers.get("Location", "") if headers else ""
        safe_loc = ""
        if loc_raw:
            try:
                p = urllib.parse.urlparse(loc_raw)
                host = p.hostname or ""
                if p.port:
                    host = f"{host}:{p.port}"
                safe_loc = f"{p.scheme}://{host}{p.path}"
            except Exception:
                safe_loc = "(unparseable)"
        label = self._REDIRECT_LABELS.get(code, f"{code}")
        raise urllib.error.HTTPError(
            req.get_full_url(),
            code,
            f"redirect blocked: {label} to {safe_loc or '(none)'}. "
            "Configure base_url to point directly at the final endpoint, "
            "or front the instance with a same-origin reverse proxy. "
            "This skill does not follow redirects because the "
            "Authorization header would otherwise be forwarded to the "
            "redirect target.",
            headers,
            None,
        )

    def http_error_301(self, req, fp, code, msg, headers):
        return self._block(req, code, msg, headers)

    def http_error_302(self, req, fp, code, msg, headers):
        return self._block(req, code, msg, headers)

    def http_error_303(self, req, fp, code, msg, headers):
        return self._block(req, code, msg, headers)

    def http_error_307(self, req, fp, code, msg, headers):
        return self._block(req, code, msg, headers)

    def http_error_308(self, req, fp, code, msg, headers):
        return self._block(req, code, msg, headers)


def _build_opener():
    """Construct a urllib opener that uses `_SafeRedirectHandler`.

    We pass our handler to `build_opener` so it replaces the default
    redirect handler (rather than chaining on top of it). All other
    default handlers (HTTPSHandler, HTTPHandler, etc.) are kept.
    """
    return urllib.request.build_opener(_SafeRedirectHandler())


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
        register_secret(token)
        req.add_header("Authorization", f"Bearer {token}")
    elif auth_type == "basic":
        user = resolve_env(auth.get("user", ""))
        password = resolve_env(auth.get("pass", ""))
        if not user or not password:
            die("auth.user and auth.pass required for basic auth")
        register_secret(user)
        register_secret(password)
        credentials = base64.b64encode(f"{user}:{password}".encode()).decode()
        register_secret(credentials)  # the base64 form may also be reflected by the server
        req.add_header("Authorization", f"Basic {credentials}")
    elif auth_type:
        die(f"Unknown auth.type '{auth_type}'. Use 'bearer' or 'basic'.")

    headers = config.get("headers", {})
    for key, value in headers.items():
        if not isinstance(value, str):
            die(f"config field {key!r} in headers must be a string, got {type(value).__name__}")
        resolved = resolve_env(value)
        if value.startswith("$"):
            # An explicit $ENV_VAR reference marks this value as a
            # secret: register the resolved value for exact redaction in
            # any later error output, exactly like auth.* values.
            register_secret(resolved)
        req.add_header(key, resolved)

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
    opener = _build_opener()

    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            die(f"SearXNG response exceeded the {MAX_RESPONSE_BYTES}-byte limit")
        try:
            body = raw.decode("utf-8")
        except UnicodeDecodeError:
            die("SearXNG returned a non-UTF-8 response body")
    except urllib.error.HTTPError as e:
        # Authentication-class responses (401/403/407) frequently
        # reflect back the credentials the server saw. Even with
        # exact-secret redaction, refusing to echo the body for these
        # codes removes a residual leak surface.
        if e.code in _AUTH_ERROR_CODES:
            die(
                f"HTTP {e.code}: body suppressed to avoid leaking "
                "credentials (check base_url, auth credentials, and "
                "SearXNG instance configuration)"
            )
        # Redirect-class responses (30x) only reach us via
        # `_SafeRedirectHandler`, which raises HTTPError with fp=None
        # and a diagnostic in `e.msg` / `e.reason`. Show that diagnostic
        # instead of an empty body so the user knows how to fix
        # `base_url`.
        if 300 <= e.code < 400:
            diagnostic = getattr(e, "msg", None) or str(e) or "redirect blocked"
            die(f"HTTP {e.code}: {diagnostic}")
        try:
            body = e.read(MAX_RESPONSE_BYTES + 1).decode() if e.fp else ""
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

    if not isinstance(data, dict):
        die("Invalid JSON response from SearXNG: expected a JSON object at the top level")

    if "error" in data:
        die(f"SearXNG returned error: {data['error']}")

    format_results(data, args.max_results, args.page)


if __name__ == "__main__":
    main()
