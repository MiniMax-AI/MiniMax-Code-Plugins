"""Proxy credentials never reach diagnostics, recommendations or errors."""

from __future__ import annotations

import importlib.util
import json
import os
import socket
from pathlib import Path

import pytest

from scansci_pdf.sources import scoring
from scansci_pdf.sources.scoring import diagnose_network, redact_proxy_url

_spec = importlib.util.spec_from_file_location(
    "_secure_stage", Path(__file__).resolve().with_name("_secure_stage.py"))
_secure_stage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_secure_stage)

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

def test_setup_show_masks_proxy_password(monkeypatch, capsys):
    """`scansci-pdf setup --show` is a separate CLI path from config-cmd."""
    from scansci_pdf import config, main

    monkeypatch.setattr(config, "load_config", lambda: {
        "network_proxy": f"http://alice:{SECRET}@proxy.corp:8080",
        "vpnsci_school": "Demo",
    })
    main.setup_school(school="", show=True)
    out = capsys.readouterr().out
    assert SECRET not in out
    assert "http://alice:***@proxy.corp:8080" in out


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

    def _fake_save(cfg, **kwargs):
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

# ---------------------------------------------------------------------------
# D64-10: proxy credentials must not survive ANY egress boundary.
#
# The synthetic markers below appear only in a proxy URL, so a positive
# assertion on the masked form proves the redaction ran rather than proving
# the boundary was simply never reached.
# ---------------------------------------------------------------------------

# A percent-encoded password: the encoded form must not leak either.
ENCODED_SECRET = "p%40ssw0rd"
PLAIN_SECRET = "p@ssw0rd"
CREDENTIALED_PROXY = f"http://alice:{ENCODED_SECRET}@proxy.corp:8080"
MASKED_PROXY = "http://alice:***@proxy.corp:8080"


def _assert_no_credential(blob, note=""):
    for marker in (SECRET, ENCODED_SECRET, PLAIN_SECRET):
        assert marker not in blob, f"{note}: {marker!r} leaked"
    assert MASKED_PROXY in blob, f"{note}: expected the masked host to stay"


def test_web_error_response_redacts_nested_proxy_credentials(monkeypatch):
    """The download result is a tree; filtering a few known keys is not enough."""
    from fastapi.testclient import TestClient

    from scansci_pdf import web

    monkeypatch.setenv(web.TOKEN_ENV, "unit-test-token-value")
    monkeypatch.setattr(web, "_check_sources", lambda config: {})
    nested = {
        "success": False,
        "reason": f"ProxyError: tunnel through {CREDENTIALED_PROXY} failed",
        "source_failures": [
            {"source": "elsevier", "error_type": "proxy",
             "reason": {"chain": [f"urllib3 raised on {CREDENTIALED_PROXY}",
                                  {"deeper": f"alice:{PLAIN_SECRET}@proxy.corp:8080"}]}},
        ],
        "agent_hint": f"check {CREDENTIALED_PROXY}",
        "guidance": [f"config_set network_proxy \"{CREDENTIALED_PROXY}\""],
    }
    monkeypatch.setattr(web, "download", lambda identifier: nested)

    client = TestClient(web.app)
    response = client.post(
        "/api/download",
        json={"identifier": "10.1234/abcd"},
        headers={"X-ScanSci-Token": "unit-test-token-value",
                 "X-Requested-With": "XMLHttpRequest"},
    )

    assert response.status_code == 404
    body = response.text
    _assert_no_credential(body, "web error response")
    # The tree shape survives; only the secret is gone.
    payload = response.json()
    assert payload["source_failures"][0]["error_type"] == "proxy"
    assert payload["reason"].startswith("ProxyError")


def test_cli_failure_output_redacts_proxy_credentials(monkeypatch, capsys):
    """`scansci-pdf get` prints reason, per-source reasons and the agent hint."""
    from scansci_pdf import main, sources

    monkeypatch.setattr(sources, "download", lambda *a, **k: {
        "success": False,
        "reason": f"cannot reach publisher through {CREDENTIALED_PROXY}",
        "source_failures": [
            {"source": "springer", "error_type": "proxy",
             "reason": f"ProxyError via {CREDENTIALED_PROXY}"},
            {"source": "elsevier", "error_type": "http_403",
             "reason": {"nested": [f"retry with alice:{PLAIN_SECRET}@proxy.corp:8080"]}},
        ],
        "agent_hint": f"set network_proxy={CREDENTIALED_PROXY}",
    })

    main.get_paper(identifier="10.1234/abcd", output=".", no_bibtex=True,
                   strategy="", si=False, md=False)
    out = capsys.readouterr().out

    _assert_no_credential(out, "CLI failure output")


def test_child_process_argv_never_carries_proxy_credentials(monkeypatch, tmp_path):
    """Nothing a child process can be listed for may embed a password."""
    from scansci_pdf import browser_engine, progress_reporter
    from scansci_pdf.institutional import session_broker as broker

    config = {"browser_static_proxy": f"socks5://bob:{PLAIN_SECRET}@static.corp:1080"}

    args = browser_engine._build_browser_args(config)
    joined = " ".join(args)
    assert PLAIN_SECRET not in joined
    assert "--proxy-server=socks5://static.corp:1080" in joined

    # A legitimately authenticated proxy still authenticates: the credentials
    # travel in the in-memory Playwright proxy dict, not in argv.
    from scansci_pdf import browser_backend

    payload = browser_backend._proxy_from_config(config)
    assert payload["server"] == "socks5://static.corp:1080"
    assert payload["username"] == "bob"
    assert payload["password"] == PLAIN_SECRET

    captured: list = []

    class _Popen:
        def __init__(self, args, **kwargs):
            captured.append(list(args))

    monkeypatch.setattr("subprocess.Popen", _Popen)
    monkeypatch.delenv("SCANSCI_PROGRESS_BAR", raising=False)
    monkeypatch.delenv("SCANSCI_PROGRESS_BAR_CHILD", raising=False)
    monkeypatch.setenv("SCANSCI_PDF_DATA_DIR", str(tmp_path))
    progress_reporter.ensure_progress_bar({"network_proxy": CREDENTIALED_PROXY})
    assert captured and PLAIN_SECRET not in " ".join(captured[-1])

    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(tmp_path))
    monkeypatch.setenv("SCANSCI_PDF_SECURE_ENTRY",
                       str(Path(_secure_stage.ENGINE) / "run_secure.py"))
    monkeypatch.setattr(broker, "BROKER_ROOT", tmp_path / "brokers")
    broker.start_broker_process(publisher="Elsevier", browser_profile="p",
                                institution="Demo University", ttl_seconds=60,
                                cwd=tmp_path)
    assert captured, "the broker must still spawn"
    broker_argv = captured[-1]
    assert "session-broker-run" in broker_argv
    assert "--module" in broker_argv
    assert PLAIN_SECRET not in " ".join(broker_argv)


def test_elsevier_request_failure_log_is_redacted(monkeypatch, caplog):
    """An exception raised while egressing through a proxy embeds the URL."""
    from scansci_pdf.sources import elsevier_api as ea

    monkeypatch.setattr(ea, "confined_session", lambda url: (_ for _ in ()).throw(
        __import__("requests").exceptions.ProxyError(
            f"HTTP CONNECT tunnel failed for proxy {CREDENTIALED_PROXY}")))

    with caplog.at_level("WARNING"):
        assert ea._api_request("https://api.elsevier.com/content/x", {}) is None

    _assert_no_credential(caplog.text, "elsevier warning log")


def test_redact_proxy_structure_walks_every_container():
    from scansci_pdf.proxy_redaction import redact_proxy_structure

    payload = {
        "list": [f"via {CREDENTIALED_PROXY}", ("nested", f"{CREDENTIALED_PROXY}")],
        "set": {f"{CREDENTIALED_PROXY}"},
        "number": 7,
        "none": None,
    }
    cleaned = redact_proxy_structure(payload)

    # Free text keeps its surroundings; only the password goes.
    assert cleaned["list"][0] == f"via {MASKED_PROXY}"
    assert cleaned["list"][1] == ("nested", MASKED_PROXY)
    assert cleaned["set"] == {MASKED_PROXY}
    assert cleaned["number"] == 7 and cleaned["none"] is None
    assert isinstance(cleaned["list"][1], tuple)
    assert isinstance(cleaned["set"], set)
