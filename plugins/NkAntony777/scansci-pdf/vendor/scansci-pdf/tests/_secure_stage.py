"""Copy the shipped engine unchanged for launcher integration tests.

Positive tests use the delivered manifest and dependency lock verbatim.
Negative tests may deliberately tamper with the copied bytes.
"""

from __future__ import annotations

import hashlib
import shutil
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


# Public: tests re-hash a staged file they deliberately edited.
digest = _digest


def installed_version(name: str) -> str:
    from importlib.metadata import version

    return version(name)



def stage_engine(destination: Path) -> Path:
    """Stage the exact shipped files, without repairing pins or manifests."""
    ignore = shutil.ignore_patterns(
        ".venv", "__pycache__", "*.pyc", ".pytest_cache", "*.egg-info", "uv.lock")
    shutil.copytree(ENGINE, destination, ignore=ignore)
    return destination


def python_executable() -> str:
    """The interpreter whose installed packages the dependency gate checks."""
    return sys.executable



def main() -> int:
    destination = Path(sys.argv[1])
    stage_engine(destination)
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
