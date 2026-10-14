"""Shared redaction at log, result, and exception boundaries."""

from __future__ import annotations

import logging
import builtins
import sys
import json
import os
import re
import threading
from urllib.parse import quote
from typing import Any

_SECRETS: set[str] = set()
_LOCK = threading.RLock()
_SECRET_KEY = re.compile(r"api.?key|private.?key|(?:access|refresh|inst|auth)?token|secret|password|credential|cookie", re.I)


def register_config_secrets(config: dict) -> None:
    """Remember secret values before any validation/error can echo them."""
    with _LOCK:
        for key, value in config.items():
            sensitive = _SECRET_KEY.search(str(key)) or "key" in str(key).lower()
            if sensitive and isinstance(value, str) and value:
                _SECRETS.update((value, quote(value, safe=""), json.dumps(value)[1:-1]))


def redact_proxy_text(value: object) -> str:
    """Mask embedded proxy passwords using the config display policy."""
    # Lazy import keeps config, transport, and logging imports independent.
    from .config import mask_config_value
    register_config_secrets({key: value for key, value in os.environ.items()
                             if key.startswith(("SCANSCI_", "ZOTERO_", "ELSEVIER_"))})
    text = str(mask_config_value("network_proxy", str(value)))
    with _LOCK:
        for secret in sorted(_SECRETS, key=len, reverse=True):
            text = text.replace(secret, "***")
    return text


def redact_proxy_structure(value: Any, _seen: set[int] | None = None) -> Any:
    """Redact every string and mapping key, including deeply nested results.

    Recursive containers become a visible marker rather than an unfiltered
    subtree. Shared containers that are not recursive retain their shape.
    """
    if isinstance(value, str):
        return redact_proxy_text(value)
    if isinstance(value, BaseException):
        return redact_proxy_text(value)
    if not isinstance(value, (dict, list, tuple, set, frozenset)):
        return value
    seen = set() if _seen is None else _seen
    identity = id(value)
    if identity in seen:
        return "<recursive result>"
    seen.add(identity)
    try:
        if isinstance(value, dict):
            return {redact_proxy_structure(key, seen): "***" if _SECRET_KEY.search(str(key))
                    else redact_proxy_structure(item, seen)
                    for key, item in value.items()}
        items = [redact_proxy_structure(item, seen) for item in value]
        if isinstance(value, tuple):
            return tuple(items)
        if isinstance(value, (set, frozenset)):
            return type(value)(items)
        return items
    finally:
        seen.remove(identity)


class _ProxyLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # Redact before any handler (including caplog and file handlers) sees
        # the record, preserving ordinary logging formatting and severity.
        record.msg = redact_proxy_text(record.getMessage())
        record.args = ()
        if record.exc_info:
            record.exc_text = redact_proxy_text(
                logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        elif record.exc_text:
            record.exc_text = redact_proxy_text(record.exc_text)
        if record.stack_info:
            record.stack_info = redact_proxy_text(record.stack_info)
        return True


def redacting_logger(name: str) -> logging.Logger:
    """Get an engine logger with redaction before propagation to handlers."""
    logger = logging.getLogger(name)
    if not any(isinstance(item, _ProxyLogFilter) for item in logger.filters):
        logger.addFilter(_ProxyLogFilter())
    return logger


def redacting_console(**options):
    """Create a Rich console that also filters tables and rendered objects."""
    from rich.console import Console

    class RedactingConsole(Console):
        def _render_buffer(self, buffer):
            return redact_proxy_text(super()._render_buffer(buffer))

        def print(self, *objects, **kwargs):
            return super().print(*(redact_proxy_structure(item) for item in objects), **kwargs)

    return RedactingConsole(**options)


class _RedactingStream:
    """Filter text writes, retaining partial secrets across write/flush calls."""

    def __init__(self, stream):
        self._stream = stream
        self._pending = ""
        self._lock = threading.RLock()

    def __getattr__(self, name):
        return getattr(self._stream, name)

    def write(self, text):
        with self._lock:
            self._pending += str(text)
            if "\n" in self._pending or "\r" in self._pending or len(self._pending) >= 65536:
                self.flush()
        return len(text)

    def flush(self):
        with self._lock:
            text = redact_proxy_text(self._pending)
            keep = 0
            with _LOCK:
                for secret in _SECRETS:
                    for length in range(1, min(len(secret), len(text) + 1)):
                        if text.endswith(secret[:length]):
                            keep = max(keep, length)
            self._pending = text[-keep:] if keep else ""
            self._stream.write(text[:-keep] if keep else text)
            self._stream.flush()


def install_secret_egress() -> None:
    """Cover legacy print() calls as well as uncaught Python tracebacks."""
    if getattr(builtins.print, "_scansci_redacted", False):
        return
    sys.stdout = _RedactingStream(sys.stdout)
    sys.stderr = _RedactingStream(sys.stderr)
    original = builtins.print

    def safe_print(*objects, **kwargs):
        for key in ("sep", "end"):
            if kwargs.get(key) is not None:
                kwargs[key] = redact_proxy_text(kwargs[key])
        return original(*(redact_proxy_text(item) for item in objects), **kwargs)

    safe_print._scansci_redacted = True
    builtins.print = safe_print
    factory = logging.getLogRecordFactory()

    def safe_record(*args, **kwargs):
        record = factory(*args, **kwargs)
        record.msg = redact_proxy_text(record.getMessage())
        record.args = ()
        if record.exc_info:
            record.msg += "\n" + redact_proxy_text(logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        if record.stack_info:
            record.stack_info = redact_proxy_text(record.stack_info)
        return record

    logging.setLogRecordFactory(safe_record)

    def exception_hook(kind, value, tb):
        import traceback
        sys.stderr.write(redact_proxy_text("".join(traceback.format_exception(kind, value, tb))))

    sys.excepthook = exception_hook
