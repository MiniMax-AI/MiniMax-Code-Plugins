---
name: comfyui-drama
description: Generate a complete short drama video from a storyboard. Use this Skill for scenarios 5–6 from `comfyui-studio`'s trigger index: 5=首帧 (drama first frame, two-character LoRA + prompt → 16:9 still) and 6=出片 (image-to-video, first frame + motion prompt → MP4 clip). The Skill also describes the full 7-stage pipeline around them (storyboard → TTS → script refinement → first frame → image-to-video → subtitle burn → audio/video assembly). Ships two preset workflow templates: `workflows/drama-first-frame.json` and `workflows/drama-image-to-video.json`.
---

# ComfyUI Drama

A 7-stage pipeline for producing a short drama video from a storyboard. The Plugin ships two
preset ComfyUI workflows (scenarios 5 and 6) and describes the rest of the pipeline. The Plugin
does not distribute any character LoRA, voice sample, or video model — every asset is
user-supplied.

## The 2 trigger scenarios (Part of this Skill)

These are scenarios 5 and 6 from `comfyui-studio`'s index.

| # | Trigger | User says | Preset workflow | What it produces |
|---|---|---|---|---|
| **5** | **首帧** (first frame) | "生成这部短剧第 X 镜的首帧" / "first frame of shot 3" | `workflows/drama-first-frame.json` | One 16:9 still image per shot, with two character LoRA slots |
| **6** | **出片** (image to video) | "把这个首帧做成 4 秒视频" / "turn this first frame into a clip" | `workflows/drama-image-to-video.json` | One MP4 clip per shot, ~4 seconds, 24 FPS, distilled LTX-2.3 |

The Plugin provides templates and preset workflows for both stages. The user runs stages 1, 2,
3, 6, and 7 of the surrounding pipeline with their own tools (Excel, TTS pipeline, FFmpeg). This
boundary is intentional: the Plugin does not assume a particular TTS vendor or spreadsheet
format.

## The 7 stages (the wider pipeline)

| Stage | Output | Tool | Notes |
|---|---|---|---|
| 1. Storyboard | `desktop/<name>_分镜.xlsx` | User's spreadsheet editor or any storyboard tool | 6-column format: 序号 / 时长 / 画面 / 图片 prompt / 视频 prompt / 台词 |
| 2. TTS dubbing | `<name>_wav/00X_<role>.wav` | User's TTS pipeline (Edge TTS, IndexTTS2, Qwen3-VoiceDesign, etc.) | **TTS comes BEFORE images** — the actual measured duration is the only truth for shot length |
| 3. Script refinement | Updated Excel with measured shot lengths | User's scripting tool | Re-cut shots whose actual TTS length differs from the script estimate by > 0.5s |
| 4. **First-frame image** | `drama_frame_00001_.png` per shot | **Scenario 5: `workflows/drama-first-frame.json`** | One image per shot, two-character LoRA slots |
| 5. **Image-to-video clip** | `drama_clip_00001_.mp4` per shot | **Scenario 6: `workflows/drama-image-to-video.json`** | One video per shot, 8 GB VRAM friendly |
| 6. Subtitle burn | Subtitled video per shot | FFmpeg `drawtext` filter | Source Han Sans CN, 28pt, white + black 2px stroke |
| 7. Audio/video assembly | Final drama MP4 | FFmpeg `-c:v copy -c:a aac` + concat demuxer | One output MP4 per drama |

---

## Scenario 5 — 首帧 (first frame) — `drama-first-frame.json`

A first-frame image generator with **two LoRA slots** (one per character in a two-character
drama). For single-character dramas, set the second slot's LoRA file to a placeholder LoRA
with `strength = 0`; for two-character dramas, fill both slots.

Pipeline: Checkpoint → `LoraLoader` (character A) → `LoraLoader` (character B) → KSampler.

### Models

| Field | Value (as written in the JSON) | Where it lives on disk |
|---|---|---|
| `CheckpointLoaderSimple.ckpt_name` | `Z-Image-Base-8steps-豹豹喵呜の白玉v2White_Marble-AIO_v2-bf16.safetensors` | `models/checkpoints/` |
| `LoraLoader[0].lora_name` (character A) | `character_a_lora.safetensors` (placeholder — replace) | `models/loras/` |
| `LoraLoader[1].lora_name` (character B) | `character_b_lora.safetensors` (placeholder — replace) | `models/loras/` |
| CLIP / VAE | bundled with the CheckpointLoader | — |

### Knobs

| Knob | Default | What it does |
|---|---|---|
| `LoraLoader[0].strength_model` (character A) | 0.8 | Identity weight for character A |
| `LoraLoader[1].strength_model` (character B) | 0.8 | Identity weight for character B |
| `EmptyLatentImage.width` / `height` | 1280 / 720 | 16:9 landscape. Change for vertical (9:16) or square (1:1) |
| `KSampler.steps` | 8 | Distilled-model default; raise to 20 for a non-distilled base |
| `KSampler.cfg` | 1.5 | Distilled-model default; raise to 6 for a non-distilled base |

### Submit

1. **Place the two character LoRAs** under `<ComfyUI>/models/loras/`. Edit the two
   `LoraLoader.lora_name` fields in the JSON to point at your filenames if they differ from
   the placeholders.
2. **Pass the image prompt** with `--prompt`. For a two-character drama, lead with the trigger
   words for both characters so the LoRAs can light up.
3. **Submit** via the Python script or the MCP server.

### Critical prompt rule (first-frame)

The image prompt describes the **first frame**, not the shot's action sequence. A shot where
character A hands a sword to character B should prompt the moment the hands are meeting, not
the full handoff motion. The video prompt (scenario 6) is responsible for the motion.

---

## Scenario 6 — 出片 (image to video) — `drama-image-to-video.json`

An image-to-video generator for a single shot. Takes a first-frame image (from scenario 5) and
the shot's video prompt (Excel column "视频 prompt"). Outputs a single MP4 per shot.

Pipeline: CheckpointLoader + DualCLIPLoader + VAELoader + LoraLoader (optional motion) +
`LoadImage` (first frame) + KSampler + `VHS_VideoCombine`.

### Models

| Field | Value (as written in the JSON) | Where it lives on disk |
|---|---|---|
| `CheckpointLoaderSimple.ckpt_name` | `10Eros_v1-fp8mixed_learned.safetensors` (LTX-2.3 22B finetune) | `models/checkpoints/` |
| `DualCLIPLoader.clip_name1` | `ltx-2.3_text_projection_bf16.safetensors` | `models/clip/` |
| `DualCLIPLoader.clip_name2` | `gemma_3_12B_it_fp8_scaled.safetensors` | `models/clip/` |
| `VAELoader.vae_name` | `LTX23_video_vae_bf16.safetensors` | `models/vae/` |
| `LoraLoader.lora_name` (motion) | `any_motion_lora.safetensors` (placeholder — replace, or set `strength_model = 0` to disable) | `models/loras/` |
| `LoadImage.image` | `first_frame.png` (rename per shot, or pass `--filename` to drive the workflow from the CLI) | `input/` |

### Knobs

| Knob | Default | What it does |
|---|---|---|
| `LoadImage.image` | "first_frame.png" | The first-frame image to animate. Use predictable filenames per shot and pass them via `--filename` on the CLI. |
| `VHS_VideoCombine.frame_rate` | 24 | Output FPS. Pair with RIFE interpolation to reach 60 |
| `VHS_VideoCombine.format` | "video/h264-mp4" | Output container/codec |
| `KSampler.steps` | 8 | Distilled LTX default; raise for non-distilled |
| `KSampler.cfg` | 1.0 | Distilled LTX default |

### Submit

1. **Place the first-frame image** in the ComfyUI input folder with a predictable name
   (`shot_001.png`, `shot_002.png`, ...).
2. **Pass the motion prompt** (Excel "视频 prompt" column value) with `--prompt`. The video
   prompt describes motion only — see the critical rule below.
3. **Submit** via the Python script or the MCP server. The script will poll until done and
   download the resulting MP4 from `outputs/`.

### Critical prompt rule (motion-only)

The video prompt describes motion only — camera move, character animation, environment
dynamics, expression changes. It does **not** describe the visible image (the model can see
the first frame and already knows what is in it). The shot's dialogue goes in a separate
`dialogue` field, not in the prompt.

---

## How to run a full drama (loop scenarios 5 and 6)

For each shot in the storyboard:

1. **Scenario 5**: submit `drama-first-frame.json` with the image prompt → produces
   `drama_frame_00001_.png`.
2. **Scenario 6**: rename / move the first-frame to `shot_001.png` in the ComfyUI input
   folder, then submit `drama-image-to-video.json` with the motion prompt → produces
   `drama_clip_00001_.mp4`.
3. **Stage 6** (out of scope of this Plugin): burn subtitles with FFmpeg `drawtext`.
4. **Stage 7** (out of scope of this Plugin): concat the clips and mux the TTS audio with
   FFmpeg.

Each shot is one ComfyUI submission per scenario (because each shot has a different first-frame
image and a different prompt). The Plugin does not implement a batch driver; if you need one,
use a wrapper loop in your own tool.

## A note on long jobs and VRAM

A distilled LTX-class video model running at 1280×720 with 24 FPS for a 4-second clip finishes
in roughly 2–5 minutes on an 8 GB GPU. A non-distilled 22B video model on the same shot can
take 30–60 minutes. Long jobs (over 30 minutes) should be watched with `nvidia-smi`; the Plugin
does not ship a VRAM watchdog. If your GPU is lost mid-run, the standard recovery is to
interrupt the queue and restart ComfyUI.

## What this Skill does not do

- It does not run LoRA training. Training is its own project; the Skill only consumes a LoRA
  the user already has.
- It does not bundle or distribute any LoRA, model, voice sample, face embedding, or any other
  identity asset. Every character and voice is user-supplied.
- It does not run TTS, edit Excel, burn subtitles, or assemble audio/video. Those are user
  pipeline steps that the Plugin deliberately does not assume.
- It does not ship a VRAM watchdog or auto-retry on failure. Long jobs need a human watching.

## Requirements

- ComfyUI running locally (see `comfyui-workflow/SKILL.md` for the transport).
- A first-frame checkpoint and (optionally) two character LoRAs the user trained, dropped under
  `models/checkpoints/` and `models/loras/`. The workflow JSONs reference the LoRAs as
  `character_a_lora.safetensors` and `character_b_lora.safetensors` — replace with your
  filenames.
- A distilled LTX-Video checkpoint and its CLIP / VAE files. The motion LoRA is referenced as
  `any_motion_lora.safetensors` — replace or set its strength to 0 to disable.
- A TTS pipeline (any of the user's choice) for stage 2.
- FFmpeg for stages 6 and 7.

## License

Apache-2.0. See [LICENSE](../../LICENSE).
