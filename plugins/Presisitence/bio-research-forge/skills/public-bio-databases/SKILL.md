---
name: public-bio-databases
description: Query public biological databases for genes, proteins, domains, structures, literature, networks, motifs, or general Solanaceae metadata through the bundled allowlisted MCP. Use for evidence lookup; never route private or pepper-specific data through it.
---

# Public Bio Databases

Use the `public-bio-api` MCP rather than inventing URLs or scraping private portals.

## Workflow

1. Call `bio_api_catalog` to select a source and read its evidence limit.
2. Translate the question into a precise identifier or search expression.
3. Call `bio_api_query` with the smallest useful result limit.
4. Record the exact source URL, retrieval time, identifiers, release/header metadata when present, and empty/failed responses.
5. Cross-check high-impact claims with a second independent source or primary literature.

Read [references/api-catalog.md](references/api-catalog.md) for source selection.

## Interpretation rules

- Database annotation is evidence, not truth by authority; record evidence codes and record versions when available.
- Sequence similarity alone does not prove one-to-one orthology or conserved biological function.
- STRING edges are functional associations, not automatically physical binding.
- Predicted structures require coverage and confidence inspection and do not establish mechanism.
- Motif matches are candidate regulatory sites, not occupancy or regulation proof.
- Search results are discovery aids; read the paper before citing it as support.

## Privacy boundary

Do not submit credentials, local paths, private identifiers, or excluded species-specific terms. Do not work around an MCP refusal. If a public source lacks a verified unauthenticated API, report that limit instead of scraping it.
