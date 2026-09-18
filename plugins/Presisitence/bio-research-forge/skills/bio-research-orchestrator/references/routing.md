# Specialist routing

| Need | Skill | Required handoff |
|---|---|---|
| Question-design fit, controls, sample size | `experimental-design-gate` | decision, design diagram, failure criteria |
| Public gene/protein/structure/literature records | `public-bio-databases` | exact query, URL, retrieval time, evidence limit |
| Sequencing or omics | `omics-workflow` | input contract, QC gates, design matrix, outputs |
| RNA volcano, PCA, heatmap, boxplot, enrichment dotplot | `rna-figure-workflow` | source table, columns, thresholds, PNG/PDF/data preview |
| Statistical inference or prediction | `quantitative-research` | estimand, model, diagnostics, sensitivity |
| PyMOL, SnapGene, Cytoscape, or Fiji | `local-bio-toolkit` | detected tool, permitted local action, output/launch status |
| Local, HPC, or cloud execution choice | `secure-compute-routing` | data classification, transfer boundary, job manifest |
| Introduction or Discussion | `manuscript-argument` | claim-evidence map, section logic, missing citations |
| Publication figure | `scientific-figure-delivery` | source table, code, export files, inline preview |
| Re-runnable pipeline | `reproducible-analysis` | environment, parameters, seeds, clean-run evidence |
| Final audit | `evidence-review` | independent report and verdict |

Run independent branches in parallel only when their inputs do not depend on each other. Merge by shared identifiers and evidence, not by averaging prose.

For each handoff specify: task, permitted inputs, excluded inputs, expected files, acceptance tests, and stopping condition.
