#!/usr/bin/env python3
"""smoke.py — PR-reproducible smoke test for the openclaw-acp-bridge Plugin.

Validates that this Plugin can talk to an OpenClaw-mcode-ACP server.
Does NOT require MiniMax Code or mcode itself. Runs in <10s.

v0.2.0 change: the smoke test now exercises the **bundled** client
(`client/_acp_client.py`) instead of an external SDK. The "no-redirect
policy is real because the test shares an opener with the Skills"
property the v0.1.3 review called for is now structural: there is only
one client module, and the smoke test imports it the same way the
Skills do.

Checks:
  1. `client/_acp_client.py` parses and imports cleanly.
  2. `_resolve_token()` raises `ACPTokenMissing` when no token is set.
  3. `_check_loopback()` accepts the loopback allow-list and refuses
     everything else (including `https://127.0.0.1:9999`).
  4. The server's `/acp/health` returns HTTP 200 within 5 seconds
     (no auth required; the bundled client is not used for this — the
     health endpoint is anonymous).
  5. An inbox write/read roundtrip works through the **bundled** client.
     This is the path Skills take at runtime; the smoke test is now
     exercising the same code.
  6. The bundled no-redirect opener is in fact the opener the Skills
     will use at runtime. (Verified by reading `_acp_client._OPENER`'s
     handler chain; there is no separate "smoke test opener" anymore.)
  7. Plugin SKILL.md files resolve the plugin root through
     `ACP_PLUGIN_ROOT` (or a `__file__` fallback). No hardcoded
     `D:/openclaw-acp` or similar absolute paths.

Usage:
    # Against a real server:
    export ACP_TOKEN=<server token>
    python plugins/antianqi/openclaw-acp-bridge/scripts/smoke.py

    # Against the bundled CI stub (recommended for offline runs):
    python plugins/antianqi/openclaw-acp-bridge/scripts/stub_server.py &
    ACP_TOKEN=ci-test-token-xyzzy ACP_BASE_URL=http://127.0.0.1:19999 \
        python plugins/antianqi/openclaw-acp-bridge/scripts/smoke.py

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

# Make the bundled client importable. The script lives in `<plugin>/scripts/`
# so the client is one directory up and over.
HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parent
CLIENT_DIR = PLUGIN_ROOT / 'client'
sys.path.insert(0, str(CLIENT_DIR))

import _acp_client  # noqa: E402

_failures: list[str] = []
_passes: list[str] = []


def record_pass(msg: str) -> None:
    _passes.append(msg)
    print(f'  [PASS] {msg}')


def record_fail(msg: str) -> None:
    _failures.append(msg)
    print(f'  [FAIL] {msg}')


def check(cond: bool, msg: str) -> None:
    (record_pass if cond else record_fail)(msg)


def main() -> int:
    base_url = os.environ.get('ACP_BASE_URL', 'http://127.0.0.1:9999').rstrip('/')
    token = os.environ.get('ACP_TOKEN', '').strip()

    # --- 1. Client parses and imports -----------------------------------
    print('\n[Check 1] Bundled client imports cleanly')
    try:
        # Re-import (already done at module top) and verify the public API
        # surface matches what the Skills depend on. Adding a function to
        # the client without updating this list is a contract break.
        expected = {
            'health', 'create_task', 'get_task', 'wait_task', 'cancel_task',
            'history', 'list_tasks', 'stream_task', 'run_and_stream', 'stats',
            'inbox_write', 'inbox_read', 'inbox_ask', 'inbox_answer',
            'inbox_sessions', 'peer_session_id', 'peer_greet',
            'ACPError', 'ACPTokenMissing',
        }
        missing = expected - set(dir(_acp_client))
        if missing:
            record_fail(f'bundled client missing public names: {sorted(missing)}')
        else:
            record_pass(f'bundled client exposes all {len(expected)} expected names')
    except Exception as e:
        record_fail(f'import or attribute lookup failed: {e}')

    # --- 2. Token resolution --------------------------------------------
    print('\n[Check 2] Token resolver raises ACPTokenMissing when unset')
    saved_token = os.environ.pop('ACP_TOKEN', None)
    try:
        try:
            _acp_client._resolve_token()
            record_fail('_resolve_token did not raise with no token source')
        except _acp_client.ACPTokenMissing:
            record_pass('_resolve_token raises ACPTokenMissing with no token source')
        except Exception as e:
            record_fail(f'_resolve_token raised the wrong type: {type(e).__name__}: {e}')
    finally:
        if saved_token is not None:
            os.environ['ACP_TOKEN'] = saved_token

    # --- 3. Loopback guard ----------------------------------------------
    print('\n[Check 3] Loopback guard accepts loopback and refuses other origins')
    for url, want in [
        ('http://127.0.0.1:9999', True),
        ('http://127.0.0.1:9999/', True),  # trailing slash is still loopback
        ('http://localhost:9999', True),
        ('http://[::1]:9999', True),
        ('http://example.com', False),
        ('http://0.0.0.0:9999', False),
        ('https://127.0.0.1:9999', False),  # https is not allowed (server is http-only)
    ]:
        try:
            _acp_client._check_loopback(url)
            got = True
        except _acp_client.ACPError:
            got = False
        check(got == want, f'_check_loopback({url!r}) allow={got} (want {want})')

    # --- 4. Server /acp/health (no auth) --------------------------------
    print('\n[Check 4] Server /acp/health (no auth required)')
    try:
        with urllib.request.urlopen(f'{base_url}/acp/health', timeout=5) as r:
            check(r.status == 200, 'GET /acp/health → 200')
            body = json.loads(r.read().decode('utf-8'))
            check(body.get('status') == 'ok',
                  f'health body has status=ok (version={body.get("version")})')
            check('inbox' in body,
                  'health body advertises inbox (requires v7-bidir+)')
    except urllib.error.URLError as e:
        record_fail(f'server not reachable at {base_url}/acp/health: {e.reason}')
    except Exception as e:
        record_fail(f'/acp/health failed: {e}')

    # --- 5. Inbox roundtrip via the bundled client ----------------------
    print('\n[Check 5] Inbox write/read roundtrip via bundled client')
    if not token:
        record_fail(
            'ACP_TOKEN not set; cannot exercise the bundled client. '
            'Set $ACP_TOKEN (or run the bundled stub_server.py and pass '
            'ACP_TOKEN=ci-test-token-xyzzy).'
        )
    else:
        # The Skills call _acp_client directly; the smoke test does too.
        # This is the property the v0.1.3 review asked for: the smoke
        # test exercises the same code the Skills run.
        try:
            session = f'plugin-smoke-{os.getpid()}'
            msg_id = _acp_client.inbox_write(
                session, 'smoke test from openclaw-acp-bridge', sender='plugin',
            )
            check(isinstance(msg_id, int) and msg_id > 0,
                  f'inbox_write returned message_id={msg_id}')
            msgs = _acp_client.inbox_read(session)
            check(isinstance(msgs, list) and len(msgs) >= 1,
                  f'inbox_read returned {len(msgs)} message(s)')
            check(msgs and msgs[-1].get('sender') == 'plugin',
                  'latest message has sender=plugin')
        except _acp_client.ACPError as e:
            # A 3xx surfaced here would be a regression: the bundled
            # client is supposed to refuse redirects outright.
            if 300 <= e.status < 400:
                record_fail(
                    f'redirect ({e.status}) on token-bearing request: '
                    f'{e.body.get("Location", "?") if isinstance(e.body, dict) else "?"} '
                    '- bundled client did not apply no-redirect policy'
                )
            else:
                record_fail(f'inbox roundtrip failed: {e}')
        except Exception as e:
            record_fail(f'inbox roundtrip failed: {type(e).__name__}: {e}')

    # --- 6. Bundled opener is the runtime opener ------------------------
    print('\n[Check 6] Bundled opener is the no-redirect opener')
    op = _acp_client._OPENER
    import urllib.request as _ur
    has_default = any(
        isinstance(h, _ur.HTTPRedirectHandler) and not isinstance(h, _acp_client._NoRedirectHandler)
        for h in op.handlers
    )
    has_default |= any(
        isinstance(h, _ur.HTTPRedirectHandler) and not isinstance(h, _acp_client._NoRedirectHandler)
        for by_code in op.handle_error.values()
        for lst in by_code.values()
        for h in lst
    )
    has_ours = any(isinstance(h, _acp_client._NoRedirectHandler) for h in op.handlers)
    check(not has_default, '_OPENER has no default HTTPRedirectHandler')
    check(has_ours, '_OPENER registers _NoRedirectHandler')

    # --- 7. SKILL.md path resolution ------------------------------------
    print('\n[Check 7] Plugin SKILL.md files resolve plugin root safely')
    hardcoded_re = re.compile(
        r'(?i)D:[/\\]openclaw-acp|/Users/[^/\s"]+/openclaw-acp|/home/[^/\s"]+/openclaw-acp'
    )
    for skill_md in PLUGIN_ROOT.glob('skills/*/SKILL.md'):
        text = skill_md.read_text(encoding='utf-8')
        rel = skill_md.relative_to(PLUGIN_ROOT)
        if hardcoded_re.search(text):
            record_fail(f'{rel}: still contains a hardcoded absolute path')
        else:
            record_pass(f'{rel}: no hardcoded absolute path')
        if 'ACP_PLUGIN_ROOT' not in text and '__file__' not in text:
            record_fail(f'{rel}: does not reference ACP_PLUGIN_ROOT or __file__ fallback')
        else:
            record_pass(f'{rel}: references ACP_PLUGIN_ROOT or __file__ fallback')

    # --- Summary ---------------------------------------------------------
    print(f'\n=== Summary ===')
    print(f'PASSED: {len(_passes)}')
    print(f'FAILED: {len(_failures)}')
    if _failures:
        print('\nFailures:')
        for f in _failures:
            print(f'  - {f}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
