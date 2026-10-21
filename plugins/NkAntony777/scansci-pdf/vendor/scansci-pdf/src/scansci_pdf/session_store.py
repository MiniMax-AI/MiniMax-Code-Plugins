"""Shared cookie persistence for institutional access sessions."""

from __future__ import annotations

import json
import logging

from .proxy_redaction import redacting_logger
import time
from pathlib import Path
from typing import Any
from .security import secure_write_text, no_symlinks

logger = redacting_logger(__name__)


def credentials_for_target(*args, **kwargs):
    """Lazy re-export of the shared credential policy.

    Imported lazily to keep ``session_store`` free of an import cycle with
    ``browser_cookies`` (which imports nothing from here at module level).
    """
    from .browser_cookies import credentials_for_target as _impl

    return _impl(*args, **kwargs)


class CookieStore:
    """Persist browser cookies and load them into requests sessions."""

    def __init__(self, path: str | Path):
        self.path = Path(path)

    def load(self, *, now: float | None = None, target_url: str = "") -> list[dict[str, Any]]:
        """Load valid cookies from disk, scoped to ``target_url``.

        The same policy that governs save governs restore: without an explicit
        target nothing is returned, so a jar can never be replayed against a
        gateway it was not captured for.
        """
        no_symlinks(self.path)
        if not self.path.exists():
            return []

        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Failed to read cookies from %s: %s", self.path, exc)
            return []

        if not isinstance(raw, list):
            logger.warning("Cookie file %s does not contain a cookie list", self.path)
            return []

        now = time.time() if now is None else now
        # Missing security attributes cannot be reconstructed. Both browser
        # and HTTP consumers must re-authenticate rather than weaken a cookie.
        cookies = credentials_for_target(raw, None, target_url, now=now)
        return [c for c in cookies if self._is_valid(c, now)]

    def save(self, cookies: list[dict[str, Any]], *, now: float | None = None, target_url: str = "") -> list[dict[str, Any]]:
        """Save target-domain cookies and return the persisted list.

        Without ``target_url`` nothing is written: a full browser jar includes
        IdP and other-publisher sessions that must not be stored. Security and
        lifecycle attributes are preserved so an HttpOnly session does not come
        back page-script-readable.
        """
        now = time.time() if now is None else now
        valid = credentials_for_target(cookies, None, target_url, now=now)

        secure_write_text(self.path, json.dumps(valid, indent=2, ensure_ascii=False))
        return valid

    def load_into(self, session: Any, *, now: float | None = None, target_url: str = "") -> bool:
        """Load valid cookies into a requests-like session."""
        cookies = self.load(now=now, target_url=target_url)
        self.apply_to_session(session, cookies)
        return bool(cookies)

    @staticmethod
    def apply_to_session(session: Any, cookies: list[dict[str, Any]]) -> None:
        """Apply cookies to a requests-like session cookie jar."""
        for cookie in cookies:
            name = cookie.get("name")
            value = cookie.get("value")
            if name is None or value is None:
                continue
            session.cookies.set(
                name,
                value,
                domain=cookie.get("domain", ""),
                path=cookie.get("path", "/"),
                secure=bool(cookie.get("secure", False)),
                expires=(cookie["expires"] if cookie.get("expires", -1) > 0 else None),
                rest={key: cookie[field] for key, field in
                      (("HttpOnly", "httpOnly"), ("SameSite", "sameSite")) if field in cookie},
            )

    @staticmethod
    def _limit_to_target(cookies: list[dict[str, Any]], target_url: str) -> list[dict[str, Any]]:
        from urllib.parse import urlparse

        from .browser_cookies import _covers_host

        host = (urlparse(target_url or "").hostname or "").lower()
        if not host:
            return []
        return [cookie for cookie in cookies if _covers_host(cookie.get("domain", ""), host)]

    @staticmethod
    def _is_valid(cookie: dict[str, Any], now: float) -> bool:
        if cookie.get("name") is None or cookie.get("value") is None:
            return False

        expires = cookie.get("expires", 0)
        if not expires or expires <= 0:
            return True
        try:
            return float(expires) > now
        except (TypeError, ValueError):
            return False
