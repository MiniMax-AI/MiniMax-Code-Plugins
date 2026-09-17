#!/usr/bin/env python3
"""Shared CJK font discovery and loading for the octopus-meme-maker scripts.

Every script in this directory needs the same thing: find a usable CJK font on
whatever OS this is, load it, and fail with an actionable message if it cannot.
Keeping that in one place means a new font family is added once, not four
times, and that "the file exists but Pillow cannot open it" is reported as a
sentence rather than an uncaught OSError traceback.

Not a CLI entry point: import it.
"""
import os

from PIL import ImageFont

# Ordered by preference. Each script picks the first entry that both exists and
# loads, so a missing or unreadable candidate is skipped rather than fatal.
FONT_CANDIDATES = [
    # macOS
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    # Linux
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-VF.otf.ttc",
    # Windows
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]

INSTALL_HINT = (
    "Install a CJK font (wqy-microhei or noto-cjk on Linux, STHeiti or "
    "PingFang on macOS, msyh on Windows) or pass --font <path>."
)


def load_font(path, size):
    """Load `path` at `size`, raising ValueError with a readable message."""
    try:
        return ImageFont.truetype(path, size)
    except Exception as exc:  # Pillow raises OSError / ValueError / IndexError
        raise ValueError(f"cannot load font {path}: {exc}") from exc


def load_first_usable(candidates, size):
    """Return (font, path) for the first candidate that exists AND loads.

    Returns (None, None) when nothing works, so the caller can print
    INSTALL_HINT and exit 1. A candidate whose file is present but unreadable
    is skipped instead of crashing the run, and is reported on the way past.
    """
    broken = []
    for path in candidates:
        if not os.path.exists(path):
            continue
        try:
            return load_font(path, size), path
        except ValueError as exc:
            broken.append(str(exc))
    if broken:
        raise ValueError("; ".join(broken))
    return None, None


def pick_font_path():
    """Return the first candidate path that exists, or None. Existence only."""
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return path
    return None


class FontUnavailable(Exception):
    """No usable CJK font. The message is ready to show the user."""


def resolve_font_path(requested, probe_size=32):
    """Return a font path Pillow can open, or raise FontUnavailable.

    A caller-supplied path is verified rather than trusted, so a typo or a
    present-but-unreadable file produces a sentence instead of a traceback.
    """
    if requested:
        try:
            load_font(requested, probe_size)
        except ValueError as exc:
            raise FontUnavailable(str(exc)) from exc
        return requested
    try:
        _, path = load_first_usable(FONT_CANDIDATES, probe_size)
    except ValueError as exc:
        raise FontUnavailable(f"{exc}\n{INSTALL_HINT}") from exc
    if path is None:
        raise FontUnavailable(f"no CJK font found on this system. {INSTALL_HINT}")
    return path
