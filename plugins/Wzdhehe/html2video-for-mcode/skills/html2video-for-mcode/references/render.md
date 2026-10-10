# Render Pipeline and Troubleshooting

## Why capture doesn't "wait a few seconds and then screenshot"

A fixed sleep is the most fragile kind of wait: on a slow machine the shot is taken before the animation has finished and the fonts have swapped; on a fast machine it just waits for nothing. capture.mjs is entirely event-driven:

- **Fonts**: wait for each `link[rel=stylesheet]` load/error → explicitly `load()` every face in `document.fonts` (`font-display: swap` postpones the download, and without an active load the font may never be fetched) → `fonts.ready` → two rAFs so layout settles on the real glyphs. Hard cap of 8s overall.
- **Images**: wait for all `<img>` to be complete, 4s cap per image, skip anything that won't load (which is why assets must be local first).
- **Page load**: `domcontentloaded`, no waiting for `load`/`networkidle` (a single hanging external resource would burn a dead wait into the result).

## still mode (final-state screenshots)

All finite animations jump straight to their final state with `Animation.finish()` (fill-mode forwards holds it), infinite ambient animations keep running naturally, and the screenshot is "what the viewer sees when this slide is finished". Speed: 1–2s per slide.

## motion mode (animations really go into the video)

Principle = deterministic frame-by-frame stepping:

1. `pause()` all animations and pin them to `currentTime = 0`.
2. Every frame, set **every animation**'s `currentTime` uniformly to `i / fps`. CSS animations carry their own `animation-delay`, and currentTime is absolute time including the delay, so per-layer timing is naturally correct — which is also why you must not hand-write delays in the HTML and must let the pipeline inject `--t1/--t2/--t3`.
3. `page.screenshot()` each frame into a PNG sequence.
4. At encode time `tpad=stop_mode=clone` clones the last frame to fill the whole slide duration: only the animation window is rendered frame by frame, still segments cost nothing.

Shoot only the animation window (longest animation endTime + 0.25s) rather than the full slide duration; 8 slides × 30fps usually needs only 600–1200 frames, about 2–6 minutes (50–200ms/frame). Budget it into the timeout, don't kill it midway. Slides with long entrance choreography scale linearly (frames = Σ per-slide animation windows × fps — measured: 5 × 15s ≈ 2250 frames, 6–8 min) — for quick passes drop `fps` to 24 in `script.json`, trim the choreography, or shoot in batches (`--ids 01,02`, then `--ids 03,04`; frame dirs are per-slide and accumulate).

Limitation (which is what decides when to fall back to still): all page motion must be driven by CSS `@keyframes` / WAAPI. `<video>` elements, `setTimeout` choreography and rAF physics cannot be seeked — this layout spec already disables them, so you normally won't hit this.

## Subtitle system (capture burns them in automatically, on by default)

Subtitles are not written in the HTML and are not the author's concern: capture reads `clauses[]` from `timings.json` (single source of truth) and injects them before the page loads — one `.kit-sub` element per sentence, bottom-centered, pill background + text color taken from theme hooks (`--sub-bg` / `--sub-fg` / `--sub-ring`, defaulting to dark translucent + white text, legible on both light and dark themes); display window = this sentence's onset → next sentence's onset, built as a **full-duration percentage keyframe animation** that works naturally under frame-by-frame seeking, and hidden automatically after `finish()` in still mode (so Gate 4 static previews show no subtitles; subtitle acceptance happens at Gate 5 on the final video).

**All geometry follows the canvas variables**, so neither landscape nor portrait needs code changes:
- position `bottom = --stage-h × 0.0778` (= 84px at 1920×1080, clear of slide-num)
- width `max-width = --stage-w × 0.729` (= 1400px at 1920, narrows automatically in portrait)
- font size/padding `× --sub-scale` (capture computes it from canvas width, narrowing to a 0.75 floor in portrait to stay readable)

On dark themes always check subtitle contrast: run `node scripts/check-theme.mjs <项目>`, which computes the contrast of "subtitle text vs the pill composited onto the background". Dark themes are advised to use `--sub-bg: rgba(0,0,0,.58)` plus `--sub-ring: 1px solid rgba(255,255,255,.16)` for visual separation.

### How to verify subtitle readability (the trio, none optional)

1. **Numeric gate** — run `node scripts/check-theme.mjs <项目>`: it computes "subtitle text vs the pill composited onto the background" contrast, and <4.5:1 is an immediate fail (this is the only gate that automatically stops "subtitles smeared into a dark background").
2. **Frame gate** — subtitles only appear in the final video (a still preview finishes them away), so you have to pull motion frames to look:
   ```bash
   node scripts/capture.mjs <项目> --mode motion --ids 01   # 先出帧
   # 抽某句开口之后的一帧(例: 第 2 句 3.4s → 取 3.6s)
   ffmpeg -y -v error -i build/frames/01/f00108.png -vf "crop=iw:0.22*ih:0:0.70*ih" sub-check.png
   ```
   **Subtitle changes after the animation window (1.5.0)**: subtitles are full-duration percentage animations, while the frame sequence only covers the animation window — so the remainder used to be padded with the last frame and **every later subtitle change was frozen in the video** (and on the no-fx/static path, `finish()` parks the subtitle animation at `opacity: 0`, so nothing was burned at all). capture now emits one still per sentence (`build/substills/<id>/s<k>.png`) plus a manifest (`build/substills/<id>.json`, recording `framesCover` and each window), and build-video composes `[frame sequence] + [one still per uncovered window]` — the parts must sum to the slide duration, which the duration self-check enforces.

Check three things: whether the subtitles appear, whether they are cropped, and whether the bottom overlaps the page number. If capture finds a slide without clauses it warns outright (it will no longer silently produce a subtitle-less video).
3. **Mute gate (Gate 5)** — watch the whole video with the sound off: can you follow it on subtitles alone? This is the hearing-impaired viewpoint, and also the acceptance standard for platform auto-captions.

Implementation details (so you know where to look when troubleshooting): the subtitle animation is explicitly excluded from the "animation window" computation (`.kit-sub` does not participate in animEnd), otherwise this full-duration animation would stretch frame-by-frame capture to the whole slide duration and waste several times the frames. When a clause carries `text2` it automatically becomes two lines (second line `.kit-sub-2`, smaller size and lower opacity), no configuration needed. `build-video` additionally emits `out/subs.srt`, from the same source and with the same windows as the burned-in subtitles (two lines when bilingual), for platform upload. A single sentence that would wrap past two pill lines — the pill fits ≈24 CJK chars per line at 1080 wide, ≈33 at 1920 (it scales with the canvas; one-line craft guideline ≈18 CJK / ≈42 English) — or text2 >60 characters, gets a warning from plan-timings.

## The visual verification trio (mandatory after any HTML change)

Don't fool yourself, all three steps are required:

1. **Re-screenshot**: `node scripts/capture.mjs <项目> --mode still --ids <改动的张>`, look at `preview/<id>.png`. ⚠ still **invalidates that slide's frame directory** (to prevent stale frames from polluting it) — once the visuals are confirmed, if you want to rebuild the video you must re-run `--mode motion` for the same ids, otherwise build-video falls back to this slide's static image and the animation is silently lost (it does call out a ⚠, but by the time you see the warning you have already wasted one encode run)
2. **Check subject placement**: is the image subject in the upper-center of the frame? Is it cropped in half? (image sourcing SOP in `image-sources.md`)
3. **Pull actual frames from the final video**: `ffmpeg -ss <时刻> -i out/final.mp4 -frames:v 1 frame.png` — you **must check actual frames from final.mp4**, don't only look at the screenshot pipeline's output (the final video's fades and subtitle timing differ from the screenshots)

On attributing stage timing: first get measured data with `check-timing.mjs`, then pull final-video frames to confirm; if "some elements enter at 0s while others follow the timing", that is tokens.css delays being overridden by the `.fx-*` shorthands (see authoring.md for the implementation principle), not estimation error.

## Play page (play the HTML visuals through once, without waiting for encoding)

`node scripts/preview-page.mjs <项目> [--open] [--no-script]` → `preview/play/index.html`, a single file, zero dependencies, double-click to view over file://.

**Positioning: this page does exactly one thing — "look at the visuals"** — level-by-level entrance, slide navigation, motion on/off comparison, overview; the narration text is a bonus. It **deliberately has none of the player UI**: no timer (a ticking `X s / Y s`), no progress bar, no sentence-by-sentence follow-along highlight, no replay button — to see time/rhythm, just watch the final video; running a timer in the preview page only makes people stare at a stopwatch (measured: leave the tab open for a while and it reads `204.2s / 6.3s`, which is meaningless).

| Action | Effect |
|---|---|
| `→` / space / swipe left on touch | **Motion on: reveal level by level first** — each press brings out the next entrance level (a second-level heading or a small chart animates in on the spot), and only once they are all out does it advance to the next slide; motion off: advance directly. Level-by-level implementation: the copy's head carries a pre-boot script that, given `?s=k`, sets passed levels to their final state, the current level entering at 0ms, and future levels staying hidden |
| `←` / swipe right on touch | Motion on: step back level by level first (stepping back doesn't replay animation, it goes straight to final state), and at level 1 it goes back one slide (the previous slide entirely in final state); motion off: go back directly |
| `X` (or the bottom bar's "motion on/motion off" button) | **Motion on / motion off comparison**: turning motion off switches to `preview/play/<name>.nofx.html` (root element carrying `no-fx`, the whole slide in final state). A frame going blank = some keyframe never lifted `opacity:0` back up; the two versions matching = the motion setup is clean |
| `P` (or the bottom bar's "narration on/narration off" button) | Narration text panel on / off |
| `O` / `F` | Overview (preview/*.png thumbnails, click to jump, landing on the full final state) / fullscreen |

The toggles all live in the **bottom bar button strip** (shown on desktop too, not just touch): the button text states the current status directly ("motion on/motion off", "narration on/narration off", the off state lit in a warning color), while the top bar keeps only the topic and page number. Slide changes and level steps use a **double-buffered iframe**: the new frame only swaps in for display once it has finished loading in the hidden frame, so there is no white flash. UI text adapts between Chinese and English per `script.json`'s `lang` (English projects get a fully English button set, no more mixed Chinese).

**The narration UI loads or not based on data** (not on the user remembering to turn it off):

| Case | Page behavior |
|---|---|
| Has clauses + has `timings.json` | Lists this slide's narration text on the right (a bottom drawer on narrow screens) |
| Has clauses, not timing-synced yet | Lists the text, with the title marked "(not timing-synced)" — so you can look at the HTML first even before the narration exists |
| No clauses, or `--no-script` | No panel and no narration button at all, the visuals fill the full width |

**Layout adapts to the window**: top/bottom bars can wrap (overlong topic names ellipsis-truncated), on narrow windows and phones the narration panel collapses into a bottom drawer and is **collapsed by default** (visuals first), the bottom button strip automatically fills the whole row, touch lets you swipe left/right to change slides, and the overview grid picks its column count from the width. It uses `100dvh` rather than `100vh` so the address bar doesn't cut off a slice on phones.

**Why generate a copy instead of opening `slides/*.html` directly**: animation delays (`--t1/--t2/--t3`) and canvas size are injected by the render pipeline from `timings.json` (capture goes through `addInitScript`), and the HTML and tokens.css only hold placeholder defaults. Double-click the original file and `--t2` is 800ms instead of the measured 4.9s — every entrance animation crowds into the first two seconds and the rhythm you see is completely different from the final video (measured: on the same slide at t=3.0s, level two is still opacity 0 in the copy while it is already visible in the original file). The copy writes these values into `<html style>` (equivalent to pipeline injection, highest precedence) and adds `<base href="../../slides/">` so tokens.css and `../assets/*` resolve as usual.

**When there is no `timings.json` yet** (narration not done): the copy spaces the stages actually used in the HTML at equal intervals (0.3 / 1.3 / 2.3s), and a yellow bar at the top of the page honestly notes "not final-video timing". At least you can see the entrance order clearly — with placeholder values all animations crowd into 2 seconds, which is the truly unreadable version.

The copy is a **snapshot**: after editing `slides/` you must re-run `preview-page.mjs`, otherwise the play page still shows the old visuals (the copy's head comment states the real file path). The play page burns no subtitles and carries no sound — subtitle acceptance is still based on the final video.

When the project's tokens.css lags behind the skill's current version (the `tokens` managed region is stale, missing, duplicated, has a broken delimiter, or a leftover copy sits outside it), the script injects the skill's **current generated body** into the snapshot copies as a fallback: the no-fx rules go only into the motion-off copy, the rest into both (otherwise the old rules would render the new drawing approach broken), and the page says so honestly — including that **the rendered video still uses the project's old CSS**. For a legacy "bare text" file that is already byte-identical to the current version nothing is injected (the rendering is already right). To fix it at the root run `init-project --upgrade-css` **before** capture / build-video, which now refuse to run while the region is stale.

## Cover and transitions (1.6.0)

**Cover (thumbnail)**: `capture.mjs` emits an extra `preview/cover.png` for slide 1 (all base animations at final state, subtitles hidden = the fully revealed title design), and `build-video` does three things:

1. **First-segment cover dissolve** — when encoding segment 1, overlay the cover and fade it out over 0.25s → **frame 0 is the complete cover**, no longer a black frame (previously every segment carried `fade=t=in` and the first frame was fully black; users' measured feedback: "the thumbnail people receive is pure black"). Adds no duration.
2. **Embedded attached_pic** — at mux time add a track via `-disposition:v:1 attached_pic` (the main video stays `-c:v copy`, no re-encode): file managers / most players / some IMs read it directly as the thumbnail. Note that with an embedded cover you **must not pass `-shortest`** (it would cut the output to that frame's length; the audio track itself is already aligned to the total duration).
3. **Export `out/cover.png`** (scaled to canvas size) for manual upload to Bilibili/YouTube and similar platforms.

**Transitions (slide changes)**:

| Mode | Effect | Cost |
|---|---|---|
| `cut` (default) | **Hard cut** between segments, no black pass; the first segment keeps its cover dissolve and the last segment keeps its fade-out ending | Zero (still `-c copy` concatenation) |
| `xfade` | 0.4s cross-dissolve between adjacent segments (both frames half-transparent at once, not a black-pass transition) | One full video re-encode |

Usage: `"transition": {"type":"xfade","duration":0.4}` in `script.json`, or CLI `--transition xfade` to override temporarily. **Total duration is unchanged**: under xfade each segment first `tpad`s an extra `duration` seconds of tail frames, the dissolve eats `(n-1)×duration`, and after concatenation it still equals `timings.total` (the self-check verifies this). On the play page, `T` lets you **compare the two slide transitions live** (the dissolve is also a 0.4s overlay in the play page), so the user can decide by feel.

> Previously it was "fade to black 0.3s at the end of each segment + fade in from black 0.25s on the next" ≈ 0.55s of pure black — users' measured feedback: "every big slide change goes through a black screen". Neither hard cut nor dissolve passes through black.

**Three visual gates** (run automatically when build-video finishes; any failure exits non-zero): cover is embedded / first-frame brightness above black level (not a black frame) / no black frames around each slide-change point.

## BGM mixing (optional)

When build-video detects a `bgm` config in script.json, it inserts a mixing step after audio alignment and before mux:

```
ffmpeg -y -i build/audio-timeline.wav -stream_loop -1 -i assets/bgm.mp3 \
  -filter_complex "[1:a]aresample=44100,aformat=channel_layouts=mono,volume=0.12,\
afade=t=in:st=0:d=1.5,afade=t=out:st=<total-2.5>:d=2.5[bg];\
[0:a][bg]amix=inputs=2:duration=first:normalize=0[out]" \
  -map "[out]" -c:a pcm_s16le build/audio-mix.wav
```

- `-stream_loop -1` loops a short BGM to fill the whole video; `duration=first` converges to the length of the voice track.
- `normalize=0` is mandatory: amix by default splits the volume by input count, which **halves the voice**; normalize=0 keeps the voice at its original level and BGM is controlled only by `volume`.
- The `normalize` option requires ffmpeg ≥ 4.4; on failure the script warns and falls back to voice only (it does not abort the render).
- How to verify: `ffmpeg -i out/final.mp4 -af volumedetect -f null -` to see whether mean/max are raised versus the voice-only track (with BGM they should be); `silencedetect` should no longer report silence in the gaps between sentences (the voice gaps are filled by BGM).

## Encoding and concatenation parameters (for manual troubleshooting)

Single slide (frame sequence):

```bash
ffmpeg -y -framerate 30 -i build/frames/01/f%05d.png \
  -vf "tpad=stop_mode=clone:stop_duration=99,fade=t=in:st=0:d=0.25,fade=t=out:st=<D-0.35>:d=0.3" \
  -t <D> -c:v libx264 -pix_fmt yuv420p -preset medium -crf 20 -movflags +faststart out/slide-01.mp4
```

- `-framerate` must come before `-i` (an image sequence has no timestamps of its own; this defines them).
- `yuv420p` is mandatory, otherwise some players show green/black.
- `+faststart` moves moov to the head of the file, so streaming plays on click.

Concatenation: all segments are encoded uniformly by build-video (same encoder, same parameters) and stitched losslessly and instantly with the concat demuxer `-c copy`; after stitching ffprobe verifies, and a total-duration deviation >0.25s automatically falls back to concat filter re-encoding (mixing in foreign segments gives inconsistent timebases that turn 8s into 35s, and copy can't rescue it).

Audio alignment: each segment gets `aresample=44100,aformat=channel_layouts=mono,apad=whole_dur=<该张实测时长>` to pad silence before concat. **Don't use the adelay+concat approach** (the concat filter ignores adelay's offset and all speech piles up at the start).

**Look at the commands before running**: `node scripts/build-video.mjs <项目> --dry-run` prints every ffmpeg command it would execute without actually executing it — when you want to manually verify a slide's parameters, or suspect an encoding-parameter problem rather than an asset problem, run it first and take the commands as-is to the command line to experiment.

## Self-check standards

Before build-video ends it enforces: the final video's ffprobe duration differs from the timings total by ≤0.25s; `ffmpeg -v error -i final.mp4 -f null -` decodes the whole file with zero errors. If either fails, the exit code is non-zero — when you see non-zero, don't deliver.

## Troubleshooting table

| Symptom | Cause | Action |
|---|---|---|
| Final video has no sound | Audio wav not generated / mux failed | `ffprobe build/audio-timeline.wav` to check duration; re-run build-video |
| All speech piled at the start | Used an adelay approach | Use this script's apad approach |
| Duration explodes after concatenation | Foreign-encoded segments mixed in | Re-encode all segments uniformly with build-video; it already falls back automatically |
| Chinese renders as boxes | No CJK font on the system | Linux: `apt install fonts-noto-cjk`; or switch the font stack to an installed font |
| Font ugly first, then correct (FOUT) | External font + font waiting not going through capture | Localize assets/fonts; make sure you use capture.mjs rather than manual screenshots |
| Animation not in the video | Used still mode | Re-run that slide with `--mode motion` |
| Animation layer timing wrong | Animation delays hand-written in the HTML | Delete them, rely on --t1/--t2/--t3 injection |
| chromium fails to launch | Browser not installed | `npx playwright install chromium` (on Linux CI add `--with-deps`) |
| A slide's segment length is wrong | Frame directory is from old timings | Delete `build/frames/<id>/` and re-run capture; after changing TTS you must re-run plan-timings |
| Backslash paths break concat on Windows | — | build-video already converts to forward slashes; be careful when hand-assembling list.txt |
| Some elements enter at 0s, others on time | Old tokens.css: delays overridden by the `.fx-*` shorthands | Switch to the new tokens.css (`--fx-delay`); see authoring.md for the implementation principle |
| Image subject cropped out of frame | Bare `<img>` or cover with the wrong ratio | Wrap in `.img-frame` + `--img-pos`; for screenshot-type images switch to `.contain`; if the subject hugs the edge, re-search per the SOP |
| Subtitles smear into the background on dark themes | Theme doesn't override the subtitle hooks | Add `--sub-bg` (darker) + `--sub-ring`; `check-theme.mjs` computes this contrast |
| spawnSync returns exit -5 or hangs under PowerShell | Chinese paths + complex argument combinations easily trigger this in PowerShell | Run scripts via Git Bash / WSL instead, or inject the binary directory into `$env:PATH` first (this suite's scripts always work fine under Bash) |
| Numbers/text invisible | Undefined CSS variable voids the whole background + transparent text | `check-slides.mjs` (static) catches undefined variables; capture names the images that failed to load |
| Broken image icon | Missing file or invalid SVG | Same as above; inlining SVGs into the HTML is always the most reliable |

## Environment differences notes

- **ffmpeg/ffprobe detection**: every script uniformly goes PATH → project/repo node_modules (ffmpeg-static/ffprobe-static) → common install locations (winget Links / scoop / C:\ffmpeg\bin); when not found they list the checks one by one and exit with code 2 (distinct from 1 for business errors).
- **Windows**: `python`/`node` naming, path separators — this whole suite is implemented in Node, no bash arrays, no octal traps, it just runs. ffmpeg: `winget install Gyan.FFmpeg` or `npm i ffmpeg-static ffprobe-static`.
- **Linux sandbox (mcode)**: chromium is installed by `npx playwright install chromium`; a Chinese font package is needed; `--with-deps` supplies shared libraries.
- Supersampling: capture `--dsf 2` emits 3840×2160 frames, and build-video detects the size mismatch and auto-downsamples with lanczos, giving sharper text edges; render time is about ×4, so use it only for the final master. `--dsf` accepts 1–4 and **defaults to 1**; anything else (0, 2.5, `abc`) is rejected at the entry point with a clear message.
