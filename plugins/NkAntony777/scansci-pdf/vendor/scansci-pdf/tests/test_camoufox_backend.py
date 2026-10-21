"""Camoufox backend: selection, args dropped, and the real program is gated.

The security-relevant property under test: the executable handed to
``NewBrowser`` is the one that passed the provenance gate, on *both* the
normal and the persistent path, and a tampered or unapproved program inside an
existing install directory is refused before any process starts.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

import scansci_pdf.browser_backend as bb
from scansci_pdf import browser_provenance
from scansci_pdf.security import SecurityError


@pytest.fixture
def _all_backends(monkeypatch):
    """All three backend packages importable."""
    monkeypatch.setattr(bb, "is_available", lambda name=None: True)


def _install_stub_camoufox(monkeypatch, install_dir: Path, calls: list) -> None:
    """Register a minimal ``camoufox``/``playwright`` pair in sys.modules.

    The real distributions are optional extras, and a test that cannot run
    hermetically is a test nobody runs. Nothing here launches a browser: the
    stubs only record what the launcher was asked to do.
    """
    camoufox = types.ModuleType("camoufox")

    def new_browser(pw, **kwargs):
        calls.append(kwargs)
        return types.SimpleNamespace(version="152.0", close=lambda: None,
                                     new_context=lambda: None)

    camoufox.NewBrowser = new_browser
    camoufox.DefaultAddons = types.SimpleNamespace(UBO="ubo")
    pkgman = types.ModuleType("camoufox.pkgman")
    pkgman.INSTALL_DIR = str(install_dir)
    camoufox.pkgman = pkgman

    playwright = types.ModuleType("playwright")
    sync_api = types.ModuleType("playwright.sync_api")
    sync_api.sync_playwright = lambda: types.SimpleNamespace(
        start=lambda: types.SimpleNamespace(stop=lambda: None))
    playwright.sync_api = sync_api

    monkeypatch.setitem(sys.modules, "camoufox", camoufox)
    monkeypatch.setitem(sys.modules, "camoufox.pkgman", pkgman)
    monkeypatch.setitem(sys.modules, "playwright", playwright)
    monkeypatch.setitem(sys.modules, "playwright.sync_api", sync_api)
    monkeypatch.setattr(browser_provenance, "_camoufox_root", lambda: install_dir)


@pytest.fixture
def camoufox_install(tmp_path, monkeypatch):
    """An installed Camoufox whose program carries the owner's pinned digest."""
    calls: list = []
    root = tmp_path / "camoufox-downloads"
    root.mkdir()
    program = root / ("camoufox.exe" if sys.platform == "win32" else "camoufox")
    program.write_bytes(b"# camoufox build bytes\n")
    _install_stub_camoufox(monkeypatch, root, calls)
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: ())
    monkeypatch.setattr(browser_provenance, "_cache_root", lambda: None)
    digest = browser_provenance.file_digest(program)
    return types.SimpleNamespace(
        root=root, program=program, calls=calls,
        config={"browser_binary_sha256": {str(program): digest}},
        wrong={"browser_binary_sha256": {str(program): "ab" * 32}},
        digest=digest,
    )


class TestResolveBackend:
    def test_explicit_camoufox_config_wins(self, monkeypatch):
        monkeypatch.setattr(bb, "is_available", lambda name=None: name == "camoufox")
        assert bb.resolve_backend({"browser_backend": "camoufox"}) == "camoufox"

    def test_unknown_value_resets_to_default(self, _all_backends):
        assert bb.resolve_backend({"browser_backend": "nonsense"}) == bb.DEFAULT_BACKEND

    def test_camoufox_missing_falls_to_cloakbrowser(self, monkeypatch):
        monkeypatch.setattr(
            bb, "is_available", lambda name=None: name != "camoufox")
        assert bb.resolve_backend({"browser_backend": "camoufox"}) == "cloakbrowser"

    def test_stale_cloakbrowser_redirects_to_camoufox(self, monkeypatch):
        monkeypatch.setattr(bb, "is_available", lambda name=None: True)
        monkeypatch.setattr(bb, "_cloakbrowser_dist_version", lambda: (0, 4, 0))
        monkeypatch.delenv("SCANSCI_ALLOW_OLD_CLOAKBROWSER", raising=False)
        assert bb.resolve_backend({"browser_backend": "cloakbrowser"}) == "camoufox"


def test_camoufox_launch_drops_chromium_args(camoufox_install):
    """Chromium flags must never reach the Firefox binary (they become
    open-URL arguments there); launch proceeds without them."""
    bb._launch_camoufox(
        headless=True, proxy=None,
        args=["--disable-blink-features=AutomationControlled", "--window-size=1,1"],
        humanize=False, config=camoufox_install.config)

    assert camoufox_install.calls, "NewBrowser was never reached"
    assert camoufox_install.calls[0]["args"] == []  # chromium flags dropped


# ---------------------------------------------------------------------------
# D64-08: the program that actually launches must be the verified one.
# ---------------------------------------------------------------------------


def test_verified_program_is_handed_to_new_browser(camoufox_install):
    """Not just 'the install dir exists' — the resolved, gated file is passed."""
    bb._launch_camoufox(headless=True, proxy=None, args=None, humanize=False,
                        config=camoufox_install.config)
    assert camoufox_install.calls[0]["executable_path"] == str(camoufox_install.program)


def test_verified_program_is_handed_to_persistent_new_browser(camoufox_install):
    bb._launch_camoufox_persistent(str(camoufox_install.root / "profile"), headless=True,
                                   proxy=None, args=None, humanize=False,
                                   config=camoufox_install.config)
    assert camoufox_install.calls[0]["executable_path"] == str(camoufox_install.program)
    assert camoufox_install.calls[0]["persistent_context"] is True


def test_tampered_program_refuses_both_launch_paths(camoufox_install):
    """Positive regression: the bytes change under a valid pin -> refuse."""
    camoufox_install.program.write_bytes(b"# replaced payload\n")

    for launch, args in (
        (bb._launch_camoufox, {}),
        (bb._launch_camoufox_persistent, {"user_data_dir": str(camoufox_install.root)}),
    ):
        with pytest.raises(SecurityError, match="digest"):
            launch(headless=True, proxy=None, args=None, humanize=False,
                   config=camoufox_install.config, **args)
        assert camoufox_install.calls == [], "NewBrowser ran despite a digest mismatch"


def test_unpinned_program_in_install_dir_refuses_both_launch_paths(camoufox_install):
    """A writable download dir with no recorded digest must not launch."""
    for launch, args in (
        (bb._launch_camoufox, {}),
        (bb._launch_camoufox_persistent, {"user_data_dir": str(camoufox_install.root)}),
    ):
        with pytest.raises(SecurityError, match="no pinned digest"):
            launch(headless=True, proxy=None, args=None, humanize=False, config={}, **args)
        assert camoufox_install.calls == []


def test_installed_but_unapproved_version_is_refused(camoufox_install):
    """A pin for a *different* build must not be satisfied by this one."""
    with pytest.raises(SecurityError, match="digest"):
        bb._launch_camoufox(headless=True, proxy=None, args=None, humanize=False,
                            config=camoufox_install.wrong)
    assert camoufox_install.calls == []


def test_directory_named_like_the_program_is_not_launched(camoufox_install):
    """Dir-vs-program mismatch: the directory exists, the program does not."""
    camoufox_install.program.unlink()
    (camoufox_install.root / camoufox_install.program.name).mkdir()

    with pytest.raises(SecurityError, match="No Camoufox executable found"):
        bb._launch_camoufox(headless=True, proxy=None, args=None, humanize=False,
                            config=camoufox_install.config)
    assert camoufox_install.calls == []


def test_symlinked_program_is_refused(tmp_path, monkeypatch, camoufox_install):
    """A symlink to an approved payload must not smuggle it past the gate."""
    real = camoufox_install.program
    real.unlink()
    outside = tmp_path / "elsewhere"
    outside.write_bytes(b"# real build bytes\n")
    link = camoufox_install.root / real.name
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is not permitted for this account")
    monkeypatch.delenv("SCANSCI_PDF_TRUST_BROWSER_PATH", raising=False)

    # Pinned for the *target*, not the link: even a matching digest must not
    # make a symlinked program launchable.
    config = {"browser_binary_sha256": {str(link): browser_provenance.file_digest(outside)}}
    with pytest.raises(SecurityError):
        bb._launch_camoufox(headless=True, proxy=None, args=None, humanize=False,
                            config=config)
    assert camoufox_install.calls == []


def test_candidate_choice_is_deterministic(camoufox_install, monkeypatch):
    """Selection must not depend on filesystem traversal order."""
    nested = camoufox_install.root / "staging"
    nested.mkdir()
    decoy = nested / camoufox_install.program.name
    decoy.write_bytes(b"# decoy\n")

    def _unordered(root):
        return [decoy, camoufox_install.program]

    monkeypatch.setattr(browser_provenance, "_camoufox_candidates", _unordered)
    # The resolver verifies every candidate and takes the first *acceptable*
    # one; only the approved build satisfies the pin, so the order cannot
    # decide which bytes run.
    resolved = bb._verified_camoufox_executable(camoufox_install.config)
    assert resolved == str(camoufox_install.program)


def test_resolution_is_ordered_and_skips_directories(camoufox_install, monkeypatch):
    monkeypatch.setattr(browser_provenance, "_system_roots", lambda: ())
    nested = camoufox_install.root / "staging"
    nested.mkdir()
    (nested / camoufox_install.program.name).mkdir()  # a directory, not a program

    candidates = browser_provenance._camoufox_candidates(camoufox_install.root)
    assert candidates == [camoufox_install.program]


def test_missing_camoufox_raises_and_never_downloads(tmp_path, monkeypatch):
    """No implicit fetch: a missing install is an error, not a download."""
    monkeypatch.setattr(browser_provenance, "_camoufox_root", lambda: None)
    with pytest.raises(SecurityError, match="never downloads executable code"):
        bb._verified_camoufox_executable({})


def test_missing_install_directory_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(browser_provenance, "_camoufox_root", lambda: tmp_path / "absent")
    with pytest.raises(SecurityError, match="install directory is missing"):
        bb._verified_camoufox_executable({})


def test_browser_info_reports_only_a_verified_program(camoufox_install, monkeypatch):
    monkeypatch.setattr(bb, "resolve_backend", lambda config=None: bb.BACKEND_CAMOUFOX)
    info = bb.browser_info(camoufox_install.config)
    assert info["binary"] == str(camoufox_install.program)

    camoufox_install.program.write_bytes(b"# replaced payload\n")
    tampered = bb.browser_info(camoufox_install.config)
    assert tampered["binary"] != str(camoufox_install.program)
    assert "unverified" in tampered["binary"]


if __name__ == "__main__":
    pytest.main([__file__])
