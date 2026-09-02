---
name: comfyui-studio
description: Drive a local ComfyUI 8188 server for image and short-clip generation. Use this Skill when the task involves a ComfyUI workflow, a local Stable Diffusion / Flux / Z-Image checkpoint, character-consistent generation with a LoRA, or producing deterministic outputs from a saved workflow JSON. Triggers on requests like "use ComfyUI to ...", "submit this workflow", "what models do I have", "generate an image with my LoRA", or "check the queue".
---

# ComfyUI Studio

A generic toolkit for driving a local ComfyUI server (default `http://127.0.0.1:8188`). It bundles
four Skills and two transport layers that work together.

## Two parts, one Plugin

| Part | What it covers | Where |
|---|---|---|
| **A. Basic control** | The transport between the agent and a local ComfyUI server. Submit any workflow, poll the queue, download outputs. | `comfyui-workflow` Skill + the stdio MCP server + the Python CLI |
| **B. Preset workflows** | Six opinionated workflow templates that solve common recurring tasks, numbered 1–6 by the user's trigger scenario. | `comfyui-character` (scenarios 1–4) + `comfyui-drama` (scenarios 5–6) + the `workflows/*.json` presets |

The Plugin also ships a dependency-free stdio MCP server (see `mcp.json` + `server.mjs`) that
exposes the same Part-A primitives (`submit_prompt`, `check_queue`, `get_image`) to any MCP-capable
agent.

## The 6 trigger scenarios (Part B)

This is the routing index. The number is the trigger scenario — read the user's intent, pick a
number, and follow the pointer.

| # | Trigger | User typically says | Preset workflow | Pointer |
|---|---|---|---|---|
| **1** | **生图** (generate an image) | "用我的角色画一张自拍" / "生成一张 XX 风格的照片" / "draw my character at a beach" | `workflows/selfie-text-to-image.json` | `comfyui-character` |
| **2** | **模仿** (mimic an image) | "照着这张照片再画一张同款" / "模仿这张图" / "use this photo as a reference" | `workflows/selfie-mimicry.json` | `comfyui-character` |
| **3** | **改图** (edit an image) | "把背景换成办公室" / "衣服换成西装" / "edit this photo: change the background" | `workflows/flux2-klein-image-edit.json` | `comfyui-character` |
| **4** | **融合** (fuse two images) | "把这张图里的人物放到那张图里" / "让她穿上这件衣服" / "put the person from this image onto that image" | `workflows/flux2-klein-image-edit-dual.json` | `comfyui-character` |
| **5** | **首帧** (drama first frame) | "生成这部短剧第 X 镜的首帧" / "first frame of shot 3" | `workflows/drama-first-frame.json` | `comfyui-drama` |
| **6** | **出片** (image to video) | "把这个首帧做成 4 秒视频" / "turn this first frame into a clip" | `workflows/drama-image-to-video.json` | `comfyui-drama` |

If the user's request does not map cleanly to one of these six, fall through to **Part A**
(below) and use `comfyui-workflow` as a generic transport for any user-supplied workflow JSON.

## Routing rules

1. **Numbers 1–4** → read `skills/comfyui-character/SKILL.md` for the recipe (model stack,
   custom-node requirements, prompt structure, LoRA slots, knobs). Submit via Part A.
2. **Numbers 5–6** → read `skills/comfyui-drama/SKILL.md` for the 7-stage pipeline and the
   per-shot rules. Submit each shot via Part A.
3. **Anything else** ("submit this workflow", "check the queue", "what models do I have",
   "use ComfyUI to ...", "run this JSON") → read `skills/comfyui-workflow/SKILL.md` directly.
   The basic control layer handles all of these without reading a preset.
4. **Health probes** ("is ComfyUI running?") → `comfyui-workflow` — its first step is always
   a `GET /system_stats` or `submit_workflow.py --probe`.

Do not duplicate behaviour: if you only need to submit a workflow, do not read this Skill, read
`comfyui-workflow/SKILL.md` directly. This Skill is the entry point for **routing**, not the
implementation.

## Required environment

The Plugin assumes the user has:

- A running ComfyUI server (default `http://127.0.0.1:8188`). Override with the `COMFYUI_URL`
  environment variable or the `--url` flag on the Python scripts.
- The checkpoint / CLIP / VAE / ControlNet files referenced in each preset (see the **Model
  boundary** section in `README.md`). Edit loader fields if your install uses different
  filenames.
- For scenarios 1 and 2 (`comfyui-character` selfie workflows): a face LoRA and a style LoRA
  in `models/loras/`. The workflow JSONs reference them as `your_face_lora.safetensors` and
  `your_style_lora.safetensors` — replace these with your filenames before submitting. The
  Plugin does not bundle LoRAs.
- For scenario 2 (`selfie-mimicry.json`): the custom-node pack list in
  `comfyui-character/SKILL.md` (controlnet_aux, LLaMA-CPP, ModelPatchLoader, etc.).
- For scenarios 5 and 6 (`comfyui-drama`): two character LoRAs the user trained themselves
  (referenced as `character_a_lora.safetensors` / `character_b_lora.safetensors` /
  `any_motion_lora.safetensors` — replace with your filenames).

The Plugin does **not** download or bundle model checkpoints, LoRAs, or any other binary asset.
Each Skill instructs the user to place their own files in the standard ComfyUI directory layout.

## Data and network

- Network access is local-only by default. The MCP server and the Python scripts both target
  the address in `COMFYUI_URL`. No telemetry, no remote calls, no analytics.
- See `docs/security-notes.md` for the threat model and the data the Plugin handles.
- See `docs/troubleshooting.md` for common failures (ComfyUI offline, missing model, OOM).

## Trying it out

End-to-end smoke test (about 5 minutes, see `examples/minimal-run.md`):

```text
Use comfyui-studio to verify that my local ComfyUI is reachable, then submit scenario 3
(改图 / flux2-klein-image-edit) with the prompt "the same person sitting in an office
chair, the same outfit, professional lighting" and report the saved image path.
```

Expected outcome: the agent confirms ComfyUI is reachable, submits the bundled
`workflows/flux2-klein-image-edit.json`, polls until done, downloads the image, and tells you
where it was saved.

## License

Apache-2.0. See [LICENSE](../../LICENSE).
