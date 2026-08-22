---
name: comfyui-character
description: Build a self-trained LoRA for a stable character and use it inside a ComfyUI workflow to keep the character consistent across many generations. Use this Skill when the user wants a recurring character (a brand mascot, a video series character, a presenter), needs cross-image consistency, or asks how to make a LoRA and where to put it.
---

# ComfyUI Character

The Plugin does **not** distribute any character LoRA, face embedding, voice sample, or other
private identity asset. Every character this Skill produces is one the user trained themselves
and dropped into ComfyUI's standard `models/loras/` directory. This Skill is about the workflow
patterns that make a user-trained LoRA actually deliver consistency — what to put in the
training set, what to put in the prompt at inference, and what mistakes to avoid.

## Scope and assumptions

- The user has a stable concept of who the character is. If they do not, help them define it
  first (name, single defining trait, recurring outfit). Without that, no LoRA will save them.
- The user (or a model-trainer agent they trust) has trained or will train a LoRA. This Skill
  does not run LoRA training; it covers the inference side and the prompt / workflow patterns
  that consume a LoRA correctly.
- The LoRA file lives at `models/loras/<user-chosen-name>.safetensors` inside the ComfyUI
  install. The Skill does not dictate the file name; the user does, when they register the LoRA
  in their workflow.

## Why most "consistent character" attempts fail

A LoRA is a strong prior on identity, but it is not magic. Three things derail consistency:

1. **Inconsistent training data.** Mix of angles, lighting, outfits, and stylizations. A LoRA
   trained on a single photo or on stylistically inconsistent reference images will not
   generalize. See `references/lora-guide.md` for the data-prep checklist.
2. **Weak prompt structure.** Putting the LoRA trigger word in a wall of adjectives loses the
   signal. The LoRA trigger must lead the prompt and the prompt must avoid words that fight it.
3. **Wrong sampler / scheduler / CFG for the base model.** Some samplers oversmooth identity
   features. See `references/prompt-patterns.md` for the rules of thumb.

## The three-step recipe

### Step 1 — Define the character with one trigger word

The user picks a single token (or a short stable phrase) that the LoRA is trained to respond to.
Examples: `mascotv1`, `presenter_anna`, `mr_noodle_v2`. This token becomes the first word of
every inference prompt. It must not collide with a common word the base model already knows
well (so not `cat`, `woman`, `office`) and must not contain spaces or punctuation the base
model's tokenizer will split unexpectedly.

### Step 2 — Compose the prompt in 4 modules, in this order

From `references/prompt-patterns.md`:

```
<trigger word>, <identity block>, <outfit block>, <pose + scene block>
```

- **Identity block** — the small set of features the LoRA was trained on (face shape, hair,
  signature accessory). Keep it short; the LoRA is doing the heavy lifting.
- **Outfit block** — what the character is wearing in *this* generation. The character wears
  different outfits across the series; do not pin a single outfit in the LoRA.
- **Pose + scene block** — what is happening in the image. This is the part that changes most.

Anything that does not fit one of these four modules is noise. Strip adjectives like
"beautiful", "stunning", "professional" — they make the base model override the LoRA. See
`references/prompt-patterns.md` for the full 8-rule prompt checklist.

### Step 3 — Plug the LoRA into the workflow

The bundled `workflows/text-to-image.json` includes a `LoraLoader` node wired into a
`CheckpointLoader` so the user can:

1. Set `lora_name` to the file they placed under `models/loras/`.
2. Set `strength_model` to a value between `0.6` and `1.0`. Start at `0.85`; lower it if the
   character overpowers the scene, raise it if identity drifts.
3. Leave `strength_clip` at the workflow's default unless the user has measured otherwise.
4. Do **not** stack multiple character LoRAs at full strength — they fight each other.

If the user's ComfyUI install uses a different workflow format (e.g. Power Lora Loader), they
adapt the same four values; the Skill does not require any particular node.

## Verifying consistency

After producing 5–10 reference images, open them in a grid view and check:

- Face shape and signature features are stable across lighting and pose changes.
- Outfit changes per the prompt, not per the LoRA.
- Pose and scene obey the prompt, not the LoRA's training set.

If identity drifts, the usual cause in order of frequency: (1) trigger word is in the wrong
position, (2) `strength_model` is too low, (3) base model was changed since training, (4) too
many identity keywords fighting the trigger. Re-run the prompt-patterns checklist and try one
fix at a time.

## What this Skill does not do

- It does not run LoRA training. Training is its own project and has its own tooling
  (Kohya, OneTrainer, ai-toolkit). The Skill only consumes a LoRA the user already has.
- It does not bundle or distribute any LoRA, model, face embedding, or voice sample. Every
  identity asset is user-supplied.
- It does not invent characters. The user must define who the character is.

## Requirements

- ComfyUI running locally (see `comfyui-workflow/SKILL.md` for the transport).
- A character LoRA the user trained, dropped under `models/loras/`.
- A base checkpoint compatible with the LoRA's training resolution.

## License

Apache-2.0. See [LICENSE](../../LICENSE).
