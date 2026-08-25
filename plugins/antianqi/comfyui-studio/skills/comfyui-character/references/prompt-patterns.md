# Prompt patterns for character-consistent generation

These are the patterns that make a self-trained LoRA actually deliver a consistent character.
They are the result of empirical iteration; treat them as defaults and adjust when a specific
base model or LoRA has a measured reason to differ.

## The 4-module prompt structure

Always write the prompt in this order:

```
<trigger word>, <identity block>, <outfit block>, <pose + scene block>
```

1. **Trigger word** — the single token the LoRA was trained to respond to. Always first.
2. **Identity block** — the small set of features the LoRA was trained on. Keep it short; the
   LoRA is doing the heavy lifting here, not the prompt.
3. **Outfit block** — what the character wears in *this* generation. The character wears
   different outfits across the series; do not pin a single outfit in the LoRA training.
4. **Pose + scene block** — what is happening in the image. This is the part that changes most.

A prompt that contains material that does not fit one of these four modules is signalling
conflict to the base model. Strip it.

## The 8 rules

1. **Trigger word leads, always.** If the LoRA was trained on `mascotv1`, every prompt starts
   with `mascotv1,`. Putting the trigger in the middle of adjectives weakens the signal.

2. **No filler adjectives.** Strip "beautiful", "stunning", "professional", "cinematic",
   "8k", "highly detailed" — these tell the base model to override the LoRA with its
   photorealistic priors. The LoRA already encodes quality.

3. **4 modules > 8 modules.** A long, comma-separated prompt with 40+ tokens dilutes the
   signal. The 4-module structure beats verbose lists.

4. **No fighting the LoRA.** If the LoRA was trained on a 30-year-old male character, do not
   add "young woman, feminine face" to the identity block. The base model will try to satisfy
   both and you get a half-morphed output.

5. **Outfit is per-prompt, not per-LoRA.** Different scenes = different outfits. If every
   generation of the character wears the same jacket, the LoRA will eventually bake the jacket
   into identity and you can never change it. Vary the outfit in training data, too.

6. **Be specific about pose.** "Standing" is too vague. "Leaning on a railing, right hand in
   pocket, looking off-camera" gives the base model something concrete and reduces the chance
   of pose drift between generations.

7. **Lighting is its own sentence.** A second short clause after the 4 modules is fine:
   "mascotv1, [identity], [outfit], [pose], natural window light from the left, shallow
   depth of field". Macro lighting cues (volumetric, Tyndall, soft box) are reliable; micro
   descriptors (specular highlight at 0.3cm) are not.

8. **Negative prompts are short.** For Stable Diffusion 1.5 / SDXL / Flux the negative prompt
   should be a small fixed set: `deformed, bad anatomy, extra fingers, blurry, low quality,
   watermark`. For character consistency, *add* one phrase: `different character, identity
   drift`. Do not stack 30+ negative tokens; they fight the LoRA.

## What to do when identity drifts

If you generate 10 images and 4 of them look like a different person:

1. **Trigger word first.** Open the prompt and confirm the trigger is the first token. If you
   accidentally moved it, identity drift is the most common symptom.
2. **Bump `strength_model`.** Try 0.9 → 1.0. If that fixes it, the previous value was simply
   too low; the LoRA is fine.
3. **Check the negative prompt.** If the negative prompt contains phrases like
   `same character as before` or `consistent identity`, the base model treats them as concepts
   it has to interpret, and that interpretation varies per seed. Strip them.
4. **Check the base model.** If you trained the LoRA on SDXL 1.0 and now you are running it on
   Flux, the LoRA still loads but its effect is unpredictable. Match the base model.
5. **Reduce scene complexity.** A character in a 30-element busy scene loses identity. Move to
   a simpler scene; if identity recovers, the scene was the problem, not the LoRA.

## What to do when the LoRA is overcooked

If every image looks identical and the prompt's outfit / pose / scene are not coming through:

1. Lower `strength_model` by 0.1 and regenerate. Often that is enough.
2. Move the trigger word out of the first position. Place it second, after a strong
   scene-describing word. This works around overfit LoRAs that "lock" the first token.
3. Increase CFG slightly (e.g. 5 → 6) so the base model is allowed to push back against the
   LoRA more.
4. Re-train with more diverse outfit / pose / lighting data. The LoRA was overtrained on a
   narrow look.

## Prompt length by base model

A rough guide. Models vary; measure for your own LoRA.

| Base model | Total prompt length | Notes |
|---|---|---|
| SD 1.5 | 50–70 tokens | Compressed, the 4 modules do most of the work |
| SDXL | 60–90 tokens | A bit more room; identity block can be 8–10 tokens |
| Flux | 80–120 tokens | Flux reads natural language well; the 4 modules can become sentences |

## License

Apache-2.0. See [LICENSE](../../../LICENSE).
