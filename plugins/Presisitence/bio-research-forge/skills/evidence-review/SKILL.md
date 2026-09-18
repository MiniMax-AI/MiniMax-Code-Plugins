---
name: evidence-review
description: Independently review a life-science manuscript, analysis, figure package, or repository for claim support, citation validity, numeric traceability, figure-code-data consistency, reproducibility, and privacy. Use as a final gate, not as author self-approval.
---

# Evidence Review

Read [references/review-contract.md](references/review-contract.md). Review the artifacts and acceptance criteria, not the producer's confidence or narrative.

## Review layers

1. `Scientific`: question, design, controls, experimental unit, and causal strength.
2. `Citation`: existence, bibliographic correctness, primary-source preference, and semantic support for the exact clause.
3. `Numbers`: every sample size, percentage, effect, interval, p value, and identifier traced to source data or output.
4. `Figures`: source table, code, labels, statistics, legends, and manuscript text agree.
5. `Reproducibility`: clean rerun, versions, parameters, seeds, failures, and environment evidence.
6. `Privacy`: no private dataset, credential, local path, or excluded organism-specific resource entered a reusable package.

## Independence rule

If the reviewer participated in producing an artifact, disclose that conflict and perform only a provisional check. For a consequential gate, use a fresh review context or independent agent when available.

## Verdict

Return exactly one: `PASS`, `PASS WITH REQUIRED REVISIONS`, or `BLOCK`. A PASS requires evidence for each required layer; silence is not evidence.
