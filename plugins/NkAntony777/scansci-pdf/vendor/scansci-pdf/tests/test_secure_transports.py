from __future__ import annotations

import base64
import hashlib
import io
import socket
import tarfile
import threading
from pathlib import Path
from unittest.mock import patch

import pytest

from scansci_pdf import browser_guard, proxy_transport, security, embedded_tor


@pytest.mark.parametrize('name,kind', [('../escape', 'file'), ('/absolute', 'file'),
    ('C:/escape', 'file'), ('link', 'symlink'), ('device', 'device')])
def test_archive_attacks_rejected_before_extraction(tmp_path, name, kind):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        info = tarfile.TarInfo(name)
        if kind == 'symlink':
            info.type, info.linkname = tarfile.SYMTYPE, '../escape'
        elif kind == 'device':
            info.type = tarfile.CHRTYPE
        else:
            info.size = 1
        archive.addfile(info, io.BytesIO(b'x') if kind == 'file' else None)
    data = buffer.getvalue()
    with pytest.raises(security.SecurityError):
        security.extract_verified_tar(io.BytesIO(data), tmp_path/'stage', hashlib.sha256(data).hexdigest())
    assert not (tmp_path/'stage').exists()


def test_tor_hash_and_installed_binary_tampering(tmp_path, monkeypatch):
    buffer = io.BytesIO()
    binary_name = 'tor/tor.exe' if embedded_tor.platform.system() == 'Windows' else 'tor/tor'
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        info = tarfile.TarInfo(binary_name)
        info.size = 4
        archive.addfile(info, io.BytesIO(b'test'))
    data = buffer.getvalue()
    digest = hashlib.sha256(data).hexdigest()
    with pytest.raises(security.SecurityError):
        security.extract_verified_tar(io.BytesIO(data), tmp_path/'bad', '0'*64)
    stage = tmp_path/'good'
    security.extract_verified_tar(io.BytesIO(data), stage, digest)
    (stage/'.bundle.tar.gz').write_bytes(data)
    monkeypatch.setattr(embedded_tor, '_bundle_digest', lambda: digest)
    assert embedded_tor._verify_bundle(stage).read_bytes() == b'test'
    (stage/binary_name).write_bytes(b'evil')
    with pytest.raises(security.SecurityError):
        embedded_tor._verify_bundle(stage)


def test_tor_requires_explicit_install_confirmation(tmp_path, monkeypatch):
    monkeypatch.setenv('SCANSCI_PDF_WORKSPACE', str(tmp_path))
    with pytest.raises(security.SecurityError, match='Confirm'):
        embedded_tor.download_tor({'cache_dir': str(tmp_path/'cache')})


def test_proxy_destination_is_numeric_but_tls_host_unchanged(monkeypatch):
    public = '93.184.215.14'
    monkeypatch.setattr(proxy_transport, 'resolve_public', lambda *a: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (public, 443))])
    seen = []
    monkeypatch.setattr(proxy_transport.HTTPSConnection, '_tunnel', lambda self: seen.append(self._tunnel_host))
    connection = proxy_transport.PinnedTunnelConnection('proxy.example')
    connection.set_tunnel('publisher.example', 443)
    connection._tunnel()
    assert seen == [public]
    assert connection._tunnel_host == 'publisher.example'


def test_socks_remote_dns_flag_cannot_bypass_validation(monkeypatch):
    import socks
    monkeypatch.setattr(proxy_transport, 'resolve_public', lambda *a: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.215.14', 443))])
    seen = []
    monkeypatch.setattr(socks, 'create_connection', lambda address, **kw: seen.append((address, kw)))
    connection = proxy_transport.PinnedSOCKSConnection(host='publisher.example', _socks_options={
        'socks_version': socks.SOCKS5, 'proxy_host': '127.0.0.1', 'proxy_port': 1080,
        'username': None, 'password': None, 'rdns': True})
    connection._new_conn()
    assert seen[0][0] == ('93.184.215.14', 443)
    assert seen[0][1]['proxy_rdns'] is False
    assert connection.host == 'publisher.example'


def test_arbitrary_per_request_proxy_is_rejected():
    with pytest.raises(security.SecurityError, match='explicitly'):
        security.public_session().get('https://example.org', proxies={'https': 'http://127.0.0.1:7777'})


def test_browser_proxy_auth_and_private_destinations():
    service = browser_guard.GuardServer()
    thread = threading.Thread(target=service.serve_forever, daemon=True)
    thread.start()
    auth = base64.b64encode(f'scansci:{service.token}'.encode()).decode()
    try:
        for target, authorization, expected in [('example.org:443', '', b'407'),
                ('127.0.0.1:443', auth, b'403'), ('169.254.169.254:443', auth, b'403')]:
            with socket.create_connection(service.server_address, timeout=3) as connection:
                connection.sendall(f'CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Authorization: Basic {authorization}\r\n\r\n'.encode())
                assert expected in connection.recv(4096).split(b'\r\n')[0]
    finally:
        service.stop()
        thread.join(3)


def test_real_chromium_guard_blocks_redirect_and_local_bypass(tmp_path):
    playwright = pytest.importorskip('playwright.sync_api')
    chrome = Path('C:/Program Files/Google/Chrome/Application/chrome.exe')
    if not chrome.is_file():
        pytest.skip('local Chrome unavailable; run separately with installed Chromium')
    import ssl
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import importlib.util
    spec = importlib.util.spec_from_file_location('secure_benchmark_fixture', Path(__file__).parents[1]/'scripts'/'benchmark_secure_download.py')
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    certificate = fixture.certificate
    certificate(tmp_path)
    hits = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            hits.append(self.path)
            self.send_response(302 if self.path == '/redirect' else 200)
            if self.path == '/redirect':
                self.send_header('Location', 'https://169.254.169.254/latest/meta-data/')
            self.end_headers()
            self.wfile.write(b'<html><body>Publisher fixture</body></html>')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(tmp_path/'ca.pem'), str(tmp_path/'key.pem'))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    original = browser_guard.connect_public
    def fixture_connect(host, port, **kwargs):
        if host == 'fixture.example' and port == server.server_port:
            return socket.create_connection(server.server_address, timeout=3)
        return original(host, port, **kwargs)
    try:
        with patch.object(browser_guard, 'connect_public', fixture_connect), playwright.sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=str(chrome), headless=True,
                proxy=browser_guard.browser_proxy(), args=['--proxy-bypass-list=<-loopback>', '--disable-quic'])
            try:
                # The fixture CA bypass applies ONLY to this disposable test browser.
                page = browser.new_page(ignore_https_errors=True)
                page.goto(f'https://fixture.example:{server.server_port}/paper', timeout=15000)
                assert page.text_content('body') == 'Publisher fixture'
                page.screenshot(path=str(tmp_path/'guarded-browser.png'))
                for url in [f'https://fixture.example:{server.server_port}/redirect',
                            f'https://127.0.0.1:{server.server_port}/private',
                            f'http://127.0.0.1:{server.server_port}/plain']:
                    blocked = browser.new_page(ignore_https_errors=True)
                    try:
                        try:
                            result = blocked.goto(url, timeout=10000)
                        except playwright.Error:
                            pass
                        else:
                            assert result is not None and result.status == 403, url
                    finally:
                        blocked.close()
                assert '/paper' in hits and '/redirect' in hits
                assert '/private' not in hits and '/plain' not in hits
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(3)
