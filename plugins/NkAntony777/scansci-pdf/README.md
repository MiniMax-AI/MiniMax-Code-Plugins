# ScanSci PDF

Academic paper retrieval for MiniMax Code: turn a DOI, an arXiv ID, a keyword query, or a
thousand-row reading list into downloaded PDFs with per-item source reporting. The plugin wraps
the [scansci-pdf](https://github.com/Rimagination/scansci-pdf) engine — 20+ sources raced in a
hedged cascade (publisher links, OpenAlex / Unpaywall / Europe PMC / arXiv open-access
resolution, Sci-Hub / LibGen mirrors, and user-authorized institutional routes) — as two Skills
plus a local stdio MCP server. The plugin vendors a patched, source-only fork of the engine and
launches that exact copy; it does not execute an arbitrary `scansci-pdf` found on `PATH`.

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

- **Python >= 3.11** on the machine. The MCP server launches the vendored engine with `python`;
  install the dependencies declared in `vendor/scansci-pdf/pyproject.toml` in the Python
  environment used by MiniMax Code:

  ```bash
  python -m pip install --require-hashes -r <PLUGIN_ROOT>/vendor/scansci-pdf/requirements.lock
  # Run from your project workspace:
  python <PLUGIN_ROOT>/vendor/scansci-pdf/run_secure.py --verify
  ```

  For browser workflows, install the hashed optional dependency set instead:
  `python -m pip install --require-hashes -r <PLUGIN_ROOT>/vendor/scansci-pdf/requirements-browser.lock`.
  Use an installed Chrome/Edge, or explicitly install the chosen backend's browser.

- The package uses source fallbacks without prebuilt Cython extensions. Browser workflows use
  an authenticated local CONNECT guard, preserving publisher TLS and blocking private destinations.
  Browser backends require optional packages and a separately installed browser. Chromium has a
  real integration test; Firefox/Camoufox needs platform-specific integration validation.
  Remote CamoFox/FlareSolverr services cannot enforce this policy and are unavailable in hosted mode;
  their local browser equivalents provide the guarded fallback.
- Platforms: Windows / macOS / Linux. Mainland-China network conditions are handled explicitly
  (mirror selection, proxy detection) but not required.
- No MiniMax Code host tools are required; everything runs through the MCP server (`stdio`,
  launched from the vendored `run_secure.py` entrypoint).
- Institutional routes need **the user's own credentials**: an Elsevier API key on a campus
  network, or a WebVPN / CARSI login performed by the user in a browser session. Grey-source
  (Sci-Hub / LibGen) lanes are on by default upstream; users can restrict to legal-only sources
  (`legal_only` strategy).

## Data and network

- Outbound requests go to scholarly APIs and mirrors: OpenAlex, Unpaywall, Crossref, Semantic
  Scholar, Europe PMC / PMC, arXiv, DOAJ, OpenAIRE, publisher sites and CDNs (e.g. Elsevier,
  Springer, MDPI), Sci-Hub mirrors, LibGen, and the user's own institutional WebVPN / CARSI
  endpoints. Unpaywall requires the user's real email address (requested via MCP when missing).
- Configuration and credentials are stored under a private `.scansci-pdf/` directory in the active
  workspace. Cookie and config writes are atomic and private; existing symlinks are rejected.
- The strict hosted transport accepts public HTTPS only, validates the peer IP at connection time,
  checks every redirect hop, and treats paper text/metadata as untrusted external data.
- The engine source provenance is pinned in `vendor/scansci-pdf/SOURCE-COMMIT.txt`.
- Performance-sensitive paths retain per-worker HTTP connection pools, batch lane concurrency,
  metadata cache, and atomic streaming writes. Explicit HTTP(S)/SOCKS5 proxies connect to validated
  numeric destination IPs; publisher TLS still validates the original host. Local DNS is required.
- Tor installation requires owner confirmation and a source-controlled archive SHA-256 pin;
  archive paths and installed files are checked before execution. Existing external Tor services
  remain usable. Unsupported bundle architectures report an explicit error.
- Run bundled sorting helpers through `run_secure.py --helper <script>`. Excel write-back requires
  `--confirm-writeback`; it atomically replaces the workbook after successful serialization.
- See `REVIEW-NOTES.md` for measured performance, regression checks, and remaining validation limits.

## Upstream, license, and maintenance

- Upstream project: <https://github.com/Rimagination/scansci-pdf> (Apache-2.0,
  Copyright 2024-2026 scansci-pdf contributors). This package vendors the source from upstream
  **v1.18.0** plus the security patch documented in `vendor/scansci-pdf/SOURCE-COMMIT.txt`.
- Submitted and maintained in this registry by [NkAntony777](https://github.com/NkAntony777).
  The helper scripts referenced by `scansci-sort` are shipped under
  `vendor/scansci-pdf/scripts/`.
- Plugin `1.18.0-minimax.1` vendors engine `1.18.0.post1`, based on upstream v1.18.0.

