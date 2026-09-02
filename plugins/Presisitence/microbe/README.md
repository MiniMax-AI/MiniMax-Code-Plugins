# microbe

Downstream **16S / ITS** microbiome analysis for MiniMax Code. vegan, DESeq2, edgeR, igraph,
Hmisc, randomForest, and ggtree scripts are wrapped as MCP tools and rendered by local **Rscript**.

Figure types follow two public papers for layout (the Plugin does not include their data):

- Liu et al. 2023, *Nature Microbiology*
- Zhou et al. 2022, *Nature Communications*

Does not run DADA2/QIIME2. Start from a feature table.

## Try it

```text
I have feature_table.csv, taxonomy.csv, and metadata.csv (groups DP vs DSP). Draw alpha and beta
diversity, a genus stacked bar, DESeq2 differential abundance, and a co-occurrence network.
```

Expected result: the agent calls `microbe_env`, then `microbe_alpha`, `microbe_beta`,
`microbe_composition`, `microbe_diff`, and `microbe_network`. png+pdf paths and key statistics
are returned. Synthetic tables can be generated with `python tests/prep_test.py` for a dry run.

## Requirements

- Python 3.10+ and [uv](https://docs.astral.sh/uv/) on PATH.
- R with `Rscript` on PATH, or set `MICROBE_RSCRIPT`.
- R packages such as vegan, ggplot2, igraph; DESeq2/edgeR optional (tools degrade with install hints).
- Windows, macOS, and Linux.

## Data and network

- Analyses are local on user CSVs. No telemetry.
- No credentials in the package.
- `tests/prep_test.py` writes synthetic OTU-like tables only.

## License

MIT. See [LICENSE](LICENSE).
