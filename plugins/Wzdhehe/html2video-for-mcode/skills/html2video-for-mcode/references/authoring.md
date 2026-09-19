# HTML Design and Content Volume Guidelines

## Core principle: every slide is "one claim + one set of elaboration"

The two most common failures in a finished video can both be stopped at the authoring stage:

1. **A title with no elaboration** —— the audience watches one big line for 7 seconds; the information content is zero.
2. **All the text dumped onto the screen at once** —— no rhythm; by the time the voiceover reaches the second half of the clause, the visuals have long since run out of anything to say.

The fix is a mandatory three-layer structure: **title layer + elaboration layer + visual anchor (optional), with the three layers on different stages**. The voiceover and the frame are two voices of the same sentence.

**The entrance order of the layers is not fixed —— the narrative decides it; title-first is only the default.** The criterion is the strong-sync principle: whichever layer a given voiceover clause mentions is the stage that layer hangs on. Entirely legal variants:

- **Big number in first, title out later** (the default shape of stat-highlight): the first voiceover clause slams the number; number at s1, explanation and title at s2;
- **Question out first, answer next**: question in large type s1 → answer/data s2 → title gathers it up s3;
- **Image in first, text lands after**: main image s1 → keyword annotation s2 (common for image-led subjects).

What must always be blocked is never "the title does not come first", but **only one layer**: the whole slide stops on the title/a single block of content, with no second information layer pushing it forward.

## Content volume table (hard rules)

Chinese voiceover ≈ 5.3 chars/sec (speed 1.1; 4.8 at 1.0), target 6–10s per slide. **English at ~14 chars/sec (about 150 words/min)** —— the character counts in the table below are the Chinese measure; for English projects read them halved, in "words": 14–26 words per slide, hard ceiling 34 words (plan-timings switches the baseline and the warning band automatically by `lang`).

| Layout | Purpose | Required on the frame (any one missing is a violation) | Voiceover length | clauses structure |
|---|---|---|---|---|
| title-hero | Opening claim | Large title + one subtitle line + logo/theme corner mark | 12–20 | 1 sentence |
| statement | Single-point assertion | Assertion in large type (s1) + supporting small type (s2) + visual anchor (s3 optional) | 18–28 | 2 sentences |
| bullets | Parallel points | Title (s1) + 3–4 points, each ≤14 chars (s2) | 25–40 | 2 sentences |
| compare | Before/after contrast | Title (s1) + left and right columns with ≥1 item each + divider (s2) | 22–35 | 2 sentences |
| data-viz | Data persuasion | Title (s1) + ≥2 number cards/charts (s2) | 25–40 | 2 sentences |
| code | Demonstrating a call | Title (s1) + code block ≥3 lines + highlighted comment (s2) | 25–40 | 2 sentences |
| quote | Quotation transition | Quotation in large type (s1) + attribution/title (s2) | 20–32 | 2 sentences |
| closing | Close | One closing line + logo/CTA | 12–20 | 1 sentence |

Decision rules (written for the executor, for self-check):

- Apart from title-hero/closing, **the frame carries ≥2 visual blocks on different stages**; "just a title + page number" is sent straight back. **The order of the layers is free** (the number may precede the title, the question may precede the answer); what is wrong is "only one layer", not "the title is not at s1".
- **Strong-sync principle (a lesson measured in 2026-09): the visual anchor of each stage (big number/keyword/main image) must be written into the voiceover clause that triggers it, never left in the previous clause.** Counter-example: the very first voiceover clause is "三亿人在用" ("three hundred million people use it"), but the "3 亿" number card hangs on stage 2 —— when the audience hears "三亿" the frame does not react, and by the time the number card enters, the voiceover has already moved to the next clause; what the viewer feels is "the animation does not line up". Correct example: the first clause only sets up ("它有三个你可能用过的产品" — "it has three products you have probably used"), "3 亿" opens the second clause, and the number card hangs on stage 2 → sound and picture slam "3 亿" down together, strong sync.
- The mapping between voiceover clauses and stages: **the visuals of stage k enter the moment clause k starts speaking**. Number of stages ≈ number of clauses; any extra visual layers get explicit times via `stageTimes` in script.json.
- Hard ceiling of 60 characters of voiceover for a single slide; over that means the slide is doing the work of two, so split it. In subtitle scenarios, keep a single sentence to ≤18 characters (capture burns subtitles as a single displayed line); when bilingual, the second line (text2) is ≤60 characters.
- Numbers and proper nouns are read in Chinese in the voiceover ("九亿", not "900000000"), and only the frame shows Arabic numerals. (English projects are the opposite: the voiceover writes the English reading "nine hundred million" and the frame shows 900M.)
- Bilingual subtitles (optional): supplying `text2` for each clause automatically produces two lines (main line in Chinese + second line in a smaller size); text2 is the translation of the same clause, so do not reorder the wording.

## The staged entrance system (how to write the HTML)

tokens.css already ships this built in, and there are only four rules:

1. A block that should enter: `data-stage="1|2|3"` + an fx utility class (`fx-up/fx-fade/fx-grow/fx-draw`).
2. **Write no delay in seconds at all**. `--t1/--t2/--t3` are injected by the render pipeline from measured TTS durations; opening the file directly in a browser uses the placeholder defaults in tokens (0/0.8/2.0s).
3. Staggering within the same layer (e.g. three bullets appearing one after another): inline `style="animation-delay:calc(var(--t2) + 150ms)"`, +300ms for the second block, and so on.
4. Ambient animations (`fx-pulse` and other infinite loops) may only be decorative (glows, breathing dots); **give them no data-stage and let them carry no information** —— they take no part in duration calculation and may be frozen at an arbitrary phase in a still frame.

Prohibitions: no transition for entrance effects (the pipeline cannot seek to a transition state frame by frame); no orchestrating with JS timers (setTimeout-driven layering never happens in frame-stepping mode); no external Google Fonts for type (they render as plain boxes offline) —— use the system font stack in tokens.css.

### Three hard checks when writing HTML (run `node <skill>/scripts/check-slides.mjs <project>` the moment you finish)

All three are silent failures hit during 2026-09 testing —— the frame is visibly wrong, yet the pipeline reports success the whole way through:

1. **Variables must be defined first, or carry a fallback.** In `background: linear-gradient(135deg, var(--coral-a), var(--coral-b))`, if even one variable is undefined the whole declaration computes to `none`; and if that element also uses `-webkit-text-fill-color: transparent` (the standard way to write gradient numbers), **the text becomes completely invisible without raising any error**. This is easiest to hit when borrowing colours from another single-page HTML: the borrowed variable names (e.g. `--coral-*`) are not in tokens.css. Either add the definitions to the project tokens.css, or write `var(--coral-a, #ED3366)` to supply a default.
2. **Images use relative paths and the files must exist**; for `.svg` it is best to **inline it into the HTML**. Measured: under file://, `<img src="x.svg">` loads fine (400px), so a broken icon is usually not a protocol problem but the SVG itself: malformed XML, a dependency on external resources/web fonts, missing width/height, or a failed download saved as HTML. Inlining solves all of it at once.
3. **Do not copy an external single page's colours/variables over wholesale.** Copying the layout structure is fine, but colours must land on tokens variables (`--accent` / `--good` / `--grad` …); hard-coded hex/rgb bleeds through when you switch theme.

## Theme and visual tone

`<html data-theme="...">`:

- **a · off-white + warm orange** (default, general business): bg `#FAFAF7`, accent `#FF5B2E`, serif large titles. Narrative, opinion, people-oriented.
- **b · dark + green** (tech feel): bg `#0E0F12`, accent `#10A37F`, high-contrast data. Product, AI, developer-oriented.
- **c · black-and-white + blue** (minimal and premium): bg `#FFFFFF`, accent `#1F6FEB`. Finance, reports, serious material.

Type discipline: at most two levels on screen at once per slide (title + one secondary); body text ≥30px —— anything smaller is inviting a reviewer's complaint. Safe margin: content ≥96px from the edge (except brand/slide-num).

⚠ **Subtitle safe area (at 1080 height)**: the subtitle pill occupies **the bottom 84–168px, centred, about 73% wide** (40px type + 12px padding top and bottom, 7.8% from the bottom); **do not put body text, values, charts or figure captions in this band** —— otherwise the subtitles land directly on top of the content in the finished video and neither can be read (caught by visual acceptance on 2026-09-18: an example page had its figure caption at the bottom and the subtitle covered it, producing "ghosted text"). The fix: start from `padding-bottom: 190px` on the layout container and keep only brand/slide-num at the bottom. **Portrait (1080×1920)**: the same formulas computed against the canvas —— ≈149px from the bottom (7.8% × 1920), type squeezed to 30px by `--sub-scale`, the pill band at roughly **150–215px from the bottom and about 787px wide centred**; start from `padding-bottom: 240px` on the layout container, and since subtitle lines are narrower, keep the per-sentence character count tighter than in landscape.

## Asset acquisition (Phase 3 · Gate 3)

Process: list the requirements (which slides need images, and what) → source by the priority order below → compliance self-check → write to disk under `assets/` and register in `MANIFEST.md` → **present Gate 3 to the user**.

**Sourcing priority (step down level by level, never force it):**

1. **Official channels (first choice)**: logos from the official brand kit or simple-icons (curl-able); product screenshots taken from official help/docs; data from official reports. Strongest compliance; for factual subjects try to stop at this level.
2. **Extract from the official site with a built-in browser / Playwright (measured and recommended, 2026-09)**: open the official site or official news page with the agent's built-in browser or Playwright, inspect the DOM and extract `<img>`/`<source>` assets (verify the src is an official CDN domain, then write to disk with `fetch-official-images.mjs --url <URL> --out-dir assets` —— the same host/size/filename validation set). Measured on Chinese AI-company subjects: 6/6 all relevant, far better than image-search engines. If the user chose "official assets only / pure layout" during kickoff alignment, skip this whole level.
3. **Pure-layout fallback (the fallback that is always available)**: large type + number cards + colour + the expressive power of the layout itself. Better to omit than to fake —— when no suitable asset exists, use this level; the frame still holds up.

> ⚠ **image-downloader (Bing image search) is off by default.** Measured 2026-09-17: for Chinese AI-company subjects, 5/5 keywords returned entirely irrelevant images (Bing returned "猜你喜欢" (recommended-for-you) cards and the script's regex swallowed the lot). Unless the subject is an English-language mass-market brand and you are willing to filter every image by hand, do not take this route.

**Compliance self-check (run through it for every asset):**

- No watermarks. For a watermarked candidate: use a different image, or crop inside the watermark; if you cannot crop it out, do not use it.
- Trademarks/logos are used only in the legitimate reference context of "talking about that brand", never as decorative filler.
- Photos must come from licensable sources (official press images, CC-licensed, free stock libraries); for celebrity/people photos with no verifiable licence, prefer a text-only quotation card.
- Screenshots state their source (official doc name + date).

**Registration and use:**

- `assets/MANIFEST.md` gets one line per asset: filename / content / source URL or channel / licence. Present Gate 3 to the user together with the asset previews and ask explicitly "are the sources and licences OK?".
- **Never generate logos, screenshots, avatars or QR codes out of thin air; never let a watermarked image into the assets.**
- **Images must be framed; never place a bare `<img>`**: use `.img-frame` (ratio and cropping belong to the frame) / `.img-frame.contain` (mandatory for screenshots, charts and images containing text; no cropping, centred with letterboxing) / `--img-ratio` (frame ratio; 16:9 is not required) / `--img-pos: top|center|bottom` (controls the visible part of the subject, **the preferred replacement for hard cropping**) / `.img-scrim` (darken to carry white text) / `.img-cap` (figure caption, written outside the frame) / `.img-tag` (corner tag). The full SOP for choosing and cropping images is in `references/image-sources.md`.
- Reference images in HTML with a relative path `../assets/xxx.png`; capture waits for images to finish loading (4s cap each, skipped if they do not load —— so assets must be local first; never link an external image).

## Layout snippets (copy-ready)

The snippets below build on tokens.css plus each slide's own `<style>` (layout skeletons such as `.layout/.cols/.cards/.num/.cap` are defined inline per slide and do not come from tokens.css); they list only the structure inside `<main>`; the outer `.stage`, `.brand`, `.slide-num` follow `_template.html`.

**bullets**
```html
<main class="layout">
  <h1 class="fx-up" data-stage="1">三大产品线</h1>
  <ul>
    <li class="fx-up" data-stage="2" style="animation-delay:calc(var(--t2))">ChatGPT — 对话</li>
    <li class="fx-up" data-stage="2" style="animation-delay:calc(var(--t2) + 150ms)">GPT 系列 — 模型</li>
    <li class="fx-up" data-stage="2" style="animation-delay:calc(var(--t2) + 300ms)">Sora — 视频生成</li>
  </ul>
</main>
```

**compare**
```html
<main class="layout">
  <h1 class="fx-up" data-stage="1">三年,高中生 → 研究员</h1>
  <div class="cols">
    <div class="fx-grow" data-stage="2" style="animation-delay:calc(var(--t2))">
      <h2>2023 · GPT-3.5</h2><p>会聊天,常出错</p>
    </div>
    <div class="fx-grow" data-stage="2" style="animation-delay:calc(var(--t2) + 200ms)">
      <h2>今天 · GPT-5.6</h2><p>可托付研究级任务</p>
    </div>
  </div>
</main>
```

**data-viz**
```html
<main class="layout">
  <h1 class="fx-up" data-stage="1">九亿人每周在用</h1>
  <div class="cards">
    <div class="fx-grow" data-stage="2" style="animation-delay:calc(var(--t2))">
      <div class="num">9亿</div><div class="cap">周活跃用户</div>
    </div>
    <div class="fx-grow" data-stage="2" style="animation-delay:calc(var(--t2) + 180ms)">
      <div class="num">$25B</div><div class="cap">年化营收</div>
    </div>
    <div class="fx-grow" data-stage="2" style="animation-delay:calc(var(--t2) + 360ms)">
      <div class="num">92%</div><div class="cap">财富500强渗透</div>
    </div>
  </div>
</main>
```

**code**
```html
<main class="layout">
  <h1 class="fx-up" data-stage="1">一行调用</h1>
  <pre class="fx-fade" data-stage="2"><code>const answer = await openai.responses.create({
  model: "gpt-5.6",
  input: "帮我总结这份报告",
});
console.log(answer.output_text);</code></pre>
</main>
```

**quote**
```html
<main class="layout">
  <blockquote class="fx-up" data-stage="1">“我们想打造的是比人类更聪明的工具,而不是替代人类。”</blockquote>
  <p class="fx-fade" data-stage="2">— Sam Altman, OpenAI CEO</p>
</main>
```

**title-hero / closing**: large title centred + one line of subtitle/CTA, a single stage is enough; closing may add a logo with `fx-grow`.

Layout CSS (`.layout/.cols/.cards/.num/.cap` etc.) is defined inline in each slide's `<style>`; shared values (colours, type sizes, easing) must come from tokens variables and must never be hard-coded.

---

# Additional layouts (9 added 2026-09-17)

The original 8 layout names are unchanged (existing projects' `layout` values stay valid); the following are incremental options. **Do not use the same layout on two adjacent slides.**

| Layout | Purpose | Required on the frame (any one missing is a violation) | Voiceover length | clauses |
|---|---|---|---|---|
| kpi-grid | A set of metrics | Title (s1) + 3–4 metric cards with change and semantic colour (s2). **Use `var(--up)/var(--down)` for change; for A-share/HK audiences override to red-up/green-down (see compliance.md)** | 25–40 | 2 sentences |
| stat-highlight | One number decides everything | Huge number (≥200px, `.gradient-text` allowed) (s1) + one line of explanation (s2) | 15–28 | 2 sentences |
| table | Multi-row comparison | Title (s1) + ≥3-row data table with right-aligned values (s2). **Use the `.tbl` primitive; the five forms and disciplines are in "table toolkit"** | 25–40 | 2 sentences |
| timeline | Development history | Title (s1) + ≥4 time points (axis + labels) (s2) | 25–40 | 2 sentences |
| roadmap | Phase planning | Title (s1) + 3–4 columns (NOW/NEXT/LATER and the like) (s2) | 22–35 | 2 sentences |
| comparison | Before/after, pros/cons | Title (s1) + left and right columns with a vertical divider (s2) | 22–35 | 2 sentences |
| flow-diagram | Process / pipeline | Title (s1) + 3–5 nodes + arrows (s2) | 22–35 | 2 sentences |
| terminal | Command-line demo | Title (s1) + terminal window (traffic lights + ≥3 lines) (s2) | 25–40 | 2 sentences |
| big-quote | Large quotation transition | Quotation in large type (s1) + attribution (s2) | 20–32 | 2 sentences |

```html
<!-- kpi-grid: 指标卡 + 语义色涨跌(涨跌一律走 --up/--down, 财经题材按受众翻转这两个即可, 见 compliance.md)
     注意: 布局几何内联在容器 style 里, 不要用没定义过的 .grid/.g4 之类的类(会静默竖排) -->
<div class="fx-stagger" style="--stagger-base:var(--t2);display:grid;grid-template-columns:repeat(4,1fr);gap:var(--sp-4)">
  <div class="card"><p class="eyebrow">REVENUE</p>
    <div style="font-size:var(--fs-h2);font-family:var(--font-display)">1248K</div>
    <p style="color:var(--up)">↑ 38% YoY</p></div>
  <div class="card"><p class="eyebrow">RETENTION</p>
    <div style="font-size:var(--fs-h2);font-family:var(--font-display)">74%</div>
    <p style="color:var(--warn)">→ 持平</p></div>
  <div class="card"><p class="eyebrow">NPS</p>
    <div style="font-size:var(--fs-h2);font-family:var(--font-display)">62</div>
    <p style="color:var(--up)">↑ 9 pts</p></div>
  <div class="card"><p class="eyebrow">CHURN</p>
    <div style="font-size:var(--fs-h2);font-family:var(--font-display)">3.1%</div>
    <p style="color:var(--down)">↓ 0.4 pts</p></div>
</div>

<!-- 免责声明行: 受监管题材(财经/医疗/法律/政策)必出; 小字、不抢视觉、停留 ≥3s、口播不念 -->
<p class="disclaimer fx-fade" data-stage="2">
  本视频仅为信息分享,不构成任何投资建议。数据来源:公司 2026 年 Q2 财报(8 月披露),截至 2026-06-30。
</p>

<!-- stat-highlight: 单数字撑满视觉 -->
<div class="fx-pop" data-stage="1" style="font-size:220px;line-height:1;font-weight:900;letter-spacing:-.05em">
  <span class="gradient-text">92</span><span class="gradient-text">%</span>
</div>
<h3 class="fx-fade" data-stage="2" style="margin-top:var(--sp-3)">的准备工作被省掉</h3>

<!-- table: 数值右对齐, 行高要够(1080p 下 ≥72px) -->
<table class="fx-fade" data-stage="2" style="width:100%;border-collapse:collapse;font-size:var(--fs-caption)">
  <thead><tr style="color:var(--fg-3);text-align:left">
    <th style="padding:var(--sp-2) 0">季度</th>
    <th style="text-align:right">营收</th><th style="text-align:right">同比</th></tr></thead>
  <tbody>
    <tr style="border-top:1px solid var(--line)"><td style="padding:var(--sp-3) 0">Q1</td>
      <td style="text-align:right">3.2 亿</td><td style="text-align:right;color:var(--good)">+18%</td></tr>
    <tr style="border-top:1px solid var(--line)"><td style="padding:var(--sp-3) 0">Q2</td>
      <td style="text-align:right">4.1 亿</td><td style="text-align:right;color:var(--good)">+27%</td></tr>
  </tbody>
</table>

<!-- timeline: 横轴 + 时间点; 整轴 fx-fade, 每个时间点在容器 fx-stagger 里逐个上浮(口播点到哪个年份, 哪个冒出来) -->
<div class="fx-fade" data-stage="2" style="display:flex;gap:var(--sp-4);margin-top:var(--sp-5)">
  <div class="fx-stagger" style="--stagger-base:var(--t2);display:flex;gap:var(--sp-4);width:100%">
    <div style="flex:1;border-top:3px solid var(--accent);padding-top:var(--sp-3)">
      <p class="eyebrow">2021</p><p>成立</p></div>
    <div style="flex:1;border-top:3px solid var(--accent);padding-top:var(--sp-3)">
      <p class="eyebrow">2023</p><p>首个产品</p></div>
    <div style="flex:1;border-top:3px solid var(--accent);padding-top:var(--sp-3)">
      <p class="eyebrow">2026</p><p>上市</p></div>
  </div>
</div>

<!-- roadmap: NOW/NEXT/LATER 三列(阶段规划)。当前阶段用 .card-accent 突出; 4 列时 repeat(4,1fr) 并把要点字号压到 var(--fs-tiny) -->
<div class="fx-stagger" style="--stagger-base:var(--t2);display:grid;grid-template-columns:repeat(3,1fr);gap:var(--sp-4);margin-top:var(--sp-5)">
  <div class="card card-accent">
    <p class="eyebrow" style="color:var(--accent)">NOW · 2026 Q3</p>
    <p style="margin-top:var(--sp-2)">开放平台公测</p>
    <p style="margin-top:var(--sp-1);color:var(--muted)">长上下灰度放量</p>
  </div>
  <div class="card">
    <p class="eyebrow" style="color:var(--fg-3)">NEXT · Q4</p>
    <p style="margin-top:var(--sp-2)">多模态 API 定价</p>
    <p style="margin-top:var(--sp-1);color:var(--muted)">企业私有化版本</p>
  </div>
  <div class="card">
    <p class="eyebrow" style="color:var(--fg-3)">LATER · 2027</p>
    <p style="margin-top:var(--sp-2)">Agent 应用商店</p>
    <p style="margin-top:var(--sp-1);color:var(--muted)">海外节点</p>
  </div>
</div>

<!-- comparison: 左右两栏 + 竖分隔线 -->
<div style="display:grid;grid-template-columns:1fr 1px 1fr;gap:var(--sp-5);align-items:center">
  <div class="fx-grow" data-stage="2">
    <p class="eyebrow">三年前</p><h3>像高中生</h3><p style="color:var(--muted)">会聊天,常出错</p></div>
  <div style="background:var(--line);height:70%"></div>
  <div class="fx-grow" data-stage="2" style="animation-delay:calc(var(--t2) + 200ms)">
    <p class="eyebrow">今天</p><h3>像研究员</h3><p style="color:var(--muted)">可托付研究级任务</p></div>
</div>

<!-- flow-diagram: 节点 + 箭头(用 ▸ 字符, 不引 SVG) -->
<div class="fx-fade" data-stage="2" style="display:flex;align-items:center;gap:var(--sp-3);margin-top:var(--sp-5)">
  <div class="card card-soft">脚本</div><span class="accent" style="font-size:var(--fs-h3)">▸</span>
  <div class="card card-soft">声音</div><span class="accent" style="font-size:var(--fs-h3)">▸</span>
  <div class="card card-accent">成片</div>
</div>

<!-- terminal: 红黄绿灯头 + 等宽字体 -->
<div class="fx-fade" data-stage="2" style="background:#0d1117;border-radius:var(--radius);overflow:hidden">
  <div style="display:flex;gap:8px;padding:14px 18px;background:#161b22">
    <span style="width:14px;height:14px;border-radius:50%;background:#ff5f57"></span>
    <span style="width:14px;height:14px;border-radius:50%;background:#febc2e"></span>
    <span style="width:14px;height:14px;border-radius:50%;background:#28c840"></span>
  </div>
  <pre style="margin:0;padding:var(--sp-4);color:#c9d1d9;font-family:var(--font-mono);font-size:var(--fs-caption);line-height:1.6"><code>$ node build-video.mjs ./proj --asr
<span style="color:#7ee787">✓ 时长 62.27s / 解码零错</span></code></pre>
</div>

<!-- big-quote: 全幅引语, 衬线加大 -->
<blockquote class="fx-blur" data-stage="1"
  style="font-family:var(--font-display);font-size:var(--fs-h1);line-height:1.3;max-width:1500px">
  “我们想打造的是比人类更聪明的工具,<span class="accent">而不是替代人类</span>。”
</blockquote>
```

---

# Chart toolkit (how to draw data-viz)

Charts are **all hand-drawn**, and three bottom lines never change:

1. **No external chart libraries** (Chart.js / ECharts etc. via CDN): unreachable in the offline sandbox, a violation of the no-external-links iron rule, and canvas animation cannot be seeked frame by frame (it renders static/blank).
2. **The numbers must come from a measure already verified in research/notes.md** —— a chart "draws numbers that have been verified", it is not decoration; a measure you cannot draw (missing as-of point / mixed currencies) goes back to Phase 0 first.
3. **Never use AI-generated images as charts** (`image generate` is limited to abstract concept images): data graphics must be traceable to a source, and generated images cannot be audited.

The chart primitives and motion effects all live in `tokens.css` (`.chart*` plus `fx-grow-w/h · fx-sweep · fx-count · fx-dot`). **For existing projects run `node scripts/init-project.mjs <project> --upgrade-css` first to add them** (idempotent), otherwise the new recipes half-die silently: bars do not grow, rings do not sweep, numbers do not roll up.

## The nine disciplines of elegance (more important than adding effects)

1. **Same kind, same colour + one emphasis**: bars/columns in the same series get **the same colour**; the one to highlight uses `--accent` (the `.chart-bar` default) and the rest get `.dim` (automatically weakened into the same hue by `color-mix`). A rainbow bar chart is the most typical source of "amateur feel". **Do not use white text for the value on a dimmed bar** —— a translucent fill with white text cannot be read (measured: judged "unreadable" by visual acceptance); either rely on `.chart-bar.dim .chart-val` switching to ink automatically, or put the value outside the bar: `<span class="chart-val out chart-num">` (after the track, right-aligned, ink colour).
2. **Never put the number inside an element that gets scaled**: `fx-grow-x` uses `scaleX`, so a number inside the bar is **squashed horizontally** (measured); for bars with labels use `fx-grow-w` (animates `width`, no distortion). Always wrap values in `.chart-num` (monospace + `tabular-nums`) so multi-digit numbers do not jitter while rolling up.
3. **Have a baseline and fine gridlines**: a column chart takes its baseline from the bottom edge of `.chart-plot-cell` (columns must stay inside the plot container —— if a percentage height is computed against the whole column, anything exceeding the remaining space gets pushed back by `flex-shrink`, and **the column height no longer equals the value**; measured: 84% and 72% were drawn the same height) + the grid is drawn inside the plot area **and must be visible on the page** (use `--line-strong`; if the gridlines are too faint, or only show up where a column covers them, the reader cannot read the scale —— measured: judged fail), and the top edge line is the axis maximum. **For a column chart the target value is fine written in the note on the title line** —— drawing another dashed line at the top crowds the value label on the tallest column and gets read as a minus sign (measured: flagged as a defect); only track charts like bullet use the `.chart-target` vertical tick line. Horizontal bar charts give every track `.chart-track.grid` (shared 25/50/75% vertical ticks); the left edge of the track already carries the zero-axis vertical line. **Make the rows fixed-width using the three grid columns of `.chart-row` (label / track / value slot)** —— otherwise the track of a "row with an outside value" gets squeezed narrower, and one chart ends up with two different rulers and bar lengths that cannot be compared (measured: caught by visual acceptance). Axis labels use `--fs-tiny` + `--fg-3`. Most of a chart's refinement comes from these "invisible lines".
4. **One chart tells one thing**: use `.chart-note` to write that sentence on the right of the title line ("同比 +38%" = YoY +38%, "距目标 0.2pp" = 0.2pp from target); do not make the audience do the arithmetic.
5. **Give zero and tiny values a floor**: add `min-height:4px` to `.chart-bar` (or let the `.chart-target` dashed line catch it), otherwise "0" looks like "no data".
6. **The figure caption states the measure and the as-of date** (`.chart-cap`): mandatory for regulated subjects (see compliance.md), and recommended for other subjects too —— the credibility of a number comes from "when and how it was calculated".
7. **Pin the title to the same position at the top of the safe area and centre the chart block in the remaining space**: the chart block should occupy the safe area (about 825px usable at 1080 height); do it by keeping a fixed top margin before the `h1`, using `.layout{display:flex;flex-direction:column}` and wrapping the chart block in a layer with `flex:1;display:flex;align-items:center` —— that way the title sits at the same y on every page (the title does not jump when the video plays through) while the chart is centred in the leftover space (measured: titles 170px apart across two pages was judged fail). Bar spacing/height can be enlarged (use `--bar-h` for bar height; 56–64px looks better). A packed top half and a large empty bottom half reads as "the whole page is unbalanced" in the finished video (measured twice by visual acceptance).
8. **Align values into a single column**: every value in a chart is right-aligned in the same column (all using `.chart-val.out`); white text inside a bar is only for the case where "there is exactly one emphasis bar and it is not side by side with other rows", otherwise the four values split into two columns and the misalignment is obvious at a glance (visual acceptance measurement).
9. **Column height must be computed from the value, and the axis starts at 0**: writing `height:58%` by feel makes the column height out of proportion to the labelled number —— this is not an aesthetic issue, it is **data distortion** (truncating the vertical axis is the same class of error). Do it this way: fix the axis maximum first (e.g. 4.0%), column height = value ÷ axis maximum (3.1/4.0 = 77.5%), write the axis maximum into the title or the note ("axis 0–4.0%"), and mark the tick values on the left with `.chart-ticks` —— writing only "axis 0–4.0%" with no ticks at all leaves the audience unable to verify the column heights (measured: flagged as a defect). Visual acceptance measurement: the drawing of three columns did not match their labels and was judged fail outright.

Everything else is as before: colours go through tokens (up/down `var(--up)/var(--down)`, flipped by audience for financial subjects), grid `var(--line)`, values `var(--fg)`, legend `--muted`. **Motion is part of the chart**, and **the whole set switches off with one flag** (see "Motion switches").

## Choosing motion effects (frame-by-frame seek determinism unchanged, still pure @keyframes)

| Graphic | Which one | Why |
|---|---|---|
| Bar (with label) | `fx-grow-w` + inline `--w:86%` | animates `width`, the number is not squashed |
| Bar (flat colour block) | `fx-grow-x` | transform is cheaper, and there is no text anyway |
| Column (label outside) | `fx-grow-y` | the label is a sibling node, unaffected by scaling |
| Column (label inside) | `fx-grow-h` + inline `--h:70%` | as above, avoids squashing the number |
| Line | `fx-draw` (set `stroke-dasharray:800` on the element) + `fx-dot` for the points | stroke drawing is inherently seekable; data points pop in one by one |
| Donut / gauge | `fx-sweep` + inline `--p-to:62` | the conic gradient recomputes frame by frame from the registered property, so it **really sweeps** (no need for a hard `fx-pop`) |
| Big number | `fx-count` + inline `--n-to:924` | pure CSS counter roll-up; **integers only** (for decimals split the fields or keep it static) |

Staggering is always `--fx-delay:calc(var(--t2) + N×120ms)` (120–150ms between data bars looks best; past 200ms the audience starts waiting).

## Recipes

```html
<!-- ① 横向条形图(排名/对比首选): 标签在条外, 数值统一右对齐到同一列(都用 .chart-val.out); 关键一条用默认色, 其余 .dim;
     行宽 = 数值 ÷ 轴上限(这里轴上限 ≈ 2.16 亿 = 1.86/0.86, 所以 1.17→54%、0.67→31%、0.22→10.2%), 别凭手感写百分比;
     一句话用 .chart-note 挂在标题行; 图注写口径+时点 -->
<div class="chart" style="margin-top:var(--sp-5)">
  <div class="chart-head">
    <span class="chart-title">2026 Q2 各产品线营收</span>
    <span class="chart-note">A 产品同比 +38%</span>
  </div>
  <div class="chart-row">
    <span class="chart-lbl">产品 A</span>
    <div class="chart-track">
      <div class="chart-bar fx-grow-w" data-stage="2" style="--w:86%"><span class="chart-val chart-num">1.86 亿</span></div>
    </div>
  </div>
  <div class="chart-row">
    <span class="chart-lbl">产品 B</span>
    <div class="chart-track grid">
      <div class="chart-bar dim fx-grow-w" data-stage="2" style="--w:54%;--fx-delay:calc(var(--t2) + 120ms)"></div>
    </div>
    <span class="chart-val out chart-num fx-fade" data-stage="2" style="--fx-delay:calc(var(--t2) + 120ms)">1.17 亿</span>
  </div>
  <p class="chart-cap">口径: 集团合并报表 · 单位: 人民币 · 截至 2026-06-30</p>
</div>

<!-- ② 柱状图(≤5 个时点): .chart-plot.grid 给细网格, 数值放柱外, 逐个错峰 -->
<div class="chart" style="margin-top:var(--sp-5)">
  <!-- 柱高 = 数值 ÷ 轴上限, 轴必须从 0 起: 3.1/3.5/3.8 对 4.0% 轴 → 77.5% / 87.5% / 95%。
       把轴上限写进标题或 note, 别让读者猜比例尺(凭手感写百分比 = 数据失真) -->
  <div class="chart-head"><span class="chart-title">付费转化率 · 周(轴 0–4.0%)</span><span class="chart-note">目标 4.0%</span></div>
  <div style="display:flex;gap:var(--sp-3);align-items:flex-start">
    <div class="chart-ticks" style="--cols-h:300px"><span>4%</span><span>3%</span><span>2%</span><span>1%</span><span>0</span></div>
  <div class="chart-cols" style="--cols-h:300px">
    <div class="chart-col">
      <div class="chart-plot-cell grid">
        <div class="chart-bar-wrap" style="height:77.5%">
          <span class="chart-val chart-num fx-fade" data-stage="2">3.1%</span>
          <div class="chart-bar dim fx-grow-y" data-stage="2"></div>
        </div>
      </div>
      <span class="chart-lbl fx-fade" data-stage="2">W08</span>
    </div>
    <div class="chart-col">
      <div class="chart-plot-cell grid">
        <div class="chart-bar-wrap" style="height:87.5%">
          <span class="chart-val chart-num fx-fade" data-stage="2" style="--fx-delay:calc(var(--t2) + 120ms)">3.5%</span>
          <div class="chart-bar dim fx-grow-y" data-stage="2" style="--fx-delay:calc(var(--t2) + 120ms)"></div>
        </div>
      </div>
      <span class="chart-lbl fx-fade" data-stage="2" style="--fx-delay:calc(var(--t2) + 120ms)">W10</span>
    </div>
    <div class="chart-col">
      <div class="chart-plot-cell grid">
        <div class="chart-bar-wrap" style="height:95%">
          <span class="chart-val chart-num fx-fade" data-stage="2" style="--fx-delay:calc(var(--t2) + 240ms)">3.8%</span>
          <div class="chart-bar fx-grow-y" data-stage="2" style="--fx-delay:calc(var(--t2) + 240ms)"></div>
        </div>
      </div>
      <span class="chart-lbl fx-fade" data-stage="2" style="--fx-delay:calc(var(--t2) + 240ms)">W12</span>
    </div>
  </div>
  </div>
  <p class="chart-cap">口径: 注册后 7 日内付费 · 来源: 内部指标平台 · 截至 2026-08-15</p>
</div>

<!-- ③ 折线图(>5 个时点): inline SVG, 描边画入 + 数据点逐个弹出; 面积用同色低透明度渐变 -->
<svg class="fx-draw" data-stage="2" viewBox="0 0 900 380" style="width:100%;height:auto" fill="none">
  <defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/>
    <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
  </linearGradient></defs>
  <path d="M40,330 L215,290 L390,300 L565,180 L740,120 L875,88" stroke="var(--line)" stroke-width="1"/>
  <path d="M40,330 L215,290 L390,300 L565,180 L740,120 L875,88 L875,360 L40,360 Z" fill="url(#g1)"/>
  <polyline points="40,330 215,290 390,300 565,180 740,120 875,88"
    stroke="var(--accent)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="800"/>
  <g fill="var(--accent)">
    <circle class="fx-dot" data-stage="2" cx="565" cy="180" r="9" style="--fx-delay:calc(var(--t2) + 500ms)"/>
    <circle class="fx-dot" data-stage="2" cx="875" cy="88" r="9" style="--fx-delay:calc(var(--t2) + 800ms)"/>
  </g>
  <text x="875" y="60" text-anchor="end" fill="var(--fg)" font-size="26" class="chart-num">96.4</text>
</svg>
<!-- fx-draw 的 dasharray 要 ≥ 线长; 数据点用 fx-dot(自带轻微过冲弹入)。**标记规则要统一**: 要么每个点都标、要么只标末点(带数值);
     只给中间某个点标点、又没有对应数值, 视觉验收会读成"没标全"。
     ⚠ SVG 的 viewBox 宽高比要和容器一致, 否则 preserveAspectRatio 会把图形缩到中间一小块(实测: 半个版面里图形只占 40%);
     满宽用 width:100%;height:auto; 半宽/固定高就要把 viewBox 改成接近容器的比例, 别靠 height 硬压 -->

<!-- ④ 环形: fx-sweep 真扫出(--p-to = 目标百分比), 中心数字 fx-count 滚动(--n-to = 整数) -->
<div class="fx-sweep" data-stage="2" style="--p-to:62;position:relative;width:340px;height:340px;border-radius:50%;
     background:conic-gradient(var(--accent) 0 calc(var(--pv) * 1%), var(--panel-2) 0)">
  <div style="position:absolute;inset:52px;border-radius:50%;background:var(--bg);
              display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px">
    <span class="fx-count chart-num" data-stage="2" style="font-size:var(--fs-h1);--n-to:62"></span>
    <span style="color:var(--muted);font-size:var(--fs-tiny)">市场份额(%)</span>
  </div>
</div>
<!-- ⚠ 中心数字交给 fx-count 后不要再手写 "62"(计数器会自己填); 小数(62.4)不支持, 保持静态或拆两段。
     fx-count 在入场前是 opacity:0 —— 否则画面会停在"灰色的 0", 被读成"份额 0%/没数据"(视觉验收实测) -->

<!-- ⑤ bullet(实际 vs 目标, 汇报最实用): 一条轨道 + **目标竖刻度线**(标签贴刻度) + 实际条 + 条外数值
     ⚠ 目标标签别贴轨道右端 —— 会被读成"刻度在最右边"; 也别只给轨道加淡色分界, 看不见等于没有 -->
<div class="chart-row" style="margin-top:var(--sp-4)">
  <span class="chart-lbl">年度目标达成</span>
  <div class="chart-track" style="height:26px">
    <div class="chart-bar fx-grow-w" data-stage="2" style="--w:78%"></div>
    <div class="chart-target" style="left:88%"><span>目标 88%</span></div>
  </div>
  <span class="chart-val out chart-num fx-fade" data-stage="2">78%</span>
</div>

<!-- ⑥ slope(前后对比): 两列点 + 斜线, 比双柱更省版面; 主体用 --accent, 对照组用 --line-strong
     ⚠ 纵坐标按数值比例摆点, 而且**要单独画一条 0 基线**: 让对照组那条线兼任基线, 会出现"1M 画在 2M 之上"(实测被判 fail);
        "1M→2M 的间距"和"2M→10M 的间距"必须与数值差成比例, 否则"涨了 10 倍"在图上读不出来(实测被判 fail);
     对照组要如实画: 两年持平就画**水平线**, 并且**两端都标数值**, 标签别压在另一条线上 —— 只标一端、线却明显倾斜, 会被读成"数据不明/自相矛盾"(实测被视觉验收判 fail) -->
<svg class="fx-draw" data-stage="2" viewBox="0 0 720 320" style="width:100%;height:auto" fill="none">
  <text x="0" y="24" fill="var(--fg-3)" font-size="22">三年前</text>
  <text x="720" y="24" text-anchor="end" fill="var(--fg-3)" font-size="22">今天</text>
  <path d="M60,250 L660,90" stroke="var(--accent)" stroke-width="5" stroke-linecap="round" stroke-dasharray="800"/>
  <path d="M60,150 L660,200" stroke="var(--line-strong)" stroke-width="4" stroke-linecap="round" stroke-dasharray="800"/>
  <circle class="fx-dot" data-stage="2" cx="60" cy="250" r="10" fill="var(--accent)"/>
  <circle class="fx-dot" data-stage="2" cx="660" cy="90" r="10" fill="var(--accent)" style="--fx-delay:calc(var(--t2) + 600ms)"/>
  <circle class="fx-dot" data-stage="2" cx="60" cy="150" r="8" fill="var(--line-strong)"/>
  <circle class="fx-dot" data-stage="2" cx="660" cy="200" r="8" fill="var(--line-strong)" style="--fx-delay:calc(var(--t2) + 600ms)"/>
  <text x="60" y="288" fill="var(--fg)" font-size="24" class="chart-num">62</text>
  <text x="660" y="72" text-anchor="end" fill="var(--accent)" font-size="30" class="chart-num">92</text>
</svg>

<!-- ⑦ sparkline(数字旁的迷你趋势, 不占版面): 只有线, 无坐标轴, 用来暗示趋势 -->
<span style="display:inline-flex;align-items:center;gap:12px">
  <span class="chart-num" style="font-size:var(--fs-h2);color:var(--fg)">96.4</span>
  <svg class="fx-draw" data-stage="2" viewBox="0 0 160 48" style="width:160px;height:48px" fill="none">
    <polyline points="4,40 30,34 56,36 82,22 108,18 134,10 156,6"
      stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="300"/>
    <!-- 颜色跟主体走(--accent); 只有"涨/跌"本身是信息时才用 --up/--down。末端补个小圆点收口 -->
  </svg>
</span>
```

Quick selection guide: ranking/comparison → horizontal bars; time trend (≤5 points) → columns, (>5 points) → line; share (≤3 slices) → donut; actual vs target → bullet; before/after → slope; trend beside a number → sparkline. **Only one chart per slide** (if you place two, you must rank them or split the slide), and the figure caption is always required.

⚠ The whole chart block (including the figure caption) must land **above the subtitle safe area**: at 1080 height the bottom 84–168px is reserved for subtitles, so leave `padding-bottom: 190px` on the layout container.

---

# Table toolkit (the five forms of a data table)

Tables are the easiest thing to make ugly: not enough row height, numbers not right-aligned, change colours used wrongly, gridlines everywhere. The primitives all live in `tokens.css` (`.tbl / .kv / .matrix / .rank`); **for existing projects run `node scripts/init-project.mjs <project> --upgrade-css` first** (idempotent), otherwise none of these classes take effect.

## Table disciplines (seven)

1. **Body type size for the main data, row height ≥72px**: the body of `.tbl`/`.kv`/`.matrix`/`.rank` is already `var(--fs-body)` (readable on both 1080p and phones), and only the table header drops to `--fs-caption`; row height is built in at 72px —— do not shrink the type size or row height just to squeeze in one more row (measured: a 24px table is unreadable on a phone).
2. **One table per page, 6 rows maximum**: beyond that, split the page or keep only the top 5 + "others". A table page is naturally dense in information; squeeze it further and nobody reads it.
3. **Right-aligned values + monospace** (`.num`/`.val`): decimal-point alignment is the main source of "professional feel"; numbers use `tabular-nums` so they do not jitter when rolling or switching.
4. **Change colours go through tokens** (`.up`/`.down` → `var(--up)/var(--down)`): financial subjects flip them by audience (A-shares/HK: red up, green down), see compliance.md; and for non-financial subjects do not invent colours other than green/red.
5. **Horizontal rules only, no vertical rules, no zebra striping**: the header underline of `.tbl` plus thin lines between rows is enough; zebra stripes and a full grid make the frame dirty.
6. **Highlight exactly one row** (`.key`: accent vertical bar on the left + 8% background), usually "us / the current phase"; the total row uses `.sum` (thicker top border). Do not use either on several rows at once.
7. **The table caption states the measure and the as-of date** (the same `.chart-cap` treatment as charts): as with charts, the credibility of a number comes from "when and how it was calculated".

## The five forms and their recipes

```html
<!-- ① 数据表(最常用: 多期/多主体对比, 带涨跌) —— 表头弱化, 数值右对齐, 涨跌走令牌 -->
<table class="tbl fx-fade" data-stage="2">
  <thead><tr><th>季度</th><th class="num">营收</th><th class="num">同比</th><th class="num">毛利率</th></tr></thead>
  <tbody>
    <tr><td>2026 Q1</td><td class="num">3.2 亿</td><td class="num up">+18%</td><td class="num">61.4%</td></tr>
    <tr class="key"><td>2026 Q2</td><td class="num">4.1 亿</td><td class="num up">+27%</td><td class="num">63.8%</td></tr>
    <tr><td>2026 Q3</td><td class="num">3.9 亿</td><td class="num down">-4%</td><td class="num">62.1%</td></tr>
    <tr class="sum"><td>合计</td><td class="num">11.2 亿</td><td class="num up">+14%</td><td class="num">62.4%</td></tr>
  </tbody>
</table>
<p class="chart-cap">口径: 集团合并报表 · 单位: 人民币 · 截至 2026-09-30</p>

<!-- ② 规格表(.kv: 无表头, 左标签右值) —— 参数/条款/清单这类"一对一条目"用它, 比两列表格干净 -->
<table class="kv fx-fade" data-stage="2">
  <tr><td>上下文窗口</td><td>10,000,000 token</td></tr>
  <tr><td>单次最长输出</td><td>128,000 token</td></tr>
  <tr><td>定价(输入 / 输出)</td><td>¥0.8 / ¥2.4 每百万 token</td></tr>
  <tr><td>上线时间</td><td>2026-08-15</td></tr>
</table>

<!-- ③ 对比矩阵(.matrix: 行是维度、列是方案, 只放勾叉; .hi 高亮"我们"那一列, th/td 均可) -->
<table class="matrix fx-fade" data-stage="2">
  <thead><tr><th>能力</th><th>方案 A</th><th class="hi">方案 B(本方案)</th><th>方案 C</th></tr></thead>
  <tbody>
    <tr><td>离线可用</td><td class="no">✗</td><td class="hi yes">✓</td><td class="no">✗</td></tr>
    <tr><td>成本可控</td><td class="no">✗</td><td class="hi yes">✓</td><td class="yes">✓</td></tr>
    <tr><td>交付周期 ≤ 2 周</td><td class="yes">✓</td><td class="hi no">✗</td><td class="yes">✓</td></tr>
  </tbody>
</table>
<p class="chart-cap">口径: 内部评测 · 2026-09 · 勾叉按"是否满足该维度硬指标"判定</p>

<!-- ④ 排名表(.rank: 名次 + 微缩条 + 数值) —— 表格里嵌条形, 比纯数字一眼看出差距 -->
<table class="rank fx-fade" data-stage="2">
  <tr><td class="no">1</td><td>产品 A</td><td class="bar"><span class="fx-grow-w" data-stage="2" style="--w:100%"></span></td><td class="val">1.86 亿</td></tr>
  <tr><td class="no">2</td><td>产品 B</td><td class="bar"><span class="dim fx-grow-w" data-stage="2" style="--w:63%;--fx-delay:calc(var(--t2) + 120ms)"></span></td><td class="val">1.17 亿</td></tr>
  <tr><td class="no">3</td><td>产品 C</td><td class="bar"><span class="dim fx-grow-w" data-stage="2" style="--w:36%;--fx-delay:calc(var(--t2) + 240ms)"></span></td><td class="val">0.67 亿</td></tr>
</table>
<!-- 微缩条的宽度同样 = 数值 ÷ 轴上限(见"柱高必须由数值算出来"那条) -->

<!-- ⑤ 时间事件表(时间 × 事件两列) —— 比 timeline 版式更适合"事件多、要点长"的题材 -->
<table class="kv fx-fade" data-stage="2">
  <tr><td>2021</td><td>团队成立, 首个原型</td></tr>
  <tr><td>2023</td><td>产品上线, 首批 1 万用户</td></tr>
  <tr><td>2026 Q2</td><td>通过聆讯, 递交港股上市申请</td></tr>
</table>
```

Quick selection guide: multi-period/multi-entity comparison → ① data table; one-to-one entries → ② spec table (or ⑤ time-event table); ticking options across several plans → ③ comparison matrix; ranking to show the gap → ④ ranking table; totals/subtotals → ① + `.sum`; price/score tiers → ① with `.key` highlighting the current tier. **Do not put a table and a chart on the same page** (one thing per page); the voiceover for a table page must still "read the table" —— never treat the table as a backdrop.

## Motion switches (three granularities)

| Granularity | How | Effect |
|---|---|---|
| **Whole project** | `<html data-theme="..." class="no-fx">` (or `.stage.no-fx`) | all entrance/ambient motion off, elements go straight to their final state; motion capture detects no animation window and outputs static frames automatically, with duration and A/V sync unaffected; subtitles are still burned in |
| **Single slide** | add `no-fx` to that slide's root element (tokens.css rules match by descendant, so any container works) | only this slide has no motion, the rest behave normally |
| **Single element** | give it no fx class and no data-stage | that element renders statically |

When to use: you need a quick output under time pressure, the subject calls for restraint (government/legal/obituary material), or the user explicitly says "no animation". It can be put to the user as one of the kickoff alignment questions; the default is everything on.

**Chart motion is inside the switch range too**: with it off, bars/columns are directly at their final width, the donut is a complete sector, and numbers are at their final value (their static defaults are written as the final value, so no extra reset rules are needed).

**Verify before delivery**: on the screening page from `preview-page.mjs`, pressing `X` gives the "motion / motion off" comparison —— if it **goes blank** when switched off, some keyframes failed to lift `opacity:0` back; the two versions must look identical to be clean. Older projects (tokens.css generated before this rule) have no `no-fx` rules: run `node scripts/init-project.mjs <project dir> --upgrade-css` first (idempotent), otherwise `<html class="no-fx">` silently stops working and the page goes completely blank instead.

---

# Theme quick reference (audience → theme)

| Scenario | Theme |
|---|---|
| Business reporting / fundraising / earnings | `minimal-white` `swiss-grid` `corporate-clean` (plus the original `a`, off-white with warm orange) |
| Finance / investment research (regulated) | the same three (high data density, restrained colour); **once chosen, handle the disclaimer line and the change colours per `compliance.md` —— do not just pick a theme and start running** |
| Editorial / magazine / narrative | `editorial-serif` `magazine-bold` |
| Tech / AI / developer (dark) | `tokyo-night` `catppuccin-mocha` `nord` (plus the original `b`, dark tech green) |
| Consumer / Xiaohongshu / lifestyle | `xiaohongshu-white` `soft-pastel` (plus the original `c`, minimal blue, a general white-background option) |

Before settling on a theme, run `node <skill>/scripts/check-theme.mjs <project>`: it computes the contrast of every theme; do not use a theme that fails the gate (especially the subtitle pill contrast on dark themes).

## Custom accent colour (when the user supplies a brand colour)

A theme's accent colour is a token, so just override it —— append to the end of the **project's own** `slides/tokens.css` (edit the project copy, never the skill template):

```css
/* 品牌色覆写: 以 software 主题为底, 只换强调色三兄弟 */
[data-theme="minimal-white"] {
  --accent: #E8582A;          /* 品牌主色 */
  --accent-ink: #FFFFFF;      /* 压在主色上的文字色, 写完必须验 */
  --accent-2: #F08A5C;        /* 渐变/次级用色 */
  --accent-3: #B8431E;        /* 深色态 */
  --grad: linear-gradient(135deg, #E8582A, #F08A5C 55%, #B8431E);
}
```

**Hard requirement**: run `node <skill>/scripts/check-theme.mjs <project>` immediately after the change —— `--accent-ink` against `--accent` must be ≥3:1 (below 4.5:1 it may only be used for large type/graphics, never small text). For dark themes also take a quick look at whether `--sub-bg` (the subtitle pill) still separates from the background.

# Vertical canvas (1080×1920)

The `width/height` in `script.json` decides the canvas; the render pipeline injects `--stage-w/--stage-h` into the page and the subtitle geometry narrows with it automatically. **But the layout must be reflowed**: left/right columns that work in landscape get cramped in portrait, so switch to vertical stacking.

- Content margin goes from 96px to ~90px (portrait is narrower, so the usable area is smaller)
- Title size drops to the `--fs-h2` (44px) order of magnitude —— in portrait, 44px reads like ~78px in landscape
- Reduce the information per screen by one notch: 3 bullets in landscape → 2 in portrait
- Use `--img-ratio:3/4` or `1/1` for image frames; they fit portrait composition better than 16/9
- The subtitle position is decided automatically by `--stage-h`; no manual tuning needed

# ⚠ Must-know: how stage delay is implemented (read before changing anything)

The entrance delay is **not** a standalone `animation-delay: var(--tN)` declaration; it is written into the variable slot of the `animation` shorthand on `.fx-*`:

```css
[data-stage="2"] { --fx-delay: var(--t2); }                                    /* 只设变量 */
.fx-rise { animation: fx-rise .9s var(--ease-out) var(--fx-delay, 0ms) both; } /* 变量进 shorthand */
```

**Why**: `[data-stage="2"]` and `.fx-rise` both have (0,1,0) specificity; if you split this into two declarations, the `.fx-*` shorthand that appears later in the file resets `animation-delay` back to 0 —— every stage then enters at 0 seconds, while elements carrying an inline `calc(var(--t2)+150ms)` are still correct, producing a hard-to-diagnose failure where "some elements have weird timing and some are fine" (confirmed by measurement on 2026-09-17).

**Therefore**: ① do not hand-write `animation-delay: var(--tN)` (use `--fx-delay` or an inline calc instead); ② when defining a custom entrance animation, the delay slot must be written as `var(--fx-delay, 0ms)`; ③ to pin a container's base time, use `style="--stagger-base:var(--t3)"`.
