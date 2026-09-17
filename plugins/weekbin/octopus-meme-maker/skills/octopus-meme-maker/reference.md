# Character & Style Reference

Use this file to keep the character consistent across scenes. Read it before
every `image_synthesize` call in stage 1.

## What the bundled reference folders actually are

This Plugin ships two folders that work together:

| Folder | What it actually contains | Role in the pipeline |
|---|---|---|
| `examples/<scene>-base.png` | Three complete 3D Squishmallow-style base images produced by `image_synthesize` for prior scenes (stay-late / toilet-slacking / touch-fish). | **The character + style reference.** Pass all three as `input_file_paths` for every new scene; the prompt overrides the scene composition but inherits the Squishmallow style, anatomy, and rendering vibe. |
| `reference/videos/*.mp4` | Two illustrative H3-generated videos (breakdown, treat-milk-tea) showing the animation feel this Plugin targets. | **Animation-feel reference.** Optional; see § h3 Source Videos below. |

## Character — what the Squishmallow octopus ACTUALLY looks like

The character is a **3D Squishmallow / Pop Mart plush toy**. The shape below is
what `image_synthesize` produces when left to its own devices with a clean
prompt — `examples/02-stay-late-base.png` and the user-picked v1-5 of the
"烤焦了" scene are the visual ground truth.

- **Head** — a ROUND coral-pink dome, slightly egg-shaped (a touch taller than
  wide). NOT a sphere, NOT a teardrop, NOT a stretched oval.
- **Two soft head bumps** — present on the upper-LEFT and upper-RIGHT of the
  head silhouette. They are SOFT ROUNDED little nubs that **emerge from the
  head**, NOT separate ears glued on top. The bumps are part of the head's
  outline, not protruding significantly. There is a clear FLAT or gently
  domed pink area between them — about 20-30% of the head width.
- **Eyes** — TWO MEDIUM-sized WHITE CIRCLES drawn directly on the pink face.
  Each eye is roughly 15-18% of the head WIDTH (NOT oversized, NOT chibi /
  anime scale). Positioned in the LOWER-MIDDLE of the head (centers around
  55-65% down from the top).
- **Pupil** — a BLACK ROUND shape filling about 70% of the white eyeball, with
  a small WHITE HIGHLIGHT DOT (typically upper-left of the pupil) that gives
  the eye life.
- **Upper eyelid arc** — a SHORT THIN BLACK ARC sitting just above each
  white eyeball, HORIZONTAL, covering roughly the top 30% of the white
  circle in a neutral state. Never tilts up at the outer corners.
- **Mouth** — a SMALL HORIZONTAL squiggly line or omega-frown, slightly open.
  Located just BELOW the eye line (about 75% down from the top of the head).
  Subtle, not exaggerated.
- **Tentacles** — 8 short stubby pink tentacles around the body, slightly
  curved.
- **Body** — uniform coral-pink, NO second tone, NO shading patches, NO
  accessory ears / hair / clothes.
- **Surface** — smooth Squishmallow / Pop Mart plush-toy vinyl sheen. NOT
  flocked velvet, NOT fuzzy fabric, NOT felt, NOT fur, NOT woven cloth,
  NOT stitched plush.

### Critical anatomy rules

- **Bumps MUST stay integrated into the head silhouette.** If you describe them
  as "ears" or emphasize them as separate features, the model produces
  mouse-ear / bear-ear shapes. Use the soft-nub framing.
- **Eyes MUST stay medium-sized.** If you write "LARGE WHITE CIRCLES" or
  specify exact eye proportions, the model drifts toward chibi / anime scale.
  Just say "medium-sized white circles" and trust the reference images to
  set the scale.
- **No markings / singes / textures on the head or face.** Tentacle singes
  are OK on the underside of outer tentacles. Marks on the head turn into
  X's, tally lines, frown marks, or patch artifacts.
- **No "EXACT" numeric ratios** in the prompt. The model over-applies numeric
  ratios (e.g. "each bump 18-22% of head width") and produces distorted
  cartoon geometry. Describe the SHAPE, not the NUMBER.

## Style

- Smooth Squishmallow / Pop Mart 3D render, vibrant coral-pink plush-toy
  surface with a soft vinyl sheen.
- Render quality: high-resolution, crisp details, consistent surface texture
  across the whole body. Reject any output that looks blurry, fuzzy, or has
  inconsistent texture zones (e.g. smooth head but flocked tentacles).
- Soft warm lighting. Background varies by scene (office desk for work scenes,
  restroom for toilet scenes, BBQ grill for grill scenes, etc.).
- Cute, not sinister. The whole character reads as a friendly office worker /
  meme character.

## Reference images

**Always pass the three `examples/*.png` files** as `input_file_paths` to
`image_synthesize` for every new scene. They lock the
Squishmallow style, the 8 tentacles, the eye anatomy, and the head bumps.
The prompt supplies the new scene composition; the references supply the
visual style.

| File | What it shows |
|---|---|
| `examples/02-stay-late-base.png` | Half-lidded eyes, octopus at desk with coffee + monitor |
| `examples/10-toilet-slacking-base.png` | Open-mouth smile, big sparkly eyes, octopus on toilet reading phone |
| `examples/11-touch-fish-base.png` | Side-glance, octopus at desk with salmon |

If you also have a relevant H3 source video (see § h3 Source Videos below),
extract its first frame into the session workspace and pass it as a fourth
`input_file_path` to lock the scene composition too.

## Prompt template (paste into image_synthesize)

```text
A cute pink octopus mascot plush toy character in [SCENE_POSE].
Round coral-pink head with TWO small soft rounded nubs integrated into the
upper-left and upper-right of the head silhouette. There is a flat pink area
between the two nubs (about 25% of the head width). 8 stubby pink tentacles.

[Concrete action / expression / prop description for this scene]

CRITICAL EYE ANATOMY (must match the reference exactly):
- The whole head and face is the SAME coral-pink plush body color.
- The eyes are MEDIUM-sized white circles drawn directly on the pink face.
- Inside each white eyeball there is a BLACK ROUND PUPIL that fills about
  70% of the white, with a small WHITE HIGHLIGHT DOT on the upper-left of
  the pupil.
- A SHORT THIN BLACK UPPER EYELID ARC sits just above each individual white
  eyeball, covering roughly the top 30% of the white circle.
- The eyelid arc is HORIZONTAL — never tilts upward at the outer corners
  (NEVER smirk, NEVER evil).
- Both arcs are the same length and mirror each other.
- Plenty of WHITE EYEBALL VISIBLE around the black pupil and under the
  eyelid.

MOUTH: small horizontal squiggly line or omega-frown, slightly open, just
below the eye line. No teeth, no tongue, no visible inner mouth.

EXPRESSION: [scene-specific emotion], cute, not sinister.

[Pose / background / KEEP / NO list per scene]

SURFACE (highest priority after anatomy):
- The character body must have a smooth Squishmallow / Pop Mart plush-toy
  vinyl surface with a soft sheen.
- DO NOT render the body as flocked velvet, fuzzy fabric, felt, fur, woven
  cloth, or stitched plush.
- Texture must be consistent across the entire body — no smooth/fuzzy
  zones.
- Crisp high-resolution render, no soft blur.

Style: high-quality 3D character render (NOT 2D cartoon, NOT pixel art, NOT
clay), vibrant coral-pink Squishmallow plush-toy vinyl surface, soft warm
lighting, [scene background]. The character is the same pink octopus mascot
from the reference images.
```

## h3 Source Videos

`reference/videos/` holds 2 illustrative H3-generated videos — one expressive-anxiety scene and one multi-tentacle-coordination scene — selected as samples of the animation feel (tentacle weight, eye-blink timing, prop interaction). Both are 768×768, 24 fps, 6.58 s, 158 frames, h264 + aac.

| File | Size | Scene | Notes |
|---|---|---|---|
| `breakdown-h3.mp4` | 478 KB | 我裂开了 | Both hands on the head, eyes spiraling |
| `treat-milk-tea-h3.mp4` | 631 KB | 请大家喝奶茶 | All 8 tentacles holding a colorful cup |

This Plugin ships 2 sample videos to keep the package small. They are illustrations of the animation feel, not a required input. Generate the H3 video for your own scene when you reach stage 2.

### When to use an h3 video as the base input

When an H3 video for the target scene already exists (this Plugin's
`reference/videos/`, or one you generated), extract its first frame **into the
session workspace** and pass that frame as a fourth `input_file_path` — for
example, write it to `<scene-dir>/iterations/h3-first.png` and pass
`input_file_paths = [the 3 examples/*.png, "<scene-dir>/iterations/h3-first.png"]`.
The host accepts at most 4 reference images and rejects paths outside the
session workspace, so a frame left in `/tmp` cannot be used. This locks the
Squishmallow style and the scene composition, so stage 1 only needs to vary the
pose / expression — not the whole layout.

## Default settings

- `resolution`: `1K`, `aspect_ratio`: `1:1` → 1024×1024 PNG
- `input_file_paths`: the 3 `examples/*.png` files (the host accepts at most 4)
- Negative prompt: anything that triggers the `issues.md` ban-list (smirk,
  evil, teeth, tongue, eyebrow, tilted eyelids, missing head bumps,
  bear-ear bumps, chibi / anime proportions, fuzzy / flocked body,
  head markings)