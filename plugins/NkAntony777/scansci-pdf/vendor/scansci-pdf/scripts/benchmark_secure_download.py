"""Controlled HTTPS throughput comparison against the v1.18.0 queue downloader.

The test fixture deliberately permits its own loopback HTTPS server ONLY within
this process. Production policy has no loopback exception. No real paper or
external publisher is contacted; this measures transport/write overhead only.
"""
import ast
from concurrent.futures import ThreadPoolExecutor
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import statistics
import socket
import argparse
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from unittest.mock import patch
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from scansci_pdf import pipeline, security, network

def certificate(root):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, '127.0.0.1')])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=1))
            .not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), False)
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), True)
            .sign(key, hashes.SHA256()))
    (root/'ca.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (root/'key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,
                                                serialization.PrivateFormat.PKCS8,
                                                serialization.NoEncryption()))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--connection-latency-ms', type=float, default=0)
    options = parser.parse_args()
    saved = Path(__file__).with_name('upstream_download_fixture.py')
    upstream = saved.read_text(encoding='utf-8') if saved.exists() else subprocess.check_output(['git', 'show', 'v1.18.0:src/scansci_pdf/pipeline.py']).decode('utf-8')
    function = next(node for node in ast.parse(upstream).body
                    if isinstance(node, ast.FunctionDef) and node.name == '_download_url')
    scope = {'Path': Path, '_safe_name': pipeline._safe_name}
    exec(compile(ast.Module(body=[function], type_ignores=[]), 'upstream-download', 'exec'), scope)
    original = scope['_download_url']
    data = b'%PDF-1.7\n' + b'x' * (512*1024) + b'\n%%EOF\n'
    counts = {'connections': 0}
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def log_message(self, *args): pass
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'application/pdf')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
    class Server(ThreadingHTTPServer):
        daemon_threads = True
        def get_request(self):
            result = super().get_request()
            result[0].setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            if options.connection_latency_ms:
                time.sleep(options.connection_latency_ms / 1000)
            counts['connections'] += 1
            return result
    with tempfile.TemporaryDirectory(prefix='scansci-bench-') as folder:
        root = Path(folder)
        certificate(root)
        server = Server(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(root/'ca.pem'), str(root/'key.pem'))
        server.socket = context.wrap_socket(server.socket, server_side=True)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        url = f'https://127.0.0.1:{server.server_port}/paper.pdf'
        make_session = security.public_session
        plain_session = requests.Session
        def fixture_session():
            session = make_session()
            session.verify = str(root/'ca.pem')
            return session
        def fixture_plain_session():
            session = plain_session()
            session.verify = str(root/'ca.pem')
            return session
        result = {'fixture': 'loopback TLS; valid CA; synthetic 512 KiB PDF; TCP_NODELAY',
                  'connection_latency_ms': options.connection_latency_ms,
                  'workers': 4, 'files_per_round': 40, 'rounds': 3}
        try:
            for label, download in [('upstream', original), ('secured_pooled', pipeline._download_url)]:
                if label == 'secured_pooled':
                    security.enforce_workspace_writes()
                times, sockets, successes = [], [], []
                for round_number in range(3):
                    out = root/f'{label}-{round_number}'
                    out.mkdir()
                    env = {'REQUESTS_CA_BUNDLE': str(root/'ca.pem'), 'NO_PROXY': '*'}
                    if label == 'secured_pooled':
                        env['SCANSCI_PDF_WORKSPACE'] = str(root)
                    before = counts['connections']
                    with patch.dict(os.environ, env), patch.object(security, 'public_address', side_effect=lambda value: value), \
                         patch.object(security, 'public_url', return_value='127.0.0.1'), \
                         patch.object(network, 'public_session', side_effect=fixture_session), \
                         patch.object(requests, 'Session', side_effect=fixture_plain_session), \
                         patch.object(pipeline, 'load_config', create=True, return_value={}), \
                         patch('scansci_pdf.config.load_config', return_value={}):
                        start = time.perf_counter()
                        with ThreadPoolExecutor(max_workers=4) as executor:
                            paths = list(executor.map(lambda n: download(url, out, f'10.1000/{n}', {}, None), range(40)))
                        times.append(round((time.perf_counter()-start)*1000, 3))
                    successes.append(sum(p is not None and p.read_bytes() == data for p in paths))
                    sockets.append(counts['connections']-before)
                result[label] = {'milliseconds': times, 'median_ms': statistics.median(times),
                                 'connections': sockets, 'valid_pdfs': successes}
                if successes != [40, 40, 40]:
                    raise RuntimeError(f'{label}: incomplete fixture downloads: {successes}')
            result['speedup'] = round(result['upstream']['median_ms']/result['secured_pooled']['median_ms'], 3)
            print(json.dumps(result, indent=2))
        finally:
            server.shutdown()
            server.server_close()

if __name__ == '__main__':
    main()
