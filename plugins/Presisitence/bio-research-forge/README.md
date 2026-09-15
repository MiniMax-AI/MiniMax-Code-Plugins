# bio-research-forge

Evidence-first life-science workbench for MiniMax Code. The Plugin ships twelve Agent Skills
plus three local stdio MCP servers: public biological APIs (with provenance), RNA result figures
(PNG/PDF + plotted data), and bounded local molecular tools (PyMOL render / SnapGene / Cytoscape / Fiji).

It does not bundle genomes, expression matrices, credentials, or species-specific private portals.
Private tables stay on the user's machine. Public queries are allowlisted and read-only.
This package is the portable Agent Plugins 1.0 subset; it does not include Codex marketplace
adapters, hooks, custom agents, LSP, Apps, OAuth, or TUI extensions.

Standalone source: https://github.com/Presisitence/bio-research-forge

## Companion figure library (optional)

For a local scientific figure gallery beyond this plugin's RNA volcano / PCA / heatmap tools, see the optional companion [Scientific Figure Library](https://github.com/xuzhougeng/ScientificFigureLibrary). It is **not bundled** here—install it separately (Node.js 22+; see that repo's QUICKSTART). Bio Research Forge keeps its own RNA figure pipeline; SFL is a separate local gallery. See [ATTRIBUTION.md](ATTRIBUTION.md).

## Try it

```text
Look up Arabidopsis FLC in UniProt and NCBI. Then, using my local DEG table deg.csv
(columns gene, log2FoldChange, padj), draw a volcano plot (padj < 0.05, |log2FC| > 1)
and show the PNG in the conversation.
```

```text
用公共 API 查拟南芥 FLC 的 UniProt / NCBI 记录，再用我本地的 deg.csv
（列 gene, log2FoldChange, padj）画火山图，padj < 0.05 且 |log2FC| > 1，并在对话里预览 PNG。
```

Expected result: the agent calls `bio_api_query` (UniProt / NCBI) then `rna_figure_create`
(`plot_type="volcano"`). API replies include the source URL and retrieval time. The local table
is not uploaded. Success writes `<name>.png`, `<name>.pdf`, and `<name>.plot-data.csv`; the PNG
path is meant for inline preview. Missing R packages return a status error rather than a crash.

For a design or manuscript request, `bio-research-orchestrator` routes to specialist Skills
(`experimental-design-gate`, `manuscript-argument`, `evidence-review`, …) and labels evidence as
direct data / external / candidate / hypothesis.

## Requirements

- Node.js 18+ on PATH (`mcp.json` starts each server with `node` and `cwd: ${PLUGIN_ROOT}`).
- Optional `NCBI_API_KEY` in the environment to raise NCBI rate limits. No key is shipped.
- Optional R with `Rscript` on PATH, or `RSCRIPT_EXE`, plus `jsonlite`, `ggplot2`, `pheatmap`
  (and `ggrepel` for volcano labels). Needed only for `rna_figure_create`.
- Optional local installs of PyMOL, SnapGene, Cytoscape, or Fiji (or `PYMOL_EXE` /
  `SNAPGENE_EXE` / `CYTOSCAPE_EXE` / `FIJI_EXE`). The bridge never installs software.
- Windows, macOS, and Linux.

## Data and network

`public-bio-api` contacts named public scholarly APIs only. Arbitrary URLs, local files,
credentials, and pepper-specific queries are rejected:

- `eutils.ncbi.nlm.nih.gov`
- `rest.uniprot.org`
- `www.ebi.ac.uk` (InterPro, Europe PMC)
- `rest.ensembl.org`
- `alphafold.ebi.ac.uk`
- `data.rcsb.org`
- `string-db.org`
- `jaspar.elixir.no`
- `solgenomics.net` (generic BrAPI crop-name metadata only)

`rna-figure` and `local-bio-tools` are local-only. User CSVs and structure files are not
transmitted. No telemetry. No credentials in the package.

## Skills and MCP

Skills (frontmatter `name` matches each directory): `bio-research-orchestrator`,
`public-bio-databases`, `experimental-design-gate`, `omics-workflow`, `rna-figure-workflow`,
`quantitative-research`, `local-bio-toolkit`, `secure-compute-routing`, `manuscript-argument`,
`scientific-figure-delivery`, `reproducible-analysis`, `evidence-review`.

MCP tools: `bio_api_catalog` / `bio_api_query` / `bio_api_health`; `rna_figure_status` /
`rna_figure_create`; `local_bio_tool_status` / `pymol_render` / `local_bio_open`.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) and [ATTRIBUTION.md](ATTRIBUTION.md).
This Plugin keeps the upstream source license; it is not relicensed to MIT.
Public databases and optional desktop tools have their own terms.
