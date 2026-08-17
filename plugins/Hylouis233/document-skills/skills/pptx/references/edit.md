# Edit an existing deck

## Locate by content, then edit narrowly

```python
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

prs = Presentation("input.pptx")

old, new = "old wording", "new wording"
slide_index = None                 # Set this and shape_name when repeated text is expected.
shape_name = None
target_location = None             # e.g. "Table 1/table[0,1]" for duplicate table text

def require(condition, message):
    if not condition:
        raise ValueError(message)

def iter_shapes(shapes, path=""):
    """Yield (path, shape) for every shape, recursing into groups so text inside
    grouped artwork is reachable; the path keeps the uniqueness check readable."""
    for shape in shapes:
        here = f"{path}/{shape.name}" if path else shape.name
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_shapes(shape.shapes, here)
        else:
            yield here, shape

def iter_text_targets(path, shape):
    if shape.has_text_frame:
        yield path, shape.text_frame
    if shape.has_table:
        for row_index, row in enumerate(shape.table.rows):
            for column_index, cell in enumerate(row.cells):
                yield f"{path}/table[{row_index},{column_index}]", cell.text_frame

candidates = []
for i, slide in enumerate(prs.slides):
    if slide_index is not None and i != slide_index:
        continue
    for path, shape in iter_shapes(slide.shapes):
        if shape_name is not None and shape.name != shape_name:
            continue
        for location, text_frame in iter_text_targets(path, shape):
            if target_location is not None and location != target_location:
                continue
            if old in text_frame.text:
                candidates.append((i, location, text_frame))

locations = [(i, location) for i, location, _ in candidates]
require(len(candidates) == 1, f"expected one matching text target, found {locations}")
_, _, tf = candidates[0]

# Replace inside one existing run so its formatting and hyperlink are retained.
require(tf.text.count(old) == 1, "target occurs more than once in the selected shape")
run_hits = [
    run
    for paragraph in tf.paragraphs
    for run in paragraph.runs
    if old in run.text
]
require(len(run_hits) == 1 and run_hits[0].text.count(old) == 1, (
    "target is duplicated or split across runs; report it instead of flattening the paragraph"
))
run_hits[0].text = run_hits[0].text.replace(old, new, 1)

prs.save("input-edited.pptx")
```

## Rules

1. **Never rebuild the file to make a small change.** Rewriting slides from scratch loses the
   template, masters, notes, and animations. Edit in place, save to a new path.
2. Address shapes by slide index + shape name or matched text, and **require exactly one match**
   with an explicit exception (never a Python `assert`, which `python -O` removes).
   The locator must search both shape text frames and every table cell, retaining a stable
   `/table[row,column]` suffix. If copy repeats inside one table, set `target_location` as well as
   the slide/shape selectors rather than choosing one.
3. For formatted text, change `run.text` only when the target is wholly inside one run. Assigning
   `paragraph.text` or `text_frame.text` rebuilds runs and can discard run formatting and links.
   If the target spans runs, stop and make an explicitly reviewed run/XML edit.
4. Table cells are edited at run level exactly like shape text: iterate
   `table.cell(r, c).text_frame.paragraphs` and change `run.text`. Assigning `cell.text`
   (or `.text` on the text frame) rebuilds the frame and discards per-run formatting and
   hyperlinks:

   ```python
   cell = table.cell(2, 1)
   hits = [run for p in cell.text_frame.paragraphs for run in p.runs if old in run.text]
   if len(hits) != 1 or hits[0].text.count(old) != 1:
       raise ValueError("target is duplicated or split across runs in this cell")
   hits[0].text = hits[0].text.replace(old, new, 1)
   ```
5. Chart data: `chart.replace_data(CategoryChartData(...))` updates the embedded workbook and
   the plot together - do not hand-edit the XML series.
6. Reordering slides means moving the underlying `sldIdLst` entries; do it only on request and
   verify order in the postcheck.
7. Group shapes: iterate `shape.shapes` recursively to reach members; python-pptx will not
   ungroup for you - do not try to flatten groups.
