#!/usr/bin/env python3
"""Stdin-to-stdout credential redactor.

Use when piping raw `gh` command output (stderr merged via `2>&1`) into
the agent transcript:

    gh <cmd> 2>&1 | python scripts/redact_stderr.py

The agent runs `gh` directly via the Bash tool, so the Python wrapper in
_lib is not on the path for those commands. This script makes that path
opt-in. Reuses `_lib.redact_secrets()` (fine-grained PAT, classic PAT,
Bearer token, key=value patterns, GH_TOKEN/GITHUB_TOKEN env form).

Reconfiguration to UTF-8 mirrors _lib so Windows PowerShell hosts don't
mojibake the bytes between `gh` and us. Best-effort only: a non-standard
secret shape is still your problem to scrub before sharing.

Exit codes: 0 on success, 2 on argument error. Never raises on
encoding/IO errors from the pipe side.
"""
from __future__ import annotations

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import _lib  # noqa: E402


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Read stdin, redact credential-shaped substrings, write to stdout.",
    )
    return p


def main() -> int:
    _build_parser().parse_args()  # validates CLI; no flags currently

    raw = sys.stdin.read()
    out = _lib.redact_secrets(raw)
    # Write to the underlying buffer to avoid Windows text-mode \n -> \r\n
    # translation. The pipe is meant to be byte-transparent so the downstream
    # consumer sees the same line endings `gh` produced.
    sys.stdout.buffer.write(out.encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
