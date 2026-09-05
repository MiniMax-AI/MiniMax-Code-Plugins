# Inspect a PDF (PyMuPDF)

```python
import math
import os
import re
import fitz

doc = fitz.open("input.pdf")
if doc.needs_pass:
    password = os.environ.get("PDF_PASSWORD", "")
    if doc.authenticate(password) <= 0:
        raise RuntimeError("Encrypted PDF: set a valid PDF_PASSWORD before inspection")

DIRECT_CHARPROC_NAME = re.compile(
    r"/(?:#[0-9A-Fa-f]{2}|[^#\s()<>\[\]{}/%])+"
)
DIRECT_CHARPROC_REFERENCE = re.compile(r"\s+([1-9]\d*)\s+\d+\s+R")

def indirect_xref(value):
    match = re.fullmatch(r"\s*([1-9]\d*)\s+\d+\s+R\s*", value or "")
    return int(match.group(1)) if match else None

def direct_charproc_xrefs(value):
    """Parse only a conservative direct dictionary of name -> indirect-object entries."""
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
    """Return verified, malformed, or uninspectable without reading glyph streams."""
    if font_type.replace(" ", "").casefold() != "type3":
        return None
    if xref <= 0:  # A direct font dictionary has no xref for safe nested lookup.
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
    """Distinguish font files, verified Type3 glyph streams, and unknown cases."""
    fonts = []
    for entry in page.get_fonts(full=True):
        xref, extension, font_type, base_name, resource_name, encoding = entry[:6]
        is_type3 = font_type.replace(" ", "").casefold() == "type3"
        charprocs_status = type3_charprocs_status(document, xref, font_type)
        embedded_bytes = 0
        if xref > 0:
            try:
                extracted = document.extract_font(xref)
                embedded_bytes = len(extracted[3] or b"")
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
            "xref": xref,
            "base_name": base_name,
            "resource_name": resource_name,
            "type": font_type,
            "encoding": encoding,
            "extension": extension,
            "embedded": embedded,
            "embedded_bytes": embedded_bytes,
            "self_contained": self_contained,
            "charprocs_status": charprocs_status,
            "program_source": program_source,
        })
    return fonts

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
    """Use text render mode, opacity, clipping, and bounded alpha rendering."""
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
    """Render bounded placement clips; unknown visibility keeps the page nonblank."""
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
    # Link hit rectangles are useful without a painted appearance. PyMuPDF reports
    # them in rotated page coordinates already, unlike widget / annotation rects.
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

print("pages:", doc.page_count)
print("password_protected:", doc.needs_pass,
      "| still_encrypted:", doc.is_encrypted, "| pdf:", doc.is_pdf)
page_geometry = []
for page in doc:
    media_size = (round(page.mediabox.width, 2), round(page.mediabox.height, 2))
    crop_size = (round(page.cropbox.width, 2), round(page.cropbox.height, 2))
    page_geometry.append({
        "page": page.number + 1,
        "media_size": media_size,
        "crop_size": crop_size,
        "rotation": page.rotation,
    })
    text_spans, visible_text, text_visibility_unknown = viewable_text(page)
    image_placements, visible_images, image_visibility_unknown = viewable_images(page)
    drawings, visible_drawings, drawing_visibility_unknown = viewable_drawings(page)
    widgets, annotations, links, interaction_visibility_unknown = viewable_interactives(page)
    is_blank = not (
        visible_text or visible_images or visible_drawings
        or widgets or annotations or links
        or text_visibility_unknown or image_visibility_unknown or drawing_visibility_unknown
        or interaction_visibility_unknown
    )
    print(page.number + 1, "media_size:", media_size, "crop_size:", crop_size,
          "rotation:", page.rotation, "text_len:", len(page.get_text()),
          "text_spans:", len(text_spans), "visible_text_spans:", len(visible_text),
          "text_visibility_unknown:", text_visibility_unknown,
          "resource_images:", len(page.get_images()),
          "image_placements:", len(image_placements),
          "visible_images:", len(visible_images),
          "image_visibility_unknown:", image_visibility_unknown,
          "drawing_paths:", len(drawings),
          "visible_drawings:", len(visible_drawings),
          "drawing_visibility_unknown:", drawing_visibility_unknown,
          "widgets:", len(widgets), "annotations:", len(annotations),
          "links:", len(links), "interaction_visibility_unknown:",
          interaction_visibility_unknown, "blank:", is_blank)
    print("  fonts:", font_inventory(doc, page))
print("media_size_consistent:", len({row["media_size"] for row in page_geometry}) <= 1)
print("crop_size_consistent:", len({row["crop_size"] for row in page_geometry}) <= 1)
```

## Checks worth automating

- **Blank page detection**: flag only when rendered text, visible painted image placements and vector paths,
  and viewable widgets, annotations, and links are all absent. Ignore interactive objects carrying
  invisible, hidden, or no-view flags, as well as empty, off-page, or unrendered appearances.
  `page.get_images()` lists every image XObject resource, including unused resources, and also
  misses images embedded inline in the content stream. `page.get_image_info()` reports invoked
  inline and XObject placements without loading their bytes, but its boxes ignore graphics-state
  clipping. Treat those boxes as diagnostics only. The bounded `viewable_images()` render checks
  alpha for each page-intersecting placement; a count, source-pixel, render-pixel, or decoder limit
  returns `image_visibility_unknown=True`, which must keep the page nonblank. Interactive form
  `page.get_drawings()` similarly reports paths that are off-page, fully clipped, hidden by page
  state, or painted with zero opacity. The bounded `viewable_drawings()` checks each
  page-intersecting path clip against the actual alpha render; path-count, render-pixel, or renderer
  limits return `drawing_visibility_unknown=True`, which also keeps the page nonblank. Interactive
  form fields are widgets rather
  than page text, so a three-content-stream predicate alone would misclassify a usable form
  page as blank. A blank page after generation usually means an overflowing flowable created it.
- **Font inventory**: `page.get_fonts()` lists referenced fonts, including non-embedded base
  fonts. Use `doc.extract_font(xref)` as above for conventional font files. Type3 fonts are a
  separate case: report `charprocs_status="verified"` only for a nonempty `/CharProcs` dictionary
  whose glyph entries point to actual streams. A direct font dictionary has no font xref and is
  `uninspectable`, not falsely non-embedded. For Type3, `embedded` and `self_contained` are tri-state:
  `True` for verified, `False` for malformed, and `None` when uninspectable. Its
  `program_source="type3-charprocs"` remains explicit even when conventional bytes do not extract.
  Other referenced faces with no extractable program may be substituted on another machine.
- **Page size consistency**: compare unrotated `(width, height)` pairs from `page.mediabox` and
  `page.cropbox`, and report `page.rotation` separately. Do not compare `page.rect`: it applies
  `/Rotate`, so otherwise identical paper appears to swap width and height at 90 or 270 degrees.
  Report genuinely mixed media or crop sizes rather than silently normalizing them.
- **Damage**: `fitz.open` on a corrupt file raises or yields garbage - pair with
  `pypdf.PdfReader` cross-check when provenance is unknown.

Report findings as a table (page, media size, crop size, rotation, text chars, resource images,
image placements, visible images, image visibility unknown, drawing paths, visible drawings,
drawing visibility unknown, widgets, annotations, links, interaction visibility unknown, blank) - it
is what every downstream decision hangs off.
