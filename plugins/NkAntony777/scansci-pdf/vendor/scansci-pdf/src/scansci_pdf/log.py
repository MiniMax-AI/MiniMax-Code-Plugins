"""Logging setup for ScanSci PDF. Routes to stderr to avoid corrupting MCP stdio."""

from __future__ import annotations

import logging
import sys

_logger: logging.Logger | None = None


def get_logger() -> logging.Logger:
    global _logger
    if _logger is None:
        _logger = logging.getLogger("scansci_pdf")
        if not _logger.handlers:
            handler = logging.StreamHandler(sys.stderr)
            handler.setFormatter(logging.Formatter("[%(levelname)s] %(message)s"))
            _logger.addHandler(handler)
            _logger.setLevel(logging.INFO)
    return _logger
