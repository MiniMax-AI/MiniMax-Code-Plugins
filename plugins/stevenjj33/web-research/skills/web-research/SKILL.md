---
name: web-research
description: Use when the user asks to research a topic on the web, gather information from multiple sources, do a literature scan, summarize recent developments on a subject, or look up articles. Triggers on requests like "调研 X", "找几篇关于 Y 的文章", "research Z", "汇总 Q 的资料", "look up the latest on W". Do NOT use for single-URL fetches with no research framing (use the defuddle skill directly), local file operations, code edits, or tasks that do not need web data.
license: Apache-2.0
compatibility: Requires Python 3.8+. Defuddle CLI is optional but strongly recommended. Network access to https://api.tavily.com required.
metadata:
  author: stevenjj33
  version: "0.1.0"
---

# web-research

End-to-end web research pipeline: search → fetch with a free-first cascade → summarise.

## Tool routing policy

**Search (find candidate URLs)**: Tavily `/search` (keyless by default). Defuddle is not a search engine and is not used here.

**Fetch (one URL → clean markdown)**: cascade in this order, stop at first success.

1. **defuddle** (CLI, fully free, no rate limit) — preferred when installed. Skip entirely if `command -v defuddle` returns non-zero. Do **not** install defuddle automatically; tell the user once if it is missing.
2. **Tavily `/extract`** (keyless, free but rate-limited) — fallback when defuddle is missing or fails on a URL. Header `X-Tavily-Access-Mode: keyless` is sent by `scripts/tavily_extract.py`.
3. **mcode in-app browser** (MiniMax Code's built-in browser, "Browser Use") — last resort for login-walled, JS-rendered, or Cloudflare-protected pages that the two layers above cannot parse. The pipeline writes a `<!-- needs mcode browser: <url> -->` marker; the model sees the marker and re-fetches that URL with the browser tool.

Each output file is named `NN-<slug>.md` and prefixed by a tag noting which layer produced it (`[defuddle]`, `[tavily extract]`, or `[browser required]`).

## Default flow

If the user did not specify constraints, run the full pipeline in one shot:

```bash
python3 scripts/research.py "<query>" 5 ./research-output
```

The script returns non-zero if Tavily search itself failed; partial URL failures are surfaced as `[browser required]` markers inside the output directory, not as script errors.

## Step-by-step (when the user wants control)

1. **Search** for URLs only:
   ```bash
   python3 scripts/tavily_search.py --query "<query>" --max-results 5 --format brave
   ```
   Output is JSON `{query, answer, results:[{title,url,snippet}]}`.

2. **Fetch one URL** with the cascade (the script picks the layer based on availability):
   ```bash
   # Preferred (defuddle must be installed):
   defuddle parse "<url>" --md -o "<out>.md"
   # Fallback (Tavily keyless extract):
   python3 scripts/tavily_extract.py --url "<url>" --output "<out>.md"
   # Last resort (model-driven):
   # use the mcode browser tool on <url>
   ```

3. **Combine** the resulting markdown files into a short summary at the end.

## Failure handling

- **Tavily keyless rate limit hit** (HTTP 429 or quota message): surface the message to the user, suggest setting `TAVILY_API_KEY` for higher limits, and continue. The script does not auto-retry.
- **defuddle missing**: print a one-time notice at the start of `research.py` output (to stderr), then continue to Tavily extract for every URL. Do not install defuddle.
- **defuddle fails on a single URL** (SPA, login, paywall): fall through to Tavily extract for that URL.
- **Tavily extract fails**: write a `<!-- needs mcode browser: <url> -->` marker file and continue. The model re-fetches with the browser tool only if the user cares about that URL.
- **All three layers fail**: leave the marker in place; do not loop.

## Examples

- "调研一下向量数据库的最新进展" → `python3 scripts/research.py "向量数据库 最新进展" 5 ./research-output`
- "Find three articles on Rust async runtimes" → `python3 scripts/research.py "Rust async runtime comparison" 3 ./research-output`
- "Look up the population of Tokyo" → no need for this Skill; the model should answer directly from training data or use a single Tavily search.

## Files

- `scripts/research.py` — the one-shot pipeline (search → cascade fetch → tag outputs). Python, no bash dependency.
- `scripts/tavily_search.py` — Tavily `/search` in keyless mode. Single Python file, stdlib only.
- `scripts/tavily_extract.py` — Tavily `/extract` in keyless mode. Single Python file, stdlib only.

No native binaries. No symlinks. No secrets in tree. `TAVILY_API_KEY` is read from the environment only and never logged.
