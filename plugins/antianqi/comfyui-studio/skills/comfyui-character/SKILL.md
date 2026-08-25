---
name: comfyui-character
description: Produce consistent character images and reference-driven edits inside ComfyUI. Use this Skill for scenarios 1–4 from `comfyui-studio`'s trigger index: 1=生图 (selfie from text), 2=模仿 (mimic a reference image), 3=改图 (Flux.2 Klein single-image edit), 4=融合 (Flux.2 Klein dual-image fuse). Ships four preset workflow templates: `workflows/selfie-text-to-image.json`, `workflows/selfie-mimicry.json`, `workflows/flux2-klein-image-edit.json`, `workflows/flux2-klein-image-edit-dual.json`.
---

# ComfyUI Character

Four preset workflows for character-consistent selfies (with a user-trained LoRA) and
reference-image-driven edits (with Flux.2 Klein). The Plugin does **not** distribute any
character LoRA, face embedding, voice sample, or other private identity asset. Every character
this Skill produces is one the user trained themselves and dropped into ComfyUI's standard
`models/loras/` directory.

## The 4 trigger scenarios

These are scenarios 1–4 from `comfyui-studio`'s index. The number is the trigger, the workflow
is the implementation.

| # | Trigger | User says | Preset workflow | Model stack at a glance |
|---|---|---|---|---|
| **1** | **生图** (generate) | "用我的角色画一张自拍" | `workflows/selfie-text-to-image.json` | Z-Image base + 2 LoRAs (face + style) |
| **2** | **模仿** (mimic) | "照着这张照片再画一张同款" | `workflows/selfie-mimicry.json` | ZIT-flavoured Z-Image finetune + 2 LoRAs + Z-Image Fun ControlNet + Qwen3.5 vision LLM |
| **3** | **改图** (edit) | "把背景换成办公室" | `workflows/flux2-klein-image-edit.json` | Flux.2 Klein 9B + Qwen3 8B + bundled VAE |
| **4** | **融合** (fuse) | "把这张图里的人物放到那张图里" | `workflows/flux2-klein-image-edit-dual.json` | same as #3, with 2x `LoadImage` inputs |

Scenarios 1 and 2 share the **same two LoRA placeholders** (`your_face_lora.safetensors` for
the character's face, `your_style_lora.safetensors` for the artistic style). Scenarios 3 and 4
do not use LoRAs at all — the character / object identity is carried by the reference image
itself, not by a LoRA.

## Why scenarios 1 and 2 use different checkpoints

The two selfie presets use **different checkpoints** for a reason: the direct selfie is the
"default look" (Z-Image base, 8 steps, the canonical character), while the mimicry preset is a
"reference-driven" workflow that needs a ZIT-flavoured Z-Image finetune plus a ControlNet and a
local vision LLM to do the imitation. They are not interchangeable — if you want scenario 1
(direct generation), use the Z-Image base; if you want scenario 2 (mimicry), use the ZIT
finetune.

---

## Scenario 1 — 生图 (generate) — `selfie-text-to-image.json`

Pipeline: Checkpoint → `LoraLoaderModelOnly` (face) → `LoraLoaderModelOnly` (style) → KSampler.

### Models

| Field | Value (as written in the JSON) | Where it lives on disk |
|---|---|---|
| `CheckpointLoaderSimple.ckpt_name` | `Z-Image-Base-8steps-豹豹喵呜の白玉v2White_Marble-AIO_v2-bf16.safetensors` | `models/checkpoints/` |
| `LoraLoaderModelOnly[0].lora_name` (face) | `your_face_lora.safetensors` (placeholder — replace with your file) | `models/loras/` |
| `LoraLoaderModelOnly[1].lora_name` (style) | `your_style_lora.safetensors` (placeholder — replace with your file) | `models/loras/` |
| CLIP / VAE | bundled with the CheckpointLoader (outputs `[…, 1]` and `[…, 2]`) | — |

### Submit

1. **Place the two LoRAs** under `<ComfyUI>/models/loras/`. Edit the two
   `LoraLoaderModelOnly.lora_name` fields in the JSON to point at your filenames if they differ
   from the placeholders.
2. **Compose the 4-module prompt** (see `references/prompt-patterns.md`):
   ```
   <trigger word>, <identity block>, <outfit block>, <pose + scene block>
   ```
   Pass via `--prompt` on the CLI; the `__PROMPT__` marker in the workflow gets replaced.
3. **Submit** via the Python script or the MCP server (see `comfyui-workflow/SKILL.md`).

### Knobs

| Knob | Default | What it does | When to change it |
|---|---|---|---|
| `LoraLoaderModelOnly[0].strength_model` (face) | 1.0 | How strongly the face LoRA controls the model | Lower to 0.7 if the character overpowers the scene |
| `LoraLoaderModelOnly[1].strength_model` (style) | 1.0 | How strongly the style LoRA controls the model | Lower to 0.7 if the style is too dominant |
| `KSampler.steps` | 8 | Distilled-model default; raise to 20+ for a non-distilled base | — |
| `KSampler.cfg` | 1.5 | Distilled-model default; raise to 6 for a non-distilled base | — |

---

## Scenario 2 — 模仿 (mimic) — `selfie-mimicry.json`

Pipeline: `LoadImage` (reference) → `AIO_Preprocessor` → ControlNet application →
`UNETLoader` (ZIT-flavoured finetune) → KSampler → `VAEDecode` → `SaveImage`, with two
`LoraLoaderModelOnly` nodes (face + style) and a `llama_cpp_instruct_adv` node that runs the
vision LLM on the reference to produce the positive prompt.

This workflow does **not** use IP-Adapter. It uses a different mechanism: a ControlNet is fed
the reference image's preprocessed output, and a vision LLM (Qwen3.5) looks at the reference
and produces a text description that becomes the positive prompt. The two LoRAs then keep the
character identity stable.

### Models

| Field | Value (as written in the JSON) | Where it lives on disk |
|---|---|---|
| `UNETLoader.unet_name` | `ZIT-moodyPornMix_zitV10R1DPO_fp16.safetensors` (ZIT-flavoured Z-Image finetune) | `models/unet/` (or wherever your UNETLoader looks) |
| `ControlNetLoader.control_net_name` | `Z-Image-Fun-Controlnet-Union-2.1.safetensors` | `models/controlnet/` |
| `LoraLoaderModelOnly[0].lora_name` (face) | `your_face_lora.safetensors` (placeholder — replace) | `models/loras/` |
| `LoraLoaderModelOnly[1].lora_name` (style) | `your_style_lora.safetensors` (placeholder — replace) | `models/loras/` |
| `llama_cpp_instruct_adv.ckpt_name` (vision LLM) | `Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf` | `models/llama/` (or wherever the llama.cpp loader looks) |
| `LoadImage.image` | `__IMAGE1__` (replace at submit time with `--filename`) | `input/` |

### Custom nodes required

The `selfie-mimicry.json` workflow depends on several custom nodes that ship outside the default
ComfyUI install. Without these, submission will fail with `missing_node_type`.

| Custom node | Used for | Install |
|---|---|---|
| `comfyui_controlnet_aux` (or any `AIO_Preprocessor` + `ZImageFunControlnet` provider) | ControlNet preprocessing and application | `https://github.com/Fannovel16/comfyui_controlnet_aux` |
| `ComfyUI-Manager` + the `ModelPatchLoader` / `ZImageFunControlnet` nodes | Loading the Z-Image Fun ControlNet union | any pack that ships `ModelPatchLoader` |
| `ComfyUI-LLaMA-CPP` (or a llama.cpp loader for ComfyUI) | Loading `Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf` for vision reprompting | `https://github.com/daniel-lewis-ab/ComfyUI-LLaMA-CPP` (or compatible) |
| `rgthree-comfy` (or compatible Any Switch / Image Comparer pack) | The `Any Switch (rgthree)` nodes in the original workflow | `https://github.com/rgthree/rgthree-comfy` |
| `ComfyUI-Impact-Pack` (or any `LayerUtility: ImageScaleByAspectRatio V2` provider) | Aspect-ratio-aware image scaling | `https://github.com/ltdrdata/ComfyUI-Impact-Pack` |

### Submit

1. **Install the custom nodes** above.
2. **Place the model files** under the standard ComfyUI directories.
3. **Drop a reference image** into the ComfyUI input folder and pass its filename with
   `--filename` on the CLI (the `__IMAGE1__` marker in the workflow's `LoadImage.image` field
   gets replaced). Or edit the `LoadImage.image` field directly in the JSON.
4. **Set the trigger word** via `--trigger` (the `__TRIGGER__` marker in the `CR Text` node
   gets replaced).
5. **Submit** via the Python script or the MCP server. The script will poll until the run
   finishes and download the saved image from `outputs/`.

### The 4-module prompt (for the vision-LLM-reprompted positive prompt)

For scenario 2 the prompt is produced by the vision LLM, not by the user. The user provides
only the **trigger word** (via `--trigger`). The vision LLM fills in the rest of the
description from the reference image. See `references/prompt-patterns.md` for the rules of
thumb on what the trigger word should and shouldn't include.

---

## Scenario 3 — 改图 (edit) — `flux2-klein-image-edit.json`

Pipeline: `LoadImage` (reference) → Flux.2 Klein UNET + CLIP + VAE → KSampler → `VAEDecode` →
`SaveImage`. One `LoadImage` input (`__IMAGE1__`).

### Models

| Field | Value (as written in the JSON) | Where it lives on disk |
|---|---|---|
| `UNETLoader.unet_name` | `flux-2-klein-base-9b-fp8.safetensors` | `models/unet/` |
| `DualCLIPLoader.clip_name1` | `qwen_3_8b_fp8mixed.safetensors` | `models/clip/` |
| `DualCLIPLoader.clip_name2` | `diffusion_pytorch_model.safetensors` | `models/clip/` |
| `VAELoader.vae_name` | bundled with the UNET, or the user's preferred Flux.2 Klein VAE | `models/vae/` |
| `LoadImage.image` | `__IMAGE1__` (replace at submit time with `--filename`) | `input/` |

### Submit

1. **Place the reference image** into the ComfyUI input folder and pass its filename with
   `--filename` on the CLI.
2. **Pass the edit prompt** with `--prompt`. The prompt describes **what to change** (e.g.
   "the same person sitting in an office chair, professional lighting"). The reference image
   supplies the unchanged parts.
3. **Submit** via the Python script or the MCP server.

### Knobs

| Knob | Default | What it does | When to change it |
|---|---|---|---|
| `KSampler.steps` | 20 | Standard distilled-Klein default | Raise to 30+ for higher quality at the cost of latency |
| `KSampler.cfg` | 1.0 | Distilled-Klein default | Usually leave alone |
| `KSampler.denoise` | 0.75 | How much the prompt is allowed to change the reference | Lower to 0.4–0.5 for "subtle" edits; raise to 0.9+ for "full re-imagination" |

---

## Scenario 4 — 融合 (fuse) — `flux2-klein-image-edit-dual.json`

Same model stack as scenario 3, but with **two `LoadImage` inputs** (`__IMAGE1__` and
`__IMAGE2__`). The semantic is "**the subject of image 1 in the scene of image 2, with the
prompt describing the rest**" — e.g. "the person from image 1, now wearing the outfit from
image 2, in the office of image 2".

### Models

Identical to scenario 3, with one extra `LoadImage` input. Replace `__IMAGE1__` with
`--filename` and `__IMAGE2__` with `--filename2` at submit time.

### Submit

1. **Place both reference images** into the ComfyUI input folder.
2. **Pass filenames** with `--filename` (image 1, the subject) and `--filename2` (image 2,
   the scene / outfit).
3. **Pass the fusion prompt** with `--prompt` describing how to combine them.
4. **Submit** via the Python script or the MCP server.

### Knobs

Same as scenario 3, plus an extra `ReferenceLatent` strength control (default 0.85) that
governs how much of image 2 the result should inherit.

---

## Why most "consistent character" attempts fail (scenarios 1 and 2)

A LoRA is a strong prior on identity, but it is not magic. Three things derail consistency:

1. **Inconsistent training data.** Mix of angles, lighting, outfits, and stylizations. A LoRA
   trained on a single photo or on stylistically inconsistent reference images will not
   generalize. See `references/lora-guide.md` for the data-prep checklist.
2. **Weak prompt structure.** Putting the LoRA trigger word in a wall of adjectives loses the
   signal. The LoRA trigger must lead the prompt and the prompt must avoid words that fight it.
3. **Wrong sampler / scheduler / CFG for the base model.** Some samplers oversmooth identity
   features. See `references/prompt-patterns.md` for the rules of thumb.

## LoRAs are required for scenarios 1 and 2

Both selfie workflows' `LoraLoaderModelOnly` nodes reference **placeholder** LoRA filenames
(`your_face_lora.safetensors` and `your_style_lora.safetensors`). If those files do not exist
on disk, ComfyUI will fail at submission. To swap in a different LoRA, edit the `lora_name`
field in the workflow JSON to point at your file. The LoRAs are user identity assets; the
Plugin does not bundle them and does not name anyone's private LoRAs.

## What this Skill does not do

- It does not run LoRA training. Training is its own project and has its own tooling (Kohya,
  OneTrainer, ai-toolkit). The Skill only consumes a LoRA the user already has.
- It does not bundle or distribute any LoRA, model, face embedding, or voice sample. Every
  identity asset is user-supplied.
- It does not invent characters. The user must define who the character is.

## Requirements

- ComfyUI running locally (see `comfyui-workflow/SKILL.md` for the transport).
- For scenarios 1 and 2: a face LoRA and a style LoRA in `models/loras/`. The workflow JSONs
  reference them as `your_face_lora.safetensors` and `your_style_lora.safetensors`.
- For scenario 2: the custom-node pack list above. Plus a ZIT-flavoured Z-Image finetune, a
  Z-Image Fun ControlNet, and a Qwen3.5 GGUF vision LLM.
- For scenarios 3 and 4: the Flux.2 Klein 9B UNET, the Qwen3 8B CLIP, and the bundled VAE.

## License

Apache-2.0. See [LICENSE](../../LICENSE).
