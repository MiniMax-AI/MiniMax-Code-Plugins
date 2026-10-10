"""Browser login persists target-domain credentials only."""

from __future__ import annotations

import atexit
import json
from pathlib import Path

import pytest

from scansci_pdf import browser_cookies as bc
from scansci_pdf import browser_login as bl
from scansci_pdf.browser_cookies import (
    is_allowed_login_destination,
    minimal_cookies,
    scoped_cookies,
)

# browser_login registers a module-level singleton close with atexit, which
# logs after pytest has already closed its capture stream. Unregister it so the
# suite output stays clean; nothing here depends on the shutdown hook.
atexit.unregister(bl._browser.close)

TARGET = "https://www.sciencedirect.com/"

# What a real context holds after a campus SSO round-trip: publisher session
# cookies plus the IdP/SSO cookies of the portal that issued them.
JAR = [
    {"name": "SD_session", "value": "pub-token", "domain": ".sciencedirect.com",
     "path": "/", "secure": True, "httpOnly": True, "expires": 9999999999,
     "sameSite": "Lax"},
    {"name": "shibsession", "value": "idp-token", "domain": ".tsinghua.edu.cn",
     "path": "/", "secure": True, "httpOnly": True, "expires": 9999999999},
    {"name": "CAS", "value": "cas-token", "domain": "idp.campus.example.edu",
     "path": "/", "secure": True, "httpOnly": True, "expires": 9999999999},
    {"name": "mail", "value": "webmail", "domain": ".mail.example.com",
     "path": "/", "secure": True, "httpOnly": True, "expires": 9999999999},
]


def test_scoped_cookies_drops_unrelated_domains():
    kept = scoped_cookies(JAR, TARGET)
    domains = {c["domain"] for c in kept}
    assert domains == {".sciencedirect.com"}
    names = {c["name"] for c in kept}
    assert "shibsession" not in names
    assert "CAS" not in names
    assert "mail" not in names


def test_scoped_cookies_keeps_only_minimum_fields():
    kept = scoped_cookies(JAR, TARGET)
    assert kept == [{"name": "SD_session", "value": "pub-token",
                     "domain": ".sciencedirect.com", "path": "/"}]
    for cookie in kept:
        assert set(cookie) == {"name", "value", "domain", "path"}


def test_scoped_cookies_keeps_target_host_and_publishers():
    """Only the target domain survives.

    Persisting a sibling publisher's cookie alongside the target's meant one
    login left a live session behind for every other publisher on the list.
    Cross-domain flows are unaffected because WebVPN/EZProxy proxy the
    publisher under the proxy hostname, which is the target here.
    """
    jar = [
        {"name": "vpn", "value": "vpn-token", "domain": ".webvpn.campus.edu.cn", "path": "/"},
        {"name": "sd", "value": "pub-token", "domain": ".sciencedirect.com", "path": "/"},
        {"name": "other", "value": "x", "domain": ".mail.example.com", "path": "/"},
    ]
    kept = scoped_cookies(jar, "https://webvpn.campus.edu.cn/remote/login")
    assert {c["name"] for c in kept} == {"vpn"}


def test_scoped_cookies_rejects_lookalike_domains():
    """Suffix matching must be dot-anchored, not a bare endswith."""
    jar = [
        {"name": "lookalike", "value": "x", "domain": "evil-sciencedirect.com", "path": "/"},
        {"name": "real", "value": "y", "domain": ".sciencedirect.com", "path": "/"},
        {"name": "sub", "value": "z", "domain": "www.sciencedirect.com", "path": "/"},
    ]
    kept = {c["name"] for c in scoped_cookies(jar, TARGET)}
    assert kept == {"real", "sub"}
    assert bc._is_publisher_cookie({"domain": "evil-sciencedirect.com"}) is False


def test_minimal_cookies_defaults_missing_path():
    assert minimal_cookies([{"name": "a", "value": "b", "domain": "x.com"}]) == [
        {"name": "a", "value": "b", "domain": "x.com", "path": "/"}
    ]


@pytest.mark.parametrize("url", [
    "https://www.sciencedirect.com/",
    "https://link.springer.com/article/10.1/x",
    "https://doi.org/10.1126/science.aec6396",
    "https://onlinelibrary.wiley.com/doi/10.1/x",
])
def test_allowlisted_custom_destinations(url):
    allowed, _host = is_allowed_login_destination(url)
    assert allowed is True


@pytest.mark.parametrize("url", [
    "https://mail.example.com/",
    "https://evil-sciencedirect.com.attacker.test/",
    "https://intranet.campus.edu.cn/idp",
    "file:///etc/passwd",
    "not-a-url",
])
def test_non_allowlisted_custom_destinations(url):
    allowed, _host = is_allowed_login_destination(url)
    assert allowed is False


def test_custom_destination_rejected_before_browser_launch(monkeypatch, caplog):
    """A non-allowlisted custom URL never reaches the browser."""
    def _explode(*_a, **_k):
        raise AssertionError("browser must not launch for a rejected destination")

    monkeypatch.setattr(bl, "launch", _explode, raising=False)
    monkeypatch.setattr(bl, "_HAS_CLOAKBROWSER", True)

    with caplog.at_level("INFO"):
        result = bl.open_login_browser(
            "https://mail.example.com/", {}, cookie_file=Path("unused.json"),
        )

    assert result is False
    assert "Rejected non-allowlisted login destination" in caplog.text
    assert "mail.example.com" in caplog.text


def test_institutional_flows_are_allowlist_exempt(monkeypatch):
    """WebVPN/EZProxy/CARSI origins come from config, not from a caller."""
    seen = {}

    def _fake_open(url, config, **kwargs):
        seen["url"] = url
        seen["allow_unlisted_domain"] = kwargs.get("allow_unlisted_domain")
        return True

    monkeypatch.setattr(bl, "open_login_browser", _fake_open)
    monkeypatch.setattr("scansci_pdf.sources.instsci._get_webvpn_base",
                        lambda config: "https://webvpn.campus.edu.cn")

    assert bl.webvpn_login({}) is True
    assert seen["url"] == "https://webvpn.campus.edu.cn"
    assert seen["allow_unlisted_domain"] is True


def test_extract_via_browser_rejects_non_allowlisted_url():
    result = bc.extract_via_browser({}, url="https://mail.example.com/")
    assert result["success"] is False
    assert "not allowed" in result["error"]


def test_extract_via_browser_rejects_non_allowlisted_url_before_launch(monkeypatch):
    def _explode(*_a, **_k):
        raise AssertionError("browser must not launch for a rejected destination")

    import scansci_pdf.browser_backend as backend
    monkeypatch.setattr(backend, "launch", _explode, raising=False)
    monkeypatch.setattr(backend, "is_available", lambda *_a, **_k: True, raising=False)

    result = bc.extract_via_browser({}, url="https://intranet.campus.edu.cn/")
    assert result["success"] is False
    assert "not allowed" in result["error"]


def test_publisher_login_rejects_non_allowlisted_url():
    result = bc.publisher_login("https://mail.example.com/", {})
    assert result["success"] is False
    assert "not allowed" in result["error"]


def test_merge_cookies_persists_minimum_fields(tmp_path):
    config = {"cache_dir": str(tmp_path)}
    raw = [{"name": "SD", "value": "t", "domain": ".sciencedirect.com",
            "path": "/", "secure": True, "httpOnly": True, "expires": 1,
            "sameSite": "Lax", "session": True}]
    result = bc.merge_cookies(raw, config)

    assert result == [{"name": "SD", "value": "t",
                       "domain": ".sciencedirect.com", "path": "/"}]
    saved = json.loads((tmp_path / "publisher_cookies.json").read_text(encoding="utf-8"))
    assert saved == result


# --- localStorage is opt-in only -------------------------------------------


class _FakePage:
    def __init__(self, url, items):
        self.url = url
        self._items = items
        self.visited = []

    def evaluate(self, script):
        return dict(self._items)


class _FakeContext:
    def __init__(self, cookies, pages):
        self._cookies = cookies
        self.pages = pages

    def cookies(self):
        return self._cookies


def _persistent(tmp_path, cookies, pages):
    browser = bl.PersistentBrowser()
    browser._context = _FakeContext(cookies, pages)
    return browser


def test_localstorage_not_persisted_by_default(tmp_path):
    pages = [_FakePage(TARGET, {"token": "publisher-token"})]
    browser = _persistent(tmp_path, JAR, pages)

    browser.save_cookies({"cache_dir": str(tmp_path)})

    state = json.loads((tmp_path / "browser_state.json").read_text(encoding="utf-8"))
    assert state["localStorage"] == {}
    assert "publisher-token" not in json.dumps(state)


def test_localstorage_persisted_when_explicitly_opted_in(tmp_path):
    pages = [_FakePage(TARGET, {"token": "publisher-token"})]
    browser = _persistent(tmp_path, JAR, pages)

    browser.save_cookies({"cache_dir": str(tmp_path),
                          bl.LOCALSTORAGE_OPT_IN_KEY: True})

    state = json.loads((tmp_path / "browser_state.json").read_text(encoding="utf-8"))
    assert state["localStorage"]["https://www.sciencedirect.com"]["token"] == "publisher-token"


def test_localstorage_opt_in_still_excludes_other_origins(tmp_path):
    pages = [
        _FakePage(TARGET, {"token": "publisher-token"}),
        _FakePage("https://mail.example.com/", {"session": "unrelated"}),
    ]
    browser = _persistent(tmp_path, JAR, pages)

    browser.save_cookies({"cache_dir": str(tmp_path),
                          bl.LOCALSTORAGE_OPT_IN_KEY: True})

    state = json.loads((tmp_path / "browser_state.json").read_text(encoding="utf-8"))
    assert list(state["localStorage"]) == ["https://www.sciencedirect.com"]
    assert "unrelated" not in json.dumps(state)


def test_saved_cookies_scoped_to_target_domain(tmp_path):
    browser = _persistent(tmp_path, JAR, [_FakePage(TARGET, {})])

    browser.save_cookies({"cache_dir": str(tmp_path)})

    saved = json.loads((tmp_path / "instsci-cookies.json").read_text(encoding="utf-8"))
    assert {c["domain"] for c in saved} == {".sciencedirect.com"}
    assert all(set(c) == {"name", "value", "domain", "path"} for c in saved)
    assert "idp-token" not in json.dumps(saved)