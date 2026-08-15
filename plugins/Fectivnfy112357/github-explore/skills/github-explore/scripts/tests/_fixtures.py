"""Shared test fixtures for the github-explore test suite.

Importing from this module keeps fake subprocess results in one place, so
the shape of `subprocess.CompletedProcess` is defined exactly once.
"""
from __future__ import annotations


class FakeProc:
    """Minimal stand-in for `subprocess.CompletedProcess` in unit tests.

    Mirrors the three attributes read by `_lib` and the entry-point scripts:
    `returncode`, `stdout`, `stderr`. Tests should pass an instance to
    `mock.patch.object(subprocess, "run", return_value=FakeProc(...))` or to
    `_lib.run_gh` when only the args are interesting.
    """

    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
