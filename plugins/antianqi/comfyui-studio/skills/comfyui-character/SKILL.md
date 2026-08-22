---
name: comfyui-character
description: Produce consistent character images (selfies and reference-image mimicry) using a self-trained LoRA inside ComfyUI. Use this Skill when the user wants a recurring character (a brand mascot, a presenter, a series character), needs cross-image consistency, asks how to make a LoRA and where to put it, or wants to generate "a selfie of MY character" from a reference photo. Ships two preset workflow templates: `workflows/selfie-text-to-image.json` and `workflows/selfie-mimicry.json`.
---

# ComfyUI Character

Two complementary presets for producing consistent character images with a self-trained LoRA.
The Plugin does **not** distribute any character LoRA, face embedding, voice sample, or other
private identity asset. Every character this Skill produces is one the user trained themselves
and dropped into ComfyUI's standard `models/loras/` directory.

## Two presets, one goal

| Preset | Trigger intent | Workflow |
|---|---|---|
| **生成自拍 (selfie generation)** | "Make a selfie of my character" — character fully defined by the LoRA, prompt sets pose and scene | `workflows/selfie-text-to-image.json` |
| **模仿自拍 (selfie mimicry)** | "Use this photo as a reference — make a similar image of my character" — IP-Adapter pulls pose / lighting / composition from the reference, LoRA keeps the character stable | `workflows/selfie-mimicry.json` |

Both workflows share the same contract:

- `--prompt` (or the `__PROMPT__` marker in the workflow) supplies the 4-module prompt
  structure documented in `references/prompt-patterns.md`.
- The LoRA slot expects a single file the user placed in `models/loras/`. The Plugin never
  renames, copies, or symlinks the file.
- Resolution is portrait by default (832×1216, roughly 11:16). Change `EmptyLatentImage` width
  / height for landscape, square, or other ratios.
- The seed is fixed at `42` for reproducibility. Change it for variation.

## 生成自拍 — `selfie-text-to-image.json`

Pipeline: Checkpoint → LoraLoader (single face LoRA slot) → ControlNet face → KSampler.

The bundled workflow uses a face-oriented ControlNet to keep the face shape / position stable
across pose and lighting changes. If you do not have a face ControlNet installed, set
`strength` on both `ControlNetApply` nodes to `0` and let the LoRA do the work; the workflow
will still produce a portrait, just with weaker face position lock.

### Step-by-step

1. **Place your face LoRA** at `<ComfyUI>/models/loras/your_face_lora.safetensors`. Edit the
   workflow's `LoraLoader` node to set `lora_name` to this exact filename. ComfyUI shows the
   file in its dropdown only after a `Refresh` click or a restart.
2. **Place a face ControlNet** at `<ComfyUI>/models/controlnet/any_face_controlnet.safetensors`
   and set `control_net_name` accordingly. (Skip this step if you do not have one — set both
   `ControlNetApply` strengths to 0.)
3. **Drop a face reference image** named `face_reference.png` into the ComfyUI input folder,
   OR change `LoadImage.image` to point at the file you want.
4. **Compose the 4-module prompt** (see `references/prompt-patterns.md`):
   ```
   __TRIGGER__, <identity block>, <outfit block>, <pose + scene block>
   ```
   Pass the prompt via `--prompt` on the CLI. The `__PROMPT__` marker in the workflow gets
   replaced automatically.
5. **Submit** via the Python script or the MCP server (see `comfyui-workflow/SKILL.md` for
   the transport). The script will poll until the run finishes and download the saved image
   from `outputs/`.

### Strengths and what they do

| Knob | Default | What it does | When to change it |
|---|---|---|---|
| `LoraLoader.strength_model` | 0.85 | How strongly the LoRA controls the model | Lower to 0.6–0.7 if the character overpowers the scene; raise to 0.9–1.0 if identity drifts |
| `LoraLoader.strength_clip` | 0.85 | How strongly the LoRA controls the text encoder | Usually keep the same as `strength_model` |
| `ControlNetApply.strength` (positive) | 0.75 | Face position lock strength | 0.5 for looser shots, 0.9 for strict identity |
| `ControlNetApply.strength` (negative) | 0.6 | Negative prompt's face lock (used to suppress the wrong face) | Usually 0.4–0.6 |
| `KSampler.steps` | 28 | Diffusion steps | 20 for fast drafts, 35–40 for final-quality |
| `KSampler.cfg` | 6.0 | Prompt adherence | 5 for more creative, 7–8 for stricter prompt following |

## 模仿自拍 — `selfie-mimicry.json`

Pipeline: Checkpoint → LoraLoader → IP-Adapter (pulls reference) → KSampler.

The bundled workflow uses an IP-Adapter FaceID model to pull the **face** from the reference
image while the LoRA keeps the **character identity** stable. This is the right tool when the
user has a reference photo (their own face, a stock photo, a frame from a video) and wants a
new generation that uses the same pose, lighting, and composition with their character.

### Step-by-step

1. **Place your face LoRA** at `<ComfyUI>/models/loras/your_face_lora.safetensors` and set
   `LoraLoader.lora_name` to the exact filename.
2. **Place the IP-Adapter model** at `<ComfyUI>/models/ipadapter/ip-adapter-faceid-portrait.bin`
   and set `IPAdapterModelLoader.ipadapter_file` accordingly. (If you use a different IP-Adapter
   file, e.g. SDXL vs SD 1.5, change the filename and verify the base checkpoint matches.)
3. **Drop a reference face image** named `reference_face.png` into the ComfyUI input folder,
   OR change `LoadImage.image` to point at the file you want. The reference image should
   contain a clearly visible face — IP-Adapter FaceID will not work on a landscape with no
   face.
4. **Compose the prompt**. The IP-Adapter is doing the heavy lifting on pose and lighting, so
   the prompt can be lighter: `<trigger>, <identity block>, <outfit block>` is usually enough.
   You do not need to describe the pose — the reference is providing it.
5. **Submit** the same way as the selfie workflow.

### Strengths and what they do

| Knob | Default | What it does | When to change it |
|---|---|---|---|
| `LoraLoader.strength_model` | 0.85 | LoRA weight | See selfie workflow above |
| `IPAdapterApply.weight` | 0.7 | How strongly the reference controls the image | 0.4–0.5 for looser mimicry, 0.85 for near-clone |
| `IPAdapterApply.noise` | 0.05 | Slight variation from the reference | 0.0 for exact mimicry, 0.1–0.2 for "inspired by" |
| `IPAdapterApply.weight_type` | "linear" | How the weight is applied across denoising steps | "ease in" / "ease out" / "reverse in-out" available; default works for most |

## Why most "consistent character" attempts fail

A LoRA is a strong prior on identity, but it is not magic. Three things derail consistency:

1. **Inconsistent training data.** Mix of angles, lighting, outfits, and stylizations. A LoRA
   trained on a single photo or on stylistically inconsistent reference images will not
   generalize. See `references/lora-guide.md` for the data-prep checklist.
2. **Weak prompt structure.** Putting the LoRA trigger word in a wall of adjectives loses the
   signal. The LoRA trigger must lead the prompt and the prompt must avoid words that fight it.
3. **Wrong sampler / scheduler / CFG for the base model.** Some samplers oversmooth identity
   features. See `references/prompt-patterns.md` for the rules of thumb.

## The 4-module prompt structure (summary)

From `references/prompt-patterns.md`:

```
<trigger word>, <identity block>, <outfit block>, <pose + scene block>
```

For the mimicry workflow, drop the `pose + scene` block — the reference image is supplying it.
For the selfie workflow, keep all four.

## What this Skill does not do

- It does not run LoRA training. Training is its own project and has its own tooling
  (Kohya, OneTrainer, ai-toolkit). The Skill only consumes a LoRA the user already has.
- It does not bundle or distribute any LoRA, model, face embedding, or voice sample. Every
  identity asset is user-supplied.
- It does not invent characters. The user must define who the character is.

## Requirements

- ComfyUI running locally (see `comfyui-workflow/SKILL.md` for the transport).
- A character LoRA the user trained, dropped under `models/loras/`.
- For the mimicry workflow: an IP-Adapter model (FaceID for portraits, SD 1.5 or SDXL
  depending on your base checkpoint).
- For the selfie workflow (optional but recommended): a face-oriented ControlNet.
- A base checkpoint compatible with the LoRA's training resolution.

## License

Apache-2.0. See [LICENSE](../../LICENSE).
