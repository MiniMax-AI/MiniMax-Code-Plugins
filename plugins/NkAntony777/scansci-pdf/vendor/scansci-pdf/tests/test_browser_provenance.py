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
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: ())
    cache = tmp_path / "cache" / "browser"
    cache.mkdir(parents=True)
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: cache)
    binary = cache / "chrome.exe"
    binary.write_bytes(b"cached build")
    assert browser_provenance.verify_browser_executable(binary, {}) == Path(os.path.abspath(binary))


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