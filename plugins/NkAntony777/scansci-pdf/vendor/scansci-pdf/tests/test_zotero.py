"""Zotero push: final read boundary and honest failure reporting.

D64-02 — the attachment path is validated immediately before the file is
opened, not merely when the cache record is read. An outside-workspace file
must never be opened at all, through the real MCP tool chain.

D64-14 — a partial Zotero push must be visible to the caller. Parent item
success, attachment-create success and file-upload success are distinct
outcomes; a requested PDF that did not upload is never reported as success.

The fixtures emulate the real Zotero Web API upload sequence (create
attachment item -> request upload authorization -> push prefix -> push file),
so a mock that returns 200 for everything cannot pass by accident.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

from scansci_pdf import config as config_module
from scansci_pdf import zotero


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


# A Zotero write response: "successful" carries the full object, "success" the
# bare key, and a rejected item lands in "failed" with a code and message.
def _write_ok(key):
    return FakeResponse(200, {
        "success": {"0": key},
        "successful": {"0": {"key": key, "version": 3, "data": {"key": key}}},
        "failed": {},
        "unchanged": {},
    })


def _write_failed(code, message):
    return FakeResponse(200, {"success": {}, "successful": {}, "failed": {"0": {"code": code, "message": message}}})


class FakeZotero:
    """Protocol-correct Zotero transport with per-stage failure injection."""

    def __init__(self, *, parent_status=200, parent_key="PARENTKEY",
                 attach_status=200, attach_key="ATTKEY",
                 authorize_status=200, prefix_status=200, upload_status=201,
                 authorize_payload=None, raises_on=()):
        self.parent_status = parent_status
        self.parent_key = parent_key
        self.attach_status = attach_status
        self.attach_key = attach_key
        self.authorize_status = authorize_status
        self.prefix_status = prefix_status
        self.upload_status = upload_status
        self.authorize_payload = authorize_payload
        self.raises_on = set(raises_on)
        self.calls = []
        self.uploaded_streams = []
        self.deleted = []

    def _maybe_raise(self, stage):
        if stage in self.raises_on:
            import requests

            raise requests.exceptions.Timeout(f"simulated {stage} timeout")

    def post(self, url, **kwargs):
        stage = self._stage(url, kwargs)
        self.calls.append((stage, url, kwargs))
        self._maybe_raise(stage)
        if stage == "parent":
            if self.parent_status != 200:
                return FakeResponse(self.parent_status, {"error": {"code": self.parent_status, "message": "nope"}})
            return _write_ok(self.parent_key)
        if stage == "attachment":
            if self.attach_status != 200:
                return FakeResponse(self.attach_status, {"error": {"code": self.attach_status, "message": "bad item"}})
            return _write_ok(self.attach_key)
        if stage == "authorize":
            if self.authorize_status != 200:
                return FakeResponse(self.authorize_status, {"error": {"code": self.authorize_status, "message": "no auth"}})
            if self.authorize_payload is not None:
                return FakeResponse(self.authorize_status, self.authorize_payload)
            return FakeResponse(200, {
                "url": "https://storage.zotero.invalid/upload/ATTKEY",
                "contentType": "application/pdf",
                "prefix": "",
                "suffix": "",
                "uploadKey": "upload:1:abc",
            })
        if stage == "prefix":
            return FakeResponse(self.prefix_status, {})
        if stage == "upload":
            data = kwargs.get("data")
            if hasattr(data, "read"):
                data.read()
                self.uploaded_streams.append(url)
            return FakeResponse(self.upload_status, {})
        raise AssertionError(f"unexpected Zotero call: {url}")

    def delete(self, url, **kwargs):
        self.deleted.append(url)
        return FakeResponse(204, {})

    @staticmethod
    def _stage(url, kwargs):
        # Both the parent item and the attachment item POST to /items; the
        # real API distinguishes them only by itemType in the JSON array.
        if url.endswith("/items"):
            payload = kwargs.get("json") or []
            item_type = payload[0].get("itemType") if payload else ""
            return "attachment" if item_type == "attachment" else "parent"
        if "/items/" in url and url.endswith("/file"):
            return "authorize"
        if url.startswith("https://storage.zotero.invalid"):
            return "upload"
        return "unknown"

    def stages(self):
        return [stage for stage, _, _ in self.calls]


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    """A real strict-mode workspace with its own data dir and config."""
    root = tmp_path / "workspace"
    (root / ".scansci-pdf" / "cache").mkdir(parents=True)
    (root / "papers").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()

    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(root))
    data_dir = root / ".scansci-pdf"
    monkeypatch.setattr(config_module, "DATA_DIR", data_dir)
    monkeypatch.setattr(config_module, "CONFIG_FILE", data_dir / "config.json")
    config_module.save_config({
        "zotero_api_key": "SECRET-API-KEY",
        "zotero_library_type": "user",
        "zotero_library_id": "123456",
        "cache_dir": str(data_dir / "cache"),
        "output_dir": str(root / "papers"),
    })
    return {"root": root, "outside": outside, "data_dir": data_dir}


@pytest.fixture
def recorded_opens():
    """Record every file opened while armed, so 'never opened' is provable."""
    seen: list[str] = []
    state = {"armed": False}

    def hook(event, args):
        if state["armed"] and event == "open":
            try:
                seen.append(os.fsdecode(args[0]))
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


def _install_transport(monkeypatch, transport):
    import requests

    monkeypatch.setattr(requests, "post", transport.post)
    monkeypatch.setattr(requests, "delete", transport.delete)


def _tool_call(monkeypatch, identifier, cached_file):
    """Drive the real MCP tool, with only the network and metadata stubbed."""
    from scansci_pdf import cache as cache_module
    from scansci_pdf import citation, server

    monkeypatch.setattr(citation, "fetch_metadata", lambda doi, config: {"title": ["A Paper"]})
    cfg = server.load_config()
    cache_module.cache_set(identifier, {"success": True, "doi": identifier, "file": str(cached_file)}, cfg)
    return server.scansci_pdf_zotero_push(identifier)


def _unwrap(payload: str) -> dict:
    """The MCP wrapper tags every tool result as untrusted external data."""
    outer = json.loads(payload)
    inner = outer.get("result", outer)
    return inner if isinstance(inner, dict) else json.loads(inner)


def _pdf(path: Path, body: bytes = b"%PDF-1.7\n%%EOF\n") -> Path:
    path.write_bytes(body)
    return path


# --------------------------------------------------------------------------
# Existing behaviour
# --------------------------------------------------------------------------

def test_push_to_zotero_posts_item_as_raw_json_array(monkeypatch):
    transport = FakeZotero()
    _install_transport(monkeypatch, transport)

    result = zotero.push_to_zotero(
        doi="10.1234/example",
        pdf_path=None,
        config={
            "zotero_api_key": "test-key",
            "zotero_library_type": "user",
            "zotero_library_id": "123456",
        },
    )

    assert result["success"] is True
    assert result["zotero_key"] == "PARENTKEY"
    assert result["attachment"] == {"requested": False, "status": "not_requested"}
    parent_url, kwargs = transport.calls[0][1], transport.calls[0][2]
    assert parent_url == "https://api.zotero.org/users/123456/items"
    assert isinstance(kwargs["json"], list)
    assert kwargs["json"][0]["DOI"] == "10.1234/example"


def test_upload_attachment_follows_the_zotero_upload_protocol(monkeypatch, tmp_path):
    transport = FakeZotero()
    _install_transport(monkeypatch, transport)
    pdf_path = _pdf(tmp_path / "paper.pdf")

    upload = zotero._upload_attachment(
        base_url="https://api.zotero.org/users/123456",
        headers={"Zotero-API-Key": "test-key", "Content-Type": "application/json"},
        parent_key="PARENTKEY",
        pdf_path=pdf_path,
        api_key="test-key",
    )

    assert upload["status"] == "uploaded"
    assert upload["attachment_key"] == "ATTKEY"
    # Create item -> authorize -> push file. A one-shot POST would prove nothing.
    assert transport.stages() == ["attachment", "authorize", "upload"]
    attach_kwargs = transport.calls[0][2]
    assert attach_kwargs["json"][0]["parentItem"] == "PARENTKEY"
    assert attach_kwargs["json"][0]["linkMode"] == "imported_file"
    auth_kwargs = transport.calls[1][2]
    assert set(auth_kwargs["data"]) == {"md5", "filename", "filesize", "mtime"}
    assert auth_kwargs["headers"]["If-None-Match"] == "*"
    assert transport.calls[2][1] == "https://storage.zotero.invalid/upload/ATTKEY"


# --------------------------------------------------------------------------
# D64-02 — final read boundary
# --------------------------------------------------------------------------

def test_cached_attachment_outside_workspace_is_never_opened(workspace, monkeypatch, recorded_opens):
    """The outside file is not read, and no remote entry is created."""
    secret = _pdf(workspace["outside"] / "SYNTHETIC-OUTSIDE-WORKSPACE-DATA.pdf",
                  b"SYNTHETIC-OUTSIDE-WORKSPACE-DATA")
    transport = FakeZotero()
    _install_transport(monkeypatch, transport)

    with recorded_opens as opened:
        result = _unwrap(_tool_call(monkeypatch, "10.1234/outside", secret))

    assert result["success"] is False
    assert result["item_created"] is False
    assert result["attachment"]["status"] == "rejected"
    assert "workspace" in result["attachment"]["error"].lower()
    assert transport.calls == [], "no remote item may be created for a rejected path"
    assert str(secret) not in opened, "the outside file must never be opened"
    assert not transport.uploaded_streams


def test_relative_traversal_attachment_is_never_opened(workspace, monkeypatch, recorded_opens):
    workspace["root"]  # ensure the workspace exists
    secret = _pdf(workspace["outside"] / "escape.pdf", b"OUTSIDE-ESCAPE-DATA")
    transport = FakeZotero()
    _install_transport(monkeypatch, transport)

    with recorded_opens as opened:
        result = _unwrap(_tool_call(monkeypatch, "10.1234/traversal", "../outside/escape.pdf"))

    assert result["success"] is False
    assert result["attachment"]["status"] == "rejected"
    assert transport.calls == []
    assert str(secret.resolve()) not in [os.path.normcase(p) for p in opened]


def _make_directory_link(link: Path, target: Path) -> bool:
    """Link a directory to ``target``; symlink on POSIX, junction on Windows."""
    try:
        link.symlink_to(target, target_is_directory=True)
        return True
    except OSError:
        pass
    if os.name != "nt":
        return False
    import subprocess
    try:
        subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                       check=True, capture_output=True)
        return True
    except Exception:
        return False


def test_workspace_symlink_pointing_outside_is_never_opened(workspace, monkeypatch, recorded_opens):
    secret = _pdf(workspace["outside"] / "linked.pdf", b"OUTSIDE-LINKED-DATA")
    link = workspace["root"] / "link"
    if not _make_directory_link(link, workspace["outside"]):
        pytest.skip("no symlink/junction privilege")
    transport = FakeZotero()
    _install_transport(monkeypatch, transport)

    with recorded_opens as opened:
        result = _unwrap(_tool_call(monkeypatch, "10.1234/symlink", link / "linked.pdf"))

    assert result["success"] is False
    assert result["attachment"]["status"] == "rejected"
    assert transport.calls == []
    assert str(secret) not in opened


def test_workspace_junction_pointing_outside_is_never_opened(workspace, monkeypatch, recorded_opens):
    """Windows junctions are reparse points and must not launder an escape."""
    secret = _pdf(workspace["outside"] / "juncted.pdf", b"OUTSIDE-JUNCTION-DATA")
    link = workspace["root"] / "junction"
    if os.name != "nt":
        pytest.skip("junctions are Windows-only")
    if not _make_directory_link(link, workspace["outside"]):
        pytest.skip("no junction privilege")
    assert link.is_dir() and link.resolve() == workspace["outside"].resolve()
    transport = FakeZotero()
    _install_transport(monkeypatch, transport)

    with recorded_opens as opened:
        result = _unwrap(_tool_call(monkeypatch, "10.1234/junction", link / "juncted.pdf"))

    assert result["success"] is False
    assert result["attachment"]["status"] == "rejected"
    assert transport.calls == []
    assert str(secret) not in opened


def test_directory_and_missing_attachment_are_rejected(workspace, monkeypatch):
    transport = FakeZotero()
    _install_transport(monkeypatch, transport)
    result = _unwrap(_tool_call(monkeypatch, "10.1234/dir", workspace["root"]))
    assert result["attachment"]["status"] == "rejected"
    assert "regular file" in result["attachment"]["error"]

    missing = _unwrap(_tool_call(monkeypatch, "10.1234/missing", workspace["root"] / "nope.pdf"))
    assert missing["attachment"]["status"] == "rejected"
    assert "does not exist" in missing["attachment"]["error"]
    assert transport.calls == []


def test_in_workspace_pdf_uploads_through_absolute_and_relative_paths(workspace, monkeypatch):
    workspace_pdf = _pdf(workspace["root"] / "papers" / "paper.pdf", b"%PDF-1.7\n%%EOF\n")
    for label, cached in (("absolute", workspace_pdf),
                          ("relative", Path("papers/paper.pdf"))):
        transport = FakeZotero()
        _install_transport(monkeypatch, transport)
        result = _unwrap(_tool_call(monkeypatch, f"10.1234/ok-{label}", cached))
        assert result["success"] is True, label
        assert result["zotero_key"] == "PARENTKEY"
        assert result["attachment"]["status"] == "uploaded", label
        assert transport.stages() == ["parent", "attachment", "authorize", "upload"]


def test_non_pdf_attachment_is_rejected(workspace, monkeypatch):
    decoy = workspace["root"] / "papers" / "notes.txt"
    decoy.write_text("not a pdf", encoding="utf-8")
    transport = FakeZotero()
    _install_transport(monkeypatch, transport)

    result = _unwrap(_tool_call(monkeypatch, "10.1234/txt", decoy))

    assert result["attachment"]["status"] == "rejected"
    assert transport.calls == []


# --------------------------------------------------------------------------
# D64-14 — partial failure reaches the caller
# --------------------------------------------------------------------------

@pytest.mark.parametrize("failing", ["parent", "attachment", "authorize", "upload"])
def test_each_stage_failure_is_visible_to_the_caller(workspace, monkeypatch, failing):
    """A failure at any stage must not be reported as an unqualified success."""
    pdf_path = _pdf(workspace["root"] / "papers" / "paper.pdf", b"%PDF-1.7\n%%EOF\n")
    settings = {
        "parent": {"parent_status": 500},
        "attachment": {"attach_status": 400},
        "authorize": {"authorize_status": 413},
        "upload": {"upload_status": 502},
    }[failing]
    transport = FakeZotero(**settings)
    _install_transport(monkeypatch, transport)

    result = _unwrap(_tool_call(monkeypatch, "10.1234/partial", pdf_path))

    assert result["success"] is False, failing
    assert result["attachment"]["requested"] is True
    assert result["attachment"]["status"] != "uploaded"
    assert result["error"]
    if failing == "parent":
        assert result["item_created"] is False
        assert "zotero_key" not in result
    else:
        # The item exists: the key is preserved so a retry does not duplicate it.
        assert result["item_created"] is True
        assert result["zotero_key"] == "PARENTKEY"
        assert result["retry"]["zotero_key"] == "PARENTKEY"
        assert result["attachment"]["error"]


def test_upload_timeout_is_reported_not_swallowed(workspace, monkeypatch):
    pdf_path = _pdf(workspace["root"] / "papers" / "paper.pdf", b"%PDF-1.7\n%%EOF\n")
    transport = FakeZotero(raises_on=("upload",))
    _install_transport(monkeypatch, transport)

    result = _unwrap(_tool_call(monkeypatch, "10.1234/timeout", pdf_path))

    assert result["success"] is False
    assert result["attachment"]["status"] == "upload_failed"
    assert "timeout" in result["error"].lower()
    assert result["zotero_key"] == "PARENTKEY"


def test_partial_failure_preserves_the_existing_item_for_retry(workspace, monkeypatch):
    pdf_path = _pdf(workspace["root"] / "papers" / "paper.pdf", b"%PDF-1.7\n%%EOF\n")
    transport = FakeZotero(upload_status=500)
    _install_transport(monkeypatch, transport)

    result = _unwrap(_tool_call(monkeypatch, "10.1234/retry", pdf_path))

    # The half-written attachment is dropped, but the parent item is untouched.
    assert transport.deleted == ["https://api.zotero.org/users/123456/items/ATTKEY/file"]
    assert transport.stages().count("parent") == 1
    assert result["retry"]["action"] == "upload_attachment_to_existing_item"
    assert result["zotero_key"] == "PARENTKEY"


def test_failed_write_envelope_reports_the_api_message(workspace, monkeypatch):
    pdf_path = _pdf(workspace["root"] / "papers" / "paper.pdf", b"%PDF-1.7\n%%EOF\n")

    def post(url, **kwargs):
        if url.endswith("/items"):
            return _write_failed(400, "Invalid itemType")
        raise AssertionError(url)

    import requests
    monkeypatch.setattr(requests, "post", post)

    result = zotero.push_to_zotero(
        doi="10.1234/example", pdf_path=pdf_path,
        config={"zotero_api_key": "k", "zotero_library_type": "user", "zotero_library_id": "1"},
    )
    assert result["success"] is False
    assert "Invalid itemType" in result["error"]


def test_missing_local_pdf_is_reported_not_silently_skipped(workspace, monkeypatch):
    transport = FakeZotero()
    _install_transport(monkeypatch, transport)

    result = _unwrap(_tool_call(monkeypatch, "10.1234/gone", workspace["root"] / "papers" / "deleted.pdf"))

    assert result["success"] is False
    assert result["attachment"]["status"] == "rejected"
    assert transport.calls == []


def test_api_key_never_leaks_into_results_or_logs(workspace, monkeypatch, caplog):
    pdf_path = _pdf(workspace["root"] / "papers" / "paper.pdf", b"%PDF-1.7\n%%EOF\n")
    transport = FakeZotero(upload_status=500)
    _install_transport(monkeypatch, transport)

    with caplog.at_level("WARNING", logger=zotero.log.name):
        result = _unwrap(_tool_call(monkeypatch, "10.1234/leak", pdf_path))

    assert result["success"] is False
    assert "SECRET-API-KEY" not in json.dumps(result)
    assert not any("SECRET-API-KEY" in record.getMessage() for record in caplog.records)


def test_no_pdf_is_a_clean_success(workspace, monkeypatch):
    transport = FakeZotero()
    _install_transport(monkeypatch, transport)

    result = zotero.push_to_zotero(
        doi="10.1234/nopdf", pdf_path=None,
        config={"zotero_api_key": "k", "zotero_library_type": "user", "zotero_library_id": "1"},
    )
    assert result["success"] is True
    assert result["attachment"]["status"] == "not_requested"
    assert transport.stages() == ["parent"]