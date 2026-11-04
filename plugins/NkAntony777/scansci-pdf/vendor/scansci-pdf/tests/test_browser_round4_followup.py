"""Local maintenance fixtures only; no network, accounts or real credentials."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from scansci_pdf import browser_backend as bb
from scansci_pdf import browser_cookies as bc
from scansci_pdf import browser_engine as be
from scansci_pdf import browser_guard, browser_provenance
from scansci_pdf.security import SecurityError


TARGET = "https://www.sciencedirect.com/"
FUTURE = 4102444800


@pytest.fixture
def browser_fixture(tmp_path, monkeypatch):
    """Keep the real path/digest verifier; replace only discovery and startup."""
    root = tmp_path / "installed"
    root.mkdir()
    explicit = root / "chrome.exe"
    fallback = root / "msedge.exe"
    explicit.write_bytes(b"synthetic selected browser, never executed")
    fallback.write_bytes(b"synthetic discovered browser, never executed")
    monkeypatch.setenv("SCANSCI_PDF_TRUST_BROWSER_PATH", "0")
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: (str(root),))
    monkeypatch.setattr(browser_provenance, "_per_user_roots", lambda: ())
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    monkeypatch.setattr(browser_provenance, "_camoufox_root", lambda: None)
    monkeypatch.setattr(browser_provenance, "_channel_candidates", lambda channel: (str(fallback),))
    monkeypatch.delenv("CLOAKBROWSER_BINARY_PATH", raising=False)
    monkeypatch.delenv("CLOAKBROWSER_AUTO_UPDATE", raising=False)
    monkeypatch.setitem(sys.modules, "cloakbrowser.config", SimpleNamespace(
        get_binary_path=lambda: str(tmp_path / "missing-bundled.exe"),
    ))
    discovered = []
    started = []

    def discover(config):
        discovered.append(config)
        return str(fallback)

    monkeypatch.setattr(bb, "find_local_browser", discover)
    monkeypatch.setattr(browser_guard, "browser_proxy", lambda proxy: {"server": "http://guard.invalid"})

    class Context:
        pages = []

        def close(self):
            pass

        def new_page(self):
            return SimpleNamespace(goto=lambda url, **kwargs: None)

    class Browser:
        version = "150.0.0.0"

        def new_context(self, **kwargs):
            return Context()

        def close(self):
            pass

    class Chromium:
        executable_path = str(tmp_path / "missing-patchright.exe")

        def launch(self, **kwargs):
            started.append(kwargs["executable_path"])
            return Browser()

        def launch_persistent_context(self, **kwargs):
            started.append(kwargs["executable_path"])
            return Context()

    driver = SimpleNamespace(chromium=Chromium(), stop=lambda: None)
    monkeypatch.setitem(sys.modules, "patchright.sync_api", SimpleNamespace(
        sync_playwright=lambda: SimpleNamespace(start=lambda: driver),
    ))

    def cloak_launch(**kwargs):
        started.append(os.environ.get("CLOAKBROWSER_BINARY_PATH"))
        return Browser()

    def cloak_profile(*args, **kwargs):
        started.append(os.environ.get("CLOAKBROWSER_BINARY_PATH"))
        return Context()

    monkeypatch.setattr(bb, "_launch_cloakbrowser", cloak_launch)
    monkeypatch.setattr(bb, "_launch_cloakbrowser_persistent", cloak_profile)
    return SimpleNamespace(explicit=explicit, fallback=fallback,
                           discovered=discovered, started=started)


def _mode(monkeypatch, tmp_path, hosted, backend):
    if hosted:
        monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(tmp_path))
    else:
        monkeypatch.delenv("SCANSCI_PDF_WORKSPACE", raising=False)
    monkeypatch.setattr(bb, "is_available", lambda name: name == backend)


def _launch_entry(tmp_path, profile, config):
    if profile:
        return bb.launch_persistent_context(str(tmp_path / "profile"), config=config)
    return bb.launch(config=config)


@pytest.mark.parametrize("backend", ["patchright", "cloakbrowser"])
@pytest.mark.parametrize("profile", [False, True], ids=["direct", "profile"])
@pytest.mark.parametrize("hosted", [False, True], ids=["ordinary", "hosted"])
def test_all_launch_entries_honor_explicit_path_and_path_keyed_pin(
    tmp_path, monkeypatch, browser_fixture, backend, profile, hosted,
):
    fixture = browser_fixture
    _mode(monkeypatch, tmp_path, hosted, backend)
    monkeypatch.setenv("CLOAKBROWSER_BINARY_PATH", str(fixture.fallback))
    config = {"browser_backend": backend, "browser_executable": str(fixture.explicit),
              "browser_binary_sha256": {str(fixture.explicit): browser_provenance.file_digest(fixture.explicit)}}
    result = _launch_entry(tmp_path, profile, config)
    assert fixture.started == [str(fixture.explicit.absolute())]
    assert fixture.discovered == []
    result.close()


@pytest.mark.parametrize("backend", ["patchright", "cloakbrowser"])
@pytest.mark.parametrize("profile", [False, True], ids=["direct", "profile"])
@pytest.mark.parametrize("hosted", [False, True], ids=["ordinary", "hosted"])
def test_all_launch_entries_refuse_wrong_explicit_digest(
    tmp_path, monkeypatch, browser_fixture, backend, profile, hosted,
):
    fixture = browser_fixture
    _mode(monkeypatch, tmp_path, hosted, backend)
    config = {"browser_backend": backend, "browser_executable": str(fixture.explicit),
              "browser_binary_sha256": {str(fixture.explicit): "ab" * 32}}
    with pytest.raises(SecurityError, match="digest"):
        _launch_entry(tmp_path, profile, config)
    assert fixture.started == []
    assert fixture.discovered == []


@pytest.mark.parametrize("backend", ["patchright", "cloakbrowser"])
@pytest.mark.parametrize("profile", [False, True], ids=["direct", "profile"])
def test_hosted_launch_entries_refuse_missing_explicit_before_fallback(
    tmp_path, monkeypatch, browser_fixture, backend, profile,
):
    fixture = browser_fixture
    _mode(monkeypatch, tmp_path, True, backend)
    missing = tmp_path / "missing-explicit.exe"
    monkeypatch.setenv("CLOAKBROWSER_BINARY_PATH", str(fixture.fallback))
    config = {"browser_backend": backend, "browser_executable": str(missing),
              "browser_binary_sha256": {str(missing): "ab" * 32}}
    with pytest.raises(SecurityError, match="Configured browser executable"):
        _launch_entry(tmp_path, profile, config)
    assert fixture.started == []
    assert fixture.discovered == []
    assert os.environ["CLOAKBROWSER_BINARY_PATH"] == str(fixture.fallback)


@pytest.mark.parametrize("backend", ["patchright", "cloakbrowser"])
@pytest.mark.parametrize("profile", [False, True], ids=["direct", "profile"])
@pytest.mark.parametrize("hosted", [False, True], ids=["ordinary", "hosted"])
def test_all_launch_entries_keep_verified_fallback_without_explicit_selection(
    tmp_path, monkeypatch, browser_fixture, backend, profile, hosted,
):
    fixture = browser_fixture
    _mode(monkeypatch, tmp_path, hosted, backend)
    config = {"browser_backend": backend,
              "browser_binary_sha256": {str(fixture.fallback): browser_provenance.file_digest(fixture.fallback)}}
    result = _launch_entry(tmp_path, profile, config)
    assert fixture.started == [str(fixture.fallback.absolute())]
    result.close()


@pytest.mark.parametrize("backend", ["patchright", "cloakbrowser"])
@pytest.mark.parametrize("profile", [False, True], ids=["direct", "profile"])
def test_ordinary_launch_entries_keep_missing_explicit_fallback_compatibility(
    tmp_path, monkeypatch, browser_fixture, backend, profile,
):
    fixture = browser_fixture
    _mode(monkeypatch, tmp_path, False, backend)
    missing = tmp_path / "missing-explicit.exe"
    config = {"browser_backend": backend, "browser_executable": str(missing),
              "browser_binary_sha256": {str(fixture.fallback): browser_provenance.file_digest(fixture.fallback)}}
    result = _launch_entry(tmp_path, profile, config)
    assert fixture.started == [str(fixture.fallback.absolute())]
    result.close()


@pytest.mark.parametrize("backend", ["patchright", "cloakbrowser"])
@pytest.mark.parametrize("profile", [False, True], ids=["direct", "profile"])
@pytest.mark.parametrize("hosted", [False, True], ids=["ordinary", "hosted"])
def test_all_launch_entries_refuse_fallback_with_wrong_digest(
    tmp_path, monkeypatch, browser_fixture, backend, profile, hosted,
):
    fixture = browser_fixture
    _mode(monkeypatch, tmp_path, hosted, backend)
    config = {"browser_backend": backend,
              "browser_binary_sha256": {str(fixture.fallback): "ab" * 32}}
    with pytest.raises(SecurityError, match="digest"):
        _launch_entry(tmp_path, profile, config)
    assert fixture.started == []


@pytest.mark.parametrize("profile", [False, True], ids=["direct", "profile"])
def test_missing_explicit_cloakbrowser_with_real_approved_system_edge(
    tmp_path, monkeypatch, profile,
):
    """Retain the review's system-browser provenance check without launching it."""
    approved = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
    if not approved.is_file():
        pytest.skip("approved system Edge fixture unavailable")
    _mode(monkeypatch, tmp_path, True, "cloakbrowser")
    monkeypatch.setenv("SCANSCI_PDF_TRUST_BROWSER_PATH", "0")
    assert browser_provenance.verify_browser_executable(approved, {}) == approved.absolute()
    monkeypatch.setenv("CLOAKBROWSER_BINARY_PATH", str(approved))
    monkeypatch.setattr(bb, "find_local_browser", lambda config: str(approved))
    monkeypatch.setattr(browser_guard, "browser_proxy", lambda proxy: {"server": "http://guard.invalid"})
    started = []
    monkeypatch.setattr(bb, "_launch_cloakbrowser", lambda **kwargs: started.append(kwargs))
    monkeypatch.setattr(bb, "_launch_cloakbrowser_persistent", lambda *args, **kwargs: started.append(kwargs))
    missing = tmp_path / "missing-explicit.exe"
    config = {"browser_backend": "cloakbrowser", "browser_executable": str(missing),
              "browser_binary_sha256": {str(missing): "ab" * 32}}
    with pytest.raises(SecurityError, match="Configured browser executable"):
        _launch_entry(tmp_path, profile, config)
    assert started == []


def _cookie(**updates):
    return {"name": "synthetic-session", "value": "synthetic-fixture",
            "domain": ".sciencedirect.com", "path": "/", "httpOnly": False,
            "secure": True, "sameSite": "Lax", "expires": -1, **updates}


@pytest.mark.parametrize("http_only", [False, True])
@pytest.mark.parametrize("same_site", ["Strict", "Lax", "None"])
@pytest.mark.parametrize("expiry", [-1, FUTURE], ids=["session", "persistent"])
def test_own_netscape_export_parse_credentials_and_real_import_round_trip(
    tmp_path, monkeypatch, http_only, same_site, expiry,
):
    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(tmp_path))
    original = _cookie(httpOnly=http_only, sameSite=same_site, expires=expiry)
    text = bc.cookies_to_netscape([original])
    assert ("#HttpOnly_" in text) is http_only
    assert bc.parse_netscape_cookies(text) == [original]
    assert be._parse_netscape_cookies(text) == [original]
    assert bc.credentials_for_target(bc.parse_netscape_cookies(text), {}, TARGET) == [original]
    cookie_file = tmp_path / "own-export.txt"
    bc._save_cookies_netscape([original], cookie_file)
    injected = []
    context = SimpleNamespace(add_cookies=lambda cookies: injected.extend(cookies))
    monkeypatch.setattr(be, "_get_shared_browser", lambda config: (None, context))
    assert be.import_cookies(cookie_file, {}, target_url=TARGET) == 1
    assert injected == [original]


def test_mixed_netscape_jar_restores_both_httponly_values_only_for_complete_authorized_records(
    tmp_path, monkeypatch,
):
    originals = [_cookie(name="script-readable"), _cookie(name="http-only", httpOnly=True, expires=FUTURE)]
    text = bc.cookies_to_netscape(originals + [
        _cookie(name="foreign", domain=".other.example"),
        _cookie(name="expired", expires=1),
    ])
    text += ".sciencedirect.com\tTRUE\t/\tTRUE\t-1\texternal-partial\tfixture\n"
    text += "#HttpOnly_.sciencedirect.com\tTRUE\t/\tTRUE\t-1\texternal-http-only-partial\tfixture\n"
    parsed = bc.parse_netscape_cookies(text)
    assert bc.credentials_for_target(parsed, {}, TARGET) == originals
    cookie_file = tmp_path / "mixed.txt"
    cookie_file.write_text(text, encoding="utf-8")
    injected = []
    context = SimpleNamespace(add_cookies=lambda cookies: injected.extend(cookies))
    monkeypatch.setattr(be, "_get_shared_browser", lambda config: (None, context))
    assert be.import_cookies(cookie_file, {}, target_url=TARGET) == 2
    assert injected == originals


@pytest.mark.parametrize("http_only", [False, True])
@pytest.mark.parametrize("same_site", [None, "", "invalid"])
def test_external_netscape_without_valid_samesite_metadata_stays_partial(
    tmp_path, monkeypatch, http_only, same_site,
):
    prefix = "#HttpOnly_" if http_only else ""
    text = f"{prefix}.sciencedirect.com\tTRUE\t/\tTRUE\t-1\tsynthetic-session\tfixture\n"
    if same_site is not None:
        text = "#ScanSci-Cookie-Attributes " + json.dumps({
            "name": "synthetic-session", "domain": ".sciencedirect.com", "path": "/", "sameSite": same_site,
        }) + "\n" + text
    (parsed,) = bc.parse_netscape_cookies(text)
    assert parsed["httpOnly"] is http_only
    assert "sameSite" not in parsed
    assert bc.is_legacy_cookie_record(parsed)
    assert bc.credentials_for_target([parsed], {}, TARGET) == []
    cookie_file = tmp_path / "external-partial.txt"
    cookie_file.write_text(text, encoding="utf-8")
    monkeypatch.setattr(be, "_get_shared_browser", lambda config: pytest.fail("partial jar started a browser"))
    assert be.import_cookies(cookie_file, {}, target_url=TARGET) == 0


@pytest.mark.parametrize("missing", bc.COOKIE_IDENTITY_FIELDS + bc.COOKIE_SECURITY_FIELDS)
def test_partial_raw_cookie_records_remain_rejected(missing):
    partial = _cookie()
    partial.pop(missing)
    assert bc.is_legacy_cookie_record(partial)
    assert bc.credentials_for_target([partial], {}, TARGET) == []
