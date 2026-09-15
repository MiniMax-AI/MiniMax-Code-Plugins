# Attribution and source boundaries

## DAWN Science

- Project: DAWN Science, <https://github.com/Jiawang1209/DAWN-Science>
- Audited revision: `5f909a5b6370c05046b0b0fd527bbf2ce6de1189`
- License: GNU Affero General Public License v3.0 or later
- Material used: high-level role boundaries and research-workbench discipline from the public `agents/` roster and bundled reproducibility skill; provenance, verification, and review concepts described in the public documentation.
- Treatment here: rewritten and reorganized as vendor-neutral Agent Skills; no DAWN desktop runtime, UI, dependency tree, or bundled application code is included.

The AGPL license in this repository applies to the resulting plugin distribution. DAWN Science remains copyright its contributors.

## Private local configuration and author materials

Private local DSH configuration was inspected only to identify desired capability classes and exclusion boundaries. No private DSH module, private database, organism-specific private portal, credential, path, or dataset is redistributed.

The RNA-figure and local-tool layers were independently implemented for this plugin after inspecting the capability names in the user's local `rna-bio` and `tools-bio` modules. Their hard-coded executable paths, private helper assumptions, local datasets, and source code were not copied into the reusable plugin.

A user-provided presentation and a local corpus of graduate theses were used only to abstract generic Introduction/Discussion reasoning patterns. Those files, their figures, and their wording are not included. The distilled rules emphasize argument structure rather than copied prose.

## Public data services

The plugin calls third-party public APIs but does not redistribute their databases. Users remain responsible for each provider's current terms, attribution requirements, rate limits, and data licenses. Source URLs are returned with every query and listed in the public database skill.

PyMOL, SnapGene, Cytoscape, Fiji/ImageJ, R, and their packages are optional third-party installations and are not redistributed. Their names identify interoperable software only. The plugin detects and invokes an existing installation under the user's license; it includes no code or assets from those products.

## Companion: Scientific Figure Library (optional)

- Project: [Scientific Figure Library](https://github.com/xuzhougeng/ScientificFigureLibrary)
- License: MIT
- Treatment here: **not bundled**. Install separately if you want a local scientific figure gallery. This plugin does not ship SFL code or assets; RNA figures remain provided by bio-research-forge itself.
