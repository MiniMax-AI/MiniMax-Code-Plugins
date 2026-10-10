"""Proxy credentials never reach diagnostics, recommendations or errors."""

from __future__ import annotations

import json
import socket

import pytest

from scansci_pdf.sources import scoring
from scansci_pdf.sources.scoring import diagnose_network, redact_proxy_url

SECRET = "hunter2"


@pytest.mark.parametrize("raw,expected", [
    # plain user:password
    ("http://user:pass@host:8080", "http://user:***@host:8080"),
    ("socks5://alice:hunter2@10.0.0.1:1080", "socks5://alice:***@10.0.0.1:1080"),
    # empty username
    ("http://:hunter2@host", "http://:***@host"),
    # IPv6 literal host
    ("http://user:hunter2@[::1]:8080", "http://user:***@[::1]:8080"),
    # percent-encoded credentials
    ("http://user%40corp:hunter2@host", "http://user%40corp:***@host"),
    # no credentials at all: nothing to redact, must stay usable
    ("http://10.0.0.1:8080", "http://10.0.0.1:8080"),
    ("socks5://127.0.0.1:1080", "socks5://127.0.0.1:1080"),
])
def test_redact_proxy_url_shapes(raw, expected):
    assert redact_proxy_url(raw) == expected
    assert "hunter2" not in redact_proxy_url(raw)


def test_redact_proxy_url_on_free_text():
    text = f"ProxyError: cannot reach http://user:{SECRET}@proxy.corp:8080 through tunnel"
    masked = redact_proxy_url(text)
    assert SECRET not in masked
    assert "http://user:***@proxy.corp:8080" in masked


def test_redact_proxy_url_leaves_non_proxy_text_untouched():
    for text in ("", "me@example.com", "user:pass@host", "检测到系统代理", "no credentials here"):
        assert redact_proxy_url(text) == text


def test_diagnose_network_report_masks_env_proxy(monkeypatch):
    monkeypatch.setenv("SCANSCI_PDF_PROXY", f"http://user:{SECRET}@proxy.corp:8080")
    monkeypatch.delenv("HTTP_PROXY", raising=False)
    monkeypatch.delenv("HTTPS_PROXY", raising=False)

    report = diagnose_network({})

    assert report["proxy"]["url"] == "http://user:***@proxy.corp:8080"
    assert report["proxy"]["configured"] is True
    assert SECRET not in json.dumps(report, ensure_ascii=False)


def test_diagnose_network_report_masks_config_proxy(monkeypatch):
    for name in ("SCANSCI_PDF_PROXY", "HTTP_PROXY", "HTTPS_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(socket, "gethostbyname", lambda *_a, **_k: "203.0.113.1")
    monkeypatch.setattr(socket, "create_connection", _ok_connection)

    report = diagnose_network({"network_proxy": f"socks5://bob:{SECRET}@10.0.0.1:1080"})

    assert report["proxy"]["url"] == "socks5://bob:***@10.0.0.1:1080"
    assert report["proxy"]["source"] == "config"
    assert SECRET not in json.dumps(report, ensure_ascii=False)


def test_diagnose_network_ignores_credentialed_system_proxy(monkeypatch):
    """A system proxy scansci-pdf does not use is still redacted in advice."""
    for name in ("SCANSCI_PDF_PROXY", "HTTP_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HTTPS_PROXY", f"http://carol:{SECRET}@sysproxy.corp:3128")
    monkeypatch.setattr(socket, "gethostbyname", lambda *_a, **_k: "203.0.113.1")
    monkeypatch.setattr(socket, "create_connection", _ok_connection)

    report = diagnose_network({})

    blob = json.dumps(report, ensure_ascii=False)
    assert SECRET not in blob
    assert "http://carol:***@sysproxy.corp:3128" in blob


def test_diagnose_network_error_path_does_not_leak_proxy(monkeypatch):
    """A raised exception embedding the proxy URL must be redacted too."""
    for name in ("SCANSCI_PDF_PROXY", "HTTP_PROXY", "HTTPS_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(socket, "gethostbyname", lambda *_a, **_k: "203.0.113.1")
    monkeypatch.setattr(socket, "create_connection", _ok_connection)

    proxy = f"http://dave:{SECRET}@proxy.corp:8080"
    monkeypatch.setenv("SCANSCI_PDF_PROXY", proxy)

    def _boom(*_args, **_kwargs):
        raise RuntimeError(f"ProxyError: unable to connect through {proxy}")

    monkeypatch.setitem(__import__("sys").modules, "requests", _FakeRequests(_boom))

    report = diagnose_network({})

    blob = json.dumps(report, ensure_ascii=False)
    assert SECRET not in blob
    assert proxy not in blob
    errors = [t for t in report["tests"] if t.get("target") == "Sci-Hub via proxy"]
    assert errors and errors[0]["error"].startswith("ProxyError")
    advice = [r for r in report["recommendations"] if "代理访问 Sci-Hub 失败" in r]
    assert advice and "http://dave:***@proxy.corp:8080" in advice[0]
    assert SECRET not in advice[0]


def test_redact_proxy_url_matches_config_masking_shape():
    """The helper must agree with the config masking path it delegates to."""
    from scansci_pdf.config import mask_config_value

    raw = "http://user:pass@host:8080"
    assert redact_proxy_url(raw) == mask_config_value("network_proxy", raw)
    assert scoring.redact_proxy_url is redact_proxy_url


class _FakeRequests:
    def __init__(self, get_impl):
        self.get = get_impl


class _FakeSocket:
    def close(self):
        pass


def _ok_connection(*_args, **_kwargs):
    return _FakeSocket()