#!/usr/bin/env python3
"""Compose a 3x2 contact sheet of base-pose candidates for the user to pick from.

Usage:
    python3 make_contact_sheet.py <img1> <img2> <img3> <img4> <img5> <img6> <output.png> \
        [--labels "1,2,3,4,5,6"] \
        [--cols 3]

Six images are arranged in a 3-cols x 2-rows grid; each cell is downscaled to
480x480 with white padding, and a bold number is drawn in the top-left corner
so the user can answer "pick 3" / "选第 2 张" without ambiguity. The grid line
between cells is a 4 px black rule for visual separation. The script accepts
.jpg / .jpeg / .png files of any resolution; very large sources are downscaled
to fit before being composited. With the default 3 columns the sheet is
1460x974 px; wider --cols values produce a proportionally wider sheet.

Exit 0: <output> exists, six labelled cells visible.
Exit 1: wrong number of inputs (must be exactly 6), a source image is unreadable,
        Pillow is missing, or the output cannot be written.

Stage 1 of the octopus-meme-maker pipeline must run this script after the base
pose batch lands and BEFORE asking the user to confirm. See SKILL.md § 2.2.
"""
import argparse
import os
import sys

from PIL import Image, ImageDraw

import _fonts
import _platform

CELL_SIZE = 480
COLS = 3
PADDING = 6
RULE = 4
LABEL_FONT_SIZE = 72
LABEL_BG = (255, 255, 255, 200)
LABEL_FG = (0, 0, 0, 255)





def fit_into_square(img, size):
    """Resize-and-pad an image into a size x size RGB square on a white background."""
    img = img.convert("RGB")
    w, h = img.size
    scale = min(size / w, size / h)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    resized = img.resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new("RGB", (size, size), (255, 255, 255))
    canvas.paste(resized, ((size - new_w) // 2, (size - new_h) // 2))
    return canvas


def main():
    _platform.setup_console()
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("images", nargs=6, help="Six candidate base-pose image paths.")
    p.add_argument("output", help="Output contact-sheet PNG path.")
    p.add_argument(
        "--labels",
        default=None,
        help="Comma-separated 6 labels (defaults to '1,2,3,4,5,6').",
    )
    p.add_argument(
        "--cols", type=int, default=COLS, help=f"Grid columns (default {COLS}; rows = ceil(6 / cols))."
    )
    p.add_argument("--font", default=None, help="Path to a CJK .ttc / .ttf file for the labels.")
    args = p.parse_args()

    if args.labels is not None:
        labels = args.labels.split(",")
        if len(labels) != 6:
            print(
                f"ERROR: --labels must have exactly 6 comma-separated values, got {len(labels)}.",
                file=sys.stderr,
            )
            sys.exit(1)
    else:
        labels = [str(i) for i in range(1, 7)]

    if args.cols < 1 or args.cols > 6:
        print(f"ERROR: --cols must be 1..6, got {args.cols}.", file=sys.stderr)
        sys.exit(1)

    try:
        font_path = _fonts.resolve_font_path(args.font)
    except _fonts.FontUnavailable as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    cells = []
    for path in args.images:
        if not os.path.isfile(path):
            print(f"ERROR: input image not found: {path}", file=sys.stderr)
            sys.exit(1)
        try:
            cells.append(fit_into_square(Image.open(path), CELL_SIZE))
        except Exception as exc:  # PIL raises a variety of exception types
            print(f"ERROR: failed to read {path}: {exc}", file=sys.stderr)
            sys.exit(1)

    cols = args.cols
    rows = (6 + cols - 1) // cols
    sheet_w = cols * CELL_SIZE + (cols - 1) * PADDING + 2 * RULE
    sheet_h = rows * CELL_SIZE + (rows - 1) * PADDING + 2 * RULE
    sheet = Image.new("RGB", (sheet_w, sheet_h), (0, 0, 0))
    draw = ImageDraw.Draw(sheet)
    font = _fonts.load_font(font_path, LABEL_FONT_SIZE)

    for i, (cell, label) in enumerate(zip(cells, labels)):
        row = i // cols
        col = i % cols
        x = RULE + col * (CELL_SIZE + PADDING)
        y = RULE + row * (CELL_SIZE + PADDING)
        sheet.paste(cell, (x, y))

        # Number badge: white rectangle background + bold black number, top-left.
        badge_w = 80
        badge_h = 90
        draw.rectangle([x, y, x + badge_w, y + badge_h], fill=LABEL_BG)
        # Center the digit horizontally and vertically inside the badge.
        bbox = draw.textbbox((0, 0), label, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]
        draw.text(
            (x + (badge_w - text_w) // 2 - bbox[0], y + (badge_h - text_h) // 2 - bbox[1]),
            label,
            font=font,
            fill=LABEL_FG,
        )

    out_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(out_dir, exist_ok=True)
    sheet.save(args.output, "PNG")
    print(
        f"OK: {args.output} ({sheet_w}x{sheet_h}, {cols}x{rows} grid, font={font_path})"
    )


if __name__ == "__main__":
    main()
