"""Provenance gate for browser executables.

A browser binary is executable code that this engine launches. Unlike paper
content (always data), it must come from a location the owner controls and
must not be swapped underneath us. This module enforces three properties
before any binary is accepted:

1. **Allowlisted location** — the binary lives under a real system browser
   install root, or under the engine's own cache. Arbitrary configured paths
   are rejected unless the owner opts in explicitly.
2. **No symlinks/junctions** — reuses :func:`security.no_symlinks`, the same
   gate the rest of the package applies, so the policy is consistent instead
   of being re-implemented (and weakened) per call site.
3. **Pinned identity** — the resolved file's hash must match a recorded
   allowlist entry, when one is configured. A mismatch is a hard failure.

Provenance here means *this file is the one the owner approved*: path
allowlist plus recorded content hash. It is not a vendor code-signature
check; release signatures are not available on every supported platform and
are not claimed.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

from .security import SecurityError, no_symlinks

# Vendor install roots. A binary is accepted if its resolved path stays under
# one of these. Kept as prefixes so a versioned subdirectory (Chrome/Application)
# and a future beta channel are both covered without editing this table per build.
_SYSTEM_ROOTS_WINDOWS = (
    r"C:\Program Files\Google\Chrome",
    r"C:\Program Files (x86)\Google\Chrome",
    r"C:\Program Files\Microsoft\Edge",
    r"C:\Program Files (x86)\Microsoft\Edge",
    r"C:\Program Files\Mozilla Firefox",
    r"C:\Program Files (x86)\Mozilla Firefox",
)

_SYSTEM_ROOTS_POSIX = (
    "/Applications/Google Chrome.app",
    "/Applications/Microsoft Edge.app",
    "/Applications/Firefox.app",
    "/opt/google/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/firefox",
    "/snap/bin/chromium",
)

# Suffixes that identify a launcher rather than the browser payload itself.
_LAUNCHER_SUFFIXES = ("chrome", "msedge", "firefox", "google-chrome", "chromium", "chromium-browser")

# Owner opt-in: accept any explicitly configured path after the symlink gate.
# Off by default, because a configured path is the least trustworthy input.
_OPT_IN_ENV = "SCANSCI_PDF_TRUST_BROWSER_PATH"

_DIGEST_CHUNK = 1024 * 1024


def _cache_root() -> Path | None:
    """The engine's own browser cache, which the owner populated deliberately."""
    try:
        from .config import DATA_DIR
    except Exception:  # pragma: no cover - config import must never break launch
        return None
    if not DATA_DIR:
        return None
    return Path(DATA_DIR) / "cache" / "browser"


def _system_roots() -> tuple[str, ...]:
    return _SYSTEM_ROOTS_WINDOWS if os.name == "nt" else _SYSTEM_ROOTS_POSIX


def _under(path: Path, root: Path) -> bool:
    try:
        return path == root or path.is_relative_to(root)
    except (ValueError, OSError):
        return False


def _looks_like_browser(path: Path) -> bool:
    """Accept only the canonical launcher name inside an allowlisted root.

    A directory that merely *starts with* an allowlisted prefix is not enough:
    a sibling such as ``Google\\ChromeEvil\\x.exe`` must not pass. Requiring the
    launcher basename keeps the prefix check meaningful.
    """
    return path.name.lower().startswith(_LAUNCHER_SUFFIXES)


def file_digest(path: str | Path) -> str:
    """SHA-256 of a file, read in bounded chunks."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(_DIGEST_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def expected_digest(config: dict[str, Any] | None, path: Path) -> str | None:
    """Recorded digest for this binary, if the owner pinned one."""
    pins = (config or {}).get("browser_binary_sha256") or {}
    if isinstance(pins, str):
        return pins.strip().lower() or None
    if not isinstance(pins, dict):
        return None
    for key in (str(path), path.name):
        value = pins.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    return None


def verify_browser_executable(candidate: str | Path, config: dict[str, Any] | None = None) -> Path:
    """Return the verified absolute path, or raise :class:`SecurityError`.

    Call this at the point a binary is about to be handed to a launcher. It is
    intentionally cheap enough to run per launch and strict enough that an
    unapproved binary is refused rather than silently trusted.
    """
    raw = str(candidate).strip()
    if not raw:
        raise SecurityError("Browser executable path is empty")

    path = Path(os.path.abspath(Path(raw).expanduser()))

    if not path.is_file():
        raise SecurityError(f"Browser executable not found: {path}")

    # Same gate as every other path this engine trusts; not a second, weaker one.
    no_symlinks(path)

    if os.environ.get(_OPT_IN_ENV, "").strip().lower() in {"1", "true", "yes"}:
        return path

    allowed = [root for root in _system_roots() if _under(path, Path(os.path.abspath(root)))]
    cache = _cache_root()
    if cache is not None and _under(path, Path(os.path.abspath(cache))):
        allowed.append(str(cache))
    if not allowed or not _looks_like_browser(path):
        raise SecurityError(
            f"Browser executable is outside the allowlisted browser roots: {path}. "
            f"Install Chrome/Edge/Firefox in a standard location, or set {_OPT_IN_ENV}=1 "
            "to trust a custom path explicitly."
        )

    pinned = expected_digest(config, path)
    if pinned:
        actual = file_digest(path)
        if actual != pinned:
            raise SecurityError(
                f"Browser executable digest does not match the pinned value: {path}"
            )
    return path


def is_verified(candidate: str | Path, config: dict[str, Any] | None = None) -> bool:
    """Boolean form of :func:`verify_browser_executable` for diagnostics."""
    try:
        verify_browser_executable(candidate, config)
    except SecurityError:
        return False
    return True