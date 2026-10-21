"""Owner-selected Camoufox programs must not fall back to another pinned build."""

from __future__ import annotations

import sys
from pathlib import Path
from types import MappingProxyType, ModuleType, SimpleNamespace

import pytest

from scansci_pdf import browser_backend as bb, browser_guard, browser_provenance as bp
from scansci_pdf.security import SecurityError


@pytest.fixture
def installed_camoufox(tmp_path, monkeypatch):
    root = tmp_path / "camoufox-install"
    root.mkdir()
    name = "camoufox.exe" if sys.platform == "win32" else "camoufox"
    default = root / name
    selected = root / "selected" / name
    selected.parent.mkdir()
    default.write_bytes(b"default Camoufox fixture, never executed")
    selected.write_bytes(b"owner-selected Camoufox fixture, never executed")
    calls = []
    contexts = []

    class Context:
        pages = []

        def close(self):
            pass

        def new_page(self):
            return SimpleNamespace(goto=lambda url, **kwargs: None)

    class Browser:
        def close(self):
            pass

        def new_context(self, **kwargs):
            contexts.append(kwargs)
            return Context()

    def new_browser(driver, **kwargs):
        calls.append(kwargs)
        return Context() if kwargs.get("persistent_context") else Browser()

    camoufox = ModuleType("camoufox")
    camoufox.NewBrowser = new_browser
    camoufox.DefaultAddons = SimpleNamespace(UBO="ubo")
    monkeypatch.setitem(sys.modules, "camoufox", camoufox)
    monkeypatch.setitem(sys.modules, "playwright.sync_api", SimpleNamespace(
        sync_playwright=lambda: SimpleNamespace(start=lambda: SimpleNamespace(stop=lambda: None)),
    ))
    monkeypatch.setattr(bb, "is_available", lambda backend: backend == bb.BACKEND_CAMOUFOX)
    monkeypatch.setattr(bp, "_camoufox_root", lambda: root)
    monkeypatch.setattr(bp, "_cache_root", lambda: None)
    monkeypatch.setattr(bp, "_system_roots", lambda: ())
    monkeypatch.setattr(bp, "_per_user_roots", lambda: ())
    monkeypatch.setenv("SCANSCI_PDF_TRUST_BROWSER_PATH", "0")
    monkeypatch.setattr(browser_guard, "browser_proxy", lambda proxy: {"server": "http://guard.invalid"})
    config = {
        "browser_backend": bb.BACKEND_CAMOUFOX,
        "browser_executable": str(selected),
        "browser_binary_sha256": {
            str(default): bp.file_digest(default),
            str(selected): bp.file_digest(selected),
        },
    }
    return SimpleNamespace(root=root, default=default, selected=selected,
                           calls=calls, contexts=contexts, config=config)


def launch_entry(tmp_path, monkeypatch, config, hosted, profile, **kwargs):
    if hosted:
        monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(tmp_path))
    else:
        monkeypatch.delenv("SCANSCI_PDF_WORKSPACE", raising=False)
    if profile:
        return bb.launch_persistent_context(str(tmp_path / "profile"), config=config, **kwargs)
    return bb.launch(config=config, **kwargs)


@pytest.mark.parametrize("hosted", [False, True], ids=["ordinary", "hosted"])
@pytest.mark.parametrize("profile", [False, True], ids=["direct", "profile"])
def test_camoufox_launch_uses_owner_selected_program(
    tmp_path, monkeypatch, installed_camoufox, hosted, profile,
):
    fixture = installed_camoufox
    result = launch_entry(tmp_path, monkeypatch, fixture.config, hosted, profile)
    assert len(fixture.calls) == 1
    options = fixture.calls[0]
    assert options["executable_path"] == str(fixture.selected.absolute())
    assert options.get("persistent_context", False) is (profile and not hosted)
    if hosted and profile:
        assert len(fixture.contexts) == 1
    result.close()


@pytest.mark.parametrize("hosted", [False, True], ids=["ordinary", "hosted"])
@pytest.mark.parametrize("profile", [False, True], ids=["direct", "profile"])
@pytest.mark.parametrize("problem", ["missing", "digest", "unpinned", "location"])
def test_camoufox_refuses_invalid_selection_without_installed_fallback(
    tmp_path, monkeypatch, installed_camoufox, hosted, profile, problem,
):
    fixture = installed_camoufox
    config = {**fixture.config, "browser_binary_sha256": dict(fixture.config["browser_binary_sha256"])}
    match = "digest"
    if problem == "missing":
        config["browser_executable"] = str(tmp_path / "absent-camoufox")
        match = "not found"
    elif problem == "digest":
        config["browser_binary_sha256"][str(fixture.selected)] = "ab" * 32
    elif problem == "unpinned":
        del config["browser_binary_sha256"][str(fixture.selected)]
        match = "no pinned digest"
    else:
        outside = tmp_path / "outside" / fixture.selected.name
        outside.parent.mkdir()
        outside.write_bytes(b"outside install fixture, never executed")
        config["browser_executable"] = str(outside)
        config["browser_binary_sha256"][str(outside)] = bp.file_digest(outside)
        match = "allowlisted"
    with pytest.raises(SecurityError, match=match):
        launch_entry(tmp_path, monkeypatch, config, hosted, profile)
    assert fixture.calls == []


def test_explicit_camoufox_does_not_require_default_install_directory(
    tmp_path, monkeypatch, installed_camoufox,
):
    fixture = installed_camoufox
    monkeypatch.setattr(bp, "_camoufox_root", lambda: None)
    monkeypatch.setattr(bp, "_system_roots", lambda: (str(fixture.root),))
    result = launch_entry(tmp_path, monkeypatch, fixture.config, True, False)
    assert fixture.calls[0]["executable_path"] == str(fixture.selected.absolute())
    result.close()


@pytest.mark.parametrize("profile", [False, True], ids=["direct", "profile"])
@pytest.mark.parametrize("override", ["executable_path", "from_options", "launch_options", "launch_options_mapping"])
def test_camoufox_raw_options_cannot_replace_verified_selection(
    tmp_path, monkeypatch, installed_camoufox, profile, override,
):
    fixture = installed_camoufox
    value = str(fixture.default) if override == "executable_path" else {"executable_path": str(fixture.default)}
    if override == "launch_options_mapping":
        override, value = "launch_options", MappingProxyType(value)
    with pytest.raises(SecurityError, match="browser_executable"):
        launch_entry(tmp_path, monkeypatch, fixture.config, False, profile, **{override: value})
    assert fixture.calls == []
