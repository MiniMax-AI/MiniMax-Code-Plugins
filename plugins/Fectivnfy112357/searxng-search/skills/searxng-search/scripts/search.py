#!/usr/bin/env python3
"""SearXNG Search Script - Search the web via a SearXNG instance."""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python < 3.11
    tomllib = None


def load_config():
    config_dir = os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))
    config_dir = os.path.join(config_dir, "agents")
    toml_file = os.path.join(config_dir, "searxng.toml")
    json_file = os.path.join(config_dir, "searxng.json")

    if os.path.isfile(toml_file):
        config_file = toml_file
        if tomllib is None:
            print(
                f"ERROR: TOML config found at {config_file}, but this Python does not support TOML.",
                file=sys.stderr,
            )
            print("Upgrade to Python 3.11+ or remove the TOML config to use legacy JSON fallback.", file=sys.stderr)
            sys.exit(1)

        try:
            with open(config_file, "rb") as f:
                config = tomllib.load(f)
        except tomllib.TOMLDecodeError as e:
            print(f"ERROR: Invalid TOML in {config_file}: {e}", file=sys.stderr)
            sys.exit(1)
    elif os.path.isfile(json_file):
        config_file = json_file
        try:
            with open(config_file) as f:
                config = json.load(f)
        except json.JSONDecodeError as e:
            print(f"ERROR: Invalid JSON in {config_file}: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        print(f"ERROR: Config file not found: {toml_file}", file=sys.stderr)
        print(
            f"Legacy JSON fallback path: {json_file}",
            file=sys.stderr,
        )
        print(
            'Create TOML config with at minimum: base_url = "https://your-searxng-instance.com"',
            file=sys.stderr,
        )
        sys.exit(1)

    if not config.get("base_url"):
        print(f"ERROR: base_url is required in {config_file}", file=sys.stderr)
        sys.exit(1)

    return config


def resolve_env(value: str) -> str:
    """Resolve $ENV_VAR or ${ENV_VAR} references in a string."""
    if not value:
        return value
    if value.startswith("$"):
        var_name = value.lstrip("$").strip("{}")
        resolved = os.environ.get(var_name)
        if not resolved:
            print(f"ERROR: Environment variable {var_name} is not set", file=sys.stderr)
            sys.exit(1)
        return resolved
    return value


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

    # Auth
    auth = config.get("auth", {})
    auth_type = auth.get("type", "")
    if auth_type == "bearer":
        token = resolve_env(auth.get("token", ""))
        if not token:
            print("ERROR: auth.token required for bearer auth", file=sys.stderr)
            sys.exit(1)
        req.add_header("Authorization", f"Bearer {token}")
    elif auth_type == "basic":
        user = resolve_env(auth.get("user", ""))
        password = resolve_env(auth.get("pass", ""))
        if not user or not password:
            print("ERROR: auth.user and auth.pass required for basic auth", file=sys.stderr)
            sys.exit(1)
        credentials = base64.b64encode(f"{user}:{password}".encode()).decode()
        req.add_header("Authorization", f"Basic {credentials}")
    elif auth_type:
        print(f"ERROR: Unknown auth.type '{auth_type}'. Use 'bearer' or 'basic'.", file=sys.stderr)
        sys.exit(1)

    # Headers
    headers = config.get("headers", {})
    for key, value in headers.items():
        req.add_header(key, value)

    # Set a reasonable User-Agent if not already set via headers
    if "User-Agent" not in headers:
        req.add_header("User-Agent", "searxng-search-skill (+https://github.com/XYenon/agents)")

    return req


def format_results(data: dict, max_results: int, page: int):
    # Answers — direct answers from engines
    answers = data.get("answers", [])
    if answers:
        print("# Answers\n")
        for a in answers:
            answer = a if isinstance(a, str) else a.get("answer", "")
            if answer:
                print(f"> {answer}\n")

    # Infoboxes — knowledge panel style info
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

    # Search results
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

    # Suggestions
    suggestions = data.get("suggestions", [])
    if suggestions:
        print(f"**Suggestions:** {', '.join(suggestions)}\n")

    # Corrections
    corrections = data.get("corrections", [])
    if corrections:
        print(f"**Corrections:** {', '.join(corrections)}\n")

    total = len(results)
    shown = min(max_results, total)
    print("---")
    print(f"Showing {shown} of {total} results (page {page})")


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
        body = e.read().decode() if e.fp else ""
        print(f"ERROR: HTTP {e.code}: {body[:500]}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"ERROR: Request failed: {e.reason}", file=sys.stderr)
        sys.exit(1)
    except TimeoutError:
        print(f"ERROR: Request timed out after {timeout}s", file=sys.stderr)
        sys.exit(1)

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        print("ERROR: Invalid JSON response from SearXNG", file=sys.stderr)
        print(f"Response: {body[:500]}", file=sys.stderr)
        sys.exit(1)

    if "error" in data:
        print(f"ERROR: SearXNG returned error: {data['error']}", file=sys.stderr)
        sys.exit(1)

    format_results(data, args.max_results, args.page)


if __name__ == "__main__":
    main()
