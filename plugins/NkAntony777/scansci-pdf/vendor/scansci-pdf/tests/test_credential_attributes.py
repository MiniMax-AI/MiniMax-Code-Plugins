"""Credential save/restore: security attributes, one scope policy, one bool parser.

D64-05 (attributes survive the round trip), D64-06 (every entry point shares
the scope policy) and D64-07 (a security toggle is never resolved by
truthiness) each get a positive regression: the restored cookie is *stronger*
than the bug allowed, not merely "the old bug no longer reproduces".
"""

from __future__ import annotations

import atexit
import json
import time
from pathlib import Path

import pytest

from scansci_pdf import browser_cookies as bc
from scansci_pdf import browser_login as bl

atexit.unregister(bl._browser.close)

TARGET = "https://www.sciencedirect.com/"
FUTURE = 9999999999


# ---------------------------------------------------------------------------
# D64-05: security and lifecycle attributes survive save + restore
# ---------------------------------------------------------------------------


def _synthetic_cookie(**overrides):
    cookie = {
        "name": "SD_session", "value": "pub-token", "domain": ".sciencedirect.com",
        "path": "/", "httpOnly": True, "secure": True, "sameSite": "Strict",
        "expires": FUTURE,
    }
    cookie.update(overrides)
    return cookie


class _RoundTripContext:
    """A context whose add_cookies() keeps exactly what the browser was given.

    Stands in for ``browser_context.add_cookies`` so the assertion is about
    what the production save path hands the browser, which is where the
    attribute loss happened.
    """

    def __init__(self, cookies=None, pages=None):
        self._cookies = list(cookies or [])
        self.pages = pages or []
        self.added = []

    def cookies(self):
        return list(self._cookies)

    def add_cookies(self, cookies):
        self.added.extend(cookies)


class _Page:
    def __init__(self, url="", items=None):
        self.url = url
        self._items = items or {}

    def evaluate(self, script):
        return dict(self._items)

    def goto(self, *args, **kwargs):
        raise AssertionError("localStorage must not be restored while the opt-in is off")


def _save(browser, config):
    browser.save_cookies(config)


def test_httponly_cookie_stays_httponly_through_save_and_restore(tmp_path):
    """The D64-05 regression, end to end through the production save path.

    An HttpOnly session used to come back as a plain page-script-readable
    cookie. It must come back HttpOnly, Secure, SameSite=Strict, with its
    original expiry intact.
    """
    context = _RoundTripContext([_synthetic_cookie()], [_Page(TARGET, {})])
    browser = bl.PersistentBrowser()
    browser._context = context
    config = {"cache_dir": str(tmp_path)}
    _save(browser, config)

    (restored,) = bc.credentials_for_target(
        json.loads((tmp_path / "browser_state.json").read_text(encoding="utf-8"))["cookies"],
        config, TARGET,
    )
    assert restored["httpOnly"] is True, "HttpOnly session became page-script-readable"
    assert restored["secure"] is True
    assert restored["sameSite"] == "Strict"
    assert restored["expires"] == FUTURE

    target = _RoundTripContext()
    browser._context = target
    browser._restore_state(config)
    (injected,) = target.added
    assert injected["httpOnly"] is True
    assert injected["secure"] is True


def test_session_cookie_keeps_session_semantics(tmp_path):
    """A session cookie must not gain a lifetime it never had.

    Playwright's sentinel is -1; persisting 0 makes the browser treat it as
    already expired and silently drop the session on restore.
    """
    (cookie,) = bc.security_cookies(
        [_synthetic_cookie(name="sid", expires=-1)], now=time.time()
    )
    assert cookie["expires"] == -1.0

    context = _RoundTripContext([_synthetic_cookie(name="sid", expires=-1)], [_Page(TARGET, {})])
    browser = bl.PersistentBrowser()
    browser._context = context
    _save(browser, {"cache_dir": str(tmp_path)})
    saved = json.loads((tmp_path / "instsci-cookies.json").read_text(encoding="utf-8"))
    assert saved[0]["expires"] == -1.0


def test_expired_cookie_is_not_restored(tmp_path):
    """A dead credential is dropped instead of being re-injected."""
    expired = _synthetic_cookie(name="dead", expires=int(time.time()) - 60)
    assert bc.security_cookies([expired]) == []
    assert bc.credentials_for_target([expired], {"cache_dir": str(tmp_path)}, TARGET) == []


def test_prefixed_cookies_stay_valid_or_are_dropped(tmp_path):
    """__Secure-/__Host- records are not restored as weaker cookies."""
    kept = bc.security_cookies([
        _synthetic_cookie(name="__Secure-a", secure=True),
        _synthetic_cookie(name="__Host-b", secure=True, path="/"),
    ])
    assert len(kept) == 2

    # A stripped record would violate the prefix requirements, which Chrome
    # rejects outright; it must not be restored.
    assert bc.credentials_for_target([
        {"name": "__Secure-a", "value": "t", "domain": ".sciencedirect.com",
         "path": "/", "secure": False, "httpOnly": False, "expires": FUTURE},
        {"name": "__Host-b", "value": "t", "domain": ".sciencedirect.com",
         "path": "/x", "secure": True, "httpOnly": False, "expires": FUTURE},
    ], {}, TARGET) == []


def test_netscape_export_round_trip_keeps_httponly():
    """Netscape is a real consumer of the persisted fields.

    Without the #HttpOnly_ prefix an export/import round trip strips the flag
    and hands a script-readable session back to the browser.
    """
    from scansci_pdf.browser_engine import _parse_netscape_cookies

    text = bc.cookies_to_netscape(bc.security_cookies([_synthetic_cookie()]))
    assert "#HttpOnly_" in text
    (parsed,) = _parse_netscape_cookies(text)
    assert parsed["httpOnly"] is True
    assert parsed["secure"] is True
    assert parsed["expires"] == FUTURE


def test_legacy_four_field_file_cannot_resurrect_lost_flags():
    """Compat policy: a legacy file is dropped on browser restore.

    The HttpOnly/Secure/SameSite state of the original cookie was never
    written, so it cannot be inferred — restoring it would silently invent a
    weaker cookie. Re-login once and the new file carries real attributes.
    """
    legacy = [{"name": "SD_session", "value": "pub-token",
               "domain": ".sciencedirect.com", "path": "/"}]
    assert bc.is_legacy_cookie_record(legacy[0]) is True
    assert bc.credentials_for_target(legacy, {}, TARGET) == []


# ---------------------------------------------------------------------------
# D64-06: one scope policy across every save/restore entry point
# ---------------------------------------------------------------------------


MIXED_JAR = [
    _synthetic_cookie(),
    {"name": "springer", "value": "other-publisher", "domain": ".springer.com",
     "path": "/", "httpOnly": True, "secure": True, "expires": FUTURE},
    {"name": "shibsession", "value": "idp-token", "domain": ".tsinghua.edu.cn",
     "path": "/", "httpOnly": True, "secure": True, "expires": FUTURE},
    {"name": "CAS", "value": "cas-token", "domain": "idp.campus.example.edu",
     "path": "/", "httpOnly": True, "secure": True, "expires": FUTURE},
]


def test_passing_through_an_idp_persists_only_the_authorized_target():
    """Logging in via SSO must not leave the IdP's session on disk."""
    context = _RoundTripContext(MIXED_JAR, [_Page(TARGET, {}), _Page("https://idp.campus.example.edu/login", {"sso": "x"})])
    browser = bl.PersistentBrowser()
    browser._context = context
    _save(browser, {"cache_dir": str(tmp_path := Path(pytest.importorskip("tempfile").mkdtemp()))})

    on_disk = json.dumps(json.loads((tmp_path / "browser_state.json").read_text(encoding="utf-8")))
    for leaked in ("idp-token", "cas-token", "other-publisher"):
        assert leaked not in on_disk


def test_cache_cannot_self_declare_its_own_restore_target(tmp_path):
    """The authorized target comes from config, never from the cache file.

    A rewritten browser_state.json naming an attacker origin must not get that
    origin's cookies injected into a new context.
    """
    (tmp_path / "browser_state.json").write_text(json.dumps({
        "target_url": "https://attacker.example/",
        "cookies": [_synthetic_cookie(  # legitimate publisher cookie
        ), _synthetic_cookie(name="evil", domain=".attacker.example")],
        "localStorage": {},
    }), encoding="utf-8")

    context = _RoundTripContext()
    browser = bl.PersistentBrowser()
    browser._context = context
    browser._page = _Page()
    browser._restore_state({"cache_dir": str(tmp_path),
                            "browser_login_target_url": TARGET})
    assert context.added == [], "state for a foreign target was restored"


def test_restore_without_an_authorized_target_injects_nothing(tmp_path):
    """No authorization, no injection — even for a matching cookie."""
    (tmp_path / "browser_state.json").write_text(json.dumps({
        "target_url": TARGET, "cookies": [_synthetic_cookie()], "localStorage": {},
    }), encoding="utf-8")

    context = _RoundTripContext()
    browser = bl.PersistentBrowser()
    browser._context = context
    browser._page = _Page()
    browser._restore_state({"cache_dir": str(tmp_path),
                            "browser_login_target_url": "https://link.springer.com/"})
    assert context.added == []


def test_publisher_b_does_not_receive_publisher_a_cookies(tmp_path):
    """One publisher's login never populates another publisher's context."""
    from scansci_pdf import _publisher_strategies_core as core

    config = {"cache_dir": str(tmp_path)}
    bc.merge_cookies(MIXED_JAR, config, target_urls=[TARGET, "https://link.springer.com/"])

    springer = _RoundTripContext()
    core._restore_cookies_to_context(springer, config, "springer")
    assert {c["name"] for c in springer.added} == {"springer"}
    assert all(c["name"] != "SD_session" for c in springer.added), \
        "publisher A's session leaked into publisher B's context"

    elsevier = _RoundTripContext()
    core._restore_cookies_to_context(elsevier, config, "elsevier")
    assert [c["name"] for c in elsevier.added] == ["SD_session"]
    assert elsevier.added[0]["httpOnly"] is True


def test_institutional_target_scope_still_allows_webvpn_and_ezproxy(tmp_path):
    """Scope must not break the flows that legitimately span origins.

    WebVPN/EZProxy proxy the publisher under the proxy hostname, which is the
    authorized target for those logins.
    """
    jar = [
        {"name": "vpn", "value": "ticket", "domain": ".webvpn.campus.edu.cn",
         "path": "/", "httpOnly": True, "secure": True, "expires": FUTURE},
        {"name": "ezproxy", "value": "proxy", "domain": ".login.ezproxy.edu.cn",
         "path": "/", "httpOnly": True, "secure": True, "expires": FUTURE},
        {"name": "shibsession", "value": "idp", "domain": ".tsinghua.edu.cn",
         "path": "/", "httpOnly": True, "secure": True, "expires": FUTURE},
    ]
    kept = bc.credentials_for_target(jar, {}, "https://webvpn.campus.edu.cn/remote/login")
    assert [c["name"] for c in kept] == ["vpn"]
    assert kept[0]["httpOnly"] is True

    kept = bc.credentials_for_target(jar, {}, "https://login.ezproxy.edu.cn/login")
    assert [c["name"] for c in kept] == ["ezproxy"]


def test_cookie_store_save_and_restore_both_apply_the_scope(tmp_path):
    """CookieStore is the WebVPN/EZProxy/CARSI entry point: scoped both ways."""
    from scansci_pdf.session_store import CookieStore

    store = CookieStore(tmp_path / "gw.json")
    saved = store.save(MIXED_JAR, target_url="https://webvpn.campus.edu.cn/remote/login")
    assert saved == [], "an IdP/publisher-B session was persisted by the gateway store"

    store.save(
        [{"name": "vpn", "value": "ticket", "domain": ".webvpn.campus.edu.cn",
          "path": "/", "httpOnly": True, "secure": True, "expires": FUTURE}],
        target_url="https://webvpn.campus.edu.cn/remote/login",
    )
    assert [c["name"] for c in store.load(target_url="https://webvpn.campus.edu.cn/")] == ["vpn"]
    assert store.load(target_url="https://other.example.edu/") == []
    assert store.load() == []


def test_publisher_batch_handoff_is_scoped_to_its_own_login_url(tmp_path):
    """The batch hand-off cache is a credential file too."""
    from scansci_pdf.publisher_batch import PublisherBatchDownloader

    downloader = PublisherBatchDownloader.__new__(PublisherBatchDownloader)
    downloader._context_proxy = {}
    downloader._get_login_url = lambda: "https://www.sciencedirect.com/"

    source = _RoundTripContext(MIXED_JAR)
    downloader._export_handoff_cookies(source)
    assert {c["name"] for c in downloader._handoff_cookies} == {"SD_session"}

    target = _RoundTripContext()
    downloader._apply_handoff_cookies(target)
    assert [c["name"] for c in target.added] == ["SD_session"]
    assert target.added[0]["httpOnly"] is True


def test_merge_preserves_attributes_and_never_persists_idp_sessions(tmp_path):
    """The Elsevier-API merge path shares the allowlist.

    Multiple publisher domains may be merged only when the caller authorizes
    those targets explicitly; incidental IdP and campus sessions are excluded.
    """
    config = {"cache_dir": str(tmp_path)}
    merged = bc.merge_cookies(MIXED_JAR, config, target_urls=[TARGET, "https://link.springer.com/"])
    names = {c["name"] for c in merged}
    assert {"SD_session", "springer"} <= names
    assert "shibsession" not in names
    assert "CAS" not in names

    sd = next(c for c in merged if c["name"] == "SD_session")
    assert sd["httpOnly"] is True
    assert sd["secure"] is True
    assert sd["expires"] == FUTURE

    on_disk = json.dumps(json.loads((tmp_path / "publisher_cookies.json").read_text(encoding="utf-8")))
    assert "idp-token" not in on_disk and "cas-token" not in on_disk


def test_merge_with_an_explicit_target_scope_drops_sibling_publishers(tmp_path):
    """Passing an authorized target narrows the merge to that origin."""
    merged = bc.merge_cookies(MIXED_JAR, {"cache_dir": str(tmp_path)}, TARGET)
    assert [c["name"] for c in merged] == ["SD_session"]


# ---------------------------------------------------------------------------
# D64-07: the localStorage toggle is a declared bool with one parser
# ---------------------------------------------------------------------------


def test_default_config_declares_the_toggle_as_a_bool():
    from scansci_pdf.config import DEFAULT_CONFIG

    assert isinstance(DEFAULT_CONFIG["browser_persist_localstorage"], bool)
    assert DEFAULT_CONFIG["browser_persist_localstorage"] is False


@pytest.mark.parametrize("value,expected", [
    (True, True),
    (False, False),
    ("true", True),
    ("false", False),
    ("False", False),
    ("  false  ", False),
    (" TRUE ", True),
    ("yes", True), ("no", False),
    ("1", True), ("0", False),
])
def test_bool_parser_is_strict_about_literals(value, expected):
    from scansci_pdf.config import parse_config_bool

    assert parse_config_bool(value) is expected


@pytest.mark.parametrize("value", [1, 0, 2, [], {}, None, "maybe", "enabled", "truthy"])
def test_unknown_types_and_values_fail_closed(value):
    """A security toggle defaults OFF for anything that is not a boolean."""
    from scansci_pdf.config import config_bool

    assert config_bool("browser_persist_localstorage", value) is False


def test_legacy_string_false_in_config_file_does_not_enable_localstorage(tmp_path, monkeypatch):
    """A config.json written before the type was declared must migrate OFF.

    That file stores the toggle as the STRING "false"; a truthiness read made
    the string mean ON.
    """
    from scansci_pdf import config as cfg

    cache_dir = tmp_path / "cache"
    monkeypatch.setattr(cfg, "DATA_DIR", tmp_path)
    monkeypatch.setattr(cfg, "CONFIG_FILE", tmp_path / "config.json")
    (tmp_path / "config.json").write_text(
        json.dumps({"browser_persist_localstorage": "false",
                    "cache_dir": str(cache_dir)}), encoding="utf-8"
    )

    loaded = cfg.load_config()
    assert loaded["browser_persist_localstorage"] is False
    assert bl.localstorage_opt_in(loaded["browser_persist_localstorage"]) is False

    context = _RoundTripContext(
        [_synthetic_cookie()],
        [_Page(TARGET, {"token": "publisher-bearer-token"})],
    )
    browser = bl.PersistentBrowser()
    browser._context = context
    browser.save_cookies(loaded)
    assert "publisher-bearer-token" not in (cache_dir / "browser_state.json").read_text(encoding="utf-8")


def test_real_config_tool_round_trip_is_bool_on_disk(tmp_path, monkeypatch):
    """Set through the real config tool, reloaded from disk as a real bool."""
    from scansci_pdf import config as cfg

    monkeypatch.setattr(cfg, "DATA_DIR", tmp_path)
    monkeypatch.setattr(cfg, "CONFIG_FILE", tmp_path / "config.json")

    cfg.update_config("browser_persist_localstorage", "true")
    stored = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert stored["browser_persist_localstorage"] is True
    assert cfg.load_config()["browser_persist_localstorage"] is True

    cfg.update_config("browser_persist_localstorage", "false")
    stored = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert stored["browser_persist_localstorage"] is False
    assert cfg.load_config()["browser_persist_localstorage"] is False
    assert bl.localstorage_opt_in(cfg.load_config()["browser_persist_localstorage"]) is False


def test_false_keeps_localstorage_off_for_both_save_and_restore(tmp_path):
    """Opt-in off: no localStorage token on disk and none in a new context."""
    config = {"cache_dir": str(tmp_path), bl.LOCALSTORAGE_OPT_IN_KEY: False}
    context = _RoundTripContext(
        [_synthetic_cookie()],
        [_Page(TARGET, {"token": "publisher-bearer-token"}),
         _Page("https://idp.campus.example.edu/login", {"sso": "idp-token"})],
    )
    browser = bl.PersistentBrowser()
    browser._context = context
    browser.save_cookies(config)

    state = json.loads((tmp_path / "browser_state.json").read_text(encoding="utf-8"))
    assert state["localStorage"] == {}

    restored = _RoundTripContext()
    browser._context = restored
    browser._page = _Page()
    browser._restore_state(config)
    assert "publisher-bearer-token" not in json.dumps(state)


def test_true_opt_in_saves_only_the_authorized_origin(tmp_path):
    """Opt-in on still does not authorize a foreign origin's storage."""
    config = {"cache_dir": str(tmp_path), bl.LOCALSTORAGE_OPT_IN_KEY: True,
              "browser_login_target_url": TARGET}
    context = _RoundTripContext(
        [_synthetic_cookie()],
        [_Page(TARGET, {"token": "publisher-bearer-token"}),
         _Page("https://idp.campus.example.edu/login", {"sso": "idp-token"})],
    )
    browser = bl.PersistentBrowser()
    browser._context = context
    browser.save_cookies(config)

    state = json.loads((tmp_path / "browser_state.json").read_text(encoding="utf-8"))
    assert list(state["localStorage"]) == ["https://www.sciencedirect.com"]
    assert "idp-token" not in json.dumps(state)


def test_opt_in_off_ignores_localstorage_already_in_a_legacy_file(tmp_path):
    """A state file written while the toggle was on is not honoured after off."""
    config = {"cache_dir": str(tmp_path), bl.LOCALSTORAGE_OPT_IN_KEY: False,
              "browser_login_target_url": TARGET}
    (tmp_path / "browser_state.json").write_text(json.dumps({
        "target_url": TARGET,
        "cookies": [_synthetic_cookie()],
        "localStorage": {"https://www.sciencedirect.com": {"token": "stale-bearer"}},
    }), encoding="utf-8")

    browser = bl.PersistentBrowser()
    browser._context = _RoundTripContext()
    browser._page = _Page()  # goto() raises: restore must not touch localStorage
    browser._restore_state(config)
    assert browser._context.added, "the authorized target cookie should still restore"
