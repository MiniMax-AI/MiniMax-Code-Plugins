# Inspect a PDF (PyMuPDF)

```python
import os
import fitz

doc = fitz.open("input.pdf")
if doc.needs_pass:
    password = os.environ.get("PDF_PASSWORD", "")
    if doc.authenticate(password) <= 0:
        raise RuntimeError("Encrypted PDF: set a valid PDF_PASSWORD before inspection")

def font_inventory(document, page):
    """Distinguish fonts with extractable programs from referenced-only faces."""
    fonts = []
    for entry in page.get_fonts(full=True):
        xref, extension, font_type, base_name, resource_name, encoding = entry[:6]
        embedded_bytes = 0
        if xref > 0:
            try:
                extracted = document.extract_font(xref)
                embedded_bytes = len(extracted[3] or b"")
            except (RuntimeError, ValueError):
                embedded_bytes = 0
        fonts.append({
            "xref": xref,
            "base_name": base_name,
            "resource_name": resource_name,
            "type": font_type,
            "encoding": encoding,
            "extension": extension,
            "embedded": embedded_bytes > 0,
            "embedded_bytes": embedded_bytes,
        })
    return fonts

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
    blocks = page.get_text("dict")["blocks"]
    image_blocks = [block for block in blocks if block["type"] == 1]
    drawings = page.get_drawings()
    widgets = list(page.widgets() or ())
    annotations = list(page.annots() or ())
    links = page.get_links()
    is_blank = not (
        page.get_text().strip() or page.get_images() or image_blocks or drawings
        or widgets or annotations or links
    )
    print(page.number + 1, "media_size:", media_size, "crop_size:", crop_size,
          "rotation:", page.rotation, "text_len:", len(page.get_text()),
          "resource_images:", len(page.get_images()),
          "image_blocks:", len(image_blocks), "drawings:", len(drawings),
          "widgets:", len(widgets), "annotations:", len(annotations),
          "links:", len(links), "blank:", is_blank)
    print("  fonts:", font_inventory(doc, page))
print("media_size_consistent:", len({row["media_size"] for row in page_geometry}) <= 1)
print("crop_size_consistent:", len({row["crop_size"] for row in page_geometry}) <= 1)
```

## Checks worth automating

- **Blank page detection**: flag only when text, resource images, type-1 image blocks, drawings,
  widgets, annotations, and links are all absent. `page.get_images()` lists image XObjects but
  misses images embedded inline in the content stream; type-1 blocks from `get_text("dict")`
  cover both inline and XObject image placements. Interactive form fields are widgets rather
  than page text, so a three-content-stream predicate alone would misclassify a usable form
  page as blank. A blank page after generation usually means an overflowing flowable created it.
- **Font inventory**: `page.get_fonts()` lists referenced fonts, including non-embedded base
  fonts. Use `doc.extract_font(xref)` as above and report `embedded` separately; a referenced
  face with no extractable program may be substituted on another machine.
- **Page size consistency**: compare unrotated `(width, height)` pairs from `page.mediabox` and
  `page.cropbox`, and report `page.rotation` separately. Do not compare `page.rect`: it applies
  `/Rotate`, so otherwise identical paper appears to swap width and height at 90 or 270 degrees.
  Report genuinely mixed media or crop sizes rather than silently normalizing them.
- **Damage**: `fitz.open` on a corrupt file raises or yields garbage - pair with
  `pypdf.PdfReader` cross-check when provenance is unknown.

Report findings as a table (page, media size, crop size, rotation, text chars, resource images,
image blocks, drawings, widgets, annotations, links, blank) - it is what every downstream
decision hangs off.
