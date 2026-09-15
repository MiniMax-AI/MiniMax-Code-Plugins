#!/usr/bin/env python3
"""Cross-platform runtime helpers for the octopus-meme-maker scripts.

Three things differ enough between macOS, Linux and Windows to need one place
to get them right:

1. **Console encoding.** A Windows console defaults to a legacy code page
   (cp1252 on an English install, cp936 on a Chinese one) and some Linux
   setups still run under the C locale. Printing a Chinese caption to either
   raises UncaughtError, so the scripts would die on their own success message.
   `setup_console()` pins stdout/stderr to UTF-8 and never raises on an
   unencodable glyph.

2. **Subprocess decoding.** `text=True` decodes using the locale encoding, so
   a tool that emits UTF-8 (ffmpeg) can produce mojibake or a decode error.
   `SUBPROCESS_TEXT` decodes UTF-8 and replaces what it cannot read.

3. **Path comparison.** Windows paths are case-insensitive and accept both
   separators. `same_dir()` normalises before comparing, so the containment
   checks behave the same on all three platforms.

Not a CLI entry point: import it.
"""
import os
import sys

# Pass as **SUBPROCESS_TEXT to subprocess.run(...) instead of text=True.
SUBPROCESS_TEXT = {"encoding": "utf-8", "errors": "replace"}


def setup_console():
    """Make stdout/stderr UTF-8 and tolerant of unencodable characters.

    Safe to call more than once, and a no-op when the stream is not a real
    text stream (e.g. a StringIO under test).
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def same_dir(left, right):
    """Compare two directory paths the way the running platform does.

    Windows is case-insensitive and accepts `/` and `\\`; POSIX is neither.
    """
    return os.path.normcase(os.path.normpath(left)) == os.path.normcase(os.path.normpath(right))


def dirname_normalised(path):
    """`os.path.dirname` with the platform's normalisation applied."""
    return os.path.normcase(os.path.normpath(os.path.dirname(path)))


# Windows treats these as devices, not file names, anywhere in the path.
_WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL"}
_WINDOWS_RESERVED.update(f"COM{i}" for i in range(1, 10))
_WINDOWS_RESERVED.update(f"LPT{i}" for i in range(1, 10))


def windows_reserved_reason(name):
    """Return a human-readable reason if `name` is unusable on Windows, else None.

    Checked on every platform so a name that works on macOS cannot silently
    fail on a Windows user's machine.
    """
    stem = os.path.splitext(name)[0].upper()
    if stem in _WINDOWS_RESERVED:
        return f"{stem} is a reserved Windows device name"
    if name != name.rstrip(" ."):
        return "Windows strips a trailing space or dot from a file name"
    for char in '<>:"|?*':
        if char in name:
            return f"{char!r} is not a legal character in a Windows file name"
    return None
