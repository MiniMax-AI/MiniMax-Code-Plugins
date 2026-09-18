# Image & Asset Sourcing SOP

> Source: distilled from end-to-end testing on 2026-09-17 (hard user requirement). The core principle in one sentence:
> **When an image is incomplete / cut off / badly proportioned, first search for one that shows the whole subject — do not force-crop it and do not force-use it.**

## 1. Image sourcing paths (by priority)

| Path | How | Use for | Tested |
|---|---|---|---|
| **A · Official channels** | Official brand kit / simple-icons (curl works); take product shots from official help/docs; use official reports for data | logos, product shots, data | ✅ Strongest compliance; for factual topics stay at this tier whenever possible |
| **B · Direct from the official site (highest success rate)** | `node <skill>/scripts/fetch-official-images.mjs <official-site-URL>` lists candidate images (including CSS background images and lazy-loaded ones) → pick indexes → `--get 1,3 --out-dir assets` to download. **When the site needs login / scroll-loading, or the script cannot open it, use the agent's built-in browser to inspect the DOM, grab the image URLs, then `--url <URL>[,<URL>...] --out-dir assets` to write them to disk** (the same host / redirect / size / filename validation, and no Playwright needed); the tool flags suspicious "off-site domain" assets, and can feed straight into `prep-image.mjs --check` | brand logos, product shots, hero images, CEO portraits, news images | ✅ tested on minimaxi.com, 6/6 all relevant |
| **C · Wikipedia Commons / CC** | Search historical figures, landmarks, public institutions | historical topics | ✅ download once, reuse forever; zero compliance risk |
| **D · Screenshots of announcements and authoritative coverage** | **Negative-event topics** (collapse / penalty / lawsuit / controversy): the official site will never carry this material, so A/B are guaranteed to fail — the correct source is **the primary carrier of the event itself**: exchange filings, regulatory documents, company official statements / apology letters > media coverage pages (Tier 3 media are acceptable from either region — international: Reuters, AP, Bloomberg, FT, WSJ, BBC, CNBC, The Verge; Chinese: Xinhua, CCTV, The Paper 澎湃, Caixin, Tencent News 腾讯新闻, Sina, NetEase — self-media excluded). Open with the built-in browser or Playwright and **screenshot** (command below) | collapse, regulatory penalty, lawsuit, scandal / controversy | ✅ reporting-based citation; the screenshot must keep the outlet name and date visible |
| ~~Legacy · Bing image search~~ | image-downloader skill | — | ❌ for niche Chinese-language topics 5/5 were irrelevant (anti-bot interstitial pages + "you may also like" recommendation cards), **off by default** |

**Discipline when inspecting with the built-in browser** (take this route when the site needs interaction or the script cannot open it):

1. **Once you have the image URL, do not "save as" or let the browser download it directly**: hand it to `--url` so it goes through the host allow-list / per-hop redirect re-check / 30MB cap / filename sanitisation / no-overwrite discipline.
2. **Do not treat "opening a new page" as a refresh**: in the host browser `navigate(replaceCurrentTab)` often opens a new tab (site data held in IDB will look like it "vanished into thin air"); to reload, use reload / F5.
3. **Batch actions belong in scripts, not on the browser's back**: clicking 15+ times in a row or bulk downloading triggers the site's human verification; leave image search / bulk download to the existing tools (see "Tier C" below).
4. **Take only assets on official domains**: before downloading, check whether the `src` found by inspect is on the official CDN; images from non-official domains are never used (compliance and copyright).

**On the legacy Bing route**: this skill ships **no** Bing crawler of its own (shipping one would mean shipping a known-failing path). If image-downloader happens to be installed, use it **only when** the topic is an English-language mainstream brand or a generic real-world scene and you are willing to hand-filter every image; for Chinese-language topics, niche companies and the China context, always take path B. **Do not write a throwaway crawler just to fetch an image** — start with the existing tools, and if they come up empty, fall back to pure layout.

**Screenshot discipline for Path D** (negative-event topics, news/announcement screenshots):

1. **Source tiering**: exchange filings / regulatory documents > company official statements (including apology letters and clarification announcements) > media coverage — **rank by primary-ness and editorial accountability, not by country**: Tier 1 primary documents (SEC EDGAR filings, HKEX / SSE / SZSE announcements, regulatory notices, FDA / FTC decisions) outrank Tier 2 company statements, which outrank Tier 3 mainstream media; and within Tier 3, international outlets (Reuters, AP, Bloomberg, FT, WSJ, BBC, CNBC, The Verge) and Chinese outlets (Xinhua, CCTV, The Paper 澎湃, Caixin, Tencent News 腾讯新闻, Sina, NetEase) are **equally qualified sources** — do not insist on a single "most authoritative" one. What is actually excluded is only self-media, aggregator accounts and content farms (unverifiable, often agenda-driven).
2. **Screenshots must retain verifiable information**: the outlet/institution name, the headline and the publication date must be inside the frame — a screenshot with the source information cropped out is unusable. Close cookie banners and recommendation feeds before shooting; capture the article body area only.
3. **Saving and logging**: store screenshots in `assets/`, and log one MANIFEST line per file: "content / source URL / publication date / licence (fair use for reporting)"; in the HTML use `.img-frame.contain` + `.img-cap` to state the source and date (e.g. "Image: XX News report · 2026-09").
4. **Negative financial topics are also bound by compliance.md**: still add the closing disclaimer line, give no trading advice in the narration and no price predictions; third-party logos / people appearing in screenshots follow the existing trademark / portrait rules.
5. Screenshot command (wait for lazy-loading, then capture the article body area; the same applies to the host's built-in browser screenshot):

```bash
node -e "const {chromium}=require('playwright');(async()=>{
  const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1280,height:900}});
  await p.goto(process.argv[1],{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(2500);                                   // wait for lazy-loading
  const art=(await p.$('article'))||(await p.$('main'))||await p.$('body');
  await art.screenshot({path:process.argv[2]});
  await b.close();})()" "https://news-site.example/article" assets/news-01.png
```

Abstract information (numbers, comparisons, quotes) **does not need an image**: use the layout itself (number card / big type / pull quote) as the information layer — the least effort and the most refined solution.

## 2. Filtering at the search stage (mandatory, before downloading)

**Query design**
- ✅ Add positive words: **panorama / full view / front-on / wide shot / official**
- ❌ Add exclusion words: **close-up / macro / corner of / half-cut**
- For people add `official portrait`; for products add `press photo` / `official`

**Glance over the thumbnails first, ask four questions:**
1. Is the subject centred and prominent? (subject hugging the edge → replace immediately)
2. Is the ratio close to 16:9? (target ratio first, avoid cropping)
3. Any watermark / unrelated logo / someone else's face?
4. Resolution ≥1200px? (anything that will look soft on screen is out)

**If one image does not fit, keep searching the next one — do not settle.**

## 3. Second check once you have the image (mandatory)

```bash
node <skill>/scripts/prep-image.mjs --check assets/xxx.png
```

It reports: dimensions, ratio, how much would be cut to reach 16:9, whether the resolution is too low, and a reminder that "if the subject is at the edge, replace the image first".

**How to judge subject position**: eyeball the thumbnail — which band is the subject in, **top / middle / bottom**? At the edge (y near 0 or h) → **drop this one and re-search**; in the middle but the ratio is off → a small crop is fine, or just use the frame's letterbox mode (see §4).

## 4. Prefer solving it with the "frame", not by cropping

`.img-frame` (built into tokens.css) **hands ratio and cropping to the frame, while the image just fills it**:

```html
<!-- Cover image: cropped to the frame ratio; --img-pos decides which part of the subject is kept -->
<figure class="img-frame fx-grow" data-stage="2" style="--img-ratio:16/10; --img-pos:top">
  <img src="../assets/photo.png" alt="description">
  <span class="img-tag">on site</span>
</figure>
<p class="img-cap">The caption goes outside the frame, not inside it (the frame will crop it)</p>

<!-- Screenshots/charts/images with text: use contain, no cropping, centred with letterbox -->
<figure class="img-frame contain" style="--img-ratio:16/9">
  <img src="../assets/shot.png" alt="screenshot">
</figure>
```

- **Hard rule: every image must sit in a frame; a bare `<img>` is forbidden**. A bare image blows out the layout at its own ratio.
- `--img-ratio` can be whatever you want (16/10 for a steady look, 1/1 square, 16/9 widescreen) — **16:9 is not required**.
- `--img-pos: top|center|bottom` = controls the visible part of the subject via object-position — this is the **first-choice replacement for hard cropping**.
- Screenshots / charts / images carrying text **must** use `.contain`: cropping loses information.
- `.img-scrim` darkens the bottom so white text stays readable over a photo; `.img-cap` is the caption, `.img-tag` the corner badge.

## 5. Cropping (last resort, with hard limits)

When 5 searches all disappoint, consider in order: ① **change the subject** (switch to a number card / big type / quote); ② **change the layout** (contain letterboxing also looks refined); ③ **find an officially licensed image**; ④ only then crop.

```bash
node <skill>/scripts/prep-image.mjs --crop assets/in.png assets/out.png --ratio 16:9 --anchor bottom
```

**Hard crop limits** (enforced by the script): the target ratio must not require upscaling to pad the edges; the cropped area must be **≤20%** — beyond that it refuses outright and tells you to switch to `contain`.

After cropping you **must** eyeball whether the subject is intact — better to switch to `--img-pos` than to crop into the subject.

## 6. The three-step visual verification (mandatory after any HTML change)

1. **Re-capture**: `node <skill>/scripts/capture.mjs <project> --mode still`, then look at `preview/<id>.png`
2. **Check the subject position**: is the subject centred and slightly above middle? Has half of it been cropped away?
3. **Pull an actual frame from the finished render**: `ffmpeg -ss <timestamp> -i out/final.mp4 -frames:v 1 frame.png` — you **must check a frame from the finished render**, not just what the capture pipeline produced (capture and final render can differ in fades and subtitle timing)

## 7. Compliance and logging (consistent with authoring.md)

- Every asset lands in `assets/` and is logged in `assets/MANIFEST.md`: filename / content / source URL or channel / licence
- No watermarks (if there is one, replace the image; cropping out a watermark requires confirming the cropped area is ≤20% and the subject is intact)
- Trademarks/logos only in the context of "talking about that brand", never as decoration
- Photos must come from a licensable source; a person's photo with no traceable licence is better replaced by a plain text quote card
- Screenshots must state their origin (official document name + date)
- **Never fabricate logos, screenshots, portraits or QR codes out of thin air**
- Assets must be saved locally before being referenced in the HTML (capture only waits 4s; external images that do not load in time are skipped)

## 8. Image sourcing advice by topic

| Topic | Preferred path | Notes |
|---|---|---|
| Chinese AI companies / Hong Kong IPOs | B (official-site DOM) | Bing fails systematically; official hero/product pages carry the most complete assets |
| Overseas tech companies | A (official brand kit) + B | curl logos straight from simple-icons |
| Universities / campuses | B (school official site, "official account" images) | real-scene images must be "front-on / full view"; the subject easily hugs the edge |
| Historical figures / old photos | C (Wikipedia CC) | mind the copyright term |
| Collapse / regulatory penalty / lawsuit / scandal | D (announcement and coverage screenshots) | official sites carry no such material; screenshot mainstream media coverage or the announcement page and keep the outlet name and date visible; negative financial topics are also bound by compliance.md |
| Earnings data / comparisons | no image | number card + table layout |
| Abstract concepts (growth / connection / future) | no image | gradient + big type + icons |
