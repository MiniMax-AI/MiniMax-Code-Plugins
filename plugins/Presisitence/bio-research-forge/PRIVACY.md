# Privacy and scope policy

## Never include or transmit

- private experimental measurements, sequencing data, expression matrices, assemblies, annotations, identifiers, or sample metadata;
- user-specific genome or transcriptome databases;
- private credentials, tokens, cookies, internal hostnames, or absolute paths from a contributor's machine;
- dedicated pepper portals, pepper datasets, or species-specific private helpers;
- local theses, presentations, manuscripts, or copied passages from them.

## Allowed

- user-selected files inside the active task, processed locally under the user's ordinary authorization;
- local rendering of a user-selected RNA table or molecular structure, with outputs written only to the requested local directory;
- opening an existing compatible file in SnapGene, Cytoscape, or Fiji only after the user explicitly requests that desktop action;
- public, documented, read-only biological APIs on the server allowlist;
- the general Sol Genomics Network resource, limited to public generic metadata and excluding pepper-specific operations;
- generic writing and review heuristics distilled from private reference material without redistributing the source files or wording.

## Network behavior

`mcp/public-bio-api.mjs` accepts named operations rather than arbitrary URLs. It does not crawl local files. Each network response records the public endpoint and retrieval time. The server limits result size and blocks queries containing excluded private-resource terms or pepper-specific species terms.

`mcp/rna-figure.mjs` and `mcp/local-bio-tools.mjs` are local-only. They do not transmit input files. Tool discovery occurs at runtime; reusable source files contain no contributor-specific absolute executable paths. The PyMOL bridge exposes fixed rendering presets rather than arbitrary commands, and desktop tools are never installed automatically.

## Publication checklist

Before publishing a release, run `node tests/privacy-boundary.mjs`. Then inspect the git diff for unexpected binary files, archives, datasets, absolute Windows paths, credentials, and source-document text.
