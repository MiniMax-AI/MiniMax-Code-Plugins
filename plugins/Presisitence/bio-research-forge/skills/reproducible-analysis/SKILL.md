---
name: reproducible-analysis
description: Turn a life-science analysis into a cleanly rerunnable workflow with protected raw data, centralized parameters, fixed seeds, environment capture, provenance, and verified outputs. Use for publication or handoff-quality analysis.
---

# Reproducible Analysis

## Invariants

- Raw data are read-only; transformed data go to a separate location.
- Paths are project-relative in shared code and configurable at the boundary.
- Parameters and thresholds are centralized and recorded.
- Every stochastic operation has an explicit seed.
- Software, reference database, annotation, and model versions are captured.
- Each output records its inputs, command/config, creation time, and checksum.

## Workflow

1. Define inputs, expected outputs, parameters, environment, and resource requirements.
2. Add preflight checks for files, schema, identifiers, sample counts, and free space.
3. Run from a clean process in documented order.
4. Capture stdout/stderr with bounded logs and preserve non-zero exits.
5. Verify output schema, row/sample counts, hashes, and scientific invariants.
6. Rerun from clean state; compare deterministic outputs exactly and stochastic outputs under declared tolerances.
7. Produce a run manifest and disclose partial or failed steps.

Notebook state is not rerun evidence. A visible figure is not proof that the final code and source data agree. Use `evidence-review` for the final consistency check.
