**English** | [中文](README.zh-CN.md)

# HTML 2 Video for mcode

Turn a topic, an outline, or a finished script into a **narrated MP4**: HTML slides with staged
entrance animations, a TTS voiceover, burned-in subtitles, and an ASR pass that verifies the
voiceover actually says what the script says.

Built for MiniMax Code (mcode), and runnable in any agent host through `mmx-cli`.

## What the user gets

Ask in plain language, get a publishable video. Here is a real request — Chinese is the default
narration language (English and Cantonese are supported too), so the sample input is quoted as it
was typed:

> 帮我把这份大纲做成一条 60 秒的中文口播视频:三张关键数字、结尾一句行动号召,用深色科技主题,加中文字幕。

*"Turn this outline into a 60-second Chinese voiceover video: three key numbers, a closing call to
action, a dark tech theme, Chinese subtitles."*

Result:

```
my-video/
├── slides/            8 HTML slides + tokens.css (13 themes, 17 layout recipes)
├── audio/             8 TTS clips
├── build/timings.json measured durations + per-layer entrance times
├── preview/*.png      terminal-state frames
├── preview/play/      self-contained play page (screen the deck without encoding)
└── out/
    ├── final.mp4      ★ the deliverable (1920×1080 or 1080×1920, H.264 + AAC)
    ├── subs.srt       subtitles for platform upload
    └── slide-*.mp4    per-slide segments
```

## Pipeline

One Skill drives a 12-script pipeline (plus eight internal modules — path containment / URL policy,
`no-fx` rules, chart CSS, table CSS, the **managed CSS region** (rev delimiters + in-place
replacement), the generated-body template with its content fingerprint, and the scan cap — under
`skills/html2video-for-mcode/scripts/`):

| Stage | What happens |
|---|---|
| 1. Kickoff alignment | Ask about language (Chinese / English / Cantonese), style & brand color, subtitles (none / single / bilingual), canvas (16:9 or 9:16), duration, voice, asset boundaries |
| 2. Research | Fact-check the topic and record sources before writing |
| 3. Script | Per-slide narration split into clauses; every slide carries at least two information layers on separate animation stages (order is free) |
| 4. TTS | Voice synthesis (mcode connector, or `mmx-cli` elsewhere), then measure every clip with ffprobe |
| 5. Timing | Derive each slide's duration and each animation's entrance time from the **measured** audio — nothing is hand-written |
| 6. Assets | Official sources first, image framing primitives, compliance manifest |
| 7. HTML | Staged entrance animations bound to the measured timings; layout recipes for 17 slide types |
| 8. Render | Deterministic frame-stepping capture (animations land in the video), ffmpeg assembly with subtitles, optional background music. Before spending encode time, `preview-page.mjs` writes a play page so the deck can be screened in a browser |
| 9. Verify | ASR transcription compared against the script; contrast, theme, and static-slide gates |

## Design decisions worth knowing

- **Nothing about timing is hand-written.** Every slide's duration and every animation's entrance
  time comes from the measured TTS audio, so "the voiceover finished but the picture is still
  waiting" cannot happen by construction.
- **Every slide has at least two information layers** on separate animation stages (which layer
  enters first is a judgement call — a big number, a question, or an image may lead), so a slide is
  never just one line of text with nothing to look at. Entrance order is checked statically, not
  left to hope.
- **Animations land in the video.** Capture steps frames deterministically instead of
  screen-recording, so entrance animations are actually rendered rather than frozen.
- **Regulated topics get compliance handling.** For finance / medical / legal / policy decks the
  workflow asks about disclaimers and source attribution up front, pins every number to its basis
  (scope + currency + as-of date), and flips the up/down colour convention to the audience's market
  (A-shares and Hong Kong read red as up) — see `references/compliance.md`.
- **Charts are drawn in plain CSS/SVG, and effects can be switched off in one place.** No chart
  library and no canvas (offline they would not load, and canvas animations cannot be frame-seeked).
  Adding `no-fx` to the root element — or to any container, for a single slide — turns every
  entrance and ambient animation off; the renderer then emits static frames and the timing stays
  intact. The chart toolbox enforces the data-viz basics in the template itself: bars grow by
  animating `width` (scaling would squash the numbers), column heights resolve against the plot
  area so they always match their values, the grid shares the bars' scale, and charts stay clear of
  the subtitle band. Tables ship four shapes (`.tbl` data table, `.kv` spec list, `.matrix` feature
  matrix, `.rank` ranking with inline bars) with type and row heights sized to survive being watched
  on a phone.
- **Rendering is gated.** A static check refuses to render slides with undefined CSS variables,
  missing images, external resources, or entrance animations without an animation class — the
  failure modes that otherwise ship a video that looks broken while every script reports success.
  It also refuses entrance animations whose keyframes never lift the `opacity: 0` base state — those
  elements would silently stay invisible in the finished video.

## Install

**As a plugin (MiniMax Code):** add `plugins/Wzdhehe/html2video-for-mcode` from this repository, or
install it from the community catalog once merged.

**As a standalone skill (any AgentSkills host):**

```bash
cp -r html2video-for-mcode ~/.claude/skills/          # or ~/.openclaw/skills/
# project-level
cp -r html2video-for-mcode <your-project>/.claude/skills/
# or from GitHub
npx skills add Wzdhehe/html2video-for-mcode
```

Then install the two dependencies **in your video project** (not in the skill directory):

```bash
cd <your-video-project>
npm i playwright && npx playwright install chromium
# ffmpeg: winget install Gyan.FFmpeg / brew install ffmpeg / apt install ffmpeg
#         or: npm i ffmpeg-static ffprobe-static
```

## Requirements

- **Node.js 18+** (plain ESM, no build step).
- **ffmpeg / ffprobe** on `PATH`, or `ffmpeg-static` / `ffprobe-static` in the project. Scripts
  probe `PATH → project node_modules → skill parents → common install locations`.
- **Playwright Chromium** for capture. Install it in the video project — scripts resolve it from
  the project directory, the working directory, or the global npm root.
- **Voice synthesis**, one of: mcode platform connectors, `mmx-cli`
  (`npm i -g mmx-cli && mmx auth login --api-key sk-...`), or your own TTS written to
  `audio/<id>.mp3`.
- Optional: `MINIMAX_API_KEY` for `scripts/asr.mjs`, which transcribes the voiceover and compares
  it against the script (numbers, proper nouns, and spoken language).

## Quick start

```bash
node <skill>/scripts/init-project.mjs ./my-video --topic "My topic"
# fill research/notes.md and script.json (clauses = one line of narration each)
# synthesize audio/01.mp3 … audio/08.mp3
node <skill>/scripts/plan-timings.mjs ./my-video     # measure audio → timings.json
node <skill>/scripts/check-slides.mjs ./my-video     # static gate before rendering
node <skill>/scripts/capture.mjs ./my-video --mode still
node <skill>/scripts/preview-page.mjs ./my-video --open   # play page: screen it yourself first
node <skill>/scripts/capture.mjs ./my-video --mode motion
node <skill>/scripts/build-video.mjs ./my-video --asr
```

`SKILL.md` carries the full workflow (7 phases, 6 confirmation gates); `references/` holds the
authoring rules, asset-sourcing SOP, TTS/timing notes, and rendering internals.

`preview-page.mjs` writes a self-contained play page to `preview/play/index.html` (open it from
disk, no server) whose only job is **screening the HTML**: arrows (or a swipe) page through the
slides, `O` is an overview, and `X` switches to a `no-fx` copy — if the picture goes blank, some
keyframes never lift the `opacity: 0` base state. With animations on, the arrows **step through the entrance
level by level** (`→` reveals the next level on the spot and only then turns the page) — nothing waits for a
timer. `T` compares hard cut against cross-dissolve for the slide change, so the transition can be decided by
ear and eye before rendering; both toggles sit in the bottom bar. There is
deliberately no timer, progress bar, or karaoke-style highlight: for timing, watch the finished
video. The narration panel is data-driven (`P` toggles it): it lists the slide's script lines when
they exist, is skipped entirely when they do not, and `--no-script` hides it outright — so a deck
whose voiceover is not written yet still previews fine. The layout adapts down to phones (panel
becomes a collapsible bottom drawer, touch buttons appear). The page loads snapshots with the
**measured** stage delays injected from `timings.json`, so what you see in the browser matches the
timing of the final video (opening `slides/*.html` directly does not — those files carry
placeholder delays; without `timings.json` the page spreads the stages evenly and says so).

## Supported platforms

Windows, macOS, and Linux. All scripts are Node ESM and shell-agnostic. On Windows prefer Git
Bash / WSL over PowerShell (complex argument lists with non-ASCII paths can misbehave there);
ffmpeg and Chromium paths are auto-detected.

## Network access

Nothing is contacted unless you invoke the step that needs it:

- `scripts/asr.mjs` — HTTPS `POST` to `https://api.minimaxi.com/v1/speech_to_text`
  (or `https://api.minimax.io` when `MINIMAX_REGION=global`). Only when you run it. **The API key
  is sent to these two official hosts only**: any other `--base-url` / `MINIMAX_BASE_URL` is
  rejected before the request is made, unless you explicitly pass `--allow-any-endpoint`
  (self-hosted gateway / testing, at your own risk).
- `scripts/fetch-official-images.mjs` — opens the URL **you** pass (an official site, or a local
  `file://` page with `--allow-file`) to list and download candidate images, or downloads the exact
  image URLs you hand it with `--url` (what the in-app browser route uses; no Playwright needed). Targets are checked
  before any request: loopback, link-local (including cloud metadata `169.254.169.254`), private
  and CGNAT ranges, dotless hostnames, URLs with embedded credentials, and non-HTTP(S) schemes are
  all refused, every redirect hop is re-checked the same way, and responses are size-capped
  (30 MB by default, `--max-mb`).
- Voice synthesis happens through mcode connectors or `mmx-cli`, which contact MiniMax.
- Everything else (timing, static checks, capture, encoding, theme validation) is fully offline.

No telemetry, no analytics, no hidden endpoints, no installers, no native binaries.

## Data use

- The narration text you write is sent to the speech service you chose; the produced audio is sent
  to the ASR service only if you run `scripts/asr.mjs`.
- Assets you fetch are downloaded into your project's `assets/` directory and must be recorded in
  `assets/MANIFEST.md` with source and license.
- **Writes stay inside the project directory you pass in.** Every path derived from `script.json`
  (slide `id` / `html` / `audio`, `bgm.file`) is validated first: ids must match
  `^[A-Za-z0-9_-]{1,64}$`, paths must resolve inside the project, and symlink escapes are refused —
  a hand-edited or prompt-injected `script.json` cannot make the pipeline read, write, or
  recursively delete anything outside your project. One declared exception: `prep-image.mjs --crop`
  takes its input and output **explicitly on the command line** (the same trust level as running
  ffmpeg yourself), so those two paths are not restricted to the project — overwriting an existing
  output still requires `--force`. Every pipeline write whose path is *derived* (project + id,
  `preview/`, `build/`, `out/`, `asr.mjs --out`) remains fully contained.
- **Nothing is overwritten silently.** `init-project.mjs` refuses a non-empty target directory
  (re-initialising needs `--force`, which only resets its own five generated files);
  `fetch-official-images.mjs` and `prep-image.mjs` do not clobber existing files without `--force`
  and keep downloads inside your working directory by default. `--upgrade-css` updates the one
  **managed `tokens` region** in `tokens.css` — the whole generated body (theme tokens, the `--fs-*`
  scale, fx keyframes and utilities, `.fx-stagger`), with the three toolkit blocks (no-fx / chart /
  table) nested inside — by replacing it in place. Stale copies **outside** the region are cleaned
  **rule by rule**: rules that are verbatim copies of the module text are deleted (they win the CSS
  cascade and would override the region), while your own rules — one or two overrides sitting next
  to a copy included — are kept and reported; a `tokens.css.bak` backup is written first. Put your
  own rules **after** the region, or the region's values win. `--check-css` reports staleness
  without changing anything.
- No credentials are stored or embedded: the ASR script reads a key from `MINIMAX_API_KEY` or
  `--api-key` at runtime and never writes it anywhere.
- `KIT_PROJECT_DIR` is internal plumbing, set automatically by the CLI entry points so shared
  helpers can locate the project directory; you never need to set it yourself.

## Verification

The Skill ships an executable test suite (`skills/html2video-for-mcode/tests/`, plain
`node:test` — no extra dependencies):

```bash
# in the MiniMax-Code-Plugins monorepo (the plugin PR context), from the repository root:
node --test "plugins/Wzdhehe/html2video-for-mcode/skills/html2video-for-mcode/tests/*.test.mjs"
# in a standalone clone of this skill repo, from its root:
node --test "tests/*.test.mjs"
```

243 tests in fourteen files: `safe-paths` (malicious slide ids / paths, canary intactness, symlink
escapes including a **dangling** link that must be caught rather than skipped), `no-clobber` (refusing to overwrite), `endpoint-allowlist` (key never leaves the official
hosts — plus a local server that proves the gate sits before the request), `fetch-policy` (SSRF,
`file://`, redirect and filename rules), `preview-page` (snapshot timing injection, `base` ordering,
self-containment, containment refusals, the no-timer rule), `tokens-fx` (every entrance animation in
the generated `tokens.css` must declare `opacity`, `no-fx` must reset it, `--upgrade-css` is
idempotent) and `fetch-policy`/`no-clobber` (the `--url` download route obeys the same SSRF,
redirect, size and no-clobber rules), plus
`chart-kit` (the chart toolbox is really in the generated `tokens.css`: keyframes, registered
properties, and "off = final state"), `table-kit` (table primitives keep their legibility rules:
body-size type, ≥72px rows, token-driven up/down colours, matrix highlight covers the header row
too), `css-kit` (the managed CSS region: a region that is stale, missing, duplicated, has a broken
delimiter, or has a leftover copy outside it must be detected and repaired in place — invisible copies
outside the region win the CSS cascade, which is what the rewrite is about; project-side overrides
survive rule-by-rule, legacy bare-text files get wrapped in place instead of duplicated, `--check-css`
exit codes, CRLF files must not false-positive, pathological interleaving resolves in one run,
oversized inputs are refused — and the two false greens an adversarial re-review then found *inside*
the new mechanism: a live region **plus a stale copy of the generated body outside it** used to report
`ok`, and the `ok` note for a project override now says whether it sits before the region (loses the
cascade) or after it (wins)) and `render-smoke` (init → timings → static gate → capture → build, end
to end, **plus a pixel-level proof that upgrading a stale project really changes the rendered picture**). Two newer suites cover the second review round and the delivery-quality fixes: `review-round2` (canary tests proving output containment, a local server proving a rejected destination receives **zero** requests, single-quoted/unquoted HTML attributes, ASR request errors counted as failures, ffmpeg discovered from the project) and `cover-transition` (cover image present, `attached_pic` stream embedded, first frame not black, no black frame at any cut point in both hard-cut and cross-dissolve modes, total duration unchanged) and `review-round3` (the seven functional defects: `check-timing --calibrate` must not write back half-measured boundaries, `--topic <value> <project>` must not treat the value as the project directory, `--json` is position-independent, `--min WxH`, `--get` all-failed exits non-zero, `capture --mode/--dsf` and `grab-frames --at` reject bad values at the entry point, the subtitle-band gate only fires on positioned elements, `--dry-run` prints the plan and exits 0, and a bare-string `transition` must mean the same thing to the gate and the renderer — plus the stale-CSS gates on `check-slides` / `capture` / `build-video`) and `subtitles-invalidate` (deleting clauses, or `--no-subs`, and rebuilding must remove the old subtitles from the video — asserted at pixel level). Everything runs with ffmpeg, ffprobe and
Chromium installed (on `PATH`, or in this repo's / your project's `node_modules` — `npm i
ffmpeg-static ffprobe-static playwright`). Without them, every test that needs one of them **skips
with its stated reason** (a tool is absent, or the filesystem forbids creating a junction) — nothing
pretends to pass, and the pipeline scripts themselves exit with `找不到 ffmpeg` instead of running
half a pipeline. The scoped workflow
`.github/workflows/html2video-for-mcode-smoke.yml` — which lives in the **MiniMax-Code-Plugins
monorepo** (this standalone repo has no workflows) and runs on the plugin PR and on main —
installs them and runs everything for real.

## Troubleshooting

`SKILL.md` ends with a symptom → cause → fix table covering the failures this pipeline has actually
hit: silent tails after the voiceover, slides with nothing on them, elements entering at 0 seconds,
invisible text from undefined CSS variables, entrance elements that never appear at all (keyframes
that never lift the `opacity: 0` base state), a `no-fx` switch that leaves the slide blank, opening
`slides/*.html` and finding every animation crammed into the first two seconds, a blank play page,
broken images, subtitles washed out on dark themes, wrong voice language, mismatched concat
durations, and finance decks missing a disclaimer or with the up/down colour flipped.

## License

MIT — see `LICENSE`. Portions of the design system (10 themes, image-frame primitives, several
entrance animations) are adapted from
[html-ppt-skill](https://github.com/lewislulu/html-ppt-skill) (MIT, Copyright (c) 2026 lewis); the
full notice and the upstream MIT text are in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
