"""LibGen lane: session warm-up (cookieless one-shot requests get empty 200s)
and CDN retry (booksdl 503s most requests)."""

from __future__ import annotations

from pathlib import Path

import pytest

import scansci_pdf.sources.libgen as lg

PAGE = ('<html><a href="get.php?md5=abc&key=K&doi=10.1/x">download</a></html>')


class _Resp:
    status_code = 200

    def __init__(self, text=""):
        self.text = text


class _FakeSession:
    calls: list = []

    def __init__(self):
        self.headers = {}
        self.proxies = {}

    def get(self, url, **kwargs):
        _FakeSession.calls.append((url, dict(self.headers), dict(kwargs.get("headers") or {})))
        if url.rstrip("/").endswith(("libgen.li", "libgen.bz")):
            return _Resp("<html>home</html>")
        return _Resp(PAGE)


@pytest.fixture(autouse=True)
def _fake_http(monkeypatch):
    _FakeSession.calls = []
    monkeypatch.setattr("requests.Session", _FakeSession)
    monkeypatch.setattr(lg, "polite_delay", lambda cfg: None)
    monkeypatch.setattr("time.sleep", lambda s: None)


def test_warms_session_and_sends_referer(tmp_path: Path, monkeypatch):
    """ads.php must be requested with the homepage Referer after warm-up."""
    monkeypatch.setattr(
        lg, "download_pdf",
        lambda url, out, cfg, src, **kw: {"success": True, "file": str(out)})

    r = lg.try_libgen("10.1/x", tmp_path / "o.pdf",
                      {"network_proxy": "http://127.0.0.1:7890"})
    assert r is not None and r["success"]

    urls = [c[0] for c in _FakeSession.calls]
    assert urls[0] == "https://libgen.li/"  # homepage warm-up first
    ads = next(c for c in _FakeSession.calls if "ads.php" in c[0])
    assert ads[2].get("Referer") == "https://libgen.li/"
    assert ads[1].get("User-Agent")  # browser-ish UA set


def test_download_retried_on_flaky_cdn(tmp_path: Path, monkeypatch):
    """The booksdl CDN 503s most attempts — download_pdf must be retried."""
    attempts = []

    def flaky(url, out, cfg, src, **kw):
        attempts.append(url)
        if len(attempts) < 3:
            return None  # 503-ish miss
        return {"success": True, "file": str(out)}

    monkeypatch.setattr(lg, "download_pdf", flaky)

    r = lg.try_libgen("10.1/x", tmp_path / "o.pdf", {})
    assert r is not None and r["success"]
    assert len(attempts) == 3


def test_download_gives_up_after_budget(tmp_path: Path, monkeypatch):
    attempts = []
    monkeypatch.setattr(
        lg, "download_pdf",
        lambda url, out, cfg, src, **kw: attempts.append(url) or None)

    r = lg.try_libgen("10.1/x", tmp_path / "o.pdf", {})
    assert r is None
    # 4 attempts per mirror (then the failover moves on) — bounded, not infinite
    assert len(attempts) >= 4


def test_timeout_floors_applied(tmp_path: Path, monkeypatch):
    seen = {}
    monkeypatch.setattr(
        lg, "download_pdf",
        lambda url, out, cfg, src, **kw: seen.update(cfg) or {"success": True})

    lg.try_libgen("10.1/x", tmp_path / "o.pdf",
                  {"connect_timeout": 3, "read_timeout": 7})
    assert seen["connect_timeout"] >= 10
    assert seen["read_timeout"] >= 30
    assert seen["download_deadline_seconds"] >= 180


if __name__ == "__main__":
    pytest.main([__file__])
