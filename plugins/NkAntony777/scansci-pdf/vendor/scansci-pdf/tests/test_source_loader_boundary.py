"""Offline source-only loader regressions for ordinary project maintenance.

All bytecode is locally compiled harmless fixture code. Integration stages copy
the delivered manifest unchanged; no account, external service or workflow is
used, and no network-security testing is performed.
"""

from __future__ import annotations

import ast
import hashlib
import importlib
import importlib.abc
import importlib.machinery
import importlib.util
import json
import os
import py_compile
import shutil
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest


ENGINE = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("_loader_secure_stage", ENGINE / "tests/_secure_stage.py")
_secure_stage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_secure_stage)
MARKER = "LOCAL-LEGACY-BYTECODE-RAN"


def _valid_bytecode(tmp_path: Path, destination: Path, marker: str = MARKER) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    source = tmp_path / "legacy_canary.py"
    source.write_text(f"import sys\nprint({marker!r}, file=sys.stderr)\nCANARY = {marker!r}\n", encoding="ascii")
    py_compile.compile(str(source), cfile=str(destination), doraise=True,
                       invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
    assert destination.read_bytes()[:4] == importlib.util.MAGIC_NUMBER
    return destination


@pytest.fixture
def source_loader(tmp_path, monkeypatch):
    """Exercise the shipped loader class without bypassing a launcher gate.

    This is a small unit fixture, not a delivered-manifest integration proof.
    Only its explicitly pinned source files belong to the fixture manifest.
    """
    engine = tmp_path / "fixture_engine"
    manifest = {"files": {}}

    def pin(relative, content):
        file = engine / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content, encoding="ascii")
        manifest["files"][relative] = hashlib.sha256(file.read_bytes()).hexdigest()
        return file

    pin("src/scansci_pdf/__init__.py", "")
    pin("src/scansci_pdf/_core/__init__.py", "")
    tree = ast.parse((ENGINE / "run_secure.py").read_text(encoding="utf-8"))
    definition = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "SourceLoader")
    namespace = {"engine": engine, "manifest": manifest, "importlib": importlib, "Path": Path}
    exec(compile(ast.Module(body=[definition], type_ignores=[]), str(ENGINE / "run_secure.py"), "exec"), namespace)
    loader = namespace["SourceLoader"]()
    monkeypatch.syspath_prepend(str(engine / "src"))
    monkeypatch.setattr(sys, "meta_path", [loader, *sys.meta_path])
    with patch.dict(sys.modules):
        for name in list(sys.modules):
            if name == "scansci_pdf" or name.startswith("scansci_pdf."):
                del sys.modules[name]
        yield engine, loader, pin


def test_sourceless_optional_bytecode_never_reaches_a_later_finder(source_loader, tmp_path, monkeypatch, capsys):
    engine, loader, pin = source_loader
    core = engine / "src/scansci_pdf/_core"
    _valid_bytecode(tmp_path, core / "racing.pyc")
    # Establish that this is a real loadable legacy module, not invalid pyc text.
    normal_spec = importlib.machinery.PathFinder.find_spec("scansci_pdf._core.racing", [str(core)])
    assert isinstance(normal_spec.loader, importlib.machinery.SourcelessFileLoader)
    assert MARKER in normal_spec.loader.get_code(normal_spec.name).co_consts

    calls = []

    class LaterFinder:
        def find_spec(self, fullname, path=None, target=None):
            calls.append(fullname)
            return None

    monkeypatch.setattr(sys, "meta_path", [loader, LaterFinder(), *sys.meta_path[1:]])
    pin("src/scansci_pdf/sources/__init__.py", "try:\n    from .._core.racing import CANARY\nexcept ImportError:\n    SOURCE_FALLBACK = True\n")
    sources = importlib.import_module("scansci_pdf.sources")
    assert sources.SOURCE_FALLBACK is True
    assert "scansci_pdf._core.racing" not in calls
    assert "scansci_pdf._core.racing" not in sys.modules
    assert MARKER not in capsys.readouterr().err
    with pytest.raises(ModuleNotFoundError) as caught:
        importlib.import_module("scansci_pdf._core.racing")
    assert caught.value.name == "scansci_pdf._core.racing"


@pytest.mark.parametrize("layout", ["module", "package", "namespace"])
def test_missing_source_closes_the_entire_engine_namespace(source_loader, tmp_path, layout):
    engine, loader, _ = source_loader
    base = engine / "src/scansci_pdf/legacy_optional"
    if layout == "module":
        _valid_bytecode(tmp_path, base.with_suffix(".pyc"))
    elif layout == "package":
        _valid_bytecode(tmp_path, base / "__init__.pyc")
    else:
        base.mkdir()
    with pytest.raises(ModuleNotFoundError) as caught:
        importlib.import_module("scansci_pdf.legacy_optional")
    assert caught.value.name == "scansci_pdf.legacy_optional"


@pytest.mark.parametrize("relative,fullname", [
    ("src/scansci_pdf/unpinned.py", "scansci_pdf.unpinned"),
    ("src/scansci_pdf/unpinned/__init__.py", "scansci_pdf.unpinned"),
])
def test_existing_but_unmanifested_source_is_not_a_dynamic_import(source_loader, relative, fullname):
    engine, loader, _ = source_loader
    file = engine / relative
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text("raise AssertionError('unpinned source must not run')\n", encoding="ascii")
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module(fullname)
    with pytest.raises(ImportError):
        loader.get_code(fullname)


@pytest.mark.parametrize("layout", ["cache", "adjacent"])
def test_existing_pinned_source_runs_instead_of_valid_legacy_bytecode(source_loader, tmp_path, capsys, layout):
    engine, _, pin = source_loader
    source = pin("src/scansci_pdf/verified.py", "VALUE = 'pinned source'\n")
    bytecode = Path(importlib.util.cache_from_source(str(source))) if layout == "cache" else source.with_suffix(".pyc")
    _valid_bytecode(tmp_path, bytecode)
    if layout == "cache":
        normal_spec = importlib.machinery.PathFinder.find_spec("scansci_pdf.verified", [str(source.parent)])
        assert MARKER in normal_spec.loader.get_code(normal_spec.name).co_consts
    module = importlib.import_module("scansci_pdf.verified")
    assert module.VALUE == "pinned source"
    assert MARKER not in capsys.readouterr().err
    assert bytecode.exists(), "ordinary old caches are ignored, not prohibited or deleted"


def test_an_unpinned_directory_does_not_hide_a_pinned_source_module(source_loader):
    engine, loader, pin = source_loader
    pin("src/scansci_pdf/verified.py", "VALUE = 'pinned module'\n")
    (engine / "src/scansci_pdf/verified").mkdir()
    spec = loader.find_spec("scansci_pdf.verified")
    assert spec.submodule_search_locations is None
    assert importlib.import_module("scansci_pdf.verified").VALUE == "pinned module"


def test_similarly_named_external_packages_keep_normal_import_behavior(source_loader, tmp_path, capsys):
    engine, loader, _ = source_loader
    _valid_bytecode(tmp_path, engine / "src/scansci_pdf_other.pyc", marker="NORMAL-OTHER-PACKAGE")
    assert loader.find_spec("scansci_pdf_other") is None
    assert loader.find_spec("scansci_pdf_other.child") is None
    other = importlib.import_module("scansci_pdf_other")
    assert other.CANARY == "NORMAL-OTHER-PACKAGE"
    assert "NORMAL-OTHER-PACKAGE" in capsys.readouterr().err


@pytest.fixture
def bytecode_plugin(tmp_path):
    """Copy the exact delivered source manifest and add only valid old pyc."""
    package = tmp_path / "plugin"
    engine = package / "vendor/scansci-pdf"
    _secure_stage.stage_engine(engine)
    shutil.copy2(ENGINE.parents[1] / "mcp.json", package / "mcp.json")
    manifest = (engine / "SOURCE-HASHES.json").read_bytes()
    optional = engine / "src/scansci_pdf/_core/racing.py"
    main = engine / "src/scansci_pdf/cli/__main__.py"
    bytecode = [
        _valid_bytecode(tmp_path, optional.with_suffix(".pyc")),
        _valid_bytecode(tmp_path, Path(importlib.util.cache_from_source(str(optional)))),
        _valid_bytecode(tmp_path, main.with_suffix(".pyc")),
        _valid_bytecode(tmp_path, Path(importlib.util.cache_from_source(str(main)))),
    ]
    assert not optional.exists(), "the optional engine module must remain sourceless"
    assert (engine / "SOURCE-HASHES.json").read_bytes() == manifest
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    return package, engine, workspace, manifest, bytecode


def _subprocess(command, workspace):
    environment = dict(os.environ)
    for name in ("SCANSCI_PDF_SECURE_ENTRY", "SCANSCI_PDF_WORKSPACE", "PYTHONPATH", "PYTHONHOME"):
        environment.pop(name, None)
    environment["SCANSCI_PDF_PYTHON"] = sys.executable
    environment["SCANSCI_PROGRESS_BAR"] = "0"
    return subprocess.run(command, cwd=str(workspace), env=environment,
                          capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)


def _assert_bytecode_ignored(result, engine, manifest, bytecode):
    assert result.returncode == 0, result.stdout + result.stderr
    assert MARKER not in result.stdout + result.stderr
    assert (engine / "SOURCE-HASHES.json").read_bytes() == manifest
    assert all(path.exists() for path in bytecode)


def test_real_host_cli_ignores_sourceless_and_existing_module_bytecode(bytecode_plugin):
    package, engine, workspace, manifest, bytecode = bytecode_plugin
    server = json.loads((package / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]["scansci-pdf"]
    bootstrap = server["args"][0].replace("${PLUGIN_ROOT}", str(package))
    result = _subprocess([server["command"], bootstrap, "--module", "scansci_pdf.cli", "--help"], workspace)
    _assert_bytecode_ignored(result, engine, manifest, bytecode)
    assert "session-broker-status" in result.stdout


def test_actual_manifest_stdio_ignores_sourceless_and_existing_module_bytecode(bytecode_plugin):
    _, engine, workspace, manifest, bytecode = bytecode_plugin
    result = _subprocess([sys.executable, "-I", str(engine / "scripts/check_mcp_package.py"),
                          str(engine / "run_secure.py")], workspace)
    _assert_bytecode_ignored(result, engine, manifest, bytecode)
    reports = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
    assert any(report.get("stdio") == "passed" and report.get("tools") == 18 for report in reports), result.stdout
    assert "source-integrity: tampering rejected" in result.stdout
