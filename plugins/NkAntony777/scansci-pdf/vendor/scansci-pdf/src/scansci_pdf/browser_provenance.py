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
   allowlist entry, when one is configured. A mismatch is a hard failure, and
   a binary under the runtime-writable cache must always have one.

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
# "Google Chrome" is the macOS launcher name (inside the .app bundle).
_LAUNCHER_SUFFIXES = ("chrome", "msedge", "firefox", "google-chrome", "google chrome",
                      "chromium", "chromium-browser")

# Where Playwright's own ``channel=`` lookup lands on each platform. Used to
# resolve a channel to a concrete binary *before* launch, so the executable the
# launcher receives has already been through the gate — see
# :func:`resolve_channel_executable`.
_CHANNEL_CANDIDATES_WINDOWS = {
    "chrome": (
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    ),
    "msedge": (
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ),
}

_CHANNEL_CANDIDATES_POSIX = {
    "chrome": (
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/opt/google/chrome/chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
    ),
    "msedge": ("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",),
}

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
    """Immutable roots whose binaries may be trusted without a pinned digest.

    Per-user install roots are NOT listed: they live under the user's own
    profile, so anything running as that user can write there, and a browser
    resolved from them would be as trustworthy as a cache entry. A per-user
    install is still reachable — it just needs a pinned digest, exactly like a
    cached build, so the owner has to say which bytes they expect.
    """
    return _SYSTEM_ROOTS_WINDOWS if os.name == "nt" else _SYSTEM_ROOTS_POSIX


def _per_user_roots() -> tuple[str, ...]:
    """Roots that are user-writable: acceptable only with a pinned digest."""
    if os.name != "nt":
        return ()
    roots = []
    for variable in ("LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"):
        base = os.environ.get(variable, "")
        if base:
            roots.append(os.path.join(base, "Google", "Chrome"))
            roots.append(os.path.join(base, "Microsoft", "Edge"))
    return tuple(roots)


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

    cache = _cache_root()
    in_cache = cache is not None and _under(path, Path(os.path.abspath(cache)))

    # The owner escape hatch widens *where* a binary may live. It deliberately
    # does not bypass the digest check below.
    trusted = os.environ.get(_OPT_IN_ENV, "").strip().lower() in {"1", "true", "yes"}
    # User-writable locations: reachable, but only with a pinned digest. This is
    # what keeps a per-user Chrome install working instead of being a regression.
    in_user_root = any(
        _under(path, Path(os.path.abspath(root))) for root in _per_user_roots()
    )
    if not trusted:
        allowed = [root for root in _system_roots() if _under(path, Path(os.path.abspath(root)))]
        if in_cache or in_user_root:
            allowed.append(str(path))
        if not allowed or not _looks_like_browser(path):
            raise SecurityError(
                f"Browser executable is outside the allowlisted browser roots: {path}. "
                f"Install Chrome/Edge/Firefox in a standard location, or set {_OPT_IN_ENV}=1 "
                "to trust a custom path explicitly."
            )

    # Pinned identity is enforced unconditionally. A digest the owner recorded
    # is the strongest statement available about which file may run, so turning
    # on the trust escape hatch must not silently disable it.
    pinned = expected_digest(config, path)
    if pinned:
        actual = file_digest(path)
        if actual != pinned:
            raise SecurityError(
                f"Browser executable digest does not match the pinned value: {path}"
            )
    elif in_cache or in_user_root:
        # Writable at runtime, so a browser-named file here is the weakest thing
        # this gate could accept: it must be pinned.
        where = "engine cache" if in_cache else "user-writable install root"
        raise SecurityError(
            f"Browser executable under a {where} has no pinned digest: {path}. "
            "That location is writable at runtime; pin it with browser_binary_sha256, "
            "or install the browser in a standard system location."
        )
    return path


def _channel_candidates(channel: str) -> tuple[str, ...]:
    table = _CHANNEL_CANDIDATES_WINDOWS if os.name == "nt" else _CHANNEL_CANDIDATES_POSIX
    return table.get(str(channel or "").strip().lower(), ())


def resolve_channel_executable(channel: str, config: dict[str, Any] | None = None) -> Path | None:
    """Resolve a Playwright ``channel=`` selection to a gate-verified binary.

    Playwright resolves ``channel`` internally (registry entries on Windows, a
    fixed candidate list elsewhere) and hands the result straight to the
    launcher. That lookup happens where we cannot gate it, so instead of
    trusting it we run the equivalent lookup ourselves and pass
    ``executable_path``; the binary the launcher actually receives has then
    already passed :func:`verify_browser_executable`.

    Returns ``None`` when the channel is not installed at all (Playwright would
    fail at launch in that case too). Raises :class:`SecurityError` when an
    installed candidate is not acceptable, so a refusal is never silently read
    as "not installed" and downgraded to some other browser.
    """
    candidates = _channel_candidates(channel)
    if not candidates:
        raise SecurityError(f"Unsupported browser channel: {channel!r}")

    first_error: SecurityError | None = None
    for raw in candidates:
        path = Path(os.path.abspath(os.path.expandvars(os.path.expanduser(raw))))
        if not path.is_file():
            continue
        try:
            return verify_browser_executable(path, config)
        except SecurityError as exc:
            first_error = first_error or exc
    if first_error is not None:
        raise first_error
    return None


def is_verified(candidate: str | Path, config: dict[str, Any] | None = None) -> bool:
    """Boolean form of :func:`verify_browser_executable` for diagnostics."""
    try:
        verify_browser_executable(candidate, config)
    except SecurityError:
        return False
    return True