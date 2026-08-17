#!/usr/bin/env python3
"""smoke.py — PR-reproducible smoke test for the openclaw-acp-bridge Plugin.

Validates that this Plugin can talk to an OpenClaw-mcode-ACP server.
Does NOT require MiniMax Code or mcode itself. Runs in <10s.

Checks:
  1. $ACP_HOME env var is set and points to an OpenClaw-mcode-ACP checkout.
  2. SDK is importable from $ACP_HOME/openclaw-skill/.
  3. acp_paths resolves cross-platform (no hardcoded D:\\ paths in SDK source).
  4. /acp/health returns 200 (no auth required for health).
  5. /acp/inbox/write + /acp/inbox/read roundtrip works (requires $ACP_TOKEN).
  6. Plugin SKILL.md files reference $ACP_HOME (not hardcoded D:/openclaw-acp).

Security:
  - By default, the Bearer token is only sent to a loopback address
    (127.0.0.0/8, ::1, localhost) over HTTP.
  - Remote targets are disabled unless ACP_ALLOW_REMOTE_HTTPS=1 AND the
    URL is https://. Plain HTTP to a non-loopback host is refused outright.

Usage:
    export ACP_HOME=/path/to/openclaw-mcode-acp           # POSIX
    $env:ACP_HOME = 'D:\\path\\to\\openclaw-mcode-acp'    # PowerShell
    export ACP_TOKEN=<server token>
    python scripts/smoke.py

    # Remote (opt-in, HTTPS only):
    export ACP_ALLOW_REMOTE_HTTPS=1
    export ACP_BASE_URL=https://acp.example.com:8443
    python scripts/smoke.py

Exit code: 0 on full pass, 1 on any failure.
"""
from __future__ import annotations
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

_failures: list[str] = []
_passes: list[str] = []


def check(cond: bool, msg: str) -> None:
    (record_pass if cond else record_fail)(msg)


def record_pass(msg: str) -> None:
    _passes.append(msg)
    print(f'  [PASS] {msg}')


def record_fail(msg: str) -> None:
    _failures.append(msg)
    print(f'  [FAIL] {msg}')


# --- 0. base URL validation (token transport boundary) --------------------
print('\n[Check 0] ACP_BASE_URL loopback / HTTPS boundary')


def is_loopback_host(host: str) -> bool:
    """Return True if host is loopback (127.0.0.0/8, ::1, localhost)."""
    if not host:
        return False
    h = host.lower()
    if h == 'localhost' or h == '::1':
        return True
    if h.startswith('127.'):
        return True
    return False


def validate_base_url(url: str) -> tuple[bool, str]:
    """Validate the target URL for token transport.

    Default policy: loopback only.
    Remote policy:  requires ACP_ALLOW_REMOTE_HTTPS=1 AND https://.

    Returns (ok, reason). When ok=False, reason explains why and the caller
    MUST refuse to send the token.
    """
    p = urlparse(url)
    if p.scheme not in ('http', 'https'):
        return False, f"scheme must be http or https (got {p.scheme!r})"
    host = (p.hostname or '').lower()
    if not host:
        return False, "URL is missing a host"
    if is_loopback_host(host):
        return True, f"loopback:{p.scheme}://{host}:{p.port or (443 if p.scheme == 'https' else 80)}"
    # Remote target — strict opt-in
    if os.environ.get('ACP_ALLOW_REMOTE_HTTPS') != '1':
        return False, (
            f"remote target {host!r} refused. Set ACP_ALLOW_REMOTE_HTTPS=1 "
            "to opt in (HTTPS only)."
        )
    if p.scheme != 'https':
        return False, f"remote target {host!r} must use https (got {p.scheme!r})"
    return True, f"remote-https:{host}"


raw_base = os.environ.get('ACP_BASE_URL', 'http://127.0.0.1:9999')
ok, reason = validate_base_url(raw_base)
if not ok:
    record_fail(f'ACP_BASE_URL={raw_base!r} rejected: {reason}')
    base_url = None
else:
    base_url = raw_base
    if reason.startswith('remote-https:'):
        print(f'  [WARN] ACP_BASE_URL={base_url}')
        print('  [WARN] Sending ACP_TOKEN over the network to a remote host.')
        print('  [WARN] This exposes your local loopback secret externally.')
        record_pass(f'ACP_BASE_URL accepted as remote HTTPS target ({reason})')
    else:
        record_pass(f'ACP_BASE_URL accepted as loopback ({reason})')


# --- 1. ACP_HOME is set and usable ----------------------------------------
print('\n[Check 1] $ACP_HOME environment variable')
acp_home = os.environ.get('ACP_HOME')
if not acp_home:
    record_fail('ACP_HOME is not set; install OpenClaw-mcode-ACP and '
                'export ACP_HOME=<path> (see Plugin README)')
else:
    acp_home_path = Path(acp_home).expanduser().resolve()
    check(acp_home_path.is_dir(),
          f'ACP_HOME points to an existing directory ({acp_home_path})')
    sdk_dir = acp_home_path / 'openclaw-skill'
    check(sdk_dir.is_dir(),
          f'SDK directory exists: {sdk_dir}')
    check((sdk_dir / 'acp_tools.py').is_file(),
          f'acp_tools.py present at {sdk_dir / "acp_tools.py"}')
    check((sdk_dir / 'acp_paths.py').is_file(),
          f'acp_paths.py present at {sdk_dir / "acp_paths.py"}')


# --- 2. SDK is importable --------------------------------------------------
print('\n[Check 2] SDK importable from $ACP_HOME/openclaw-skill/')
if acp_home:
    sys.path.insert(0, str(Path(acp_home).expanduser().resolve() / 'openclaw-skill'))
    try:
        import acp_paths  # noqa: F401
        record_pass('acp_paths imports cleanly')
        import acp_tools  # noqa: F401
        record_pass('acp_tools imports cleanly')
    except Exception as e:
        record_fail(f'SDK import failed: {e}')
else:
    record_fail('skipped (ACP_HOME not set)')


# --- 3. acp_paths resolves cross-platform ----------------------------------
print('\n[Check 3] acp_paths resolves cross-platform')
if acp_home:
    try:
        from acp_paths import resolve_acp_home  # type: ignore
        resolved = resolve_acp_home()
        check(isinstance(resolved, Path),
              f'resolve_acp_home returns Path ({resolved})')
        record_pass(f'resolve_acp_home default = {resolved}')
    except Exception as e:
        record_fail(f'acp_paths.resolve_acp_home failed: {e}')
    # Static check: SDK source must not hardcode a default path
    sdk_text = (Path(acp_home) / 'openclaw-skill' / 'acp_paths.py').read_text(
        encoding='utf-8', errors='ignore'
    )
    if re.search(r'["\']D:[/\\\\]openclaw-acp["\']', sdk_text):
        record_fail('acp_paths.py hardcodes a D:\\openclaw-acp default')
    else:
        record_pass('acp_paths.py does not hardcode D:\\openclaw-acp')


# --- 4. /acp/health returns 200 (no auth) ---------------------------------
print('\n[Check 4] Server /acp/health (no auth required)')
MIN_SERVER_VERSION = 'v7-bidir'
if base_url is None:
    record_fail('skipped (ACP_BASE_URL rejected by Check 0)')
else:
    try:
        with urllib.request.urlopen(f'{base_url}/acp/health', timeout=5) as r:
            check(r.status == 200, f'GET /acp/health → 200')
            body = json.loads(r.read().decode('utf-8'))
            check(body.get('status') == 'ok',
                  f'health body has status=ok (version={body.get("version")})')
            check('inbox' in body,
                  'health body advertises inbox (requires v7-bidir+)')
            version = body.get('version', '')
            check(version.startswith(MIN_SERVER_VERSION),
                  f"server version {version!r} satisfies required "
                  f"{MIN_SERVER_VERSION} or later")
    except urllib.error.URLError as e:
        record_fail(f'cannot reach server at {base_url}: {e}')
    except Exception as e:
        record_fail(f'/acp/health failed: {e}')


# --- 5. Inbox write/read roundtrip (requires $ACP_TOKEN) -------------------
print('\n[Check 5] Inbox write/read roundtrip (requires $ACP_TOKEN)')
token = os.environ.get('ACP_TOKEN')
if not token:
    record_fail('ACP_TOKEN not set; skip auth check (set it to test roundtrip)')
elif base_url is None:
    record_fail('skipped (ACP_BASE_URL rejected by Check 0 — token not sent)')
else:
    try:
        # Write
        write_body = json.dumps({
            'session_id': 'plugin-smoke',
            'sender': 'plugin',
            'content': 'smoke test from openclaw-acp-bridge',
        }).encode('utf-8')
        req = urllib.request.Request(
            f'{base_url}/acp/inbox/write',
            data=write_body,
            headers={
                'Authorization': f'Bearer {token}',
                'Content-Type': 'application/json',
            },
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            wr = json.loads(r.read().decode('utf-8'))
            check('message_id' in wr,
                  f'POST /acp/inbox/write returned message_id ({wr.get("message_id")})')
        # Read
        read_req = urllib.request.Request(
            f'{base_url}/acp/inbox/read?session_id=plugin-smoke&since_id=0',
            headers={'Authorization': f'Bearer {token}'},
        )
        with urllib.request.urlopen(read_req, timeout=5) as r:
            rd = json.loads(r.read().decode('utf-8'))
            msgs = rd.get('messages', [])
            check(len(msgs) >= 1,
                  f'GET /acp/inbox/read returned {len(msgs)} message(s)')
            check(msgs and msgs[-1].get('sender') == 'plugin',
                  'latest message has sender=plugin')
    except Exception as e:
        record_fail(f'inbox roundtrip failed: {e}')


# --- 6. Plugin SKILL.md files use ACP_HOME, not hardcoded paths -----------
print('\n[Check 6] Plugin SKILL.md files reference $ACP_HOME')
PLUGIN_ROOT = Path(__file__).resolve().parent.parent
HARDCODED_RE = re.compile(r"D:[/\\\\]openclaw-acp")
for skill_md in PLUGIN_ROOT.glob('skills/*/SKILL.md'):
    text = skill_md.read_text(encoding='utf-8')
    rel = skill_md.relative_to(PLUGIN_ROOT)
    if HARDCODED_RE.search(text):
        record_fail(f'{rel}: still contains hardcoded D:/openclaw-acp')
    else:
        record_pass(f'{rel}: no hardcoded D:/openclaw-acp')
    if "ACP_HOME" not in text:
        record_fail(f'{rel}: does not reference ACP_HOME')
    else:
        record_pass(f'{rel}: references ACP_HOME')


# --- 7. Plugin source files do not embed tokens or remote URLs ------------
print('\n[Check 7] Plugin source does not embed tokens or remote endpoints')
HARDCODED_TOKEN_RE = re.compile(r'(?i)\bbearer\s+[A-Za-z0-9._\-]{8,}')
REMOTE_URL_RE = re.compile(r'https?://(?!127\.0\.0\.1|localhost|::1)[^\s"\'<>]+')
# Only scan runtime code (.py). Documentation files (.md/.json) often link to
# the project home page and docs on github.com — those are not server endpoints.
SKIP_PATHS = {Path('scripts') / 'smoke.py'}  # smoke.py references URLs intentionally
scanned = 0
for f in PLUGIN_ROOT.rglob('*.py'):
    rel = f.relative_to(PLUGIN_ROOT)
    if rel in SKIP_PATHS:
        continue
    scanned += 1
    try:
        text = f.read_text(encoding='utf-8', errors='ignore')
    except Exception:
        continue
    if HARDCODED_TOKEN_RE.search(text):
        record_fail(f'{rel}: embeds a Bearer token literal')
    if REMOTE_URL_RE.search(text):
        record_fail(f'{rel}: references a non-loopback URL')
if scanned == 0:
    record_pass('no runtime code (.py) outside smoke.py to scan — check N/A')
else:
    record_pass(f'scanned {scanned} .py file(s); no embedded Bearer tokens or non-loopback URLs')


# --- Summary ---------------------------------------------------------------
print(f'\n=== Summary ===')
print(f'PASSED: {len(_passes)}')
print(f'FAILED: {len(_failures)}')
if _failures:
    print('\nFailures:')
    for f in _failures:
        print(f'  - {f}')
    sys.exit(1)
sys.exit(0)
