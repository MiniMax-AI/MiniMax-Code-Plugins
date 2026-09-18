---
name: rna-figure-workflow
description: Create and audit common RNA-seq result figures locally, including volcano, PCA, heatmap, expression boxplot, and enrichment dotplot, with PNG/PDF delivery and inline conversation preview. Use for RNA result plotting from user-selected tables; do not use private bundled datasets.
---

# RNA Figure Workflow

Use the bundled `rna-figure` MCP for a standard R-based plot when its input contract fits. Read [references/input-contracts.md](references/input-contracts.md) before calling it.

## Scope

- Direct plots from an existing differential-expression, expression, count, or enrichment table.
- Standard deliverables: PNG preview, PDF publication file, and the exact plotted-data CSV.
- Local processing only. Never upload the table or import it into this reusable plugin.

This skill does not silently perform differential expression, invent biological replicates, or treat enrichment as mechanistic proof. Route a full counts-to-DE workflow through `omics-workflow`, then use this skill for figures.

## Figure contract

Before drawing, identify the biological conclusion, experimental unit, comparison, relevant columns, transformation, thresholds, and whether the table contains adjusted P values. Stop if sample identity, replicate structure, or the requested comparison is ambiguous.

Use `rna_figure_status` first. Then call `rna_figure_create` with an explicit plot type and output directory. Keep default thresholds only when they match the analysis contract; otherwise pass the documented values.

## Delivery

After generation:

1. inspect the PNG for clipping, misleading scales, illegible labels, and unexpected sample groupings;
2. show the PNG directly in the conversation with its absolute path;
3. link the PDF and plotted-data CSV;
4. state the source table, columns, transformation, thresholds, and row/gene selection;
5. use `evidence-review` for submission-facing figures.

Never make the user open a side-panel file merely to judge the figure.
