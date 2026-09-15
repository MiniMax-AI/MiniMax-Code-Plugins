---
name: octopus-meme-maker
description: Use this skill when the user asks for a new pink-octopus office-worker GIF meme, a Smooth Squishmallow-style worker octopus sticker, a 4-character Chinese caption on a 720x720 looping GIF, or wants to add a scene to an existing meme library. Drives a 4-stage pipeline (base pose via image_synthesize -> 6s 24fps video via gen_videos -> transparent Chinese text overlay via Pillow -> 720x720 + 480x480 GIF via ffmpeg) and enforces a strict character-anatomy ban-list. Read this skill before starting any new scene.
license: Apache-2.0
metadata:
  author: weekbin
  version: 0.2.0
---

# Octopus Meme Maker

Generate one 720×720 looping GIF + one 480×480 mini-GIF per scene. Read this entire file before producing any output.

## 1. Pre-flight

`${PLUGIN_ROOT}` is the environment variable MiniMax Code sets to this Plugin's root directory. Every command in this file is anchored to it, so the commands work from any working directory.

Read `reference.md` (anatomy + prompt template) and `issues.md` (ban-list + failure modes) before stage 1.

### 1.1 Copy the reference frames

Shell blocks in this file are POSIX shell: macOS, Linux, or Git Bash on Windows.

The character / style reference is the **3 `examples/*.png` files** (3D
Squishmallow-style bases from prior scenes). `reference.md` § Reference images
explains why a finished base pose, and not a video frame, is the right anchor.

```shell
mkdir -p <scene-dir>/iterations <scene-dir>/frames-check
cp "${PLUGIN_ROOT}"/examples/*.png <host-image-synthesize-input-dir>/
```

Exit condition: `ls "${PLUGIN_ROOT}"/examples/*.png` lists 3 files; `<scene-dir>/iterations/` and `<scene-dir>/frames-check/` exist.

## 2. Stage 1 — base pose (image_synthesize, 2K 1:1)

Generate a 1024×1024 PNG that the user has personally picked from a contact
sheet. **The hard gate is "抽 6 张拼图给用户挑" — never ask the user to
confirm a single image, and never pick on the user's behalf.** The first
non-contact-sheet round is treated as an unauthorised shortcut.

### 2.1 Generate 6 candidates in one batch

Submit one `image_synthesize` call with **6 parallel requests** in the
`requests` array (NOT 6 separate calls). The tool accepts up to 10 requests.
All 6 share the same prompt and the same `input_file_paths` — the 3
`examples/*.png` files, since the tool accepts at most 4 reference images per
request. The model returns 6 distinct candidates in one round-trip.

Save successful outputs to `<scene-dir>/iterations/vN-{1..6}-base.jpg`,
where `N` is the round number starting at 1. Reject any candidate that
matches an `issues.md` ban-list entry — note the bad index, but keep the
rest of the batch.

If the round's batch has fewer than 4 non-banned candidates, re-roll only
the bad indices with a refined prompt (see § 7.1) and append the new ones
to the same round. Do not move on to round N+1 just because one image was
weak.

### 2.2 Compose the contact sheet

```shell
python3 "${PLUGIN_ROOT}/scripts/make_contact_sheet.py" \
  <scene-dir>/iterations/vN-1-base.jpg \
  <scene-dir>/iterations/vN-2-base.jpg \
  <scene-dir>/iterations/vN-3-base.jpg \
  <scene-dir>/iterations/vN-4-base.jpg \
  <scene-dir>/iterations/vN-5-base.jpg \
  <scene-dir>/iterations/vN-6-base.jpg \
  <scene-dir>/iterations/vN-contact-sheet.png
```

The script lays the 6 candidates in a 3-cols × 2-rows grid with a bold
number badge (1-6) on each cell so the user can answer "3" / "选 2" /
"第 5 张" without ambiguity. Default cell size is 480×480; the sheet is
1460×974 px.

Exit condition: `<scene-dir>/iterations/vN-contact-sheet.png` exists and
shows 6 distinct numbered cells.

### 2.3 Hand the contact sheet to the user

Deliver the contact sheet to the user as an inline image — use a `<media />`
tag so all 6 candidates are visible at once without leaving the chat. Then
**STOP and wait** for the user to pick. This is a hard gate that nothing
in Stage 1 or Stage 2 may bypass.

#### Output to the free canvas

The contact sheet MUST land on the user's free canvas (the workspace panel
that surfaces generated files) as well as in the chat reply. The action is
two-part:

1. **Persist to disk** — the contact sheet is already at
   `<scene-dir>/iterations/vN-contact-sheet.png` after § 2.2; the 6
   individual candidates are at `<scene-dir>/iterations/vN-{1..6}-base.jpg`.
   Both paths must remain valid after the contact-sheet delivery.
2. **Surface in chat** — emit a `<media src="/abs/path/to/vN-contact-sheet.png" />`
   tag inside an assistant turn so the user can see all 6 candidates inline.

Both steps are required. Persisting without surfacing leaves the user
guessing; surfacing without persisting means the user cannot re-pick later.

| User signal | Action |
|---|---|
| **A number** ("3", "选 2", "第 5 张") | Copy `iterations/vN-{N}-base.jpg` → `<scene-dir>/base.png` and proceed to Stage 2. |
| **All-bad signal** ("全部不行" / "再抽" / "继续抽卡" / "都不行") | Start a new round: bump N → N+1, refine the prompt per § 7.1, re-run § 2.1 and § 2.2. Repeat until the user picks. |
| **Specific feedback** ("3 号嘴有问题" / "想要更慵懒" / "表情再焦一点") | Treat as both a pick AND a refinement: lock the chosen one as `base.png`, note the feedback, then start a follow-up round N+1 with the feedback applied before committing to Stage 2. |

**The contact-sheet loop is mandatory and runs until the user picks.**

- **STOP after every contact-sheet delivery.** Do not start Stage 2, do not
  start a follow-up round, do not move on in any way — the loop must wait
  for the user's reply.
- **Loop indefinitely.** There is no upper bound on `N`; keep re-rolling
  with the user's feedback applied until they pick a number or signal
  abandon / relax.
- **Only the user ends the loop.** A single 'best of 1-2' round, picking
  on the user's behalf because a candidate 'looks great', or skipping the
  contact sheet to save time are all unauthorised shortcuts and forbidden.
  The user is the curator; the model's taste does not count.

Exit signal of § 2.3: the user has typed a number (e.g. "3" / "选 2") OR
has explicitly signalled that they want to abandon / relax the prompt. No
other input counts.

### 2.4 Prompt skeleton

```text
A cute pink octopus mascot plush toy character in <SCENE_POSE>.
[Full anatomy block — see reference.md § Anatomy]
[Scene-specific action / expression / prop]
Style: Squishmallow / Pop Mart 3D render, NOT furry, NOT stitched plush.
```

Exit condition: `<scene-dir>/base.png` is a 1024×1024 PNG copied from a
contact-sheet candidate the user has explicitly chosen. The contact-sheet
loop has no upper bound on rounds — keep re-rolling until the user picks.
Only an explicit user signal ("选了 / OK / 继续 / 放弃 / 放松 prompt") ends
the loop; nothing else counts.

## 3. Stage 2 — video (gen_videos)

Call `gen_videos` once with a single request in the `requests` array (the tool
accepts up to 5).

### 3.1 gen_videos parameters

| Field | Value |
|---|---|
| `prompt` | the stage 1 style block + this scene's motion description |
| `output_file_path` | `<scene-dir>/video.mp4` — required |
| `input_image_path` | `<scene-dir>/base.png` — the base pose the user picked |
| `reference_type` | `first_frame` |
| `duration` | `6` |
| `resolution` | `1080P` |

Every path passed to a host tool must be **workspace-relative**. The host
rejects absolute paths and any path outside the session workspace, system temp
directories among them. `output_file_path` is where the host writes the mp4 —
there is no separate copy step.

`fps` is not a `gen_videos` parameter. The host picks the frame rate and
returns 24 fps for these clips, which is what the stage 4 scripts expect.
Generation is asynchronous and can take several minutes; the file appears at
`output_file_path` only after the job succeeds.

Exit condition: `<scene-dir>/video.mp4` exists and `ffprobe -show_streams video.mp4` reports `width=1080 height=1080` at `r_frame_rate=24/1` with `nb_frames=141`.

## 4. Stage 3 — preview strip (sanity check, not the deliverable)

### 4.1 Generate the strip

```shell
python3 "${PLUGIN_ROOT}/scripts/make_preview_strip.py" <scene-dir>/video.mp4 \
  <scene-dir>/frames-check/preview.png \
  --labels "t=0.0s,<pose>,t=1.8s,<pose>,t=3.0s,<pose>,t=4.2s,<pose>,t=5.8s,<pose>"
```

Exit condition: `frames-check/preview.png` exists, 5 frames wide, and the user confirms the animation reads as expected.

## 5. Stage 4 — GIF assembly (the deliverable)

### 5.1 Compose both GIFs

```shell
python3 "${PLUGIN_ROOT}/scripts/make_gif.py" <scene-dir> "<caption>"
```

The script writes both `<scene-dir>/final.gif` (720×720) and `<scene-dir>/final-mini.gif` (480×480). Both scripts resolve their own location, so the command works from any working directory.

File size tracks scene complexity, not a fixed budget. Across the 23 reference scenes the main GIF lands between 2.8 MB and 15.8 MB (median 7.2 MB), and the mini GIF between 0.8 MB and 5.3 MB (median 1.6 MB). Report both sizes to the user as information; treat the ranges as a sanity band rather than a cap.

Exit condition: both files exist, `ffprobe -select_streams v:0 -show_entries stream=width,height,nb_frames` reports `720,720,141` for `final.gif` and `480,480,141` for `final-mini.gif`, and the caption reads correctly. If `final.gif` exceeds 16 MB, apply the reduction levers in § Failure Recovery.

### 5.2 Output to the free canvas

The final GIFs are the deliverable. They MUST land on the user's free canvas
(workspace panel that surfaces generated files) as well as in the chat
reply. Same two-part action as § 2.3:

1. **Persist to disk** — `final.gif` and `final-mini.gif` are already at
   `<scene-dir>/final.gif` and `<scene-dir>/final-mini.gif` after § 5.1.
   Both paths must remain valid after delivery.
2. **Surface in chat** — emit two `<media src="..." />` tags (one for
   `final.gif`, one for `final-mini.gif`) inside the assistant turn that
   announces the GIF is ready. Wrap them in a single `<deliver-assets>`
   block so the user can download both files from the chat:
   ```xml
   <deliver-assets>
     <media src="/abs/path/to/final.gif" caption="烤焦了 (720×720, N MB)" />
     <media src="/abs/path/to/final-mini.gif" caption="烤焦了 (480×480, N MB)" />
   </deliver-assets>
   ```

Both steps are required. The user wants to see the GIF inline AND have it
persisted for reuse in chat apps / downloads.

## 6. Examples

### 6.1 摆烂躺平 (lying flat)

- Caption: "摆烂躺平"
- Pose: sprawled on the desk, one eye half-closed, one tentacle holding a coffee cup
- Expected: `base.png` 1024×1024; `final.gif` ≈ 6 MB; `final-mini.gif` ≈ 1.6 MB.

### 6.2 假装很忙 (pretending to be busy, no caption)

- Caption: (none)
- Pose: phone in one tentacle, eyes down, neutral mouth
- Stage 4 command: `python3 "${PLUGIN_ROOT}/scripts/make_gif.py" <scene-dir> ""` — the overlay is empty, only the video frames survive.

### 6.3 期待 m3pro (waiting for m3pro)

- Caption: "期待 m3pro"
- Pose: tentacles cupping the cheeks, eyes wide
- Expected: `base.png` 1024×1024; `final.gif` ≈ 4 MB; `final-mini.gif` ≈ 1.0 MB.

## 7. Failure Recovery

### 7.1 Stage 1 contact-sheet round needs a re-roll

If the user issues an all-bad signal ("全部不行" / "再抽" / "继续抽卡") or
specific feedback ("嘴不行" / "表情不够慵懒" / "质感不对" / "缺耳朵"):

1. Re-read `issues.md` § Ban-list and § Feedback signals. Map the feedback
   to one or more concrete prompt deltas — e.g.:
   - "mouth too dark" → drop any word that could be misread as a lip color;
   - "想要更慵懒" → push the eyelid-arc coverage from "top 30%" to "top 50%";
   - "再焦一点" → raise grill-mark count from 3-4 to 5-6 stripes;
   - **"质感不对" / "fuzzy" / "flocked" / "像毛绒玩具"** → add the SURFACE
     block from `reference.md` § Prompt template at the TOP of the prompt;
     call out the failure mode explicitly; re-check ALL 6 candidates not
     just the ones the user flagged (texture drift tends to cluster in
     the same batch);
   - **"缺耳朵" / "头上没凸起"** → count the candidates that clearly show the
     nubs. If **≥ 1 of 6** shows them, they are HIDDEN by pose / angle / smoke
     (the common case): change the pose or the camera angle. If **0 of 6**
     shows them, they are genuinely absent: add the bumps line at the very top
     of the prompt.
2. Increment N → N+1. Generate a new batch of 6 candidates with the
   refined prompt. **Do not** delete the previous round's files; they are
   evidence and let the user compare.
3. Compose a fresh contact sheet and re-deliver to the user.

If `N` reaches 4 without a user pick, escalate: surface the best candidate
from rounds 1-3 in a final contact sheet and ask the user to either pick
the best of the rest, relax the prompt scope, or abandon the scene.

### 7.2 Stage 2 gen_videos rejects the path

The host rejects absolute paths and any path outside the session workspace,
system temp directories among them. Keep both `output_file_path` and
`input_image_path` workspace-relative, e.g. `<scene-dir>/video.mp4` and
`<scene-dir>/base.png` relative to the session workspace root. If `base.png`
was generated outside the workspace, move it inside first, then re-submit with
the relative path.

### 7.3 Stage 4 final.gif exceeds 16 MB

The scene carries heavy motion blur, a wide gradient, or many distinct colours. Lower `PALETTE_DITHER` from `bayer:bayer_scale=5` to `bayer:bayer_scale=4` in `"${PLUGIN_ROOT}/scripts/make_gif.py"`, or reduce `FPS` from 24 to 20. Re-run stage 4; do not regenerate base or video.

## 8. Quick Reference

| Stage | Tool | Output | Exit criterion |
|---|---|---|---|
| 1. base pose (loop) | `image_synthesize` + `make_contact_sheet.py` | `<scene-dir>/base.png` | 1024×1024 PNG, user-picked from a 6-image contact sheet; loop N → N+1 indefinitely until user picks |
| 2. video | `gen_videos` | `<scene-dir>/video.mp4` | 1080×1080, 141 frames @ 24fps || 3. preview | `make_preview_strip.py` | `frames-check/preview.png` | 5 frames wide |
| 4. GIF | `make_gif.py` | `final.gif` + `final-mini.gif` | 720,720,141 and 480,480,141 |

For character anatomy, prompt template, and reference frames, see `reference.md`. For known failure modes and feedback-signal translations, see `issues.md`.

## 9. Hard Rules

- **Stage 1 IS a contact-sheet loop. Generate 6 candidates, compose a contact sheet, deliver to the user via `<media />`, then STOP and wait for the user to pick. Loop N → N+1, N+2, ... indefinitely until the user picks a number or explicitly signals abandon / relax. Stage 2 must not start until the user has picked.** This is the most important rule in this file. A single 'best of 1-2' round, picking on the user's behalf, or skipping the contact sheet because a candidate 'looks great' are all forbidden. The user is the curator, not the model.
- **Never pick on the user's behalf.** Stage 2 must not start until the user has explicitly chosen a number or issued an abandon / relax signal.
- **Never crop the video to fit text.** The text is composited as a transparent overlay, not baked into the video.
- **Never hardcode scene paths.** Use `<scene-dir>` as a parameter; the Plugin must work for any user-provided scene name.
- **Never delete old iteration files.** They are evidence and let the user compare across rounds.
- **Output to the free canvas at every key checkpoint.** Stage 1 contact sheets (§ 2.3) and Stage 4 final GIFs (§ 5.2) MUST be persisted to the workspace AND surfaced inline via `<media />` (and the final GIFs wrapped in `<deliver-assets>`). Persisting without surfacing leaves the user guessing; surfacing without persisting means the user cannot reuse the file.
- **Do not over-constrain the prompt.** Each MUST / SHOULD / NEVER rule you add increases the chance of character drift. Add a rule only when the model has *demonstrably* failed at something. The "烤焦了" scene went through 5 re-roll rounds (v1 → v5) precisely because every round added another rule; the user ultimately picked the v1 candidate that was generated by the original simple prompt. Reference images do most of the anchoring work — trust them.
- After stage 4, append a row to the maintainer's `README.md` scene table with `path`, `caption`, and `size` for both GIFs.
