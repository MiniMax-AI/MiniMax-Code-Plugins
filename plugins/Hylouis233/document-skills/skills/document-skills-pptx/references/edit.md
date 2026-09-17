# Edit an existing deck

## Locate by content, then edit narrowly

The self-contained route below uses the same bounded `validate_pptx_package()` and
`open_validated_presentation()` preflight as `analyze.md`. Keep both copies in sync. The loader
validates and parses one open file identity; do not replace it with `Presentation(path)`, which
decompresses the package before the bounds run.

```python
import zipfile
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
SAFE_XML = etree.XMLParser(
    load_dtd=False, resolve_entities=False, no_network=True,
    huge_tree=False, recover=False,
)
MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_MEMBERS = 10_000
MAX_XML_PART = 20 * 1024 * 1024
MAX_ENTRY = 100 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED = 500 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200

def require(condition, message):
    """Security and edit gates must remain active under python -O."""
    if not condition:
        raise ValueError(message)

def validate_pptx_package(source):
    """Apply the same bounded OPC preflight used by the analysis route."""
    source.seek(0, 2)
    compressed_size = source.tell()
    source.seek(0)
    require(compressed_size <= MAX_ARCHIVE_BYTES, "compressed PPTX file size above limit")
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        require(len(infos) <= MAX_MEMBERS, "archive member count above limit")
        names = {info.filename for info in infos}
        require(len(names) == len(infos), "duplicate archive member names are unsafe")
        require("[Content_Types].xml" in names and "ppt/presentation.xml" in names,
                "missing required OPC members")
        require(sum(info.file_size for info in infos) <= MAX_TOTAL_UNCOMPRESSED,
                "declared total uncompressed size above limit")

        content_types_info = next(
            info for info in infos if info.filename == "[Content_Types].xml"
        )
        require(content_types_info.file_size <= MAX_XML_PART,
                "oversized XML part: [Content_Types].xml")
        require(
            content_types_info.file_size / max(content_types_info.compress_size, 1)
            <= MAX_COMPRESSION_RATIO,
            "suspicious compression ratio: [Content_Types].xml",
        )
        content_type_chunks = []
        content_type_size = 0
        with archive.open(content_types_info) as stream:
            while chunk := stream.read(64 * 1024):
                content_type_size += len(chunk)
                require(content_type_size <= MAX_XML_PART,
                        "part exceeded read limit: [Content_Types].xml")
                content_type_chunks.append(chunk)
        require(content_type_size == content_types_info.file_size,
                "size mismatch: [Content_Types].xml")
        content_types_blob = b"".join(content_type_chunks)
        content_types_root = etree.fromstring(content_types_blob, parser=SAFE_XML)
        require(content_types_root.tag == f"{{{CONTENT_TYPES_NS}}}Types",
                "invalid content-types root")
        default_types = {}
        override_types = {}
        for declaration in content_types_root:
            if declaration.tag == f"{{{CONTENT_TYPES_NS}}}Default":
                key = (declaration.get("Extension") or "").casefold()
                target = default_types
            elif declaration.tag == f"{{{CONTENT_TYPES_NS}}}Override":
                part_name = declaration.get("PartName") or ""
                require(part_name.startswith("/"), "invalid content-type part name")
                key = part_name[1:].casefold()
                target = override_types
            else:
                continue
            content_type = declaration.get("ContentType") or ""
            require(key and content_type and key not in target,
                    "invalid or duplicate content-type declaration")
            target[key] = content_type.partition(";")[0].strip().casefold()

        actual_total = 0
        for info in infos:
            require(info.file_size <= MAX_ENTRY, f"oversized part: {info.filename}")
            ratio = info.file_size / max(info.compress_size, 1)
            require(ratio <= MAX_COMPRESSION_RATIO,
                    f"suspicious compression ratio: {info.filename}")
            extension = info.filename.rpartition(".")[2].casefold()
            content_type = override_types.get(
                info.filename.casefold(), default_types.get(extension, "")
            )
            is_xml = (
                info.filename.casefold().endswith((".xml", ".rels"))
                or content_type in {"application/xml", "text/xml"}
                or content_type.endswith("+xml")
            )
            if is_xml:
                require(info.file_size <= MAX_XML_PART, f"oversized XML part: {info.filename}")
            chunks = []
            actual_size = 0
            if info.filename == "[Content_Types].xml":
                chunks = [content_types_blob]
                actual_size = len(content_types_blob)
                actual_total += actual_size
            else:
                with archive.open(info) as stream:
                    while chunk := stream.read(64 * 1024):
                        actual_size += len(chunk)
                        actual_total += len(chunk)
                        require(actual_size <= MAX_ENTRY,
                                f"part exceeded read limit: {info.filename}")
                        require(actual_total <= MAX_TOTAL_UNCOMPRESSED,
                                "archive exceeded total read limit")
                        if is_xml:
                            chunks.append(chunk)
            require(actual_total <= MAX_TOTAL_UNCOMPRESSED,
                    "archive exceeded total read limit")
            require(actual_size == info.file_size, f"size mismatch: {info.filename}")
            if is_xml:
                etree.fromstring(b"".join(chunks), parser=SAFE_XML)
    source.seek(0)

def open_validated_presentation(path):
    """Preflight and parse one immutable open-file identity, then release the handle."""
    with Path(path).open("rb") as source:
        validate_pptx_package(source)
        source.seek(0)
        return Presentation(source)

prs = open_validated_presentation("input.pptx")

old, new = "old wording", "new wording"
slide_index = None                 # Set this and shape_name when repeated text is expected.
shape_name = None
target_location = None             # e.g. "Table 1/table[0,1]" for duplicate table text

def iter_shapes(shapes, path=""):
    """Yield (path, shape) for every shape, recursing into groups so text inside
    grouped artwork is reachable; the path keeps the uniqueness check readable."""
    for shape in shapes:
        here = f"{path}/{shape.name}" if path else shape.name
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_shapes(shape.shapes, here)
        else:
            yield here, shape

def iter_text_targets(path, shape):
    if shape.has_text_frame:
        yield path, shape.text_frame
    if shape.has_table:
        for row_index, row in enumerate(shape.table.rows):
            for column_index, cell in enumerate(row.cells):
                if cell.is_spanned:  # covered merge slots can retain stale, non-rendered text
                    continue
                yield f"{path}/table[{row_index},{column_index}]", cell.text_frame

candidates = []
for i, slide in enumerate(prs.slides):
    if slide_index is not None and i != slide_index:
        continue
    for path, shape in iter_shapes(slide.shapes):
        if shape_name is not None and shape.name != shape_name:
            continue
        for location, text_frame in iter_text_targets(path, shape):
            if target_location is not None and location != target_location:
                continue
            if old in text_frame.text:
                candidates.append((i, location, text_frame))

locations = [(i, location) for i, location, _ in candidates]
require(len(candidates) == 1, f"expected one matching text target, found {locations}")
_, _, tf = candidates[0]

# Replace inside one existing run so its formatting and hyperlink are retained.
require(tf.text.count(old) == 1, "target occurs more than once in the selected shape")
run_hits = [
    run
    for paragraph in tf.paragraphs
    for run in paragraph.runs
    if old in run.text
]
require(len(run_hits) == 1 and run_hits[0].text.count(old) == 1, (
    "target is duplicated or split across runs; report it instead of flattening the paragraph"
))
run_hits[0].text = run_hits[0].text.replace(old, new, 1)

prs.save("input-edited.pptx")
```

## Rules

1. **Never rebuild the file to make a small change.** Rewriting slides from scratch loses the
   template, masters, notes, and animations. Edit in place, save to a new path.
2. Address shapes by slide index + shape name or matched text, and **require exactly one match**
   with an explicit exception (never a Python `assert`, which `python -O` removes).
   The locator must search both shape text frames and every editable table cell, skipping grid
   slots covered by a merge and retaining a stable `/table[row,column]` suffix. If copy repeats
   inside one table, set `target_location` as well as the slide/shape selectors rather than
   choosing one.
3. For formatted text, change `run.text` only when the target is wholly inside one run. Assigning
   `paragraph.text` or `text_frame.text` rebuilds runs and can discard run formatting and links.
   If the target spans runs, stop and make an explicitly reviewed run/XML edit.
4. Table cells are edited at run level exactly like shape text: iterate
   `table.cell(r, c).text_frame.paragraphs` and change `run.text`. Assigning `cell.text`
   (or `.text` on the text frame) rebuilds the frame and discards per-run formatting and
   hyperlinks:

   ```python
   cell = table.cell(2, 1)
   hits = [run for p in cell.text_frame.paragraphs for run in p.runs if old in run.text]
   if len(hits) != 1 or hits[0].text.count(old) != 1:
       raise ValueError("target is duplicated or split across runs in this cell")
   hits[0].text = hits[0].text.replace(old, new, 1)
   ```
5. Chart data: `chart.replace_data(CategoryChartData(...))` updates the embedded workbook and
   the plot together - do not hand-edit the XML series.
6. Reordering slides means moving the underlying `sldIdLst` entries; do it only on request and
   verify order in the postcheck.
7. Group shapes: iterate `shape.shapes` recursively to reach members; python-pptx will not
   ungroup for you - do not try to flatten groups.
