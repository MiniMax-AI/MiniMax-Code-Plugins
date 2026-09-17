# Create a PDF with ReportLab

Use flowables (the Platypus layer) so pagination, spacing, and style separation work for you.

## Skeleton

```python
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                ListFlowable, ListItem, KeepTogether)

styles = getSampleStyleSheet()
h1 = ParagraphStyle("H1x", parent=styles["Heading1"], fontSize=16, spaceAfter=6)
body = ParagraphStyle("Bodyx", parent=styles["BodyText"], fontSize=10, leading=14)

doc = SimpleDocTemplate(
    "output.pdf",
    pagesize=A4,
    leftMargin=20*mm, rightMargin=20*mm, topMargin=18*mm, bottomMargin=18*mm,
    title="Q3 launch checklist", author="document-skills",
)

story = [
    Paragraph("Q3 Launch Checklist", h1),
    Spacer(1, 4*mm),
    Paragraph("Owner: platform team. Scope: EU region rollout.", body),
    Spacer(1, 6*mm),
]

data = [["#", "Item", "Owner", "Status"],
        ["1", "Freeze scope", "PM", "done"],
        ["2", "Load test at 2x", "SRE", "planned"]]
tbl = Table(data, colWidths=[10*mm, 70*mm, 30*mm, 25*mm])
tbl.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#1a3c6e")),
    ("TEXTCOLOR", (0,0), (-1,0), colors.white),
    ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
    ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.white, colors.HexColor("#eef2f7")]),
    ("GRID", (0,0), (-1,-1), 0.4, colors.HexColor("#9aa7b4")),
    ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
    ("TOPPADDING", (0,0), (-1,-1), 4),
    ("BOTTOMPADDING", (0,0), (-1,-1), 4),
]))
story.append(tbl)
story.append(Spacer(1, 6*mm))
story.append(ListFlowable(
    [ListItem(Paragraph("Dry-run in staging with production-shaped data", body))],
    bulletType="bullet",
))
doc.build(story)
```

## Rules

- **Escape plain text before Paragraph**: `Paragraph` parses its string as XML-ish markup, so
  user-provided prose containing `&` or `<` raises a parse error or renders wrong. Escape
  everything that is data; use markup only for strings you authored as markup:

  ```python
  from xml.sax.saxutils import escape

  def para(text, style):
      return Paragraph(escape(text), style)      # & < > become entity-safe
  ```

  The same applies to `ListItem(Paragraph(...))` and to table cell strings when they flow
  through `Paragraph`.
- **Exactly-one-page constraint**: after `build`, run the postcheck. Over budget -> reduce
  `leading`, tighten `spaceBefore/After`, cut rows - in that order of preference. Under budget
  is usually fine; add a spacer or scale the title block.
- **Keep blocks atomic**: wrap heading + first paragraph (or a table and its caption) in
  `KeepTogether` so pagination does not orphan them.
- **Two columns** only via frames/PageTemplates; never by positioning two columns on one
  canvas manually unless you are in full-canvas mode with measured coordinates.
- **Full-canvas mode** (`canvas` API) is for fixed-layout artifacts: badges, certificates,
  posters with absolute geometry. Measure text with `pdfmetrics.stringWidth` before placing;
  never guess whether a string fits.
- **Links**: internal links via bookmarks/anchors, external via `linkURL`; declare the URL
  visibly next to the link text when the PDF may be printed.
- **Images**: `Image(path, width=..., height=...)` with both dimensions set from the real
  aspect ratio (PIL or PyMuPDF can measure).
