"""Regressions for the credential and launch boundaries reported on 0acd104."""

import io
import ast
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import requests

from scansci_pdf import browser_backend as bb, browser_cookies as bc, config as cfg
from scansci_pdf.credential_transport import confined_session
from scansci_pdf.security import SecurityError

TARGET = "https://www.sciencedirect.com/"
COOKIE = dict(name="sid", value="ticket", domain=".sciencedirect.com", path="/",
              httpOnly=True, secure=True, sameSite="Strict", expires=-1)


@pytest.mark.parametrize("missing", bc.COOKIE_SECURITY_FIELDS)
def test_partial_security_record_is_never_restored(missing):
    record = {key: value for key, value in COOKIE.items() if key != missing}
    assert bc.credentials_for_target([record], {}, TARGET) == []


@pytest.mark.parametrize("field,value", [("httpOnly", "false"), ("secure", 1),
                                         ("sameSite", "bogus"), ("expires", float("nan"))])
def test_invalid_security_attributes_are_not_defaulted(field, value):
    assert bc.credentials_for_target([{**COOKIE, field: value}], {}, TARGET) == []
    assert bc.credentials_for_target([COOKIE], {}, TARGET) == [COOKIE]


@pytest.mark.parametrize("persistent", [False, True])
def test_hosted_launch_requires_trusted_config(tmp_path, monkeypatch, persistent):
    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(tmp_path))
    monkeypatch.setattr(bb, "resolve_backend", lambda config: pytest.fail("backend selected without config"))
    with pytest.raises(SecurityError, match="config"):
        if persistent:
            bb.launch_persistent_context(str(tmp_path / "legacy"))
        else:
            bb.launch()


def test_hosted_profile_never_reuses_browser_native_state(tmp_path, monkeypatch):
    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(tmp_path))
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    (legacy / "Cookies").write_text("unrelated-idp-secret", encoding="utf-8")
    monkeypatch.setattr(bb, "_launch_patchright_persistent", lambda *a, **kw: pytest.fail("native profile reused"))
    calls = []
    context = SimpleNamespace(close=lambda: calls.append("context closed"))
    browser = SimpleNamespace(new_context=lambda **kw: context, close=lambda: calls.append("browser closed"))
    monkeypatch.setattr(bb, "launch", lambda **kw: browser)
    returned = bb.launch_persistent_context(str(legacy), config={})
    assert returned is context
    returned.close()
    assert calls == ["context closed", "browser closed"]
    assert (legacy / "Cookies").read_text(encoding="utf-8") == "unrelated-idp-secret"


@pytest.fixture
def private_config(tmp_path, monkeypatch):
    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(tmp_path))
    monkeypatch.setattr(cfg, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setitem(cfg.DEFAULT_CONFIG, "cache_dir", str(tmp_path / "cache"))
    monkeypatch.setitem(cfg.DEFAULT_CONFIG, "output_dir", str(tmp_path / "papers"))
    return cfg


@pytest.mark.parametrize("key,value", [("network_proxy", "http://proxy.example:8080"),
                                      ("browser_static_proxy", "http://proxy.example:8080"),
                                      ("browser_backend", "camoufox"),
                                      ("browser_binary_sha256", {"browser": "ab" * 32}),
                                      ("browser_persist_localstorage", True)])
def test_direct_save_cannot_bypass_confirmation(private_config, key, value):
    changed = {**private_config.load_config(), key: value}
    with pytest.raises(ValueError, match="confirmation required"):
        private_config.save_config(changed)
    assert not private_config.CONFIG_FILE.exists()
    private_config.save_config(changed, confirmed=True)
    before = private_config.CONFIG_FILE.read_bytes()
    private_config.save_config(private_config.load_config())
    assert private_config.CONFIG_FILE.read_bytes() == before


def test_all_egresses_remove_registered_secrets(private_config, monkeypatch, caplog):
    from scansci_pdf.proxy_redaction import redact_proxy_structure, redact_proxy_text, redacting_console, redacting_logger
    secret = "round4-sentinel-api-key"
    with pytest.warns(UserWarning, match="Unknown config key"):
        private_config.update_config("custom_client_secret", secret)
    assert secret not in redact_proxy_text(f"unlabelled exception: {secret}")
    assert secret not in json.dumps(redact_proxy_structure({"nested": [secret], "refreshToken": "response-secret"}))
    assert "response-secret" not in json.dumps(redact_proxy_structure({"refreshToken": "response-secret"}))
    output = io.StringIO()
    redacting_console(file=output).print(secret)
    assert secret not in output.getvalue()
    redacting_logger("round4").warning("failure %s", secret)
    assert secret not in caplog.text


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_zotero_header_is_confined_at_real_requests_redirect_boundary(status):
    sent = []

    class Adapter(requests.adapters.BaseAdapter):
        def send(self, request, **kwargs):
            sent.append(request)
            response = requests.Response()
            response.status_code = status if len(sent) == 1 else 200
            response.url = request.url
            response.request = request
            response._content = b""
            if len(sent) == 1:
                response.headers["Location"] = "https://unrelated.example/collect"
            return response

        def close(self):
            pass

    with confined_session("https://api.zotero.org/users/1/items") as session:
        session.mount("https://", Adapter())
        session.post("https://api.zotero.org/users/1/items", headers={"Zotero-API-Key": "sentinel"})
    assert sent[0].headers["Zotero-API-Key"] == "sentinel"
    assert "Zotero-API-Key" not in sent[1].headers


@pytest.mark.parametrize("url", ["http://www.zotero.org/services/storage/upload",
                                "https://www.zotero.org.evil.example/upload",
                                "https://127.0.0.1/upload", "https://www.zotero.org:8443/upload",
                                "https://user:pass@www.zotero.org/upload"])
def test_response_supplied_upload_url_is_allowlisted(url):
    from scansci_pdf.zotero import validate_upload_url
    with pytest.raises(SecurityError):
        validate_upload_url(url)
    assert validate_upload_url("https://www.zotero.org/services/storage/upload")


def test_isolated_bootstrap_ignores_inherited_python_startup(tmp_path):
    engine = Path(__file__).resolve().parents[1]
    marker = tmp_path / "injected"
    poison = f"from pathlib import Path; Path({str(marker)!r}).write_text('injected')\n"
    for name in ("sitecustomize.py", "hashlib.py"):
        (tmp_path / name).write_text(poison, encoding="utf-8")
    environment = {**os.environ, "SCANSCI_PDF_PYTHON": sys.executable,
                   "PYTHONPATH": str(tmp_path), "PYTHONHOME": str(tmp_path / "missing"),
                   "PYTHONSTARTUP": str(tmp_path / "sitecustomize.py")}
    result = subprocess.run(["node", str(engine / "launch_secure.mjs"), "--verify"],
                            cwd=tmp_path, env=environment, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["isolated_startup"] is True
    assert Path(report["python_executable"]) == Path(sys.executable)
    assert not marker.exists()


def test_secure_entry_independently_checks_python_floor(tmp_path):
    entry = Path(__file__).resolve().parents[1] / "run_secure.py"
    script = f"import sys,runpy; sys.version_info=(3,10); runpy.run_path({str(entry)!r},run_name='__main__')"
    result = subprocess.run([sys.executable, "-I", "-c", script], cwd=tmp_path,
                            capture_output=True, text=True, timeout=20)
    assert result.returncode != 0 and "Python >=3.11" in result.stderr


def test_unisolated_direct_entry_is_refused(tmp_path):
    entry = Path(__file__).resolve().parents[1] / "run_secure.py"
    result = subprocess.run([sys.executable, str(entry), "--verify"], cwd=tmp_path,
                            capture_output=True, text=True, timeout=20)
    assert result.returncode != 0 and "Isolated Python startup required" in result.stderr


def test_all_browser_call_sites_supply_config():
    source = Path(__file__).resolve().parents[1] / "src" / "scansci_pdf"
    calls = []
    for path in source.rglob("*.py"):
        if path.name == "browser_backend.py":
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                if node.func.id in {"launch", "launch_persistent_context", "get_persistent_context"}:
                    explicit = any(item.arg == "config" for item in node.keywords)
                    positional = node.func.id == "get_persistent_context" and len(node.args) >= 2
                    assert explicit or positional, f"{path.name}:{node.lineno} omits config"
                    calls.append(node)
    assert len(calls) >= 12


def test_missing_explicit_binary_never_falls_back(tmp_path, monkeypatch):
    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(tmp_path))
    monkeypatch.setattr(bb, "resolve_channel_executable", lambda *a: pytest.fail("explicit pin bypassed"))
    with pytest.raises(SecurityError, match="Configured browser executable"):
        bb._patchright_browser_kwargs({"browser_executable": str(tmp_path / "missing.exe")})
    with pytest.raises(SecurityError, match="Configured browser executable"):
        bb.resolve_browser_binary({"browser_executable": str(tmp_path / "missing.exe")})


@pytest.mark.parametrize("module", ["scansci_pdf.publisher_batch", "scansci_pdf.institutional.publisher_batch"])
def test_batch_worker_never_clones_legacy_profile(module, tmp_path, monkeypatch):
    import importlib
    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(tmp_path))
    klass = importlib.import_module(module).PublisherBatchDownloader
    worker = klass.__new__(klass)
    source = tmp_path / "legacy"
    source.mkdir()
    (source / "Cookies").write_text("legacy-idp-secret", encoding="utf-8")
    target = tmp_path / "worker"
    assert worker._prepare_worker_profile(source, target) == target
    assert not target.exists()
    assert (source / "Cookies").read_text(encoding="utf-8") == "legacy-idp-secret"


def test_stream_egress_handles_split_secrets_and_preserves_nonsecret_text():
    from scansci_pdf.proxy_redaction import _RedactingStream, register_config_secrets
    register_config_secrets({"api_key": "round4-split-secret"})
    output = io.StringIO()
    stream = _RedactingStream(output)
    stream.write("safe prefix round4-split-")
    stream.flush()
    stream.write("secret\n")
    stream.flush()
    assert output.getvalue() == "safe prefix ***\n"


def test_upload_body_is_one_stream_with_unambiguous_length():
    from scansci_pdf.zotero import _UploadStream
    stream = _UploadStream(io.BytesIO(b"PDF bytes"), b"prefix", b"suffix", 21)
    request = requests.Request("POST", "https://www.zotero.org/services/storage/upload",
                               data=stream).prepare()
    assert request.headers["Content-Length"] == "21"
    assert "Transfer-Encoding" not in request.headers
    assert b"".join(request.body) == b"prefixPDF bytessuffix"


def test_real_cli_secret_echo_is_masked_and_trust_write_requires_confirmation(tmp_path):
    engine = Path(__file__).resolve().parents[1]
    base = [sys.executable, "-I", str(engine / "run_secure.py")]
    secret = "round4-terminal-secret"
    for arguments in (["config-cmd", "custom_client_secret", secret],
                      ["--module", "scansci_pdf.cli", "config-cmd", "--elsevier-inst-token", secret]):
        result = subprocess.run([*base, *arguments], cwd=tmp_path, capture_output=True,
                                encoding="utf-8", errors="replace", timeout=30)
        assert result.returncode == 0, result.stderr
        assert secret not in result.stdout + result.stderr
    rejected = subprocess.run([*base, "config-cmd", "browser_backend", "camoufox"],
                              cwd=tmp_path, capture_output=True, text=True, timeout=30)
    assert rejected.returncode != 0 and "confirmation required" in rejected.stdout + rejected.stderr
    accepted = subprocess.run([*base, "config-cmd", "--confirm-trust", "browser_backend", "camoufox"],
                             cwd=tmp_path, capture_output=True, text=True, timeout=30)
    assert accepted.returncode == 0, accepted.stderr
    assert json.loads((tmp_path / ".scansci-pdf" / "config.json").read_text())["browser_backend"] == "camoufox"


def test_real_hosted_context_restart_drops_native_sso_and_localstorage(tmp_path, monkeypatch):
    from scansci_pdf.browser_login import PersistentBrowser
    executable = os.environ.get("SCANSCI_AUDIT_BROWSER")
    if not executable:
        pytest.skip("set SCANSCI_AUDIT_BROWSER to an approved installed browser")
    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(tmp_path))
    config = {"browser_backend": "patchright", "browser_executable": executable,
              "cache_dir": str(tmp_path / "cache"), "browser_login_target_url": TARGET}
    profile = tmp_path / "legacy-profile"
    profile.mkdir()
    (profile / "Cookies").write_text("legacy-secret", encoding="utf-8")
    first = bb.launch_persistent_context(str(profile), config=config, headless=True)
    try:
        first.route("**/*", lambda route: route.fulfill(body="<html>fixture</html>"))
        first.add_cookies([COOKIE, {**COOKIE, "name": "idp", "domain": ".example.org"}])
        page = first.new_page()
        page.goto(TARGET)
        page.evaluate("localStorage.setItem('token','unapproved-local-storage')")
        state = PersistentBrowser()
        state._context, state._page = first, page
        state.save_cookies(config)
    finally:
        first.close()
    second = bb.launch_persistent_context(str(profile), config=config, headless=True)
    try:
        assert second.cookies() == []
        second.route("**/*", lambda route: route.fulfill(body="<html>fixture</html>"))
        page = second.new_page()
        state._context, state._page = second, page
        state._restore_state(config)
        page.goto(TARGET)
        assert page.evaluate("localStorage.length") == 0
        assert [c["name"] for c in second.cookies()] == ["sid"]
        assert second.cookies()[0]["httpOnly"] is True
        assert (profile / "Cookies").read_text(encoding="utf-8") == "legacy-secret"
    finally:
        second.close()
