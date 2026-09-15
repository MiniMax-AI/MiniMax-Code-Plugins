#!/usr/bin/env python3
"""Extract 5 evenly-spaced key frames from a video and stitch them into a preview strip.

Usage:
    python3 make_preview_strip.py <video.mp4> <output.png> [--labels "a,b,c,d,e"]

The 5 sampling points are 0%, 30%, 50%, 70% and 100% of the video duration, so
the script adapts to any 24 fps source (a 5.87 s / 141-frame clip and a 6.58 s /
158-frame clip both work). When --labels is omitted the labels are the real
timestamps of the sampled frames.

Exit 0: <output> exists (5 frames wide, label band at the bottom).
Exit 1: ffmpeg/ffprobe missing, the video has no decodable video stream, or the
        output could not be written.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw

import _fonts
import _platform

SAMPLE_FRACTIONS = (0.0, 0.30, 0.50, 0.70, 1.0)
FRAME_WIDTH = 480
LABEL_BAND_H = 50
LABEL_BG = "white"
LABEL_FG = "black"
LABEL_FONT_SIZE = 24





def probe_video(video):
    """Return (frame_count, fps) for the first video stream, or raise RuntimeError."""
    if shutil.which("ffprobe") is None:
        raise RuntimeError("ffprobe not found on PATH. Install ffmpeg (which ships ffprobe).")
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=nb_frames,r_frame_rate",
         "-of", "csv=p=0", video],
        capture_output=True, **_platform.SUBPROCESS_TEXT,
    )
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe failed on {video}:\n{out.stderr}")
    parts = [p for p in out.stdout.strip().split(",") if p]
    if len(parts) < 2:
        raise RuntimeError(f"could not read frame count / fps from {video}: {out.stdout!r}")
    rate_text, frames_text = parts[0], parts[1]
    num, _, den = rate_text.partition("/")
    fps = float(num) / float(den) if den else float(num)
    frames = int(frames_text) if frames_text.isdigit() else 0
    if frames <= 0 or fps <= 0:
        raise RuntimeError(
            f"video {video} reports nb_frames={frames_text!r} r_frame_rate={rate_text!r}; "
            "re-encode it with an explicit frame count first."
        )
    return frames, fps


def sample_indices(frames):
    """Return 5 unique frame indices spread across the clip."""
    last = frames - 1
    picked = []
    for fraction in SAMPLE_FRACTIONS:
        idx = min(last, int(round(fraction * last)))
        if idx not in picked:
            picked.append(idx)
    # Guarantee 5 distinct indices even on very short clips.
    fill = 0
    while len(picked) < 5 and fill <= last:
        if fill not in picked:
            picked.append(fill)
        fill += 1
    return sorted(picked)[:5]


def main():
    _platform.setup_console()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("video", help="Input video (any square 24fps clip; 1080x1080 5.87s or 768x768 6.58s both work)")
    p.add_argument("output", help="Output preview.png path")
    p.add_argument("--labels", default=None,
                   help="Comma-separated 5 labels. Defaults to the sampled frames' real timestamps.")
    p.add_argument("--font", default=None, help="Path to a CJK .ttc / .ttf file")
    p.add_argument("--workdir", default=None,
                   help="Existing empty directory to extract frames into. Defaults to a temp dir that is removed on exit.")
    args = p.parse_args()

    # 1. Argument validation first: fail fast, and never touch the filesystem
    #    before we know the caller's arguments are sane.
    labels = None
    if args.labels is not None:
        labels = args.labels.split(",")
        if len(labels) != 5:
            print(f"ERROR: --labels must have exactly 5 comma-separated values, got {len(labels)}.",
                  file=sys.stderr)
            sys.exit(1)

    # A caller-supplied --workdir is never deleted: refusing a non-empty one is
    # cheaper than explaining why the user's files are gone. We also refuse a path
    # that already exists as a regular file — `os.makedirs(..., exist_ok=True)`
    # would raise an uncaught `FileExistsError` and leak a Python traceback.
    cleanup = None
    if args.workdir:
        workdir = os.path.abspath(args.workdir)
        if os.path.exists(workdir) and not os.path.isdir(workdir):
            print(f"ERROR: --workdir {workdir} is not a directory. Pass a directory path, or omit "
                  "--workdir to use a temporary one.", file=sys.stderr)
            sys.exit(1)
        if os.path.isdir(workdir) and os.listdir(workdir):
            print(f"ERROR: --workdir {workdir} is not empty. Pass an empty directory, or omit "
                  "--workdir to use a temporary one.", file=sys.stderr)
            sys.exit(1)
    else:
        workdir = tempfile.mkdtemp(prefix="octopus_preview_")
        cleanup = workdir

    # 2. Environment and input checks.
    if shutil.which("ffmpeg") is None:
        print("ERROR: ffmpeg not found on PATH. Install ffmpeg 5.0+ first "
              "(-fps_mode replaced -vsync in 5.0).", file=sys.stderr)
        sys.exit(1)

    try:
        font_path = _fonts.resolve_font_path(args.font)
    except _fonts.FontUnavailable as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    if not os.path.isfile(args.video):
        print(f"ERROR: {args.video} not found.", file=sys.stderr)
        sys.exit(1)

    try:
        frames, fps = probe_video(args.video)
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    indices = sample_indices(frames)
    if labels is None:
        labels = [f"t={i / fps:.1f}s" for i in indices]

    os.makedirs(workdir, exist_ok=True)

    try:
        select_expr = "+".join(f"eq(n,{i})" for i in indices)
        cmd = [
            "ffmpeg", "-y",
            "-i", args.video,
            "-vf", f"select='{select_expr}',scale={FRAME_WIDTH}:-1",
            "-fps_mode", "passthrough",
            os.path.join(workdir, "f_%d.png"),
        ]
        print(f"Extracting 5 key frames at {[f'{i / fps:.2f}s' for i in indices]}...")
        result = subprocess.run(cmd, capture_output=True, **_platform.SUBPROCESS_TEXT)
        if result.returncode != 0:
            print(f"ERROR: ffmpeg failed:\n{result.stderr}", file=sys.stderr)
            sys.exit(1)

        frame_files = sorted(f for f in os.listdir(workdir) if f.endswith(".png"))
        if len(frame_files) != 5:
            print(f"ERROR: expected 5 frames, got {len(frame_files)}: {frame_files}", file=sys.stderr)
            sys.exit(1)

        imgs = [Image.open(os.path.join(workdir, f)) for f in frame_files]
        w, h = imgs[0].size
        strip = Image.new("RGB", (w * 5, h + LABEL_BAND_H), LABEL_BG)
        font = _fonts.load_font(font_path, LABEL_FONT_SIZE)
        draw = ImageDraw.Draw(strip)
        for i, im in enumerate(imgs):
            strip.paste(im, (i * w, 0))
            draw.text((i * w + 10, h + 10), labels[i], font=font, fill=LABEL_FG)
        strip.save(args.output, "PNG")
        print(f"OK: {args.output} ({w * 5}x{h + LABEL_BAND_H}, 5 frames, font={font_path})")
    finally:
        if cleanup:
            shutil.rmtree(cleanup, ignore_errors=True)


if __name__ == "__main__":
    main()
