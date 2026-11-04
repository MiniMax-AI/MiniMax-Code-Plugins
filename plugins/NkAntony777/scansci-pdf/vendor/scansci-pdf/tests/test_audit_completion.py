"""Acceptance regressions for gaps found in the 2026-10-11 handoff."""
from __future__ import annotations

import io
import json
import logging
from pathlib import Path

import pytest
import requests

KEY = "AUDIT-ELSEVIER-KEY"
TOKEN = "AUDIT-INSTITUTION-TOKEN"
DOI = "10.1016/j.audit.2026.01.001"
SECRET = "AUDIT-PROXY-SECRET"
PROXY = f"http://owner:{SECRET}@proxy.example:8080"


@pytest.mark.parametrize("status", [302, 303, 307, 308])
@pytest.mark.parametrize("entry", [
    "head_probe", "error_probe", "key_probe", "institutional_pdf",
    "institutional_xml", "bridge", "publisher", "mcp_setup", "cli_setup",
])
def test_all_elsevier_exits_confine_credentials(entry, status, monkeypatch, tmp_path):
    """Capture real prepared requests, replacing only the wire adapter."""
    seen = []

    def send(adapter, request, **kwargs):
        seen.append(request)
        response = requests.Response()
        response.url = request.url
        response.request = request
        response.raw = io.BytesIO(b"missing")
        response._content = b"missing"
        if request.url.startswith("https://api.elsevier.com/"):
            response.status_code = status
            response.headers["Location"] = "https://redirect.example/receiver"
        else:
            response.status_code = 404
        return response

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    monkeypatch.delenv("SCANSCI_PDF_PROXY", raising=False)
    config = {"elsevier_api_key": KEY, "elsevier_insttoken": TOKEN}
    from scansci_pdf import elsevier_check
    if entry == "head_probe":
        elsevier_check._head_probe(DOI, KEY, None)
    elif entry == "error_probe":
        elsevier_check._error_status_text_probe(DOI, KEY, None)
    elif entry == "key_probe":
        elsevier_check._probe_key_valid(KEY, None)
    elif entry in {"institutional_pdf", "institutional_xml"}:
        from scansci_pdf.institutional.sources import elsevier_api
        operation = elsevier_api.fetch_pdf if entry.endswith("pdf") else elsevier_api.fetch_fulltext
        operation(DOI, KEY, TOKEN, config)
    elif entry == "bridge":
        from scansci_pdf.institutional import instsci_bridge
        instsci_bridge._try_elsevier_api(DOI, tmp_path / "paper.pdf", config)
    elif entry == "publisher":
        from scansci_pdf import _publisher_strategies_core
        _publisher_strategies_core.try_elsevier_api(DOI, tmp_path / "paper.pdf", config)
    elif entry == "mcp_setup":
        from scansci_pdf import server
        monkeypatch.setattr(server, "load_config", lambda: config)
        server.scansci_pdf_elsevier_setup(test=True)
    elif entry == "cli_setup":
        from scansci_pdf import _cli_core
        monkeypatch.setattr(_cli_core, "load_config", lambda: config)
        _cli_core.elsevier_setup(api_key="", inst_token="", validate=True)

    issued = [r for r in seen if r.url.startswith("https://api.elsevier.com/")]
    redirected = [r for r in seen if r.url.startswith("https://redirect.example/")]
    assert issued and redirected, "the production entry must actually follow the replayed redirect"
    assert all(r.headers.get("X-ELS-APIKey") == KEY for r in issued)
    assert all("X-ELS-APIKey" not in r.headers and "X-ELS-InstToken" not in r.headers
               for r in redirected)


def test_proxy_result_redaction_has_no_depth_or_mapping_key_escape():
    from scansci_pdf.proxy_redaction import redact_proxy_structure
    nested = {PROXY: PROXY}
    for _ in range(40):
        nested = {"next": [nested]}
    safe = redact_proxy_structure(nested)
    encoded = json.dumps(safe)
    assert SECRET not in encoded
    assert "proxy.example:8080" in encoded
    recursive = [PROXY]
    recursive.append(recursive)
    assert SECRET not in json.dumps(redact_proxy_structure(recursive))


@pytest.mark.parametrize("encoded", [False, True])
def test_auth_logs_redact_arguments_and_exception_chains(encoded, monkeypatch, caplog):
    from scansci_pdf import auth
    from urllib.parse import quote
    secret = quote(SECRET + "/:@", safe="") if encoded else SECRET
    proxy = f"http://owner:{secret}@[2001:db8::1]:8080"
    with caplog.at_level(logging.WARNING):
        auth.logger.warning("Session validation failed: %s", RuntimeError(proxy))
        try:
            try:
                raise OSError("upstream " + proxy)
            except OSError as cause:
                raise RuntimeError("outer " + proxy) from cause
        except RuntimeError:
            auth.logger.exception("session request failed")
    assert secret not in caplog.text
    assert "[2001:db8::1]:8080" in caplog.text


def test_actual_auth_validation_failure_does_not_log_proxy_secret(monkeypatch, caplog):
    from scansci_pdf.auth import WebVPNAuth
    session = requests.Session()
    def fail(*args, **kwargs):
        raise requests.RequestException("connection to " + PROXY)
    monkeypatch.setattr(session, "get", fail)
    auth = WebVPNAuth({"network_proxy": PROXY})
    auth._session = session
    assert auth._validate_session() is False
    assert SECRET not in caplog.text


def test_mcp_and_cli_result_boundaries_redact_nested_errors(monkeypatch, capsys):
    from scansci_pdf import server, _cli_core, main
    result = {"failures": [{PROXY: {"exception": PROXY}}]}
    assert SECRET not in server._json_result(result)
    _cli_core.console.print(result)
    main.print(result)
    assert SECRET not in capsys.readouterr().out


def test_guarded_mcp_error_message_does_not_expose_credentials(monkeypatch):
    from scansci_pdf.security import guarded_tool, SecurityError
    monkeypatch.delenv("SCANSCI_PDF_WORKSPACE", raising=False)
    @guarded_tool
    def tool():
        raise RuntimeError("failed " + PROXY)
    with pytest.raises(SecurityError) as result:
        tool()
    assert SECRET not in str(result.value)
    assert result.value.__suppress_context__


def test_positive_launcher_stage_keeps_the_shipped_manifest_and_locks(tmp_path):
    import importlib.util
    path = Path(__file__).with_name("_secure_stage.py")
    spec = importlib.util.spec_from_file_location("audit_secure_stage", path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    stage = helper.stage_engine(tmp_path / "copy")
    for name in ("SOURCE-HASHES.json", "requirements.lock", "requirements-browser.lock"):
        assert (stage / name).read_bytes() == (helper.ENGINE / name).read_bytes()

def test_legacy_cookie_cannot_be_laundered_through_institutional_restore(tmp_path):
    from scansci_pdf.auth import _seed_saved_cookies
    from scansci_pdf.session_store import CookieStore
    from scansci_pdf import browser_cookies
    legacy = [{"name": "session", "value": "old-ticket", "domain": ".sciencedirect.com", "path": "/"}]
    cookie_file = tmp_path / "cookies.json"
    cookie_file.write_text(json.dumps(legacy), encoding="utf-8")
    class Context:
        def add_cookies(self, cookies):
            raise AssertionError("legacy cookies must require login")
    assert _seed_saved_cookies(cookie_file, Context(), "https://www.sciencedirect.com/") == 0
    assert CookieStore(cookie_file).load(target_url="https://www.sciencedirect.com/") == []
    (tmp_path / "publisher_cookies.json").write_text(json.dumps(legacy), encoding="utf-8")
    assert browser_cookies.load_saved_cookies({"cache_dir": str(tmp_path)}, "https://www.sciencedirect.com/") == []


def _secure_cookie(**changes):
    cookie = {"name": "session", "value": "ticket", "domain": ".sciencedirect.com", "path": "/",
              "httpOnly": True, "secure": True, "sameSite": "Strict", "expires": 9999999999}
    cookie.update(changes)
    return cookie


def test_requests_cookie_restore_preserves_secure_expiry_and_samesite(tmp_path):
    from scansci_pdf.session_store import CookieStore
    store = CookieStore(tmp_path / "cookies.json")
    target = "https://www.sciencedirect.com/"
    store.save([_secure_cookie()], target_url=target)
    session = requests.Session()
    assert store.load_into(session, target_url=target)
    cookie = next(iter(session.cookies))
    assert cookie.secure and cookie.expires == 9999999999
    assert cookie.get_nonstandard_attr("HttpOnly") is True
    assert cookie.get_nonstandard_attr("SameSite") == "Strict"
    assert "Cookie" not in session.prepare_request(requests.Request("GET", "http://www.sciencedirect.com/")).headers
    assert "session=ticket" in session.prepare_request(requests.Request("GET", target)).headers["Cookie"]


def test_netscape_roundtrip_preserves_samesite_in_both_consumers():
    from scansci_pdf import browser_cookies, browser_engine, camofox
    text = browser_cookies.cookies_to_netscape([_secure_cookie()])
    for parse in (browser_engine._parse_netscape_cookies, camofox._parse_netscape_cookies):
        cookie, = parse(text)
        assert cookie == _secure_cookie()


def test_merge_does_not_authorize_every_known_publisher_by_default(tmp_path):
    from scansci_pdf import browser_cookies
    config = {"cache_dir": str(tmp_path)}
    assert browser_cookies.merge_cookies([_secure_cookie()], config) == []
    assert not (tmp_path / "publisher_cookies.json").exists()
    merged = browser_cookies.merge_cookies([
        _secure_cookie(), _secure_cookie(domain=".springer.com", name="other")
    ], config, "https://www.sciencedirect.com/")
    assert [c["name"] for c in merged] == ["session"]


def test_empty_merge_removes_expired_credentials_from_disk(tmp_path):
    from scansci_pdf import browser_cookies
    cookie_file = tmp_path / "publisher_cookies.json"
    cookie_file.write_text(json.dumps([_secure_cookie(expires=1)]), encoding="utf-8")
    assert browser_cookies.merge_cookies([], {"cache_dir": str(tmp_path)}, "https://www.sciencedirect.com/") == []
    assert json.loads(cookie_file.read_text(encoding="utf-8")) == []


def test_publisher_save_and_api_merge_preserve_httponly_and_samesite(tmp_path, monkeypatch):
    from scansci_pdf import _publisher_strategies_core as core, browser_engine
    monkeypatch.setattr(browser_engine, "is_available", lambda *args: False)
    config = {"cache_dir": str(tmp_path)}
    core._save_all_cookie_formats([_secure_cookie()], "elsevier", config,
                                  target_url="https://idp.example.edu/")
    for path in (tmp_path / "carsi_cookies" / "elsevier.json", tmp_path / "publisher_cookies.json"):
        saved, = json.loads(path.read_text(encoding="utf-8"))
        assert saved["httpOnly"] and saved["sameSite"] == "Strict"
    session = requests.Session()
    session.cookies.set("session", "ticket", domain=".sciencedirect.com", path="/", secure=True,
                        expires=9999999999, rest={"HttpOnly": True, "SameSite": "Strict"})
    assert core._persist_api_cookies(session, config) == 1
    saved, = json.loads((tmp_path / "publisher_cookies.json").read_text(encoding="utf-8"))
    assert saved["httpOnly"] and saved["sameSite"] == "Strict"


def test_host_cookie_requires_a_host_only_domain():
    from scansci_pdf.browser_cookies import credentials_for_target
    target = "https://www.sciencedirect.com/"
    assert credentials_for_target([_secure_cookie(name="__Host-session")], None, target) == []
    assert credentials_for_target([_secure_cookie(name="__Host-session", domain="www.sciencedirect.com")], None, target)


@pytest.mark.parametrize("confirmed", ["false", "true", 1, [], {}])
def test_trust_confirmation_requires_boolean_true(confirmed, monkeypatch, tmp_path):
    from scansci_pdf.config_trust import enforce_trust_write
    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(tmp_path))
    with pytest.raises(ValueError, match="confirmation"):
        enforce_trust_write("browser_binary_sha256", "a" * 64, confirmed=confirmed)


def test_windows_metadata_probe_quotes_approved_literal_paths(monkeypatch, tmp_path):
    import hashlib
    from types import SimpleNamespace
    from scansci_pdf import browser_backend, browser_provenance
    binary = tmp_path / "owner's browser" / "chrome.exe"
    binary.parent.mkdir()
    binary.write_bytes(b"approved fixture")
    monkeypatch.setenv(browser_provenance._OPT_IN_ENV, "1")
    monkeypatch.setattr(browser_backend, "_SYSTEM_BROWSER_PATHS_WIN", [str(binary)])
    calls = []
    def run(arguments, **kwargs):
        calls.append(arguments)
        return SimpleNamespace(stdout=str(binary) + "\t150.0.0.0\n")
    monkeypatch.setattr(browser_backend.subprocess, "run", run)
    result = browser_backend._probe_windows_versions({"browser_binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest()})
    assert result[str(binary)] == "150.0.0.0"
    script = calls[0][-1]
    assert "owner''s browser" in script
    assert "Test-Path -LiteralPath" in script and "Get-Item -LiteralPath" in script

def test_cookie_roundtrip_in_real_approved_browser(monkeypatch, tmp_path):
    """Opt-in integration: real browser, production save/restore, local routes."""
    import os
    import time
    from scansci_pdf import browser_backend
    from scansci_pdf.browser_login import PersistentBrowser
    executable = os.environ.get("SCANSCI_AUDIT_BROWSER")
    if not executable:
        pytest.skip("set SCANSCI_AUDIT_BROWSER to an installed approved browser")
    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(tmp_path))
    target = "https://www.sciencedirect.com/"
    config = {"browser_backend": "patchright", "browser_executable": executable,
              "browser_login_target_url": target, "browser_persist_localstorage": False,
              "cache_dir": str(tmp_path / "cache")}
    browser = browser_backend.launch(config=config, headless=True, humanize=False)
    expiry = int(time.time()) + 3600
    try:
        first = browser.new_context()
        first.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body="<html><body>local fixture</body></html>"))
        first.add_cookies([
            _secure_cookie(name="audit-session", expires=expiry),
            _secure_cookie(name="audit-public", httpOnly=False, expires=-1),
            _secure_cookie(name="audit-expired", expires=1),
        ])
        page = first.new_page()
        page.goto(target)
        assert "audit-session" not in page.evaluate("document.cookie")
        saved = PersistentBrowser()
        saved._context, saved._page = first, page
        saved.save_cookies(config, target_url=target)
        assert saved._cookies_saved
        first.close()

        second = browser.new_context()
        second.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body="<html><body>local fixture</body></html>"))
        page = second.new_page()
        restored = PersistentBrowser()
        restored._context, restored._page = second, page
        restored._restore_state(config)
        page.goto(target)
        visible = page.evaluate("document.cookie")
        assert "audit-session" not in visible and "audit-public" in visible
        cookies = {c["name"]: c for c in second.cookies()}
        private = cookies["audit-session"]
        assert private["httpOnly"] is True and private["secure"] is True
        assert private["sameSite"] == "Strict" and private["expires"] == expiry
        assert cookies["audit-public"]["expires"] == -1
        assert "audit-expired" not in cookies
        print(json.dumps({"browser": browser.version, "httponly": True, "secure": True,
                          "same_site": private["sameSite"], "expiry_preserved": True,
                          "session_preserved": True, "expired_dropped": True}))
        second.close()
    finally:
        browser.close()

def test_rich_table_output_does_not_bypass_proxy_redaction(capsys):
    from rich.table import Table
    from scansci_pdf._cli_core import console
    table = Table("failure")
    table.add_row(PROXY)
    console.print(table)
    assert SECRET not in capsys.readouterr().out


@pytest.mark.parametrize("base_key", ["instsci_base_url", "vpnsci_base_url"])
@pytest.mark.parametrize("legacy_filename", [False, True])
def test_webvpn_requests_restore_preserves_cookie_attributes(tmp_path, monkeypatch, base_key, legacy_filename):
    from scansci_pdf.sources import instsci
    path = tmp_path / "instsci-cookies.json"
    monkeypatch.setattr(instsci, "instsci_cookie_path", lambda config: path)
    target = "https://gateway.example.edu/"
    cookie = _secure_cookie(domain="gateway.example.edu")
    instsci._save_cookies([cookie, _secure_cookie(name="expired", domain="gateway.example.edu", expires=1),
                          _secure_cookie(name="unrelated")], {base_key: target})
    if legacy_filename:
        path.rename(path.with_name("instsci_cookies.json"))
    jar = instsci._load_cookies({base_key: target})
    restored, = jar
    assert restored.secure and restored.expires == cookie["expires"]
    assert restored.get_nonstandard_attr("HttpOnly") is True
    assert restored.get_nonstandard_attr("SameSite") == "Strict"
    with requests.Session() as session:
        session.cookies.update(jar)
        assert "Cookie" not in session.prepare_request(requests.Request("GET", "http://gateway.example.edu/")).headers
        assert "session=ticket" in session.prepare_request(requests.Request("GET", target)).headers["Cookie"]


@pytest.mark.parametrize("operation", ["load", "save"])
def test_webvpn_does_not_normalize_legacy_cookie_into_a_trusted_record(tmp_path, monkeypatch, operation):
    from scansci_pdf.sources import instsci
    path = tmp_path / "instsci-cookies.json"
    monkeypatch.setattr(instsci, "instsci_cookie_path", lambda config: path)
    cookies = [{"name": "session", "value": "old-ticket", "domain": "gateway.example.edu", "path": "/"}]
    config = {"instsci_base_url": "https://gateway.example.edu/"}
    if operation == "save":
        instsci._save_cookies(cookies, config)
        assert json.loads(path.read_text(encoding="utf-8")) == []
    else:
        path.write_text(json.dumps(cookies), encoding="utf-8")
    assert not instsci._load_cookies(config)


def test_launcher_staging_excludes_local_environments_and_bytecode(tmp_path):
    import importlib.util
    path = Path(__file__).with_name("_secure_stage.py")
    spec = importlib.util.spec_from_file_location("audit_stage_exclusions", path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    stage = helper.stage_engine(tmp_path / "copy")
    assert not (stage / ".venv").exists()
    assert not list(stage.rglob("*.pyc"))
    assert not list(stage.rglob("*.egg-info"))
    assert not (stage / "uv.lock").exists()


@pytest.mark.parametrize("entry", ["scoped", "merge"])
def test_legacy_cookie_cannot_enter_persistence_as_a_new_merge_record(tmp_path, entry):
    from scansci_pdf import browser_cookies
    cookies = [{"name": "session", "value": "old-ticket", "domain": ".sciencedirect.com", "path": "/"}]
    target = "https://www.sciencedirect.com/"
    if entry == "scoped":
        assert browser_cookies.scoped_cookies(cookies, target) == []
    else:
        assert browser_cookies.merge_cookies(cookies, {"cache_dir": str(tmp_path)}, target) == []
        assert json.loads((tmp_path / "publisher_cookies.json").read_text(encoding="utf-8")) == []
