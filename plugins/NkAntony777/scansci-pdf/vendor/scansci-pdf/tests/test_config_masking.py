"""Config value masking: secrets and proxy credentials never leak via MCP."""

from __future__ import annotations

import pytest

from scansci_pdf import config as config_mod
from scansci_pdf.config import get_config_safe, mask_config_value


def test_mask_sensitive_key():
    assert mask_config_value("elsevier_api_key", "sk-secret-123") == "***"
    assert mask_config_value("zotero_api_key", "abc") == "***"
    assert mask_config_value("core_api_key", None) is None


def test_mask_proxy_url_hides_password():
    masked = mask_config_value("network_proxy", "http://user:secret@proxy.corp:8080")
    assert masked == "http://user:***@proxy.corp:8080"
    # socks5 with credentials too
    masked = mask_config_value("browser_static_proxy", "socks5://u:p@10.0.0.1:1080")
    assert masked == "socks5://u:***@10.0.0.1:1080"


def test_mask_leaves_plain_values_untouched():
    assert mask_config_value("email", "me@example.com") == "me@example.com"
    assert mask_config_value("scihub_enabled", True) is True
    # proxy without credentials stays as-is
    assert mask_config_value("network_proxy", "http://10.0.0.1:8080") == "http://10.0.0.1:8080"


def test_get_config_safe_masks_everything(monkeypatch):
    fake = {
        "elsevier_api_key": "sk-live",
        "network_proxy": "http://alice:hunter2@proxy.corp:8080",
        "email": "me@example.com",
        "batch_workers": 8,
    }
    monkeypatch.setattr(config_mod, "load_config", lambda: dict(fake))
    safe = get_config_safe()
    assert safe["elsevier_api_key"] == "***"
    assert safe["network_proxy"] == "http://alice:***@proxy.corp:8080"
    assert safe["email"] == "me@example.com"
    assert safe["batch_workers"] == 8


def test_proxy_pool_values_are_masked():
    pool = ["http://alice:hunter2@a.example:8080", "socks5://bob:hunter2@b.example:1080"]
    assert [mask_config_value("proxy_pool", p) for p in pool] == [
        "http://alice:***@a.example:8080",
        "socks5://bob:***@b.example:1080",
    ]


def test_empty_username_proxy_credential_is_masked():
    """An empty username is still a credential: the password must not survive."""
    assert mask_config_value("network_proxy", "http://:hunter2@host") == "http://:***@host"
    assert "hunter2" not in mask_config_value("network_proxy", "http://:hunter2@host")
    assert mask_config_value("proxy_pool", "socks5://:hunter2@host:1080") == "socks5://:***@host:1080"


def test_proxy_without_credentials_is_untouched():
    assert mask_config_value("network_proxy", "socks5://127.0.0.1:1080") == "socks5://127.0.0.1:1080"


def test_ipv6_and_percent_encoded_proxy_credentials():
    assert mask_config_value("network_proxy", "http://user:pass@[::1]:8080") == "http://user:***@[::1]:8080"
    assert mask_config_value("network_proxy", "http://user%40corp:p%40ss@host") == "http://user%40corp:***@host"


def test_shared_redaction_helper_is_used_by_diagnostics():
    """The diagnostics boundary must go through the shared helper, not its own regex."""
    from scansci_pdf.sources.scoring import redact_proxy_url

    # Empty username is the shape config masking alone does not cover; the
    # shared helper adds it so every boundary behaves the same way.
    assert redact_proxy_url("http://:hunter2@host") == "http://:***@host"
    assert "hunter2" not in redact_proxy_url("http://:hunter2@host")
    # ...and it delegates to the config masking path for the common shapes.
    assert redact_proxy_url("http://user:pass@host:8080") == mask_config_value("network_proxy", "http://user:pass@host:8080")
