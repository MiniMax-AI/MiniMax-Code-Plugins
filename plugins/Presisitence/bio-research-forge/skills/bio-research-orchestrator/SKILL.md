---
name: bio-research-orchestrator
description: Coordinate a life-science research request that spans design, public databases, omics, statistics, writing, figures, reproducibility, or independent review. Use for multi-stage research work; do not use for a single narrow lookup.
---

# Bio Research Orchestrator

Turn a broad request into a traceable research workflow without mixing evidence levels or private resources.

## Start contract

Before analysis, state:

1. the biological question in one sentence;
2. the primary endpoint and experimental unit;
3. the falsifiable claim;
4. the available evidence and what it cannot establish;
5. the requested deliverables and final review gate.

If the materials cannot answer the question, issue `No-Go` or `Revise-and-Go`. Do not hide a design failure by adding downstream analyses.

## Routing

Read [references/routing.md](references/routing.md) and load only the specialist skills needed. Keep responsibilities separate. When delegation is available and the user has requested multi-agent work, assign bounded roles with explicit inputs, outputs, and acceptance criteria. A production role must not self-certify its own result when an independent review role is available.

## Non-negotiable boundary

Read [../../PRIVACY.md](../../PRIVACY.md). Use only user-authorized workspace files and named public APIs. Never import a private genome/transcriptome database, private experimental dataset, dedicated pepper portal, credential, or machine-specific path into a reusable artifact.

## Evidence ledger

For every conclusion, label the strongest support as one of:

- `Direct data`: observed or computed from supplied data;
- `External evidence`: verified public record or paper;
- `Candidate evidence`: association, prediction, enrichment, network, docking, or model importance;
- `Hypothesis`: a proposed explanation or next test.

## Completion gate

Do not say the work is complete until deliverables exist, commands/tests are recorded, failures are disclosed, and `evidence-review` has produced a verdict for high-stakes outputs. Return the important result in the conversation; files are supporting artifacts, not a substitute for the answer.
