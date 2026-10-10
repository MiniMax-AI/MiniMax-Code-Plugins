# Domains and Compliance (required reading for regulated topics)

**When to read this**: at kickoff alignment, first settle **which domain** this video belongs to. If the topic falls in a **regulated domain** — finance/investment, healthcare/medical, legal, government policy, marketing efficacy claims — read this section to the end before you start writing.

It is not legal advice; it turns "the things this kind of video always gets challenged on" into process checkpoints: whether a disclaimer line is required, what every number must carry, and which way the up/down colours point. Get these three wrong and the picture gets reworked no matter how good it looks.

**Name your jurisdiction, then apply its rules.** Regulated domains exist in every market; the specific regulator does not. Illustrative only — US: SEC / FTC / FDA; EU & UK: FCA / ESMA / EMA; China: CSRC / NMPA / SAMR; anywhere else: check the local regulator. So the question to put to the user is never "which regulator?" but **"which market is the audience in?"** — the answer fixes the disclaimer wording, the data rules and the colour convention for the whole video.

## 1. Domain confirmation (part of the first batch of kickoff questions)

**The two questions to ask** (never assume an answer — put both into Gate 0 alongside the data definitions):

| Question | Options / default |
|---|---|
| Which domain is this video in? | Finance/business · Technology/product · Science/education · Brand/marketing · Culture/history · Lifestyle/consumer · Government/policy — the domain decides what the visuals must carry (disclaimer line, data provenance, units), how far the narration may go, and which up/down colour convention applies |
| Disclaimer and source attribution required? | **Required by default** in regulated domains; pure opinion/brand/lifestyle may skip it. A "no" must still be stated explicitly by the user and recorded in the Gate 0 baseline and `research/notes.md` |

**Why you must ask**: a disclaimer is a **content attribute**, not a legal opinion — it does not remove liability, but when it is missing in a finance or medical context it will almost certainly be demanded later, and the rework lands in Phase 5 (the final cut), the most expensive place for it.

## 2. Finance / investment research (the class that goes wrong most often)

### 2.1 Three red lines for the narration

1. **No trading recommendations, no price predictions.** Never write "worth watching / buy the dip / could rise to / sure profit / room to double". To express an expectation, attribute it to a subject: "one institution's target-price range is …", with the institution and the publication date.
2. **Don't state opinions as facts.** "The most popular fund", "growth is a certainty" must carry a subject (the company says so / the agency's rating) or be rewritten as a verifiable statement (see `research.md` hard rule 5).
3. **Don't invent numbers or charts.** Candlesticks, earnings screenshots and rankings must all come from official sources; **no data graphic may be AI-generated** (global hard rule — see `image-sources.md`).

### 2.2 Every number must carry three things

| Requirement | Example |
|---|---|
| **Definition / scope** | annualised / single quarter / cumulative; GAAP / non-GAAP; year-over-year / quarter-over-quarter; adjusted-price basis |
| **Currency and units** | USD / EUR / CNY / HKD; millions / billions — always state which |
| **Date or period** | "as of the 2026-06-30 close", "Q2 2026 results (reported in August)" |

Financial data has a **reporting lag**: don't write "revenue is currently X", write "Q2 revenue of X as reported by the company in August". If second-by-second data such as a share price or an exchange rate must appear, write "as of the YYYY-MM-DD close" and cite the source, and **state the data date in the disclaimer line** (the video stays online for years; the number will be stale).

**Provenance rule**: at least two independent sources for every key claim, each with its date and its definition/scope; state currency and units; and keep what a source reported separate from your own inference — never let an inference ride along in the same sentence as a reported figure.

### 2.3 Up/down colours: this convention differs by region

The semantic colours in `tokens.css` default to `--good` green / `--bad` red — the US/EU reading (green up, red down). **Greater China audiences (CN/HK/TW) read the opposite: red up, green down** — flip this one by accident and the whole video reads inverted. What to do:

```css
/* 追加在项目 slides/tokens.css 末尾: A股/港股受众 = 红涨绿跌 */
:root { --up: #D92B2B; --down: #12A150; }
```

(That comment means: append to the end of the project's `slides/tokens.css` — A-share / Hong Kong audiences = red up, green down.)

- Metric cards always write **`var(--up)` / `var(--down)`** (never `var(--good)` / `var(--bad)` directly); the template already defines `--up: var(--good); --down: var(--bad)`, so an older project missing those two variables just adds the line above (`check-slides.mjs` reports undefined variables).
- Markets that read green as up (US/EU and others) keep the default — do not flip them.
- **Ask which market the audience is in while confirming assets at Gate 3**, and settle it together with the colour convention. Default to the audience's own convention, and stay consistent within one video.

### 2.4 Disclaimer: how to write it, where to put it

- **Use a fixed template, don't improvise.** English: "Not investment advice. Data as of <date>, source: <source>." Chinese: "本视频仅为信息分享,不构成任何投资建议。数据来源:<来源>,截至 <日期>。" (Medical follows the same shape: not medical advice — for diagnosis and treatment consult a licensed physician.)
- **Placement**: the `closing` slide carries a small `.disclaimer` line (bottom or bottom-right), **on screen ≥3 seconds** and legible; a long video may repeat the same small line on the `title-hero` or on the first data page.
- **The narration does not read the disclaimer aloud** (and it is not burned into the subtitles): the compliance text is carried by the picture, and the voiceover keeps its pace. If the user insists on reading it, read it — but it stays out of the subtitles.
- A disclaimer **does not replace verification**: get a number wrong and ten disclaimer lines will not save it.

## 3. Healthcare / medical

- No efficacy claims, no diagnosis, no recommending a specific drug or treatment; if you must mention one, describe "what the authoritative guideline / the approved label says", with version and date.
- Disclaimer line: "This video is general information, not medical advice; consult a licensed physician for diagnosis and treatment."
- Source ranking follows the finance standard (guidelines first, then the drug regulator — FDA / EMA / NMPA — or the pharmacopoeia, then peer-reviewed papers); **second-hand social-media retellings are not acceptable**.

## 4. Legal / government / policy

- Quote provisions **verbatim + effective date**; distinguish "currently in force" from "draft for comment".
- No case-specific interpretation ("in your situation you could argue…" → "the provision reads…, individual cases need a licensed lawyer").
- For policy and statistics cite **official releases only**, and watch for revision notes (see `research.md`).

## 5. Brand / marketing (advertising claims)

- **Absolute wording is a minefield**: best / no.1 / top / only / national-level / 100% effective / never — none of it without an authoritative basis or a substantiation document the user supplies.
- Efficacy claims need substantiation ("3x more efficient" → state the test conditions and the source); without substantiation, make the claim qualitative.
- Third-party trademarks, likenesses and endorsement relationships: **never use without authorisation**; comparative claims must be verifiable and must state the comparator and the basis.

## 6. Closing checklist (run once at Gate 0 and once at Gate 5)

- [ ] Domain confirmed, and the **audience market named** — the rules applied are that market's (US: SEC/FTC/FDA; EU & UK: FCA/ESMA/EMA; China: CSRC/NMPA/SAMR; elsewhere: the local regulator)
- [ ] **The user explicitly said yes / no to a disclaimer** (recorded in the notes)
- [ ] Every number carries definition / scope + currency / units + date or period (finance)
- [ ] No trading recommendations, no price predictions, no absolute wording
- [ ] Up/down colours match the audience market (Greater China = red up / green down; US/EU = green up / red down) and use `var(--up)` / `var(--down)`
- [ ] If confirmed: the disclaimer is on screen, stays ≥3s, and is not in the narration or the subtitles
- [ ] All data graphics come from official sources, none AI-generated

> **Regional example — mainland China** (the market this skill was first written for): regulators CSRC / NMPA / SAMR; financial and medical disclaimers in Chinese, as above; A-share and Hong Kong audiences read red = up, so apply the flip in §2.3; advertising claims fall under the Advertising Law, whose absolute-wording list (best / no.1 / top / only / national-level / 100% effective / never) is treated as a hard prohibition. In any other market, substitute that market's regulator and wording rules — the process above does not change.

Related: `research.md` (source ranking and definitions), `authoring.md` (layout and the `.disclaimer` snippet), `image-sources.md` (asset compliance).
