---
name: experimental-design-gate
description: Audit whether biological materials, sampling, controls, replication, and measurements can answer a proposed question before experiments or analysis. Use for study planning and Go/No-Go decisions.
---

# Experimental Design Gate

## Define before optimizing

Write the biological question, experimental unit, primary endpoint, minimum meaningful effect, intervention/contrast, and falsifiable hypothesis. Distinguish biological from technical replication.

## Audit

Check:

- material and model-system relevance;
- controls, randomization, blocking, blinding, and batch balance;
- nesting, repeated measures, pairing, and independence;
- sample-size justification using a defensible effect range or simulation;
- measurement timing, dynamic range, failure thresholds, and missing-data handling;
- whether the planned statistic estimates the biological quantity of interest.

## Decision

Return one of:

- `Go`: the design can test the claim;
- `Revise-and-Go`: named changes are required before proceeding;
- `No-Go`: the current materials or design cannot identify the claimed effect.

Do not rescue a No-Go by adding omics, enrichment, machine learning, or more figures. State the smallest change that would alter the decision.

## Deliverable

Provide a design map, control table, sample-size assumptions, analysis skeleton, failure criteria, and records to preserve. Separate confirmatory endpoints from exploratory measurements.
