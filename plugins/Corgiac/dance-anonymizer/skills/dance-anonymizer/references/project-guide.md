# DanceAnon Project Guide

## Purpose

DanceAnon is a local Python video-processing application for detecting and tracking people in dance videos and applying anonymization or visual effects. It provides both a browser UI and a command-line interface.

## Important files

- `README.md`: Installation, startup, user workflow, requirements, and model information.
- `main.py`: CLI entry point for direct input-to-output processing.
- `api.py`: FastAPI application, task lifecycle, uploads, analysis, rendering, status, cancellation, and cleanup.
- `index.html`: Browser client and interactive controls.
- `config.yaml`: Model, detection, tracking, and effect defaults.
- `src/pipeline.py`: End-to-end video processing orchestration.
- `src/tracker.py`: Initial person detection and tracker configuration.
- `src/engine.py`: Video mask propagation engines, including SAM2/CUTIE integration.
- `src/effects.py`: Mask rendering and visual effects.
- `src/utils.py`: Shared video and image utilities.
- `scripts/mac/setup.sh`: macOS environment setup.
- `scripts/mac/run.sh`: macOS Web server launcher.
- `scripts/windows/setup.bat`: Windows environment setup.
- `scripts/windows/run.bat`: Windows Web server launcher.
- `vendor/Cutie/`: Vendored CUTIE tracking implementation.
- `vendor/sam2/`: Vendored SAM2 implementation.

## Runtime requirements

- Python 3.10 or newer.
- Python packages listed in `requirements.txt`.
- `yolo11s-seg.pt` in the project root for person detection.
- `sam2_hiera_tiny.pt` in the project root for SAM2 mask refinement/tracking.
- CUTIE weights under `vendor/Cutie/weights/` when CUTIE is selected.
- `ffmpeg` for reliable audio preservation and muxing.

## CLI behavior

`main.py` loads `config.yaml`, creates `TrackerConfig`, builds the tracking engine configuration, parses optional target IDs, creates the output directory, and calls `DanceAnonymizerPipeline.process()`.

The device values accepted by the CLI are `mps`, `cuda`, and `cpu`.

## Web behavior

`api.py` exposes a FastAPI service normally launched on port 8002. The browser UI supports uploading and analyzing a clip, choosing people, configuring effects, rendering, polling status, canceling tasks, and cleaning temporary task data.

Treat API changes as coupled with `index.html`. Search both files for an endpoint name or response field before changing it.

## Configuration guidance

Prefer user-supplied CLI options for one-off jobs. Change `config.yaml` only when the user wants persistent defaults. Back up or clearly describe any persistent configuration changes.

For performance problems:

- Prefer `mps` on supported Apple Silicon.
- Prefer `cuda` on a compatible NVIDIA environment.
- Use `cpu` as a compatibility fallback, with substantially slower processing expected.
- Lowering input duration or resolution is safer than making undocumented model substitutions.

## Safe validation

Use the narrowest applicable validation:

```bash
cd <PROJECT_ROOT>
.venv/bin/python -m py_compile main.py api.py src/*.py
```

For CLI argument validation:

```bash
cd <PROJECT_ROOT>
.venv/bin/python main.py --help
```

For Web startup validation:

```bash
cd <PROJECT_ROOT>
.venv/bin/python -m uvicorn api:app --host 127.0.0.1 --port 8002
```

Do not run a full model inference unless a real input video, all required weights, sufficient disk space, and user approval are available.

