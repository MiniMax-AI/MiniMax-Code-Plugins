#!/usr/bin/env python3
"""stub_server.py — minimal stub of the OpenClaw-mcode-ACP HTTP server.

Implements just the endpoints the Plugin's `smoke.py` exercises:

  - GET  /acp/health          → {status: "ok", version: "stub", inbox: true}
  - POST /acp/inbox/write     → {message_id: <int>}
  - GET  /acp/inbox/read      → {messages: [...]}
  - GET  /acp/inbox/redirect  → 302 to /acp/inbox/read
                                (so the test can confirm the bundled
                                client refuses the redirect rather than
                                following it.)

This server is **only** intended for `scripts/smoke.py` driven from CI.
It does not implement task dispatch, history, stats, stream, ask,
answer, or sessions. Anything outside the four paths above returns 404.

It is intentionally NOT a public test fixture: it lives in `scripts/`
because the only thing that should ever import it is the bundled smoke
test driver. The full server contract is in the upstream
`antianqi/openclaw-mcode-acp` repository.

Usage:
    python scripts/stub_server.py [--port 19999] [--token ci-test-token]

Binds to 127.0.0.1 only (no remote connections).
"""
from __future__ import annotations

import argparse
import http.server
import json
import socketserver
import sys
import threading
import time
from typing import Any


class _StubHandler(http.server.BaseHTTPRequestHandler):
    """Implements the four endpoints the smoke test needs."""

    server_version = 'ACPStub/0.1'

    # Server-level state. Filled in by `serve()` before the server starts.
    state: dict[str, Any] = {}

    def _send_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _check_auth(self) -> bool:
        """Verify the Authorization header. The smoke test sets
        $ACP_TOKEN; the stub's expected token is in `state['token']`."""
        auth = self.headers.get('Authorization', '')
        expected = self.state.get('token', '')
        if not expected:
            return True  # auth disabled (no token configured)
        return auth == f'Bearer {expected}'

    def do_GET(self):  # noqa: N802 (BaseHTTPRequestHandler API)
        if self.path == '/acp/health':
            self._send_json(200, {
                'status': 'ok',
                'version': 'stub',
                'inbox': True,
            })
            return
        if self.path.startswith('/acp/inbox/read'):
            if not self._check_auth():
                self._send_json(401, {'error': 'unauthorized'})
                return
            # Return everything the smoke test wrote so far.
            self._send_json(200, {'messages': list(self.state['messages'])})
            return
        if self.path == '/acp/inbox/redirect':
            # A 302 the smoke test should refuse. Point at /acp/inbox/read
            # so a client that followed the redirect would still be talking
            # to us; the test asserts this code path is never taken.
            self.send_response(302)
            self.send_header('Location', '/acp/inbox/read?session_id=redirect&since_id=0')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self._send_json(404, {'error': 'not found', 'path': self.path})

    def do_POST(self):  # noqa: N802
        if not self._check_auth():
            self._send_json(401, {'error': 'unauthorized'})
            return
        if self.path == '/acp/inbox/write':
            length = int(self.headers.get('Content-Length', '0') or '0')
            raw = self.rfile.read(length) if length else b'{}'
            try:
                body = json.loads(raw.decode('utf-8'))
            except Exception:
                self._send_json(400, {'error': 'invalid json'})
                return
            with self.state['lock']:
                msg_id = self.state['next_id']
                self.state['next_id'] += 1
                self.state['messages'].append({
                    'id': msg_id,
                    'session_id': body.get('session_id'),
                    'sender': body.get('sender'),
                    'content': body.get('content'),
                    'msg_type': body.get('msg_type', 'progress'),
                })
            self._send_json(200, {'message_id': msg_id})
            return
        self._send_json(404, {'error': 'not found', 'path': self.path})

    def log_message(self, *_args, **_kwargs):  # silence access log
        pass


def serve(host: str = '127.0.0.1', port: int = 19999, token: str = '') -> http.server.HTTPServer:
    """Start the stub server in the current process. Returns the server.

    Callers are responsible for `.serve_forever()` and shutdown. The
    server shares state via `_StubHandler.state` so handlers see a
    consistent view. Uses `ThreadingHTTPServer` so the smoke test can
    issue sequential requests without the single-threaded
    `HTTPServer` blocking on a still-open keep-alive socket.
    """
    _StubHandler.state = {
        'token': token,
        'messages': [],
        'next_id': 1,
        'lock': threading.Lock(),
    }
    server = http.server.ThreadingHTTPServer((host, port), _StubHandler)
    return server


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--port', type=int, default=19999)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--token', default='')
    args = parser.parse_args()
    server = serve(host=args.host, port=args.port, token=args.token)
    print(f'[stub] listening on http://{args.host}:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
