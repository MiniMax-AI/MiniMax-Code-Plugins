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
    # NOTE: ``user:pass@host`` was listed here and has been moved to the
    # redaction tests below. A schemeless ``user:pass@host`` IS a credential;
    # pinning it as "untouched" asserted that the password leaks.
    for text in ("", "me@example.com", "检测到系统代理", "no credentials here",
                 "127.0.0.1:1080", "bob@proxy.corp:3128"):
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


# ---------------------------------------------------------------------------
# Gap A: _build_failure_guidance tips reach the model and the CLI.
# ---------------------------------------------------------------------------

def _guidance_tips(config, monkeypatch):
    """Run the failure-tips builder with a clean proxy environment."""
    from scansci_pdf.sources import _build_failure_guidance

    for name in ("SCANSCI_PDF_PROXY", "HTTP_PROXY", "HTTPS_PROXY"):
        monkeypatch.delenv(name, raising=False)
    return _build_failure_guidance("10.1234/abcd", dict(config))


def test_failure_tips_mask_configured_proxy_password(monkeypatch):
    """A configured credentialed proxy must not reach the tips verbatim."""
    tips = _guidance_tips({"network_proxy": f"http://alice:{SECRET}@proxy.corp:8080"}, monkeypatch)

    blob = json.dumps(tips, ensure_ascii=False)
    assert SECRET not in blob
    assert "http://alice:***@proxy.corp:8080" in blob


def test_failure_tips_mask_env_proxy_password(monkeypatch):
    tips = _guidance_tips({"network_proxy": f"socks5://alice:{SECRET}@10.0.0.1:1080"}, monkeypatch)
    monkeypatch.setenv("SCANSCI_PDF_PROXY", f"socks5://dave:{SECRET}@10.0.0.1:1080")

    from scansci_pdf.sources import _build_failure_guidance

    blob = json.dumps(_build_failure_guidance("10.1234/abcd", {"network_proxy": ""}), ensure_ascii=False)
    assert SECRET not in blob
    assert "socks5://dave:***@10.0.0.1:1080" in blob
    assert SECRET not in json.dumps(tips, ensure_ascii=False)


def test_failure_tips_mask_system_proxy_branch(monkeypatch):
    """The HTTPS_PROXY branch must be redacted, including the config_set hint."""
    from scansci_pdf.sources import _build_failure_guidance

    for name in ("SCANSCI_PDF_PROXY", "HTTP_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HTTPS_PROXY", f"http://carol:{SECRET}@sysproxy.corp:3128")

    tips = _build_failure_guidance("10.1234/abcd", {})

    blob = json.dumps(tips, ensure_ascii=False)
    assert SECRET not in blob
    assert "http://carol:***@sysproxy.corp:3128" in blob
    # The hint must not be a copy-pasteable command carrying the password.
    hints = [t for t in tips if "config_set network_proxy" in t]
    assert hints
    assert all(SECRET not in hint for hint in hints)
    assert any("请自行填写" in hint for hint in hints)


def test_failure_tips_keep_copy_pasteable_hint_without_credentials(monkeypatch):
    """A credential-free system proxy stays copy-pasteable (usability guard)."""
    from scansci_pdf.sources import _build_failure_guidance

    for name in ("SCANSCI_PDF_PROXY", "HTTP_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HTTPS_PROXY", "socks5://127.0.0.1:1080")

    tips = _build_failure_guidance("10.1234/abcd", {})

    assert any('config_set network_proxy "socks5://127.0.0.1:1080"' in t for t in tips)


# ---------------------------------------------------------------------------
# Gap B: config display (`config-cmd --show`) and its setter echoes.
# ---------------------------------------------------------------------------

def test_config_cmd_show_masks_proxy_passwords(monkeypatch):
    """`config-cmd --show` must not echo network_proxy/browser_static_proxy raw."""
    from rich.console import Console
    from typer.testing import CliRunner

    from scansci_pdf import _cli_core

    fake_cfg = {
        "instsci_school": "Demo University",
        "network_proxy": f"http://alice:{SECRET}@proxy.corp:8080",
        "browser_static_proxy": f"socks5://bob:{SECRET}@static.corp:1080",
        "email": "me@example.com",
    }
    monkeypatch.setattr(_cli_core, "load_config", lambda: dict(fake_cfg))
    # Wide console so Rich does not wrap the proxy URLs across lines.
    monkeypatch.setattr(_cli_core, "console", Console(width=1000))

    result = CliRunner().invoke(_cli_core.app, ["config-cmd", "--show"])

    assert result.exit_code == 0, result.output
    out = result.output
    assert SECRET not in out
    assert "http://alice:***@proxy.corp:8080" in out
    assert "socks5://bob:***@static.corp:1080" in out


def test_config_cmd_setter_echoes_mask_proxy_passwords(monkeypatch):
    """Setting a proxy must not print the password back to the terminal."""
    from rich.console import Console
    from typer.testing import CliRunner

    from scansci_pdf import _cli_core

    saved: dict = {}

    def _fake_save(cfg):
        saved.update(cfg)

    monkeypatch.setattr(_cli_core, "load_config", lambda: {})
    monkeypatch.setattr(_cli_core, "save_config", _fake_save)
    monkeypatch.setattr(_cli_core, "console", Console(width=1000))

    runner = CliRunner()
    result = runner.invoke(
        _cli_core.app,
        ["config-cmd", "--static-proxy", f"socks5://bob:{SECRET}@static.corp:1080"],
    )
    assert result.exit_code == 0, result.output
    assert SECRET not in result.output
    assert "socks5://bob:***@static.corp:1080" in result.output

    result = runner.invoke(
        _cli_core.app,
        ["config-cmd", "--proxy-pool", f"http://alice:{SECRET}@a.example:8080"],
    )
    assert result.exit_code == 0, result.output
    assert SECRET not in result.output
    assert "http://alice:***@a.example:8080" in result.output


# ---------------------------------------------------------------------------
# Gap C: schemeless credentials are masked; non-credential forms are not.
# ---------------------------------------------------------------------------

def test_schemeless_proxy_credentials_are_masked():
    from scansci_pdf.config import mask_config_value

    assert redact_proxy_url("user:pass@host") == "user:***@host"
    assert mask_config_value("network_proxy", "user:pass@host") == "user:***@host"
    assert mask_config_value("browser_static_proxy", "user:pass@host") == "user:***@host"
    assert mask_config_value("network_proxy", f"alice:{SECRET}@proxy.corp:8080") == "alice:***@proxy.corp:8080"
    assert SECRET not in redact_proxy_url("user:pass@host")
    assert SECRET not in mask_config_value("network_proxy", "user:pass@host")


def test_non_credential_proxy_forms_are_untouched():
    """A bare host:port and a username-only proxy must survive untouched."""
    from scansci_pdf.config import mask_config_value

    for value in (
        "127.0.0.1:1080",
        "bob@proxy.corp:3128",
        "http://127.0.0.1:1080",
        "http://bob@proxy.corp:3128",
        "socks5://127.0.0.1:1080",
    ):
        assert redact_proxy_url(value) == value
        assert mask_config_value("network_proxy", value) == value

    # The username must be kept, not replaced.
    assert "bob@" in mask_config_value("network_proxy", "bob@proxy.corp:3128")
    assert "bob@" in mask_config_value("network_proxy", "http://bob@proxy.corp:3128")