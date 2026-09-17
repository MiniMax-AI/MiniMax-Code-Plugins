---
name: plant-public
description: Use when the user needs plant or Solanaceae gene/protein lookup via public APIs (UniProt, NCBI, InterPro, PDB, AlphaFold, Ensembl Plants, Sol Genomics, Arabidopsis BAR/ATTED/STRING), domain annotation, or structure summaries. Do not invent sequences; call the plant-public MCP tools.
---

# plant-public

Call the `plant-public` MCP tools. Do not reimplement UniProt/NCBI/InterPro in ad-hoc scripts.

## Routing

- Protein annotation / FASTA → `uniprot_summary`, `uniprot_fasta`, `uniprot_search`
- Nucleotide/gene/literature IDs → `ncbi_search`, `ncbi_fetch`, `ncbi_search_fetch`
- Domains (NLR/LRR/kinase) → `interproscan_run` (needs the user's email)
- Experimental or predicted structure → `pdb_entry`, `pdb_search_by_sequence`, `alphafold_summary`
- Plant gene by species + symbol → `ensembl_plants_gene` (example species: `solanum_lycopersicum`)
- Solanaceae BLAST / genome browser (no open API) → `plant_resource_guide` with key `solgenomics`
- Arabidopsis function / biotic-stress eFP / coexpression / PPI → `bar_*`, `atted_coexpression`, `string_interactions`

Web-only resources (`signalp6`, `plantcare`, `planttfdb`, …) return submission steps only. Never fabricate those outputs.

## Honesty

If an API fails, report the error. Missing full text or a web-only tool is a source gap, not a negative biological result.
