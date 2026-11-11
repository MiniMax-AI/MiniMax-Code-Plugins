"""Elsevier API 下载链走显式代理的回归测试（网络请求全部 mock）。

背景（用户实测，2026-09）：权限探测（elsevier_check 双路由）认 network_proxy，
但快车道/API 下载器（sources/elsevier_api）忽略所有代理设置——用户挂了
校园网代理仍全员 403 NOT_ENTITLED。修复后整条链统一走
SCANSCI_PDF_PROXY / network_proxy（HTTP_PROXY/HTTPS_PROXY 项目级忽略）。
"""

import io
import os
import unittest
from unittest.mock import patch

import pytest
import requests

from scansci_pdf import elsevier_check as ec
from scansci_pdf.sources import elsevier_api as ea

CAMPUS_PROXY = "http://127.0.0.1:7890"


class _FakeResp:
    def __init__(self, status_code=403, text="", content=b""):
        self.status_code = status_code
        self.text = text
        self.content = content
        self.headers = {}


class _FakeSession:
    """记录 trust_env/proxies 配置的替身 Session。"""

    instances: list["_FakeSession"] = []

    def __init__(self):
        self.trust_env = True
        self.proxies: dict = {}
        self.headers: dict = {}
        self.calls: list[dict] = []
        _FakeSession.instances.append(self)

    def get(self, url, **kwargs):
        self.calls.append({"url": url, **kwargs})
        return _FakeResp(403)


class ResolveProxiesTests(unittest.TestCase):
    def test_none_without_any_setting(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(ea._resolve_proxies({}))
            self.assertIsNone(ea._resolve_proxies(None))

    def test_config_proxy(self):
        self.assertEqual(
            ea._resolve_proxies({"network_proxy": CAMPUS_PROXY}),
            {"http": CAMPUS_PROXY, "https": CAMPUS_PROXY},
        )

    def test_env_overrides_config(self):
        with patch.dict(os.environ, {"SCANSCI_PDF_PROXY": "socks5://127.0.0.1:1080"}):
            self.assertEqual(
                ea._resolve_proxies({"network_proxy": CAMPUS_PROXY}),
                {"http": "socks5://127.0.0.1:1080", "https": "socks5://127.0.0.1:1080"},
            )


class ApiRequestProxyTests(unittest.TestCase):
    def test_proxies_applied_to_session(self):
        _FakeSession.instances = []
        with patch.object(ea.requests, "Session", _FakeSession):
            resp = ea._api_request("https://api.elsevier.com/content/x", {},
                                   proxies={"http": CAMPUS_PROXY, "https": CAMPUS_PROXY})
        self.assertEqual(resp.status_code, 403)
        for s in _FakeSession.instances:
            self.assertEqual(s.proxies["http"], CAMPUS_PROXY)

    def test_direct_when_no_proxies(self):
        _FakeSession.instances = []
        with patch.object(ea.requests, "Session", _FakeSession):
            ea._api_request("https://api.elsevier.com/content/x", {})
        for s in _FakeSession.instances:
            self.assertEqual(s.proxies, {})


class FetchPdfProxyTests(unittest.TestCase):
    """fetch_pdf 全链（XML→attachment→direct fallback）都带同一代理。"""

    def test_chain_uses_config_proxy(self):
        _FakeSession.instances = []
        with patch.object(ea.requests, "Session", _FakeSession):
            out = ea.fetch_pdf("10.1016/j.aaa.2023.01.001", "KEY",
                               config={"network_proxy": CAMPUS_PROXY})
        self.assertIsNone(out)  # 403 全失败，但请求必须都走了代理
        self.assertGreaterEqual(len(_FakeSession.instances), 2)
        for s in _FakeSession.instances:
            self.assertEqual(s.proxies.get("http"), CAMPUS_PROXY)
            self.assertFalse(s.trust_env)

    def test_chain_uses_env_proxy_without_config(self):
        _FakeSession.instances = []
        with patch.dict(os.environ, {"SCANSCI_PDF_PROXY": CAMPUS_PROXY}), \
             patch.object(ea.requests, "Session", _FakeSession):
            ea.fetch_pdf("10.1016/j.aaa.2023.01.001", "KEY")
        for s in _FakeSession.instances:
            self.assertEqual(s.proxies.get("http"), CAMPUS_PROXY)

    def test_direct_without_any_proxy(self):
        _FakeSession.instances = []
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(ea.requests, "Session", _FakeSession):
                ea.fetch_pdf("10.1016/j.aaa.2023.01.001", "KEY", config={})
        for s in _FakeSession.instances:
            self.assertEqual(s.proxies, {})


class InstitutionalMirrorTests(unittest.TestCase):
    def test_fetch_pdf_applies_config_proxy(self):
        from scansci_pdf.institutional.sources import elsevier_api as inst

        _FakeSession.instances = []
        with patch.object(inst.requests, "Session", _FakeSession):
            inst.fetch_pdf("10.1016/j.aaa.2023.01.001", "KEY",
                           config={"network_proxy": CAMPUS_PROXY})
        self.assertTrue(_FakeSession.instances)
        for s in _FakeSession.instances:
            self.assertEqual(s.proxies.get("http"), CAMPUS_PROXY)


class ProbeEnvProxyTests(unittest.TestCase):
    """权限探测与下载器必须同一代理语义（env 优先），否则诊断与实际出口脱节。"""

    def test_probe_dual_route_uses_env_proxy(self):
        captured = []
        with patch.dict(os.environ, {"SCANSCI_PDF_PROXY": CAMPUS_PROXY}), \
             patch.object(ec.time, "sleep"):
            def _capture(doi, key, proxies, **kw):
                captured.append(proxies)
                return 200, ec.ENTITLED
            with patch.object(ec, "_head_probe", side_effect=_capture):
                ec.probe_dual_route("10.1016/j.aaa.2023.01.001", "K", {})
        self.assertEqual(captured[0], {"http": CAMPUS_PROXY, "https": CAMPUS_PROXY})
        self.assertIsNone(captured[1])  # direct 路由不带代理


if __name__ == "__main__":
    unittest.main()


# ---------------------------------------------------------------------------
# D64-11: Elsevier credentials must not follow a cross-origin redirect.
#
# The harness keeps the REAL requests Session redirect flow and only replays
# the wire at the lowest HTTPAdapter.send level, so 301/302/303/307/308, the
# method rewrite, the cookie handling and every hop's request preparation are
# requests' own code, not a stand-in.
# ---------------------------------------------------------------------------

API_URL = "https://api.elsevier.com/content/article/doi/10.1016/j.aaa.2023.01.001"
API_KEY = "SYNTHETIC-ELSEVIER-KEY"
INST_TOKEN = "SYNTHETIC-INST-TOKEN"

_REDIRECT_STATUSES = (302, 303, 307, 308)


class _ReplayAdapter(requests.adapters.HTTPAdapter):
    """Replays a scripted wire response and records each prepared request."""

    def __init__(self, script):
        super().__init__()
        self.script = script
        self.seen: list = []

    def send(self, request, **kwargs):
        self.seen.append(request)
        entry = self.script.get(request.url)
        if entry is None:
            entry = (200, {}, b"<ok/>")
        if isinstance(entry, Exception):
            raise entry
        status, headers, body = entry
        response = requests.models.Response()
        response.status_code = status
        response.reason = {302: "Found", 303: "See Other", 307: "Temporary Redirect",
                           308: "Permanent Redirect"}.get(status, "OK")
        response.headers.update(headers)
        response.url = request.url
        response.request = request
        response.raw = io.BytesIO(body)
        response.encoding = "utf-8"
        return response


def _headers_of(request):
    return {k.lower(): v for k, v in request.headers.items()}


def _install(monkeypatch, script):
    """Route the confined session's wire through the replay adapter."""
    adapter = _ReplayAdapter(script)
    original = ea.confined_session

    def _wrapped(url):
        session = original(url)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        return session

    monkeypatch.setattr(ea, "confined_session", _wrapped)
    return adapter


@pytest.fixture(autouse=True)
def _reset_confined_session_cache():
    ea._confined_session_class = None
    yield
    ea._confined_session_class = None


@pytest.mark.parametrize("status", _REDIRECT_STATUSES)
def test_cross_origin_redirect_never_receives_elsevier_credentials(status, monkeypatch):
    adapter = _install(monkeypatch, {
        API_URL: (status, {"location": "https://elsevier-secrets.attacker.test/collect"}, b""),
        "https://elsevier-secrets.attacker.test/collect": (200, {}, b"<html/>"),
    })

    response = ea._api_request(API_URL, {"X-ELS-APIKey": API_KEY, "X-ELS-InstToken": INST_TOKEN})

    assert response is not None and response.status_code == 200
    assert len(adapter.seen) == 2, "the redirect must still be followed"
    first, second = (_headers_of(r) for r in adapter.seen)
    # Positive: the legitimate Elsevier origin is fully authenticated.
    assert first["x-els-apikey"] == API_KEY
    assert first["x-els-insttoken"] == INST_TOKEN
    # The property under test: the unauthorized target gets NEITHER secret.
    assert "x-els-apikey" not in second
    assert "x-els-insttoken" not in second
    assert API_KEY not in str(second)
    assert INST_TOKEN not in str(second)


@pytest.mark.parametrize("location", [
    "https://api.elsevier.com:8443/content/other",      # same host, other port
    "http://api.elsevier.com/content/other",            # scheme downgrade
    "https://elsevier.com/content/other",               # different host
    "https://api.elsevier.com.attacker.test/content/x",  # lookalike host
])
def test_origin_comparison_is_scheme_host_and_port(location, monkeypatch):
    adapter = _install(monkeypatch, {
        API_URL: (302, {"location": location}, b""),
        location: (200, {}, b"<html/>"),
    })

    ea._api_request(API_URL, {"X-ELS-APIKey": API_KEY, "X-ELS-InstToken": INST_TOKEN})

    last = _headers_of(adapter.seen[-1])
    assert "x-els-apikey" not in last
    assert "x-els-insttoken" not in last


def test_same_origin_redirect_keeps_its_credentials(monkeypatch):
    """A redirect inside the API origin is a normal Elsevier hop and must not
    be stripped, or legitimate downloads would silently lose full-text access."""
    same_origin = "https://api.elsevier.com/content/object/eid/1-s2.0-main.pdf"
    adapter = _install(monkeypatch, {
        API_URL: (302, {"location": same_origin}, b""),
        same_origin: (200, {"content-type": "application/pdf"}, b"%PDF-1.7\n"),
    })

    response = ea._api_request(API_URL, {"X-ELS-APIKey": API_KEY, "X-ELS-InstToken": INST_TOKEN})

    assert response.status_code == 200
    assert len(adapter.seen) == 2
    for request in adapter.seen:
        headers = _headers_of(request)
        assert headers["x-els-apikey"] == API_KEY
        assert headers["x-els-insttoken"] == INST_TOKEN


def test_multi_hop_never_hands_the_token_to_a_later_host(monkeypatch):
    first_hop = "https://elsevier-secrets.attacker.test/collect"
    second_hop = "https://elsevier-secrets2.attacker.test/collect"
    adapter = _install(monkeypatch, {
        API_URL: (302, {"location": first_hop}, b""),
        first_hop: (307, {"location": second_hop}, b""),
        second_hop: (200, {}, b"<html/>"),
    })

    ea._api_request(API_URL, {"X-ELS-APIKey": API_KEY, "X-ELS-InstToken": INST_TOKEN})

    assert len(adapter.seen) == 3
    assert _headers_of(adapter.seen[0])["x-els-apikey"] == API_KEY
    for request in adapter.seen[1:]:
        headers = _headers_of(request)
        assert "x-els-apikey" not in headers
        assert "x-els-insttoken" not in headers


def test_ssl_retry_path_applies_the_same_policy(monkeypatch):
    """The retry session must not be the one that leaks."""
    adapter = _install(monkeypatch, {
        API_URL: (302, {"location": "https://elsevier-secrets.attacker.test/collect"}, b""),
        "https://elsevier-secrets.attacker.test/collect": (200, {}, b"<html/>"),
    })
    original_send = adapter.send
    state = {"raised": False}

    def _flaky_send(request, **kwargs):
        if request.url == API_URL and not state["raised"]:
            state["raised"] = True
            adapter.seen.append(request)
            raise requests.exceptions.SSLError("TLS handshake failed")
        return original_send(request, **kwargs)

    adapter.send = _flaky_send

    response = ea._api_request(API_URL, {"X-ELS-APIKey": API_KEY, "X-ELS-InstToken": INST_TOKEN})

    assert state["raised"], "the SSL retry path must actually have run"
    assert response.status_code == 200
    assert _headers_of(adapter.seen[-1]).get("x-els-apikey") is None
    assert _headers_of(adapter.seen[-1]).get("x-els-insttoken") is None


def test_authorization_header_is_confined_too(monkeypatch):
    adapter = _install(monkeypatch, {
        API_URL: (302, {"location": "https://elsevier-secrets.attacker.test/collect"}, b""),
        "https://elsevier-secrets.attacker.test/collect": (200, {}, b"<html/>"),
    })

    ea._api_request(API_URL, {"Authorization": "Bearer SYNTHETIC-BEARER"})

    assert _headers_of(adapter.seen[0])["authorization"] == "Bearer SYNTHETIC-BEARER"
    assert "authorization" not in _headers_of(adapter.seen[-1])


def test_legitimate_api_call_still_sends_the_key_and_proxy(monkeypatch):
    """A normal, same-origin, credentialed call keeps working end to end."""
    proxy = {"http": "http://campus:8080", "https": "http://campus:8080"}
    adapter = _install(monkeypatch, {API_URL: (200, {"content-type": "application/xml"},
                                              b"<full-text/>")})

    response = ea._api_request(API_URL, {"X-ELS-APIKey": API_KEY}, proxies=proxy)

    assert response.status_code == 200
    assert response.text == "<full-text/>"
    headers = _headers_of(adapter.seen[0])
    assert headers["x-els-apikey"] == API_KEY


def test_confined_session_keeps_the_strict_transport_checks(monkeypatch):
    """Confining credentials must not weaken the per-hop public/TLS policy."""
    import requests.sessions

    from scansci_pdf import security as sc

    monkeypatch.setattr(requests, "Session", sc.PublicSession)
    monkeypatch.setattr(requests.sessions, "Session", sc.PublicSession)
    ea._confined_session_class = None

    session = ea.confined_session(API_URL)

    assert isinstance(session, sc.PublicSession)
    assert isinstance(session.get_adapter("https://api.elsevier.com/"), sc.PublicHTTPSAdapter)
    with pytest.raises(sc.SecurityError):
        session.get("https://127.0.0.1/content")


def test_origin_of_normalises_scheme_host_and_default_port():
    assert ea.origin_of("https://API.Elsevier.com/content") == ("https", "api.elsevier.com", 443)
    assert ea.origin_of("https://api.elsevier.com:443/content") == ("https", "api.elsevier.com", 443)
    assert ea.origin_of("https://api.elsevier.com:8443/content") != ea.origin_of(API_URL)
    assert ea.origin_of("http://api.elsevier.com/content") != ea.origin_of(API_URL)