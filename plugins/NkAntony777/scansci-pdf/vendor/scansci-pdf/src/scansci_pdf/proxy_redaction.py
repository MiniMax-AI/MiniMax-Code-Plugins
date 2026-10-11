"""Shared redaction at log, result, and exception boundaries."""

from __future__ import annotations

import logging
from typing import Any


def redact_proxy_text(value: object) -> str:
    """Mask embedded proxy passwords using the config display policy."""
    # Lazy import keeps config, transport, and logging imports independent.
    from .config import mask_config_value
    return str(mask_config_value("network_proxy", str(value)))


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
            return {redact_proxy_structure(key, seen): redact_proxy_structure(item, seen)
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
