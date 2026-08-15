"""Shared test fixtures for the searxng-search test suite."""
from __future__ import annotations

import urllib.error


class FakeResponse:
    """Minimal stand-in for the context manager returned by `urlopen`."""

    def __init__(self, body: bytes = b"", status: int = 200) -> None:
        self._body = body
        self.status = status

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeHTTPError(urllib.error.HTTPError):
    """Fake HTTPError for testing the error path. Subclasses
    `urllib.error.HTTPError` so the script's `except` clause matches.
    """

    class _FP:
        def __init__(self, body: bytes):
            self._body = body

        def read(self) -> bytes:
            return self._body

    def __init__(self, code: int, body: bytes = b"", reason: str = "HTTP Error") -> None:
        super().__init__(
            url="http://dummy.local/",
            code=code,
            msg=reason,
            hdrs=None,
            fp=FakeHTTPError._FP(body),
        )
        self._body = body

    def read(self) -> bytes:
        return self._body
