---
name: html2video-for-mcode
description: Turn a script/outline/topic into a finished MP4 with Chinese voiceover (HTML slides + TTS + ffmpeg), tailored to mcode and runnable in other Agent environments with mmx-cli. Trigger when the user wants to turn content into a video, html 转 mp4 (html to mp4), 幻灯片口播视频 (narrated slide video), slides video, narrated video, 一分钟介绍视频 (one-minute intro video), 抖音/视频号竖版视频 (vertical video for Douyin/WeChat Channels); **also trigger when they only want to look at the finished HTML slides first, present them once themselves, or preview the animations (with or without the voiceover yet)** — the skill generates a self-contained play page, so you don't have to spend minutes rendering a finished video first. Also trigger for **受监管题材** (regulated subjects): finance/earnings/investment research/healthcare/policy — they need disclaimers and data-scope handling. Also trigger on symptoms — anywhere the frame looks wrong or the timing is off; the full list is in references/symptoms.md.
---

# HTML 2 Video for mcode: script → narrated video

Turn a topic/outline into a publishable MP4 (default 1920×1080, switchable to 1080×1920 vertical): HTML slides (staged entrance animations) + Chinese TTS narration + ffmpeg assembly + reverse ASR verification.

## The four iron rules (violate any one and the output is guaranteed to be reworked)

1. **All durations come only from ffprobe measurements; never write them by hand.** Each slide's duration = that segment's measured TTS duration + tail padding (default 0.8s). Don't estimate, don't round, don't hard-code.
2. **TTS before HTML.** Produce the audio first, measure the real durations, work out the entrance moment of every visual layer, then write the HTML. All animation delays are injected through the CSS variables `--t1/--t2/--t3`; never hard-code seconds in the HTML. This is the fundamental cure for "too much silence after the narration ends" and "audio and visuals out of sync".
3. **Wait for user confirmation at every Gate; skip no steps.** See the workflow below for the Gate list.
4. **Align before starting; don't just charge ahead.** The first response = **ask each of the questions below, one by one, in question form, then stop and wait for the user's answers**; each item may come with a recommended default, but it must be "ask, then wait" — not "announce the default and treat silence as consent". Only when the user explicitly says "go with the defaults", or leaves an item unanswered, do you adopt the default, and before moving to the next step, restate which defaults were finally adopted. The answers become the acceptance baseline for every subsequent Gate.

   ⚠ Counter-example (hit for real on 2026-09-18 — never again): firing off one message that reads "默认项(不特别说的话就按这个):中文普通话口播 · 中文字幕 · 1920×1080 · 温润男声 · 预计 10–12 张…" ["Defaults (unless you say otherwise, we use these): Mandarin Chinese narration · Chinese subtitles · 1920×1080 · warm male voice · estimated 10–12 slides…"] and then pressing on — that is not asking, it is informing; the user never gets the chance to take a position on each item, which amounts to no alignment at all. The right way: lay it out as a question list (2–3 options + a recommended default per item), say plainly "reply to confirm, or tell me which ones to change", and only move once the answers come back.

| What to ask | Options / defaults |
|---|---|
| **Topic and domain** | One sentence on the subject + **which domain it belongs to** (finance/business · tech/product · popular science/education · brand/marketing · culture/history · life/consumer · government/policy); the domain decides layout and information density; full constraints for regulated domains are in the "Sensitive content and disclaimer" row below and in `references/compliance.md` |
| **Audience** | Who it's for: **domain professionals / general tech-savvy public / management briefing / client demo / internal training** (recommend based on the subject, but have the user confirm). The same subject written for researchers and for the general public is two different scripts — this item decides term density, information density and tone of voice |
| **Language (must ask)** | What language the narration is in: **Mandarin Chinese `zh`** (default) / **English `en`** / Cantonese `yue` / other BCP-47. This decides 4 things: ① which language the narration script is written in; ② **the voice must match the language** (Chinese uses `Chinese (Mandarin)_*`, English uses `English_*`; a mismatch produces a strange accent, so verify the language with ASR after writing); ③ the characters/speech-rate baseline (Chinese characters/sec vs English words/sec — plan-timings switches automatically); ④ the ASR language header (zh forces Mandarin, so it can catch Cantonese) |
| **Style and colors (theme color)** | First offer 2–3 candidate themes based on the audience (business `minimal-white`/`swiss-grid`/`corporate-clean`; editorial magazine `editorial-serif`/`magazine-bold`; dark tech `tokyo-night`/`catppuccin-mocha`/`nord`; consumer/lifestyle `xiaohongshu-white`/`soft-pastel`). **Then ask one more question about theme-color preference**: use the theme's built-in primary color, or is there a brand color to specify (if given, override `--accent` per the "custom primary color" section of authoring.md and run check-theme to verify contrast) |
| **Data and charts** | When the subject contains key numbers, comparisons, proportions or trends (earnings/product data/market comparisons/progress), you **must ask**: ① is there any data worth a slide of its own; ② do you want chart slides, and roughly how many (default suggestion: hard data + a suitable layout → 1–2 slides; pure narrative subjects skip this); ③ style preference: horizontal bars / columns / donut / line / progress bar, or "let the agent pick per the data shape" (selection cheat sheet in the authoring.md chart toolkit — all pure CSS/SVG, works offline); ④ numbers on the chart are also bound by Gate 0 (≥2 independent sources, with scope and timestamp). **Even if the user doesn't bring up charts, proactively offer this option for data-dense subjects** — a string of comparable numbers read out as bullets is worse than one chart |
| **Subtitles** | No subtitles / monolingual (**same language as the narration**, default) / **bilingual** (main line = narration language, second line `text2` = the other language, e.g. Chinese narration with English subtitles) — decides whether to write text2 and whether to use `--no-subs` |
| **Sensitive content and disclaimer** | If the subject touches any of these, ask "do you want a disclaimer + a sources-and-scope slide at the end": financial opinions/figures, medical, legal, policy, **negative-event reporting**, personal information/data citations — default is **yes**. Regulated domains (financial investment research/healthcare/legal/government policy/marketing performance claims) follow the full `references/compliance.md` set: a closing `.disclaimer` line (on screen ≥3s), up/down colors flipped per audience, numbers carrying scope + currency + timestamp. Omit only if the user explicitly says no |
| **Canvas and platform (aspect ratio)** | Landscape 1920×1080 (default, suits Bilibili/official sites) or vertical 1080×1920 (Douyin/WeChat Channels/Xiaohongshu); vertical needs a stacked layout |
| Approximate duration | Default ~60s (6–10s per slide × 8 slides); short-video platforms can compress it to 30s; offer a range for the user to pick |
| **TTS voice and speed (rough direction)** | ①**Gender/voice direction**: male / female / neutral × warm / crisp / magnetic / lively; ②**speed**: normal (**default 1.1**, ≈5.3 Chinese characters/sec) / a bit slower / a bit faster. A rough direction is enough — Phase 2 auditions 3 candidate voices, and **plays the same sentence at all three speeds (1.05/1.15/1.25) alongside them so the two are decided together** (see tts-and-timing.md); once decided, write it into `speed` in `script.json` and restate it |
| **Images and asset boundaries** | First ask **whether to use images at all**: pure typography, no images (number cards + large type + quotes) / allow official images pulled from the web (default) / only user-provided assets. **For negative-event subjects (blow-ups/penalties/lawsuits/controversies), add: do you want announcement or news-report screenshots as illustrations** (default suggestion: yes, 1–2; discipline in image-sources.md path D). The specifics — "which ones to use, what still needs to be supplied" — are left to the Gate 3 asset confirmation |

## Contents and tools

The skill ships with **12 command-line scripts + 8 internal modules** (call them directly by path within the skill directory, passing the project directory as an argument, no copying needed; `tests/` also holds a set of node:test security and smoke tests, auto-discovered from `node --test` at the repo root):

| Script | Purpose |
|---|---|
| `scripts/init-project.mjs <project> [--topic "topic name"] [--force] [--upgrade-css] [--check-css]` | Generates the project skeleton: directory + tokens.css + slide templates + the script.json contract. **Refuses to run when the target directory is non-empty** (it would reset 5 generated files); re-initializing requires an explicit `--force`. `--upgrade-css` updates the project's tokens.css to the skill's current version. The **whole generated body** (theme tokens, `--fs-*` scale, fx keyframes/utilities, `.fx-stagger` rules, and the three toolkit blocks no-fx/charts/tables nested inside) lives in one `tokens` **managed region**, so it is **replaced in place** by content rev — no duplicate sections, idempotent, `tokens.css.bak` written first. **Put your own project rules after the managed region**; everything outside it is never touched (rules that duplicate a toolkit are the only exception: a leftover full copy would win the cascade and is cleaned up, its original text staying in the `.bak`). `--check-css` only inspects: stale/missing/duplicated/broken-delimiter/leftover-copy items are reported one by one, and any of them exits 1. A project whose file is still the old "bare text" format but byte-identical to the current version reports **ok** (rendering is already correct), with a note that the next upgrade will wrap it in place |
| `scripts/plan-timings.mjs <project> [--pacing=<chars per second>]` | ffprobe-measures each TTS segment → per-slide duration, each stage's entrance moment, **each sentence's clause timing** → `build/timings.json`; `--pacing` overrides the speech-rate baseline (for re-estimating when the speed warning fires) |
| `scripts/check-timing.mjs <project> [--calibrate]` | Silence detection measures each sentence's real onset and compares it with the estimate; `--calibrate` calibrates the timings to the measurements and then re-renders. For slides whose silence-segment count doesn't match and which haven't been calibrated, use `asr.mjs --verify-timing` to get character-level timestamps and measure the sentence onset |
| `scripts/check-theme.mjs <project>` | Verifies WCAG contrast for all themes — **five pairs**: `--accent-ink/--accent`, `--fg/--bg`, `--muted/--bg`, `--fg-3/--bg`, and `--sub-fg/--sub-bg` (subtitle pill composited onto the background); exit code 1 if any fails; new themes must pass this gate |
| `scripts/check-slides.mjs <project> [--ids 01,02] [--quiet]` | **Static gate before rendering**: undefined CSS variables, missing images/external resources, `data-stage` without an fx class, fx keyframes that don't include opacity (which would stay invisible forever), use of undefined classes (silently unstyled — info level), **tokens.css managed region out of date — error level, blocks screenshots** (an old CSS still renders, just with stale rules; the fix command is printed), **`.fx-stagger` and `data-stage` on the same slide (which would override entrance timing)**, **absolutely positioned `bottom` falling inside the subtitle band — warning level: burned-in subtitles would cover the caption, and a still does not show it**, hard-coded colors, and a whole-video domain self-check. Any ✗ and don't take screenshots |
| `scripts/prep-image.mjs --check <image...>` / `--crop <in> <out> [--ratio 16:9] [--anchor ...] [--force]` | Execution helper for the image SOP: checks dimensions and crop risk; crops by anchor (enforcing "crop away ≤20%, never upscale to pad") |
| `scripts/fetch-official-images.mjs <page URL> [--get 1,3] [--out-dir <dir>] [--min WxH] [--json] [--allow-file] [--max-mb N] [--force]` / `--url <image URL>[,...]` | Lists and downloads candidate images from an official page/local page (`--json` lists candidates without downloading; `--min` filters by size); **when the site needs login or lazy-loads on scroll, use the built-in browser to inspect the image URL, then drop it straight to disk with `--url` (no Playwright needed)**. Intranet and metadata addresses are always rejected (including IPv4-mapped IPv6 forms), every redirect hop is re-checked, and output defaults to inside the working directory |
| `scripts/capture.mjs <project> [--mode still\|motion] [--ids 01,02] [--no-subs]` | Playwright screenshots. still = a single final-state frame (invalidates that slide's old frame directory); motion = frame-by-frame stepping through the entrance animations. `--dsf 1..4` sets the device scale factor (**default 1**; `--dsf 2` supersamples at 3840×2160 and build-video downsamples with lanczos — sharper text edges, ~4× render time, so use it for the final master). **Both capture and build-video refuse to run when the project's managed region is stale** (they print the issue list and the `--upgrade-css` command, and exit 1); `--allow-stale-css` skips that gate explicitly if you really must render the project's old CSS. **Subtitles are burned in by default** (content comes from clauses); `--no-subs` turns that off; **each sentence's subtitle is also emitted as a static image** (`build/substills/`), and subtitle windows the frame sequence can't cover are spliced in by build-video — otherwise subtitle changes after the animation window would freeze; **slide 1 additionally emits `preview/cover.png`** (title fully visible, no subtitles — used as the cover and the video's first frame) |
| `scripts/preview-page.mjs <project> [--open] [--no-script]` | Generates the **play page** `preview/play/index.html` (single file, zero dependencies, double-click to view over file://): **with animations on, ←→/touch swipe step through the entrance level by level** — each press of → reveals the next level (a sub-heading or small chart animates in on the spot), and only after the last level does it turn the page; with animations off it just turns pages. X toggles animations on/off, P toggles narration on/off (all toggles are buttons in the bottom bar, and the label text literally reads "动效开/动效关" "口播开/口播关" — animations on/off, narration on/off; the top bar keeps only the page number), O overview, F fullscreen. **Frame switching is double-buffered with no white flash; UI text adapts between Chinese and English per the `lang` in script.json**. **It does only one thing: "show the frame"** — no timer/progress bar/read-along highlight/replay button (to see timing, watch the finished video). Snapshots inject the measured delays from `timings.json` (the level-by-level animation shares its source with the finished video); the narration panel decides automatically from the data whether to load at all, collapses into a bottom drawer with default-collapsed state in narrow windows/on phones, and the canvas adapts to landscape or vertical |
| `scripts/build-video.mjs <project> [--asr] [--dry-run] [--transition cut|xfade]` | Encodes each slide → concatenates → aligns the audio track → muxes → self-checks + emits `out/subs.srt`; `--asr` splits the audio **by sentence** + generates a checklist; `--dry-run` only prints the ffmpeg commands that would run (for troubleshooting). **Transitions default to a hard cut** (no black frame between segments; the first segment dissolves in from the cover and the last fades out), and `--transition xfade` or `transition` in `script.json` switches to a 0.4s cross-dissolve (the dissolve eats the extra frames kept at the end of each segment, so the total duration is unchanged). When subtitle stills exist it splices as "frame-sequence segments + subtitle segments" (the segment lengths must sum exactly to the slide's duration) |
| `scripts/grab-frames.mjs <project> [--ids 05,11] [--at 0.5] [--both]` | **Finished-video frame extraction check**: compute each slide's absolute start from `timings.json` and pull frames from `out/final.mp4` into `build/introspect/` — problems like a caption covered by subtitles, the last-level element missing from the frame, or too little still time at the end are "invisible in a still, only visible in the finished video", so go through them slide by slide before publishing |
| `scripts/asr.mjs <project> [--api-key K] [--verify-timing] [--from <transcript>] [--allow-any-endpoint]` | Calls ASR to transcribe and verifies sentence by sentence whether the audio says what the script says (mismatched numbers/traditional characters count as ✗); `--verify-timing` uses character-level timestamps to measure sentence onset. The key is only ever sent to official domains |

Internal modules (imported by the scripts above, never run on their own): `tools.mjs` (ffmpeg/ffprobe probing + path jail `safeId/safeRel/inside`), `url-policy.mjs` (ASR endpoint allowlist + SSRF/redirect policy + download filenames), `nofx-css.mjs` (single source of truth for the `no-fx` rules), `chart-css.mjs` (single source of truth for chart animations and chart primitives), `table-css.mjs` (table primitives: `.tbl/.kv/.matrix/.rank`), `css-kit.mjs` (the **managed-region mechanism**: rev delimiter comments + `findAllBlocks` + in-place replacement + the status vocabulary `ok`/`stale`/`duplicate`/`broken`/`legacy-outside`/`missing`, shared by `--upgrade-css`/`--check-css`/check-slides/preview-page/capture/build-video), `tokens-template.mjs` (the single source of the generated tokens.css body + its content hash `TOKENS_REV`), `limits.mjs` (the 2 MB scan cap that applies to both tokens.css and slide HTML). The whole generated body is wrapped in a `tokens` managed region **with the three toolkit blocks nested inside**, so after any source module changes, `--upgrade-css` propagates exactly into old projects; `BLOCK_IDS` in css-kit is the single list of region ids.

Requirements: Node 18+ (scripts use fileURLToPath for compatibility, so they don't depend on Node 20.11's import.meta.dirname), `npm i playwright && npx playwright install chromium` (inside the project directory). ffmpeg/ffprobe are auto-detected: PATH → node_modules (ffmpeg-static/ffprobe-static) → common install locations; if they can't be found you get item-by-item diagnostics instead of a cryptic error.

## Installing into other Agent environments

This skill is the standard "one folder + SKILL.md at the root" shape (the frontmatter `name` / `description` are already written to spec), so dropping it into the corresponding skills directory is enough for it to be discovered. **Copy the reviewed skill directory out of the hosted plugin — not from any other source**: the hosted directory is the publication unit, and a copy taken from anywhere else has not been reviewed.

```bash
# from a checkout of the MiniMax-Code-Plugins repository:
cp -r plugins/Wzdhehe/html2video-for-mcode/skills/html2video-for-mcode ~/.claude/skills/        # Claude Code (personal scope) / OpenClaw / other AgentSkills hosts
# project-scope install
cp -r plugins/Wzdhehe/html2video-for-mcode/skills/html2video-for-mcode <your project>/.claude/skills/
```

After installing, you only need to add two **dependencies** (in your video project, not in the skill directory):

```bash
cd <your video project>
npm i playwright && npx playwright install chromium        # for screenshots
# ffmpeg, pick one: winget install Gyan.FFmpeg / brew install ffmpeg / apt install ffmpeg
# or: npm i ffmpeg-static ffprobe-static
```

**Why the skill still runs when installed elsewhere**: `scripts/tools.mjs` resolves `playwright` through a list of anchors — "the skill's own location → the project directory → the working directory at call time → npm global"; ffmpeg/ffprobe are likewise probed in four tiers (PATH → the project's node_modules → two levels up from the skill → common install locations). So "skill in `~/.claude/skills/`, dependencies in the project" is a supported setup (measured: the skill still renders images even when it lives outside the project tree).

## Runtime: two toolchains (same scripts, only the tool source changes)

The script layer (screenshots / rendering / compositing / validation / images) is completely environment-agnostic; **only TTS, music and ASR depend on platform capabilities**.

| Capability | mcode sandbox (preferred) | Other Agent environments (Claude Code / OpenClaw / Cursor, etc.) |
|---|---|---|
| TTS synthesis | `mcode-tools connector call connector__matrix__batch_text_to_audio --args '{...}'` (≤10 items per batch, the main path); for a single voice test use `connector__matrix__synthesize_speech` | `mmx speech synthesize --text "第一句口播。" --voice <voice_id> --speed 1.1 --out audio/01.mp3`; voice list via `mmx speech voices` |
| Writing results to disk | `get_asset_url <node_id>` → download to `audio/<id>.mp3` | `--out` writes straight to disk |
| BGM music | `connector__matrix__batch_text_to_music` (≤5 items per batch) | ⚠ **mmx-cli has no music generation** → have the user provide a music file (confirm licensing, then register it in MANIFEST), or skip BGM |
| Reverse ASR verification | `mcode-tools upload_temp_url` + `connector__matrix__listen_audio` | **`node scripts/asr.mjs <project>`** — calls REST (`/v1/speech_to_text`) directly with the same API Key, with no dependency on mcode and no need to install whisper; **it automatically compares against the expected text in the checklist and back-fills it, and mismatched numbers/traditional characters (Cantonese) are marked ✗ outright**. To measure sentence onset with character-level timestamps: `--verify-timing` |
| Image assets | Built-in browser inspecting the official site's DOM (preferred; take the image URL to disk with `scripts/fetch-official-images.mjs --url`) / official brand kit | Same image paths as on the left (in this environment use `fetch-official-images`, which ships its own Playwright headless browser for rendering pages); for abstract illustrations use `mmx image generate --prompt "..." --aspect-ratio 16:9 --n 3` (use `9:16` for vertical projects; **abstract concept images only — generating logos / screenshots / real people's faces is forbidden**), then register it per `image-sources.md` |
| Research | `web_search` / `web_fetch` (built in); for SPA/JS-rendered pages open them in the **built-in browser** to read the body text (usage discipline in references/research.md) | `mmx search "<keyword>"` / `mmx text chat`; for SPA pages render the body text with the project's Playwright **headless browser** (minimal command in research.md) |

**First-time mmx-cli setup** (non-mcode environments): `npm install -g mmx-cli` → `mmx auth login --api-key sk-xxx` → verify with `mmx quota`. A 401 is usually a region mismatch: `mmx config set --key region --value cn|global`. On the script side, use `MINIMAX_API_KEY` (required) and `MINIMAX_REGION=cn|global` (optional) to line up with the same identity.

**Discipline does not change with the environment**: durations still come from ffprobe measurements, subtitles still come from `clauses[]`, voices still have to be auditioned and language-verified (via asr.mjs above), and no Gate is skipped. **Search and body-text extraction are not limited to the tools in the table above either**: if other search skills/plugins are installed locally (web search, web reading, etc.), or any headless browser (the project's Playwright counts), use whichever one can get the body text — only the tool changes; source grading, two-source cross-checking and scope annotation are not negotiable.

## Workflow (7 phases · 6 Gates)

```
kickoff alignment (iron rule 4 — no gate, but it must happen first)
Phase 0 research      → Gate 0 fact list
Phase 1 script design → Gate 1 per-slide narration script
Phase 2 TTS + timing  → Gate 2 audition + duration table
Phase 3 assets        → Gate 3 asset list + preview + compliance check
Phase 4 HTML          → Gate 4 final-state screenshots
Phase 5 render + ASR  → Gate 5 finished video
Phase 6 delivery
```

**The order is scaffolding, not advice.** The narration script is final before TTS; TTS durations are measured before you touch assets and HTML; the asset list passes Gate 3 before it goes into the pages; the HTML passes the final-state screenshot before rendering. Changing the narration script = re-run from Phase 2 (TTS is cheap, redoing it costs little; forcing changes onto stale durations is the real disaster). Each Gate presents the user with exactly what its "acceptance-artifact list" specifies, and you never move forward without an OK — even when it looks obvious, confirm.

**To resume/continue an old project, do one thing before starting work**: `node <技能>/scripts/init-project.mjs <project> --check-css`. If it reports anything other than `ok` (stale / missing / duplicate / broken delimiter / leftover copy outside the region), run `--upgrade-css` — it replaces the managed region in place by content rev, leaves everything outside it alone, and backs up `.bak` automatically. The same check now **blocks** `check-slides`, `capture` and `build-video`: an old region still renders, just with stale rules, so a stale project would otherwise ship the wrong picture with no error anywhere. **Note that the upgrade only changes tokens.css** — already-generated `preview/*.png`, `build/frames/` and `out/*.mp4` still hold frames from the old CSS: affected slides need capture re-run (still + motion), preview-page re-run, then build-video. To tell which Phase a project stopped at: `research/notes.md` has content → past Gate 0; `script.json` clauses filled in → Gate 1; `audio/*.mp3` complete → Gate 2; `assets/` complete → Gate 3; `slides/*.html` complete → Gate 4; `build/frames` or `out/*.mp4` present → Gate 5.

### Phase 0 · Research (conditional)

**Full method in `references/research.md`** (source grading, query design, handling contradictions, notes template). Key points:

- The test is simple: if the finished video will contain specific **numbers, dates, names, quotes or attributions** → you must research. Generic/lyrical/creative subjects can skip it, but any sentence that "looks like a fact" still has to be verified.
- **Four hard rules**: ① key numbers need **at least 2 independent sources** (with only one, use hedged wording or downgrade to an approximation); ② **primary sources first** (official announcements/earnings reports/technical reports/government statistics); second-hand retellings must be traced back to the original; ③ label the **scope and date** (annualized or single quarter? weekly active or monthly active? which currency?); ④ **anything with no traceable source or that can't be determined goes into "uncertain items" — never into the narration script**.
- **How to get the body text**: try `web_fetch` first; SPA/JS-rendered official sites and investor-relations pages often return an empty shell, so switch to the **mcode built-in browser** (a host capability of the mcode environment) or a **Playwright headless browser** (any environment, already installed in the project) and render before reading the body text (minimal command in references/research.md); prospectuses/earnings reports are PDFs — take the numbers from the PDF text itself. When press releases and media retellings conflict, the official text wins. If other search skills/plugins are installed locally, they're equally usable — tools are open, discipline is not.
- **Regulated domains** (finance/healthcare/legal/policy/marketing claims → read `references/compliance.md`) add three more constraints: ① financial numbers must carry **scope + currency + timestamp** ("Q2 revenue", not "current revenue"); ② the narration **gives no operational advice, does not predict prices, and uses no absolute language**; ③ the disclaimer and data sources (whether, how and where) are settled with the user at Gate 0, not left to cause rework at the finished-video stage.
- Output `research/notes.md`: each entry has source URL + scope date + grade + second source; also list "uncertain items" and "content that must not go into the script"; for regulated subjects add a line recording **the confirmed domain + disclaimer wording**.
- **Gate 0**: the fact list goes to the user — focus on having them confirm **numbers, names and scopes**; for regulated subjects, confirm the disclaimer, data timestamps and up/down colors at the same time.

### Phase 1 · Script design (content volume is controlled here)

Fill it in slide by slide in `script.json` (the contract file that every later script reads):

```json
{
  "topic": "OpenAI 一分钟", "voice": "Chinese (Mandarin)_Gentleman",
  "speed": {"default": 1.1, "first": 1.05, "last": 1.05},   // 试听时与用户定的语速(1.1 ≈ 中文 5.3 字/秒)
  "transition": {"type": "cut"},                              // 切页方式: cut 硬切(默认) / {"type":"xfade","duration":0.4} 交叉溶解
  "fps": 30, "width": 1920, "height": 1080,
  "bgm": "assets/bgm.mp3",
  "slides": [
    {"id": "03", "layout": "bullets", "html": "03-lines.html", "audio": "03.mp3",
     "title": "三大产品线",
     "clauses": [
       {"stage": 1, "text": "三大产品线。"},
       {"stage": 2, "text": "ChatGPT 对话,GPT 系列模型,Sora 视频生成。",
        "text2": "Chat, models, video generation."}
     ]}
  ]
}
```

Optional fields: `clauses[].text2` = the second line of bilingual subtitles (omit it for Chinese-only subtitles); top-level `bgm` = `"assets/bgm.mp3"` or `{file, volume:0.12, fadeIn:1.5, fadeOut:2.5}` (when set, build-video loops it + fades it in and out underneath automatically).

**Content-volume hard rules** (detailed version in `references/authoring.md`):

- Chinese narration ≈ 5.3 characters/sec (speed 1.1; ≈4.8 at speed 1.0). Target 6–10 seconds per slide → 25–48 characters of narration; 12–20 characters for the first and last slides. Hard limit is 60 characters per slide; split into two slides if it goes over.
- **Every slide (except the first and last) must have at least two information layers, mapped to different stages — but the order of the layers is free** (a big number can enter first and the title later; the question first and the answer after; it's decided by the strong-sync principle: a layer hangs on the stage of the sentence that mentions it). Title only, no expansion = a violation, send it back. Same for the narration: at least two sentences per slide, each driving a different layer.
- Each element of `clauses` is one narration sentence; `stage` declares "when this sentence starts, which visual layer should appear". The number of stages ≈ the number of clauses, one-to-one.
- There are 17 layouts in total (the original 8 + 9 added: kpi-grid / stat-highlight / table / timeline / roadmap / comparison / flow-diagram / terminal / big-quote); each one's required frame elements and character-count range are in the layout table in `references/authoring.md`; **charts (bars/columns/donut/line/progress) have a pure CSS/SVG cheat sheet — no external chart library needed**.
- **For data-dense subjects, proactively make charts**: when the narration contains ≥2 comparable numbers, proportions or a trend, prefer the `data-viz` layout + chart toolkit over listing numbers as bullets — whether to chart and in what style was already asked in the "Data and charts" row of kickoff alignment; if the user didn't raise it then, offer the option proactively (charting is built in, don't leave it idle). Numbers must come from verified scopes (Gate 0), and bar heights/lengths are computed from the values (see the nine disciplines in authoring.md).
- If the user asked for **bilingual subtitles** during kickoff alignment, write `text2` for every sentence here (a translation of the same sentence, no reordering, ≤60 characters).

**Gate 1**: the user reviews the slide-by-slide narration script + layout assignment, presented per slide as "# / layout / frame / **table and animation** / verbatim narration". **The table-and-animation column is a required part of the presentation**: slides that use table primitives must state the table's shape (how many rows and columns, which primitive `.tbl/.matrix/.rank/.kv`, which row/column is highlighted); slides with entrance animations must name the effect and the order (e.g. "three cards fade in one by one, staggered 150ms", "the number counts up to 92.4%", "the bars grow in from the left one after another") — the user has to be able to play the finished video once in their head from this table, instead of seeing it move for the first time at Gate 4. **No Phase 2 until every slide is OK'd.**

### Phase 2 · TTS + measured timing sync

Which toolchain TTS uses is in the "Runtime" comparison table above (mcode uses `connector__matrix__*`, other environments use `mmx speech synthesize`); command templates and retry discipline are in `references/tts-and-timing.md`. Key points: batches ≤10 items; on partial failure, sleep 10–30s and **retry only the failed items**; first and last slides use speed 1.05 (but keep 1.1 for short sentences ≤10 characters — see the measured pitfalls in that file). Output goes to `audio/<id>.mp3`. **The audition step must ask about voice and speed together** (one sentence each from 3 candidate voices + the top-choice voice at all three speeds); only batch-synthesize once the user has decided.

Then sync the timing:

```bash
node <skill>/scripts/plan-timings.mjs <project>
```

It does this: ffprobe measures each segment → per-slide duration = measured + tail padding (default 0.8s, adjustable via the slide's `tail` field: tight 0.4 / relaxed 1.2) → each stage's entrance moment = the onset estimated from that sentence's share of the characters − 0.2s (visuals slightly ahead of the voice, which reads as in sync) → each sentence's onset/duration written into `clauses[]` (shared by subtitles, ASR sentence splitting and timing calibration) → writes `build/timings.json` and prints warnings (abnormal speech rate, over 15s, last stage too close to the ending, sentence over 18 characters so the subtitle will wrap).

Optional but recommended (especially when the user has reported "audio and visuals out of sync"): `node <skill>/scripts/check-timing.mjs <project>` measures each sentence's true onset with silence detection and prints an "estimate vs measured" comparison table; if the deviation is large, `--calibrate`, then delete `build/frames/` and re-render. Note that "feels out of sync" is often a design misalignment — a big number/hero image must hang on the stage of **the sentence that mentions it** (strong-sync principle, see authoring.md).

**Gate 2**: the user listens through every narration audio segment + reviews the duration table from plan-timings.

### Phase 3 · Asset collection (compliance is enforced here)

Follow the image SOP in `references/image-sources.md` (core principle: **for images with an incomplete subject / cut off halfway / wrong aspect, search again for the full view first — don't force a crop**). Key points:

1. Write the requirements list (which slides need images, and what kind).
2. **Priority: official channels (brand kit / simple-icons / official documentation screenshots) → open the official site in the built-in browser or Playwright and inspect the DOM for official assets (highest measured success rate) → Wikipedia CC → pure-typography fallback (number cards + large type + quotes, no images). Negative-event subjects (blow-ups / penalties / lawsuits / controversies) won't have assets on the official site, so switch to **announcement and news-report screenshots**: exchange/regulatory announcements, company statements, or screenshots of mainstream media report pages (top-tier authorities and portals like Tencent News/Sina are both fine; self-media excluded), and the frame must keep the outlet name and date (commands and discipline in image-sources.md path D).** The old image-downloader (Bing) is off by default: on niche Chinese-language subjects it returned irrelevant images 5/5 times.
3. Add positive keywords when searching for images (panorama/full view/front view/wide shot), and screen with thumbnails before downloading: subject centered, aspect close, no watermark, no unrelated logos, ≥1200px; if one doesn't fit, swap it — don't settle.
4. Once you have an image, first run `node <技能>/scripts/prep-image.mjs --check <图>` to check dimensions and crop risk; if the subject touches the edge, swap the image.
5. Compliance-check every asset: no watermark, trademarks only in a fair-use context, photos from licensable sources, screenshots (official docs or news/announcements) must keep their source and date and be registered in MANIFEST.
6. Save to `assets/`, one line per asset in `assets/MANIFEST.md` (content/source/license).
7. **Generating logos, screenshots, avatars or QR codes out of thin air is forbidden; putting watermarked images into assets is forbidden; dropping a bare `<img>` is forbidden (it must be wrapped in `.img-frame`).**

**Gate 3** (after asset collection is done and both the facts and candidate images are in hand): give the user the asset-list table + a preview of each asset (thumbnail/description), and ask three things: ① **which ones to use** — have the user pick slide by slide (annotate recommended usage, e.g. "slide 02 with the hero image"); whatever they cross out is dropped; ② **is there anything to add** — links (official pages/report pages/data pages), screenshots, logos, pictures, data files, reference narration scripts can all be handed to the agent directly; **user-provided assets have the highest priority** (they save searching and the source is reliable): images go to `assets/`, pass `prep-image --check`, and are registered in MANIFEST as "source: user-provided"; links are saved to disk per image-sources.md paths A/B/D or used as Gate 0 fact sources; ③ "are the asset sources and licensing fine". **Only write the HTML after the user has signed off.**

### Phase 4 · HTML (staged entrance is implemented here)

One file per slide, in `slides/`, with the filename matching the `html` field in script.json. Conventions:

- The root element `<html data-theme="...">` selects the theme (the initial ones `a|b|c`, plus `minimal-white / swiss-grid / corporate-clean / editorial-serif / magazine-bold / tokyo-night / catppuccin-mocha / nord / xiaohongshu-white / soft-pastel`; theme cheat sheet and contrast verification in authoring.md); import `tokens.css`; the frame container is `.stage`, containing the `.brand` corner badge and the `.slide-num` page number.
- **Every block that should enter gets `data-stage="1|2|3"` + one fx utility class** (`fx-up/fx-fade/fx-grow/fx-blur/fx-rise/fx-pop/fx-spotlight/fx-ripple/fx-glitch/fx-draw`; ambient ones `fx-pulse/fx-shimmer/fx-kenburns` take no data-stage); don't write delays — the pipeline injects `--t1/--t2/--t3` from `timings.json`. For staggering within a level use the `.fx-stagger` container (baseline `style="--stagger-base:var(--t2)"`, which is also the default) or inline `style="animation-delay:calc(var(--t2) + 150ms)"`.
- ⚠ **`data-stage` must be used together with an fx class** (the attribute alone with no animation class leaves it stuck at opacity:0 forever); for how delays are implemented see "how stage delays work" in authoring.md, and don't hand-write `animation-delay: var(--tN)` when changing animations.
- Always wrap images in `.img-frame` (`.contain` for screenshots/charts; `--img-ratio` sets the aspect; `--img-pos` protects the subject; the `.img-cap` caption goes outside the frame).
- Ambient animations (infinite looping breathing/floating) are allowed, but they must not carry information and get no `data-stage`.
- **Animations can be switched off in one move**: `<html data-theme="..." class="no-fx">` turns them off for the whole project, adding `no-fx` to any container turns them off for a single slide, and an element with no fx class is simply static. With them off, motion capture automatically degrades to producing the video from static frames; durations and audio-visual sync are unaffected and subtitles work as usual (details in authoring.md "animation switch").
- Do not use transitions for entrances (the screenshot pipeline can't seek to them); use only `@keyframes`. External Google Fonts are banned (unstable offline) — use a system font stack (tokens.css already configures a CJK fallback).
- Use only the `assets/` list confirmed at Gate 3; add no unreviewed assets.
- If you changed the project's `tokens.css` (custom brand color, A-share up/down color flip, subtitle hooks `--sub-bg/--sub-ring`) → first run `node <技能>/scripts/check-theme.mjs <project>` to verify contrast (skippable if the built-in themes are untouched). Discovering a contrast problem at Gate 5, in the finished video, is the most expensive rework there is.
- ⚠ **After writing the 8 slides, run the static check before screenshotting**: `node <技能>/scripts/check-slides.mjs <project>` — it catches undefined CSS variables (which make text invisible), missing images/external resources, data-stage without an fx class, and hard-coded colors. Any ✗ and don't screenshot: a frame that is correct but "invisible" is the hardest thing to debug.

Once the slides are written, produce the final-state preview (the fastest path, for Gate 4):

```bash
node <skill>/scripts/capture.mjs <project> --mode still
node <skill>/scripts/preview-page.mjs <project> --open   # 放映页: 让用户自己过一遍动效
```

**Gate 4**: walk the user through `preview/<id>.png` slide by slide (layout, text pressure, assets) + **hand the play page `preview/play/index.html` over for the user to present themselves** (are the animations really all appearing, is the speed acceptable, does the frame hold up). Static images can't show animation — failures like "the element never appears", "turning animations off leaves a blank frame", "column heights collapse" only surface when it moves or when you toggle between the two; the play page is a 30-second self-check, so there's no need to wait for the 3–6 minute motion encode. Timing and whether the narration lines up are not judged here (the play page deliberately has no timer) — the finished video and `timings.json` are the source of truth.

**This step must ask the user two questions (since 1.6.0; per iron rule 4, ask as questions + options and stop to wait for answers)** — both can only be decided by "seeing how it moves"; static images and written descriptions can't substitute:

1. **Slide transition**: hard cut (default, recommended) / 0.4s cross-dissolve / custom dissolve duration. Have the user press `T` in the play page to **compare live** (the play page switches between hard cut and dissolve instantly; the dissolve is a 0.4s blend that never passes through black), and once decided, write it into `transition` in `script.json` (`{"type":"cut"}` or `{"type":"xfade","duration":0.4}`).
2. **Entrance layering**: should the big title and the sub-information **all appear at once**, or be **revealed level by level** (the current `data-stage` default). For "at once", collapse that slide's `data-stage` levels into a single level (title and sub-items on the same stage, or drop the later stages), then re-run that slide's `capture --mode motion` and rebuild; in the play page, verify the collapsed result level by level with "animations on + →".

Once both are decided, restate "final choices: transition = X / entrance = Y". `check-slides.mjs` prints the measured status of both at the end (the transition value + the level count per slide) — ask based on that, not on impressions. **Only enter Phase 5 after the user has signed off.**

### Phase 5 · Render + ASR verification

```bash
node <skill>/scripts/capture.mjs <project> --mode motion   # entrance animations rendered frame by frame into the video
node <skill>/scripts/build-video.mjs <project> --asr
```

- `--mode motion`: frame-by-frame stepping (pause all animations → seek frame by frame → screenshot → encode); the animation window is rendered frame by frame and still segments get the tail frame automatically, so durations are exact. **Subtitles are burned in by default** (content from clauses; the display window = from that sentence's onset to the next sentence's onset; centered at the bottom of the frame; not shown in still previews, only in the finished video; `--no-subs` turns it off). Cost is about 50–200ms per frame — 8 slides × 30fps is roughly 3–6 minutes, so budget for the timeout. In a hurry you can produce the video in still mode (animations don't make it into the video, only fades).
- ⚠ **Re-running a still capture invalidates that slide's frame directory** (capture's design to prevent stale-frame contamination). If you changed the HTML after Gate 4 and want another look → `capture --mode still --ids <id>`, and **after confirming, you must re-run `--mode motion` for the same ids before build-video**; otherwise that slide falls back to a static image in the video and its animations are silently lost (build-video calls this out with a ⚠).
- build-video does this automatically: encode each slide (uniform parameters) → concat (automatic fallback re-encode on duration drift) → align the audio track with `apad` using each slide's measured duration → **bed the BGM underneath (only when bgm is configured: loop to fill, fade in/out, voice first; falls back to voice-only if mixing fails)** → mux → ffprobe duration check + full decode self-check, non-zero exit code if it fails; it also outputs `out/subs.srt` (same source and same windows as the burned-in subtitles; bilingual subtitles are generated automatically as two lines from each clause's text2, for platform upload).
- `--asr`: splits out `asr/part-<id>-<k>.mp3` **by sentence** + generates `asr/checklist.md`. The transcription is compared with the expected text: numbers, years and product names must match; homophones are tolerable. **If a segment's transcription bleeds in the start of the previous sentence, that sentence actually started later than estimated — run check-timing to calibrate.**
  - mcode: upload with `mcode-tools upload_temp_url`, then hand off to `connector__matrix__listen_audio`.
  - **Other environments**: `MINIMAX_API_KEY=sk-xxx node scripts/asr.mjs <project>` — calls REST directly (same Key), compares and back-fills the checklist automatically; failing items (mismatched numbers/traditional characters) are reported with a non-zero exit code. For more accurate onset times: `--verify-timing`.
  - For a slide that fails: change the narration or redo that segment's TTS → re-run plan-timings → re-render that slide (just delete the corresponding slide's frame directory).

**Gate 5**: the user reviews the finished video `out/final.mp4` + the ASR verification table, including a subtitle readability check (play it once muted — can the subtitles carry the meaning) and the BGM level (is the voice always clear). **Before publishing, pull real frames from the finished video and look at them slide by slide**: `node <技能>/scripts/grab-frames.mjs <project>` → `build/introspect/` — whether captions/credits are covered by subtitles, whether all the last-level elements made it into the frame, and whether the ending holds still long enough; these three are invisible in both stills and the play page.

### Phase 6 · Delivery

```
out/final.mp4            # main deliverable
out/slide-*.mp4          # per-slide segments (publishable on their own)
out/cover.png            # cover image (canvas size; the video embeds it as attached_pic for thumbnails, this file is for platforms that want a manual upload)
out/subs.srt             # subtitles for platform upload (same source and windows as the burned-in ones)
build/timings.json       # single source of truth for timing (read by check-timing / asr / preview-page)
build/substills/         # one still per subtitle sentence + window manifest (windows the frame sequence cannot cover; build-video concatenates them)
build/audio-timeline.wav # aligned audio timeline
preview/*.png  preview/play/index.html   slides/*.html  slides/tokens.css
audio/*.mp3  assets/(含 MANIFEST.md)  research/notes.md  asr/(校验记录)
```

(`slides/tokens.css.bak` is the pre-upgrade backup made by `--upgrade-css`; delete it once the finished video checks out.)

## Reference files (read on demand, not all of them)

- `references/authoring.md` — the 17 layout specs (required frame elements for each) + the content-volume table + how to use the entrance system (including how stage delays work) + the **chart toolkit** (chart primitives, the nine elegance disciplines, 7 recipes and animation selection) + the **table toolkit** (four primitives, seven disciplines, five shapes) + theme cheat sheet + vertical notes + copy-pasteable HTML snippets
- `references/compliance.md` — domain and compliance (required reading for regulated subjects): how to confirm the domain, red lines for financial narration, the three requirements for numbers, flipping up/down colors by audience, how and where to write the disclaimer, key points for medical/legal/advertising law, and the closing checklist
- `references/research.md` — research (source grading, hard cross-validation rules, query design, handling contradictions, notes template)
- `references/image-sources.md` — image and asset SOP (the three image paths, positive/negative query terms, two-stage screening, how to use the image frame, hard crop limits, the three-piece visual verification, and an index of common subjects)
- `references/tts-and-timing.md` — mcode TTS connector commands, retry discipline, the timing algorithm, tail-padding and speech-rate tuning, and the measured voice table
- `references/render.md` — how rendering works (why frame-by-frame stepping, how fonts are awaited), the subtitle system, cover and slide transitions, BGM mixing, manual ffmpeg commands, and a troubleshooting table
- `references/symptoms.md` — **the long symptom list** (moved out of the `description`, which the host caps at 1024 characters): symptom → the script/section that usually owns the fix. Reach for it when the user describes a problem rather than asking for a video
- `THIRD-PARTY-NOTICES.md` — third-party component license notices (10 themes and some CSS primitives adapted from html-ppt-skill, MIT)

## Common symptoms → one-line diagnosis

> The full symptom index (symptom → the section that usually owns the fix, including the ones that only make sense as *trigger* phrases) is `references/symptoms.md`. The `description` field only carries a short pointer to it because the host caps that field at 1024 characters.

| Symptom | Root cause | Action |
|---|---|---|
| The frame lingers long after TTS finishes speaking | Durations were estimated rather than measured, or the tail is too large | Re-run plan-timings; adjust that slide's `tail` |
| The frame has only a title, no expansion | Violates the content-volume hard rule | Add an expansion layer + its clause, go back to Phase 1 |
| Animations aren't in the video | Still mode was used | Re-render in motion mode |
| Audio and visuals feel out of sync | One of three: hand-written animation delays / estimation drift / the visual anchor hung on the wrong sentence (strong-sync principle) | First remove the hand-written delays; run check-timing for measured data and --calibrate if the drift is large; if the anchor is on the wrong sentence, fix the stage mapping |
| The voice is in the wrong language (Cantonese/traditional characters) | The platform's voice labels are mismatched; names can't be trusted | The Phase 1 audition must include ASR voice verification (see the measured voice table in tts-and-timing.md) |
| The finished video has no subtitles | --no-subs was used, or clauses are missing | capture burns them in by default; confirm timings.json has clauses |
| Bilingual subtitles wanted | — | Add `text2` to the clause; the frame shows two lines + the SRT gets two lines automatically; keep the second line ≤60 characters |
| Want background music | — | Configure top-level `bgm`; build-video loops it + fades it in/out underneath automatically (default volume 0.12); ASR verification still runs on the voice-only track |
| In a hurry / the subject calls for restraint, no animation | — | `<html class="no-fx">` turns off all animation in one move, or add `no-fx` to a single slide's container; the video is then produced from static frames with unchanged durations (see authoring.md) |
| Total duration is wrong after concatenation | Segments mixed from different encoder parameters | Let build-video encode all segments uniformly; it already falls back to re-encoding automatically |
| Chinese text shows as boxes | No CJK font on the system | On Linux install fonts-noto-cjk; or switch to an installed font |
| A "can't find ffprobe/ffmpeg" error | The binaries aren't on PATH | The scripts already auto-detect PATH→node_modules→common locations; install ffmpeg-static or run winget install Gyan.FFmpeg |
| **Some elements enter at 0 seconds, others on schedule** | The delays in an old tokens.css are overridden by the `.fx-*` shorthand | Switch to the new tokens.css (delays go through `--fx-delay`); rationale in authoring.md |
| The image subject is cropped out of frame / the image breaks the layout | A bare `<img>`, or cover with the wrong aspect | Wrap in `.img-frame` + `--img-pos` to protect the subject; use `.contain` for screenshots; if the subject touches the edge, re-search the image per the SOP |
| Subtitles blur into the background on dark themes | The theme doesn't override the subtitle hooks | Add `--sub-bg` (darker) + `--sub-ring: 1px solid rgba(255,255,255,.16)` to that theme; run check-theme to verify |
| Vertical output wanted (Douyin/WeChat Channels) | — | Set `width:1080, height:1920` in `script.json` and switch the layout to stacked (see the vertical section of authoring.md) |
| Numbers/text are written but invisible | An undefined CSS variable + `-webkit-text-fill-color: transparent` invalidates the whole background declaration | Run `check-slides.mjs` to locate it, then add the definition or write `var(--x, 默认值)` |
| A chart/line/some element is completely missing after entering | That fx class's keyframes don't declare opacity — the base state of `[data-stage]` is `opacity:0`, and an animation that only does transform/stroke can't bring it back | Add `opacity:1` to the keyframes' from/to; `check-slides.mjs` reports this directly |
| Turning on `no-fx` makes the frame emptier instead | Early templates only turned animations off without restoring the `[data-stage]` `opacity:0` base state | The project's tokens.css is outdated: `node scripts/init-project.mjs <project> --upgrade-css` updates the managed region in place (idempotent); when the play page meets an old tokens.css it injects the current body into its **snapshot copies** and says so explicitly — note that a correct preview page does **not** mean the rendered video is current, so upgrade before capture/build-video |
| The skill's CSS changed (or you used a new class like `.chart-ticks`) but the project doesn't pick it up | The project tokens.css's managed region lags behind the skill's single source (the old check only looked at presence, so after one patch it always reported "no upgrade needed"; duplicate blocks and copies outside the region won the cascade silently) | `node scripts/init-project.mjs <project> --check-css` shows the status; `--upgrade-css` replaces the region in place by content rev (leaving your own rules alone); **check-slides, capture and build-video all refuse to run while it is stale** |
| Double-clicking `slides/*.html` shows the animation crammed at the start | Animation delays are injected by the pipeline from `timings.json`; tokens.css only holds placeholder values (`--t2:800ms`) | Don't open the original file directly: run `preview-page.mjs` and use its copy (with the measured delays injected), or produce the video with `--mode motion` |
| Bar heights don't match the labeled values (tall bars squashed) | Bars placed directly in a flex column with a percentage height: the basis is the **whole column** height, and anything overflowing the remaining space is squeezed back by `flex-shrink`, silently distorting it | Wrap the bars in `.chart-plot-cell` (a 1fr row) so the percentage is computed against the plot area; you also get a baseline and equal-height columns for free |
| The line chart shrinks into a small patch in the middle | The SVG's `viewBox` aspect doesn't match the container, so `preserveAspectRatio` scales the content down and centers it | For full width use `width:100%;height:auto`; for half width or a fixed height, change the viewBox to a ratio close to the container's |
| A chart/caption is covered by the subtitles | Content was laid out into the subtitle band (bottom 84–168px, centered, 73% wide) | Start the layout container at `padding-bottom: 190px`; see the "subtitle safe area" section in authoring.md |
| Tables are unreadable on phones | The table text uses the caption size (24px), or row height was squeezed below 72px | Use the `.tbl/.kv/.matrix/.rank` primitives: main data uses the body size (30px) and row height is 72px built in; see "table toolkit" in authoring.md |
| The iframe in the play page is blank/broken images | The copy's `<base href>` was stripped, or slides/ was moved | Re-run `preview-page.mjs` to regenerate the snapshot; don't hand-edit the original file (the copy is a snapshot, so you must re-run after changing slides) |
| Images show a broken icon | The file is missing, or the SVG itself is broken (bad XML / depends on external resources / no dimensions) | Use `check-slides.mjs` to check the path; inline the SVG into the HTML; capture also names which image failed to load at render time |
| A finance video has no disclaimer / the up-down colors are inverted / numbers are challenged on scope | The domain wasn't confirmed at kickoff, so default colors and default wording were used as-is | Read `references/compliance.md`: add a closing `.disclaimer` line (on screen ≥3s), change metric cards to `var(--up)/var(--down)` flipped for the audience's market, and give every number its scope + currency + timestamp |
| Not sure whether a disclaimer is needed / whether this counts as regulated | The domain wasn't confirmed | Ask "domain + disclaimer or not" in the first batch of kickoff questions; financial investment research, healthcare, legal, policy and marketing performance claims default to yes. `check-slides.mjs` warns when it hits finance keywords but sees no disclaimer line |
