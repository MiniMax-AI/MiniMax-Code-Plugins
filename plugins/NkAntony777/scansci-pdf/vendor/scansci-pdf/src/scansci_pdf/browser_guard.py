"""Authenticated CONNECT proxy enforcing public DNS/IP policy for browsers.

TLS stays end-to-end between the browser and the publisher. Each new tunnel
resolves at the connection boundary and connects to the validated numeric IP.
"""
from __future__ import annotations

import atexit
import base64
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import secrets
import select
import socket
import threading
import time

from .security import SecurityError, public_url
from .proxy_transport import connect_public

_services = {}
_lock = threading.Lock()


class GuardServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64

    def __init__(self, upstream=None):
        self.upstream = upstream
        self.token = secrets.token_urlsafe(32)
        self.active = set()
        self.active_lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(64)
        super().__init__(('127.0.0.1', 0), GuardHandler)

    def stop(self):
        self.shutdown()
        self.server_close()
        with self.active_lock:
            for sock in self.active:
                try: sock.shutdown(socket.SHUT_RDWR)
                except OSError: pass


class GuardHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    rbufsize = 0

    def setup(self):
        self.request.settimeout(15)
        super().setup()

    def log_message(self, *args):
        pass

    def do_CONNECT(self):
        wanted = 'Basic ' + base64.b64encode(f'scansci:{self.server.token}'.encode()).decode()
        if not hmac.compare_digest(self.headers.get('Proxy-Authorization', ''), wanted):
            self.send_response(407)
            self.send_header('Proxy-Authenticate', 'Basic realm="ScanSci"')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if not self.server.slots.acquire(blocking=False):
            self.send_error(503, 'Browser connection limit reached')
            return
        remote = None
        try:
            host = public_url('https://' + self.path + '/')
            from urllib.parse import urlsplit
            port = urlsplit('https://' + self.path).port or 443
            remote = connect_public(host, port, proxy=self.server.upstream)
            self.send_response(200, 'Connection Established')
            self.end_headers()
            self.wfile.flush()
            peers = [self.connection, remote]
            with self.server.active_lock:
                self.server.active.update(peers)
            self.close_connection = True
            # sendall bounds writes and select bounds inactivity; preserve TLS bytes.
            idle_until = time.monotonic() + 120
            while time.monotonic() < idle_until:
                readable, _, _ = select.select(peers, [], [], 1)
                for source in readable:
                    chunk = source.recv(65536)
                    if not chunk:
                        return
                    destination = remote if source is self.connection else self.connection
                    destination.sendall(chunk)
                    idle_until = time.monotonic() + 120
        except (SecurityError, OSError, ValueError):
            if remote is None:
                self.send_error(403, 'Public HTTPS destination required')
        finally:
            with self.server.active_lock:
                self.server.active.discard(self.connection)
                self.server.active.discard(remote)
            if remote:
                remote.close()
            self.server.slots.release()

    def do_GET(self):
        self.send_error(403, 'Public HTTPS CONNECT required')


def browser_proxy(upstream=None) -> dict:
    with _lock:
        if upstream not in _services:
            service = GuardServer(upstream)
            _services[upstream] = service
            threading.Thread(target=service.serve_forever, daemon=True).start()
            atexit.register(service.stop)
        service = _services[upstream]
        return {'server': f'http://127.0.0.1:{service.server_port}',
                'username': 'scansci', 'password': service.token}
