# Create a deck (python-pptx)

## Skeleton using semantic layouts and placeholders

```python
from pptx import Presentation
from pptx.enum.shapes import PP_PLACEHOLDER
from pptx.util import Inches, Pt

prs = Presentation()
# Keep this template's slide size and layout geometry together. For 16:9 output, start with a
# real 16:9 template instead of changing only slide_width/slide_height after loading layouts.

# Built-in template convention: 0=Title, 1=Title and Content, 5=Title Only.
# With a supplied template, inspect [(i, x.name) for i, x in enumerate(prs.slide_layouts)]
# and map these roles to its layouts instead of assuming the same indices.
title_layout = prs.slide_layouts[0]
content_layout = prs.slide_layouts[1]
title_only_layout = prs.slide_layouts[5]

def add_slide(layout):
    return prs.slides.add_slide(layout)

def placeholder_of_type(slide, *types):
    matches = [
        ph for ph in slide.placeholders
        if ph.placeholder_format.type in types
    ]
    if len(matches) != 1:
        available = [
            f"{ph.name} ({ph.placeholder_format.type})"
            for ph in slide.placeholders
        ]
        raise ValueError(
            f"expected exactly one placeholder of {types}, found {len(matches)}; "
            f"available placeholders: {available or 'none'}"
        )
    return matches[0]

# P1 title slide
s = add_slide(title_layout)
s.shapes.title.text = "Service Reliability Review"
placeholder_of_type(s, PP_PLACEHOLDER.SUBTITLE).text = "Quarterly operations review"

# P2 bullet slide
s = add_slide(content_layout)
s.shapes.title.text = "Executive summary"
tf = placeholder_of_type(s, PP_PLACEHOLDER.BODY, PP_PLACEHOLDER.OBJECT).text_frame
tf.clear(); tf.word_wrap = True
lines = ["Uptime 99.97% (+0.04 vs last quarter)", "MTTR down to 42 minutes", "Two Sev-2 incidents, both capacity-driven"]
for i, line in enumerate(lines):
    par = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
    par.text = line; par.font.size = Pt(24)
    par.space_after = Pt(12)

# P3 table slide
s = add_slide(title_only_layout)
s.shapes.title.text = "Regional service health"
hdr = ["Region", "Error rate", "P99 latency"]
body = [
    ["Americas", "0.08%", "182 ms"],
    ["Europe", "0.05%", "164 ms"],
    ["Asia Pacific", "0.11%", "213 ms"],
]
rows, cols = 1 + len(body), len(hdr)
tbl_shape = s.shapes.add_table(rows, cols, Inches(0.5), Inches(1.5), Inches(9), Inches(3.5))
table = tbl_shape.table
for j, text in enumerate(hdr):
    cell = table.cell(0, j); cell.text = text
    for par in cell.text_frame.paragraphs:
        for run in par.runs: run.font.bold = True
for i, row in enumerate(body, start=1):
    for j, text in enumerate(row):
        table.cell(i, j).text = text

# P4 chart slide (real chart part, not a picture)
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
s = add_slide(title_only_layout)
s.shapes.title.text = "Deployment volume"
cd = CategoryChartData()
cd.categories = ["Jul", "Aug", "Sep"]
cd.add_series("Deploy count", (18, 22, 31))
graphic = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED,
                             Inches(0.75), Inches(1.5), Inches(8.5), Inches(5), cd)
chart = graphic.chart
chart.has_legend = False

prs.save("deck.pptx")
```

## The seven patterns

| Pattern | Build with |
|---|---|
| Title / section divider | Title or Section Header layout; title/subtitle placeholders |
| Agenda / list | Title and Content layout; body placeholder |
| Bullets + callout | Two Content layout; use both content placeholders |
| Image + text | Picture/Content with Caption layout and its placeholders |
| Data table | Title Only layout + `add_table` when no table placeholder exists |
| Chart | Title Only layout + `add_chart` with `CategoryChartData` |
| Quote / closing | Section Header or Title Only layout; add only the missing quote box |

## Rules

- Select a template with the requested aspect ratio before adding slides, then keep its slide
  size and layout geometry unchanged. Stay inside 0.5in margins.
- Choose a layout for the slide's purpose and populate its title/body placeholders. Use Blank
  only when no template layout can express the design, then measure every added shape.
- Title top-left at a consistent y-position across content slides; consistency reads as design.
- Max ~6 bullets per slide, one line each at the chosen size - if a bullet wraps twice, split
  the slide or cut.
- Speaker notes: `slide.notes_slide.notes_text_frame.text = "..."` - put the script there,
  not on the slide.
- Do not touch masters/layouts unless asked; a restyled master changes every existing slide.
