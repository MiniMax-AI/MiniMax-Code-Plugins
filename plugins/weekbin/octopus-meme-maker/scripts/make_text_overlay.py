#!/usr/bin/env python3
"""Render a transparent Chinese text overlay PNG.

Usage:
    python3 make_text_overlay.py <text> <output.png> [--size 130] [--stroke 10] [--font <path>]

The text is composited as black-fill + white-stroke on a transparent RGBA canvas.
By default the script picks the first available CJK font from a cross-platform
candidate list; pass --font to override.

`--size` is the MAXIMUM point size. Longer captions are auto-shrunk until they
fit inside the canvas, so the text is never silently clipped; the size actually
used is printed on stdout. Pass --no-fit to disable the shrink and keep the
requested size.

Exit 0: file written to <output>, stdout prints
        "OK: <path> (<w>x<h>, text='<text>', size=<n>) <font>".
Exit 1: missing font and no --font override, or the text cannot fit at the
        smallest allowed size.
"""
import argparse
import os
import sys

from PIL import Image, ImageDraw

import _fonts
import _platform

TEXT_COLOR = (24, 24, 24)
STROKE_COLOR = (255, 255, 255)
CANVAS_W = 1080
CANVAS_H = 220
DEFAULT_SIZE = 130
MIN_SIZE = 24
SIZE_STEP = 2
DEFAULT_STROKE = 10


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)






def measure(draw, text, font, stroke):
    bbox = draw.textbbox((0, 0), text, font=font, stroke_width=stroke)
    return bbox, bbox[2] - bbox[0], bbox[3] - bbox[1]


def main():
    _platform.setup_console()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("text", help="Chinese text to render")
    p.add_argument("output", help="Output PNG path")
    p.add_argument("--size", type=int, default=DEFAULT_SIZE,
                   help=f"Maximum point size (default {DEFAULT_SIZE}); shrunk to fit if needed")
    p.add_argument("--stroke", type=int, default=DEFAULT_STROKE)
    p.add_argument("--font", default=None, help="Path to a CJK .ttc / .ttf file")
    p.add_argument("--width", type=int, default=CANVAS_W)
    p.add_argument("--height", type=int, default=CANVAS_H)
    p.add_argument("--no-fit", action="store_true",
                   help="Keep the requested --size even if the text overflows the canvas")
    args = p.parse_args()

    try:
        font_path = _fonts.resolve_font_path(args.font)
    except _fonts.FontUnavailable as exc:
        fail(str(exc))

    overlay = Image.new("RGBA", (args.width, args.height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    # A caption longer than the canvas would be clipped silently, so shrink the
    # font until it fits. --size is therefore a maximum, not a fixed value.
    size = max(MIN_SIZE, args.size)
    font = _fonts.load_font(font_path, size)
    bbox, text_w, text_h = measure(draw, args.text, font, args.stroke)
    if not args.no_fit:
        while (text_w > args.width or text_h > args.height) and size > MIN_SIZE:
            size = max(MIN_SIZE, size - SIZE_STEP)
            font = _fonts.load_font(font_path, size)
            bbox, text_w, text_h = measure(draw, args.text, font, args.stroke)

    if text_w > args.width or text_h > args.height:
        if args.no_fit:
            print(
                f"ERROR: text is {text_w}x{text_h}px and does not fit the "
                f"{args.width}x{args.height} canvas at --size {size}. Shorten the "
                "caption, raise --width/--height, or drop --no-fit.",
                file=sys.stderr,
            )
            sys.exit(1)
        print(
            f"ERROR: text is still {text_w}x{text_h}px at the minimum size {MIN_SIZE}; "
            f"it cannot fit the {args.width}x{args.height} canvas. Shorten the caption "
            "or raise --width/--height.",
            file=sys.stderr,
        )
        sys.exit(1)

    x = (args.width - text_w) / 2 - bbox[0]
    y = (args.height - text_h) / 2 - bbox[1]
    draw.text(
        (x, y),
        args.text,
        font=font,
        fill=TEXT_COLOR,
        stroke_width=args.stroke,
        stroke_fill=STROKE_COLOR,
    )
    overlay.save(args.output, "PNG")
    print(
        f"OK: {args.output} ({args.width}x{args.height}, text='{args.text}', "
        f"size={size}, text={text_w}x{text_h}, font={font_path})"
    )


if __name__ == "__main__":
    main()
