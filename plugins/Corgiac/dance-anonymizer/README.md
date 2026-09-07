# Dance Anonymizer Plugin

Use MiniMax Code to operate, troubleshoot, and extend an existing local [DanceAnon](https://github.com/Corgiac/dance-anonymizer) project. The Plugin bridges the setup and operational knowledge gap between a general coding agent and DanceAnon's YOLO, SAM2, CUTIE, FastAPI, video, model, and device-specific workflow.

## Included capability

- `dance-anonymizer`: Locates the project, checks its runtime prerequisites, launches the Web interface, runs command-line video processing, diagnoses common errors, and guides focused code changes.

## Requirements

- A local copy of the DanceAnon project.
- Python 3.10 or newer.
- Project dependencies from `requirements.txt`.
- The model files required by the DanceAnon README.
- `ffmpeg` when audio preservation or muxing is needed.
- Sufficient local disk, memory, and compute resources for computer-vision model inference.

The Skill checks `DANCE_ANON_HOME`, the current workspace, an explicitly supplied path, and nearby local clones named `dance-anonymizer` when resolving the project root. If no local copy exists, it guides the user to clone `https://github.com/Corgiac/dance-anonymizer`.

## Example

```text
Use the dance-anonymizer skill to check whether my DanceAnon project can start. Do not install or download anything yet.
```

```text
Use the dance-anonymizer skill to process /absolute/path/input.mp4 into /absolute/path/output.mp4. Check the environment and model files before executing.
```

## Expected result

MiniMax Code locates a local DanceAnon checkout, checks Python and project prerequisites before taking action, selects the Web or CLI workflow, uses the repository's own launch and processing entry points, and reports the exact output path or startup address. Missing dependencies and models are reported without silently installing or downloading them.

## Supported platforms

- macOS, including Apple Silicon with MPS where supported by the installed PyTorch build.
- Windows, using the repository's bundled batch scripts.
- Linux, using the Python CLI or direct Uvicorn startup.

## Network access

The Plugin itself performs no network requests and requires no account, API key, or paid service. The underlying project setup may access GitHub, Python package indexes, and model download hosts documented by DanceAnon only when the user explicitly requests cloning, installation, or downloading.

## Data use

The Plugin contains instructions only. Source paths, environment diagnostics, model status, and video paths may be read locally to complete a requested task. Video files are processed by the local DanceAnon project. The Plugin does not add telemetry, upload code, or send videos to an external service.

## Safety

The Skill instructs the agent to request confirmation before installing packages, downloading large models, terminating processes, or overwriting output videos.
