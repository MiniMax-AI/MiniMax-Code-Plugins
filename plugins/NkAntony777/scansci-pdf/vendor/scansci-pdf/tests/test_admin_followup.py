"""Follow-up checks for the latest upstream review."""

from __future__ import annotations

import json

import pytest


def test_cookie_store_drops_other_domains_and_keeps_security_fields(tmp_path):
    from scansci_pdf.session_store import CookieStore

    store = CookieStore(tmp_path / "cookies.json")
    saved = store.save([
        {"name": "vpn", "value": "ticket", "domain": ".webvpn.example.edu", "path": "/",
         "httpOnly": True, "secure": True, "sameSite": "Lax", "expires": 9999999999},
        {"name": "idp", "value": "sso", "domain": ".idp.example.edu", "path": "/"},
    ], target_url="https://webvpn.example.edu/login")
    assert [c["name"] for c in saved] == ["vpn"]
    # The gateway session stays HttpOnly across the save; only fields outside
    # the allowlist are dropped.
    assert saved[0]["httpOnly"] is True
    assert saved[0]["sameSite"] == "Lax"
    assert saved[0]["expires"] == 9999999999
    raw = json.loads((tmp_path / "cookies.json").read_text(encoding="utf-8"))
    assert "sso" not in json.dumps(raw)
    loaded = store.load(target_url="https://webvpn.example.edu/")
    assert [c["name"] for c in loaded] == ["vpn"]
    assert loaded[0]["httpOnly"] is True
    assert store.save([{"name": "x", "value": "y", "domain": ".example.edu", "path": "/"}]) == []


def test_restore_reapplies_scope_and_localstorage_opt_in(tmp_path):
    from scansci_pdf.browser_login import PersistentBrowser

    added = []

    class Context:
        def add_cookies(self, cookies):
            added.extend(cookies)

    class Page:
        def goto(self, *args, **kwargs):
            raise AssertionError("localStorage must not be restored when the opt-in is off")

        def evaluate(self, *args, **kwargs):
            raise AssertionError("localStorage must not be restored when the opt-in is off")

    browser = PersistentBrowser()
    browser._context = Context()
    browser._page = Page()
    state = tmp_path / "browser_state.json"
    state.write_text(json.dumps({
        "target_url": "https://www.sciencedirect.com/",
        "cookies": [
            {"name": "sd", "value": "1", "domain": ".sciencedirect.com", "path": "/",
             "httpOnly": True, "secure": True, "sameSite": "Lax", "expires": 9999999999},
            {"name": "idp", "value": "2", "domain": ".university.edu", "path": "/",
             "httpOnly": True, "secure": True, "sameSite": "Lax", "expires": 9999999999},
        ],
        "localStorage": {"https://idp.university.edu": {"token": "secret"}},
    }), encoding="utf-8")
    browser._restore_state({"cache_dir": str(tmp_path),
                            "browser_login_target_url": "https://www.sciencedirect.com/",
                            "browser_persist_localstorage": False})
    assert [c["name"] for c in added] == ["sd"]
    assert added[0]["httpOnly"] is True


def test_streamable_http_rejects_public_bind():
    import typer

    from scansci_pdf.main import _require_loopback_host

    _require_loopback_host("127.0.0.1")
    _require_loopback_host("localhost")
    with pytest.raises(typer.Exit):
        _require_loopback_host("0.0.0.0")
    with pytest.raises(typer.Exit):
        _require_loopback_host("192.168.1.8")


def test_browser_launch_arg_omits_proxy_password():
    from scansci_pdf.browser_engine import _build_browser_args

    args = _build_browser_args({"browser_static_proxy": "http://alice:hunter2@proxy.example:8080"})
    blob = " ".join(args)
    assert "hunter2" not in blob
    assert "--proxy-server=http://proxy.example:8080" in blob


def test_camoufox_launch_checks_the_executable_before_starting(monkeypatch):
    from scansci_pdf.browser_backend import _launch_camoufox, _launch_camoufox_persistent
    from scansci_pdf.security import SecurityError

    def refuse(config):
        raise SecurityError("no pinned digest")

    monkeypatch.setattr("scansci_pdf.browser_backend._verified_camoufox_executable", refuse)
    with pytest.raises(SecurityError, match="digest"):
        _launch_camoufox(False, None, None, False, config={})
    with pytest.raises(SecurityError, match="digest"):
        _launch_camoufox_persistent("profile", False, None, None, False, config={})


def test_single_label_cookie_domain_does_not_cover_a_host():
    from scansci_pdf.browser_cookies import scoped_cookies

    kept = scoped_cookies(
        [{"name": "tld", "value": "x", "domain": "com", "path": "/"}],
        "https://www.nature.com/",
    )
    assert kept == []


def test_localstorage_string_false_is_off():
    from scansci_pdf.browser_login import localstorage_opt_in

    assert localstorage_opt_in("false") is False
    assert localstorage_opt_in("true") is True
    assert localstorage_opt_in(False) is False


def test_camoufox_directory_requires_a_pinned_digest(tmp_path, monkeypatch):
    from scansci_pdf import browser_provenance
    from scansci_pdf.security import SecurityError

    binary = tmp_path / "firefox.exe"
    binary.write_bytes(b"replaced camoufox build")
    monkeypatch.setattr(browser_provenance, "_camoufox_root", lambda: tmp_path)
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: ())
    monkeypatch.setattr(browser_provenance, "_per_user_roots", lambda: ())
    with pytest.raises(SecurityError, match="no pinned digest"):
        browser_provenance.verify_browser_executable(binary, {})
    pinned = {"browser_binary_sha256": {binary.name: browser_provenance.file_digest(binary)}}
    assert browser_provenance.verify_browser_executable(binary, pinned) == binary.resolve()
