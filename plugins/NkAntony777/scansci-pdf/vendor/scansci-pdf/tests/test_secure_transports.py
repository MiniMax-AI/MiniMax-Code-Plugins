from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import os
import py_compile
import re
import socket
import subprocess
import tarfile
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from scansci_pdf import browser_guard, proxy_transport, security, embedded_tor

# Loaded by path: the engine's own `tests` package is not importable by name
# from every working directory the suite is started in.
_spec = importlib.util.spec_from_file_location(
    "_secure_stage", Path(__file__).resolve().with_name("_secure_stage.py"))
_secure_stage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_secure_stage)


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
    # SCANSCI_AUDIT_BROWSER is how CI points at its installed browser; the
    # Windows default keeps the pre-CI behaviour on developer machines.
    chrome = Path(os.environ.get('SCANSCI_AUDIT_BROWSER')
                  or 'C:/Program Files/Google/Chrome/Application/chrome.exe')
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


# ---------------------------------------------------------------------------
# Source-only launcher: both `--module` entries must reach a real entry point.
#
# These run the launcher as a REAL subprocess from an isolated workspace OUTSIDE
# the plugin package, because that is the only way the cwd gate, the manifest
# gate and the dependency gate are all genuinely exercised.
# ---------------------------------------------------------------------------

HEADLESS_HARNESS = """\
\"\"\"Headless harness: keep tkinter importable, forbid opening a window.\"\"\"
import os

import tkinter


class _NoWindow(RuntimeError):
    pass


def _refuse(*_args, **_kwargs):
    raise _NoWindow("windowed progress bar disabled by the test harness")


tkinter.Tk = _refuse
os.environ["SCANSCI_PROGRESS_BAR_HARNESS"] = "1"
"""


@pytest.fixture(scope="session")
def staged_package(tmp_path_factory):
    """A staged engine laid out as <pkg>/vendor/scansci-pdf.

    The `vendor` layout matters: it is what makes the launcher resolve a
    package root above the engine, which the cwd gate then enforces.
    """
    package = tmp_path_factory.mktemp("staged_package")
    engine = package / "vendor" / "scansci-pdf"
    engine.parent.mkdir(parents=True, exist_ok=True)
    return _secure_stage.stage_engine(engine)


@pytest.fixture(scope="session")
def launcher(staged_package, tmp_path_factory):
    """Runs run_secure.py in an isolated workspace outside the plugin package."""
    workspace = tmp_path_factory.mktemp("isolated_workspace")

    def _run(*args, cwd=None, env=None, timeout=300):
        environment = dict(os.environ)
        environment.pop("SCANSCI_PDF_SECURE_ENTRY", None)
        environment.pop("SCANSCI_PDF_WORKSPACE", None)
        environment.pop("PYTHONPATH", None)
        if env:
            environment.update(env)
        return subprocess.run(
            [_secure_stage.python_executable(), "-I", str(staged_package / "run_secure.py"), *args],
            cwd=str(cwd or workspace), capture_output=True, text=True,
            # The child writes box-drawing characters for Typer help; never let
            # the console code page turn that into a decode error.
            encoding="utf-8", errors="replace",
            timeout=timeout, env=environment,
        )

    return _run


_ANSI_CSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def _plain(text: str) -> str:
    """Assertion view of console output: no ANSI styling, no line wrapping.

    CI runners render the Typer help at 80 columns, so any expectation about
    a command's help text must be checked against the wrapped-and-styled
    output normalized back to one space-separated line, not the raw bytes.
    """
    return " ".join(_ANSI_CSI.sub("", text).split())


def test_launcher_verify_passes_from_an_isolated_workspace(launcher):
    result = launcher("--verify")
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report["source_manifest"] == "verified"
    assert report["dependency_lock"] == "verified"


def test_cli_module_entry_runs_the_real_command_surface(launcher):
    """"scansci_pdf.cli" is a PACKAGE: without cli/__main__.py runpy aborts with
    "No module named scansci_pdf.cli.__main__"."""
    result = launcher("--module", "scansci_pdf.cli", "--help")
    assert result.returncode == 0, result.stdout + result.stderr
    plain = _plain(result.stdout)
    assert "Usage: python -m scansci_pdf.cli" in plain
    assert "session-broker-status" in plain
    assert "No module named" not in result.stderr


def test_cli_module_entry_reaches_the_real_broker_command(launcher):
    """The allowlisted module must expose the target the broker actually spawns."""
    result = launcher("--module", "scansci_pdf.cli", "session-broker-run", "--help")
    assert result.returncode == 0, result.stdout + result.stderr
    plain = _plain(result.stdout)
    assert "Run the long-lived broker loop" in plain
    assert "--publisher" in plain
    assert "Traceback" not in result.stderr


def test_progress_bar_module_entry_runs_a_real_entry_point(staged_package, tmp_path_factory):
    """The bar is a GUI with an infinite console fallback, so it is driven by a
    harness that forbids a window, observed for a bounded time, then killed."""
    harness = tmp_path_factory.mktemp("headless_harness")
    (harness / "sitecustomize.py").write_text(HEADLESS_HARNESS, encoding="utf-8")
    # The cwd gate is legitimate: launch from outside the package, as in use.
    workspace = tmp_path_factory.mktemp("bar_workspace")

    command = [_secure_stage.python_executable(), "-I", "-u",
               str(staged_package / "run_secure.py"),
               "--module", "scansci_pdf.progress_bar"]
    environment = dict(os.environ)
    environment.pop("PYTHONPATH", None)
    environment.pop("SCANSCI_PDF_SECURE_ENTRY", None)
    environment.pop("SCANSCI_PDF_WORKSPACE", None)
    environment["PYTHONPATH"] = str(harness)
    environment["PYTHONUNBUFFERED"] = "1"
    environment["SCANSCI_PROGRESS_BAR"] = "0"

    process = subprocess.Popen(
        command, cwd=str(workspace), env=environment,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding="utf-8", errors="replace",
    )
    # A blocking readline would hang the suite if the child never speaks, so the
    # stream is drained on a thread and the wait is bounded by a deadline.
    lines: list[str] = []
    reader = threading.Thread(
        target=lambda: [lines.append(line) for line in process.stdout], daemon=True)
    reader.start()
    try:
        deadline = time.time() + 15
        while time.time() < deadline and not any(
                "progress bar disabled" in line for line in lines):
            if process.poll() is not None and reader.is_alive() is False:
                break
            time.sleep(0.2)
        blob = "".join(lines)
        assert "progress bar disabled" in blob, (
            "the module entry never reached progress_bar.main()\n" + blob)
        # No ImportError/AttributeError from the loader itself.
        assert "AttributeError" not in blob and "ImportError" not in blob
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=30)
        process.stdout.close()
    assert process.returncode is not None, "the child must be reaped, never leaked"


def test_progress_bar_spawn_uses_the_verified_source_entry(monkeypatch):
    """Automatic startup must not keep the unguarded `python -m` path."""
    from scansci_pdf import progress_reporter

    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(Path.cwd()))
    monkeypatch.setenv("SCANSCI_PDF_SECURE_ENTRY", str(_secure_stage.ENGINE / "run_secure.py"))

    command = progress_reporter.progress_bar_command()

    # [python, <run_secure.py>, --module, scansci_pdf.progress_bar]
    assert command[3:] == ["--module", "scansci_pdf.progress_bar"]
    assert command[0] == _secure_stage.python_executable()
    assert command[1] == "-I"
    assert command[2] == str(_secure_stage.ENGINE / "run_secure.py")

    # Outside the secure launcher there is no verified entry to use.
    monkeypatch.delenv("SCANSCI_PDF_WORKSPACE")
    assert progress_reporter.progress_bar_command()[1:] == ["-m", "scansci_pdf.progress_bar"]


@pytest.mark.parametrize("module", ["os", "scansci_pdf.config", "scansci_pdf.main",
                                    "scansci_pdf.cli.main_commands", ""])
def test_unknown_modules_are_refused(launcher, module):
    result = launcher("--module", module)
    assert result.returncode != 0
    assert "Unknown engine child module" in result.stdout + result.stderr


def test_tampered_source_is_refused(launcher, staged_package):
    target = staged_package / "src" / "scansci_pdf" / "cli" / "__main__.py"
    original = target.read_bytes()
    try:
        target.write_bytes(original + b"\n# tampered\n")
        result = launcher("--module", "scansci_pdf.cli", "--help")
        assert result.returncode != 0
        assert "Pinned engine source changed" in result.stdout + result.stderr
    finally:
        target.write_bytes(original)


@pytest.mark.parametrize("layout", ["cache", "adjacent"])
def test_valid_legacy_pyc_is_ignored(launcher, staged_package, tmp_path, layout):
    """Valid old bytecode beside a pinned module must never be executed.

    The loader resolves pinned modules to their .py, so the bytecode cache is
    not merely untrusted, it is unreachable.
    """
    source = staged_package / "src" / "scansci_pdf" / "cli" / "__main__.py"
    pyc = (Path(importlib.util.cache_from_source(str(source))) if layout == "cache"
           else source.with_suffix(".pyc"))
    pyc.parent.mkdir(parents=True, exist_ok=True)
    marker = "SYNTHETIC-PYC-MARKER"
    canary = tmp_path / "legacy_source.py"
    canary.write_text(f"print({marker!r})\n", encoding="ascii")
    # Unchecked-hash caches are valid even when the pinned source has changed.
    py_compile.compile(str(canary), cfile=str(pyc), doraise=True,
                       invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
    try:
        result = launcher("--module", "scansci_pdf.cli", "--help")
        assert result.returncode == 0, result.stdout + result.stderr
        assert marker not in result.stdout + result.stderr
        # The verified .py ran, not the cache.
        assert "Usage: python -m scansci_pdf.cli" in _plain(result.stdout)
    finally:
        pyc.unlink()
        if layout == "cache" and not any(pyc.parent.iterdir()):
            pyc.parent.rmdir()


def test_bad_dependency_pin_is_refused(launcher, staged_package):
    """The dependency gate stays enforced.

    The lock is re-hashed into the staged manifest first, so this cannot pass by
    tripping the (also working) manifest gate instead.
    """
    lock = staged_package / "requirements.lock"
    manifest_path = staged_package / "SOURCE-HASHES.json"
    original = lock.read_text(encoding="utf-8")
    original_manifest = manifest_path.read_text(encoding="utf-8")
    try:
        lock.write_text(original.replace("pycparser==", "pycparser==3.10", 1),
                        encoding="utf-8")
        manifest = json.loads(original_manifest)
        manifest["files"]["requirements.lock"] = _secure_stage.digest(lock)
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        result = launcher("--verify")
        assert result.returncode != 0
        combined = result.stdout + result.stderr
        assert "Dependency version mismatch" in combined
        assert "Pinned engine source changed" not in combined
    finally:
        lock.write_text(original, encoding="utf-8")
        manifest_path.write_text(original_manifest, encoding="utf-8")


def test_launch_from_inside_the_package_is_refused(staged_package):
    """A legitimate cwd check, not a module defect: the same command that works
    outside the package is refused inside it."""
    package = staged_package.parent.parent
    environment = dict(os.environ)
    environment.pop("SCANSCI_PDF_SECURE_ENTRY", None)
    environment.pop("SCANSCI_PDF_WORKSPACE", None)
    result = subprocess.run(
        [_secure_stage.python_executable(), "-I", str(staged_package / "run_secure.py"), "--verify"],
        cwd=str(package), capture_output=True, text=True, timeout=300, env=environment,
    )
    assert result.returncode != 0
    assert "Launch from the project workspace, outside the plugin package" in (
        result.stdout + result.stderr)


def test_stdio_handshake_still_passes(staged_package, tmp_path_factory):
    """The MCP stdio entry still completes initialize + tools/list.

    Exercised against the staged engine, so the loader change is covered too;
    EOF must still shut the server down (see tests/test_mcp_lifecycle.py).
    """
    workspace = tmp_path_factory.mktemp("stdio_workspace")
    environment = dict(os.environ)
    for name in ("SCANSCI_PDF_SECURE_ENTRY", "SCANSCI_PDF_WORKSPACE", "PYTHONPATH"):
        environment.pop(name, None)
    environment["SCANSCI_PROGRESS_BAR"] = "0"

    process = subprocess.Popen(
        [_secure_stage.python_executable(), "-I", str(staged_package / "run_secure.py"), "run"],
        cwd=str(workspace), env=environment,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        payload = "\n".join([
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                        "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                                   "clientInfo": {"name": "secure-launcher-test", "version": "0"}}}),
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
        ]) + "\n"
        # A real client waits for responses before closing stdin: closing it
        # right after the write races the server's EOF shutdown against the
        # tools/list answer on fast hosts. EOF-exit is covered separately by
        # tests/test_mcp_lifecycle.py. Both pipes are drained by threads and
        # the process is awaited with wait(): on POSIX, communicate() flushes
        # self.stdin unconditionally, which raises "flush of closed file"
        # once stdin has been closed here.
        process.stdin.write(payload.encode("utf-8"))
        process.stdin.flush()
        collected: list[bytes] = []

        def _drain(stream, sink: list) -> None:
            for line in iter(stream.readline, b""):
                sink.append(line)

        out_thread = threading.Thread(target=_drain, args=(process.stdout, collected), daemon=True)
        err_lines: list[bytes] = []
        err_thread = threading.Thread(target=_drain, args=(process.stderr, err_lines), daemon=True)
        out_thread.start()
        err_thread.start()
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            if any(b'"id":2,' in line or b'"id": 2,' in line for line in collected):
                break
            if process.poll() is not None:
                break
            time.sleep(0.05)
        process.stdin.close()
        process.wait(timeout=120)
        out_thread.join(5)
        err_thread.join(5)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=30)

    text = b"".join(collected).decode("utf-8", "replace")
    messages = [json.loads(line) for line in text.splitlines() if line.strip().startswith("{")]
    by_id = {message.get("id"): message for message in messages}
    assert 1 in by_id and "result" in by_id[1], text[:800]
    assert by_id[1]["result"].get("protocolVersion") == "2024-11-05"
    assert 2 in by_id and by_id[2]["result"].get("tools"), text[:800]
