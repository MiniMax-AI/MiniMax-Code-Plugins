**English** | [中文](README.zh-CN.md)

# HTML 2 Video for mcode

Turn a topic, an outline, or a finished script into a **narrated MP4**: HTML slides with staged
entrance animations, a TTS voiceover, burned-in subtitles, and an ASR pass that verifies the
voiceover actually says what the script says.

Built for MiniMax Code (mcode), and runnable in any agent host through `mmx-cli`.

## What the user gets

Ask in plain language, get a publishable video:

> 帮我把这份大纲做成一条 60 秒的中文口播视频:三张关键数字、结尾一句行动号召,用深色科技主题,加中文字幕。

Result:

```
my-video/
├── slides/            8 HTML slides + tokens.css (13 themes, 17 layout recipes)
├── audio/             8 TTS clips
├── build/timings.json measured durations + per-layer entrance times
├── preview/*.png      terminal-state frames
└── out/
    ├── final.mp4      ★ the deliverable (1920×1080 or 1080×1920, H.264 + AAC)
    ├── subs.srt       subtitles for platform upload
    └── slide-*.mp4    per-slide segments
```

## Pipeline

One Skill drives an 11-script pipeline (`skills/html2video-for-mcode/scripts/`):

| Stage | What happens |
|---|---|
| 1. Kickoff alignment | Ask about language (Chinese / English / Cantonese), style & brand color, subtitles (none / single / bilingual), canvas (16:9 or 9:16), duration, voice, asset boundaries |
| 2. Research | Fact-check the topic and record sources before writing |
| 3. Script | Per-slide narration split into clauses; every slide must have a title layer and a detail layer |
| 4. TTS | Voice synthesis (mcode connector, or `mmx-cli` elsewhere), then measure every clip with ffprobe |
| 5. Timing | Derive each slide's duration and each animation's entrance time from the **measured** audio — nothing is hand-written |
| 6. Assets | Official sources first, image framing primitives, compliance manifest |
| 7. HTML | Staged entrance animations bound to the measured timings; layout recipes for 17 slide types |
| 8. Render | Deterministic frame-stepping capture (animations land in the video), ffmpeg assembly with subtitles, optional background music |
| 9. Verify | ASR transcription compared against the script; contrast, theme, and static-slide gates |

## Design decisions worth knowing

- **Nothing about timing is hand-written.** Every slide's duration and every animation's entrance
  time comes from the measured TTS audio, so "the voiceover finished but the picture is still
  waiting" cannot happen by construction.
- **Every slide has a title layer and a detail layer** on separate animation stages, so a slide is
  never just a big title with nothing to look at.
- **Animations land in the video.** Capture steps frames deterministically instead of
  screen-recording, so entrance animations are actually rendered rather than frozen.
- **Rendering is gated.** A static check refuses to render slides with undefined CSS variables,
  missing images, external resources, or entrance animations without an animation class — the
  failure modes that otherwise ship a video that looks broken while every script reports success.

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
node <skill>/scripts/capture.mjs ./my-video --mode motion
node <skill>/scripts/build-video.mjs ./my-video --asr
```

`SKILL.md` carries the full workflow (7 phases, 6 confirmation gates); `references/` holds the
authoring rules, asset-sourcing SOP, TTS/timing notes, and rendering internals.

## Supported platforms

Windows, macOS, and Linux. All scripts are Node ESM and shell-agnostic. On Windows prefer Git
Bash / WSL over PowerShell (complex argument lists with non-ASCII paths can misbehave there);
ffmpeg and Chromium paths are auto-detected.

## Network access

Nothing is contacted unless you invoke the step that needs it:

- `scripts/asr.mjs` — HTTPS `POST` to `https://api.minimaxi.com/v1/speech_to_text`
  (or `https://api.minimax.io` when `MINIMAX_REGION=global`). Only when you run it.
- `scripts/fetch-official-images.mjs` — opens the URL **you** pass (an official site or a local
  `file://` page) to list and download candidate images.
- Voice synthesis happens through mcode connectors or `mmx-cli`, which contact MiniMax.
- Everything else (timing, static checks, capture, encoding, theme validation) is fully offline.

No telemetry, no analytics, no hidden endpoints, no installers, no native binaries.

## Data use

- The narration text you write is sent to the speech service you chose; the produced audio is sent
  to the ASR service only if you run `scripts/asr.mjs`.
- Assets you fetch are downloaded into your project's `assets/` directory and must be recorded in
  `assets/MANIFEST.md` with source and license.
- Everything else stays on disk inside your project directory. The Skill writes only inside the
  project directory you pass to it.
- No credentials are stored or embedded: the ASR script reads a key from `MINIMAX_API_KEY` or
  `--api-key` at runtime and never writes it anywhere.

## Troubleshooting

`SKILL.md` ends with a symptom → cause → fix table covering the failures this pipeline has actually
hit: silent tails after the voiceover, slides with nothing on them, elements entering at 0 seconds,
invisible text from undefined CSS variables, broken images, subtitles washed out on dark themes,
wrong voice language, and mismatched concat durations.

## License

MIT — see `LICENSE`. Portions of the design system (10 themes, image-frame primitives, several
entrance animations) are adapted from
[html-ppt-skill](https://github.com/lewislulu/html-ppt-skill) (MIT, Copyright (c) 2026 lewis); the
full notice and the upstream MIT text are in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
