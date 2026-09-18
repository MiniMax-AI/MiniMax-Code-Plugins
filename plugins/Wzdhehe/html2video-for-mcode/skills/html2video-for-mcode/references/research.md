# Research and fact collection (Phase 0 reference)

Factual content goes wrong in a very concentrated set of ways: **mixed definitions/metric bases, distortion through second-hand retelling, quotes attributed to the wrong person or occasion, stale information**. This section turns "looking something up" from a single search into a reviewable process.

## When research is mandatory

**The test is simple**: if the finished video contains specific **numbers, dates, names, quotes or attribution relationships** → research is mandatory.

- Companies / products / funding / data / history / people / policy: **mandatory**
- Generic, lyrical, creative or purely opinion pieces: can be skipped, but any sentence that *looks like a fact* still has to be verified
- The user has already supplied a final script: still review it and mark the factual points that "could be misread or challenged"

## Source tiering (decides whether a source can enter the script)

| Tier | Examples | Use |
|---|---|---|
| **Primary** | Official announcements, financial reports, prospectuses, official blogs and technical reports, government / international-organisation statistics, original papers | Use directly; definitions and numbers defer to it |
| **Authoritative secondary** | Mainstream financial media, industry research reports, the **original sources cited by** Wikipedia | Usable, but key numbers should be traced back to primary wherever possible |
| **Weak sources** | Self-media, aggregator sites, AI summary pages, unsigned "compiled materials" | **Leads only**, must be traced back to primary; discard if it cannot be |
| **Unusable** | Forum posts, unsourced screenshots, images/tables of unknown origin | Do not enter the script |

## Hard rules (miss one and it goes back)

1. **Every key number needs at least 2 independent sources.** With only one source, use hedged wording in the script ("per the official figure…") or downgrade it to an approximation.
2. **Primary first.** Numbers taken from secondary retellings must be traced back to the original text — the longer the retelling chain, the more the number gets processed.
3. **Label the definition and the date.** Is "revenue" annualised or quarterly? In what currency? Is "users" weekly actives or monthly actives? As of when? Write it clearly in the notes, and carry it into the script where it belongs ("in the first half of this year").
4. **Recency**: prefer sources from the last 12 months; assertions like "fastest / first / largest / the first ever" especially need a recent source.
5. **Separate fact from narrative**: "900M weekly actives" (checkable) vs "most popular" (an opinion). Opinions need a subject ("the company itself says…") or must be a quote.
6. **Quotes verbatim + name and occasion stated**; translated quotes marked "(translated)".
7. **Anything uncertain stays out of the script**: if the source cannot be found, or sources conflict irreconcilably → write it into the notes as an "uncertain item", keep it out of the narration.
8. **Sources must be re-checkable**: every item carries a URL or document name + date, so Gate 0 and later review can trace it.

## Query design

- **Entity + metric + time**: `MiniMax 2026 H1 revenue prospectus`; for a Chinese-market entity, the same query in Chinese — `MiniMax 2026 上半年 营收 招股书`
- **Query in both Chinese and English**: for Chinese-language topics look for the official Chinese announcement; for international topics go to the English original (second-hand translation distorts)
- **Go straight for the carrier word**: to find numbers, search "financial report / prospectus / annual report / technical report / statistical bulletin" — that hits primary sources faster than searching the entity name
- **Prefer official domains**: guess the official document path or the official news page first, get the primary source and only then look for secondary interpretation

## What to do when sources conflict

1. Compare **definition and date** first — most "conflicts" are actually different definitions (weekly vs monthly actives, annualised vs single quarter)
2. Then compare **source tier** (primary > authoritative secondary > weak)
3. Still conflicting: take the primary / more recent one, and record the disagreement in the notes
4. Cannot decide on the spot: **do not use that number in the script**, or turn it into a qualitative statement

## Search tools by environment

| Environment | Search | Notes |
|---|---|---|
| mcode | `web_search` / `web_fetch` (built in) | `web_fetch` pulls the body text, good for tracing primary pages |
| Other hosts | `mmx search "keyword"` / `mmx text chat` | **~10 results max, no pagination** — good for "finding a primary entry point"; deeper verification still needs fetching the page or opening the official page |
| mcode general fallback | built-in browser, open the official page | The same technique as image path B; the official page is always the most reliable |
| Any environment | **other search skills/plugins installed on this machine** | Use whichever one can actually pull the body text (the tools are open, the discipline is not); try it once to confirm result quality and count before depending on it; source tiering, two-source cross-checking and definition labelling all still apply |

## Fetching: how to actually get official sites / press releases / prospectuses

Search tools only "find the entry point" — **you fetch the body text yourself**. Choose the method by how the page renders:

| Page type | Method | Notes |
|---|---|---|
| Static pages / documents / announcement pages | `web_fetch <URL>` | Gets the body text directly, fastest |
| **SPA / JS-rendered pages** (many corporate sites, investor relations pages) | **mcode built-in browser** (mcode environment) or a **headless Playwright browser** (any environment), render first then take the body text | `web_fetch` often returns nothing but an empty shell HTML (a shell with no text). This skill already depends on Playwright, so reuse it (headless render, nobody has to watch it); any other headless browser automation skill installed on the machine also works, as long as it gets the body text. When using the **mcode built-in browser**: do not use `navigate(replaceCurrentTab)` as a refresh (it opens a new tab), throttle when clicking 15+ times in a row (it triggers human verification), and when you have image URLs, write them to disk via `fetch-official-images.mjs --url`. Command: |

```bash
# render, then take the body text (works for SPA / lazy-loaded official sites)
node -e "const {chromium}=require('playwright');(async()=>{
  const b=await chromium.launch(); const p=await b.newPage();
  await p.goto(process.argv[1],{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(2500);                       // wait for async content
  console.log(await p.evaluate(()=>document.body.innerText));
  await b.close();})()" "https://company.example/newsroom/some-post"
```

- For **images/charts** on the same page: `node <skill>/scripts/fetch-official-images.mjs <URL>` (it already opens and renders the page and lists candidate images)
- **PDF** (prospectuses, financial reports, annual reports, white papers): download directly, then extract the text from the PDF; **numbers defer to the PDF original text**, never to a media retelling
- Pages that need login / captcha: do not force your way through automation — switch to a public official page or ask the user for the file

## Discipline for using press releases / announcements

**Where to look**: `/news`, `/newsroom`, `/press`, `/investor`, `/ir`, `/announcements`; Chinese companies usually keep columns named "news centre / investor relations / announcements". Exchange announcements — SEC EDGAR for US filings, HKEXnews for Hong Kong, SSE / SZSE (CNINFO) for mainland China, plus regulator decisions such as FDA / FTC — are more authoritative than the company's own site.

**Four rules of discipline**

1. **Identify the publishing entity**: the official original text (company / exchange / institution) ≠ a media retelling. On conflict, **the official original text wins**.
2. **Identify the publication date and the definition**: numbers in a press release almost always carry a definition ("as of June 2026", "annualised", "unaudited") → **copy the definition verbatim**, never shorten it to a bare number.
3. **Beware headline exaggeration**: "first / largest / disruptive" mostly appears in media headlines rather than the original text; before writing it into the narration, go back to the original and check whether it really says that.
4. **Trace syndicated copies**: when the same wire story is republished by several outlets, find the original publisher; quote the original text, not the republished page.

```markdown
## Core facts
| Fact | Value/wording | Source (URL or document name) | Definition date | Tier | Second source |
|---|---|---|---|---|---|
| Weekly active users | 900M | openai.com/… (official announcement) | 2026-02 | Primary | Reuters 2026-03 |

## Uncertain items (not entering the script)
- Valuation definitions disagree across reports (800B / 852B), and there is no primary source → do not use

## Content that must not enter the script
- Unconfirmed rumours, controversial evaluations, unverifiable personal relationships
```

When presenting at Gate 0, **focus the user on confirming the numbers, names and definitions**, rather than reading through the whole table.

## Confirm the domain first (extra step for regulated topics)

At kickoff alignment, if the topic falls under **finance/investment research, healthcare, legal, government policy, or marketing performance claims**, then in addition to the definition discipline in this section you must also follow `compliance.md`: confirm **whether a disclaimer and data attribution are required** (by default they are), complete every number with the three requisites "definition + currency + point in time", and settle up/down colours by the audience's market (red-up/green-down vs green-up/red-down). This step must reach a conclusion at Gate 0 — do not leave it to the finished video.

## Pitfalls by topic

| Topic | Pitfall | What to do |
|---|---|---|
| Company / funding / IPO | Media mix up "valuation / revenue / funding amount"; currency and annualisation basis unclear | Defer to the prospectus or official announcement; state the currency and the period |
| Finance / investment research (stocks, funds, macro data) | Opinions written as facts, stale points in time presented as "currently", mixed definitions (YoY ≠ QoQ, GAAP ≠ non-GAAP); wrong up/down colours for the audience | Every number carries **definition + currency + point in time**; price figures say "as of the YYYY-MM-DD close"; no trading advice and no price predictions; disclaimer and up/down colours per `compliance.md` |
| Models / technical benchmarks | Leaderboard versions differ, scores are not comparable | Defer to the official technical report + state the leaderboard name and version |
| History / people | Quote sources unclear, second-hand retellings distort | Defer to authoritative biographies/archives; every quote must have an original source |
| Policy / statistics | Using old-version data, ignoring revisions | Defer to the original government or international-organisation release, watch for revision notes |
| Product features | Calling a "beta / gated rollout" a "live feature" | Defer to the current state in the official documentation, and date it |
