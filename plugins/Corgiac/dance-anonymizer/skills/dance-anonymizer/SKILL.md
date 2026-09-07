---
name: dance-anonymizer
description: Operate, configure, troubleshoot, and extend the local DanceAnon dance-video anonymization project. Use when the user asks to install or launch DanceAnon, anonymize people in a video, run its CLI or FastAPI web interface, configure YOLO/SAM2/CUTIE tracking, adjust visual effects, diagnose model or ffmpeg problems, or modify the dance-anonymizer codebase.
---

# Dance Anonymizer

Use the local DanceAnon project to detect, track, anonymize, and apply effects to people in dance videos.

## Resolve the project root

Resolve the project root before running commands. Use the first valid location:

1. The `DANCE_ANON_HOME` environment variable.
2. The current workspace when it contains `main.py`, `api.py`, `config.yaml`, and `src/`.
3. A path explicitly supplied by the user.
4. A local clone named `dance-anonymizer` under the current workspace or its parent.
5. If no valid local copy exists, guide the user to clone `https://github.com/Corgiac/dance-anonymizer` and ask them to confirm the destination before cloning.

Store the chosen path conceptually as `<PROJECT_ROOT>` and run project commands from it. Do not assume that the Skill directory contains the application source or model weights.

## Choose the workflow

- Use the Web workflow when the user wants interactive person selection, preview, stickers, beauty effects, leg stretching, camera following, cropping, or browser-based export.
- Use the CLI workflow when the user provides an input video and output path and wants batch processing or automation.
- Use the Development workflow when the user asks to inspect, fix, or extend the project.

## Prepare the environment

1. Confirm Python 3.10 or newer.
2. Confirm `<PROJECT_ROOT>/yolo11s-seg.pt` exists.
3. Confirm `<PROJECT_ROOT>/sam2_hiera_tiny.pt` exists before SAM2 processing. If it is absent, explain that the user must obtain the model referenced by the project README; do not silently substitute another checkpoint.
4. Confirm CUTIE weights exist under `<PROJECT_ROOT>/vendor/Cutie/weights/` when the selected tracking engine requires them.
5. Prefer the project's `.venv` Python when `.venv` exists.
6. Check for `ffmpeg` when audio preservation or final video muxing matters.
7. Ask before installing packages, downloading large models, killing processes, or overwriting an existing output video.

## Web workflow

On macOS or Linux, prefer the bundled launcher:

```bash
cd <PROJECT_ROOT>
bash scripts/mac/run.sh
```

If the environment is already installed, the equivalent direct command is:

```bash
cd <PROJECT_ROOT>
.venv/bin/python -m uvicorn api:app --host 0.0.0.0 --port 8002
```

On Windows, use `scripts\windows\run.bat` from the project root.

Tell the user to open `http://localhost:8002`. Do not claim the service is ready until the process reports that Uvicorn is running. If port 8002 is occupied, identify the process first and request confirmation before terminating it.

## CLI workflow

Use `main.py` for a direct video-processing job:

```bash
cd <PROJECT_ROOT>
.venv/bin/python main.py \
  --input "/absolute/path/input.mp4" \
  --output "/absolute/path/output.mp4"
```

Supported options include:

- `--target_ids 1,3` to process selected detected person IDs.
- `--thickness 7` to change the effect boundary width.
- `--device mps`, `--device cuda`, or `--device cpu` to select inference hardware.
- `--conf 0.3` to change detection confidence.
- `--temporal_window 3` to tune temporal smoothing.
- `--model /path/to/yolo-model.pt` to override the YOLO model.
- `--config /path/to/config.yaml` to use another configuration.
- `--quiet` to reduce logging.

Use absolute paths for input and output. Create the output directory when necessary. Never overwrite the input file. For an existing output, ask whether to overwrite it or generate a new name.

## Installation workflow

Only install when the user requests it.

On macOS:

```bash
cd <PROJECT_ROOT>
bash scripts/mac/setup.sh
```

On Windows, run `scripts\windows\setup.bat`.

If a bundled setup script fails, inspect the exact failed command before retrying individual steps. Avoid changing package versions until checking `requirements.txt` and the Python/PyTorch platform constraints.

## Development workflow

Read `references/project-guide.md` before modifying the application. Preserve the current architecture unless the user requests a refactor.

When editing:

1. Trace the relevant request from `index.html` or `main.py` into `api.py`, `src/pipeline.py`, `src/tracker.py`, `src/engine.py`, and `src/effects.py`.
2. Keep Web API task lifecycle, cancellation, cleanup, and progress reporting intact.
3. Keep CPU, Apple MPS, and NVIDIA CUDA paths working when practical.
4. Avoid committing model checkpoints, generated videos, uploads, virtual environments, or caches.
5. Run the narrowest relevant check first, then a broader import or startup check.

## Troubleshooting priorities

Diagnose in this order:

1. Wrong working directory or missing virtual environment.
2. Python version or missing dependency.
3. Missing model checkpoint or CUTIE weights.
4. Unsupported `mps`/`cuda` device; retry with `cpu` only after explaining the speed impact.
5. Port 8002 already in use.
6. Missing `ffmpeg`, especially when the result has no audio.
7. Input codec, corrupt video, or unsupported path characters.
8. Person absent from the first frame, excessive crowd size, or low detection confidence.

Report the exact failing command and the most relevant error lines. Do not present a speculative fix as verified.

## Output expectations

At completion, report:

- The project root used.
- The workflow used: Web, CLI, installation, or development.
- The command executed or recommended.
- The output video path or local Web address.
- Any missing model, dependency, device fallback, or unverified step.
