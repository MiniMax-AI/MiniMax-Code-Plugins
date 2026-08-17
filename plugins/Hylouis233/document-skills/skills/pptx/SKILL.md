---
name: pptx
description: Create, read, edit, or analyze PowerPoint .pptx presentations. Use this Skill whenever the task involves slides or a deck - building a presentation from an outline or content file; editing text, tables, or charts in an existing deck; extracting slide content for review or repurposing; checking that a produced deck opens, has the right slide count, and nothing overflows its slide.
---

# PPTX workbench

A `.pptx` is a ZIP of XML parts (one per slide) plus masters, layouts, and media. python-pptx
models most of it safely; everything else is surgical.

## Step 0 - Check the toolchain

```bash
python -c "import pptx; print('python-pptx ok')"
```

`soffice` present -> the rendered-PDF smoke test becomes available; use it for anything visual.

## Step 1 - Classify the task

| Request | Route |
|---|---|
| Build a deck from an outline / notes / markdown | [references/create.md](references/create.md) |
| Change text, tables, or charts in an existing deck | [references/edit.md](references/edit.md) |
| Extract or summarize deck content | [references/analyze.md](references/analyze.md) |
| Deck renders wrong / opens broken | [references/analyze.md](references/analyze.md) triage section |

## Step 2 - Shared rules

1. **Templates first**: if the user provides a `.pptx` template or brand deck, build on it
   (`Presentation("template.pptx")`), reuse its masters/layouts, and never restyle globally.
2. **Layouts carry design**: pick the closest built-in layout for each slide's purpose instead
   of hand-placing empty text boxes. Hand-placement is for exceptions, measured.
3. **Text must fit its box**: estimate width (chars x ~0.5 x font size for sans-serif at a
   first approximation) and step font size down (never below 12pt body) or cut words. Overflow
   text is a defect the postcheck must catch.
4. **Placeholders keep semantics**: write into placeholder shapes (`.placeholders`) when
   available so title/body roles survive round-trips.
5. **Images**: set both width and height from the real aspect ratio; never stretch.
6. Charts: prefer a real chart part (`chart_data` + `add_chart`) over a picture of a chart -
   only a real chart stays editable and data-accurate.
7. Output to a new path (`-edited` suffix) unless in-place was explicitly requested.

## Step 3 - Postcheck (mandatory)

```python
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

def iter_text_frames(shapes, path=""):
    """Yield every logical text frame, including group members and table cells."""
    for shape in shapes:
        here = f"{path}/{shape.name}" if path else shape.name
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_text_frames(shape.shapes, here)
            continue
        if shape.has_text_frame:
            yield here, shape.text_frame
        if shape.has_table:
            for row_index, row in enumerate(shape.table.rows):
                for column_index, cell in enumerate(row.cells):
                    if cell.is_spanned:  # a covered merge slot is intentionally empty
                        continue
                    yield f"{here}/table[{row_index},{column_index}]", cell.text_frame

prs = Presentation("output.pptx")
print("slides:", len(prs.slides))
for i, slide in enumerate(prs.slides):
    inventory = [(location, frame.text) for location, frame in iter_text_frames(slide.shapes)]
    print(i, len(slide.shapes), inventory)

# Populate this only with locations intentionally left blank by the task.
intentionally_empty_locations = set()
unexpected_empty_locations = [
    (slide_index, location)
    for slide_index, slide in enumerate(prs.slides)
    for location, frame in iter_text_frames(slide.shapes)
    if not frame.text.strip()
    and (slide_index, location) not in intentionally_empty_locations
]
if unexpected_empty_locations:
    raise ValueError(f"unexpected empty text frames: {unexpected_empty_locations}")
```

Confirm: slide count matches the outline; every slide has its intended title text; no text
frame is empty that should not be. If `soffice` exists, render to PDF and check the page count
equals the slide count:

```bash
soffice --headless --convert-to pdf output.pptx --outdir <tmp>
```

Page count is only a structural smoke test. Rasterize and inspect **every rendered slide** for
horizontal clipping and for a final line clipped or missing at the bottom; follow the text-fit
procedure in [references/analyze.md](references/analyze.md). Fix and render again if any text
overflows. If no production-equivalent renderer is available, report overflow as unverified -
do not claim that shape bounds or page count prove that text fits.

Report: output path, slide inventory (index, layout name, title), verification done, and any
remaining layout risks (long CJK strings, tight two-column slides).
