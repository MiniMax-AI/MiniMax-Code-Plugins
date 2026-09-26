# ScanSci PDF

Academic paper retrieval for MiniMax Code: turn a DOI, an arXiv ID, a keyword query, or a
thousand-row reading list into downloaded PDFs with per-item source reporting. The plugin wraps
the [scansci-pdf](https://github.com/Rimagination/scansci-pdf) engine — 20+ sources raced in a
hedged cascade (publisher links, OpenAlex / Unpaywall / Europe PMC / arXiv open-access
resolution, Sci-Hub / LibGen mirrors, and user-authorized institutional routes) — as two Skills
plus a local stdio MCP server.

Two Skills are included:

- **scansci-pdf** — single-paper download, search & citations, batch download with lane
  scheduling, institutional access setup (Elsevier API, WebVPN / CARSI), and troubleshooting
  (Cloudflare / Turnstile, proxies, session expiry).
- **scansci-sort** — triage for large lists (hundreds to thousands of DOIs): sniff-only
  classification into open-access / grey-source-available / needs-institutional-access buckets,
  then bucket-routed batch downloading.

## Try it

```text
Download this paper for me: 10.1038/s41586-024-07386-0, and give me the BibTeX entry.
```

Expected result: the agent resolves the DOI, reports which source produced the file (for example
an open-access PDF direct link, ~a few seconds), saves it to the working directory, and returns
a verified BibTeX record from the metadata source.

```text
Here is reading_list.xlsx with ~800 DOIs. Sort out which are open access, which Sci-Hub has,
and which need my university login, then download everything you can.
```

Expected result: the agent runs the sniff-first triage workflow, writes back a classification
report (UTF-8 CSV) plus bucket queue files, then batch-downloads the OA and grey buckets and
tells you which papers remain behind institutional auth.

## Requirements

- **Python >= 3.11** on the machine, and the `scansci-pdf` executable on `PATH`:

  ```bash
  pip install scansci-pdf      # or: uv tool install scansci-pdf
  scansci-pdf check            # verify dependencies
  ```

- The PyPI wheel ships a prebuilt Cython core (`scansci_pdf._core`); no compiler is needed at
  install time. Some fallback sources use a headless browser (optional extra
  `pip install scansci-pdf[camoufox]`).
- Platforms: Windows / macOS / Linux. Mainland-China network conditions are handled explicitly
  (mirror selection, proxy detection) but not required.
- No MiniMax Code host tools are required; everything runs through the MCP server (`stdio`,
  launched as `scansci-pdf run`) or falls back to the CLI.
- Institutional routes need **the user's own credentials**: an Elsevier API key on a campus
  network, or a WebVPN / CARSI login performed by the user in a browser session. Grey-source
  (Sci-Hub / LibGen) lanes are on by default upstream; users can restrict to legal-only sources
  (`legal_only` strategy).

## Data and network

- Outbound requests go to scholarly APIs and mirrors: OpenAlex, Unpaywall, Crossref, Semantic
  Scholar, Europe PMC / PMC, arXiv, DOAJ, OpenAIRE, publisher sites and CDNs (e.g. Elsevier,
  Springer, MDPI), Sci-Hub mirrors, LibGen, and the user's own institutional WebVPN / CARSI
  endpoints. Unpaywall requires the user's real email address (requested via MCP when missing).
- Configuration, credentials, and browser session cookies are stored locally under
  `~/.scansci-pdf/`. The plugin folder itself contains only markdown and JSON — no binaries,
  no credentials, no telemetry.
- The engine's proprietary compiled core is distributed only through the PyPI wheel; source for
  the rest of the project is on GitHub (Apache-2.0).

## Upstream, license, and maintenance

- Upstream project: <https://github.com/Rimagination/scansci-pdf> (Apache-2.0,
  Copyright 2024-2026 scansci-pdf contributors). This package redistributes the two Skill
  documents and the MCP wiring from upstream release **v1.17.0**; the engine itself is installed
  from PyPI, never vendored here.
- Submitted and maintained in this registry by [NkAntony777](https://github.com/NkAntony777).
  Some advanced workflows in `scansci-sort` reference helper scripts that live in the upstream
  repository, not in this folder.
- Version numbers here track upstream releases.

