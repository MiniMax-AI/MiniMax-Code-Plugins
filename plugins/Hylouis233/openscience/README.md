# openscience

Evidence-first research workflow for MiniMax Code: literature search, traceable evidence,
citation verification, and human-gated research stages.

## The problem

Research is not one chat — it is a stateful, multi-stage process. A general agent can search,
code, and write, but left on its own it will hold the whole project in conversation memory,
let claims in the draft drift away from the sources they came from, and run end-to-end
without ever stopping to ask a human whether stage N was actually good enough to build
stage N+1 on.

This Plugin installs 28 Skills plus one MCP server that turn the workflow into files on disk:
a six-stage lifecycle (`question → literature → hypothesis → experiment → analysis → writing`),
an explicit evidence chain (retrieval → evidence items → whitelisted synthesis → draft →
claim-support check), machine citation verification, and a stage gate that pauses for
`approve / revise / reject` before every stage transition.

## Try it

```text
Survey the last three years of work on retrieval-augmented code generation: find the main
methods, the known failure modes, and verifiable research gaps. Search OpenAlex, Crossref,
and arXiv; read full text where available; write the survey with a BibTeX bibliography and
verify every entry.
```

```text
调研过去三年 LLM agent 在蛋白 binder design 方向的进展：检索 OpenAlex / Crossref / arXiv /
万方，去重后建立文献库；能拿到全文的精读，拿不到的诚实标注 abstract-only；把每条论断
映射回证据，写出综述稿与 references.bib，并逐条核验引用。
```

Expected result: the agent searches, dedupes into `papers.json`, reads papers into
`evidence.json` (verbatim quotes with anchors, abstract-only entries honestly marked),
synthesizes `survey.md`, writes a draft with `references.bib`, verifies every BibTeX entry
through the bibverify MCP and produces a citation report — then stops at the stage gate and
waits for your `approve / revise / reject` instead of rushing ahead. Everything lands in the
workspace under `output/<skill>/<slug>/`, with every run recorded in
`.openscience/provenance.jsonl`.

## What it does

- **Workbench core (8 Skills)**: `research-lifecycle` (six-stage router with resume-from-disk),
  `stage-gate` (writes artifacts, generates the stage report, then halts for
  approve / revise / reject — `revise` archives the old artifacts instead of overwriting),
  `research-workspace` (directory and artifact-path contract), `cold-start-interview` and
  `customize` (the research profile in the package-root `CLAUDE.md` that sets default
  databases, citation style, compute environment, and compliance red lines),
  `provenance-record` (appends every run to `.openscience/provenance.jsonl`),
  `evidence-capsule` (freezes the artifact set behind a paper-grade claim),
  `reviewer-protocol` (the shared structured-review contract).
- **Literature (6 Skills)**: `literature-search`, `paper-search`, `paper-read`,
  `literature-survey`, `review-writing`, and `cn-literature` for Chinese sources
  (CNKI bibliography import, Wanfang API, GB/T 7714 output).
- **Verify (3 Skills)**: `citation-verify` (per-entry metadata checks via the bibverify MCP),
  `claim-check` (does every draft claim trace back to evidence?), and `evidence-loop`
  (verify → targeted re-search → user-confirmed revision, max two rounds).
- **Compute (5 Skills)**: `python-analysis`, `r-analysis`, `remote-compute`, `hpc-slurm`,
  `run-monitor` — local and remote execution with provenance captured for every run.
- **Data (1 Skill)**: `scientific-databases` — license-gated access to domain databases.
- **Epidemiology (5 Skills)**: `epi-data-access`, `outbreak-analysis`, `seir-modeling`,
  `spatial-epi`, `epi-writing`.

Cross-cutting contracts every Skill obeys:

- **```review fence**: all structured review output (citation checks, claim checks, pre-release
  review) is a JSON array inside a ```` ```review ```` code fence, with `level` /
  `check` / `title` / `evidence` / `note` fields, so any consumer can parse any reviewer.
- **Stage gate**: three states only — `approve` (advance), `revise` (re-run with your
  comments, old version archived), `reject` (stop with a closing report). Nothing auto-approves.
- **provenance.jsonl**: one append-only line per run — artifacts, tool, session, model,
  environment hash, note — so every number in a draft can be traced back to a real execution.
- **slug**: a research topic is normalized (NFKC, lowercase, whitespace-collapsed) and hashed
  to an 8-hex-digit slug that namespaces all of its artifacts under `output/<skill>/<slug>/`.

## Requirements

- Python 3.11+ on PATH. Scripts shipped inside Skills use the standard library only.
- [uv](https://docs.astral.sh/uv/) — required to run the bibverify MCP server
  (`uvx bibverify mcp`) used by `citation-verify` and `evidence-loop`.
- No credentials are required by default. The optional Wanfang provider uses the
  `WANFANG_TOKEN` environment variable if you set it; without it, that provider is skipped
  and the Skills degrade gracefully to the remaining sources.
- Works on Windows, macOS, and Linux.

## Data and network

- Literature and metadata Skills contact only scholarly APIs: `api.openalex.org`,
  `api.crossref.org`, and `export.arxiv.org`. Full-text reading fetches the paper URLs
  returned by those APIs.
- `cn-literature` optionally calls `api.wanfangdata.com.cn` (only when `WANFANG_TOKEN` is
  configured). CNKI is never scraped: it works exclusively from bibliography files the user
  exports manually.
- The bibverify MCP server (started via `uvx`) queries services such as Crossref and OpenAlex
  to verify citation metadata.
- No telemetry, no analytics, no callbacks. The Plugin repository ships zero credentials and
  zero user data.
- All artifacts are written locally: research outputs under the workspace `output/` tree and
  run metadata under `.openscience/`. Bulk downloading, remote job submission, and any
  externally visible action require explicit user confirmation per the shared guardrails.

## Notes

- This package is the MiniMax Code port of [github.com/Hylouis233/openscience](https://github.com/Hylouis233/openscience),
  flattened from six source plugins into a single Plugin package.
- The upstream agents and hooks are not included — MiniMax Code Agent Plugins do not load
  them. The pre-release review flow is provided as the `reviewer-protocol` Skill, which the
  agent follows directly.
- The package-root `CLAUDE.md` holds the research profile and the shared guardrails that the
  Skills read; fill it in via the `cold-start-interview` Skill on first use.

## License

MIT. See [LICENSE](LICENSE).
