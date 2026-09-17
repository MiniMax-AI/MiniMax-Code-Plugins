# Create a new DOCX

Use python-docx from an outline. Never assemble the ZIP by hand.

## Pattern

```python
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()

# 1. Page geometry (A4 default is US Letter in python-docx - set explicitly)
for section in doc.sections:
    section.page_width, section.page_height = Cm(21.0), Cm(29.7)
    section.left_margin = section.right_margin = Cm(2.5)
    section.top_margin = section.bottom_margin = Cm(2.5)

# 2. Semantic outline: title + headings drive navigation and TOC
doc.add_heading("Quarterly Reliability Report", level=0)   # uses Title style
doc.add_heading("Summary", level=1)
doc.add_heading("Incident review", level=2)

# 3. Body paragraphs; set spacing once via style, not per paragraph
style = doc.styles["Normal"]
style.font.name = "Calibri"
style.font.size = Pt(11)
style.paragraph_format.space_after = Pt(6)
style.paragraph_format.line_spacing = 1.15

p = doc.add_paragraph("Text with ")
p.add_run("bold segment").bold = True
p.add_run(" and regular text.")

# 4. Tables with header row emphasis
table = doc.add_table(rows=1, cols=3)
table.style = "Light Grid Accent 1"
hdr = table.rows[0].cells
for cell, text in zip(hdr, ["Region", "Incidents", "MTTR (h)"]):
    cell.text = text
    for par in cell.paragraphs:
        for run in par.runs:
            run.font.bold = True
row = table.add_row().cells
row[0].text, row[1].text, row[2].text = "eu-1", "3", "0.8"

# 5. Optional footer with page number field
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
footer = doc.sections[0].footer
fp = footer.paragraphs[0]
fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
fld = OxmlElement("w:fldSimple")
fld.set(qn("w:instr"), "PAGE")
fp._p.append(fld)

doc.save("report.docx")
```

## Rules

- Build the heading outline **before** writing prose; a wrong outline is the most expensive
  late fix.
- One table style per document. Cell-level font overrides are for exceptions only.
- Bullet lists: `add_paragraph(text, style="List Bullet")`. Numbered lists: `style="List
  Number"` - but reusing that style makes every list **continue** the same sequence, because
  all paragraphs share one numbering definition. When a second list must restart at 1, clone
  the numbering definition and point the new list's paragraphs at the clone:

  ```python
  import copy
  from docx.oxml.ns import qn
  from docx.oxml import OxmlElement
  from docx.opc.constants import RELATIONSHIP_TYPE as RT

  def new_restart_num_id(doc, base_num_id):
      """Clone <w:num> base_num_id with a startOverride so the next list restarts at 1."""
      numbering = doc.part.part_related_by(RT.NUMBERING).element
      source = next(
          n for n in numbering.findall(qn("w:num"))
          if n.get(qn("w:numId")) == str(base_num_id)
      )
      clone = copy.deepcopy(source)
      new_id = max(int(n.get(qn("w:numId"))) for n in numbering.findall(qn("w:num"))) + 1
      clone.set(qn("w:numId"), str(new_id))
      level_zero_overrides = [
          item for item in clone.findall(qn("w:lvlOverride"))
          if item.get(qn("w:ilvl")) == "0"
      ]
      if len(level_zero_overrides) > 1:
          raise ValueError("base numbering has duplicate level-zero overrides")
      if level_zero_overrides:
          override = level_zero_overrides[0]
          for old_start in override.findall(qn("w:startOverride")):
              override.remove(old_start)
      else:
          override = OxmlElement("w:lvlOverride")
          override.set(qn("w:ilvl"), "0")
          clone.append(override)
      start = OxmlElement("w:startOverride")
      start.set(qn("w:val"), "1")
      override.insert(0, start)  # startOverride precedes an optional embedded w:lvl
      numbering.append(clone)
      return new_id

  def numbered_paragraph(doc, text, num_id):
      p = doc.add_paragraph(text, style="List Number")
      pPr = p._p.get_or_add_pPr()
      numPr = OxmlElement("w:numPr")
      ilvl = OxmlElement("w:ilvl"); ilvl.set(qn("w:val"), "0")
      numId = OxmlElement("w:numId"); numId.set(qn("w:val"), str(num_id))
      numPr.append(ilvl); numPr.append(numId)
      pPr.append(numPr)
      return p

  # Find the numId behind "List Number" in numbering.xml (inspect it once, then hard-code),
  # then give each independent list its own cloned definition.
  ```
- Images: `doc.add_picture(path, width=Cm(14))` - always set width so oversized images do not
  overflow the text column. Keep aspect ratio by setting only one dimension.
- A real TOC is a **field**, it renders after the user opens the file and updates fields
  (Word prompts, or Ctrl+A then F9). If a TOC is requested, insert the field and tell the user
  it needs one field refresh; optionally pre-populate static entries from your outline.
- Do not attempt pixel-exact page design (complex multi-column covers, inline floating
  wrap). If the user wants that fidelity, produce the PDF route instead.

## Quality bar

- Heading levels never skip (no Heading 1 straight to Heading 3).
- No empty sections: every heading is followed by content or removed.
- Numbers in tables right-aligned; units declared in the header.
