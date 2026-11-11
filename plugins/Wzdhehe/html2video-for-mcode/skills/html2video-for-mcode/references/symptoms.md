# Symptom index (when to reach for this skill, and where to look)

This file holds the long symptom list that used to live in the SKILL.md `description` (the host caps that field at 1024 characters). The description now says "also trigger on symptoms"; **this is the list**.

Use it two ways: as trigger examples (the user describes one of these and you reach for this skill) and as a first routing hint (the right column is where the fix usually lives).

| Symptom as the user describes it | Where it usually comes from |
|---|---|
| TTS leaves too long a silence after it finishes speaking | `tail` too large or the pause is in the audio itself → re-cut that TTS segment (`references/tts-and-timing.md`) |
| the frame has only a title with no detail expansion | the slide violates the "≥2 information layers" rule → add layers, then re-run Gate 1 (`references/authoring.md`) |
| some elements enter at 0 seconds | the fx delay was overridden — check `--fx-delay` / `.fx-stagger` (`references/authoring.md`, and `check-slides.mjs` item 5d) |
| entrance animations aren't rendered into the video | motion frames missing — `capture --mode motion` for those ids, then rebuild (still capture invalidates the frame dir) |
| audio and visuals are out of sync | re-run `plan-timings.mjs`, then `check-timing.mjs` / `asr.mjs --verify-timing` (`references/tts-and-timing.md`) |
| an image's subject is cropped out of frame | re-pick or re-crop the asset — `prep-image.mjs --check`, and see `references/image-sources.md` §2-4 |
| subtitles are muddy on a dark background | contrast below 4.5:1 — `check-theme.mjs`, then theme hooks `--sub-bg` / `--sub-fg` / `--sub-ring` (`references/render.md`) |
| the total duration after concatenation is wrong | `build-video.mjs` duration self-check — usually stale frames or a wrong `timings.json` |
| fonts flicker or show as boxes | missing glyphs / web fonts — use system CJK fonts and inline or local assets (`references/render.md`) |
| a chart or some element never appears after entering (the keyframes don't bring opacity back) | the keyframes never lift `opacity` — `check-slides.mjs` item 5b names it; fix the keyframes (`references/authoring.md`) |
| switching to no-fx makes the frame emptier instead | old tokens.css: `init-project.mjs --upgrade-css` (the no-fx reset is a managed block) |
| double-clicking slides/*.html to watch the animation shows everything crammed at the start | that is the placeholder delay — open the play page `preview/play/index.html` instead (`references/render.md`) |
| or a finance video forgot the disclaimer or has the up/down colors inverted | `references/compliance.md`: disclaimer line + the audience market's up/down convention |

## More symptoms worth triggering on

- A slide that reads fine as a still but falls apart once it moves (elements overlapping, things never appearing) → the play page is the 30-second check: `preview-page.mjs`.
- The thumbnail of the shared file is black, or every page change flashes black → `references/render.md` "Cover and transitions".
- The voice is too fast/slow, or a Chinese voice came out Cantonese → the audition step plus ASR verification (`references/tts-and-timing.md`).
- Stale styling after the skill updated (`new classes have no effect`) → `init-project.mjs --check-css` / `--upgrade-css`; see `references/render.md`.

> When a symptom points at a script, run it with `--quiet`/`--ids` to narrow first; every diagnostic script prints the exact next command on failure.
| a script exits 0 with no output at all (printed nothing, did nothing) | you **imported** the CLI instead of running it — `node -e "import(…)"` never runs `main` by design; run `node <script> …` instead. (Before 1.9.9 an entry reached through a symlinked path could also silently no-op — the entry guard compared raw paths) |
| Playwright in a cloud sandbox cannot find its browser (`chrome-headless-shell` path errors) | partial browser install: `npx playwright install chromium` lays down `chromium-*/chrome-linux/chrome` while some runtimes look for `chromium_headless_shell-*/…/chrome-headless-shell` — copy+rename the binary as a stopgap (seen on mavis-like sandboxes) |
| `git clone` from GitHub fails with a certificate/SSL error in a locked-down sandbox | fetch the archive instead: `curl -o repo.zip https://codeload.github.com/<owner>/<repo>/zip/refs/heads/main` (seen on mavis-like sandboxes) |
