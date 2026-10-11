"""Constrained identifier and path resolution for untrusted caller-supplied names.

Two call sites hand a caller-controlled string straight to the filesystem: the
batch resume identifier and the Zotero attachment path. Both need the same two
properties, so they share one resolver rather than re-implementing checks:

* an identifier is a *name*, never a path (no separators, drive letters, UNC,
  ADS streams or traversal), and
* the resolved path is proven to sit inside a trusted root, with no symlink or
  junction anywhere along the way.

``security.workspace_path`` already implements the strict-mode half of that
contract; this module adds the identifier grammar and a final read boundary
that also runs when the engine is used outside the hosted workspace.
"""

from __future__ import annotations

import os
import string
from pathlib import Path

from .security import SecurityError, no_symlinks, strict_mode, workspace_path

MAX_IDENTIFIER_LENGTH = 64
# Deliberately narrow: letters, digits, dot, underscore and hyphen. This
# excludes every POSIX/Windows separator, ':' (drive letters and NTFS
# alternate data streams), whitespace, NUL and all control characters.
_IDENTIFIER_ALPHABET = frozenset(string.ascii_letters + string.digits + "._-")


def safe_identifier(value: object, *, field: str = "identifier") -> str:
    """Return ``value`` when it is a plain identifier, else raise SecurityError.

    Auto-generated ids (an md5 prefix) and ordinary user ids such as
    ``nightly-2024`` or ``run_7`` are preserved. Anything path-shaped is
    rejected: absolute paths, POSIX and Windows separators, drive letters,
    UNC prefixes, ADS streams, ``.``/``..`` traversal, reserved Windows
    device names, trailing dots or spaces, and over-long names.
    """
    if not isinstance(value, str):
        raise SecurityError(f"{field} must be a string identifier")
    if not value:
        raise SecurityError(f"{field} must not be empty")
    if len(value) > MAX_IDENTIFIER_LENGTH:
        raise SecurityError(
            f"{field} must be at most {MAX_IDENTIFIER_LENGTH} characters")
    if value != value.strip():
        raise SecurityError(f"{field} must not have leading or trailing whitespace")
    if value in (".", "..") or ".." in value:
        raise SecurityError(f"{field} must not contain path traversal")
    if value.endswith((".", " ")):
        raise SecurityError(f"{field} must not end with a dot or space")
    stem = value.split(".", 1)[0].upper()
    reserved = {"CON", "PRN", "AUX", "NUL"} | {
        f"{prefix}{index}" for prefix in ("COM", "LPT") for index in range(1, 10)}
    if stem in reserved:
        raise SecurityError(f"{field} must not be a reserved device name")
    illegal = sorted(set(value) - _IDENTIFIER_ALPHABET)
    if illegal:
        raise SecurityError(
            f"{field} must contain only letters, digits, '.', '_' and '-' "
            f"(rejected: {''.join(illegal)!r})")
    return value


def resolve_within(base_dir: str | Path, *parts: str, field: str = "path") -> Path:
    """Join ``parts`` under ``base_dir`` and prove the result stays inside it.

    One resolver for every read, write and delete of a named file: it rejects
    traversal, and refuses a symlink or junction anywhere between the root and
    the target. The target need not exist yet (writes create it).
    """
    base = Path(os.path.abspath(base_dir))
    candidate = Path(os.path.abspath(base.joinpath(*parts)))
    if candidate == base or not candidate.is_relative_to(base):
        raise SecurityError(f"{field} must stay inside {base.name or base}")
    no_symlinks(candidate)
    return candidate


def resolve_attachment(
    value: str | Path,
    *,
    field: str = "attachment",
    suffixes: frozenset[str] | None = frozenset({".pdf"}),
) -> Path:
    """Resolve and validate the final read boundary for a Zotero attachment.

    Validated immediately before the file is opened, not merely when the
    caller supplies it: a cache record, a cache directory or any other
    in-workspace component may have changed the value in between. Checks the
    workspace root (strict mode), symlink/junction escape, existence, that the
    target is a regular file, and that its type is an allowed attachment type.

    Absolute and relative paths both resolve per the existing convention:
    relative paths are taken against the workspace root in strict mode and
    against the current directory otherwise.
    """
    if isinstance(value, Path):
        raw = value
    elif isinstance(value, str) and value.strip():
        raw = Path(value)
    else:
        raise SecurityError(f"{field} path must not be empty")

    if strict_mode():
        # Handles workspace-relative and absolute inputs and rejects escapes.
        candidate = workspace_path(raw)
    else:
        candidate = Path(os.path.abspath(raw.expanduser()))
        no_symlinks(candidate)

    if not candidate.exists():
        raise SecurityError(f"{field} file does not exist")
    if not candidate.is_file():
        raise SecurityError(f"{field} path is not a regular file")
    if suffixes is not None and candidate.suffix.lower() not in suffixes:
        allowed = ", ".join(sorted(suffixes))
        raise SecurityError(f"{field} type {candidate.suffix or '(none)'} is not an allowed type ({allowed})")
    return candidate