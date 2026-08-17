# CJK typography in DOCX (Chinese, Japanese, Korean)

python-docx is Latin-first: `run.font.name` writes only the `w:ascii` and `w:hAnsi` slots.
Chinese text renders from the `w:eastAsia` slot, so a "font is wrong in Word but fine in
LibreOffice" report almost always means the east-asian face was never set.

## Set the CJK face explicitly

```python
from docx.oxml.ns import qn

LATIN, EAST_ASIAN = "Times New Roman", "宋体"   # define both names once, up front

def set_fonts(run, latin=LATIN, east_asian=EAST_ASIAN):
    run.font.name = latin                      # writes w:ascii + w:hAnsi
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.get_or_add_rFonts()
    rFonts.set(qn("w:eastAsia"), east_asian)   # python-docx has no helper for this slot

# Style level: do the same on the style so body text inherits it
style = doc.styles["Normal"]
style.font.name = LATIN
style.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), EAST_ASIAN)
```

Convention for mixed-script body text: CJK glyphs from the east-asian face, digits and Latin
from a Latin face (Times New Roman or Arial). Both slots set = deterministic rendering.

## Chinese font-size table (字号)

Word's Chinese UI names map to point sizes; scripts must use the points:

| 字号 | pt | typical use | 字号 | pt |
|---|---|---|---|---|
| 初号 | 42 | big covers | 小三 | 15 |
| 小初 | 36 | covers | 四号 | 14 |
| 一号 | 26 | 公文标题辅助 | 小四 | 12 |
| 小一 | 24 | | 五号 | 10.5 |
| 二号 | 22 | 公文标题 | 小五 | 9 |
| 小二 | 18 | section covers | 六号 | 7.5 |
| 三号 | 16 | 公文正文 | 七号 | 5.5 |
| | | | 八号 | 5 |

Common pairings: 正文宋体小四 (reports), 仿宋三号 (official documents), 黑体 for headings at
one size step above the body.

## Paragraph properties CJK actually needs

```python
from docx.shared import Pt

pPr = p._p.get_or_add_pPr()

# First-line indent of exactly two characters - use the char-based attribute, not twips,
# so the indent survives font-size changes
ind = pPr.get_or_add_ind()
ind.set(qn("w:firstLineChars"), "200")        # units are 1/100 of a character

# Fixed line spacing (公文 practice: 28-30 pt fixed; pick one value and stay consistent)
p.paragraph_format.line_spacing = Pt(28)      # writes w:line=560, w:lineRule="exact"
```

- Word's CJK defaults (kinsoku line-breaking, auto space between CJK and Latin) live in
  document defaults and need no action unless the source file disabled them.
- Do not fake a two-char indent with spaces or full-width spaces; `firstLineChars` is the
  durable mechanism and survives re-flow.
- Justify body text (`WD_ALIGN_PARAGRAPH.JUSTIFY`); CJK justification is the expected look.

## Official-document page geometry (GB/T 9704 family)

Public-standard values for 党政机关公文 style documents on A4 - always confirm the user's
edition before promising compliance:

```python
from docx.shared import Cm

section = doc.sections[0]
section.top_margin, section.bottom_margin = Cm(3.7), Cm(3.5)
section.left_margin, section.right_margin = Cm(2.8), Cm(2.6)
# conventional target density with 三号仿宋 body: ~22 lines per page, ~28 chars per line
```

## Font availability is a delivery risk

- `宋体`/`黑体`/`楷体` exist on Chinese Windows; `仿宋_GB2312` may not. Non-Chinese systems
  substitute silently. Report the faces you referenced and expected substitutions in the
  postcheck summary.
- python-docx cannot embed fonts. If the recipient machine is unknown and the layout must be
  exact, say so and suggest embedding from Word (File > Options > Save > Embed fonts), or
  deliver a PDF alongside.

## Postcheck additions for CJK documents

1. Re-open the output and assert the east-asian slot is set on body runs and styles
   (`.get(qn("w:eastAsia"))` is not None) - not just `run.font.name`.
2. Tofu (missing-glyph boxes) cannot be detected by text extraction: the rendered PDF's text
   layer keeps the original codepoint while the glyph is a box, so "extracted text matches"
   proves nothing about rendering. Check glyph coverage directly instead - with fontTools
   (`pip install fonttools`) when the referenced faces can be located:

   ```python
   from docx import Document
   from docx.enum.style import WD_STYLE_TYPE
   from fontTools.ttLib import TTFont
   from docx.oxml.ns import qn
   from docx.text.paragraph import Paragraph
   from docx.text.run import Run

   doc = Document("output.docx")
   normal_style = doc.styles["Normal"]
   def paragraph_runs(paragraph):
       def walk(element):
           for child in element.iterchildren():
               if child.tag == qn("w:r"):
                   yield Run(child, paragraph)
               elif child.tag != qn("w:p"):
                   yield from walk(child)
       yield from walk(paragraph._p)

   def xml_runs(element, parent):
       # Covers paragraphs in tables/block controls and runs in inline controls/hyperlinks.
       for paragraph_element in element.iter(qn("w:p")):
           yield from paragraph_runs(Paragraph(paragraph_element, parent))

   emitted_runs = list(xml_runs(doc.element.body, doc))
   for section in doc.sections:
       emitted_runs.extend(xml_runs(section.header._element, section.header))
       emitted_runs.extend(xml_runs(section.footer._element, section.footer))

   def face_from_rpr(rpr, slot):
       if rpr is None:
           return None
       rfonts = rpr.find(qn("w:rFonts"))
       if rfonts is None:
           return None
       theme_attribute = {
           "ascii": "asciiTheme", "hAnsi": "hAnsiTheme",
           "eastAsia": "eastAsiaTheme", "cs": "cstheme",
       }[slot]
       theme_token = rfonts.get(qn("w:" + theme_attribute))
       if theme_token is not None:
           # A direct theme declaration must not fall through to an inherited literal face.
           # Resolve the document theme/fontScheme (including themeFontLang/script mapping)
           # before auditing this run. Both a literal and theme attribute for one slot are
           # ambiguous across consumers, so fail closed in that case too.
           literal = rfonts.get(qn("w:" + slot))
           raise LookupError(
               f"unresolved direct {theme_attribute}={theme_token!r}"
               + (f" alongside {slot}={literal!r}" if literal is not None else "")
           )
       return rfonts.get(qn("w:" + slot))

   def style_faces(style, slot):
       while style is not None:
           face = face_from_rpr(style.element.find(qn("w:rPr")), slot)
           if face:
               yield face
           style = style.base_style

   def table_style_faces(run, slot):
       """Find table/conditional style faces that python-docx does not cascade for runs."""
       element = run._r
       while element is not None and element.tag != qn("w:tbl"):
           element = element.getparent()
       if element is None:
           return []
       table_properties = element.find(qn("w:tblPr"))
       table_style = None if table_properties is None else table_properties.find(qn("w:tblStyle"))
       style_id = None if table_style is None else table_style.get(qn("w:val"))
       style = None if not style_id else doc.styles.get_by_id(style_id, WD_STYLE_TYPE.TABLE)
       faces = []
       while style is not None:
           rprs = [style.element.find(qn("w:rPr"))]
           rprs.extend(
               region.find(qn("w:rPr"))
               for region in style.element.findall(qn("w:tblStylePr"))
           )
           faces.extend(face for rpr in rprs if (face := face_from_rpr(rpr, slot)))
           style = style.base_style
       return list(dict.fromkeys(faces))

   def effective_face(run, slot):
       direct = face_from_rpr(run._r.find(qn("w:rPr")), slot)
       if direct:
           return direct
       if faces := table_style_faces(run, slot):
           raise LookupError(
               f"table style can override {slot} with {faces}; resolve the applicable "
               "tblStylePr region or require rendered inspection"
           )
       # Header/footer runs belong to a HeaderPart/FooterPart, which has no .document.
       # Resolve the owning document's Normal style once rather than via run.part.
       for style in (run.style, run._parent.style, normal_style):
           if face := next(style_faces(style, slot), None):
               return face
       raise LookupError(f"no resolved {slot} face for run {run.text!r}; resolve theme defaults")

   def font_slot(character):
       # This is the ordinary non-cs/rtl mapping. Resolve effective w:cs/w:rtl and special
       # w:rFonts@w:hint overrides separately before relying on a slot for those runs.
       codepoint = ord(character)
       uses_east_asian_slot = (
           0x1100 <= codepoint <= 0x11FF       # Hangul Jamo
           or 0x2E80 <= codepoint <= 0x9FFF   # CJK radicals, kana, bopomofo, ideographs
           or 0x3130 <= codepoint <= 0x318F   # Hangul compatibility Jamo
           or 0xA000 <= codepoint <= 0xA4CF   # Yi syllables and radicals
           or 0xA960 <= codepoint <= 0xA97F   # Hangul Jamo Extended-A
           or 0xAC00 <= codepoint <= 0xD7FF   # Hangul syllables and Extended-B
           or 0xF900 <= codepoint <= 0xFAFF   # CJK compatibility ideographs
           or 0xFE30 <= codepoint <= 0xFE6F   # CJK compatibility and small forms
           or 0xFF00 <= codepoint <= 0xFFEF   # fullwidth and halfwidth forms
           or 0x20000 <= codepoint <= 0x3134F  # CJK unified ideograph extensions
       )
       return "eastAsia" if uses_east_asian_slot else (
           "ascii" if codepoint < 128 else "hAnsi"
       )

   # Resolve installed files by exact face name first; do not pool their cmaps.
   # TTC collections need the face's fontNumber; ordinary TTF files use -1.
   font_files_by_face = {
       "宋体": ("path/to/simsun.ttc", 0),
       "Times New Roman": ("path/to/times.ttf", -1),
   }
   cmaps = {}
   missing = []
   unresolved = []
   for run_index, run in enumerate(emitted_runs):
       for character in run.text:
           if character.isspace():
               continue
           face = effective_face(run, font_slot(character))
           font_spec = font_files_by_face.get(face)
           if not font_spec:
               unresolved.append((run_index, character, face))
               continue
           if font_spec not in cmaps:
               font_path, font_number = font_spec
               cmaps[font_spec] = TTFont(font_path, fontNumber=font_number).getBestCmap()
           cmap = cmaps[font_spec]
           if ord(character) not in cmap:
               missing.append((run_index, character, face))
   # These are mandatory audit gates, so raise explicitly: `python -O` removes asserts.
   if unresolved:
       raise ValueError(f"font files not resolved per run: {unresolved}")
   if missing:
       raise ValueError(f"glyph missing from the run's effective font: {missing}")
   ```

   When font files cannot be located, rasterize the rendered pages with PyMuPDF and inspect
   the images visually, and say in the report that glyph rendering was not machine-verified.
3. Confirm `firstLineChars` survived on body paragraphs if the indent was requested.
