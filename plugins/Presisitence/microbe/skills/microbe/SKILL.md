---
name: microbe
description: Use when the user has a 16S or ITS feature table plus taxonomy and metadata and needs alpha/beta diversity, composition bars, differential abundance, co-occurrence networks, random-forest biomarkers, or a taxonomy tree. Drive the microbe MCP tools with local Rscript.
---

# microbe

Use the `microbe` MCP tools. Do not reimplement vegan/DESeq2 plots in Python.

## Typical order

1. `microbe_env`
2. `microbe_alpha`, `microbe_beta`
3. `microbe_composition`, `microbe_diff`
4. `microbe_network`, `microbe_rf`, `microbe_corr`, `microbe_tree` as requested

Expected columns: `feature_id` + sample counts; taxonomy ranks or a QIIME semicolon string; `sample_name` + `group`.

Missing R or packages: return the tool's repair command. This Plugin does not go from raw reads to ASVs.
