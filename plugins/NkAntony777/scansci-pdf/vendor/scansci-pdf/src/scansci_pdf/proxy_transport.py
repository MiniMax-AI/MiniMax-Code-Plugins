"""Explicitly trusted proxy endpoints; destinations always use pinned public IPs."""
from __future__ import annotations

import socket
import threading
from urllib.parse import urlsplit, unquote

from urllib3 import ProxyManager
from urllib3.connection import HTTPSConnection
from urllib3.connectionpool import HTTPSConnectionPool
from urllib3.contrib.socks import SOCKSHTTPSConnection, SOCKSProxyManager

from .security import SecurityError, public_address

_authorized = set()
_lock = threading.Lock()


def authorize_proxy(proxy: str) -> str:
    parts = urlsplit(proxy)
    if (parts.scheme not in {'http', 'https', 'socks5', 'socks5h'} or not parts.hostname
            or not parts.port or parts.path not in {'', '/'} or parts.query or parts.fragment):
        raise SecurityError('Expected an explicitly configured HTTP(S) or SOCKS5 proxy')
    with _lock:
        _authorized.add(proxy)
    return proxy


def require_authorized_proxy(proxy: str) -> None:
    with _lock:
        if proxy not in _authorized:
            raise SecurityError('Proxy endpoint must be explicitly configured by the workspace owner')


def resolve_public(host, port):
    answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not answers:
        raise SecurityError('DNS returned no addresses')
    for _, _, _, _, address in answers:
        public_address(address[0])
    return answers


class PinnedTunnelConnection(HTTPSConnection):
    def _tunnel(self):
        original = self._tunnel_host
        # CONNECT uses a numeric destination, while TLS retains the original SNI.
        self._tunnel_host = resolve_public(original, self._tunnel_port)[0][4][0]
        try:
            return super()._tunnel()
        finally:
            self._tunnel_host = original


class PinnedTunnelPool(HTTPSConnectionPool):
    ConnectionCls = PinnedTunnelConnection


class PinnedSOCKSConnection(SOCKSHTTPSConnection):
    def _new_conn(self):
        import socks
        options = self._socks_options
        error = None
        for _, _, _, _, address in resolve_public(self.host, self.port):
            try:
                return socks.create_connection(
                    (address[0], self.port), timeout=self.timeout,
                    proxy_type=options['socks_version'], proxy_addr=options['proxy_host'],
                    proxy_port=options['proxy_port'], proxy_username=options['username'],
                    proxy_password=options['password'], proxy_rdns=False,
                    socket_options=self.socket_options, source_address=self.source_address)
            except OSError as exc:
                error = exc
        raise error or SecurityError('No public destination could be reached')


class PinnedSOCKSPool(HTTPSConnectionPool):
    ConnectionCls = PinnedSOCKSConnection


def guarded_proxy_manager(proxy, **kwargs):
    require_authorized_proxy(proxy)
    if proxy.startswith('socks'):
        kwargs.pop('proxy_headers', None)
        manager = SOCKSProxyManager(proxy, **kwargs)
        manager.pool_classes_by_scheme = {'https': PinnedSOCKSPool}
    else:
        manager = ProxyManager(proxy, **kwargs)
        manager.pool_classes_by_scheme = {'https': PinnedTunnelPool}
    return manager


def connect_public(host, port, *, timeout=15, proxy=None):
    answers = resolve_public(host, port)
    error = None
    if proxy:
        require_authorized_proxy(proxy)
        parts = urlsplit(proxy)
        if parts.scheme.startswith('socks'):
            import socks
            for _, _, _, _, address in answers:
                try:
                    return socks.create_connection(
                        (address[0], port), timeout=timeout, proxy_type=socks.SOCKS5,
                        proxy_addr=parts.hostname, proxy_port=parts.port, proxy_rdns=False,
                        proxy_username=unquote(parts.username or '') or None,
                        proxy_password=unquote(parts.password or '') or None)
                except OSError as exc:
                    error = exc
        else:
            from http.client import HTTPConnection, HTTPSConnection as TLSProxyConnection
            import base64
            cls = TLSProxyConnection if parts.scheme == 'https' else HTTPConnection
            connection = cls(parts.hostname, parts.port, timeout=timeout)
            headers = {}
            if parts.username:
                token = f'{unquote(parts.username)}:{unquote(parts.password or "")}'.encode()
                headers['Proxy-Authorization'] = 'Basic ' + base64.b64encode(token).decode()
            connection.set_tunnel(answers[0][4][0], port, headers=headers)
            try:
                connection.connect()
                sock, connection.sock = connection.sock, None
                return sock
            except BaseException:
                connection.close()
                raise
    else:
        for family, kind, protocol, _, address in answers:
            connection = socket.socket(family, kind, protocol)
            try:
                connection.settimeout(timeout)
                connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                connection.connect(address)
                public_address(connection.getpeername()[0])
                return connection
            except BaseException as exc:
                connection.close()
                if not isinstance(exc, OSError):
                    raise
                error = exc
    raise error or SecurityError('No public destination could be reached')
