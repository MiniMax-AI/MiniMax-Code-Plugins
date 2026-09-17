# plant-public

Public plant-pathology bioinformatics for MiniMax Code: UniProt, NCBI, InterProScan, PDB,
AlphaFold DB, Ensembl Plants, Sol Genomics (Solanaceae), and Arabidopsis BAR / ATTED / STRING.

This Plugin ships a stdio MCP server. It does not bundle any local genomes or RNA-seq matrices.
All sequence and annotation data come from public APIs. Web-only tools (SignalP, PlantCARE, …)
return submission guidance rather than invented results.

## Try it

```text
Look up tomato WRKY transcription factors in UniProt and NCBI. Then get InterProScan domains
for one protein and fetch its AlphaFold model if a UniProt accession exists.
```

```text
用 Ensembl Plants 查 solanum_lycopersicum 的 NPR1 同源基因，再给出 Sol Genomics BLAST 该怎么提交。
```

Expected result: the agent calls `uniprot_search` / `ncbi_search` / `ensembl_plants_gene` (or
`plant_resource_guide("solgenomics")` for the SGN web path), returns accessions, FASTA or domain
tables from the live APIs, and marks any web-only step as a guide rather than fake data.

## Requirements

- Python 3.10+ and [uv](https://docs.astral.sh/uv/) on PATH (`mcp.json` starts the server with `uv run server.py`).
- Optional `NCBI_API_KEY` environment variable to raise NCBI rate limits. No key is required.
- Windows, macOS, and Linux.

## Data and network

The MCP server contacts public scholarly APIs only:

- `rest.uniprot.org`
- `eutils.ncbi.nlm.nih.gov`
- `www.ebi.ac.uk` (InterProScan)
- `data.rcsb.org` / RCSB PDB search
- `alphafold.ebi.ac.uk`
- `rest.ensembl.org` (Ensembl Plants)
- `bar.utoronto.ca`, `atted.jp`, `string-db.org` (Arabidopsis)

No telemetry. No credentials in the package. Optional `NCBI_API_KEY` stays in the user's environment.

## License

MIT. See [LICENSE](LICENSE). Upstream databases have their own terms; respect rate limits.
