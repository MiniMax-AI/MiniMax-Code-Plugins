# TTS Integration and the Timing Sync Algorithm

## Why TTS comes before the HTML (the biggest difference between this pipeline and common practice)

The common order is "write the HTML first, then dub it", which forces you to **estimate** each slide's duration and **guess** the animation delays; the typical symptoms it produces are: TTS finishes speaking and the visuals sit there dumbly for several seconds (over-estimated), or an unfolding layer appears only when the narration has already moved elsewhere (guessed wrong).

This pipeline goes the other way: script finalized → run TTS immediately → ffprobe measurement → compute every stage's entrance moment → only then touch the HTML. There are no hard-coded seconds anywhere in the HTML; all delays are injected by capture through `--t1/--t2/--t3`. Change the voice, change the speech rate, change one word, and you only need to re-run TTS and plan-timings — the HTML usually needs not a single character changed.

## Timing sync algorithm (plan-timings.mjs internal logic)

For each slide:

1. `D` = the segment's TTS duration measured by ffprobe.
2. The k-th narration sentence's onset ≈ `D × (character count of the first k−1 sentences ÷ total character count)` (Chinese speech rate is distributed evenly enough across sentences; the error is usually <0.3s).
3. Stage s's entrance moment = the onset of the earliest sentence mapped to that level − 0.2s (the visuals lead slightly, which reads as synced; broadcast convention).
4. Final video duration = `ceil((D + tail) × fps) / fps`, aligned to the frame grid; `tail` defaults to 0.8s.

Character counting ignores whitespace and includes punctuation (TTS pauses naturally at punctuation, so including it is actually more accurate).

Timing data has three layers, each one measurable and traceable; when you suspect audio-visual desync, **get the data first, then act**:

1. **Estimate** (plan-timings): the character-share estimate above. For normal speech-rate samples the error is usually <0.3s.
2. **Silence measurement** (`node scripts/check-timing.mjs <项目目录>`): TTS has 0.2s+ pauses between sentences, and the script uses ffmpeg silencedetect to measure each sentence's real onset directly, outputting an "estimate vs measured" comparison table; `--calibrate` writes the measured boundaries back into timings.json (it only calibrates slides where the silence-segment count and the sentence count match exactly), after which delete `build/frames/` and re-run capture and build-video.
3. **ASR review** (build-video `--asr`): cut the audio by sentence and transcribe each part, verifying both content (numbers/proper nouns) and boundaries — if a part's transcript bleeds in the start of the previous sentence, that sentence's real onset is later than the estimate, so go back to layer 2 and calibrate.

Also note that "it feels out of sync" is often a **design-level misplacement** rather than algorithmic error: a big number / hero image must be attached to the stage of **the sentence that mentions it** (see the strong-sync principle in authoring.md); draw the first sentence's highlight inside stage 2 and no matter how accurate the algorithm is, the audience feels the disconnect.

## Whitespace tuning

Whitespace = each slide's `tail` (narration end to slide change). Default **0.8s**: below 0.5s the audience feels chased, above 1.5s it is "finished speaking, staring blankly".

- Tight overall pacing (fast-consumption style): add `"tail": 0.4` to each slide in script.json.
- Unhurried delivery (brand film): `"tail": 1.2`, with 1.5 for the first and last slides.
- Per-slide tweak: change only that slide's `tail` and re-run plan-timings; no need to redo TTS.

Speech rate: **1.1** overall (≈5.3 Chinese chars/sec; ≈4.8 at 1.0); the first and last slides at 1.05 are slightly slower for a sense of ceremony. **This must be asked of the user together with the voice during the audition step** (see below); don't just decide it yourself and move on. If plan-timings warns that the speech rate deviates from 3–6.5 chars/s, first check whether speed is set wrong or the character count exceeds the limit — don't rush to re-estimate with --pacing.

⚠ **Measured gotcha: `speed<1` (e.g. 0.95) on short sentences (≤10 chars) may increase rather than decrease the duration** — the TTS engine appears to pad silence on short sentences, making the duration longer instead (found in end-to-end measurement on 2026-09-17). So: if you want 0.95 for the first/last slides, don't make that slide's narration too short; or just keep short sentences at 1.0.

⚠ **Precondition for stage timing**: entrance delays rely on the `--fx-delay` mechanism (see authoring.md for the implementation principle). If the page uses an old tokens.css (one that writes delays as a separate `animation-delay: var(--tN)`), the delay is overridden by the `.fx-*` shorthands, showing up as "some elements enter at 0s" — this affects the feel more than estimation error (usually <0.3s) does, so rule it out first when troubleshooting audio-visual desync.

## TTS commands in the mcode environment

Single synthesis / batch synthesis (≤10 per batch):

```bash
mcode-tools connector call connector__matrix__batch_text_to_audio --args '{"requests": [
  {"text": "第一句口播。", "voice_id": "Chinese (Mandarin)_Gentleman", "speed": 1.1, "output_file": "01.mp3"},
  {"text": "……", "voice_id": "…", "speed": 1.05, "output_file": "08.mp3"}
]}'
```

Take `success_items[].node_id` from the result and fetch each download link to disk under `audio/`:

```bash
mcode-tools get_asset_url <node_id>   # 得到 URL 后 curl 下载为 audio/<id>.mp3
```

Look up voice candidates with `connector__matrix__get_voice_list`; when aligning at kickoff, first ask the user about the **voice direction (gender + timbre: warm male / crisp female / neutral, magnetic, lively)** — a rough direction is enough, the audition fixes the rest.

**⚠ One audition, two questions (1.6.0): pitch AND pace.** The audition must ask the user *both* which voice to use *and* whether the pace is right — the pace is the complaint users actually report ("the default is a bit slow"), and it cannot be judged from written settings. So besides the three candidate voices, synthesize **the same probe line in the chosen voice at three speeds (1.05 / 1.15 / 1.25)** and hand over all of them with the list. After the user answers, write the decision into `script.json` (`speed.default` = the chosen one, first/last slides 1.05) and restate "voice = X / speed = Y" before moving on. `plan-timings` then checks the measured rate against that value and warns if the two disagree.

**⚠ Voice names are not trustworthy, the audition must verify the voice with ASR (2026-09 measured lesson)**: platform labels get mismatched — `Chinese (Mandarin)_News_Anchor` is labeled a Mandarin news female voice but actually generates **Cantonese** (ASR transcripts show traditional characters such as "來自/從"). Picking a voice by name alone = picking blind. The correct flow:

1. Take 3 candidate voices, each synthesizing one fixed probe line as a single TTS call (containing numbers and proper nouns, e.g. "三家科技公司,去年营收三点五亿美元。") — generate them **individually**, to avoid batch pairing mismatches (the three speed variants are also single calls);
2. Transcribe and verify each part (on mcode use `listen_audio`; in other environments `node scripts/asr.mjs --file probe.mp3 --language zh`), checking: the transcript is **Simplified** Mandarin (traditional characters appearing = Cantonese/another language, discard), numbers read correctly, no obvious swallowed characters;
3. Annotate the "measured language" and the speed of each sample into the audition list, hand the audio to the user, and ask the two questions together: **"① which voice? ② which pace — 1.05 / 1.15 / 1.25 (or none of them, give me a direction)"** (this step is in Phase 1, don't skip it).

**Trick to force Mandarin**: pass the `language: zh` header in the call (the script's `--language zh`) and the model decodes as Mandarin; if traditional characters still appear in the result (e.g. 來/從/聲/畫), you can basically conclude that this voice actually outputs Cantonese. To confirm Cantonese in the opposite direction, use `--language yue`.

Measured usable Mandarin voices (2026-09-17, mcode matrix):

| voice_id | label name | measured |
|---|---|---|
| `Chinese (Mandarin)_Gentle_Senior` | 温柔学姐 (gentle senior) | ✅ Mandarin, crisp |
| `Chinese (Mandarin)_Sweet_Lady` | 甜美女声 (sweet female voice) | ✅ Mandarin, friendly (**the primary choice in the 2026-09-17 measurement**) |
| `Chinese (Mandarin)_Crisp_Girl` | 清脆少女 (crisp young girl) | ✅ Mandarin, clear |
| `Chinese (Mandarin)_Mature_Woman` | 傲娇御姐 (tsundere mature sister) | ✅ Mandarin, storytelling feel |
| `Chinese (Mandarin)_Wise_Women` | 阅历姐姐 (worldly-wise sister) | ✅ Mandarin |
| `Chinese (Mandarin)_Male_Announcer` | 播报男声 (announcer male voice) | ✅ Mandarin (usable) |

| voice_id | label name | measured |
|---|---|---|
| `Chinese (Mandarin)_News_Anchor` | 新闻女声 (news female voice) | ❌ actually outputs **Cantonese**, do not use |

(The voice library drifts, so this table is only a starting point; every new project still goes through the three-step ASR voice verification above.)

## Language and voice (must ask at kickoff alignment)

**The narration language is fixed at kickoff alignment**, written into `script.json`'s `lang` (default `zh`). It drives four things:

1. **What language the narration script** is written in (`clauses[].text`); when bilingual, `text2` holds the **other language** (main line = narration language).
2. **The voice must match the language** — Chinese uses `Chinese (Mandarin)_*`, English uses `English_*`, Cantonese uses the corresponding Cantonese voices. A mismatch shows up as "accented / mispronounced / language drift", and must be verified with ASR once written.
3. **Character-count and speech-rate baselines**: `plan-timings` switches automatically by `lang` — Chinese 5.3 chars/s @speed 1.1 (4.8 at 1.0; typically 3–6.5), English ~14 chars/s (typically 9–18, about 150 words/min); the single-line subtitle limit is 18 chars for Chinese / 42 characters for English.
4. **The ASR language header**: `asr.mjs` reads `lang` and automatically passes `language: zh|en|yue`. Chinese projects check "whether traditional characters show up" (= Cantonese), English projects check "whether Chinese characters are mixed in".

**Changing language takes only three steps**: change `script.json`'s `lang` → swap in a matching `voice_id` and redo TTS → if bilingual, add/replace `text2` for each sentence. Neither the layout nor the script logic needs to change.

English voice examples (both mcode and mmx-cli track platform updates, so measured results are authoritative):

```bash
# mcode: 列全部音色后挑 English_* 前缀的
mcode-tools connector call connector__matrix__get_voice_list --args '{}'
# mmx-cli: 同样先列再选
mmx speech voices
# mmx-cli 示例(官方文档中出现过的英语男声)
mmx speech synthesize --text "Three companies, three point five billion dollars." --voice English_magnetic_voiced_man --speed 1.1 --out audio/probe.mp3
```

Voice verification must also carry the language header: `--language en` (English) / `--language zh` (Mandarin) / `--language yue` (Cantonese).



## BGM (optional, off by default)

Configure once and it beds the whole video automatically: add `"bgm": "assets/bgm.mp3"` at the top level of script.json (or the object form `{file, volume, fadeIn, fadeOut}`). build-video will: loop it to fill the whole video, fade in over 1.5s, fade out over 2.5s at the tail, and hold it under the voice per `volume` (default **0.12**, i.e. -18.4dB); if mixing fails it automatically falls back to voice only and warns. **ASR verification always switches to the voice-only track**, so BGM doesn't interfere with transcription.

- Volume calibration: 0.08 (very restrained, storytelling) ~ 0.15 (lively, fast-consumption); the listening standard = every word of the voice is clear, and listening to the audio track alone with the picture off is effortless. Watch Gate 5 during final-video acceptance.
- BGM sources: ① `connector__matrix__batch_text_to_music` (generated on the mcode platform, ≤5 per batch, no copyright risk, the first choice); ② music the user provides (licensing must be confirmed, registered in assets/MANIFEST.md). Don't rip music off video sites. **⚠ mmx-cli has no music generation command**, so non-mcode environments can only use ② (or skip BGM).
- Generation advice: pick the style per subject matter (tech / warm / light), and **require "no vocals, no strong melodic hook, loopable"**; put the resulting file at `assets/bgm.mp3`, and listen to it once on its own to confirm there are no jarring section changes (the loop point must be clean).
- Requires ffmpeg ≥ 4.4 (amix's normalize option); older versions automatically skip BGM rather than erroring out.

## Bilingual subtitles (optional)

Adding `text2` to a clause in script.json takes effect automatically: the on-screen subtitles become two lines (Chinese main line + second line in a smaller size), and `out/subs.srt` becomes two lines in sync. No HTML changes and no extra parameters needed.

- `text2` rules: it is the translation of the same sentence, **do not reorder the words**; second line ≤60 characters (plan-timings warns when exceeded); use the target language's punctuation conventions.
- Doing only some sentences is also fine (each sentence is independent); before delivery confirm the language pairing of the bilingual subtitles (ask clearly at Gate 1 alignment whether it is "Chinese-English" or something else).

**Retry discipline for partial failures**: the upstream is very sensitive to resending an entire failed batch (rate limit). After a failure, sleep 10–30s and **retry only the failed entries** (pick the failures out of requests and form a small new batch); don't resend the whole batch.

Immediately after TTS is written to disk:

```bash
node scripts/plan-timings.mjs <项目目录>
```

Give the user the output duration table and warnings together for Gate 2. If a slide gets a speech-rate warning at this point, prefer changing the narration word count (back to Phase 1) or adjusting that slide's speed and redoing that segment — don't move on with warnings left standing.

## ASR reverse verification flow

build-video `--asr` cuts `asr/part-<id>-<k>.mp3` **by sentence** (sentence k of slide id) and generates `checklist.md`. Pick either path:

**Path A · mcode sandbox**
1. `mcode-tools upload_temp_url asr/part-01-1.mp3` to get a public URL.
2. `mcode-tools connector call connector__matrix__listen_audio --args '{"audio_info": {"url": "<URL>"}}'`.
3. Compare the transcript against the "expected narration" in the checklist: numbers, years and product names must match exactly; homophone/punctuation differences are acceptable.

**Path B · direct REST (any environment, the same single API Key; mmx-cli has no ASR subcommand)**

```bash
export MINIMAX_API_KEY=sk-xxx          # 与 mmx-cli 同一把; 海外套餐加 MINIMAX_REGION=global
node scripts/asr.mjs <项目目录>          # 逐句转写 → 自动比对 → 回填 asr/checklist.md
```

- The script performs the **comparison verdict** automatically: numbers mismatched, or traditional characters appearing (suspected Cantonese) → ✗ and the process exits non-zero; low similarity → ⚠ pending review.
- If the audio exceeds the API limits (>500s or >50MB) it is automatically transcoded with ffmpeg to mono 16k mp3 before upload; no manual handling needed.
- If you already have transcripts (e.g. produced with whisper in another environment) you can feed them straight in for comparison: `node scripts/asr.mjs <项目> --from transcripts.json` (JSON shaped like `{"part-01-1": "文本"}`).
- If you want **word-level timestamps to measure each sentence's onset** (more accurate than silence detection; the API supports `timestamp_level: word`): `node scripts/asr.mjs <项目> --verify-timing`, which outputs an "estimate vs ASR-measured" comparison table; if the deviation is large, adjust `clauses[].start` in `timings.json` per the results and re-render.

For slides that don't pass: change the narration or redo that segment's TTS → re-run plan-timings → delete `build/frames/<id>/` and `out/slide-<id>.mp4` → re-run capture (that slide) and build-video. Don't redo the whole video.
