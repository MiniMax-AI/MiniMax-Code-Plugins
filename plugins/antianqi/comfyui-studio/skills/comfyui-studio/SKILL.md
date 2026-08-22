---
name: comfyui-studio
description: Drive a local ComfyUI 8188 server for image and short-clip generation. Use this Skill when the task involves a ComfyUI workflow, a local Stable Diffusion / Flux checkpoint, character-consistent generation with a LoRA, or producing deterministic outputs from a saved workflow JSON. Triggers on requests like "use ComfyUI to ...", "submit this workflow", "what models do I have", "generate an image with my LoRA", or "check the queue".
---

# ComfyUI Studio

A generic toolkit for driving a local ComfyUI server (default `http://127.0.0.1:8188`). It bundles
four Skills and two transport layers that work together.

## Two parts, one Plugin

| Part | What it covers | Where |
|---|---|---|
| **Basic control** | The transport between the agent and a local ComfyUI server. Submit workflows, poll the queue, download outputs. | `comfyui-workflow` Skill + the stdio MCP server + the Python CLI |
| **Preset workflows** | Three opinionated workflow templates that solve common recurring tasks: a consistent character selfie, a reference-image mimicry, and a 7-stage short drama pipeline. | `comfyui-character` and `comfyui-drama` Skills + the `workflows/*.json` presets |

The Plugin also ships a dependency-free stdio MCP server (see `mcp.json` + `server.mjs`) that
exposes the same basic-control primitives (`submit_prompt`, `check_queue`, `get_image`) to any
MCP-capable agent.

## When to use which Skill

| User intent | Use |
|---|---|
| "Submit this workflow" / "Check the queue" / "Download the image" | **comfyui-workflow** |
| "Make a selfie of my character" / "Generate a portrait using my LoRA" | **comfyui-character** (preset: `workflows/selfie-text-to-image.json`) |
| "Use this photo as a reference — make a similar selfie" | **comfyui-character** (preset: `workflows/selfie-mimicry.json`) |
| "Make a short drama" / "Generate a multi-shot video with these characters" | **comfyui-drama** (presets: `workflows/drama-first-frame.json` + `workflows/drama-image-to-video.json`) |
| "Use ComfyUI to ..." without further detail | **comfyui-studio** — read the user's intent, then route to one of the siblings |
| "What models do I have?" / "Is ComfyUI running?" | **comfyui-workflow** — its first step is always a health probe |

Do not duplicate behaviour: if you only need to submit a workflow, do not read this Skill, read
`comfyui-workflow/SKILL.md` directly. This Skill is the entry point for routing, not the
implementation.

## Required environment

The Plugin assumes the user has:

- A running ComfyUI server (default `http://127.0.0.1:8188`). Override with the `COMFYUI_URL`
  environment variable or the `--url` flag on the Python scripts.
- At least one checkpoint model installed and reachable from ComfyUI.
- For `comfyui-character`: a character LoRA the user trained themselves and dropped into
  ComfyUI's `models/loras/` directory. The Plugin never distributes LoRAs or character
  weights.
- For `comfyui-drama`: two character LoRAs (for two-character dramas), a distilled video
  checkpoint (LTX-2.3 class), and a TTS pipeline of the user's choice.

The Plugin does **not** download or bundle model checkpoints, LoRAs, or any other binary asset.
Each Skill instructs the user to place their own files in the standard ComfyUI directory
layout.

## Data and network

- Network access is local-only by default. The MCP server and the Python scripts both target
  the address in `COMFYUI_URL`. No telemetry, no remote calls, no analytics.
- See `docs/security-notes.md` for the threat model and the data the Plugin handles.
- See `docs/troubleshooting.md` for common failures (ComfyUI offline, missing model, OOM).

## Trying it out

End-to-end smoke test (about 5 minutes, see `examples/minimal-run.md`):

```text
Use comfyui-studio to verify that my local ComfyUI is reachable, then submit the
text-to-image workflow bundled in this Plugin with the prompt "a tabby cat sleeping
on a windowsill, morning light, photorealistic" and report the saved image path.
```

Expected outcome: the agent confirms ComfyUI is reachable, submits the bundled
`workflows/text-to-image.json` workflow, polls until done, downloads the image, and tells you
where it was saved.

## License

Apache-2.0. See [LICENSE](../../LICENSE).
