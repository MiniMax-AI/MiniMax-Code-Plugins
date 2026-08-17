# Minimal runnable fixtures for the snippets called out in review: one file per format.
# Each script is self-contained, writes only scratch files into the current directory,
# and exits non-zero on failed assertions. Run from any scratch directory:
#   python pdf_fixture.py   (deps: reportlab, pypdf, pymupdf)
#   python pptx_fixture.py  (deps: python-pptx)
#   python xlsx_fixture.py  (deps: openpyxl)
#   python docx_fixture.py  (deps: python-docx, pymupdf, soffice on PATH)
import os
import sys

import fitz
import pypdf
import reportlab
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

def font_inventory(document, page):
    fonts = []
    for entry in page.get_fonts(full=True):
        xref, extension, font_type, base_name, resource_name, encoding = entry[:6]
        embedded_bytes = 0
        if xref > 0:
            try:
                embedded_bytes = len((document.extract_font(xref)[3] or b""))
            except (RuntimeError, ValueError):
                embedded_bytes = 0
        fonts.append({
            "base_name": base_name, "embedded": embedded_bytes > 0,
            "embedded_bytes": embedded_bytes,
        })
    return fonts

font_doc = fitz.open("font-inventory.pdf")
fonts = font_inventory(font_doc, font_doc[0])
check("font inventory labels the embedded TrueType face",
      any("Vera" in item["base_name"] and item["embedded"] for item in fonts), fonts)
check("font inventory labels referenced-only Helvetica as non-embedded",
      any("Helvetica" in item["base_name"] and not item["embedded"] for item in fonts), fonts)

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
widgets = list(widget_page.widgets() or ())
annotations = list(widget_page.annots() or ())
links = widget_page.get_links()
blank = (
    not widget_page.get_text().strip()
    and not widget_page.get_images()
    and not widget_page.get_drawings()
    and not widgets and not annotations and not links
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
          and not bool((hidden_page.extract_text() or "").strip()))

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
          widget_count(geometry_page, geometry_render[0]) == 0)

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
    image_blocks = [
        block for block in page.get_text("dict")["blocks"]
        if block["type"] == 1
    ]
    return not (
        page.get_text().strip() or page.get_images() or image_blocks
        or page.get_drawings() or list(page.widgets() or ())
        or list(page.annots() or ()) or page.get_links()
    )


form_only_is_blank = inspected_page_is_blank(form_only_page)
check("form-only page exposes a widget", len(form_only_widgets) == 1)
check("form-only page is not classified as blank", not form_only_is_blank)

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


def drawing_bounds(drawing):
    rect = fitz.Rect(drawing["rect"])
    stroke_pad = (
        float(drawing.get("width") or 0) / 2
        if "s" in drawing.get("type", "") else 0
    )
    return fitz.Rect(
        rect.x0 - stroke_pad, rect.y0 - stroke_pad,
        rect.x1 + stroke_pad, rect.y1 + stroke_pad,
    )


def overflow_pages(path, password=None):
    doc = fitz.open(path)
    if doc.needs_pass and doc.authenticate("") <= 0:
        if not password:
            raise RuntimeError(f"valid password required to overflow-check {path}")
        if doc.authenticate(password) <= 0:
            raise RuntimeError(f"password could not decrypt {path} for overflow checking")
    pages = []
    for page in doc:
        # Plain block extraction drops fully off-page text; enlarge the clip.
        crop_left, crop_bottom, crop_right, crop_top = normalized_box(page.cropbox)
        page_box = fitz.Rect(0, 0, crop_right - crop_left, crop_top - crop_bottom)
        clip = fitz.Rect(
            page_box.x0 - 2000, page_box.y0 - 2000,
            page_box.x1 + 2000, page_box.y1 + 2000,
        )
        text_rects = [
            fitz.Rect(block[:4])
            for block in page.get_text("blocks", clip=clip)
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
