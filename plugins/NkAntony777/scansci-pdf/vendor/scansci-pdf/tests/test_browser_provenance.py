"""Browser executables are code, not data: they must pass a provenance gate."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from scansci_pdf import browser_provenance
from scansci_pdf.security import SecurityError


@pytest.fixture
def allowlisted_root(tmp_path, monkeypatch):
    """Point the Windows allowlist at a temp tree so tests stay hermetic."""
    if os.name == "nt":
        roots = (str(tmp_path / "Google" / "Chrome"),)
    else:
        roots = (str(tmp_path / "chrome"),)
    root = Path(roots[0])
    (root / "Application").mkdir(parents=True)
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: roots)
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    return root / "Application"


def _binary(root: Path, name: str = "chrome.exe") -> Path:
    path = root / name
    path.write_bytes(b"#!/bin/sh\n# fake browser\n")
    return path


def test_allowlisted_browser_binary_is_accepted(allowlisted_root):
    path = _binary(allowlisted_root)
    assert browser_provenance.verify_browser_executable(path, {}) == Path(os.path.abspath(path))


def test_arbitrary_path_outside_allowlist_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: (str(tmp_path / "nope"),))
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    stray = tmp_path / "chrome.exe"
    stray.write_bytes(b"malicious")
    with pytest.raises(SecurityError, match="allowlisted"):
        browser_provenance.verify_browser_executable(stray, {})


def test_prefix_lookalike_directory_is_rejected(tmp_path, monkeypatch):
    """A sibling directory sharing the prefix must not inherit the trust."""
    roots = (str(tmp_path / "Google" / "Chrome"),)
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: roots)
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    evil = tmp_path / "Google" / "ChromeEvil"
    evil.mkdir(parents=True)
    binary = evil / "chrome.exe"
    binary.write_bytes(b"malicious")
    with pytest.raises(SecurityError, match="allowlisted"):
        browser_provenance.verify_browser_executable(binary, {})


def test_non_launcher_name_in_allowlisted_root_is_rejected(tmp_path, monkeypatch):
    roots = (str(tmp_path / "Google" / "Chrome"),)
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: roots)
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    root = Path(roots[0])
    root.mkdir(parents=True)
    binary = root / "notepad.exe"
    binary.write_bytes(b"whatever")
    with pytest.raises(SecurityError, match="allowlisted"):
        browser_provenance.verify_browser_executable(binary, {})


def test_symlinked_binary_is_rejected(allowlisted_root, monkeypatch):
    path = _binary(allowlisted_root)
    link = allowlisted_root / "chrome-link.exe"
    try:
        link.symlink_to(path)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is not permitted for this account")
    with pytest.raises(SecurityError, match="Symlink"):
        browser_provenance.verify_browser_executable(link, {})


def test_mismatched_pinned_digest_is_rejected(allowlisted_root):
    path = _binary(allowlisted_root)
    config = {"browser_binary_sha256": {"chrome.exe": "00" * 32}}
    with pytest.raises(SecurityError, match="digest"):
        browser_provenance.verify_browser_executable(path, config)


def test_matching_pinned_digest_is_accepted(allowlisted_root):
    path = _binary(allowlisted_root)
    config = {"browser_binary_sha256": {path.name: browser_provenance.file_digest(path)}}
    assert browser_provenance.verify_browser_executable(path, config) == Path(os.path.abspath(path))


def test_explicit_owner_opt_in_trusts_custom_path(tmp_path, monkeypatch):
    monkeypatch.setenv("SCANSCI_PDF_TRUST_BROWSER_PATH", "1")
    stray = tmp_path / "custom-browser.exe"
    stray.write_bytes(b"owner installed this deliberately")
    assert browser_provenance.verify_browser_executable(stray, {}) == Path(os.path.abspath(stray))


def test_missing_binary_is_rejected(tmp_path):
    with pytest.raises(SecurityError, match="not found"):
        browser_provenance.verify_browser_executable(tmp_path / "absent.exe", {})


def test_engine_cache_root_is_allowed(tmp_path, monkeypatch):
    """The cache is an accepted *location* — but only for a pinned binary."""
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: ())
    cache = tmp_path / "cache" / "browser"
    cache.mkdir(parents=True)
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: cache)
    binary = cache / "chrome.exe"
    binary.write_bytes(b"cached build")
    config = {"browser_binary_sha256": {"chrome.exe": browser_provenance.file_digest(binary)}}
    assert browser_provenance.verify_browser_executable(binary, config) == Path(os.path.abspath(binary))


def test_launch_paths_reject_unprovenanced_binary(tmp_path, monkeypatch):
    """The gate is wired into the launch helpers, not merely available."""
    from scansci_pdf import browser_backend

    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: (str(tmp_path / "nope"),))
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    stray = tmp_path / "evil.exe"
    stray.write_bytes(b"malicious")

    with pytest.raises(SecurityError):
        browser_backend.resolve_browser_binary({"browser_executable": str(stray)})
    with pytest.raises(SecurityError):
        browser_backend._patchright_browser_kwargs({"browser_executable": str(stray)})


# ---------------------------------------------------------------------------
# Round 2: the default launch paths are gated too.
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_chrome(tmp_path, monkeypatch):
    """An installed-looking Chrome outside every allowlist."""
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: (str(tmp_path / "nope"),))
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    install = tmp_path / "Chrome" / "Application"
    install.mkdir(parents=True)
    binary = install / "chrome.exe"
    binary.write_bytes(b"not the browser you installed")
    monkeypatch.setattr(browser_provenance, "_channel_candidates",
                        lambda channel: (str(binary),))
    return binary


def test_default_channel_path_refuses_unprovenanced_binary(fake_chrome):
    """channel="chrome" used to let patchright pick and launch any Chrome."""
    with pytest.raises(SecurityError, match="allowlisted"):
        browser_provenance.resolve_channel_executable("chrome", {})

    from scansci_pdf import browser_backend

    with pytest.raises(SecurityError, match="allowlisted"):
        browser_backend._patchright_browser_kwargs({})


def test_default_channel_path_uses_gate_verified_executable(allowlisted_root, monkeypatch):
    binary = _binary(allowlisted_root)
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    monkeypatch.setattr(browser_provenance, "_channel_candidates", lambda channel: (str(binary),))

    from scansci_pdf import browser_backend

    kwargs = browser_backend._patchright_browser_kwargs({})
    # Never a bare channel= ... that lookup happens inside Playwright, ungated.
    assert "channel" not in kwargs
    assert kwargs["executable_path"] == str(Path(os.path.abspath(binary)))


def test_channel_resolution_returns_none_when_not_installed(tmp_path, monkeypatch):
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: ())
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    monkeypatch.setattr(browser_provenance, "_channel_candidates",
                        lambda channel: (str(tmp_path / "absent" / "chrome.exe"),))

    from scansci_pdf import browser_backend

    assert browser_provenance.resolve_channel_executable("chrome", {}) is None
    assert browser_backend._patchright_browser_kwargs({}) is None


def test_bundled_chromium_fallback_is_gated(fake_chrome):
    """The ``{}`` retry reached Playwright's bundled Chromium ungated."""

    class _Chromium:
        executable_path = str(fake_chrome)

    class _FakeDriver:
        chromium = _Chromium()

    from scansci_pdf import browser_backend

    with pytest.raises(SecurityError, match="allowlisted"):
        browser_backend._bundled_chromium_kwargs(_FakeDriver(), {})


def test_bundled_chromium_fallback_passes_gate_when_allowlisted(allowlisted_root, monkeypatch):
    binary = _binary(allowlisted_root)
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)

    class _FakeDriver:
        chromium = type("C", (), {"executable_path": str(binary)})()

    from scansci_pdf import browser_backend

    kwargs = browser_backend._bundled_chromium_kwargs(_FakeDriver(), {})
    assert kwargs == {"executable_path": str(Path(os.path.abspath(binary)))}


def test_cloakbrowser_env_path_is_gated(tmp_path, monkeypatch):
    """CLOAKBROWSER_BINARY_PATH is still an input, not a grant."""
    from scansci_pdf import browser_backend

    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: (str(tmp_path / "nope"),))
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    stray = tmp_path / "cloak-chrome.exe"
    stray.write_bytes(b"someone else's binary")
    monkeypatch.setenv("CLOAKBROWSER_BINARY_PATH", str(stray))

    with pytest.raises(SecurityError, match="allowlisted"):
        browser_backend.resolve_browser_binary({"browser_auto_upgrade": True})


def test_cloakbrowser_env_path_is_accepted_when_provenanced(allowlisted_root, monkeypatch):
    from scansci_pdf import browser_backend

    binary = _binary(allowlisted_root)
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    monkeypatch.setenv("CLOAKBROWSER_BINARY_PATH", str(binary))

    assert browser_backend.resolve_browser_binary({}) == str(Path(os.path.abspath(binary)))


def test_trust_opt_in_does_not_disable_pinned_digest(allowlisted_root, monkeypatch):
    """The escape hatch widens *where*, never *which file*."""
    monkeypatch.setenv("SCANSCI_PDF_TRUST_BROWSER_PATH", "1")
    path = _binary(allowlisted_root)
    config = {"browser_binary_sha256": {"chrome.exe": "00" * 32}}

    with pytest.raises(SecurityError, match="digest"):
        browser_provenance.verify_browser_executable(path, config)

    good = {"browser_binary_sha256": {"chrome.exe": browser_provenance.file_digest(path)}}
    assert browser_provenance.verify_browser_executable(path, good) == Path(os.path.abspath(path))


def test_trust_opt_in_does_not_relax_cache_digest_requirement(tmp_path, monkeypatch):
    monkeypatch.setenv("SCANSCI_PDF_TRUST_BROWSER_PATH", "1")
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: ())
    cache = tmp_path / "cache" / "browser"
    cache.mkdir(parents=True)
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: cache)
    binary = cache / "chrome.exe"
    binary.write_bytes(b"swapped at runtime")

    with pytest.raises(SecurityError, match="digest"):
        browser_provenance.verify_browser_executable(binary, {})


def test_cache_root_binary_without_pinned_digest_is_rejected(tmp_path, monkeypatch):
    """A cache is writable at runtime, so a browser-named file there is weak."""
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: ())
    cache = tmp_path / "cache" / "browser"
    cache.mkdir(parents=True)
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: cache)
    binary = cache / "chrome.exe"
    binary.write_bytes(b"swapped at runtime")

    with pytest.raises(SecurityError, match="digest"):
        browser_provenance.verify_browser_executable(binary, {})
    assert browser_provenance.is_verified(binary, {}) is False


def test_cache_root_binary_with_pinned_digest_is_accepted(tmp_path, monkeypatch):
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: ())
    cache = tmp_path / "cache" / "browser"
    cache.mkdir(parents=True)
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: cache)
    binary = cache / "chrome.exe"
    binary.write_bytes(b"genuine cached build")
    config = {"browser_binary_sha256": {str(binary): browser_provenance.file_digest(binary)}}

    assert browser_provenance.verify_browser_executable(binary, config) == Path(os.path.abspath(binary))


def test_cache_root_binary_with_wrong_digest_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: ())
    cache = tmp_path / "cache" / "browser"
    cache.mkdir(parents=True)
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: cache)
    binary = cache / "chrome.exe"
    binary.write_bytes(b"swapped at runtime")
    config = {"browser_binary_sha256": {"chrome.exe": "11" * 32}}

    with pytest.raises(SecurityError, match="digest"):
        browser_provenance.verify_browser_executable(binary, config)


# ---------------------------------------------------------------------------
# Cookie scope: the login target's domain only.
# ---------------------------------------------------------------------------


def test_scoped_cookies_keeps_target_domain_only():
    from scansci_pdf import browser_cookies as bc

    jar = [
        {"name": "SD_session", "value": "t", "domain": ".sciencedirect.com", "path": "/"},
        {"name": "springer", "value": "t", "domain": ".springer.com", "path": "/"},
        {"name": "wiley", "value": "t", "domain": "onlinelibrary.wiley.com", "path": "/"},
        {"name": "shibsession", "value": "t", "domain": ".tsinghua.edu.cn", "path": "/"},
    ]
    kept = bc.scoped_cookies(jar, "https://www.sciencedirect.com/")
    assert {c["name"] for c in kept} == {"SD_session"}


def test_scoped_cookies_match_is_parent_domain_anchored():
    """A cookie domain covers the target host; the reverse is not a match."""
    from scansci_pdf import browser_cookies as bc

    jar = [
        {"name": "parent", "value": "t", "domain": ".sciencedirect.com", "path": "/"},
        {"name": "exact", "value": "t", "domain": "www.sciencedirect.com", "path": "/"},
        {"name": "child", "value": "t", "domain": "a.b.sciencedirect.com", "path": "/"},
        {"name": "lookalike", "value": "t", "domain": "evil-sciencedirect.com", "path": "/"},
        {"name": "other_publisher", "value": "t", "domain": ".springer.com", "path": "/"},
    ]
    kept = {c["name"] for c in bc.scoped_cookies(jar, "https://www.sciencedirect.com/")}
    assert kept == {"parent", "exact"}


def test_scoped_cookies_drops_everything_without_a_target_host():
    from scansci_pdf import browser_cookies as bc

    jar = [{"name": "SD_session", "value": "t", "domain": ".sciencedirect.com", "path": "/"}]
    assert bc.scoped_cookies(jar, "not-a-url") == []


def test_publisher_cookie_match_is_dot_anchored():
    from scansci_pdf import browser_cookies as bc

    assert bc._is_publisher_cookie({"domain": "evil-sciencedirect.com"}) is False
    assert bc._is_publisher_cookie({"domain": ".evil-sciencedirect.com"}) is False
    assert bc._is_publisher_cookie({"domain": "sciencedirect.com.attacker.test"}) is False
    assert bc._is_publisher_cookie({"domain": "sciencedirect.com"}) is True
    assert bc._is_publisher_cookie({"domain": ".link.springer.com"}) is True


# ---------------------------------------------------------------------------
# localStorage persistence is an owner-confirmed setting in strict mode.
# ---------------------------------------------------------------------------


def test_localstorage_opt_in_requires_owner_confirmation(monkeypatch):
    from scansci_pdf import server

    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(Path.cwd()))
    refused = server.scansci_pdf_config(key="browser_persist_localstorage",
                                        value="true", confirmed=False)
    assert "confirmation required" in refused

# ---------------------------------------------------------------------------
# Per-user browser installs must stay usable without becoming trustworthy.
# ---------------------------------------------------------------------------


def test_per_user_install_is_reachable_only_with_a_pinned_digest(tmp_path, monkeypatch):
    """A per-user Chrome is common on Windows; refusing it outright would be a
    functional regression, but it lives in a user-writable tree, so it has to
    carry a pinned digest rather than being trusted like a system install."""
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: ())
    monkeypatch.setattr(browser_provenance, "_per_user_roots", lambda: (str(tmp_path),))
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    binary = tmp_path / "Chrome" / "chrome.exe"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"per user build")

    # Reachable by location, but unprovenanced: refused.
    with pytest.raises(SecurityError, match="no pinned digest"):
        browser_provenance.verify_browser_executable(binary, {})

    # With the owner's digest it is accepted.
    pinned = {"browser_binary_sha256": {binary.name: browser_provenance.file_digest(binary)}}
    assert browser_provenance.verify_browser_executable(binary, pinned) == Path(os.path.abspath(binary))


def test_program_files_chrome_does_not_require_a_digest(tmp_path, monkeypatch):
    """A system install under Program Files is not a per-user writable root."""
    if os.name != "nt":
        assert browser_provenance._per_user_roots() == ()
        return
    root = tmp_path / "Program Files" / "Google" / "Chrome"
    binary = root / "Application" / "chrome.exe"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"system chrome")
    monkeypatch.setenv("PROGRAMFILES", str(tmp_path / "Program Files"))
    monkeypatch.setenv("PROGRAMFILES(X86)", str(tmp_path / "Program Files (x86)"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: (str(root),))
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)

    assert browser_provenance.verify_browser_executable(binary, {}) == Path(os.path.abspath(binary))
    roots = browser_provenance._per_user_roots()
    assert all("Program Files" not in root for root in roots)
    assert any(str(root).endswith(os.path.join("Local", "Google", "Chrome")) for root in roots)


def test_bundled_refusal_keeps_a_verified_local_browser(allowlisted_root, tmp_path, monkeypatch):
    """A rejected bundled Chromium must not discard Chrome that already passed."""
    local = _binary(allowlisted_root)
    stray = tmp_path / "ms-playwright" / "chrome.exe"
    stray.parent.mkdir()
    stray.write_bytes(b"unprovenanced bundle")
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    monkeypatch.setattr(browser_provenance, "_channel_candidates", lambda channel: (str(local),))

    class _FakeDriver:
        chromium = type("C", (), {"executable_path": str(stray)})()

    from scansci_pdf import browser_backend

    attempts = browser_backend._patchright_launch_attempts({}, _FakeDriver())
    assert attempts == [{"executable_path": str(Path(os.path.abspath(local)))}]


def test_per_user_install_digest_mismatch_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: ())
    monkeypatch.setattr(browser_provenance, "_per_user_roots", lambda: (str(tmp_path),))
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    binary = tmp_path / "chrome.exe"
    binary.write_bytes(b"per user build")
    pinned = {"browser_binary_sha256": {"chrome.exe": "00" * 32}}
    with pytest.raises(SecurityError, match="digest"):
        browser_provenance.verify_browser_executable(binary, pinned)
