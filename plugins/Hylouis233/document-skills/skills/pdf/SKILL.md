---
name: pdf
description: Create, extract, transform, or analyze PDF documents. Use this Skill whenever a .pdf file is the input or output - generating reports, one-pagers, posters or structured documents as real selectable-text PDFs; extracting text, tables or images from existing PDFs; merging, splitting, rotating, or watermarking pages; filling forms; checking that a produced PDF has the right page count and extractable text.
---

# PDF workbench

PDF tasks fail when the agent mixes incompatible libraries or generates pages as screenshots.
Route by job, use one tool per job, verify the artifact.

## Step 0 - Check the toolchain

```bash
python -c "import reportlab, pypdf, fitz; print('reportlab', reportlab.Version, '| pypdf ok | pymupdf ok')"
```

- `reportlab` - creation (preferred: selectable text, controlled layout).
- `pypdf` - page-level transforms: split, merge, rotate, encrypt, form fields.
- `pymupdf` (`fitz`) - extraction (text with coordinates, tables, images), rasterization,
  page-level inspection.

Missing any -> say so and degrade to the ones present; do not substitute screenshot pipelines.

## Step 1 - Pick exactly one tool for the job

| Task | Tool | Reference |
|---|---|---|
| Build a new structured PDF (report, one-pager, letter, checklist) | ReportLab | [references/create.md](references/create.md) |
| Extract text / tables / images | PyMuPDF | [references/extract.md](references/extract.md) |
| Merge, split, rotate, watermark, encrypt, forms | pypdf | [references/transform.md](references/transform.md) |
| Inspect: page count, sizes, fonts, links, blank-page detection | PyMuPDF | [references/inspect.md](references/inspect.md) |

Chaining tools on one artifact is fine (create -> inspect). Using two creation libraries on one
file is not.

## Step 2 - Shared rules

1. **Text-first**: a generated PDF must contain extractable text. Image-of-text is acceptable
   only when the user asked for a rasterized look or provides only images.
2. **Page geometry is explicit**: A4 = 595.27 x 841.89 pt, US Letter = 612 x 792 pt. Declare
   the target size and margins up front; re-check fit after generation.
3. **Fonts**: the standard 14 fonts cover only limited encodings; they do not automatically
   support arbitrary Unicode. Check that the selected face contains every requested character.
   If any glyph is unsupported - including CJK, Cyrillic, Arabic, Devanagari, or emoji - embed
   one or more licensed TTF/OTF fonts with the required coverage and use them for those runs.
   If no suitable embeddable font is available, report the limitation instead of emitting tofu.
4. **Overflow is a defect**: content that spills past the last page or the margin must be
   detected in postcheck and fixed (shrink, paginate, or cut), never shipped.
5. Write output to a new path; keep inputs untouched unless in-place was requested.
6. **Accessibility claims require tagged output.** ReportLab does not produce a tagged PDF/UA
   document, so do not describe ordinary ReportLab output as accessible or screen-reader-ready.
   When PDF/UA or assistive-technology compatibility is required, use a toolchain that can create
   and validate tags, reading order, structure roles, language, and alternative text. If that
   toolchain is unavailable, stop and report the limitation; offer an accessible DOCX or HTML
   deliverable instead of silently returning an untagged PDF.

## Step 3 - Postcheck (mandatory)

```python
import os
import fitz
import pypdf

output_path = "output.pdf"
expected_page_count = 1  # set this from the task; do not derive it from the output
password = os.environ.get("PDF_PASSWORD")
r = pypdf.PdfReader(output_path)
if r.is_encrypted:
    # Permission-encrypted PDFs commonly have an empty user password and open normally.
    if r.decrypt("") == 0:
        if not password:
            raise RuntimeError("set PDF_PASSWORD so the encrypted output can be postchecked")
        if r.decrypt(password) == 0:
            raise RuntimeError("PDF_PASSWORD could not decrypt the output")

def require(condition, message):
    # Mandatory verification must remain active under python -O.
    if not condition:
        raise ValueError(message)

page_count = len(r.pages)
require(
    page_count == expected_page_count,
    f"expected {expected_page_count} pages, got {page_count}",
)
render_doc = fitz.open(output_path)
if render_doc.needs_pass and render_doc.authenticate("") <= 0:
    if not password:
        raise RuntimeError("set PDF_PASSWORD so encrypted widgets can be rendered")
    if render_doc.authenticate(password) <= 0:
        raise RuntimeError("PDF_PASSWORD could not decrypt the output for widget rendering")
page_texts = {
    number: (page.extract_text() or "").strip()
    for number, page in enumerate(r.pages, start=1)
}

def normalized_box(box):
    x0, y0, x1, y1 = (float(value) for value in box)
    left, right = sorted((x0, x1))
    bottom, top = sorted((y0, y1))
    return left, bottom, right, top

def normalized_size(box):
    left, bottom, right, top = normalized_box(box)
    return right - left, top - bottom

def widget_count(page, rendered_page):
    # Interactive-only pages can be valid, but hidden metadata widgets are not visible content.
    non_viewable_flags = 1 | 2 | 32  # Invisible, Hidden, NoView annotation flags
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
        # Do not require /AP: viewers may synthesize it from field defaults. Instead,
        # render annotations on and off and require this widget region to change visibly.
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

intentionally_raster_only_pages = set()
missing_text_pages = [
    number for number, text in page_texts.items()
    if number not in intentionally_raster_only_pages
    and not text
    and widget_count(r.pages[number - 1], render_doc[number - 1]) == 0
]
require(not missing_text_pages, f"pages without extractable text: {missing_text_pages}")
# Add task-specific checks when exact copy matters, for example
# {1: ("Report title",), 2: ("Conclusion",)}. Per-page text presence is enforced above.
expected_strings_by_page = {}
for page_number, expected_strings in expected_strings_by_page.items():
    missing = [value for value in expected_strings if value not in page_texts[page_number]]
    require(not missing, f"page {page_number} is missing {missing}")
# Compare width/height to the exact size used at creation with a small point tolerance.
# ReportLab A4 is about (595.2756, 841.8898), not the rounded prose value (595.27, 841.89).
expected_page_size = (595.2756, 841.8898)  # replace for Letter or a task-specific size
page_size_tolerance = 0.5
page_sizes = [
    normalized_size(page.mediabox) for page in r.pages
]
size_mismatches = [
    (number, actual)
    for number, actual in enumerate(page_sizes, start=1)
    if any(abs(value - expected) > page_size_tolerance
           for value, expected in zip(actual, expected_page_size))
]
require(not size_mismatches, f"unexpected page sizes: {size_mismatches}")

# Overflow is a defect (shared rule 4): text, images, or vector drawings that run
# past the page box are clipped even though every check above still passes. Plain
# text extraction silently drops fully off-page text, so use an enlarged clip for
# text and inspect the placement boxes reported for every image and drawing.
overflow_doc = render_doc
overflow_pages = []
for page in overflow_doc:
    # These APIs report unrotated coordinates even when /Rotate is 90/270;
    # page.rect uses rotated dimensions. Compare against an unrotated crop-box
    # extent so valid high-y portrait content is not flagged on a rotated page.
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
    drawing_rects = []
    for drawing in page.get_drawings():
        rect = fitz.Rect(drawing["rect"])
        # Path rectangles exclude stroke thickness. Expand stroked paths so a
        # line centered on the page edge cannot hide half its width off-page.
        stroke_pad = (
            float(drawing.get("width") or 0) / 2
            if "s" in drawing.get("type", "") else 0
        )
        drawing_rects.append(fitz.Rect(
            rect.x0 - stroke_pad, rect.y0 - stroke_pad,
            rect.x1 + stroke_pad, rect.y1 + stroke_pad,
        ))
    beyond_box = any(
        rect.x0 < page_box.x0 - 0.5 or rect.y0 < page_box.y0 - 0.5
        or rect.x1 > page_box.x1 + 0.5 or rect.y1 > page_box.y1 + 0.5
        for rect in text_rects + image_rects + drawing_rects
    )
    if beyond_box:
        overflow_pages.append(page.number + 1)
overflow_doc.close()
require(not overflow_pages, f"content extends past the page box on pages: {overflow_pages}")
# The page box is the hard bound. When the task declares specific margins,
# additionally check key blocks against them (or render and inspect visually) -
# content inside the box but past a declared margin is a softer, task-specific
# defect to report.
```

Confirm: page count matches the request; every page except those explicitly listed in
`intentionally_raster_only_pages` has extractable text or at least one form widget (a pure
interactive page); each requested key string is listed in `expected_strings_by_page` and
extracts on the correct page; every value in `page_sizes` is the declared size within
`page_size_tolerance`; and no page's text, image placements, or vector drawings extend past
the page box (the overflow check). Report all five. For pixel-sensitive work, render every applicable page
with PyMuPDF at 100 dpi and check that each render is non-blank (mean pixel value).
