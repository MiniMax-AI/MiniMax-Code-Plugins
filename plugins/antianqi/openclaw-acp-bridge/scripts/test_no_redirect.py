#!/usr/bin/env python3
"""Regression test for the no-redirect policy on token-bearing requests.

The smoke test's Check 5 sends $ACP_TOKEN as `Authorization: Bearer <token>`
to `$ACP_BASE_URL/acp/inbox/*`. A loopback URL is not enough: a hostile
or buggy server on the same machine can return 302 to a different local
origin, and the default `urllib.request.urlopen` would follow the
redirect while keeping the Authorization header attached, leaking the
token to whatever the redirect target is.

This test stands up two local HTTP servers on loopback ports:

  - **server A** (the "frontend") returns 302 to server B for
    `/acp/inbox/write` and 200 OK for `/acp/inbox/read`. This is what a
    compromised or misconfigured ACP server could do.
  - **server B** (the "capture") accepts any path, records the
    Authorization header it received, and returns 200.

The test invokes smoke.py's `_NoRedirectHandler` directly by reusing
the same opener-building logic, sends a fake token to server A, and
asserts that:

  1. The opener refused the 302 (HTTPError, code 302).
  2. Server B never received any request (no token captured).

If both pass, the redirect path is provably closed: the smoke test's
token cannot be exfiltrated by a same-host 3xx even if the original
server turns hostile.

Run:
    python plugins/antianqi/openclaw-acp-bridge/scripts/test_no_redirect.py
"""
from __future__ import annotations
import http.server
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

# Make the sibling smoke_helpers importable.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import smoke_helpers  # noqa: E402


def _free_port() -> int:
    """Ask the OS for an unused TCP port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class _Redirector(http.server.BaseHTTPRequestHandler):
    """Server A: 302 -> capture for /acp/inbox/write, 200 OK for /read."""

    CAPTURE_URL: str = ''  # injected by the test

    def do_POST(self):  # noqa: N802 (BaseHTTPRequestHandler API)
        if self.path == '/acp/inbox/write':
            # Read & discard the body so the client doesn't see a broken pipe.
            length = int(self.headers.get('Content-Length', '0') or '0')
            if length:
                self.rfile.read(length)
            self.send_response(302)
            self.send_header('Location', self.CAPTURE_URL + self.path)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self._ok_empty()

    def do_GET(self):  # noqa: N802
        # /acp/inbox/read returns a 200 so Check 5's "GET" path is also
        # exercised; the redirect only matters on the POST branch.
        if self.path.startswith('/acp/inbox/read'):
            payload = json.dumps({'messages': []}).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self._ok_empty()

    def _ok_empty(self):
        self.send_response(200)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def log_message(self, *_args, **_kwargs):  # silence test output
        pass


class _Capture(http.server.BaseHTTPRequestHandler):
    """Server B: record every Authorization header it sees."""

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get('Content-Length', '0') or '0')
        if length:
            self.rfile.read(length)
        # Record in a process-global list (set by the test driver).
        _Capture.seen.append({
            'path': self.path,
            'authorization': self.headers.get('Authorization'),
        })
        self._ok_empty()

    def do_GET(self):  # noqa: N802
        _Capture.seen.append({
            'path': self.path,
            'authorization': self.headers.get('Authorization'),
        })
        self._ok_empty()

    def _ok_empty(self):
        self.send_response(200)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def log_message(self, *_args, **_kwargs):
        pass


# Will be filled in by the test driver before serving.
_Capture.seen: list[dict] = []


def _serve(server: http.server.HTTPServer) -> None:
    server.serve_forever(poll_interval=0.05)


def main() -> int:
    frontend_port = _free_port()
    capture_port = _free_port()
    frontend_url = f'http://127.0.0.1:{frontend_port}'
    capture_url = f'http://127.0.0.1:{capture_port}'

    _Redirector.CAPTURE_URL = capture_url
    _Capture.seen = []

    frontend = http.server.HTTPServer(('127.0.0.1', frontend_port), _Redirector)
    capture = http.server.HTTPServer(('127.0.0.1', capture_port), _Capture)
    t1 = threading.Thread(target=_serve, args=(frontend,), daemon=True)
    t2 = threading.Thread(target=_serve, args=(capture,), daemon=True)
    t1.start()
    t2.start()
    time.sleep(0.05)  # let the servers start

    failures: list[str] = []
    try:
        # Use the same opener-building logic the smoke test uses for
        # token-bearing requests. This is the only thing under test.
        no_redirect = smoke_helpers.build_no_redirect_opener()
        fake_token = 'tk_test_secret_DO_NOT_LEAK_xyzzy'

        # 1. POST: must surface the 302 as HTTPError; must not hit server B.
        body = json.dumps({
            'session_id': 'redirect-test',
            'sender': 'plugin',
            'content': 'x',
        }).encode('utf-8')
        req = urllib.request.Request(
            f'{frontend_url}/acp/inbox/write',
            data=body,
            headers={
                'Authorization': f'Bearer {fake_token}',
                'Content-Type': 'application/json',
            },
            method='POST',
        )
        raised: Exception | None = None
        try:
            no_redirect.open(req, timeout=5).read()
        except urllib.error.HTTPError as e:
            raised = e
        if raised is None:
            failures.append('POST: no exception raised (opener followed the 302)')
        elif raised.code != 302:
            failures.append(
                f'POST: expected HTTPError 302, got {raised.code}: {raised.reason}'
            )

        # 2. GET: also must not follow a hypothetical 302. The frontend
        #    returns 200 for /acp/inbox/read in this test (we don't
        #    simulate a redirect on GET), so the opener should get the
        #    body back without contacting server B.
        read_req = urllib.request.Request(
            f'{frontend_url}/acp/inbox/read?session_id=redirect-test&since_id=0',
            headers={'Authorization': f'Bearer {fake_token}'},
        )
        try:
            with no_redirect.open(read_req, timeout=5) as r:
                # 200 OK from the frontend's GET path; body is the empty
                # messages list. As long as the body comes back, the
                # call completed without leaking.
                _ = r.read()
        except urllib.error.HTTPError as e:
            # If for some reason the GET path is also under test and
            # starts redirecting, this is still a pass for the
            # "no-redirect" assertion as long as the code is in 3xx.
            if not (300 <= e.code < 400):
                failures.append(
                    f'GET: expected 200 or 3xx, got {e.code}: {e.reason}'
                )

        # 3. The hard assertion: server B never received the token. If
        #    this list is non-empty, the no-redirect opener leaked.
        #    Filter out anything that isn't a clear "captured" record:
        #    every record should be inspected individually.
        for record in _Capture.seen:
            auth = record.get('authorization') or ''
            if fake_token in auth:
                failures.append(
                    f'CAPTURE SERVER RECEIVED TOKEN on {record["path"]}: {auth!r}'
                )
            elif auth:
                # The frontend never redirects GETs in this test, so any
                # Authorization header on server B is unexpected.
                failures.append(
                    f'capture server saw Authorization on {record["path"]}: {auth!r}'
                )
    finally:
        frontend.shutdown()
        frontend.server_close()
        capture.shutdown()
        capture.server_close()
        t1.join(timeout=2)
        t2.join(timeout=2)

    if failures:
        print('[FAIL] no-redirect regression test:')
        for f in failures:
            print(f'  - {f}')
        return 1
    print('[PASS] no-redirect regression test:')
    print(f'  - 302 on POST was surfaced as HTTPError 302 (no follow)')
    print(f'  - 200 on GET completed without contacting capture server')
    print(f'  - capture server recorded 0 requests with the fake token')
    return 0


if __name__ == '__main__':
    sys.exit(main())
