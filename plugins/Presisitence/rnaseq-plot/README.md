# rnaseq-plot

RNA-seq **downstream plotting** for MiniMax Code (formerly published as `rgraph`).
Parameterized R scripts (ggplot2, pheatmap, clusterProfiler, edgeR, limma, WGCNA, …)
are exposed as MCP tools and rendered by the user's local **Rscript** to png + pdf.

The Plugin consumes the user's own count/FPKM tables. It does not ship genomes or experimental matrices.
`tests/data/` is a tiny synthetic `g1`–`g10` table for smoke tests.

MCP **tool names remain `rgraph_*`** (for example `rgraph_volcano`) so existing prompts keep working.

## Try it

```text
I have gene_count.csv and sample_group.csv. Run DESeq2 for treatment vs control, then draw a
volcano plot (label top 8 genes, padj < 0.05, |log2FC| > 1) and a clustered heatmap of DEGs.
```

Expected result: the agent calls `rgraph_env`, then `rgraph_diff(method="deseq2")` and
`rgraph_volcano` / `rgraph_heatmap`. Output png+pdf paths are returned. DEG calls use **padj**
by default. If R or a package is missing, the tool returns install commands instead of crashing.

## Requirements

- Python 3.10+ and [uv](https://docs.astral.sh/uv/) on PATH.
- R with `Rscript` on PATH, or set `RGRAPH_RSCRIPT` to the Rscript executable.
- Common R packages: ggplot2, pheatmap, edgeR or DESeq2 or limma, clusterProfiler as needed.
  Missing packages are reported with CRAN/Bioconductor install lines.
- Windows, macOS, and Linux.

## Data and network

- Default analyses are local: user CSVs in, png/pdf out. No telemetry.
- `rgraph_ppi` may contact STRING (`string-db.org`) when the user asks for a PPI edge table.
- No credentials in the package.

## License

MIT. See [LICENSE](LICENSE). Source: https://github.com/Presisitence/rnaseq-plot-mcp
