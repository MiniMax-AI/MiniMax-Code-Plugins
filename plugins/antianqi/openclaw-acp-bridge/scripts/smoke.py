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
        ('http://[::1]:9999', True),
        # Round-5 amendment: 'localhost' is now refused. The literal-IP
        # allow-list means we never rely on the platform resolver to
        # confirm the host is loopback; a misconfigured /etc/hosts or
        # DNS that returns a non-loopback address for 'localhost' would
        # otherwise send the bearer token to that non-loopback address.
        ('http://localhost:9999', False),
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

    # --- 4. Server /acp/health via the bundled client --------------------
    # v0.2.1 change: the health check now goes through
    # `_acp_client.health()` (the same path the Skills take) instead of
    # a raw `urllib.request.urlopen`. The round-4 review pointed out
    # that the previous implementation bypassed `_OPENER` (no-redirect
    # policy) and `_check_loopback` (loopback guard); the smoke test
    # therefore had to exercise the bundled client, not a parallel
    # raw-urllib path. The health endpoint is anonymous, so the bundled
    # client sends no Authorization header; loopback + no-redirect
    # still apply.
    print('\n[Check 4] Server /acp/health via bundled client (loopback + no-redirect apply)')
    try:
        body = _acp_client.health(base_url=base_url)
        check(isinstance(body, dict), f'health returned a dict: {body!r}')
        check(body.get('status') == 'ok',
              f'health body has status=ok (version={body.get("version")})')
        check('inbox' in body,
              'health body advertises inbox (requires v7-bidir+)')
    except _acp_client.ACPError as e:
        # A 3xx here would be a regression: the bundled client is
        # supposed to refuse redirects outright, and the no-redirect
        # contract now applies to /acp/health too.
        if 300 <= e.status < 400:
            record_fail(
                f'redirect ({e.status}) on health: bundled client did not apply '
                'no-redirect policy to /acp/health'
            )
        else:
            record_fail(f'/acp/health via bundled client failed: {e}')
    except urllib.error.URLError as e:
        record_fail(f'server not reachable at {base_url}/acp/health: {e.reason}')
    except Exception as e:
        record_fail(f'/acp/health failed: {type(e).__name__}: {e}')

    # --- 4b. Bundled health() refuses non-loopback base URLs ------------
    # Negative test for the round-4 fix: before the fix, health() used
    # `urllib.request.urlopen` directly and never consulted
    # `_check_loopback`. A misconfigured `ACP_BASE_URL` (e.g. an
    # attacker-controlled host) would have leaked a probe. The fix
    # routes health() through `_request`, so the loopback guard now
    # raises `ACPError` before any network call.
    #
    # Round-trip: revert `health()` to a raw `urllib.request.urlopen`
    # call, and this check fails — `_acp_client.health('http://1.2.3.4')
    # would attempt a real network call instead of refusing.
    print('\n[Check 4b] Bundled health() refuses non-loopback base URLs')
    try:
        _acp_client.health(base_url='http://1.2.3.4:9999')
        record_fail(
            'health("http://1.2.3.4:9999") did not raise; loopback guard bypassed'
        )
    except _acp_client.ACPError as e:
        # The loopback guard raises ACPError with status 0; that is
        # the expected outcome. Any other exception type means the
        # guard is NOT in the path.
        check(e.status == 0,
              f'health("http://1.2.3.4:9999") raised ACPError status=0 '
              f'(loopback refused), got status={e.status}: {e}')
    except Exception as e:
        record_fail(
            f'health("http://1.2.3.4:9999") raised the wrong type '
            f'({type(e).__name__}); loopback guard is not on the health() path'
        )

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

    # --- 8. Server rejects requests without Authorization ---------------
    # Round-4 finding: the smoke workflow started stub_server.py
    # without --token, so state['token'] was '' and `_check_auth`
    # returned True for every request (auth disabled). The smoke
    # roundtrip therefore never proved the server rejects a missing
    # Authorization header. The fix in v0.2.1 is two-fold:
    #   1. The CI workflow now starts the stub with --token set, so
    #      the server is in the "auth required" state.
    #   2. This check sends a raw POST to /acp/inbox/write WITHOUT
    #      an Authorization header and asserts the server returns
    #      401. The bundled client always adds the header for
    #      token-bearing requests, so this check uses raw
    #      urllib (the same way an attacker would probe).
    #
    # Round-trip: with --token unset, _check_auth returns True and
    # the server returns 200, so this check fails.
    print('\n[Check 8] Server rejects requests without Authorization (negative test)')
    if not token:
        record_fail(
            'ACP_TOKEN not set; cannot derive expected token for negative tests. '
            'Run the smoke workflow with $ACP_TOKEN set (the CI workflow does this).'
        )
    else:
        try:
            req = urllib.request.Request(
                f'{base_url}/acp/inbox/write',
                data=json.dumps({
                    'session_id': 'no-auth-test',
                    'sender': 'plugin',
                    'content': 'no auth header attached',
                }).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            with urllib.request.urlopen(req, timeout=5) as r:
                record_fail(
                    f'server accepted request without Authorization: status={r.status}; '
                    'auth is disabled on the server (--token was not set?)'
                )
        except urllib.error.HTTPError as e:
            check(e.code == 401,
                  f'server rejected missing Authorization with 401 (got {e.code})')
        except Exception as e:
            record_fail(
                f'no-auth request failed unexpectedly: {type(e).__name__}: {e}'
            )

    # --- 9. Server rejects requests with wrong Authorization -----------
    # Same negative-test discipline as Check 8, but with a wrong
    # token attached. The server should still return 401 because
    # `_check_auth` does a constant-string compare.
    print('\n[Check 9] Server rejects requests with wrong Authorization (negative test)')
    if not token:
        record_fail(
            'ACP_TOKEN not set; cannot run wrong-token test'
        )
    else:
        try:
            req = urllib.request.Request(
                f'{base_url}/acp/inbox/write',
                data=json.dumps({
                    'session_id': 'wrong-auth-test',
                    'sender': 'plugin',
                    'content': 'wrong token attached',
                }).encode('utf-8'),
                headers={
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer this-is-the-wrong-token',
                },
                method='POST',
            )
            with urllib.request.urlopen(req, timeout=5) as r:
                record_fail(
                    f'server accepted wrong Authorization: status={r.status}'
                )
        except urllib.error.HTTPError as e:
            check(e.code == 401,
                  f'server rejected wrong Authorization with 401 (got {e.code})')
        except Exception as e:
            record_fail(
                f'wrong-auth request failed unexpectedly: {type(e).__name__}: {e}'
            )

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
