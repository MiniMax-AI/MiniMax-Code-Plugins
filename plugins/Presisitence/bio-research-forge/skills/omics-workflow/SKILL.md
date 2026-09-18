---
name: omics-workflow
description: Plan, audit, or interpret public or user-authorized sequencing and omics workflows, including bulk RNA-seq, single-cell, amplicon, metagenomic, variant, and metabolomic analyses. Use only after design and metadata fit are checked.
---

# Omics Workflow

## Intake contract

Identify assay, platform, experimental unit, biological replicates, groups, batches, pairing, reference/annotation version, raw/processed inputs, and primary biological contrast. Stop if group and batch are fully confounded or replication cannot support inference.

## Stage gates

1. `Raw QC`: integrity, depth, quality, contamination, adapters, duplication, mapping/assignment expectations.
2. `Metadata`: unique sample IDs, factor levels, units, missingness, batch and subject structure.
3. `Quantification`: versioned reference, parameters, multi-mapping policy, feature definition.
4. `Exploration`: sample-level PCA/MDS, library size, outliers, and batch patterns without deleting samples silently.
5. `Inference`: explicit design matrix and contrasts; multiple-testing control; effect sizes with uncertainty.
6. `Interpretation`: correct background universe, annotation version, redundancy control, and evidence-level language.
7. `Delivery`: source tables, code, environment, QC report, exclusions, and failed checks.

## Domain red lines

- Do not treat cells as biological replicates; use sample-aware inference or pseudobulk where appropriate.
- Treat microbiome abundance as compositional and evaluate sparsity and prevalence.
- Do not infer mechanism from enrichment, network centrality, classifier importance, or differential abundance alone.
- Never overwrite raw data or package user data into a reusable plugin.
