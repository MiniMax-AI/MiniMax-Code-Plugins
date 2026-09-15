# Examples — base pose samples

This directory holds `base.png` samples that the maintainer has successfully extracted. They serve two purposes:

1. **抽卡的基础图** — pass them as `input_file_paths` to `image_synthesize` to lock the Squishmallow style, the character anatomy (8 stubby pink tentacles, head bumps, large white-circle eyes with black round pupils), and the soft 3D render vibe. The prompt overrides the scene composition for the new scene. **All three should be passed together** for every new base pose; do not cherry-pick one.
2. **Reference for the scene table** — the file naming matches the maintainer's external scene table, e.g. `<works>/octopus-worker-meme/<scene-number>-<scene-name>/`, so consumers can cross-reference.

| File | Source | Use as `image_synthesize` input_file_path? |
|---|---|---|
| `02-stay-late-base.png` | image_synthesize (seeded with maintainer's external H3 first frame) | yes — locks coffee + half-lidded eyes |
| `10-toilet-slacking-base.png` | image_synthesize (no matching H3 source) | yes — locks toilet tiles + phone + open-mouth smile |
| `11-touch-fish-base.png` | image_synthesize (seeded with maintainer's external H3 first frame) | yes — locks desk + salmon + side-glance |

When adding a new base, follow the `<scene-number>-<scene-name>-base.png` convention. The matching H3 source video is not required and is not part of this package; this Plugin only ships 2 illustrative H3 videos in `reference/videos/` (`breakdown-h3.mp4`, `treat-milk-tea-h3.mp4`).
