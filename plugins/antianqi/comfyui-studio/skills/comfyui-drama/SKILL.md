---
name: comfyui-drama
description: Generate a complete short drama video from a storyboard: first-frame image, image-to-video clip, TTS dubbing, subtitle burn, audio/video assembly. Use this Skill when the user wants a multi-shot, multi-character video with consistent character identity — ancient costume, modern urban, fantasy, or any other genre. Ships two preset workflow templates: `workflows/drama-first-frame.json` and `workflows/drama-image-to-video.json`.
---

# ComfyUI Drama

A 7-stage pipeline for producing a short drama video from a storyboard. The Plugin ships
two preset ComfyUI workflows (first-frame and image-to-video) and describes the rest of the
pipeline. The Plugin does not distribute any character LoRA, voice sample, or video model —
every asset is user-supplied.

## The 7 stages

| Stage | Output | Tool | Notes |
|---|---|---|---|
| 1. Storyboard | `desktop/<name>_分镜.xlsx` | User's spreadsheet editor or any storyboard tool | 6-column format: 序号 / 时长 / 画面 / 图片 prompt / 视频 prompt / 台词 |
| 2. TTS dubbing | `<name>_wav/00X_<role>.wav` | User's TTS pipeline (Edge TTS, IndexTTS2, Qwen3-VoiceDesign, etc.) | **TTS comes BEFORE images** — the actual measured duration is the only truth for shot length |
| 3. Script refinement | Updated Excel with measured shot lengths | User's scripting tool | Re-cut shots whose actual TTS length differs from the script estimate by > 0.5s |
| 4. First-frame image | `drama_frame_00001_.png` per shot | **This Plugin's `workflows/drama-first-frame.json`** | One image per shot, two-character LoRA slots |
| 5. Image-to-video clip | `drama_clip_00001_.mp4` per shot | **This Plugin's `workflows/drama-image-to-video.json`** | One video per shot, 8 GB VRAM friendly |
| 6. Subtitle burn | Subtitled video per shot | FFmpeg `drawtext` filter | Source Han Sans CN, 28pt, white + black 2px stroke |
| 7. Audio/video assembly | Final drama MP4 | FFmpeg `-c:v copy -c:a aac` + concat demuxer | One output MP4 per drama |

The Plugin provides templates and preset workflows for stages 4 and 5. The user runs stages
1, 2, 3, 6, and 7 with their own tools (Excel, TTS pipeline, FFmpeg). This boundary is
intentional: the Plugin does not assume a particular TTS vendor or spreadsheet format.

## Two preset workflows

### `workflows/drama-first-frame.json`

A first-frame image generator with **two LoRA slots** (one per character in a two-character
drama). For single-character dramas, set the second slot's LoRA file to a placeholder
LoRA with `strength = 0`; for two-character dramas, fill both slots.

Pipeline: Checkpoint → LoraLoader (character A) → LoraLoader (character B) → KSampler.

| Knob | Default | What it does |
|---|---|---|
| `LoraLoader[0].strength_model` (character A) | 0.8 | Identity weight for character A |
| `LoraLoader[1].strength_model` (character B) | 0.8 | Identity weight for character B |
| `EmptyLatentImage.width` / `height` | 1280 / 720 | 16:9 landscape. Change for vertical (9:16) or square (1:1) |
| `KSampler.steps` | 8 | Distilled-model default; raise to 20 for a non-distilled base |
| `KSampler.cfg` | 1.5 | Distilled-model default; raise to 6 for a non-distilled base |

**Critical prompt rule**: the image prompt describes the **first frame**, not the shot's
action sequence. A shot where character A hands a sword to character B should prompt the
moment the hands are meeting, not the full handoff motion. The video prompt is responsible
for the motion.

### `workflows/drama-image-to-video.json`

An image-to-video generator for a single shot. Takes a first-frame image (from stage 4) and
the shot's video prompt (Excel column "视频 prompt"). Outputs a single MP4 per shot.

Pipeline: Checkpoint → LoraLoader (optional motion LoRA) → LoadImage (first frame) → KSampler
→ VHS_VideoCombine.

| Knob | Default | What it does |
|---|---|---|
| `LoadImage.image` | "first_frame.png" | The first-frame image to animate. The user must change this per shot, or upload each frame to ComfyUI with a predictable filename |
| `VHS_VideoCombine.frame_rate` | 24 | Output FPS. Pair with RIFE interpolation to reach 60 |
| `VHS_VideoCombine.format` | "video/h264-mp4" | Output container/codec |
| `KSampler.steps` | 8 | Distilled LTX default; raise for non-distilled |
| `KSampler.cfg` | 1.0 | Distilled LTX default |

**Critical prompt rule**: the video prompt describes motion only — camera move, character
animation, environment dynamics, expression changes. It does **not** describe the visible
image (the model can see the first frame and already knows what is in it). The shot's dialogue
goes in a separate `dialogue` field, not the `concept` field.

### How to run a shot

1. **For each shot in the storyboard**, fill the workflow's `__PROMPT__` marker with the
   Excel "视频 prompt" column value.
2. **For each shot, set the first-frame image** by changing `LoadImage.image` to the PNG
   produced by stage 4. Use predictable filenames (`shot_001.png`, `shot_002.png`, ...) and
   the CLI's `--filename` flag to drive the workflow.
3. **Submit each shot** via the Python script or MCP server. The script will poll until done
   and download the resulting MP4.

A bulk run across all shots is straightforward but each shot is one ComfyUI submission
(because each shot has a different first-frame image and a different prompt). The Plugin does
not implement a batch driver; if you need one, use a wrapper loop in your own tool.

## A note on long jobs and VRAM

A distilled LTX-class video model running at 1280×720 with 24 FPS for a 4-second clip
finishes in roughly 2–5 minutes on an 8 GB GPU. A non-distilled 22B video model on the same
shot can take 30–60 minutes. Long jobs (over 30 minutes) should be watched with `nvidia-smi`;
the Plugin does not ship a VRAM watchdog. If your GPU is lost mid-run, the standard
recovery is to interrupt the queue and restart ComfyUI.

## What this Skill does not do

- It does not run LoRA training. Training is its own project; the Skill only consumes a LoRA
  the user already has.
- It does not bundle or distribute any LoRA, model, voice sample, face embedding, or any
  other identity asset. Every character and voice is user-supplied.
- It does not run TTS, edit Excel, burn subtitles, or assemble audio/video. Those are user
  pipeline steps that the Plugin deliberately does not assume.
- It does not ship a VRAM watchdog or auto-retry on failure. Long jobs need a human
  watching.

## Requirements

- ComfyUI running locally (see `comfyui-workflow/SKILL.md` for the transport).
- A first-frame checkpoint and (optionally) two character LoRAs the user trained, dropped
  under `models/checkpoints/` and `models/loras/`.
- A video checkpoint (distilled LTX-2.3 or similar) under `models/checkpoints/`.
- A TTS pipeline (any of the user's choice) for stage 2.
- FFmpeg for stages 6 and 7.

## License

Apache-2.0. See [LICENSE](../../LICENSE).
