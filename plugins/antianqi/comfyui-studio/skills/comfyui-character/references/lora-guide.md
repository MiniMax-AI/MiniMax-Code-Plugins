# Training a character LoRA — data, settings, and where to put the file

This Plugin consumes LoRAs the user trains themselves. It does not train LoRAs and does not
distribute any. This reference collects the data-prep and training-setting rules that make a
character LoRA actually deliver consistency at inference time.

## Where the file goes

When the user is done training, the LoRA file is a single `.safetensors` file. The user places
it under ComfyUI's standard models directory:

```
<ComfyUI install>/models/loras/<user-chosen-name>.safetensors
```

After placing the file, the user must press the "Refresh" button in ComfyUI's LoRA loader node
(or restart ComfyUI) for the file to appear in the dropdown. The Plugin never reads from any
other directory; ComfyUI's loader only sees files in the standard tree.

The Plugin does not move, copy, upload, or symlink LoRA files. The user owns the file and the
path.

## The training data checklist

The LoRA will only be as consistent as the data it was trained on. Before clicking "Train",
work through this list. Skipping items here is the most common cause of "the LoRA does not
work" reports later.

- **20–40 images is the sweet spot.** Fewer than 15 and the LoRA underfits. More than 60 and
  it overfits and you cannot change outfits at inference.
- **Varied angles.** Front, three-quarter, side, back of head. A LoRA trained only on
  front-facing photos will not survive a side profile.
- **Varied lighting.** Daylight, overcast, indoor warm, indoor cool. A LoRA trained only in
  studio lighting will not survive a sunny outdoor scene.
- **Varied outfits.** At least 3 distinct outfits across the dataset. This is the only way
  the LoRA learns to separate identity from clothing.
- **One character per LoRA.** A LoRA trained on two characters learns a confused average
  unless the user tags them with mutually-exclusive trigger words. Even then, separate LoRAs
  is simpler and more reliable.
- **Tight crops on the face** in at least 8–10 images. The LoRA needs to learn identity, and
  full-body shots with small faces give it almost no signal.
- **Consistent tagging.** Use one tool (kohya-style or ai-toolkit captions), one tag format,
  one set of trigger word placements. Mixed conventions produce mixed results.

## Recommended training settings (starter values)

These are sane defaults; the user should adjust based on their trainer's UI. Values are
intentionally generic; the user's training tool may name them differently.

| Setting | Start value | Notes |
|---|---|---|
| Network rank (dim) | 32 | 16 for SD 1.5, 32 for SDXL, 64 for Flux |
| Network alpha | 16 | Usually half of rank; some trainers want equal |
| Learning rate | 1e-4 (SD1.5), 5e-5 (SDXL), 1e-4 (Flux) | Lower if loss plateaus, raise if loss does not move |
| Training steps | 1500–3000 | Stop when preview samples stop improving |
| Batch size | 1 or 2 | Effective batch size = bs * grad_accum |
| Resolution | Match your base model | 512 for SD 1.5, 1024 for SDXL/Flux |
| Mixed precision | bf16 if supported, else fp16 | |
| Optimizer | AdamW8bit or Prodigy | Prodigy removes the LR-tuning guesswork |
| Caption dropout | 0.05 | Forces the model to read the image, not the caption |

The Plugin does not ship or endorse a particular trainer. Use whichever the user is comfortable
with.

## What to verify before you ship the LoRA

A trained LoRA is not "done" the moment training stops. Generate at least 20 test images
across three different scenes, three different outfits, and three different camera angles. If
identity holds in 18+ of them, ship it. If it holds in fewer than 15, retrain with more
diverse data — not with more steps, which overfits.

## Common failure modes and what they mean

- **Every output looks identical, ignoring the prompt** → overfit. Lower rank or training
  steps, or add more diverse data.
- **Identity is unstable across prompts** → underfit or inconsistent training data. More
  steps are usually not the answer; better-curated data is.
- **The trigger word does nothing** → either the trigger was not actually written into the
  captions during training, or the base model's tokenizer is splitting it. Try a different
  trigger.
- **Outputs look like a different character from the training set** → the LoRA learned the
  "vibe" of the dataset, not the identity. The dataset was probably too stylistically
  inconsistent. Recur with tighter curation.

## License

Apache-2.0. See [LICENSE](../../../LICENSE).
