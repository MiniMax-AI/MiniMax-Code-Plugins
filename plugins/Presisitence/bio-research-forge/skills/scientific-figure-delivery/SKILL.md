---
name: scientific-figure-delivery
description: Create, revise, or audit publication-grade life-science figures with source-data traceability, export QA, and a PNG preview shown directly in the agent conversation. Use for manuscript figures, not dashboards or decorative infographics.
---

# Scientific Figure Delivery

Read [references/delivery-contract.md](references/delivery-contract.md).

## Figure contract

Before drawing, state the one-sentence conclusion, evidence chain, primary comparison, experimental unit, n, uncertainty/statistic, target dimensions, and export formats. If no backend is explicit, ask `Python or R?` and use only the selected backend for generation, preview, export, and QA.

## Integrity

- Never alter or omit data to improve appearance.
- Show distributions or individual observations when scientifically appropriate.
- Define every error bar and statistical mark.
- Use restrained, colorblind-safe palettes and legible final-size typography.
- Keep labels, numbers, and panel order consistent with the source table and manuscript.
- Preserve the generation code, input table, environment, and key parameters with the figure.

## Conversation-first delivery

Always render a final PNG preview and display it in the answer using an absolute path:

```markdown
![Figure preview](/absolute/path/to/final-preview.png)
```

Also link the editable/vector and publication files. Do not force the user to open a side-panel file just to judge the figure.

## Final QA

Inspect the rendered image at actual output size, verify clipping and font embedding, validate SVG/PDF/TIFF metadata, and run `evidence-review` for submission-facing multi-panel figures.
