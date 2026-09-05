# Minimal runnable fixtures for the snippets called out in review: one file per format.
# Each script is self-contained, writes only scratch files into the current directory,
# and exits non-zero on failed assertions. Run from any scratch directory:
#   python pdf_fixture.py   (deps: reportlab, pypdf, pymupdf)
#   python pptx_fixture.py  (deps: python-pptx)
#   python xlsx_fixture.py  (deps: openpyxl)
#   python docx_fixture.py  (deps: python-docx, pymupdf, soffice on PATH)
import math
import os
import re
import sys

import fitz
import pypdf
import reportlab
from pypdf.generic import (
    ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject,
    NameObject, NullObject, NumberObject,
)
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

failures = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ((" :: " + str(extra)) if not cond and extra else ""))
    if not cond:
        failures.append(name)


def open_pdf(path, password=None):
    reader = pypdf.PdfReader(path)
    if reader.is_encrypted:
        if not password or reader.decrypt(password) == 0:
            raise RuntimeError(f"valid password required for {path}")
    return reader


def authenticate_for_extraction(document, password=None):
    """Mirror extract.md: try the valid blank user password before requiring env input."""
    if document.needs_pass and document.authenticate("") <= 0:
        if not password or document.authenticate(password) <= 0:
            raise RuntimeError("set PDF_PASSWORD to the correct password before extracting")


class BlankPasswordDocument:
    needs_pass = True

    def __init__(self):
        self.attempts = []

    def authenticate(self, password):
        self.attempts.append(password)
        return 2 if password == "" else 0


blank_password_stub = BlankPasswordDocument()
authenticate_for_extraction(blank_password_stub)
check("PDF extraction authenticates the blank password before requiring environment input",
      blank_password_stub.attempts == [""], blank_password_stub.attempts)


# ---- build a 2-page A4 PDF with one AcroForm text field on page 1 -------------
c = canvas.Canvas("form.pdf", pagesize=A4)
c.setFont("Helvetica", 16)
c.drawString(72, 780, "Application form")
c.acroForm.textfield(name="applicant_name", x=72, y=740, width=260, height=20, borderWidth=0)
c.showPage()
c.setFont("Helvetica", 16)
c.drawString(72, 780, "Second page content")
c.save()

# Current PyMuPDF opens a permission-encrypted PDF with an empty user password directly
# (`needs_pass == 0`). Keep this real-file proof in addition to the branch-order stub above.
blank_user_writer = pypdf.PdfWriter()
blank_user_writer.append(pypdf.PdfReader("form.pdf"))
blank_user_writer.encrypt(user_password="", owner_password="fixture-owner")
with open("blank-user-password.pdf", "wb") as output:
    blank_user_writer.write(output)
blank_user_doc = fitz.open("blank-user-password.pdf")
authenticate_for_extraction(blank_user_doc)
check("blank-user permission-encrypted PDF extracts without PDF_PASSWORD",
      "Application form" in blank_user_doc[0].get_text(), blank_user_doc.needs_pass)
blank_user_doc.close()

check("ordinary ReportLab output is not a tagged PDF/UA document",
      "/StructTreeRoot" not in pypdf.PdfReader("form.pdf").trailer["/Root"])

# ---- SKILL.md postcheck snippet: width/height pairs from the 4-coordinate box --
r = pypdf.PdfReader("form.pdf")
page_sizes = [
    (float(page.mediabox.width), float(page.mediabox.height))
    for page in r.pages
]
A4_TOLERANCE = 0.5
check(
    "mediabox width/height is A4 on every page",
    all(abs(w - 595.2755) < A4_TOLERANCE and abs(h - 841.8897) < A4_TOLERANCE for w, h in page_sizes),
    page_sizes,
)


def verify_page_count(reader, expected_page_count):
    page_count = len(reader.pages)
    if page_count != expected_page_count:
        raise ValueError(f"expected {expected_page_count} pages, got {page_count}")
    return page_count


check("postcheck accepts the requested page count", verify_page_count(r, 2) == 2)
try:
    verify_page_count(r, 1)
    page_count_mismatch = ""
except ValueError as exc:
    page_count_mismatch = str(exc)
check("postcheck rejects a page-count mismatch even under python -O",
      page_count_mismatch == "expected 1 pages, got 2", page_count_mismatch)

# ---- inspect.md distinguishes referenced-only and embedded fonts ---------------
pdfmetrics.registerFont(TTFont("FixtureVera", os.path.join(
    os.path.dirname(reportlab.__file__), "fonts", "Vera.ttf",
)))
font_canvas = canvas.Canvas("font-inventory.pdf", pagesize=A4)
font_canvas.setFont("Helvetica", 12)  # standard PDF face, normally referenced only
font_canvas.drawString(72, 780, "Referenced Helvetica")
font_canvas.setFont("FixtureVera", 12)
font_canvas.drawString(72, 750, "Embedded Vera")
font_canvas.save()

DIRECT_CHARPROC_NAME = re.compile(
    r"/(?:#[0-9A-Fa-f]{2}|[^#\s()<>\[\]{}/%])+"
)
DIRECT_CHARPROC_REFERENCE = re.compile(r"\s+([1-9]\d*)\s+\d+\s+R")


def indirect_xref(value):
    match = re.fullmatch(r"\s*([1-9]\d*)\s+\d+\s+R\s*", value or "")
    return int(match.group(1)) if match else None


def direct_charproc_xrefs(value):
    value = (value or "").strip()
    if not value.startswith("<<") or not value.endswith(">>"):
        return "uninspectable", []
    body = value[2:-2]
    position = 0
    references = []
    while position < len(body):
        while position < len(body) and body[position].isspace():
            position += 1
        if position == len(body):
            break
        name_match = DIRECT_CHARPROC_NAME.match(body, position)
        if name_match is None:
            return "uninspectable", []
        reference_match = DIRECT_CHARPROC_REFERENCE.match(body, name_match.end())
        if reference_match is None:
            return "malformed", []
        references.append(int(reference_match.group(1)))
        position = reference_match.end()
    return ("parsed", references) if references else ("malformed", [])


def type3_charprocs_status(document, xref, font_type):
    if font_type.replace(" ", "").casefold() != "type3":
        return None
    if xref <= 0:
        return "uninspectable"
    try:
        charprocs_type, charprocs_value = document.xref_get_key(xref, "CharProcs")
    except (RuntimeError, ValueError):
        return "uninspectable"
    if charprocs_type == "dict":
        parse_status, glyph_xrefs = direct_charproc_xrefs(charprocs_value)
        if parse_status != "parsed":
            return parse_status
    elif charprocs_type == "xref":
        dictionary_xref = indirect_xref(charprocs_value)
        if dictionary_xref is None:
            return "malformed"
        try:
            dictionary_source = document.xref_object(dictionary_xref, compressed=True)
            dictionary_is_stream = document.xref_is_stream(dictionary_xref)
        except (RuntimeError, ValueError):
            return "uninspectable"
        dictionary_source = dictionary_source.strip()
        if (dictionary_is_stream or not dictionary_source.startswith("<<")
                or not dictionary_source.endswith(">>")):
            return "malformed"
        parse_status, glyph_xrefs = direct_charproc_xrefs(dictionary_source)
        if parse_status != "parsed":
            return parse_status
    else:
        return "malformed"
    for glyph_xref in glyph_xrefs:
        try:
            if not document.xref_is_stream(glyph_xref):
                return "malformed"
        except (RuntimeError, ValueError):
            return "uninspectable"
    return "verified"


def font_inventory(document, page):
    fonts = []
    for entry in page.get_fonts(full=True):
        xref, extension, font_type, base_name, resource_name, encoding = entry[:6]
        is_type3 = font_type.replace(" ", "").casefold() == "type3"
        charprocs_status = type3_charprocs_status(document, xref, font_type)
        embedded_bytes = 0
        if xref > 0:
            try:
                embedded_bytes = len((document.extract_font(xref)[3] or b""))
            except (RuntimeError, ValueError):
                embedded_bytes = 0
        if is_type3:
            embedded = (
                True if charprocs_status == "verified" else
                (False if charprocs_status == "malformed" else None)
            )
            self_contained = embedded
            program_source = "type3-charprocs"
        else:
            embedded = embedded_bytes > 0
            self_contained = None
            program_source = "font-file" if embedded_bytes else None
        fonts.append({
            "base_name": base_name, "type": font_type,
            "embedded": embedded,
            "embedded_bytes": embedded_bytes,
            "self_contained": self_contained,
            "charprocs_status": charprocs_status,
            "program_source": program_source,
        })
    return fonts

font_doc = fitz.open("font-inventory.pdf")
fonts = font_inventory(font_doc, font_doc[0])
check("font inventory labels the embedded TrueType face",
      any("Vera" in item["base_name"] and item["embedded"] is True for item in fonts), fonts)
check("font inventory labels referenced-only Helvetica as non-embedded",
      any("Helvetica" in item["base_name"] and item["embedded"] is False for item in fonts), fonts)

# A Type3 font stores each glyph as PDF content in /CharProcs rather than as an
# extractable conventional font file.


def write_type3_pdf(path, *, charprocs_kind="indirect-dict", direct_font=False):
    writer = pypdf.PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    glyph = DecodedStreamObject()
    glyph.set_data(b"500 0 0 0 500 700 d1 0 0 500 700 re f")
    glyph_ref = writer._add_object(glyph)
    glyph_name = NameObject(
        "/A/B" if charprocs_kind in {"direct-escaped-name", "indirect-escaped-name"}
        else "/A"
    )
    valid_charprocs = DictionaryObject({glyph_name: glyph_ref})
    if charprocs_kind == "indirect-dict":
        charprocs = writer._add_object(valid_charprocs)
    elif charprocs_kind == "indirect-escaped-name":
        charprocs = writer._add_object(valid_charprocs)
    elif charprocs_kind == "direct-dict":
        charprocs = valid_charprocs
    elif charprocs_kind == "direct-escaped-name":
        charprocs = valid_charprocs
    elif charprocs_kind == "empty-direct":
        charprocs = DictionaryObject()
    elif charprocs_kind == "direct-number-entry":
        charprocs = DictionaryObject({NameObject("/A"): NumberObject(42)})
    elif charprocs_kind == "indirect-array":
        charprocs = writer._add_object(ArrayObject([glyph_ref]))
    elif charprocs_kind == "indirect-number":
        charprocs = writer._add_object(NumberObject(42))
    elif charprocs_kind == "indirect-null":
        charprocs = writer._add_object(NullObject())
    elif charprocs_kind == "indirect-bad-glyph":
        bad_glyph_ref = writer._add_object(NumberObject(42))
        charprocs = writer._add_object(DictionaryObject({
            NameObject("/A"): bad_glyph_ref,
        }))
    else:
        raise ValueError(f"unsupported CharProcs fixture kind {charprocs_kind}")
    encoding = DictionaryObject({
        NameObject("/Type"): NameObject("/Encoding"),
        NameObject("/Differences"): ArrayObject([
            NumberObject(65), glyph_name,
        ]),
    })
    font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type3"),
        NameObject("/Name"): NameObject("/FType3"),
        NameObject("/FontBBox"): ArrayObject([
            NumberObject(0), NumberObject(0), NumberObject(500), NumberObject(700),
        ]),
        NameObject("/FontMatrix"): ArrayObject([
            FloatObject(0.001), NumberObject(0), NumberObject(0),
            FloatObject(0.001), NumberObject(0), NumberObject(0),
        ]),
        NameObject("/CharProcs"): charprocs,
        NameObject("/Encoding"): encoding,
        NameObject("/FirstChar"): NumberObject(65),
        NameObject("/LastChar"): NumberObject(65),
        NameObject("/Widths"): ArrayObject([NumberObject(500)]),
        NameObject("/Resources"): DictionaryObject(),
    })
    font_object = font if direct_font else writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/FType3"): font_object}),
    })
    content = DecodedStreamObject()
    content.set_data(b"BT /FType3 72 Tf 72 700 Td (A) Tj ET")
    page[NameObject("/Contents")] = writer._add_object(content)
    with open(path, "wb") as output:
        writer.write(output)


def type3_fixture_record(path):
    document = fitz.open(path)
    record = next(item for item in font_inventory(document, document[0])
                  if item["type"].replace(" ", "").casefold() == "type3")
    return document, record


write_type3_pdf("type3-font.pdf")
type3_doc = fitz.open("type3-font.pdf")
type3_entry = next(item for item in type3_doc[0].get_fonts(full=True)
                   if item[2].replace(" ", "").casefold() == "type3")
type3_extracted_bytes = type3_doc.extract_font(type3_entry[0])[3] or b""
type3_fonts = font_inventory(type3_doc, type3_doc[0])
type3_record = next(item for item in type3_fonts
                    if item["type"].replace(" ", "").casefold() == "type3")
check("Type3 negative control has no conventional extractable font-file bytes",
      type3_extracted_bytes == b"", len(type3_extracted_bytes))
check("Type3 glyph program renders and extracts its encoded character",
      type3_doc[0].get_text().strip() == "A"
      and min(type3_doc[0].get_pixmap(alpha=False).samples) < 250)
check("font inventory classifies Type3 CharProcs as self-contained content",
      type3_record["embedded"] and type3_record["self_contained"]
      and type3_record["embedded_bytes"] == 0
      and type3_record["charprocs_status"] == "verified"
      and type3_record["program_source"] == "type3-charprocs",
      type3_record)

write_type3_pdf("type3-direct-charprocs.pdf", charprocs_kind="direct-dict")
direct_charprocs_doc, direct_charprocs_record = type3_fixture_record(
    "type3-direct-charprocs.pdf"
)
check("direct nonempty Type3 CharProcs with stream glyphs verifies",
      direct_charprocs_record["charprocs_status"] == "verified"
      and direct_charprocs_record["embedded"] is True
      and direct_charprocs_doc[0].get_text().strip() == "A",
      direct_charprocs_record)

write_type3_pdf(
    "type3-escaped-charproc-name.pdf", charprocs_kind="direct-escaped-name",
)
escaped_charproc_doc, escaped_charproc_record = type3_fixture_record(
    "type3-escaped-charproc-name.pdf"
)
check("escaped PDF names in direct Type3 CharProcs remain verifiable",
      escaped_charproc_record["charprocs_status"] == "verified"
      and escaped_charproc_record["embedded"] is True
      and escaped_charproc_doc[0].get_text().strip() == "A",
      escaped_charproc_record)

write_type3_pdf(
    "type3-indirect-escaped-charproc-name.pdf",
    charprocs_kind="indirect-escaped-name",
)
indirect_escaped_doc, indirect_escaped_record = type3_fixture_record(
    "type3-indirect-escaped-charproc-name.pdf"
)
indirect_escaped_xref = next(
    entry[0] for entry in indirect_escaped_doc[0].get_fonts(full=True)
    if entry[2].replace(" ", "").casefold() == "type3"
)
indirect_charprocs_type, indirect_charprocs_value = indirect_escaped_doc.xref_get_key(
    indirect_escaped_xref, "CharProcs"
)
indirect_charprocs_xref = indirect_xref(indirect_charprocs_value)
indirect_charprocs_source = indirect_escaped_doc.xref_object(
    indirect_charprocs_xref, compressed=True
)
check("escaped slash name survives in the raw indirect CharProcs dictionary",
      indirect_charprocs_type == "xref" and "#2F" in indirect_charprocs_source.upper(),
      indirect_charprocs_source)
check("escaped slash name in indirect Type3 CharProcs remains verified",
      indirect_escaped_record["charprocs_status"] == "verified"
      and indirect_escaped_record["embedded"] is True
      and indirect_escaped_doc[0].get_text().strip() == "A",
      indirect_escaped_record)

write_type3_pdf(
    "type3-direct-font.pdf", charprocs_kind="direct-dict", direct_font=True,
)
direct_font_doc, direct_font_record = type3_fixture_record("type3-direct-font.pdf")
direct_font_xref = next(
    entry[0] for entry in direct_font_doc[0].get_fonts(full=True)
    if entry[2].replace(" ", "").casefold() == "type3"
)
check("direct Type3 font dictionary is uninspectable rather than falsely non-embedded",
      direct_font_xref == 0
      and direct_font_doc[0].get_text().strip() == "A"
      and direct_font_record["charprocs_status"] == "uninspectable"
      and direct_font_record["embedded"] is None
      and direct_font_record["self_contained"] is None,
      (direct_font_xref, direct_font_record))

malformed_type3_records = {}
for malformed_kind in (
    "empty-direct", "direct-number-entry", "indirect-array",
    "indirect-number", "indirect-null", "indirect-bad-glyph",
):
    malformed_path = f"type3-{malformed_kind}.pdf"
    write_type3_pdf(malformed_path, charprocs_kind=malformed_kind)
    _, malformed_type3_records[malformed_kind] = type3_fixture_record(malformed_path)
check("empty, wrong-type, and non-stream Type3 CharProcs fail closed as malformed",
      all(record["charprocs_status"] == "malformed"
          and record["embedded"] is False
          and record["self_contained"] is False
          for record in malformed_type3_records.values()),
      malformed_type3_records)

# ---- SKILL.md postcheck: encrypted output is reopened with its password -------
encrypted_writer = pypdf.PdfWriter()
encrypted_writer.append(r)
encrypted_writer.encrypt("fixture-password")
with open("encrypted.pdf", "wb") as f:
    encrypted_writer.write(f)
probe = pypdf.PdfReader("encrypted.pdf")
check("encrypted fixture is detected before page access", probe.is_encrypted)


def postcheck_reader(path, password=None):
    reader = pypdf.PdfReader(path)
    if reader.is_encrypted and reader.decrypt("") == 0:
        if password is None or reader.decrypt(password) == 0:
            raise RuntimeError(f"valid password required to postcheck {path}")
    return reader


encrypted_r = postcheck_reader("encrypted.pdf", "fixture-password")
check("password-authenticated postcheck can access every page", len(encrypted_r.pages) == 2)

blank_password_writer = pypdf.PdfWriter()
blank_password_writer.append(r)
blank_password_writer.encrypt("", owner_password="fixture-owner-password")
with open("blank-user-password.pdf", "wb") as f:
    blank_password_writer.write(f)
blank_password_probe = pypdf.PdfReader("blank-user-password.pdf")
check("blank-user-password fixture still reports encryption", blank_password_probe.is_encrypted)
blank_password_r = postcheck_reader("blank-user-password.pdf")
check("postcheck tries the empty user password before requiring PDF_PASSWORD",
      len(blank_password_r.pages) == 2)
try:
    open_pdf("encrypted.pdf")
    transform_rejected_missing_password = False
except RuntimeError:
    transform_rejected_missing_password = True
check("PDF transforms reject encrypted input without a password",
      transform_rejected_missing_password)
check("PDF transforms authenticate before page access",
      len(open_pdf("encrypted.pdf", "fixture-password").pages) == 2)
encrypted_extract = fitz.open("encrypted.pdf")
check("PyMuPDF extraction detects that authentication is required", encrypted_extract.needs_pass)
check("PyMuPDF rejects the wrong extraction password", encrypted_extract.authenticate("wrong") == 0)
check("PyMuPDF authenticates before page extraction", encrypted_extract.authenticate("fixture-password") > 0)
check("authenticated PyMuPDF extraction reaches page text",
      "Application form" in encrypted_extract[0].get_text("text", sort=True))


def open_pdf(path):
    reader = pypdf.PdfReader(path)
    if reader.is_encrypted:
        password = os.environ.get("PDF_PASSWORD", "")
        if reader.decrypt(password) == 0:
            raise RuntimeError(f"Encrypted PDF {path}: set a valid PDF_PASSWORD")
    return reader


os.environ["PDF_PASSWORD"] = "fixture-password"
transform_encrypted = open_pdf("encrypted.pdf")
check("transform helper authenticates encrypted input before page access",
      len(transform_encrypted.pages) == 2)

# A page containing only an AcroForm widget is interactive content, not blank.
widget_canvas = canvas.Canvas("widget-only.pdf", pagesize=A4)
widget_canvas.acroForm.textfield(
    name="widget_only", x=72, y=740, width=260, height=20, borderWidth=1,
)
widget_canvas.showPage()
widget_canvas.save()
widget_doc = fitz.open("widget-only.pdf")
widget_page = widget_doc[0]

NON_VIEWABLE_ANNOTATION_FLAGS = (
    fitz.PDF_ANNOT_IS_INVISIBLE | fitz.PDF_ANNOT_IS_HIDDEN | fitz.PDF_ANNOT_IS_NO_VIEW
)


def annotation_flags(page, item):
    flags = getattr(item, "flags", None)
    if flags is not None:
        return int(flags)
    xref = getattr(item, "xref", 0)
    if not xref:
        return 0
    value_type, value = page.parent.xref_get_key(xref, "F")
    try:
        return int(value) if value_type == "int" else 0
    except (TypeError, ValueError):
        return 0


def visible_clip(page, rectangle, *, already_rotated=False):
    try:
        rectangle = fitz.Rect(rectangle)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(value) for value in rectangle):
        return None
    rectangle.normalize()
    if rectangle.is_empty or rectangle.is_infinite:
        return None
    rotated = rectangle if already_rotated else rectangle * page.rotation_matrix
    clip = rotated & page.rect
    return None if clip.is_empty else clip


MAX_IMAGE_PLACEMENTS = 1_000
MAX_IMAGE_SOURCE_PIXELS = 25_000_000
MAX_TOTAL_IMAGE_SOURCE_PIXELS = 50_000_000
MAX_IMAGE_RENDER_PIXELS = 4_000_000
MAX_TOTAL_IMAGE_RENDER_PIXELS = 20_000_000
MAX_DRAWING_PATHS = 1_000
MAX_DRAWING_RENDER_PIXELS = 4_000_000
MAX_TOTAL_DRAWING_RENDER_PIXELS = 20_000_000
MAX_TEXT_SPANS = 10_000
MAX_TEXT_RENDER_PIXELS = 4_000_000
MAX_TOTAL_TEXT_RENDER_PIXELS = 20_000_000


def viewable_text(page):
    try:
        spans = page.get_texttrace()
    except (RuntimeError, ValueError):
        return [], [], True
    if len(spans) > MAX_TEXT_SPANS:
        return spans, [], True
    visible = []
    total_render_pixels = 0
    for span in spans:
        try:
            text = "".join(chr(character[0]) for character in span.get("chars", ()))
            render_type = int(span.get("type"))
            opacity = float(span.get("opacity"))
        except (TypeError, ValueError, OverflowError):
            return spans, visible, True
        if not text.strip() or render_type > 1 or opacity <= 0:
            continue
        if render_type not in (0, 1) or not math.isfinite(opacity):
            return spans, visible, True
        clip = visible_clip(page, span.get("bbox"))
        if clip is None:
            continue
        render_pixels = math.ceil(clip.width) * math.ceil(clip.height)
        total_render_pixels += render_pixels
        if (render_pixels > MAX_TEXT_RENDER_PIXELS
                or total_render_pixels > MAX_TOTAL_TEXT_RENDER_PIXELS):
            return spans, visible, True
        try:
            pixmap = page.get_pixmap(clip=clip, alpha=True, annots=False)
        except (RuntimeError, ValueError):
            return spans, visible, True
        if not pixmap.alpha:
            return spans, visible, True
        if any(pixmap.samples[pixmap.n - 1::pixmap.n]):
            visible.append(span)
    return spans, visible, False


def viewable_images(page):
    try:
        placements = page.get_image_info()
    except (RuntimeError, ValueError):
        return [], [], True
    if len(placements) > MAX_IMAGE_PLACEMENTS:
        return placements, [], True
    visible = []
    total_source_pixels = 0
    total_render_pixels = 0
    for placement in placements:
        clip = visible_clip(page, placement.get("bbox"))
        if clip is None:
            continue
        width, height = placement.get("width"), placement.get("height")
        if (not isinstance(width, int) or isinstance(width, bool) or width <= 0
                or not isinstance(height, int) or isinstance(height, bool) or height <= 0):
            return placements, visible, True
        source_pixels = width * height
        total_source_pixels += source_pixels
        if (source_pixels > MAX_IMAGE_SOURCE_PIXELS
                or total_source_pixels > MAX_TOTAL_IMAGE_SOURCE_PIXELS):
            return placements, visible, True
        render_pixels = math.ceil(clip.width) * math.ceil(clip.height)
        total_render_pixels += render_pixels
        if (render_pixels > MAX_IMAGE_RENDER_PIXELS
                or total_render_pixels > MAX_TOTAL_IMAGE_RENDER_PIXELS):
            return placements, visible, True
        try:
            pixmap = page.get_pixmap(clip=clip, alpha=True, annots=False)
        except (RuntimeError, ValueError):
            return placements, visible, True
        if not pixmap.alpha:
            return placements, visible, True
        if any(pixmap.samples[pixmap.n - 1::pixmap.n]):
            visible.append(placement)
    return placements, visible, False


def drawing_bounds(drawing):
    """Include stroke width around the path geometry returned by PyMuPDF."""
    try:
        rectangle = fitz.Rect(drawing.get("rect"))
    except (TypeError, ValueError):
        raise ValueError("drawing has no finite bounding rectangle") from None
    if not all(math.isfinite(value) for value in rectangle) or rectangle.is_infinite:
        raise ValueError("drawing has no finite bounding rectangle")
    rectangle.normalize()
    path_type = drawing.get("type")
    has_stroke = (
        "s" in path_type if isinstance(path_type, str)
        else drawing.get("color") is not None
    )
    if has_stroke:
        width = drawing.get("width", 0)
        if isinstance(width, bool):
            raise ValueError("drawing has an invalid stroke width")
        try:
            width = float(width or 0)
        except (TypeError, ValueError):
            raise ValueError("drawing has an invalid stroke width") from None
        if not math.isfinite(width) or width < 0:
            raise ValueError("drawing has an invalid stroke width")
        # PDF hairlines (width 0) still paint one device pixel at render time.
        padding = max(width / 2, 0.5 if width == 0 else 0)
        rectangle = fitz.Rect(
            rectangle.x0 - padding, rectangle.y0 - padding,
            rectangle.x1 + padding, rectangle.y1 + padding,
        )
    return rectangle


def viewable_drawings(page):
    """Render bounded path clips; unknown visibility keeps the page nonblank."""
    try:
        drawings = page.get_drawings()
    except (RuntimeError, ValueError):
        return [], [], True
    if len(drawings) > MAX_DRAWING_PATHS:
        return drawings, [], True
    visible = []
    total_render_pixels = 0
    for drawing in drawings:
        try:
            bounds = drawing_bounds(drawing)
        except ValueError:
            return drawings, visible, True
        clip = visible_clip(page, bounds)
        if clip is None:
            continue
        render_pixels = math.ceil(clip.width) * math.ceil(clip.height)
        total_render_pixels += render_pixels
        if (render_pixels > MAX_DRAWING_RENDER_PIXELS
                or total_render_pixels > MAX_TOTAL_DRAWING_RENDER_PIXELS):
            return drawings, visible, True
        try:
            pixmap = page.get_pixmap(clip=clip, alpha=True, annots=False)
        except (RuntimeError, ValueError):
            return drawings, visible, True
        if not pixmap.alpha:
            return drawings, visible, True
        if any(pixmap.samples[pixmap.n - 1::pixmap.n]):
            visible.append(drawing)
    return drawings, visible, False


def rendered_interactives(page, items):
    rendered = []
    visibility_unknown = False
    for item in items:
        if annotation_flags(page, item) & NON_VIEWABLE_ANNOTATION_FLAGS:
            continue
        clip = visible_clip(page, item.rect)
        if clip is None:
            continue
        try:
            with_annotations = page.get_pixmap(
                matrix=fitz.Matrix(2, 2), clip=clip, alpha=False, annots=True,
            )
            without_annotations = page.get_pixmap(
                matrix=fitz.Matrix(2, 2), clip=clip, alpha=False, annots=False,
            )
        except (RuntimeError, ValueError):
            visibility_unknown = True
            continue
        if with_annotations.samples != without_annotations.samples:
            rendered.append(item)
    return rendered, visibility_unknown


def page_links(page):
    links = []
    link = page.first_link
    while link is not None:
        links.append(link)
        link = link.next
    return links


def link_has_target(link):
    destination = getattr(link, "dest", None)
    return bool(getattr(link, "uri", None)) or (
        destination is not None and getattr(destination, "page", -1) >= 0
    )


def viewable_interactives(page):
    widgets, widget_visibility_unknown = rendered_interactives(
        page, list(page.widgets() or ())
    )
    annotations, annotation_visibility_unknown = rendered_interactives(
        page, list(page.annots() or ())
    )
    links = [
        link for link in page_links(page)
        if link_has_target(link)
        and not annotation_flags(page, link) & NON_VIEWABLE_ANNOTATION_FLAGS
        and visible_clip(page, link.rect, already_rotated=True) is not None
    ]
    return (
        widgets, annotations, links,
        widget_visibility_unknown or annotation_visibility_unknown,
    )


class RenderFailurePage:
    rect = fitz.Rect(0, 0, 200, 300)
    rotation_matrix = fitz.Identity

    def get_pixmap(self, **kwargs):
        raise RuntimeError("fixture render failure")


class VisibleInteractiveProbe:
    flags = 0
    rect = fitz.Rect(20, 20, 80, 40)


failed_render_items, failed_render_unknown = rendered_interactives(
    RenderFailurePage(), [VisibleInteractiveProbe()]
)
failed_render_blank = not (failed_render_items or failed_render_unknown)
check("interactive render failures keep blank-page classification fail closed",
      not failed_render_items and failed_render_unknown and not failed_render_blank,
      (failed_render_items, failed_render_unknown, failed_render_blank))


widgets, annotations, links, interaction_visibility_unknown = viewable_interactives(
    widget_page
)
_, visible_widget_drawings, widget_drawing_visibility_unknown = viewable_drawings(
    widget_page
)
blank = (
    not viewable_text(widget_page)[1] and not viewable_text(widget_page)[2]
    and not widget_page.get_images()
    and not visible_widget_drawings and not widget_drawing_visibility_unknown
    and not widgets and not annotations and not links and not interaction_visibility_unknown
)
check("widget-only form page exposes a widget", len(widgets) == 1, len(widgets))
check("widget-aware blank-page predicate keeps form page", not blank)

# ---- SKILL.md postcheck: interactive-only pages are exempt from the text gate ---
def normalized_box(box):
    x0, y0, x1, y1 = (float(value) for value in box)
    left, right = sorted((x0, x1))
    bottom, top = sorted((y0, y1))
    return left, bottom, right, top


def normalized_size(box):
    left, bottom, right, top = normalized_box(box)
    return right - left, top - bottom


def widget_count(page, rendered_page):
    non_viewable_flags = 1 | 2 | 32
    count = 0
    for ref in page.get("/Annots") or []:
        widget = ref.get_object()
        if widget.get("/Subtype") != "/Widget":
            continue
        flags = int(widget.get("/F", 0))
        rectangle = widget.get("/Rect")
        if flags & non_viewable_flags or rectangle is None:
            continue
        left, bottom, right, top = normalized_box(rectangle)
        crop_left, crop_bottom, crop_right, crop_top = normalized_box(page.cropbox)
        media_left, media_bottom, media_right, media_top = normalized_box(page.mediabox)
        visible_left = max(crop_left, media_left)
        visible_bottom = max(crop_bottom, media_bottom)
        visible_right = min(crop_right, media_right)
        visible_top = min(crop_top, media_top)
        intersects_visible_page = (
            min(right, visible_right) > max(left, visible_left)
            and min(top, visible_top) > max(bottom, visible_bottom)
        )
        if right <= left or top <= bottom or not intersects_visible_page:
            continue
        xref = getattr(ref, "idnum", None)
        if xref is None:
            continue
        try:
            rendered_widget = rendered_page.load_widget(xref)
            clip = (
                rendered_widget.rect * rendered_page.rotation_matrix
            ) & rendered_page.rect
            if clip.is_empty:
                continue
            with_widget = rendered_page.get_pixmap(
                matrix=fitz.Matrix(2, 2), clip=clip, alpha=False, annots=True,
            )
            without_widgets = rendered_page.get_pixmap(
                matrix=fitz.Matrix(2, 2), clip=clip, alpha=False, annots=False,
            )
        except (RuntimeError, ValueError):
            continue
        if with_widget.samples != without_widgets.samples:
            count += 1
    return count

widget_postcheck = pypdf.PdfReader("widget-only.pdf")
widget_render = fitz.open("widget-only.pdf")
widget_text = (widget_postcheck.pages[0].extract_text() or "").strip()
check("widget-only page extracts no text", widget_text == "", repr(widget_text))
check("postcheck counts the visibly rendered widget annotation",
      widget_count(widget_postcheck.pages[0], widget_render[0]) == 1)
check("widget-only page passes the text postcheck via the widget exemption",
      bool(widget_text) or widget_count(widget_postcheck.pages[0], widget_render[0]) > 0)

from pypdf.generic import ArrayObject, FloatObject, NameObject, NumberObject

for label, flag in (("invisible", 1), ("hidden", 2), ("no-view", 32)):
    hidden_writer = pypdf.PdfWriter()
    hidden_writer.append(widget_postcheck)
    hidden_widget = hidden_writer.pages[0]["/Annots"][0].get_object()
    hidden_widget[NameObject("/F")] = NumberObject(flag)
    hidden_path = f"widget-{label}.pdf"
    with open(hidden_path, "wb") as output:
        hidden_writer.write(output)
    hidden_page = pypdf.PdfReader(hidden_path).pages[0]
    hidden_render = fitz.open(hidden_path)
    check(f"{label} widget does not exempt an otherwise blank page",
          widget_count(hidden_page, hidden_render[0]) == 0
          and not bool((hidden_page.extract_text() or "").strip())
          and not any(viewable_interactives(hidden_render[0])[:3]))

appearance_writer = pypdf.PdfWriter()
appearance_writer.append(widget_postcheck)
appearance_widget = appearance_writer.pages[0]["/Annots"][0].get_object()
del appearance_widget[NameObject("/AP")]
with open("widget-no-appearance.pdf", "wb") as output:
    appearance_writer.write(output)
appearance_page = pypdf.PdfReader("widget-no-appearance.pdf").pages[0]
appearance_render = fitz.open("widget-no-appearance.pdf")
check("visible widget without /AP can still be viewer-generated and render visibly",
      widget_count(appearance_page, appearance_render[0]) == 1)

blank_appearance_writer = pypdf.PdfWriter()
blank_appearance_writer.append(widget_postcheck)
blank_appearance_widget = blank_appearance_writer.pages[0]["/Annots"][0].get_object()
for key in ("/AP", "/MK", "/BS", "/DA", "/V", "/DV"):
    blank_appearance_widget.pop(NameObject(key), None)
blank_acroform = blank_appearance_writer._root_object["/AcroForm"].get_object()
for key in ("/DA", "/DR", "/NeedAppearances"):
    blank_acroform.pop(NameObject(key), None)
with open("widget-blank-appearance.pdf", "wb") as output:
    blank_appearance_writer.write(output)
blank_appearance_page = pypdf.PdfReader("widget-blank-appearance.pdf").pages[0]
blank_appearance_render = fitz.open("widget-blank-appearance.pdf")
check("widget with no renderable appearance does not exempt a white page",
      widget_count(blank_appearance_page, blank_appearance_render[0]) == 0
      and not any(value != 255 for value in
                  blank_appearance_render[0].get_pixmap(alpha=False).samples))

for label, rectangle in (
    ("zero-area", [72, 740, 72, 760]),
    ("off-page", [1000, 1000, 1100, 1100]),
):
    geometry_writer = pypdf.PdfWriter()
    geometry_writer.append(widget_postcheck)
    geometry_widget = geometry_writer.pages[0]["/Annots"][0].get_object()
    geometry_widget[NameObject("/Rect")] = ArrayObject([
        FloatObject(value) for value in rectangle
    ])
    geometry_path = f"widget-{label}.pdf"
    with open(geometry_path, "wb") as output:
        geometry_writer.write(output)
    geometry_page = pypdf.PdfReader(geometry_path).pages[0]
    geometry_render = fitz.open(geometry_path)
    check(f"{label} widget does not exempt an otherwise blank page",
          widget_count(geometry_page, geometry_render[0]) == 0
          and not any(viewable_interactives(geometry_render[0])[:3]))

interaction_doc = fitz.open()
interaction_page = interaction_doc.new_page(width=200, height=300)
hidden_annotation = interaction_page.add_text_annot((40, 40), "hidden note")
hidden_annotation.set_flags(fitz.PDF_ANNOT_IS_HIDDEN)
hidden_annotation.update()
interaction_page.insert_link({
    "kind": fitz.LINK_URI,
    "from": fitz.Rect(500, 500, 600, 520),
    "uri": "https://example.invalid",
})
interaction_doc.save("non-viewable-interactives.pdf")
interaction_doc.close()
interaction_reopened = fitz.open("non-viewable-interactives.pdf")
filtered_widgets, filtered_annotations, filtered_links, filtered_unknown = (
    viewable_interactives(interaction_reopened[0])
)
check("hidden annotations and off-page links do not exempt a blank page",
      not filtered_widgets and not filtered_annotations and not filtered_links
      and not filtered_unknown,
      (filtered_widgets, filtered_annotations, filtered_links, filtered_unknown))

visible_interaction_doc = fitz.open()
visible_interaction_page = visible_interaction_doc.new_page(width=200, height=300)
visible_annotation = visible_interaction_page.add_text_annot((40, 40), "visible note")
visible_annotation.update()
visible_interaction_page.insert_link({
    "kind": fitz.LINK_URI,
    "from": fitz.Rect(40, 80, 140, 100),
    "uri": "https://example.invalid",
})
visible_interaction_doc.save("visible-interactives.pdf")
visible_interaction_doc.close()
visible_interaction_reopened = fitz.open("visible-interactives.pdf")
visible_widgets, visible_annotations, visible_links, visible_unknown = (
    viewable_interactives(visible_interaction_reopened[0])
)
check("visible annotations and usable links keep an interactive page nonblank",
      not visible_widgets and len(visible_annotations) == 1 and len(visible_links) == 1
      and not visible_unknown,
      (visible_widgets, visible_annotations, visible_links, visible_unknown))

reversed_writer = pypdf.PdfWriter()
reversed_writer.append(widget_postcheck)
reversed_page = reversed_writer.pages[0]
reversed_widget = reversed_page["/Annots"][0].get_object()
reversed_widget[NameObject("/Rect")] = ArrayObject([
    FloatObject(332), FloatObject(760), FloatObject(72), FloatObject(740),
])
with open("widget-reversed-rect.pdf", "wb") as output:
    reversed_writer.write(output)
reversed_reader_page = pypdf.PdfReader("widget-reversed-rect.pdf").pages[0]
reversed_render = fitz.open("widget-reversed-rect.pdf")
check("legal reversed widget rectangle is normalized and remains visible",
      widget_count(reversed_reader_page, reversed_render[0]) == 1)

reversed_boxes_writer = pypdf.PdfWriter()
reversed_boxes_writer.append(widget_postcheck)
reversed_boxes_page = reversed_boxes_writer.pages[0]
reversed_page_box = ArrayObject([
    FloatObject(A4[0]), FloatObject(A4[1]), FloatObject(0), FloatObject(0),
])
reversed_boxes_page[NameObject("/MediaBox")] = reversed_page_box
reversed_boxes_page[NameObject("/CropBox")] = ArrayObject(reversed_page_box)
with open("widget-reversed-page-boxes.pdf", "wb") as output:
    reversed_boxes_writer.write(output)
reversed_boxes_reader_page = pypdf.PdfReader("widget-reversed-page-boxes.pdf").pages[0]
reversed_boxes_render = fitz.open("widget-reversed-page-boxes.pdf")
check("legal reversed page boxes are normalized before widget intersection",
      widget_count(reversed_boxes_reader_page, reversed_boxes_render[0]) == 1
      and all(
          abs(actual - expected) < A4_TOLERANCE
          for actual, expected in zip(
              normalized_size(reversed_boxes_reader_page.mediabox), A4,
          )
      ))

rotated_widget_writer = pypdf.PdfWriter()
rotated_widget_writer.append(widget_postcheck)
rotated_widget_page = rotated_widget_writer.pages[0]
rotated_widget_page.rotate(90)
rotated_widget = rotated_widget_page["/Annots"][0].get_object()
rotated_widget[NameObject("/Rect")] = ArrayObject([
    FloatObject(72), FloatObject(72), FloatObject(332), FloatObject(92),
])
with open("widget-rotated.pdf", "wb") as output:
    rotated_widget_writer.write(output)
rotated_widget_reader_page = pypdf.PdfReader("widget-rotated.pdf").pages[0]
rotated_widget_render = fitz.open("widget-rotated.pdf")
check("visible widget on a rotated page is clipped in rotated coordinates",
      widget_count(rotated_widget_reader_page, rotated_widget_render[0]) == 1)

blank_writer = pypdf.PdfWriter()
blank_writer.add_blank_page(width=200, height=300)
with open("blank.pdf", "wb") as f:
    blank_writer.write(f)
blank_r = pypdf.PdfReader("blank.pdf")
blank_render = fitz.open("blank.pdf")
check("a truly blank page still fails the text postcheck",
      not (bool((blank_r.pages[0].extract_text() or "").strip())
           or widget_count(blank_r.pages[0], blank_render[0]) > 0))

# ---- transform.md AcroForm snippet: clone into writer, fill on writer pages ----
from pypdf import PdfReader, PdfWriter

reader = PdfReader("form.pdf")
fields = reader.get_fields() or {}
check("source form has the expected field", "applicant_name" in fields, list(fields))

writer = PdfWriter()
writer.append(reader)  # clones pages AND catalog /AcroForm
writer.update_page_form_field_values(
    writer.pages[0],
    {"applicant_name": "Ada Byron"},
)
with open("filled.pdf", "wb") as f:
    writer.write(f)

check_r = PdfReader("filled.pdf")
check("filled file keeps both pages", len(check_r.pages) == 2, len(check_r.pages))
value = str((check_r.get_fields() or {}).get("applicant_name", {}).get("/V", ""))
check("field value round-trips", value.strip("/") == "Ada Byron", repr(value))

# A widget can live on any page; locate its annotation instead of assuming page 1.
page2_form = canvas.Canvas("form-page2.pdf", pagesize=A4)
page2_form.drawString(72, 780, "Cover page")
page2_form.showPage()
page2_form.drawString(72, 780, "Form page")
page2_form.acroForm.textfield(
    name="applicant_name", x=72, y=740, width=260, height=20, borderWidth=0,
)
page2_form.showPage()
page2_form.save()

wrong_page_writer = PdfWriter()
wrong_page_writer.append(PdfReader("form-page2.pdf"))
wrong_page_writer.update_page_form_field_values(
    wrong_page_writer.pages[0], {"applicant_name": "Wrong page"},
)
with open("form-page2-wrong.pdf", "wb") as f:
    wrong_page_writer.write(f)
wrong_value = str(
    (PdfReader("form-page2-wrong.pdf").get_fields() or {})
    .get("applicant_name", {}).get("/V", "")
)
check("hard-coded first-page form fill misses a page-2 widget (negative control)",
      wrong_value.strip("/") != "Wrong page", repr(wrong_value))


def widget_field_name(widget):
    parts = []
    seen = set()
    while widget is not None:
        object_id = id(widget)
        if object_id in seen:
            raise ValueError("cycle in AcroForm field parent chain")
        seen.add(object_id)
        partial_name = widget.get("/T")
        if partial_name is not None:
            parts.append(str(partial_name))
        parent = widget.get("/Parent")
        widget = None if parent is None else parent.get_object()
    return ".".join(reversed(parts)) if parts else None


page2_writer = PdfWriter()
page2_writer.append(PdfReader("form-page2.pdf"))
field_name = "applicant_name"
target_pages = [
    page for page in page2_writer.pages
    if any(
        (widget := ref.get_object()).get("/Subtype") == "/Widget"
        and widget_field_name(widget) == field_name
        for ref in (page.get("/Annots") or [])
    )
]
for target_page in target_pages:
    page2_writer.update_page_form_field_values(
        target_page, {field_name: "Ada on page 2"},
    )
with open("form-page2-filled.pdf", "wb") as f:
    page2_writer.write(f)
page2_value = str(
    (PdfReader("form-page2-filled.pdf").get_fields() or {})
    .get(field_name, {}).get("/V", "")
)
check("form fill locates the widget page before updating",
      len(target_pages) == 1 and target_pages[0] is page2_writer.pages[1], len(target_pages))
check("page-2 field value round-trips", page2_value.strip("/") == "Ada on page 2",
      repr(page2_value))

# A hierarchical field stores one partial /T at each level. Build a non-terminal
# `application` parent around the page-2 widget and address the terminal field by
# the fully qualified name returned by get_fields().
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, TextStringObject

hierarchy_writer = PdfWriter()
hierarchy_writer.append(PdfReader("form-page2.pdf"))
hierarchy_widget_ref = hierarchy_writer.pages[1]["/Annots"][0]
hierarchy_widget = hierarchy_widget_ref.get_object()
hierarchy_parent = DictionaryObject({
    NameObject("/T"): TextStringObject("application"),
    NameObject("/Kids"): ArrayObject([hierarchy_widget_ref]),
})
hierarchy_parent_ref = hierarchy_writer._add_object(hierarchy_parent)
hierarchy_widget[NameObject("/Parent")] = hierarchy_parent_ref
hierarchy_acroform = hierarchy_writer._root_object["/AcroForm"]
hierarchy_acroform[NameObject("/Fields")] = ArrayObject([hierarchy_parent_ref])
with open("hierarchical-form.pdf", "wb") as f:
    hierarchy_writer.write(f)

hierarchy_reader = PdfReader("hierarchical-form.pdf")
hierarchical_field_name = "application.applicant_name"
check("get_fields exposes the fully qualified hierarchical field name",
      hierarchical_field_name in (hierarchy_reader.get_fields() or {}),
      list((hierarchy_reader.get_fields() or {}).keys()))

hierarchy_fill_writer = PdfWriter()
hierarchy_fill_writer.append(hierarchy_reader)
hierarchy_target_pages = [
    page for page in hierarchy_fill_writer.pages
    if any(
        (widget := ref.get_object()).get("/Subtype") == "/Widget"
        and widget_field_name(widget) == hierarchical_field_name
        for ref in (page.get("/Annots") or [])
    )
]
for target_page in hierarchy_target_pages:
    hierarchy_fill_writer.update_page_form_field_values(
        target_page, {hierarchical_field_name: "Ada Hierarchical"},
    )
with open("hierarchical-form-filled.pdf", "wb") as f:
    hierarchy_fill_writer.write(f)
hierarchy_value = str(
    (PdfReader("hierarchical-form-filled.pdf").get_fields() or {})
    .get(hierarchical_field_name, {}).get("/V", "")
)
hierarchy_literal_value = str(
    (PdfReader("hierarchical-form-filled.pdf").get_fields() or {})
    .get("applicant_name", {}).get("/V", "")
)
check("qualified field lookup locates the hierarchical widget page",
      len(hierarchy_target_pages) == 1
      and hierarchy_target_pages[0] is hierarchy_fill_writer.pages[1],
      len(hierarchy_target_pages))
check("hierarchical field value round-trips",
      hierarchy_value.strip("/") == "Ada Hierarchical", repr(hierarchy_value))
check("literal applicant_name lookup is a proven false negative for a qualified field",
      hierarchy_literal_value == "", repr(hierarchy_literal_value))

# ---- transform.md merge imports outline navigation ----------------------------
appendix_writer = PdfWriter()
appendix_writer.add_blank_page(width=200, height=300)
appendix_writer.add_outline_item("Appendix bookmark", 0)
with open("appendix-outline.pdf", "wb") as f:
    appendix_writer.write(f)

merge_writer = PdfWriter()
merge_writer.append(open_pdf("form.pdf"), pages=(1, 2), import_outline=True)
merge_writer.append(open_pdf("appendix-outline.pdf"), import_outline=True)
with open("merged-outline.pdf", "wb") as f:
    merge_writer.write(f)
merged_outline = PdfReader("merged-outline.pdf").outline
check(
    "append imports the appended PDF outline",
    any(getattr(item, "title", "") == "Appendix bookmark" for item in merged_outline),
    merged_outline,
)

# ---- transform.md watermark snippet -------------------------------------------
from pypdf import PdfReader as R2, Transformation
from pypdf.generic import RectangleObject


def rotation_transfer(page):
    media = RectangleObject(page.mediabox)
    transform = (
        Transformation()
        .translate(
            -float(media.left + media.width / 2),
            -float(media.bottom + media.height / 2),
        )
        .rotate(-page.rotation)
    )
    corners = [
        transform.apply_on(point)
        for point in (media.lower_left, media.lower_right, media.upper_left, media.upper_right)
    ]
    return transform.translate(
        -min(point[0] for point in corners),
        -min(point[1] for point in corners),
    )


def inverse_transformation(transform):
    a, b, c, d, e, f = map(float, transform.ctm)
    determinant = a * d - b * c
    return Transformation((
        d / determinant, -b / determinant,
        -c / determinant, a / determinant,
        (c * f - d * e) / determinant,
        (b * e - a * f) / determinant,
    ))


def transformed_rectangle(rectangle, transform):
    rectangle = RectangleObject(rectangle)
    corners = [
        transform.apply_on(point)
        for point in (
            rectangle.lower_left, rectangle.lower_right,
            rectangle.upper_left, rectangle.upper_right,
        )
    ]
    return RectangleObject((
        min(point[0] for point in corners), min(point[1] for point in corners),
        max(point[0] for point in corners), max(point[1] for point in corners),
    ))


def stamp_placement(page, stamp_box):
    to_visual = rotation_transfer(page)
    destination = transformed_rectangle(page.cropbox, to_visual)
    sw, sh = float(stamp_box.width), float(stamp_box.height)
    dw, dh = float(destination.width), float(destination.height)
    scale = min(dw / sw, dh / sh)
    tx = float(destination.left) + (dw - sw * scale) / 2 - float(stamp_box.left) * scale
    ty = float(destination.bottom) + (dh - sh * scale) / 2 - float(stamp_box.bottom) * scale
    visible_placement = Transformation().scale(scale).translate(tx, ty)
    return visible_placement.transform(inverse_transformation(to_visual))

stamp_src = canvas.Canvas("stamp.pdf", pagesize=A4)
stamp_src.setFont("Helvetica", 40)
stamp_src.setFillAlpha(0.35)
stamp_src.drawString(160, 400, "DRAFT")
stamp_src.save()

stamp = R2("stamp.pdf").pages[0]
stamp.transfer_rotation_to_content()
stamp_text = (stamp.extract_text() or "").strip()
reader = R2("form.pdf")
expected_fields = reader.get_fields() or {}
writer = PdfWriter()
writer.append(reader)
stamp_box = stamp.cropbox
for page in writer.pages:
    page.merge_transformed_page(stamp, stamp_placement(page, stamp_box))
expected_sizes = [(round(float(p.mediabox.width), 2), round(float(p.mediabox.height), 2))
                  for p in writer.pages]
with open("watermarked.pdf", "wb") as f:
    writer.write(f)

verify = R2("watermarked.pdf")
check("watermark written and page count kept", len(verify.pages) == 2, len(verify.pages))
check(
    "watermark page sizes unchanged",
    [(round(float(p.mediabox.width), 2), round(float(p.mediabox.height), 2)) for p in verify.pages] == expected_sizes,
)
check("watermarking preserves the AcroForm catalog and fields",
      set(expected_fields) <= set(verify.get_fields() or {}), verify.get_fields())
check("stamp text present on every page", all(stamp_text in (p.extract_text() or "") for p in verify.pages))

# ---- inspect.md blank-page predicate includes widgets and annotations -----------
form_only_canvas = canvas.Canvas("form-only.pdf", pagesize=A4)
form_only_canvas.acroForm.textfield(
    name="widget_only", x=72, y=740, width=260, height=20, borderWidth=0
)
form_only_canvas.showPage()
form_only_canvas.save()
form_only_doc = fitz.open("form-only.pdf")
form_only_page = form_only_doc[0]
form_only_widgets = list(form_only_page.widgets() or ())
form_only_annotations = list(form_only_page.annots() or ())


def inspected_page_is_blank(page):
    _, visible_text, text_visibility_unknown = viewable_text(page)
    _, visible_images, image_visibility_unknown = viewable_images(page)
    _, visible_drawings, drawing_visibility_unknown = viewable_drawings(page)
    widgets, annotations, links, interaction_visibility_unknown = viewable_interactives(page)
    return not (
        visible_text or visible_images or visible_drawings
        or widgets or annotations or links
        or text_visibility_unknown or image_visibility_unknown
        or drawing_visibility_unknown or interaction_visibility_unknown
    )


form_only_is_blank = inspected_page_is_blank(form_only_page)
check("form-only page exposes a widget", len(form_only_widgets) == 1)
check("form-only page is not classified as blank", not form_only_is_blank)

# Extractable text can still be visually absent because of Tr=3, alpha=0,
# clipping, or off-page geometry.
text_visibility_canvas = canvas.Canvas(
    "text-visibility.pdf", pagesize=(200, 200), pageCompression=0,
)
text_visibility_canvas.drawString(40, 100, "visible")
text_visibility_canvas.showPage()
invisible_text = text_visibility_canvas.beginText(40, 100)
invisible_text.setTextRenderMode(3)
invisible_text.textOut("render-mode-hidden")
text_visibility_canvas.drawText(invisible_text)
text_visibility_canvas.showPage()
text_visibility_canvas.saveState()
text_visibility_canvas.setFillAlpha(0)
text_visibility_canvas.drawString(40, 100, "zero-opacity")
text_visibility_canvas.restoreState()
text_visibility_canvas.showPage()
text_clip = text_visibility_canvas.beginPath()
text_clip.rect(0, 0, 10, 10)
text_visibility_canvas.saveState()
text_visibility_canvas.clipPath(text_clip, stroke=0, fill=0)
text_visibility_canvas.drawString(40, 100, "clipped")
text_visibility_canvas.restoreState()
text_visibility_canvas.showPage()
text_visibility_canvas.drawString(250, 100, "off-page")
text_visibility_canvas.showPage()
text_visibility_canvas.save()

text_visibility_doc = fitz.open("text-visibility.pdf")
text_visibility_results = []
for text_page in text_visibility_doc:
    text_spans, visible_text_spans, text_visibility_unknown = viewable_text(text_page)
    text_visibility_results.append((
        len(text_spans), len(visible_text_spans), text_visibility_unknown,
        inspected_page_is_blank(text_page),
    ))
check("blank-page text detection uses rendered visibility",
      text_visibility_results == [
          (1, 1, False, False),
          (1, 0, False, True),
          (1, 0, False, True),
          (1, 0, False, True),
          (1, 0, False, True),
      ], text_visibility_results)

text_budget_results = {}
for budget_name in (
    "MAX_TEXT_SPANS", "MAX_TEXT_RENDER_PIXELS", "MAX_TOTAL_TEXT_RENDER_PIXELS",
):
    original_budget = globals()[budget_name]
    globals()[budget_name] = 0
    try:
        spans, visible_spans, visibility_unknown = viewable_text(text_visibility_doc[0])
        page_is_blank = inspected_page_is_blank(text_visibility_doc[0])
    finally:
        globals()[budget_name] = original_budget
    text_budget_results[budget_name] = (
        len(spans), len(visible_spans), visibility_unknown, page_is_blank,
    )
check("every text count/render budget fails closed as visibility unknown",
      all(result == (1, 0, True, False) for result in text_budget_results.values()),
      text_budget_results)

# PyMuPDF inventories invoked paths even when page geometry, clipping, or opacity
# prevents them from contributing a rendered pixel.
drawing_visibility_canvas = canvas.Canvas(
    "drawing-visibility.pdf", pagesize=(200, 200), pageCompression=0,
)
drawing_visibility_canvas.setLineWidth(2)
drawing_visibility_canvas.rect(40, 40, 80, 60, stroke=1, fill=0)
drawing_visibility_canvas.showPage()
drawing_visibility_canvas.setLineWidth(2)
drawing_visibility_canvas.rect(250, 40, 80, 60, stroke=1, fill=0)
drawing_visibility_canvas.showPage()
clipping_path = drawing_visibility_canvas.beginPath()
clipping_path.rect(0, 0, 10, 10)
drawing_visibility_canvas.saveState()
drawing_visibility_canvas.clipPath(clipping_path, stroke=0, fill=0)
drawing_visibility_canvas.setLineWidth(2)
drawing_visibility_canvas.rect(40, 40, 80, 60, stroke=1, fill=0)
drawing_visibility_canvas.restoreState()
drawing_visibility_canvas.showPage()
drawing_visibility_canvas.saveState()
drawing_visibility_canvas.setStrokeAlpha(0)
drawing_visibility_canvas.setLineWidth(2)
drawing_visibility_canvas.rect(40, 40, 80, 60, stroke=1, fill=0)
drawing_visibility_canvas.restoreState()
drawing_visibility_canvas.showPage()
no_paint_path = drawing_visibility_canvas.beginPath()
no_paint_path.rect(40, 40, 80, 60)
drawing_visibility_canvas.drawPath(no_paint_path, stroke=0, fill=0)
drawing_visibility_canvas.showPage()
drawing_visibility_canvas.save()

drawing_visibility_doc = fitz.open("drawing-visibility.pdf")
drawing_visibility_results = []
for drawing_page in drawing_visibility_doc:
    drawing_paths, visible_drawing_paths, drawing_visibility_unknown = viewable_drawings(
        drawing_page
    )
    drawing_visibility_results.append((
        len(drawing_paths), len(visible_drawing_paths), drawing_visibility_unknown,
        inspected_page_is_blank(drawing_page),
    ))
check("drawing visibility uses rendered paint rather than raw path presence",
      drawing_visibility_results == [
          (1, 1, False, False),  # ordinary visible stroke
          (1, 0, False, True),   # fully off-page stroke
          (1, 0, False, True),   # stroke fully excluded by the active clip
          (1, 0, False, True),   # zero-opacity stroke still has a path record
          (0, 0, False, True),   # a path ended with PDF's no-paint operator
      ], drawing_visibility_results)


class FailingDrawingRenderPage:
    rect = fitz.Rect(0, 0, 200, 200)
    rotation_matrix = fitz.Identity

    def get_drawings(self):
        return [{"type": "f", "rect": fitz.Rect(20, 20, 80, 80)}]

    def get_pixmap(self, **kwargs):
        raise RuntimeError("fixture drawing renderer failure")


failed_drawing_paths, failed_visible_drawings, failed_drawing_unknown = viewable_drawings(
    FailingDrawingRenderPage()
)
failed_drawing_blank = not (failed_visible_drawings or failed_drawing_unknown)
check("drawing render failures keep blank-page classification fail closed",
      len(failed_drawing_paths) == 1 and not failed_visible_drawings
      and failed_drawing_unknown and not failed_drawing_blank,
      (failed_drawing_paths, failed_visible_drawings,
       failed_drawing_unknown, failed_drawing_blank))

drawing_budget_results = {}
for budget_name in (
    "MAX_DRAWING_PATHS", "MAX_DRAWING_RENDER_PIXELS",
    "MAX_TOTAL_DRAWING_RENDER_PIXELS",
):
    original_budget = globals()[budget_name]
    globals()[budget_name] = 0
    try:
        budget_paths, budget_visible, budget_unknown = viewable_drawings(
            drawing_visibility_doc[0]
        )
        budget_page_is_blank = inspected_page_is_blank(drawing_visibility_doc[0])
    finally:
        globals()[budget_name] = original_budget
    drawing_budget_results[budget_name] = (
        len(budget_paths), len(budget_visible), budget_unknown, budget_page_is_blank,
    )
check("every drawing count/render budget fails closed as visibility unknown",
      all(result == (1, 0, True, False)
          for result in drawing_budget_results.values()),
      drawing_budget_results)

# Identical media/crop geometry remains consistent when one page has /Rotate 90.
mixed_rotation_writer = PdfWriter()
mixed_rotation_writer.append(PdfReader("form.pdf"))
mixed_rotation_writer.pages[1].rotate(90)
with open("inspect-mixed-rotation.pdf", "wb") as f:
    mixed_rotation_writer.write(f)
mixed_rotation_doc = fitz.open("inspect-mixed-rotation.pdf")
mixed_media_sizes = {
    (round(page.mediabox.width, 2), round(page.mediabox.height, 2))
    for page in mixed_rotation_doc
}
mixed_crop_sizes = {
    (round(page.cropbox.width, 2), round(page.cropbox.height, 2))
    for page in mixed_rotation_doc
}
mixed_display_sizes = {
    (round(page.rect.width, 2), round(page.rect.height, 2))
    for page in mixed_rotation_doc
}
check("page.rect falsely reports mixed sizes for identical rotated media (negative control)",
      len(mixed_display_sizes) == 2, mixed_display_sizes)
check("unrotated media and crop sizes stay consistent across mixed rotation",
      len(mixed_media_sizes) == 1 and len(mixed_crop_sizes) == 1,
      (mixed_media_sizes, mixed_crop_sizes))
check("inspection reports mixed rotation separately from paper size",
      [page.rotation for page in mixed_rotation_doc] == [0, 90])

# ReportLab's drawInlineImage emits BI/ID/EI content rather than an image XObject.
inline_source = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 12, 12))
inline_source.clear_with(96)
inline_source.save("inline-only-source.png")
inline_canvas = canvas.Canvas("inline-only.pdf", pagesize=A4)
inline_canvas.drawInlineImage("inline-only-source.png", 72, 700, width=80, height=80)
inline_canvas.showPage()
inline_canvas.save()
inline_doc = fitz.open("inline-only.pdf")
inline_page = inline_doc[0]
inline_blocks = [
    block for block in inline_page.get_text("dict")["blocks"]
    if block["type"] == 1
]
check("inline-only image is absent from the XObject inventory",
      inline_page.get_images() == [], inline_page.get_images())
check("inline-only image appears as a type-1 text-dictionary block",
      len(inline_blocks) == 1, inline_blocks)
check("inline-only image page is not classified as blank",
      not inspected_page_is_blank(inline_page))

# The extraction XObject pass and inline pass are disjoint: type-1 blocks with
# positive xrefs belong to the first pass, while true inline blocks have xref 0.
xobject_canvas = canvas.Canvas("xobject-image.pdf", pagesize=A4)
xobject_canvas.drawImage("inline-only-source.png", 72, 700, width=80, height=80)
xobject_canvas.showPage()
xobject_canvas.save()

def write_fully_clipped_image(path, *, inline):
    clipped_canvas = canvas.Canvas(path, pagesize=(200, 200))
    clip_path = clipped_canvas.beginPath()
    clip_path.rect(0, 0, 10, 10)
    clipped_canvas.saveState()
    clipped_canvas.clipPath(clip_path, stroke=0, fill=0)
    draw = clipped_canvas.drawInlineImage if inline else clipped_canvas.drawImage
    draw("inline-only-source.png", 60, 60, width=80, height=80)
    clipped_canvas.restoreState()
    clipped_canvas.showPage()
    clipped_canvas.save()


clipped_image_results = {}
for clipped_kind, clipped_inline in (("xobject", False), ("inline", True)):
    clipped_path = f"fully-clipped-{clipped_kind}.pdf"
    write_fully_clipped_image(clipped_path, inline=clipped_inline)
    clipped_doc = fitz.open(clipped_path)
    clipped_page = clipped_doc[0]
    placements, visible, visibility_unknown = viewable_images(clipped_page)
    clipped_alpha = clipped_page.get_pixmap(alpha=True, annots=False)
    clipped_image_results[clipped_kind] = {
        "placements": len(placements), "visible": len(visible),
        "unknown": visibility_unknown,
        "painted_alpha": any(clipped_alpha.samples[clipped_alpha.n - 1::clipped_alpha.n]),
        "blank": inspected_page_is_blank(clipped_page),
    }
check("fully clipped XObject and inline placements remain diagnostic candidates",
      all(result["placements"] == 1 for result in clipped_image_results.values()),
      clipped_image_results)
check("alpha render excludes fully clipped XObject and inline images from blank evidence",
      all(result == {
          "placements": 1, "visible": 0, "unknown": False,
          "painted_alpha": False, "blank": True,
      } for result in clipped_image_results.values()), clipped_image_results)

rotated_image_writer = pypdf.PdfWriter()
rotated_image_writer.append(pypdf.PdfReader("xobject-image.pdf"))
rotated_image_writer.pages[0].rotate(90)
with open("rotated-visible-image.pdf", "wb") as output:
    rotated_image_writer.write(output)
rotated_image_doc = fitz.open("rotated-visible-image.pdf")
rotated_placements, rotated_visible, rotated_unknown = viewable_images(rotated_image_doc[0])
check("visible image remains visible after page rotation",
      len(rotated_placements) == len(rotated_visible) == 1
      and not rotated_unknown and not inspected_page_is_blank(rotated_image_doc[0]),
      (rotated_placements, rotated_visible, rotated_unknown))

xobject_visibility_doc = fitz.open("xobject-image.pdf")
budget_results = {}
for budget_name in (
    "MAX_IMAGE_PLACEMENTS", "MAX_IMAGE_SOURCE_PIXELS",
    "MAX_TOTAL_IMAGE_SOURCE_PIXELS", "MAX_IMAGE_RENDER_PIXELS",
    "MAX_TOTAL_IMAGE_RENDER_PIXELS",
):
    original_budget = globals()[budget_name]
    globals()[budget_name] = 0
    try:
        budget_placements, budget_visible, budget_unknown = viewable_images(
            xobject_visibility_doc[0]
        )
        budget_page_is_blank = inspected_page_is_blank(xobject_visibility_doc[0])
    finally:
        globals()[budget_name] = original_budget
    budget_results[budget_name] = (
        len(budget_placements), len(budget_visible),
        budget_unknown, budget_page_is_blank,
    )
check("every image count/source/render budget fails closed as visibility unknown",
      all(result == (1, 0, True, False) for result in budget_results.values()),
      budget_results)

class FailingImageRenderPage:
    rotation_matrix = fitz.Matrix(1, 1)
    rect = fitz.Rect(0, 0, 200, 200)

    def get_image_info(self):
        return [{"bbox": (20, 20, 80, 80), "width": 12, "height": 12}]

    def get_pixmap(self, **kwargs):
        raise RuntimeError("fixture image decoder failure")


failed_placements, failed_visible, failed_unknown = viewable_images(
    FailingImageRenderPage()
)
check("image decoder failure is reported as visibility unknown",
      len(failed_placements) == 1 and not failed_visible and failed_unknown)

# Editing can remove the only Do operation while leaving the image in /Resources.
# The resource inventory is then nonempty, but no image is painted.
unused_image_writer = pypdf.PdfWriter()
unused_image_writer.append(pypdf.PdfReader("xobject-image.pdf"))
empty_page_content = DecodedStreamObject()
empty_page_content.set_data(b"")
unused_image_writer.pages[0][NameObject("/Contents")] = (
    unused_image_writer._add_object(empty_page_content)
)
with open("unused-image-resource.pdf", "wb") as output:
    unused_image_writer.write(output)
unused_image_doc = fitz.open("unused-image-resource.pdf")
unused_image_page = unused_image_doc[0]
check("unused image fixture retains an XObject resource (negative control)",
      bool(unused_image_page.get_images()), unused_image_page.get_images())
check("unused image resource has no painted placement",
      unused_image_page.get_image_info(xrefs=True) == [],
      unused_image_page.get_image_info(xrefs=True))
check("unused image resource does not exempt an otherwise blank rendered page",
      inspected_page_is_blank(unused_image_page)
      and min(unused_image_page.get_pixmap(alpha=False).samples) == 255)

# Placement geometry, rather than mere presence in the content stream, decides visibility.
placement_canvas = canvas.Canvas("image-placement-visibility.pdf", pagesize=(200, 200))
placement_canvas.drawImage("inline-only-source.png", -40, 80, width=80, height=80)
placement_canvas.showPage()
placement_canvas.drawImage("inline-only-source.png", 250, 80, width=80, height=80)
placement_canvas.showPage()
placement_canvas.save()
placement_doc = fitz.open("image-placement-visibility.pdf")
check("partly intersecting image placement keeps a page nonblank",
      not inspected_page_is_blank(placement_doc[0]),
      placement_doc[0].get_image_info(xrefs=True))
check("fully off-page image placement does not exempt a blank page",
      inspected_page_is_blank(placement_doc[1]),
      placement_doc[1].get_image_info(xrefs=True))


def extract_images_without_duplicates(document, page, prefix):
    outputs = []
    for i, info in enumerate(page.get_images(full=True), start=1):
        pix = fitz.Pixmap(document, info[0])
        output = f"{prefix}-{i}.png"
        pix.save(output)
        outputs.append(output)
    image_xrefs = {
        image["number"]: image["xref"]
        for image in page.get_image_info(xrefs=True)
    }
    for block in page.get_text("dict")["blocks"]:
        if block["type"] != 1 or image_xrefs.get(block["number"]) != 0:
            continue
        ext = block.get("ext") or "png"
        output = f"{prefix}-inline-{block['number']}.{ext}"
        with open(output, "wb") as fh:
            fh.write(block["image"])
        outputs.append(output)
    return outputs


xobject_doc = fitz.open("xobject-image.pdf")
xobject_blocks = [
    block for block in xobject_doc[0].get_text("dict")["blocks"]
    if block["type"] == 1
]
xobject_info = xobject_doc[0].get_image_info(xrefs=True)
xobject_outputs = extract_images_without_duplicates(xobject_doc, xobject_doc[0], "xobject-export")
check("ordinary XObject image info exposes a positive xref",
      len(xobject_blocks) == 1 and len(xobject_info) == 1
      and xobject_info[0]["xref"] > 0,
      xobject_info)
check("ordinary XObject is exported once, not duplicated by the inline pass",
      len(xobject_outputs) == 1 and "-inline-" not in xobject_outputs[0], xobject_outputs)
inline_outputs = extract_images_without_duplicates(inline_doc, inline_page, "inline-export")
check("true inline image is exported by the xref-zero second pass",
      len(inline_outputs) == 1 and "-inline-" in inline_outputs[0]
      and os.path.getsize(inline_outputs[0]) > 0,
      inline_outputs)

# ---- extract.md CMYK conversion snippet ---------------------------------------
pix = fitz.Pixmap(fitz.csCMYK, fitz.IRect(0, 0, 24, 24))  # CMYK pixmap like a CMYK PDF image
converted = fitz.Pixmap(fitz.csRGB, pix) if pix.colorspace not in (fitz.csGRAY, fitz.csRGB) else pix
converted.save("cmyk-converted.png")
check("CMYK pixmap converts to a saved PNG", os.path.getsize("cmyk-converted.png") > 0)
rgb = fitz.Pixmap("cmyk-converted.png")
check("converted pixmap is RGB", "RGB" in str(rgb.colorspace), rgb.colorspace)

# ---- extract.md soft-mask composition: transparent image keeps alpha -----------
rgba = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 8, 8), True)
for y in range(rgba.height):
    for x in range(rgba.width):
        rgba.set_pixel(x, y, (255, 0, 0, 255 if x < 4 else 64))
rgba.save("transparent-source.png")

transparent_pdf = canvas.Canvas("transparent-image.pdf", pagesize=A4)
transparent_pdf.drawImage(
    "transparent-source.png", 72, 700, width=80, height=80, mask="auto"
)
transparent_pdf.save()

transparent_doc = fitz.open("transparent-image.pdf")
image_info = transparent_doc[0].get_images(full=True)[0]
check("transparent PDF image exposes a soft-mask xref", image_info[1] > 0, image_info)
base = fitz.Pixmap(transparent_doc, image_info[0])
if base.colorspace and base.colorspace not in (fitz.csGRAY, fitz.csRGB):
    base = fitz.Pixmap(fitz.csRGB, base)
mask = fitz.Pixmap(transparent_doc, image_info[1])
composited = fitz.Pixmap(base, mask)
composited.save("transparent-extracted.png")
reopened_composite = fitz.Pixmap("transparent-extracted.png")
check("soft-mask composition keeps an alpha channel", reopened_composite.alpha == 1)
check(
    "soft-mask composition keeps varying transparency",
    len(set(reopened_composite.samples[3::4])) > 1,
    set(reopened_composite.samples[3::4]),
)

# ---- create.md rule: escape plain text before Paragraph ------------------------
from reportlab.lib.pagesizes import A4 as A4_SIZE
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate
from xml.sax.saxutils import escape

MESSY = "R&D spend <budget> & \"pipeline\" > forecast"
try:
    SimpleDocTemplate("escaped.pdf", pagesize=A4_SIZE).build(
        [Paragraph(escape(MESSY), getSampleStyleSheet()["BodyText"])]
    )
    build_error = ""
except Exception as exc:  # unescaped markup typically raises a paraparser error
    build_error = str(exc)
check("escaped messy text builds without paraparser error", build_error == "", build_error)
esc_text = " ".join(page.get_text() for page in fitz.open("escaped.pdf"))
check("escaped text extracts with original characters",
      "R&D spend <budget>" in esc_text and "\"pipeline\"" in esc_text, esc_text[:120])

unescaped_failed = False
try:
    SimpleDocTemplate("raw.pdf", pagesize=A4_SIZE).build(
        [Paragraph(MESSY, getSampleStyleSheet()["BodyText"])]
    )
except Exception:
    unescaped_failed = True
if unescaped_failed:
    check("unescaped markup is proven dangerous (negative control)", True)
else:
    # lenient inputs build but render mangled: markup is swallowed, entities reinterpreted
    raw_text = " ".join(page.get_text() for page in fitz.open("raw.pdf"))
    check(
        "unescaped markup is proven dangerous (negative control)",
        "<budget>" not in raw_text or "R&D;" in raw_text,
        raw_text[:120],
    )

# ---- extract.md table route: find_tables instead of raw span soup ---------------
from reportlab.lib import colors
from reportlab.platypus import Table as RlTable, TableStyle

rl_table = RlTable(
    [["Region", "Sales"], ["North", "120"], ["South", "340"]],
    style=TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)]),
)
SimpleDocTemplate("table.pdf", pagesize=A4_SIZE).build([rl_table])

table_doc = fitz.open("table.pdf")
detected = table_doc[0].find_tables()
check("find_tables detects the drawn table", len(detected.tables) == 1, len(detected.tables))
if detected.tables:
    extracted_rows = detected.tables[0].extract()
    check("find_tables extracts the header row", extracted_rows[0] == ["Region", "Sales"], extracted_rows)
    check("find_tables extracts data rows", extracted_rows[2] == ["South", "340"], extracted_rows)


# ---- transform.md: stamps fit non-zero-origin and rotated destination pages ------

mixed_writer = PdfWriter()
mixed_writer.append(open_pdf("form.pdf"))
small_source = PdfWriter()
small_source.add_blank_page(width=200, height=300)
offset_page = small_source.add_blank_page(width=200, height=300)
offset_page.mediabox.lower_left = (100, 200)
offset_page.mediabox.upper_right = (300, 500)
offset_page.cropbox.lower_left = (100, 200)
offset_page.cropbox.upper_right = (300, 500)
rotated_page = small_source.add_blank_page(width=240, height=160)
rotated_page.rotate(90)
from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, TextStringObject
rotated_link = DictionaryObject({
    NameObject("/Type"): NameObject("/Annot"),
    NameObject("/Subtype"): NameObject("/Link"),
    NameObject("/Rect"): ArrayObject([FloatObject(value) for value in (20, 30, 100, 60)]),
    NameObject("/Border"): ArrayObject([FloatObject(0), FloatObject(0), FloatObject(0)]),
    NameObject("/A"): DictionaryObject({
        NameObject("/S"): NameObject("/URI"),
        NameObject("/URI"): TextStringObject("https://example.invalid/rotated-link"),
    }),
})
rotated_page[NameObject("/Annots")] = ArrayObject([small_source._add_object(rotated_link)])
cropped_page = small_source.add_blank_page(width=400, height=500)
cropped_page.cropbox.lower_left = (250, 300)
cropped_page.cropbox.upper_right = (390, 480)
mixed_writer.append(small_source)
with open("mixed.pdf", "wb") as f:
    mixed_writer.write(f)

def first_annotation_rect(page):
    return tuple(float(value) for value in page["/Annots"][0].get_object()["/Rect"])

mixed_rotated_page = R2("mixed.pdf").pages[4]
rotated_geometry_before = (mixed_rotated_page.rotation, first_annotation_rect(mixed_rotated_page))

# Negative control: a plain merge keeps the A4 stamp's coordinates, so the text
# lands outside the small page and cannot be extracted.
plain_writer = PdfWriter()
plain_writer.append(open_pdf("mixed.pdf"))
for page in plain_writer.pages:
    page.merge_page(R2("stamp.pdf").pages[0])
with open("plain-stamped.pdf", "wb") as f:
    plain_writer.write(f)

def stamp_bboxes(path, page_number):
    doc = fitz.open(path)
    spans = []
    for block in doc[page_number].get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                if "DRAFT" in span["text"]:
                    spans.append(span["bbox"])
    return spans

def stamp_line_directions(path, page_number):
    doc = fitz.open(path)
    return [
        line["dir"]
        for block in doc[page_number].get_text("dict")["blocks"]
        for line in block.get("lines", [])
        if any("DRAFT" in span["text"] for span in line["spans"])
    ]

# The plain merge keeps the A4 stamp's coordinates, so on the 200x300 page the
# stamp is far outside the box: PyMuPDF's positioned extraction sees no span at
# all, while pypdf's plain extractor still returns the text - proof that text
# extraction alone cannot validate visual placement.
plain_spans = stamp_bboxes("plain-stamped.pdf", 2)
check("plain merge pushes the stamp outside the small page (negative control)",
      plain_spans == [] and "DRAFT" in (R2("plain-stamped.pdf").pages[2].extract_text() or ""),
      plain_spans)

# Negative control for crop-box fitting: media-box centering puts the stamp
# outside this page's small, offset visible region.
media_fit_writer = PdfWriter()
media_fit_writer.append(open_pdf("mixed.pdf"), pages=(5, 6))
media_fit_page = media_fit_writer.pages[0]
media_destination = media_fit_page.mediabox
media_scale = min(float(media_destination.width) / float(stamp_box.width),
                  float(media_destination.height) / float(stamp_box.height))
media_tx = (float(media_destination.left)
            + (float(media_destination.width) - float(stamp_box.width) * media_scale) / 2
            - float(stamp_box.left) * media_scale)
media_ty = (float(media_destination.bottom)
            + (float(media_destination.height) - float(stamp_box.height) * media_scale) / 2
            - float(stamp_box.bottom) * media_scale)
media_fit_page.merge_transformed_page(
    stamp, Transformation().scale(media_scale).translate(media_tx, media_ty),
)
with open("media-fit-cropped.pdf", "wb") as f:
    media_fit_writer.write(f)
check("media-box fitting misses an offset crop region (negative control)",
      stamp_bboxes("media-fit-cropped.pdf", 0) == [])

scaled_writer = PdfWriter()
scaled_writer.append(open_pdf("mixed.pdf"))
stamp_page = R2("stamp.pdf").pages[0]
stamp_page.transfer_rotation_to_content()
stamp_box2 = stamp_page.cropbox
sw2, sh2 = float(stamp_box2.width), float(stamp_box2.height)
for page in scaled_writer.pages:
    page.merge_transformed_page(stamp_page, stamp_placement(page, stamp_box2))
with open("scaled-stamped.pdf", "wb") as f:
    scaled_writer.write(f)
scaled_check = R2("scaled-stamped.pdf")
check("scaled stamp is present on the A4 pages",
      all("DRAFT" in (p.extract_text() or "") for p in scaled_check.pages[:2]))
scaled_spans = stamp_bboxes("scaled-stamped.pdf", 2)
check("scaled stamp lands inside the mixed-size small page",
      bool(scaled_spans) and all(bbox[1] < 300 and bbox[3] <= 300.5 for bbox in scaled_spans),
      scaled_spans)
offset_spans = stamp_bboxes("scaled-stamped.pdf", 3)
rotated_spans = stamp_bboxes("scaled-stamped.pdf", 4)
cropped_spans = stamp_bboxes("scaled-stamped.pdf", 5)
check("scaled stamp lands inside the non-zero-origin page", bool(offset_spans), offset_spans)
rotated_fitz_page = fitz.open("scaled-stamped.pdf")[4]
rotated_visible_spans = [
    fitz.Rect(bbox) * rotated_fitz_page.rotation_matrix for bbox in rotated_spans
]
rotated_visible_directions = [
    (
        direction[0] * rotated_fitz_page.rotation_matrix.a
        + direction[1] * rotated_fitz_page.rotation_matrix.c,
        direction[0] * rotated_fitz_page.rotation_matrix.b
        + direction[1] * rotated_fitz_page.rotation_matrix.d,
    )
    for direction in stamp_line_directions("scaled-stamped.pdf", 4)
]
check("scaled stamp stays horizontal in the rotated page's visible space",
      bool(rotated_spans)
      and all(rect.width > rect.height for rect in rotated_visible_spans)
      and all(dx > 0.9 and abs(dy) < 0.1 for dx, dy in rotated_visible_directions),
      (rotated_visible_spans, rotated_visible_directions))
cropped_rect = fitz.open("scaled-stamped.pdf")[5].rect
check("scaled stamp lands inside the offset visible crop box",
      bool(cropped_spans)
      and all(
          bbox[0] >= -0.5 and bbox[1] >= -0.5
          and bbox[2] <= cropped_rect.width + 0.5
          and bbox[3] <= cropped_rect.height + 0.5
          for bbox in cropped_spans
      ), cropped_spans)
check("mixed-size pages keep their original media boxes",
      [(round(float(p.mediabox.width)), round(float(p.mediabox.height)))
       for p in scaled_check.pages]
      == [(595, 842), (595, 842), (200, 300), (200, 300), (240, 160), (400, 500)])
scaled_rotated_page = scaled_check.pages[4]
check("watermarking preserves rotated-page annotation geometry",
      (scaled_rotated_page.rotation, first_annotation_rect(scaled_rotated_page))
      == rotated_geometry_before,
      ((scaled_rotated_page.rotation, first_annotation_rect(scaled_rotated_page)),
       rotated_geometry_before))
mixed_link_before = tuple(
    round(float(value), 4)
    for value in fitz.open("mixed.pdf")[4].get_links()[0]["from"]
)
mixed_link_after = tuple(
    round(float(value), 4)
    for value in fitz.open("scaled-stamped.pdf")[4].get_links()[0]["from"]
)
check("watermarking preserves the rotated link's visible hit rectangle",
      mixed_link_after == mixed_link_before, (mixed_link_before, mixed_link_after))


# ---- SKILL.md overflow check: off-page text and graphics are defects ------------
overflow_ok = canvas.Canvas("overflow.pdf", pagesize=A4)
overflow_ok.setFont("Helvetica", 16)
overflow_ok.drawString(72, 780, "fits on page")
overflow_ok.showPage()
overflow_ok.save()
overflow_bad = canvas.Canvas("overflow-bad.pdf", pagesize=A4)
overflow_bad.setFont("Helvetica", 16)
overflow_bad.drawString(72, -200, "drawn far below the page box")
overflow_bad.showPage()
overflow_bad.save()
overflow_very_far = canvas.Canvas("overflow-very-far.pdf", pagesize=A4)
overflow_very_far.setFont("Helvetica", 16)
overflow_very_far.drawString(72, -5000, "drawn beyond the old finite search window")
overflow_very_far.showPage()
overflow_very_far.save()

rotated_source = canvas.Canvas("overflow-rotated-source.pdf", pagesize=A4)
rotated_source.setFont("Helvetica", 16)
rotated_source.drawString(72, 30, "valid near the unrotated page bottom")
rotated_source.showPage()
rotated_source.save()
rotated_writer = PdfWriter()
rotated_writer.append(R2("overflow-rotated-source.pdf"))
rotated_writer.pages[0].rotate(90)
with open("overflow-rotated.pdf", "wb") as f:
    rotated_writer.write(f)

graphics_ok = canvas.Canvas("overflow-graphics-ok.pdf", pagesize=A4)
graphics_ok.drawInlineImage("inline-only-source.png", 72, 700, width=80, height=80)
graphics_ok.setLineWidth(2)
graphics_ok.rect(72, 600, 100, 50, stroke=1, fill=0)
graphics_ok.showPage()
graphics_ok.save()

image_bad = canvas.Canvas("overflow-image-bad.pdf", pagesize=A4)
image_bad.drawInlineImage("inline-only-source.png", 560, 700, width=80, height=80)
image_bad.showPage()
image_bad.save()

drawing_bad = canvas.Canvas("overflow-drawing-bad.pdf", pagesize=A4)
drawing_bad.setLineWidth(2)
drawing_bad.rect(560, 600, 80, 50, stroke=1, fill=0)
drawing_bad.showPage()
drawing_bad.save()

rotated_graphics_source = canvas.Canvas("overflow-graphics-rotated-source.pdf", pagesize=A4)
rotated_graphics_source.drawInlineImage(
    "inline-only-source.png", 500, 700, width=80, height=80,
)
rotated_graphics_source.setLineWidth(2)
rotated_graphics_source.rect(20, 20, 80, 40, stroke=1, fill=0)
rotated_graphics_source.showPage()
rotated_graphics_source.save()
rotated_graphics_writer = PdfWriter()
rotated_graphics_writer.append(R2("overflow-graphics-rotated-source.pdf"))
rotated_graphics_writer.pages[0].rotate(90)
with open("overflow-graphics-rotated.pdf", "wb") as f:
    rotated_graphics_writer.write(f)

def overflow_pages(path, password=None):
    doc = fitz.open(path)
    if doc.needs_pass and doc.authenticate("") <= 0:
        if not password:
            raise RuntimeError(f"valid password required to overflow-check {path}")
        if doc.authenticate(password) <= 0:
            raise RuntimeError(f"password could not decrypt {path} for overflow checking")
    pages = []
    for page in doc:
        # Plain block extraction drops fully off-page text; disable clipping.
        crop_left, crop_bottom, crop_right, crop_top = normalized_box(page.cropbox)
        page_box = fitz.Rect(0, 0, crop_right - crop_left, crop_top - crop_bottom)
        text_rects = [
            fitz.Rect(block[:4])
            for block in page.get_text("blocks", clip=fitz.INFINITE_RECT())
            if block[6] == 0
        ]
        image_rects = [
            fitz.Rect(0, 0, 1, 1) * fitz.Matrix(*image["transform"])
            for image in page.get_image_info()
        ]
        drawing_rects = [drawing_bounds(drawing) for drawing in page.get_drawings()]
        if any(rect.x0 < page_box.x0 - 0.5 or rect.y0 < page_box.y0 - 0.5
               or rect.x1 > page_box.x1 + 0.5 or rect.y1 > page_box.y1 + 0.5
               for rect in text_rects + image_rects + drawing_rects):
            pages.append(page.number + 1)
    doc.close()
    return pages

check("in-bounds PDF reports no overflow pages", overflow_pages("overflow.pdf") == [])
check("blank-user-password encrypted PDF passes the independent overflow check",
      overflow_pages("blank-user-password.pdf") == [])
check("reversed page boxes remain valid through the overflow postcheck",
      overflow_pages("widget-reversed-page-boxes.pdf") == [])
check("off-page text is detected by the overflow check (negative control)",
      overflow_pages("overflow-bad.pdf") == [1])
very_far_probe = fitz.open("overflow-very-far.pdf")[0]
old_finite_clip = fitz.Rect(
    very_far_probe.rect.x0 - 2000, very_far_probe.rect.y0 - 2000,
    very_far_probe.rect.x1 + 2000, very_far_probe.rect.y1 + 2000,
)
check("the old finite clip misses text positioned more than 2,000 points away (negative control)",
      not [block for block in very_far_probe.get_text("blocks", clip=old_finite_clip)
           if block[6] == 0])
check("the unbounded overflow check detects very distant positioned text",
      overflow_pages("overflow-very-far.pdf") == [1])
check("in-bounds image and vector drawing pass the overflow check",
      overflow_pages("overflow-graphics-ok.pdf") == [])
check("out-of-bounds image placement is detected",
      overflow_pages("overflow-image-bad.pdf") == [1])
check("out-of-bounds vector drawing is detected",
      overflow_pages("overflow-drawing-bad.pdf") == [1])
rotated_probe = fitz.open("overflow-rotated.pdf")[0]
rotated_blocks = rotated_probe.get_text(
    "blocks", clip=fitz.Rect(-2000, -2000, 2000, 3000),
)
rotation_blind_flag = any(
    block[2] > rotated_probe.rect.width + 0.5
    or block[3] > rotated_probe.rect.height + 0.5
    for block in rotated_blocks if block[6] == 0
)
check("rotated rect comparison falsely flags valid text (negative control)", rotation_blind_flag)
check("overflow check compares rotated pages in unrotated coordinates",
      overflow_pages("overflow-rotated.pdf") == [])
rotated_graphics_probe = fitz.open("overflow-graphics-rotated.pdf")[0]
rotated_graphic_rects = (
    [fitz.Rect(0, 0, 1, 1) * fitz.Matrix(*image["transform"])
     for image in rotated_graphics_probe.get_image_info()]
    + [drawing_bounds(drawing) for drawing in rotated_graphics_probe.get_drawings()]
)
rotation_blind_graphics_flag = any(
    rect.x1 > rotated_graphics_probe.rect.width + 0.5
    or rect.y1 > rotated_graphics_probe.rect.height + 0.5
    for rect in rotated_graphic_rects
)
check("rotated rect comparison falsely flags valid graphics (negative control)",
      rotation_blind_graphics_flag, rotated_graphic_rects)
check("graphic overflow check preserves rotated coordinate correctness",
      overflow_pages("overflow-graphics-rotated.pdf") == [])
check("off-page text still extracts, so extraction alone cannot catch it",
      "drawn far below" in (pypdf.PdfReader("overflow-bad.pdf").pages[0].extract_text() or ""))


print("\n" + ("ALL PDF FIXTURES PASSED" if not failures else f"{len(failures)} FAILURES: {failures}"))
sys.exit(0 if not failures else 1)
