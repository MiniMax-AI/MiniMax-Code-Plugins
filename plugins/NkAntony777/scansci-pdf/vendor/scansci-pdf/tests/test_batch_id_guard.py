"""D64-01 — ``batch_id`` is an identifier, never a path.

The resume file is ``<DATA_DIR>/batch_progress/<batch_id>.jsonl`` and the
progress records it holds are fed straight back into batch results. A path
passed as ``batch_id`` therefore reads a file of the caller's choosing and
returns its records to the caller.

The contract under test:
* a length-limited identifier grammar rejects absolute paths, POSIX and
  Windows separators, drive letters, UNC prefixes, ADS streams and traversal;
* read, write and cleanup all go through ONE constrained resolver that stays
  inside ``batch_progress`` and refuses a symlink or junction;
* a rejected id echoes no outside JSONL content and deletes no outside
  record; and a legitimate resume still works.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from scansci_pdf import sources


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    root = tmp_path / "data"
    (root / "batch_progress").mkdir(parents=True)
    monkeypatch.setattr(sources, "DATA_DIR", root)
    return root


@pytest.fixture
def outside_record(tmp_path):
    """A JSONL file outside the data dir holding a success record.

    The planted identifier is deliberately one the caller never passed, so
    finding it anywhere in the output proves outside content was echoed.
    """
    outside = tmp_path / "outside"
    outside.mkdir()
    record = outside / "evil"
    record.write_text(json.dumps({
        "identifier": "10.7777/planted-elsewhere",
        "success": True,
        "source": "planted",
        "file": str(outside / "planted.pdf"),
        "doi": "10.7777/planted-elsewhere",
        "private_field": "SYNTHETIC-OUTSIDE-PRIVATE-FIELD",
    }) + "\n", encoding="utf-8")
    return record


@pytest.fixture
def recorded_opens():
    seen: list[str] = []
    state = {"armed": False}

    def hook(event, args):
        if state["armed"] and event == "open":
            try:
                seen.append(os.path.normcase(os.fsdecode(args[0])))
            except Exception:
                seen.append(repr(args[0]))

    sys.addaudithook(hook)

    class Recorder:
        def __enter__(self):
            seen.clear()
            state["armed"] = True
            return seen

        def __exit__(self, *exc):
            state["armed"] = False
            return False

    return Recorder()


# Identifiers that must never be treated as a name.
PATH_LIKE_IDS = [
    pytest.param("/tmp/evil", id="posix-absolute"),
    pytest.param("/etc/passwd", id="posix-absolute-system"),
    pytest.param("C:\\Users\\victim\\evil", id="windows-absolute"),
    pytest.param("C:/Users/victim/evil", id="windows-absolute-slash"),
    pytest.param("\\\\server\\share\\evil", id="unc"),
    pytest.param("//server/share/evil", id="unc-forward"),
    pytest.param("..", id="dotdot"),
    pytest.param("../evil", id="traversal-posix"),
    pytest.param("..\\evil", id="traversal-windows"),
    pytest.param("good/../../evil", id="embedded-traversal"),
    pytest.param("evil.jsonl:stream", id="ads-stream"),
    pytest.param("C:evil", id="drive-relative"),
    pytest.param("sub\\evil", id="nested-windows"),
    pytest.param("sub/evil", id="nested-posix"),
    pytest.param("", id="empty"),
    pytest.param("x" * 65, id="too-long"),
    pytest.param("NUL", id="reserved-device"),
    pytest.param("a" * 63 + " ", id="trailing-space"),
    pytest.param("../evil", id="traversal-repeat"),
]


@pytest.mark.parametrize("bad_id", PATH_LIKE_IDS)
def test_path_like_batch_id_is_rejected(data_dir, bad_id, outside_record):
    with pytest.raises(sources.SecurityError):
        sources._get_progress_file(bad_id)


def test_auto_generated_and_user_batch_ids_still_resolve(data_dir):
    auto_id = "0123456789ab"  # md5(...).hexdigest()[:12] shape
    assert sources._get_progress_file(auto_id) == \
        data_dir / "batch_progress" / f"{auto_id}.jsonl"
    assert sources._get_progress_file("nightly-2024.10_run7").name == \
        "nightly-2024.10_run7.jsonl"


def test_resolver_refuses_to_escape_batch_progress(data_dir):
    # Even a grammar-passing id resolves strictly inside batch_progress.
    resolved = sources._get_progress_file("abc")
    assert resolved.parent == data_dir / "batch_progress"
    assert resolved.is_relative_to(data_dir)


def _make_directory_link(link: Path, target: Path) -> bool:
    """Link a directory to ``target``; symlink on POSIX, junction on Windows."""
    try:
        link.symlink_to(target, target_is_directory=True)
        return True
    except OSError:
        pass
    if os.name != "nt":
        return False
    try:
        subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                       check=True, capture_output=True)
        return True
    except Exception:
        return False


def test_symlinked_progress_file_is_rejected(data_dir, outside_record):
    """A link from inside batch_progress out to an outside record is refused."""
    linked = _make_directory_link(data_dir / "batch_progress" / "linked", outside_record.parent)
    if not linked:
        pytest.skip("no symlink/junction privilege")
    with pytest.raises(sources.SecurityError):
        sources._get_progress_file("linked/evil")


def test_junction_inside_batch_progress_is_rejected(data_dir, outside_record):
    """Windows junctions are reparse points and must not launder an escape."""
    if os.name != "nt":
        pytest.skip("junctions are Windows-only")
    target = data_dir / "batch_progress" / "jdir"
    if not _make_directory_link(target, outside_record.parent):
        pytest.skip("no junction privilege")
    with pytest.raises(sources.SecurityError):
        sources._get_progress_file("jdir/evil")


# --------------------------------------------------------------------------
# Positive regression: the outside record is never read, echoed or deleted
# --------------------------------------------------------------------------

def test_outside_jsonl_is_never_read_or_echoed(data_dir, outside_record, monkeypatch, recorded_opens):
    """The reviewer's reproduction: an extension-less absolute path as batch_id."""
    batch_id = str(outside_record.with_suffix(""))  # extension-less absolute path

    def _fake_download(identifier, output_dir=None, **kwargs):
        return {"success": False, "identifier": identifier, "reason": "offline"}

    monkeypatch.setattr(sources, "download", _fake_download)

    with recorded_opens as opened:
        summary = sources.batch_download(
            ["10.9999/planted"], data_dir, batch_id=batch_id, scihub_enabled=False,
        )

    assert summary["success"] is False
    assert "Invalid batch_id" in summary["error"]
    assert "SYNTHETIC-OUTSIDE-PRIVATE-FIELD" not in json.dumps(summary)
    assert "10.7777/planted-elsewhere" not in json.dumps(summary), \
        "no identifier from the outside record may be echoed"
    assert str(outside_record) not in opened, "outside JSONL must never be opened"
    assert outside_record.exists(), "the planted record must be left untouched"


def test_outside_record_is_never_deleted_by_cleanup(data_dir, outside_record):
    batch_id = str(outside_record.with_suffix(""))
    sources._clear_progress(batch_id)
    assert outside_record.exists(), "cleanup must not delete an outside record"

    with pytest.raises(sources.SecurityError):
        sources._save_progress(batch_id, "10.9999/planted", {"success": True})
    assert outside_record.read_text(encoding="utf-8").count("\n") == 1


def test_load_progress_on_rejected_id_returns_nothing(data_dir, outside_record):
    batch_id = str(outside_record.with_suffix(""))
    assert sources._load_progress(batch_id) == {}


def test_progress_write_read_clear_round_trip(data_dir):
    """The legitimate resume path is unchanged."""
    batch_id = "legit-run-1"
    sources._save_progress(batch_id, "10.1/ok", {
        "success": True, "source": "test", "file": "C:/papers/a.pdf", "doi": "10.1/ok"})
    loaded = sources._load_progress(batch_id)
    assert loaded["10.1/ok"]["success"] is True

    sources._clear_progress(batch_id)
    assert sources._load_progress(batch_id) == {}
    assert not (data_dir / "batch_progress" / f"{batch_id}.jsonl").exists()


def test_resume_reuses_progress_records(data_dir, monkeypatch):
    """A real resume: completed items are reused, pending ones are retried."""
    batch_id = "resume-run-2"
    sources._save_progress(batch_id, "10.1/done", {
        "success": True, "source": "test", "file": str(data_dir / "done.pdf"), "doi": "10.1/done"})
    monkeypatch.setattr(sources, "load_config", lambda: {
        "batch_total_timeout": 30, "batch_workers": 1, "batch_stagger_seconds": 0.0,
        "output_dir": str(data_dir), "download_strategy": "legal_only",
    })
    monkeypatch.setattr(sources, "_batch_institutional_phase", lambda *a, **k: None)
    # validate_doi is imported inside batch_download, so patch its origin.
    import scansci_pdf.identifiers as identifiers_module
    monkeypatch.setattr(identifiers_module, "validate_doi", lambda d: (True, "ok"))

    attempted = []

    def _fake_download(identifier, output_dir=None, **kwargs):
        attempted.append(identifier)
        return {"success": False, "identifier": identifier, "reason": "offline"}

    monkeypatch.setattr(sources, "download", _fake_download)

    summary = sources.batch_download(["10.1/done", "10.1/pending"], data_dir, batch_id=batch_id)

    assert attempted == ["10.1/pending"], "completed items must not be re-downloaded"
    assert summary["skipped_completed"] == 1
    assert summary["succeeded"] == 1
    assert summary["results"][0]["source"] == "test"