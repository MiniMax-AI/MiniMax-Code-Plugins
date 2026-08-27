# mcodeforlegal

## The problem

Chinese legal practice needs more than generic legal Q&A. A useful answer must
clear four bars that a general-purpose agent routinely misses:

- **Statute currency** — a cited article may have been amended, repealed, or
  replaced; "the model remembers it" is not verification.
- **Citation truthfulness** — fabricated case numbers and invented provisions
  are a real failure mode; anything sent out must survive an audit gate.
- **Jurisdiction differences** — Mainland China, Hong Kong, Macau, Taiwan, and
  Singapore run different regimes; an answer anchored in the wrong jurisdiction
  is worse than no answer.
- **Non-lawyer risk** — unauthorized practice of law (UPL) is a real liability;
  a non-lawyer user must be gated before receiving anything that looks like
  legal advice.

This Plugin packages a Mainland China-first legal workflow — contract review,
litigation prep, data compliance, corporate, labor, and IP — built on shared
guardrails (G1–G12), live statute-status checks, and a citation audit gate.

## Try it

```text
帮我审一下这份保密协议，我们是接收方
```

```text
查一下民法典第153条现在还有效吗
```

Expected result: the first prompt routes through the contract router into
`nda-review` and returns a three-bucket memo (🟢 / 🟡 / 🔴 findings) with a
reviewer note stating the assumed position (receiving party) and any red-line
hits; unverified citations appear as `[CITE:__]` placeholders and the output
cannot pass the `citation-audit` gate until each one is verified against a live
source. If you have not registered as a lawyer in the practice profile, a
non-lawyer confirmation gate fires before any advice-shaped output. The second
prompt runs `statute-verify`, which checks the article against the National
Laws and Regulations Database (flk) and reports its current status with a
source label — never from memory alone.

## What it does

- **Core guardrails & verification (9 skills)** — shared guardrails G1–G12 and
  the practice profile live in `docs/guardrails.md`; `cold-start-interview`
  and `customize` maintain that profile; `legal-research`, `statute-verify`,
  and `case-verify` verify statutes and cases against live sources;
  `citation-audit` is the pre-send citation gate; `matter-workspace`,
  `due-diligence`, and `tabular-review` cover matter management, diligence,
  and multi-document grid review.
- **Contract review (10 skills)** — the `contract-review` router plus typed
  reviewers: NDA, lease, loan, sales, service, and technology contracts, a
  risk-clause database, renewal tracking, and contract summaries.
- **Litigation (4 skills)** — matter intake, complaint outlines, evidence
  lists, and demand letters for Mainland civil procedure.
- **Data compliance (5 skills)** — the `compliance-review` router plus PIPL
  assessment, privacy policy review, data export assessment, and incident
  response.
- **Corporate (5 skills)** — the `corporate-review` router plus charter and
  shareholder agreement review, board resolutions, and capital contribution.
- **Labor (5 skills)** — the `labor-review` router plus labor contract and
  employee handbook review, termination assessment, and arbitration prep.
- **IP (5 skills)** — the `ip-review` router plus trademark search prep,
  patent disclosure review, software copyright, and IP assignment review.
- **Jurisdiction five-step** — every task explicitly anchors its jurisdiction
  before analysis; `docs/LEGAL_FRAMES/` holds baseline files for Mainland
  China (`cn-mainland.md`) plus framework-level baselines for HK, MO, TW, SG.
- **Source attribution vocabulary** — `docs/references/attribution-vocabulary.md`
  defines the fixed label set; a label claiming a live tool lookup may only be
  used when the tool actually returned data in the current session.
- **Not legal advice** — outputs are drafting aids for review by a licensed
  lawyer. Nothing this Plugin produces constitutes a legal opinion, and the
  UPL gate requires non-lawyer users to confirm before advice-shaped output.

## Requirements

- Python 3.11+ on PATH (runs the bundled `flk` MCP server for the National
  Laws and Regulations Database). No API key or account is needed for the
  default configuration.
- Optional: PKULAW (北大法宝), a paid commercial source, is disabled by
  default. To enable it, create a service at mcp.pkulaw.com, set
  `PKULAW_SERVICE_ID` and `PKULAW_TOKEN`, then either run
  `python scripts/enable_pkulaw.py` (verifies the gateway handshake before
  writing anything) or add this entry to `mcp.json` manually:

  ```json
  "pkulaw": {
    "type": "streamable-http",
    "url": "https://apim-gw.pkulaw.com/<SERVICE_ID>/mcp",
    "headers": { "Authorization": "Bearer ${PKULAW_TOKEN}" }
  }
  ```

- Windows, macOS, and Linux are all supported.

## Data and network

- `flk.npc.gov.cn` — the National Laws and Regulations Database, queried by the
  bundled `flk` MCP server for statute lookup and validity status.
- `apim-gw.pkulaw.com` — the PKULAW gateway, contacted only after you
  explicitly enable the connector with your own credentials.
- This Plugin does not scrape the China Judgments Online website
  (裁判文书网); case verification relies on the configured connectors and
  user-supplied materials, and reports a source gap when it cannot verify.
- No telemetry. The repository ships zero credentials; the PKULAW token is
  only ever referenced as the `${PKULAW_TOKEN}` environment variable.
- Working artifacts (matter logs, memos, drafts) are written to local
  directories such as `matters/` and `reports/` in your workspace.

## Notes

- This is the MiniMax Code port of the
  [mcodeforlegal](https://github.com/Hylouis233/mcodeforlegal) plugin set: the
  seven original sub-plugins are flattened into a single Plugin package, and
  the five scene routers were renamed (`contract-review`, `compliance-review`,
  `corporate-review`, `labor-review`, `ip-review`) to keep skill names unique.
- Claude Code-specific components (agents, hooks) are not part of this
  package and are not loaded by MiniMax Code.
- The HK/MO/TW/SG files under `docs/LEGAL_FRAMES/` are framework-level
  baselines only; verify against current local law before relying on them.

## License

Apache-2.0. See [LICENSE](LICENSE).
