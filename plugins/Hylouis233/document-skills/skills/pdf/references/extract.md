# Extract from a PDF (PyMuPDF)

```python
import os
import fitz  # pymupdf

doc = fitz.open("input.pdf")
if doc.needs_pass and doc.authenticate("") <= 0:
    password = os.environ.get("PDF_PASSWORD")
    if not password or not doc.authenticate(password):
        raise RuntimeError("set PDF_PASSWORD to the correct password before extracting")
print("pages:", doc.page_count, "metadata:", doc.metadata)

# Extract each page; do not use `page` after this loop.
for page in doc:
    page_number = page.number + 1

    # Plain text
    text = page.get_text("text", sort=True)  # position-sorted reading order for simple layouts
    print(f"--- page {page_number} ---")
    print(text)

    # Tables: use real table detection (ruled and many borderless layouts), not span soup.
    # Cells come back as strings, or None for merged/empty cells. Requires PyMuPDF >= 1.23.
    try:
        tables = page.find_tables()
    except AttributeError:
        tables = None
        print(f"page {page_number}: PyMuPDF lacks find_tables; fall back to the span route below")
    if tables is not None:
        if not tables.tables:
            print(f"page {page_number}: no table detected")
        for t, table in enumerate(tables.tables, start=1):
            print(f"page {page_number} table {t} bbox:", tuple(round(v) for v in table.bbox))
            for row in table.extract():
                print(row)

    # With coordinates (decide columns/reading order yourself); also the fallback
    # when a table is visually present but find_tables detected nothing.
    # Collect and sort first: spans arrive in content-stream order, which can
    # differ from the visual order even when plain text extraction is sorted.
    spans = [
        (page_number, round(span["bbox"][0]), round(span["bbox"][1]), span["text"])
        for block in page.get_text("dict")["blocks"]
        for line in block.get("lines", [])
        for span in line["spans"]
    ]
    for record in sorted(spans, key=lambda item: (item[2], item[1])):
        print(*record)

    # Images. Apply a soft mask (xref at info[1]) before saving or transparency is lost.
    # Pixmap keeps the image's own colorspace: convert CMYK/ICC bases to RGB first.
    # This loop sees image XObjects only.
    for i, info in enumerate(page.get_images(full=True), start=1):
        base = fitz.Pixmap(doc, info[0])
        if base.colorspace and base.colorspace not in (fitz.csGRAY, fitz.csRGB):
            base = fitz.Pixmap(fitz.csRGB, base)
        if info[1] > 0:
            mask = fitz.Pixmap(doc, info[1])
            pix = fitz.Pixmap(base, mask)
        else:
            pix = base
        pix.save(f"img-p{page_number}-{i}.png")

    # Type-1 blocks include both XObjects and inline images. An xref of zero
    # identifies true inline content; positive xrefs were already exported by
    # the XObject loop above and must not be written a second time.
    image_xrefs = {
        image["number"]: image["xref"]
        for image in page.get_image_info(xrefs=True)
    }
    for b in page.get_text("dict")["blocks"]:
        if b["type"] != 1 or image_xrefs.get(b["number"]) != 0:
            continue
        ext = b.get("ext") or "png"
        with open(f"img-p{page_number}-inline-{b['number']}.{ext}", "wb") as fh:
            fh.write(b["image"])

    # Rasterize (for visual checks or OCR preprocessing)
    pix = page.get_pixmap(dpi=150)
    pix.save(f"page-{page_number}.png")
```

## Rules

- Scanned pages return empty `get_text`. Check each page; if its text is empty and it contains
  images, report that page as "scanned, needs OCR" instead of claiming there is no text.
- Tables: run `find_tables()` first and extract rows/cells; only when detection returns nothing
  but a table is visually present, reconstruct it from span coordinates - and say that
  automatic detection failed. Merged cells arrive as `None`; preserve them, do not coerce to
  empty strings silently.
- "Sort by position" before emitting tables: spans come in internal order, not visual order;
  sort by `(round(bbox[1]), bbox[0])` for top-to-bottom, left-to-right reading.
- Two-column layouts: cluster spans by x-gap before joining lines, or text interleaves columns.
- Never send the whole raw text to the user when asked for a summary; extract, then summarize
  with page references (`page 3` etc. derived from `page.number`).
