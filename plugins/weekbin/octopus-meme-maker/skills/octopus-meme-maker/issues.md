# Known Issues and Failure Modes

When the user reports a problem, find the matching row, read the root cause, apply the fix. Do not skip this file.

## Ban-list (rejects any base pose that matches)

| Symptom | Root cause | Fix |
|---|---|---|
| Eyes drawn as beige sockets with a black line | Anatomy description omitted | Re-paste the full eye-anatomy block from `reference.md` into the prompt |
| Sinister / evil smirk | Prompt contains "smirk", "squinted upward", or "evil" | Remove these words; replace with "HORIZONTAL half-lidded" and "cute, not sinister" |
| Visible teeth or tongue | Prompt contains "show teeth" or "tongue" | Add explicit "NEVER show teeth or tongue" |
| Eyebrows drawn as a single black bar | Prompt contains "eyebrow" (misread as one thick bar) | Replace with the per-eye upper-eyelid arc description |
| Mouth tilts upward into a grin | Prompt or model defaulted to a smile | Add "Mouth opens HORIZONTALLY, never angles upward" |
| Head bumps absent (model rendered zero bumps) | Prompt did not mention them | Add "TWO small soft rounded nubs integrated into the upper-left and upper-right of the head silhouette" to the anatomy block |
| Head bumps HIDDEN by pose / angle / smoke / framing (model rendered them, but the camera angle, a tucked pose, dense smoke, or a tight crop hides one or both bumps) | Pose or composition overrules the bumps; this is the more common failure mode of the two | (1) Use phrasing like "soft nubs integrated into the head silhouette" instead of "ears on top" (the model produces better proportions), (2) when the scene requires a tight pose (e.g. octopus on its back, head tucked under tentacles), change the pose or the camera angle so both bumps read |
| Body surface looks flocked / fuzzy / felt / furry / woven / cloth instead of smooth Squishmallow vinyl | Model drifts toward "well-done plush" or "charred plush" and adds a fabric texture; common when the scene is BBQ / fire / hot / cozy | (1) Add the SURFACE block from `reference.md` § Prompt template verbatim, (2) call out the failure mode explicitly: "DO NOT render the body as flocked velvet, fuzzy fabric, felt, fur, woven cloth, or stitched plush", (3) add "Texture must be consistent across the entire body — no smooth/fuzzy zones", (4) re-check ALL 6 candidates in the contact sheet, not just one |
| One candidate in the batch looks sharper than the others (texture / lighting / crispness drift across the 6) | Inconsistent prompt application across parallel requests | Reject the off-style candidates and re-roll ONLY those indices with the SURFACE block added at the top of the prompt, not the bottom |

### Failure modes specific to the character anatomy (the "烤焦了" lesson)

These came up during the live contact-sheet loop and are now banned outright.
Each row maps to a specific round of re-rolls where a feedback signal
correctly translated to a prompt fix.

| Symptom (烤焦了 rounds) | Root cause | Fix |
|---|---|---|
| **Eyes too big / chibi / anime scale** (the model drew eyes covering ~30-40% of the head width when the reference shows ~15-18%) | Writing "LARGE WHITE CIRCLES" or giving the model exact numeric eye ratios ("each eye 15-18% of head width"); the model over-applies the ratio and exaggerates | Just say "MEDIUM-sized white circles" and let the reference images set the scale. Do NOT specify numeric eye ratios in the prompt — the model distorts them |
| **Bumps became bear-ear / mouse-ear / hamster-ear shape** with a flat or patch-like area on top of the head between them | Writing "ear-like bumps on top of the head" makes the model render them as discrete ears; adding "flat area between them" makes the model render that as a separate patch | Describe them as "two soft rounded nubs integrated into the head silhouette" and "emerging from the head", NOT as "ears". Do NOT add a separate "flat area" — say the top of the head is the normal pink dome |
| **Bumps too small / close together / pointy horns** (v3 — flat blob head with tiny pin-prick horns) | Strict "BOTH bumps must be visible and unobscured" rule pushed the model toward minimum-tiny horns to maximize visibility | Use the soft-nub framing (above) instead of the "must be visible" rule. The visibility comes from the head silhouette, not from explicit bumps |
| **Head became flat blob with no bumps and tentacles spread like a starfish** (v3 — model overcompensated after the "no marks on head" rule) | Removing all decoration from the head made the model simplify the character into a flat blob | Keep the soft-nub framing (which produces bumps as part of the silhouette) and trust the model. Do NOT over-restrict |
| **Head marks look like X / frown / tally / cross-hatch / tattoo** (v2 — model drew the grill marks as patterns on the head) | Asking for grill marks anywhere on the head, even subtly, leads to over-decorated patterns | All grill marks / singes / scratches / tattoo lines / X marks MUST go on the outer tentacles only. NEVER ask for marks on the head, face, or forehead |

###### Meta-rule: do not over-constrain

The "烤焦了" scene went through 5 re-roll rounds (v1 → v5) because each fix
added another MUST / SHOULD / NEVER rule. The user ultimately picked v1-5,
which was generated by the **original simple prompt** (before any of the
"fixes"). The lesson:

> **The more MUST / NEVER / ALWAYS rules you pile on, the further the
> character drifts from the reference.** Trust the model's natural
> interpretation when given a clean anatomy block + style block; only add
> rules for things the model has *demonstrably* failed at. The reference
> images do most of the anchoring work.

When you must add a rule, place it at the TOP of the prompt (after the
anatomy summary), not the bottom — rules at the bottom get deprioritized by
the model.

## Pipeline failures

| Symptom | Root cause | Fix |
|---|---|---|
| `gen_videos` rejects the path | The host rejects absolute paths and any path outside the session workspace, system temp directories included | Keep `output_file_path` and `input_image_path` workspace-relative. If `base.png` was generated outside the workspace, move it inside first |
| `make_gif.py` hangs on ffmpeg filter_complex | Single ffmpeg invocation with too many filters | The shipped script already splits the work into separate ffmpeg runs (overlay, palettegen, paletteuse); do not collapse them into one |
| `final.gif` exceeds 16 MB | Background contains gradient / motion blur / many distinct colors | Lower `PALETTE_DITHER` from `bayer:bayer_scale=5` to `bayer:bayer_scale=4` in `"${PLUGIN_ROOT}/scripts/make_gif.py"`, or reduce `FPS` from 24 to 20. Re-run stage 4; do not regenerate base or video |
| `final-mini.gif` is unexpectedly large (5 MB+) | High-frequency detail survives the 480×480 downscale, so the mini palette still needs many colors | Reduce fps from 24 to 20, or accept it — the reference scenes range 0.8–5.3 MB, so a large mini is not by itself a defect |
| Caption is longer than 8 characters | The 1080-wide overlay canvas only fits about 8 CJK glyphs at the maximum size 130 | `make_text_overlay.py` auto-shrinks the font until the caption fits and prints the size it used (`text=<w>x<h>`); check that line. Pass `--no-fit` only if you want the overflow reported as an error instead |
| `gen_videos` task stays "running" for a long time (H3) | The host is async and queued workers can take many minutes | Re-poll with `query_video_generation` about once a minute; the file appears at `output_file_path` only after the job succeeds |

## Feedback signals (translate user reports into action)

| User says | Action |
|---|---|
| "眼睛是白色的嘛" or "眼睛画错了" | Re-read `reference.md` § Anatomy; re-paste the full eye block; re-run stage 1 |
| "邪恶" / "太丑了" | Sweep the prompt for any ban-list word; replace with horizontal / cute / not-sinister |
| "质感不对" / "fuzzy" / "flocked" / "像毛绒玩具" / "像布料" | Add the SURFACE block from `reference.md` § Prompt template verbatim; reject any candidate whose body looks like fabric; re-roll with the SURFACE block at the TOP of the prompt |
| "耳朵没了" / "缺耳朵" / "头上没凸起" | First check whether the bumps are HIDDEN (camera angle / pose / framing) rather than absent — if so, change the pose or the camera angle per the "Head bumps HIDDEN" ban-list row; if truly absent, add the soft-nub framing at the very top of the prompt (NOT the "ear" framing) |
| "耳朵不对" / "bump 不像耳朵" / "bump 太大太小" / "bumps 像小熊耳" | Re-read the failure-mode row "Bumps became bear-ear / mouse-ear / hamster-ear" — reframe the bumps as "soft nubs integrated into the head silhouette", drop "ears" / "flat area" / "ear-like" from the prompt |
| "眼睛太大" / "像 chibi" / "像 anime" / "眼睛变形" | Re-read the failure-mode row "Eyes too big / chibi / anime scale" — drop "LARGE WHITE CIRCLES" and any numeric eye ratio; say "MEDIUM-sized" and trust the reference |
| "切掉了一部分" or "图片被裁了" | Stop cropping the video for text. Use the transparent overlay path (stage 4) |
| "文字后面有白底" | The script's overlay is transparent by default; check that the canvas is RGBA and `(0,0,0,0)` |
| "视频太短 / 太快" | Check `ffprobe` `nb_frames` and `duration`; the target is 141 frames at 24fps = 5.87s |
| "和之前不一样了" | The character drifted from the reference. Re-run stage 1 with all 3 reference frames attached; check whether the new prompt is over-constraining (see meta-rule above) |
| "嘴巴不对" / "嘴唇变形" / "嘴画错了" | Re-read `reference.md` § Anatomy mouth line; ensure prompt contains "small horizontal squiggly line or omega-frown, slightly open, just below the eye line. No teeth, no tongue, no visible inner mouth" |

## Maintenance

When a new failure mode is found, add a row. When a fix is no longer relevant (e.g. a ban-list word is no longer triggering the model), remove the row — do not keep a "previously this was broken" history.