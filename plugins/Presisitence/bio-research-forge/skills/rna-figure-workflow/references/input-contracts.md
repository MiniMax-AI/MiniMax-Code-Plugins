# RNA figure input contracts

| Plot | Required content | Typical automatic columns | Important checks |
|---|---|---|---|
| Volcano | effect size and adjusted P value | `log2FoldChange`, `padj` | verify contrast direction and zero/NA handling |
| PCA | genes by numeric sample columns | first column gene ID | raw counts may be log2(x+1); metadata sample names must match exactly |
| Heatmap | genes by numeric sample columns | first column gene ID | top genes are selected by variance and row z-scored |
| Expression boxplot | long table with group and value | `group`, `value` | observations must be biological units, not technical pseudo-replicates |
| Enrichment dotplot | term, gene ratio, count, adjusted P | `Description`, `GeneRatio`, `Count`, `padj` | enrichment is candidate-level evidence and needs a valid background universe |

Use the `columns` argument whenever automatic names do not match. Use `metadata_path` for PCA grouping; its default keys are `sample` and `group`.

The plotting tool writes `<output_name>.png`, `<output_name>.pdf`, and `<output_name>.plot-data.csv`. It never overwrites the input table.
