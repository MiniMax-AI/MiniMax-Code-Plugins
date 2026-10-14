"""Local open-source maintenance fixtures; no live accounts or services."""

from __future__ import annotations

import json
from urllib.parse import quote, urlsplit

import pytest
import requests
from urllib3.exceptions import MaxRetryError, NewConnectionError

from scansci_pdf import config as cfg, server, zotero
from scansci_pdf.config_trust import is_trust_sensitive
from scansci_pdf.schools import list_schools
from scansci_pdf.security import SecurityError
from scansci_pdf.sources.instsci import _get_webvpn_base


pytestmark = pytest.mark.filterwarnings("ignore:Unknown config key 'instsci_school':UserWarning")


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        pytest.fail("maintenance fixtures must not make network requests")

    monkeypatch.setattr(requests.sessions.Session, "request", refuse)


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(tmp_path))
    monkeypatch.setattr(cfg, "DATA_DIR", tmp_path / ".scansci-pdf")
    monkeypatch.setattr(cfg, "CONFIG_FILE", tmp_path / ".scansci-pdf" / "config.json")
    monkeypatch.setitem(cfg.DEFAULT_CONFIG, "cache_dir", str(tmp_path / "cache"))
    monkeypatch.setitem(cfg.DEFAULT_CONFIG, "output_dir", str(tmp_path / "papers"))
    cfg.save_config(cfg.load_config())
    return tmp_path


@pytest.fixture
def school():
    return next(entry for entry in list_schools() if entry.school_type == "webvpn")


def _unwrap(payload):
    outer = json.loads(payload)
    inner = outer.get("result", outer)
    return json.loads(inner) if isinstance(inner, str) else inner


@pytest.mark.parametrize("key", ["vpnsci_school", "instsci_school"])
@pytest.mark.parametrize("confirmation", [False, None, 1, "true", "false"])
def test_school_selectors_require_boolean_confirmation(workspace, school, key, confirmation):
    assert is_trust_sensitive(key)
    assert _get_webvpn_base({key: school.name}) == school.host.rstrip("/")
    before = cfg.CONFIG_FILE.read_bytes()
    with pytest.raises(ValueError, match="confirmation required"):
        cfg.update_config(key, school.name, confirmed=confirmation)
    assert cfg.CONFIG_FILE.read_bytes() == before


@pytest.mark.parametrize("key", ["vpnsci_school", "instsci_school"])
def test_direct_bulk_and_mcp_school_writes_share_confirmation(workspace, school, key):
    before = cfg.CONFIG_FILE.read_bytes()
    proposed = {**cfg.load_config(), key: school.name, "email": "must-not-partially-save@example.invalid"}
    for confirmation in (False, 1, "true"):
        with pytest.raises(ValueError, match="confirmation required"):
            cfg.save_config(proposed, confirmed=confirmation)
        assert cfg.CONFIG_FILE.read_bytes() == before

    denied = _unwrap(server.scansci_pdf_config(key=key, value=school.name))
    assert denied["success"] is False
    assert cfg.CONFIG_FILE.read_bytes() == before

    accepted = _unwrap(server.scansci_pdf_config(key=key, value=school.name, confirmed=True))
    assert accepted["success"] is True
    assert cfg.load_config()[key] == school.name
    before = cfg.CONFIG_FILE.read_bytes()
    cfg.update_config(key, school.name)
    cfg.save_config(cfg.load_config())
    noop = _unwrap(server.scansci_pdf_config(key=key, value=school.name))
    assert noop["success"] is True
    assert cfg.CONFIG_FILE.read_bytes() == before
    cfg.save_config(proposed, confirmed=True)
    assert cfg.load_config()["email"] == proposed["email"]


def test_school_tool_applies_one_atomic_config_and_preserves_rejections(workspace, school, monkeypatch):
    snapshots = []

    def record_save(config, *, confirmed=False):
        snapshots.append(dict(config))
        cfg.save_config(config, confirmed=confirmed)

    monkeypatch.setattr(server, "save_config", record_save)
    before = cfg.CONFIG_FILE.read_bytes()
    denied = _unwrap(server.scansci_pdf_schools(action="set", school=school.name))
    assert denied["success"] is False
    assert "confirmation required" in denied["error"]
    assert len(snapshots) == 1
    assert cfg.CONFIG_FILE.read_bytes() == before

    snapshots.clear()
    accepted = _unwrap(server.scansci_pdf_schools(action="set", school=school.name, confirmed=True))
    assert accepted["success"] is True
    assert len(snapshots) == 1
    config = cfg.load_config()
    assert config["vpnsci_school"] == school.name
    assert config["vpnsci_base_url"] == school.host
    assert config["vpnsci_enabled"] is True
    assert _get_webvpn_base(config) == school.host.rstrip("/")

    before = cfg.CONFIG_FILE.read_bytes()
    noop = _unwrap(server.scansci_pdf_schools(action="set", school=school.name))
    assert noop["success"] is True
    assert cfg.CONFIG_FILE.read_bytes() == before
    missing = _unwrap(server.scansci_pdf_schools(action="set", school="SYNTHETIC-MISSING-SCHOOL", confirmed=True))
    assert missing["success"] is False
    assert cfg.CONFIG_FILE.read_bytes() == before
    found = _unwrap(server.scansci_pdf_schools(query=school.name))
    assert found["total"] >= 1
    assert cfg.CONFIG_FILE.read_bytes() == before


@pytest.mark.parametrize("confirmation", [1, "true", "false"])
def test_legacy_school_function_does_not_coerce_confirmation(workspace, school, confirmation):
    before = cfg.CONFIG_FILE.read_bytes()
    result = _unwrap(server.scansci_pdf_vpnsci_set_school(school.name, confirmed=confirmation))
    assert result["success"] is False
    assert cfg.CONFIG_FILE.read_bytes() == before


class _Response:
    def __init__(self, status, payload):
        self.status_code, self.payload = status, payload

    def json(self):
        return self.payload


class _SignedUpload:
    api_key = "SYNTHETIC-API-KEY-58134"
    upload_key = "SYNTHETIC-UPLOAD-KEY-73925"
    signature = "SYNTHETIC-SIGNATURE/with+encoded=characters-63928"
    token = "SYNTHETIC-SESSION-TOKEN-58372"
    prefix = "SYNTHETIC-PREFIX-AUTH-59382"

    def __init__(self, *, failure="transport", representation="raw"):
        self.failure, self.representation = failure, representation
        self.url = (
            "https://zoterofilestorage.s3.amazonaws.com/upload?"
            "X-Amz-Signature=" + quote(self.signature, safe="")
            + "&X-Amz-Security-Token=" + self.token + "&X-Amz-Expires=300&partNumber=1"
        )
        self.calls = []
        self.streams = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if method == "DELETE":
            return _Response(204, {})
        if url == self.url:
            self.streams.append(b"".join(kwargs["data"]))
            if self.failure == "transport":
                path = urlsplit(url).path + "?" + urlsplit(url).query
                if self.representation == "decoded":
                    path = path.replace(quote(self.signature, safe=""), self.signature)
                error = NewConnectionError(None, "local fixture " + self.upload_key + " " + self.api_key)
                raise requests.ConnectionError(MaxRetryError(None, path, error))
            return _Response(201, {})
        if url.endswith("/items"):
            key = "ATTKEY1" if kwargs["json"][0]["itemType"] == "attachment" else "PARENTKEY1"
            return _Response(200, {"successful": {"0": {"key": key}}})
        if url.endswith("/file"):
            if "upload" in kwargs.get("data", {}):
                return _Response(204, {})
            return _Response(200, {"url": self.url, "uploadKey": self.upload_key,
                                   "prefix": self.prefix, "suffix": "END", "contentType": "application/pdf"})
        raise AssertionError("unexpected local fixture call")

    def config(self):
        return {"zotero_api_key": self.api_key, "zotero_library_id": "123456"}


def _assert_authorization_absent(transport, text):
    for secret in (transport.api_key, transport.upload_key, transport.signature,
                   quote(transport.signature, safe=""), transport.token, transport.prefix):
        assert secret not in text


@pytest.mark.parametrize("representation", ["raw", "decoded"])
def test_signed_storage_transport_errors_are_scrubbed_in_direct_results_and_logs(
    workspace, monkeypatch, caplog, representation,
):
    transport = _SignedUpload(representation=representation)
    monkeypatch.setattr(zotero, "confined_request", transport.request)
    pdf = workspace / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.7\n%%EOF\n")
    with caplog.at_level("WARNING", logger=zotero.log.name):
        result = zotero.push_to_zotero("10.1234/local", pdf, transport.config())
    assert result["success"] is False
    assert result["partial"] is True
    assert result["attachment"]["status"] == "upload_failed"
    _assert_authorization_absent(transport, json.dumps(result))
    _assert_authorization_absent(transport, caplog.text)


@pytest.mark.parametrize("stage", ["url", "prefix"])
def test_upload_authorization_is_registered_before_validation_errors(workspace, monkeypatch, stage):
    transport = _SignedUpload()
    monkeypatch.setattr(zotero, "confined_request", transport.request)
    if stage == "url":
        def reject(url):
            raise SecurityError("synthetic URL validation " + url + " " + transport.signature)

        monkeypatch.setattr(zotero, "validate_upload_url", reject)
    else:
        class _InvalidPrefix(str):
            def encode(self, *args, **kwargs):
                raise ValueError("synthetic prefix validation " + self + " " + transport.upload_key)

        transport.prefix = _InvalidPrefix(transport.prefix)
    pdf = workspace / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.7\n%%EOF\n")
    result = zotero._upload_attachment("https://api.zotero.org/users/123456",
                                      {"Zotero-API-Key": transport.api_key}, "PARENTKEY1", pdf)
    assert result["status"] == "authorize_failed"
    assert not transport.streams
    _assert_authorization_absent(transport, json.dumps(result))


def test_signed_storage_failure_is_scrubbed_through_actual_mcp_tool(workspace, monkeypatch, caplog):
    from scansci_pdf import cache, citation

    transport = _SignedUpload()
    monkeypatch.setattr(zotero, "confined_request", transport.request)
    monkeypatch.setattr(citation, "fetch_metadata", lambda *args: {"title": ["Local fixture"]})
    config = {**cfg.load_config(), **transport.config()}
    cfg.save_config(config)
    pdf = workspace / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.7\n%%EOF\n")
    cache.cache_set("10.1234/local-mcp", {"success": True, "file": str(pdf)}, config)
    with caplog.at_level("WARNING", logger=zotero.log.name):
        response = server.scansci_pdf_zotero_push("10.1234/local-mcp")
    assert _unwrap(response)["attachment"]["status"] == "upload_failed"
    _assert_authorization_absent(transport, response)
    _assert_authorization_absent(transport, caplog.text)


def test_signed_storage_success_retains_one_stream_and_api_registration(workspace, monkeypatch):
    from scansci_pdf.proxy_redaction import redact_proxy_text

    transport = _SignedUpload(failure=None)
    monkeypatch.setattr(zotero, "confined_request", transport.request)
    pdf = workspace / "paper.pdf"
    body = b"%PDF-1.7\n%%EOF\n"
    pdf.write_bytes(body)
    result = zotero.push_to_zotero("10.1234/local", pdf, transport.config())
    assert result["success"] is True
    assert result["zotero_key"] == "PARENTKEY1"
    assert result["attachment"]["status"] == "uploaded"
    assert result["attachment"]["attachment_key"] == "ATTKEY1"
    assert redact_proxy_text("300 seconds, part 1, DOI 10.1234/local, PARENTKEY1 ATTKEY1") == (
        "300 seconds, part 1, DOI 10.1234/local, PARENTKEY1 ATTKEY1"
    )
    assert transport.streams == [transport.prefix.encode() + body + b"END"]
    storage_calls = [(url, kwargs) for method, url, kwargs in transport.calls if url == transport.url]
    assert len(storage_calls) == 1
    assert zotero.validate_upload_url(storage_calls[0][0]) == transport.url
    assert "Zotero-API-Key" not in storage_calls[0][1]["headers"]
    assert "Authorization" not in storage_calls[0][1]["headers"]
    assert storage_calls[0][1]["headers"]["Content-Length"] == str(len(transport.streams[0]))
    registration = transport.calls[-1]
    assert registration[1] == "https://api.zotero.org/users/123456/items/ATTKEY1/file"
    assert registration[2]["data"] == {"upload": transport.upload_key}
    assert all(kwargs["allow_redirects"] is False for _, _, kwargs in transport.calls)
