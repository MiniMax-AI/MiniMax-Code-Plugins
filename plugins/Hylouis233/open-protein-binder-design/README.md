# open-protein-binder-design

Replay, audit, and evaluate protein binder design campaigns in MiniMax Code —
seven Skills on top of the `openbinder` CLI, covering source registration,
protocol compilation, campaign replay, ranking audit, agent decision
evaluation, external handoff, and evidence-graded final reports, without
running any protein model.

## The problem

Anthropic's public Claude binder design release (protocol, campaign records,
candidates, precomputed scores, wet-lab labels) is a rare window into how an AI
agent runs a real science campaign. But a raw data dump is not a workflow: from
the files alone you cannot tell what was known and decided at each step,
whether the published ranking survives recomputation, or how another model
would decide given the exact same inputs. This Plugin turns the release into a
replayable, auditable, comparable workflow — with strict gap discipline
(missing is reported as missing, never interpolated) and byte-identical,
wall-clock-free artifacts that diff cleanly under review.

## Try it

```text
回放一下内置的 synthetic-failure campaign，给我时间线要点和全部 gap
```

```text
用 synthetic-ranking fixture 审计这个 campaign 的排序：recorded 和 recomputed 对得上吗
```

```text
用 mock 和 replay 两个 provider 跑一遍 decision case 评测并对比结果
```

Expected result: the agent runs `openbinder replay --fixture synthetic-failure`
and returns a four-section report (Summary / Timeline / Decisions / Gaps) with
every skipped stage and unfinalized event honestly listed, never filled in;
`openbinder audit-ranking --fixture synthetic-ranking` recomputes ensemble
scores and ranking metrics (top-N hit rate, average precision, Spearman,
random baseline) and presents recorded vs recomputed side by side —
discrepancies are findings, not errors; `openbinder evaluate-agent --compare
mock,replay` freezes each provider's structured decision (SHA-256) before any
scoring and reports protocol adherence, evidence usage, fabrication signals,
and uncertainty handling. All three run fully offline.

## What it does

- **binder-source** — data source registry: list / inspect / lock sources
  (name, Hugging Face repo, pinned revision, license, attribution), with
  whitelist-only downloads (≤ 20 MB per file, ≤ 50 MB per session, deny by
  default; blocked items are reported, never bypassed).
- **binder-protocol** — protocol compiler: turns a prose protocol draft into a
  structured, stage-addressable `protocol.yaml` (ten canonical stages with
  explicit inputs, allowed decisions, required outputs, hard rules, stop
  conditions), validates it, and cuts per-stage slices for planning.
- **binder-replay** — campaign replay: normalizes public campaign provenance
  into a unified event stream and rebuilds what was known and decided at each
  step, for successful *and* failed campaigns. Gaps are reported, never
  interpolated; artifacts are byte-identical across runs.
- **binder-agent-eval** — agent decision evaluation: MiniMax, Anthropic,
  ReplayProvider, or MockProvider produce structured JSON decisions on
  identical stage inputs; a leakage guard scans the assembled prompt before
  any model call (exit 3 on hit), decisions are frozen before scoring, and
  reports carry a fixed method-and-limitations section.
- **binder-ranking-audit** — ranking audit: recomputes ensemble scores and
  ranking metrics from published precomputed scores and wet-lab labels, side
  by side with the recorded ranking. Missing scores are skipped and named;
  missing labels are excluded — never treated as zero or as non-binder.
- **binder-report** — final report bundle: collects replay / eval / audit
  artifacts into one deliverable, labels every substantive statement with one
  of six evidence grades (`recorded` / `recomputed` / `model-generated` /
  `externally imported` / `experimentally measured` / `unavailable`), and
  writes `limitations.md`.
- **binder-handoff** — external compute handoff: exports a declarative
  seven-file task package for an external platform (human-gated by
  `--confirm`, fail-closed), validates returned result packages (extension
  whitelist, path-traversal checks, required-file contract), and imports them
  as data — nothing inside a package is ever executed.

## Requirements

- Python 3.10+ on PATH, and the `openbinder` CLI installed from the source
  repository:

  ```bash
  pip install "openbinder @ git+https://github.com/Hylouis233/open-protein-binder-design@v0.1.1"
  ```

  (or follow the install instructions in the
  [source repository](https://github.com/Hylouis233/open-protein-binder-design)).
  Verify with `openbinder --help` (or `python -m openbinder`).
- No API key is required for the offline flows: fixtures, campaign replay,
  ranking audit, and the mock/replay evaluation providers work with zero
  credentials and zero network. Without an API key the `minimax` evaluation
  provider is unavailable; to enable it, set the `OPENBINDER_LLM_*`
  environment variables described in the source repository and check the
  configuration with `openbinder provider doctor --provider minimax` first.
  **MiniMax Code gateway users:** the agent gateway serves the Anthropic-style
  messages API only, so also set `OPENBINDER_LLM_API_STYLE=anthropic`
  (the doctor detects this automatically and prints the same hint).
- `openbinder source inspect/lock/download` and the `--source` modes of
  replay/audit need network access to Hugging Face; everything else is
  offline.
- The stage-gate approvals and evidence capsules mentioned in the Skills come
  from the optional [openscience](https://github.com/Hylouis233/openscience)
  Plugin. Without it the Skills degrade gracefully: the agent presents the
  artifacts and waits for your verbal approve / revise / reject, and the
  provenance journal (`.openscience/provenance.jsonl`) is still written by the
  `openbinder` CLI itself.
- Works on Windows, macOS, and Linux.

## Boundaries

- **No protein models.** The Plugin never runs RFdiffusion, BindCraft,
  AlphaFold, ESMFold, or any other generative / structure-prediction
  inference, local or remote. It cannot and does not generate new binder
  sequences.
- **No GPU anything.** CPU-only; no GPU scheduler, no container images, no
  model weight downloads.
- **No bulk data.** Whitelist-only small files; PDB/PAE/sensorgram archives
  are blocked by policy, and a policy rejection is the discipline working,
  not a malfunction.
- **Missing is missing.** Failed lookups are source gaps, not negative
  results; replay gaps are never interpolated; uncomputable evaluation cases
  are excluded and disclosed, never guessed.
- The evaluation compares *research decision-making* on identical inputs — it
  is not a claim about any model's ability to design binders, and mock/replay
  comparisons are offline controls, not real-model capability conclusions.

## Data and network

- `huggingface.co` — contacted by `openbinder source` commands and the
  `--source` replay/audit modes to inspect and fetch whitelisted files from
  the pinned `Anthropic/claude-protein-binder-design` revision. The release is
  still uploading at the pinned revision (tables/docs/manifests not yet
  present), so the real-data ranking channel reports a structured
  `unavailable` until the tables land — that is the correct result, not a
  failure.
- The `minimax` / `anthropic` evaluation providers contact their configured
  LLM endpoints only when you explicitly select them and provide credentials.
- No telemetry, no analytics, no callbacks. The package ships zero
  credentials; all artifacts are written locally under
  `output/binder-<skill>/<slug>/<timestamp>/`, with run metadata appended to
  `.openscience/provenance.jsonl` by the CLI.

## Notes

- This package is the MiniMax Code port of
  [github.com/Hylouis233/open-protein-binder-design](https://github.com/Hylouis233/open-protein-binder-design)
  (`plugins/science-protein`, v0.1.1).
- The upstream agents (`binder-planner`, `binder-reviewer`) are not included —
  MiniMax Code Agent Plugins do not load them. Their definitions are available
  in the source repository under `plugins/science-protein/agents/`; the
  discipline they encode (stage-slice-only planning, the `review`-fence output
  contract) is described inside the Skills themselves.
- Some Skills reference files that live in the source repository (e.g.
  `docs/scope.md`, `evals/decision-cases.json`, `fixtures/`); clone the source
  repository when a workflow needs them.

## License

MIT. See [LICENSE](LICENSE). Third-party data referenced by the workflow —
the Anthropic Claude protein binder design release (protocol text, campaign
records, candidate sequences, experimental results) — remains under its
original license (CC-BY-4.0 as declared on the dataset page) and is not
covered by this package's MIT license. The Plugin registers and references
that data by source ID and pinned revision, never by vendoring it. See
[THIRD_PARTY_NOTICES.md](https://github.com/Hylouis233/open-protein-binder-design/blob/main/THIRD_PARTY_NOTICES.md)
in the source repository for the full notices and attribution requirements.
