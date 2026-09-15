---
name: local-bio-toolkit
description: Detect and selectively use local life-science desktop or structural tools, including safe PyMOL rendering and explicit file opening in SnapGene, Cytoscape, or Fiji. Use when a user asks to work with these installed applications; never install tools silently or accept arbitrary commands.
---

# Local Bio Toolkit

Use the bundled `local-bio-tools` MCP. This layer is deliberately small and capability-based: PyMOL renders structures; SnapGene opens sequence/vector files; Cytoscape opens network files; Fiji opens microscopy images.

## Selection rule

| Need | Tool | Allowed action |
|---|---|---|
| Produce a molecular-structure image | PyMOL | headless render with a fixed visual preset |
| Inspect an existing construct or sequence record | SnapGene | open a compatible local file after an explicit user request |
| Inspect an existing biological network | Cytoscape | open a compatible local file after an explicit user request |
| Inspect an existing microscopy image | Fiji/ImageJ | open a compatible local file after an explicit user request |

Run `local_bio_tool_status` before acting. If a tool is absent, report the missing capability and the supported environment-variable override; do not install, download, or substitute software without direction.

## Safety boundary

- Accept only an existing user-selected file and a format on the allowlist.
- Do not execute arbitrary PyMOL code, macros, plugins, shell fragments, or application arguments.
- Do not launch a graphical desktop application unless the user explicitly asked to open it.
- Do not modify the source file. Save PyMOL output only to the requested PNG path.
- Processing stays local; no file is transmitted to a website or public API.

## Conversation delivery

For PyMOL output, visually inspect the generated PNG and show it directly in the conversation. Explain representation, coloring, background, and structural evidence limits. A rendered model does not establish binding, function, or experimental structure quality.
