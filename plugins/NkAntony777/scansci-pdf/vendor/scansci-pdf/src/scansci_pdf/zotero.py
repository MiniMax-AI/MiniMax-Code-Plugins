"""Zotero integration via PyZotero API."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from .log import get_logger
from .path_guard import resolve_attachment
from .security import SecurityError

log = get_logger()

# The attachment is a PDF: nothing else may be uploaded as application/pdf.
ATTACHMENT_SUFFIXES = frozenset({".pdf"})

# Zotero write responses use a per-index envelope; a partial failure lands in
# "failed" with a code and a message worth surfacing to the user.
_OK_STATUS = (200, 201)


def _get_zotero_config(config: dict[str, Any]) -> tuple[str, str] | None:
    """Get Zotero API key and library info from config."""
    api_key = config.get("zotero_api_key", "")
    library_type = config.get("zotero_library_type", "user")  # "user" or "group"
    library_id = config.get("zotero_library_id", "")

    if not api_key:
        return None
    return api_key, f"{library_type}s/{library_id}" if library_id else ""


def _scrub(text: str, secret: str) -> str:
    """Remove the API key from anything user-visible or logged."""
    message = str(text)
    if secret:
        message = message.replace(secret, "***")
    return message


def _response_json(response: Any) -> dict[str, Any]:
    """Parse a Zotero response body, tolerating the empty 200 bodies."""
    try:
        payload = response.json()
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _write_failure_detail(result: dict[str, Any]) -> str:
    """Describe why a Zotero write reported no successful object."""
    failed = result.get("failed")
    if isinstance(failed, dict) and failed:
        messages = []
        for item in failed.values():
            if isinstance(item, dict):
                code = item.get("code")
                message = item.get("message") or item.get("data", {})
                messages.append(f"{code}: {message}" if code else str(message))
        if messages:
            return "; ".join(messages)
    return ""


def push_to_zotero(
    doi: str,
    pdf_path: Path | None,
    config: dict[str, Any],
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Push a paper and its PDF to Zotero.

    Returns a dict that separates the three stages the caller cares about:
    whether the parent item was created, whether the attachment item was
    created, and whether the file actually reached Zotero. A requested PDF
    that did not upload is never reported as an unqualified success — the
    already-created ``zotero_key`` is preserved so the upload can be retried
    against it instead of creating a duplicate item.
    """
    import requests

    requested = pdf_path is not None

    def _not_started(error: str) -> dict[str, Any]:
        return {
            "success": False,
            "error": error,
            "item_created": False,
            "attachment": {"requested": requested, "status": "not_attempted"},
        }

    creds = _get_zotero_config(config)
    if not creds:
        return _not_started("Zotero API key not configured")

    api_key, library_path = creds
    if not library_path:
        return _not_started("Zotero library_id not configured")

    base_url = f"https://api.zotero.org/{library_path}"
    headers = {
        "Zotero-API-Key": api_key,
        "Content-Type": "application/json",
    }

    # Final read boundary, first half: refuse an unusable attachment BEFORE any
    # remote item exists, so a bad cached path never leaves an orphan item and
    # the outside file is never opened. Checking the argument or the cache
    # record alone is not enough — this runs on the value about to be opened.
    source: Path | None = None
    if requested:
        try:
            source = resolve_attachment(pdf_path, suffixes=ATTACHMENT_SUFFIXES)
        except SecurityError as exc:
            reason = _scrub(str(exc), api_key)
            return {
                "success": False,
                "error": f"Attachment rejected: {reason}",
                "item_created": False,
                "attachment": {
                    "requested": True,
                    "status": "rejected",
                    "filename": Path(str(pdf_path)).name,
                    "error": reason,
                },
            }

    # Build item from metadata or DOI
    if metadata:
        item_data = _metadata_to_zotero_item(metadata, doi)
    else:
        # Use DOI to create a minimal item
        item_data = {
            "itemType": "journalArticle",
            "DOI": doi,
            "url": f"https://doi.org/{doi}",
        }

    # Create item
    try:
        resp = requests.post(
            f"{base_url}/items",
            headers=headers,
            json=[item_data],
            timeout=30,
        )
        if resp.status_code not in _OK_STATUS:
            return _not_started(f"Zotero API error: {resp.status_code}")

        result = _response_json(resp)
        if not (result.get("success") or result.get("successful")):
            detail = _write_failure_detail(result) or "No successful items"
            return _not_started(_scrub(detail, api_key))

        zotero_key = _created_object_key(result)
        if not zotero_key:
            return _not_started(_scrub(_write_failure_detail(result) or "No key returned", api_key))
    except Exception as e:
        return _not_started(_scrub(e, api_key))

    log.info(f"Zotero: created item {zotero_key}")

    if source is None:
        return {
            "success": True,
            "zotero_key": zotero_key,
            "item_created": True,
            "attachment": {"requested": False, "status": "not_requested"},
        }

    upload = _upload_attachment(base_url, headers, zotero_key, source, api_key)
    attachment = {"requested": True, **upload}
    if upload["status"] == "uploaded":
        return {
            "success": True,
            "zotero_key": zotero_key,
            "item_created": True,
            "attachment": attachment,
        }

    # Partial failure: the parent item exists, the PDF does not. Keep the key
    # so a retry uploads the file against the existing item rather than
    # silently creating a second one.
    error = _scrub(
        f"Zotero item {zotero_key} was created but the PDF attachment was not "
        f"uploaded ({upload['status']}): {upload.get('error') or 'unknown error'}",
        api_key,
    )
    log.warning(error)
    return {
        "success": False,
        "partial": True,
        "error": error,
        "item_created": True,
        "zotero_key": zotero_key,
        "attachment": attachment,
        "retry": {
            "action": "upload_attachment_to_existing_item",
            "zotero_key": zotero_key,
            "note": "The item already exists in Zotero; retry the file upload against this key.",
        },
    }


def _metadata_to_zotero_item(msg: dict[str, Any], doi: str) -> dict[str, Any]:
    """Convert Crossref metadata to Zotero item format."""
    item: dict[str, Any] = {
        "itemType": "journalArticle",
        "DOI": doi,
        "url": f"https://doi.org/{doi}",
    }

    # Title
    titles = msg.get("title", [])
    if titles:
        item["title"] = titles[0] if isinstance(titles, list) else titles

    # Authors
    authors = msg.get("author", [])
    if authors:
        creators = []
        for a in authors:
            creators.append({
                "creatorType": "author",
                "firstName": a.get("given", ""),
                "lastName": a.get("family", ""),
            })
        item["creators"] = creators

    # Journal
    container = msg.get("container-title", [])
    if container:
        item["publicationTitle"] = container[0]

    # Year
    parts = msg.get("published-print", msg.get("published-online", msg.get("created", {})))
    date_parts = parts.get("date-parts", [[]]) if isinstance(parts, dict) else [[]]
    if date_parts and date_parts[0]:
        item["date"] = str(date_parts[0][0])

    # Volume, Issue, Pages
    if msg.get("volume"):
        item["volume"] = str(msg["volume"])
    if msg.get("issue"):
        item["issue"] = str(msg["issue"])
    if msg.get("page"):
        item["pages"] = msg["page"]

    # Abstract
    if msg.get("abstract"):
        import re
        item["abstractNote"] = re.sub(r"<[^>]+>", "", msg["abstract"]).strip()

    return item


def _md5_of(path: Path) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _upload_attachment(
    base_url: str,
    headers: dict[str, str],
    parent_key: str,
    pdf_path: Path,
    api_key: str | None = None,
) -> dict[str, Any]:
    """Upload a PDF as an attachment to a Zotero item.

    Follows the Zotero Web API upload sequence so each stage can fail on its
    own terms: create the attachment item, request authorization for it, then
    push the file to the returned storage URL. Returns a stage-tagged dict
    (``uploaded`` / ``create_failed`` / ``authorize_failed`` /
    ``upload_failed`` / ``rejected`` / ``error``) rather than a bare bool, so
    the caller can never mistake an empty attachment for a finished one.
    """
    import requests

    secret = api_key if api_key is not None else headers.get("Zotero-API-Key", "")

    def _fail(status: str, error: str, attachment_key: str | None = None) -> dict[str, Any]:
        return {
            "status": status,
            "attachment_key": attachment_key,
            "error": _scrub(error, secret),
        }

    # Final read boundary, second half: re-validate immediately before the
    # first read. A value that changed between the early check and here — a
    # replaced cache entry, a freshly planted symlink — still cannot escape.
    try:
        source = resolve_attachment(pdf_path, suffixes=ATTACHMENT_SUFFIXES)
    except SecurityError as exc:
        return _fail("rejected", str(exc))

    def _cleanup(attachment_key: str) -> None:
        # Best effort: drop a half-written attachment so a retry is clean.
        try:
            requests.delete(
                f"{base_url}/items/{attachment_key}/file",
                headers={"Zotero-API-Key": secret},
                timeout=30,
            )
        except Exception:
            pass

    # 1. Create the attachment item (no file content is sent yet).
    attachment_data = {
        "itemType": "attachment",
        "linkMode": "imported_file",
        "contentType": "application/pdf",
        "filename": source.name,
        "parentItem": parent_key,
    }

    try:
        resp = requests.post(
            f"{base_url}/items",
            headers=headers,
            json=[attachment_data],
            timeout=30,
        )
    except Exception as e:
        return _fail("create_failed", f"attachment create request failed: {e}")

    if resp.status_code not in _OK_STATUS:
        return _fail("create_failed", f"attachment item creation returned HTTP {resp.status_code}")

    result = _response_json(resp)
    att_key = _created_object_key(result)
    if not att_key:
        return _fail("create_failed", _write_failure_detail(result) or "attachment create returned no key")

    log.info(f"Zotero: created attachment item {att_key} on {parent_key}")

    # 2. Request upload authorization for the attachment.
    try:
        stat = source.stat()
        form = {
            "md5": _md5_of(source),
            "filename": source.name,
            "filesize": str(stat.st_size),
            "mtime": str(int(stat.st_mtime * 1000)),
        }
        resp = requests.post(
            f"{base_url}/items/{att_key}/file",
            headers={
                "Zotero-API-Key": secret,
                "Content-Type": "application/x-www-form-urlencoded",
                "If-None-Match": "*",
            },
            data=form,
            timeout=30,
        )
    except Exception as e:
        _cleanup(att_key)
        return _fail("authorize_failed", f"upload authorization failed: {e}", att_key)

    if resp.status_code not in _OK_STATUS:
        _cleanup(att_key)
        return _fail("authorize_failed", f"upload authorization returned HTTP {resp.status_code}", att_key)

    payload = _response_json(resp)
    if not payload:
        # Zotero answers 200 with an empty body when an identical file is
        # already attached; the attachment is complete.
        log.info(f"Zotero: attachment {att_key} already holds this file")
        return {"status": "uploaded", "attachment_key": att_key, "error": None,
                "filename": source.name, "already_attached": True}

    upload_url = payload.get("url")
    if not upload_url:
        _cleanup(att_key)
        return _fail("authorize_failed", "authorization response contained no upload URL", att_key)

    prefix = payload.get("prefix") or ""
    content_type = payload.get("contentType") or "application/pdf"

    # 3. Push the leading bytes when the server split the upload.
    if prefix:
        try:
            resp = requests.post(
                upload_url,
                headers={"Content-Type": content_type},
                data=prefix.encode("utf-8"),
                timeout=120,
            )
        except Exception as e:
            _cleanup(att_key)
            return _fail("upload_failed", f"prefix upload failed: {e}", att_key)
        if resp.status_code not in _OK_STATUS:
            _cleanup(att_key)
            return _fail("upload_failed", f"prefix upload returned HTTP {resp.status_code}", att_key)

    # 4. Push the file itself. Opened only after the boundary check above.
    try:
        with source.open("rb") as f:
            resp = requests.post(
                upload_url,
                headers={
                    "Authorization": f"Bearer {secret}",
                    "Content-Type": content_type,
                },
                data=f,
                timeout=300,
            )
    except Exception as e:
        _cleanup(att_key)
        return _fail("upload_failed", f"file upload failed: {e}", att_key)

    if resp.status_code not in _OK_STATUS:
        _cleanup(att_key)
        return _fail("upload_failed", f"file upload returned HTTP {resp.status_code}", att_key)

    log.info(f"Zotero: uploaded PDF {source.name}")
    return {"status": "uploaded", "attachment_key": att_key, "error": None,
            "filename": source.name}


def _created_object_key(result: dict[str, Any]) -> str | None:
    """Extract the Zotero object key from a write response."""
    successful = result.get("successful") or result.get("success") or {}
    if not successful:
        return None

    saved_object = next(iter(successful.values()))
    if isinstance(saved_object, str):
        return saved_object
    if isinstance(saved_object, dict):
        key = saved_object.get("key")
        if isinstance(key, str):
            return key
        data = saved_object.get("data", {})
        if isinstance(data, dict) and isinstance(data.get("key"), str):
            return data["key"]

    return None