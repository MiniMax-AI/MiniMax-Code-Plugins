# Read / extract a DOCX

Pick by fidelity needed.

## Fast text extraction (pandoc, if installed)

```bash
pandoc -t markdown input.docx -o extracted.md
```

Best structural fidelity for prose (headings become markdown headings, tables become pipe
tables). Prefer this when the goal is content, not coordinates.

## Structured access (python-docx)

```python
from docx import Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.text.run import Run

def iter_part_blocks(root, parent):
    """Yield each paragraph/table once, descending through block content controls."""
    for child in root.iterchildren():
        if child.tag == qn("w:p"):
            yield "paragraph", Paragraph(child, parent)
        elif child.tag == qn("w:tbl"):
            yield "table", Table(child, parent)
        elif child.tag == qn("w:altChunk"):
            relationship_id = child.get(qn("r:id"))
            part = getattr(parent, "part", None)
            relationship = None if part is None else part.rels.get(relationship_id)
            yield "unreadable", {
                "kind": "altChunk",
                "relationship_id": relationship_id,
                "target": None if relationship is None else relationship.target_ref,
                "content_type": None if relationship is None or relationship.is_external
                else relationship.target_part.content_type,
            }
        else:
            yield from iter_part_blocks(child, parent)

def iter_paragraph_runs(paragraph):
    """Include runs wrapped by hyperlinks, fields, revisions, or inline content controls."""
    def walk(element):
        for child in element.iterchildren():
            if child.tag == qn("w:r"):
                yield Run(child, paragraph)
            elif child.tag != qn("w:p"):  # nested text-box paragraphs are yielded separately
                yield from walk(child)
    yield from walk(paragraph._p)

def legacy_symbol_record(symbol):
    """Report font-specific w:sym content without guessing at a Unicode mapping."""
    font = symbol.get(qn("w:font"))
    character = symbol.get(qn("w:char"))
    return f"[unreadable legacy symbol font={font!r} char={character!r}]"

def run_text(run):
    pieces = []
    for child in run._r.xpath(
        "w:br | w:cr | w:noBreakHyphen | w:ptab | w:t | w:tab | w:sym"
    ):
        pieces.append(legacy_symbol_record(child) if child.tag == qn("w:sym") else str(child))
    return "".join(pieces)

def paragraph_text(paragraph):
    return "".join(run_text(run) for run in iter_paragraph_runs(paragraph))

def tc_text(tc, parent):
    """Cell text rebuilt per paragraph, keeping tabs and breaks visible.

    Joining only the w:t descendants concatenates separate paragraphs
    ("First" + "Second" -> "FirstSecond") and loses separators entirely.
    """
    paragraphs = []
    for kind, block in iter_part_blocks(tc, parent):
        if kind != "paragraph":  # nested tables are represented recursively, not duplicated here
            continue
        pieces = []
        for node in block._p.iter():
            if node.tag == qn("w:t"):
                pieces.append(node.text or "")
            elif node.tag == qn("w:tab"):
                pieces.append("<tab>")
            elif node.tag in (qn("w:br"), qn("w:cr")):
                pieces.append("<br>")
            elif node.tag == qn("w:sym"):
                pieces.append(legacy_symbol_record(node))
        paragraphs.append("".join(pieces))
    return " / ".join(paragraphs)

def table_content(table):
    rows = []
    for row in table.rows:
        rendered_cells = []
        row_properties = row._tr.find(qn("w:trPr"))
        grid_before_node = None if row_properties is None else row_properties.find(qn("w:gridBefore"))
        grid_after_node = None if row_properties is None else row_properties.find(qn("w:gridAfter"))
        grid_before = 0 if grid_before_node is None else int(grid_before_node.get(qn("w:val"), "0"))
        grid_after = 0 if grid_after_node is None else int(grid_after_node.get(qn("w:val"), "0"))
        column = grid_before
        # row.cells repeats a merge-origin proxy for every grid position it spans.
        # Walk physical w:tc elements and expose the merge structure instead.
        for cell_element in row._tr.tc_lst:
            cell_properties = cell_element.find(qn("w:tcPr"))
            grid_span = None if cell_properties is None else cell_properties.find(qn("w:gridSpan"))
            colspan = 1 if grid_span is None else int(grid_span.get(qn("w:val"), "1"))
            vertical = None if cell_properties is None else cell_properties.find(qn("w:vMerge"))
            vertical_merge = None if vertical is None else vertical.get(qn("w:val"), "continue")
            nested_tables = []
            unreadable = []
            for kind, block in iter_part_blocks(cell_element, table):
                if kind == "table":
                    nested_tables.append(table_content(block))
                elif kind == "unreadable":
                    unreadable.append(block)
            rendered_cells.append({
                "column": column, "colspan": colspan,
                "vMerge": vertical_merge,
                "text": tc_text(cell_element, table),
                "tables": nested_tables,
                "unreadable": unreadable,
            })
            column += colspan
        rows.append({
            "grid_before": grid_before,
            "cells": rendered_cells,
            "grid_after": grid_after,
        })
    return rows

doc = Document("input.docx")
content_controls = list(doc.element.body.iter(qn("w:sdt")))
blocks = list(iter_part_blocks(doc.element.body, doc))
print("content controls:", len(content_controls), "top-level blocks:", len(blocks))
for kind, block in blocks:
    if kind == "paragraph":
        print(block.style.name, "|", paragraph_text(block))
    elif kind == "table":
        print("table |", table_content(block))
    else:
        print("unreadable |", block)
```

Notes:

- `doc.paragraphs` includes only direct body paragraphs, `doc.tables` includes only direct body
  tables, and `Paragraph.runs` omits runs wrapped by inline content controls and other containers.
  Use the XML-backed traversal above and report the content-control count. It stops descending
  when a table is yielded, so table text is not also emitted as prose; `table_content()` handles
  nested tables recursively and emits `grid_before`, `grid_after`, `column`, `colspan`, and
  `vMerge` metadata for physical cells instead of duplicating merge-origin text through
  `row.cells`. The row-level grid omissions are required for nonuniform tables whose cells do
  not start in logical column zero or do not extend to the final grid column.
  Imported `w:altChunk` HTML/RTF/document parts are not modeled by python-docx; the traversal
  reports their relationship target and content type as `unreadable` instead of silently
  presenting an incomplete extraction. Convert them with a trusted office renderer before
  claiming their content was read. Each table-cell record carries its own `unreadable` list so
  an import nested in a cell is not lost from the report.
  A legacy `w:sym` code is specific to its symbol font, so the helpers preserve its position
  as an explicit unreadable record containing the font and character code rather than silently
  dropping visible content or guessing a Unicode character.
  Text boxes, headers, footers, and footnotes still require their own collections
  (`section.header/.footer`) or raw XML.
- For revision/comment metadata, inspect the XML parts directly: `word/comments.xml`,
  `w:ins`/`w:del` elements in `word/document.xml`.

## Reporting contract

When summarizing a document for the user, lead with: heading outline, paragraph count, table
count with dimensions, and any parts that could not be read. Do not silently skip unreadable
parts.
