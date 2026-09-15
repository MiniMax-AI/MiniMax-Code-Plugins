#!/usr/bin/env python3
"""Compose the final 720x720 + 480x480 GIFs from a video and a Chinese caption.

Usage:
    python3 make_gif.py <scene-dir> "<caption>" [--output-name final.gif]

The script runs 4 ffmpeg steps and one Pillow text-overlay step:
    1. Make a transparent 1080x220 PNG with the caption (delegated to make_text_overlay.py).
    2. Burn the overlay onto the video at y=520, scale to 720x720, dump 141 frames as PNGs.
    3. palettegen on the 141 PNGs to a 720x720 palette.
    4. paletteuse -> 720x720 final.gif.
    5. Downscale the 141 PNGs to 480x480 + paletteuse -> 480x480 final-mini.gif.

Exit 0: <scene-dir>/final.gif and <scene-dir>/final-mini.gif both exist.
Exit 1: video.mp4 missing, ffmpeg missing, or any step fails.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

import _platform

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT_OVERLAY_SCRIPT = os.path.join(HERE, "make_text_overlay.py")

MIN_FFMPEG_MAJOR = 5  # -fps_mode replaced -vsync in ffmpeg 5.0

DURATION = "5.87"        # seconds kept from the source video (141 frames @ 24fps)
OUTPUT_W = 720           # main GIF width
OUTPUT_H = 720           # main GIF height
MINI_W = 480             # mini GIF width
MINI_H = 480             # mini GIF height
OVERLAY_Y = 520          # vertical offset of the text overlay (top-left of the 720x176 strip)
OVERLAY_W = 720
OVERLAY_H = 176
FPS = 24
PALETTE_DITHER = "bayer:bayer_scale=5"


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def resolve_output(scene_dir, name, label):
    """Resolve an output file name inside scene_dir, refusing escapes.

    `--output-name` reads as a bare file name, so it must not be able to leave
    the scene directory: no absolute paths, no `..`, and no symlink that
    resolves outside.
    """
    if not name or os.path.isabs(name) or name.startswith(("\\", "/")):
        fail(f"{label} must be a bare file name, not an absolute path: {name!r}")
    if os.sep in name or (os.altsep and os.altsep in name) or "/" in name or "\\" in name:
        fail(f"{label} must not contain a path separator: {name!r}")
    reserved = _platform.windows_reserved_reason(name)
    if reserved:
        fail(f"{label} {name!r} would fail on Windows: {reserved}")
    resolved = os.path.realpath(os.path.join(scene_dir, name))
    if not _platform.same_dir(os.path.dirname(resolved), scene_dir):
        fail(f"{label} escapes the scene directory: {name!r}")
    return resolved


def run(cmd, label):
    print(f"[{label}] {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, **_platform.SUBPROCESS_TEXT)
    if result.returncode != 0:
        print(f"ERROR during {label}:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)
    return result


def require_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe is None:
        fail(f"ffmpeg not found on PATH. Install ffmpeg {MIN_FFMPEG_MAJOR}.0+ first.")
    probe = subprocess.run([exe, "-version"], capture_output=True, **_platform.SUBPROCESS_TEXT)
    match = re.search(r"ffmpeg version n?(\d+)\.", probe.stdout or "")
    if match and int(match.group(1)) < MIN_FFMPEG_MAJOR:
        fail(
            f"ffmpeg {match.group(1)}.x found, but this script uses -fps_mode, which "
            f"requires ffmpeg {MIN_FFMPEG_MAJOR}.0+ (released 2022)."
        )


def require_text_overlay_script():
    if not os.path.exists(TEXT_OVERLAY_SCRIPT):
        print(f"ERROR: {TEXT_OVERLAY_SCRIPT} not found. Run from the Plugin's scripts/ directory.", file=sys.stderr)
        sys.exit(1)


def warn_if_not_square(video):
    """The composite forces OUTPUT_W x OUTPUT_H, so a non-square source is squashed."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height",
         "-of", "csv=p=0:s=x", video],
        capture_output=True, **_platform.SUBPROCESS_TEXT,
    )
    if probe.returncode != 0:
        return  # rendering will surface the real error
    parts = probe.stdout.strip().split("x")
    if len(parts) != 2:
        return
    try:
        w, h = int(parts[0]), int(parts[1])
    except ValueError:
        return
    if w != h:
        print(
            f"WARNING: source video is {w}x{h}, not square. The composite scales it to "
            f"{OUTPUT_W}x{OUTPUT_H}, which will distort the image. Re-encode to 1:1 first.",
            file=sys.stderr,
        )
    if (w, h) != (1080, 1080):
        print(
            f"NOTE: source video is {w}x{h}; the intended capture size is 1080x1080. "
            "Rendering continues and scales to "
            f"{OUTPUT_W}x{OUTPUT_H}.",
            file=sys.stderr,
        )


def main():
    _platform.setup_console()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("scene_dir", help="Scene directory containing video.mp4")
    p.add_argument("caption", help="Chinese caption rendered onto the GIF")
    p.add_argument("--output-name", default="final.gif", help="Main GIF name (default: final.gif)")
    p.add_argument("--mini-name", default="final-mini.gif", help="Mini GIF name (default: final-mini.gif)")
    args = p.parse_args()

    scene_dir = os.path.realpath(os.path.abspath(args.scene_dir))

    # Argument validation first: a bad flag must fail before any I/O.
    output = resolve_output(scene_dir, args.output_name, "--output-name")
    mini = resolve_output(scene_dir, args.mini_name, "--mini-name")

    video = os.path.join(scene_dir, "video.mp4")
    if not os.path.exists(video):
        fail(f"{video} not found. Run stage 2 (gen_videos) first.")

    require_text_overlay_script()
    require_ffmpeg()
    warn_if_not_square(video)

    workdir = tempfile.mkdtemp(prefix="octopus_gif_")
    frames_dir = os.path.join(workdir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    overlay = os.path.join(workdir, "overlay.png")
    palette = os.path.join(workdir, "palette.png")
    mini_frames_dir = os.path.join(workdir, "mini_frames")
    os.makedirs(mini_frames_dir, exist_ok=True)
    mini_palette = os.path.join(workdir, "mini_palette.png")

    try:
        # 1. text overlay
        run([sys.executable, TEXT_OVERLAY_SCRIPT, args.caption, overlay], "1/5 overlay")

        # 2. burn overlay -> 141 PNG frames @ 720x720
        run([
            "ffmpeg", "-y",
            "-i", video,
            "-loop", "1", "-i", overlay,
            "-filter_complex",
            f"[0:v]scale={OUTPUT_W}:{OUTPUT_H}[vid];"
            f"[1:v]scale={OVERLAY_W}:{OVERLAY_H}[ovl];"
            f"[vid][ovl]overlay=0:{OVERLAY_Y}[out]",
            "-map", "[out]", "-t", DURATION, "-fps_mode", "passthrough",
            os.path.join(frames_dir, "f_%04d.png"),
        ], "2/5 burn-overlay -> frames")

        # 3. palettegen @ 720x720
        run([
            "ffmpeg", "-y",
            "-framerate", str(FPS),
            "-i", os.path.join(frames_dir, "f_%04d.png"),
            "-vf", "palettegen=stats_mode=diff",
            palette,
        ], "3/5 palettegen")

        # 4. paletteuse -> final.gif
        run([
            "ffmpeg", "-y",
            "-framerate", str(FPS),
            "-i", os.path.join(frames_dir, "f_%04d.png"),
            "-i", palette,
            "-lavfi", f"paletteuse=dither={PALETTE_DITHER}",
            output,
        ], "4/5 paletteuse -> final.gif")

        # 5. mini: downscale frames + palette
        run([
            "ffmpeg", "-y",
            "-framerate", str(FPS),
            "-i", os.path.join(frames_dir, "f_%04d.png"),
            "-vf", f"scale={MINI_W}:{MINI_H}",
            os.path.join(mini_frames_dir, "f_%04d.png"),
        ], "5a/5 downscale -> mini frames")

        run([
            "ffmpeg", "-y",
            "-framerate", str(FPS),
            "-i", os.path.join(mini_frames_dir, "f_%04d.png"),
            "-vf", "palettegen=stats_mode=diff",
            mini_palette,
        ], "5b/5 mini palettegen")

        run([
            "ffmpeg", "-y",
            "-framerate", str(FPS),
            "-i", os.path.join(mini_frames_dir, "f_%04d.png"),
            "-i", mini_palette,
            "-lavfi", f"paletteuse=dither={PALETTE_DITHER}",
            mini,
        ], "5c/5 mini paletteuse -> final-mini.gif")

        main_size = os.path.getsize(output) / (1024 * 1024)
        mini_size = os.path.getsize(mini) / (1024 * 1024)
        print()
        print(f"Done. Main: {output} ({main_size:.1f} MB)  Mini: {mini} ({mini_size:.1f} MB)")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
