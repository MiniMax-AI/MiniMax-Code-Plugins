# Analyze / triage a deck

## Content inventory

```python
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.oxml.ns import qn
from lxml import etree

DIAGRAM_NS = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
SAFE_XML = etree.XMLParser(load_dtd=False, resolve_entities=False, no_network=True)

def iter_shapes(shapes):
    """Walk shapes recursively so content nested inside group shapes is counted too."""
    for shape in shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_shapes(shape.shapes)
        else:
            yield shape

def table_cells(table):
    """Inventory the grid without repeating a merged cell's text in covered slots."""
    return [[
        {
            "row": row_index,
            "column": column_index,
            "text": None if cell.is_spanned else cell.text,
            "is_merge_origin": cell.is_merge_origin,
            "is_spanned": cell.is_spanned,
            "span_width": cell.span_width,
            "span_height": cell.span_height,
        }
        for column_index, cell in enumerate(row.cells)
    ] for row_index, row in enumerate(table.rows)]

def picture_content(shape):
    """Inventory ordinary pictures and populated picture placeholders alike."""
    try:
        image = shape.image
    except (AttributeError, ValueError):
        return None
    return {
        "name": shape.name,
        "filename": image.filename,
        "extension": image.ext,
        "bytes": len(image.blob),
    }

def cached_numeric_points(source):
    """Return indexed cached points, or None when the cache metadata is unavailable."""
    if source is None:
        return None
    point_counts = source.xpath("./c:numRef/c:numCache/c:ptCount | ./c:numLit/c:ptCount")
    if not point_counts:
        return None
    points = source.xpath("./c:numRef/c:numCache/c:pt | ./c:numLit/c:pt")
    return [
        (int(point.get("idx")), float(value.text))
        for point in points
        if point.get("idx") is not None and (value := point.find(qn("c:v"))) is not None
    ]

def cached_category_labels(plot):
    """Return flattened labels, or None when a formula has no category cache."""
    category_nodes = plot._element.xpath("./c:ser[1]/c:cat")
    if not category_nodes:
        return []
    cache_payload = category_nodes[0].xpath(
        "./c:strRef/c:strCache/c:ptCount | ./c:numRef/c:numCache/c:ptCount | "
        "./c:multiLvlStrRef/c:multiLvlStrCache/c:ptCount | "
        "./c:strLit/c:ptCount | ./c:numLit/c:ptCount"
    )
    if not cache_payload:
        return None
    return [[str(level) for level in label] for label in plot.categories.flattened_labels]

def series_name_content(series):
    """Return a cached/literal title, or mark a worksheet-backed title unavailable."""
    titles = series._element.xpath("./c:tx")
    if not titles:
        return {"name": ""}
    literal = titles[0].find(qn("c:v"))
    if literal is not None:
        return {"name": literal.text or ""}
    reference = titles[0].find(qn("c:strRef"))
    if reference is None:
        return {"name": None, "name_cache_status": "unavailable"}
    cache = reference.find(qn("c:strCache"))
    if cache is None:
        return {"name": None, "name_cache_status": "unavailable"}
    point_count = cache.find(qn("c:ptCount"))
    points = cache.findall(qn("c:pt"))
    if (point_count is None or point_count.get("val") != "1"
            or len(points) != 1 or points[0].get("idx") != "0"):
        return {"name": None, "name_cache_status": "unavailable"}
    value = points[0].find(qn("c:v"))
    if value is None:
        return {"name": None, "name_cache_status": "unavailable"}
    return {"name": value.text or ""}

def series_content(series):
    name_content = series_name_content(series)
    x_source = getattr(series._element, "xVal", None)
    if x_source is None:                    # category/value chart
        value_source = getattr(series._element, "val", None)
        if cached_numeric_points(value_source) is None:
            return {**name_content, "values": None, "cache_status": "unavailable"}
        return {**name_content, "values": list(series.values)}
    x_points = cached_numeric_points(x_source)
    y_points = cached_numeric_points(getattr(series._element, "yVal", None))
    if x_points is None or y_points is None:
        return {**name_content, "points": None, "cache_status": "unavailable"}
    content = {**name_content, "x_points": x_points, "y_points": y_points}
    size_source = getattr(series._element, "bubbleSize", None)
    if size_source is not None:
        bubble_points = cached_numeric_points(size_source)
        if bubble_points is None:
            return {**name_content, "points": None, "cache_status": "unavailable"}
        content["bubble_points"] = bubble_points
    return content

def chart_axis_titles(chart):
    """Return titles for axes the chart actually exposes (pie charts have none)."""
    titles = {}
    for label, attribute in (("category", "category_axis"), ("value", "value_axis")):
        try:
            axis = getattr(chart, attribute)
        except (AttributeError, ValueError):
            continue
        titles[label] = axis.axis_title.text_frame.text if axis.has_title else ""
    return titles

def smartart_content(shape):
    """Extract SmartArt data-part labels, or report why the diagram is unreadable."""
    graphic_data = shape._element.find(".//" + qn("a:graphicData"))
    if graphic_data is None or graphic_data.get("uri") != DIAGRAM_NS:
        return None
    rel_ids = graphic_data.find(f".//{{{DIAGRAM_NS}}}relIds")
    relationship_id = None if rel_ids is None else rel_ids.get(qn("r:dm"))
    if not relationship_id:
        return {"name": shape.name, "status": "unreadable", "reason": "missing data relationship"}
    try:
        data_part = shape.part.related_part(relationship_id)
    except (KeyError, ValueError):
        return {"name": shape.name, "status": "unreadable", "reason": relationship_id}
    try:
        root = etree.fromstring(data_part.blob, parser=SAFE_XML)
    except etree.XMLSyntaxError as error:
        return {"name": shape.name, "status": "unreadable", "reason": str(error)}
    labels = [node.text for node in root.iter(qn("a:t")) if node.text]
    return {"name": shape.name, "status": "ok", "text": labels}

prs = Presentation("input.pptx")
print("slide size:", prs.slide_width, prs.slide_height)
for i, slide in enumerate(prs.slides):
    layout = slide.slide_layout.name
    title = slide.shapes.title.text_frame.text if slide.shapes.title is not None else ""
    notes = slide.notes_slide.notes_text_frame.text if slide.has_notes_slide else ""
    shapes = list(iter_shapes(slide.shapes))   # flattened; groups are common in template decks
    text = [sh.text_frame.text for sh in shapes if sh.has_text_frame and sh.text_frame.text]
    tables = [
        table_cells(sh.table)
        for sh in shapes if sh.has_table
    ]
    charts = []
    for sh in shapes:
        if not sh.has_chart:
            continue
        chart = sh.chart
        chart_title = (
            chart.chart_title.text_frame.text
            if chart.has_title else ""
        )
        plots = []
        for plot in chart.plots:
            items = list(plot.series)
            has_xy_values = any(getattr(item._element, "xVal", None) is not None for item in items)
            categories = [] if has_xy_values else cached_category_labels(plot)
            series = [series_content(item) for item in items]
            plots.append({
                "kind": type(plot).__name__,
                "categories": categories,
                "category_cache_status": (
                    "not-applicable" if has_xy_values else
                    "unavailable" if categories is None else "available"
                ),
                "series": series,
            })
        charts.append({
            "title": chart_title,
            "axis_titles": chart_axis_titles(chart),
            "plots": plots,
        })
    pictures = [
        content for sh in shapes
        if (content := picture_content(sh)) is not None
    ]
    smartart = [
        content for sh in shapes
        if (content := smartart_content(sh)) is not None
    ]

    # These full values - not only counts or lengths - are the evidence for summaries and
    # repurposing. Keep notes verbatim so markdown output can preserve them as blockquotes.
    print(f"slide {i + 1}: layout={layout!r} title={title!r}")
    print("  text:", text)
    print("  tables:", tables)
    print("  charts:", charts)
    print("  pictures:", pictures)
    print("  smartart:", smartart)
    print("  notes:", notes)
```

(Simplify the title lookup to `slide.shapes.title` when present; the defensive loop is for
layouts where the title placeholder is missing.)

## Triage: deck renders wrong

| Symptom | Check | Fix |
|---|---|---|
| Shape crosses the slide edge | compare all four shape bounds with the slide bounds | move or resize the shape |
| Text is clipped or overflows its box | render every slide and inspect right/left and bottom/vertical fit; shape bounds do not measure laid-out text | reflow, resize the box, or reduce text/font size, then render again |
| Everything shifted | slide size changed between sources | normalize slide size or re-layout on the target size |
| Fonts look wrong elsewhere | non-embedded fonts (pptx rarely embeds) | report every effective font via the resolution chain below, not just explicit `run.font.name` values |
| File will not open | broken ZIP / part mismatch | run the bounded package check below before parsing parts |
| Pictures blank | media parts missing or rels broken | verify `ppt/media/*` present and slide rels reference them |

## Bounded package health check

Inspect declared sizes and compression ratios before decompressing anything. `ZipFile.testzip()`
must not be the first check because it expands every member, including an archive bomb.

```python
import zipfile
from pathlib import Path
from lxml import etree

path = Path("input.pptx")
MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_MEMBERS = 10_000
MAX_XML_PART = 20 * 1024 * 1024
MAX_ENTRY = 100 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED = 500 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200

# Security limits must survive `python -O` (which strips assert statements),
# so every check raises explicitly instead of asserting.
def require(condition, message):
    if not condition:
        raise ValueError(message)

safe_xml_parser = etree.XMLParser(
    load_dtd=False,
    resolve_entities=False,
    no_network=True,
    huge_tree=False,
    recover=False,
)

# Bound the package itself before ZipFile materializes its central directory.
require(path.stat().st_size <= MAX_ARCHIVE_BYTES,
        "compressed PPTX file size above limit")
with zipfile.ZipFile(path) as archive:
    infos = archive.infolist()
    # Check the count before building sets, summing sizes, or opening any member.
    require(len(infos) <= MAX_MEMBERS, "archive member count above limit")
    names = {info.filename for info in infos}
    require(len(names) == len(infos), "duplicate archive member names are unsafe")
    require("[Content_Types].xml" in names and "ppt/presentation.xml" in names,
            "missing required OPC members")
    require(sum(info.file_size for info in infos) <= MAX_TOTAL_UNCOMPRESSED,
            "declared total uncompressed size above limit")

    actual_total = 0
    for info in infos:
        require(info.file_size <= MAX_ENTRY, f"oversized part: {info.filename}")
        ratio = info.file_size / max(info.compress_size, 1)
        require(ratio <= MAX_COMPRESSION_RATIO, f"suspicious compression ratio: {info.filename}")
        is_xml = info.filename.endswith((".xml", ".rels"))
        if is_xml:
            require(info.file_size <= MAX_XML_PART, f"oversized XML part: {info.filename}")

        chunks = []
        actual_size = 0
        # Streaming to EOF verifies decompression and CRC only after metadata limits pass.
        with archive.open(info) as stream:
            while chunk := stream.read(64 * 1024):
                actual_size += len(chunk)
                actual_total += len(chunk)
                require(actual_size <= MAX_ENTRY, f"part exceeded read limit: {info.filename}")
                require(actual_total <= MAX_TOTAL_UNCOMPRESSED, "archive exceeded total read limit")
                if is_xml:
                    chunks.append(chunk)
        require(actual_size == info.file_size, f"size mismatch: {info.filename}")
        if is_xml:
            etree.fromstring(b"".join(chunks), parser=safe_xml_parser)
```

These are conservative triage defaults, not PPTX format limits. Raise a limit only for an
explicitly trusted large deck, and retain the per-member and streaming checks.

## Font triage with inheritance

Most template decks set no explicit `run.font.name`; the effective face is inherited from the
placeholder, layout, master, or theme. Resolve what you can and name the fallback explicitly:

```python
import xml.etree.ElementTree as ET
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn

def iter_shapes(shapes):
    """Self-contained recursive walker for this independently runnable block."""
    for shape in shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_shapes(shape.shapes)
        else:
            yield shape

prs = Presentation("deck.pptx")

# 1. Resolve the theme related to each slide's own layout/master. A package can contain
# multiple masters with different themes, so the first /ppt/theme/* part is not a safe default.
theme_cache = {}
DRAWINGML = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
DIAGRAM_NS = "http://schemas.openxmlformats.org/drawingml/2006/diagram"

def read_theme_role(root, role):
    node = root.find(f".//a:{role}Font", DRAWINGML)
    if node is None:
        return {"latin": "", "eastAsia": "", "complexScript": "", "scripts": {}}
    def typeface(tag):
        child = node.find(f"a:{tag}", DRAWINGML)
        return "" if child is None else child.get("typeface", "")
    return {
        "latin": typeface("latin"),
        "eastAsia": typeface("ea"),
        "complexScript": typeface("cs"),
        "scripts": {
            child.get("script"): child.get("typeface", "")
            for child in node.findall("a:font", DRAWINGML) if child.get("script")
        },
    }

def theme_faces_for_slide(slide):
    master_part = slide.slide_layout.slide_master.part
    cache_key = str(master_part.partname)
    if cache_key not in theme_cache:
        theme_part = master_part.part_related_by(RT.THEME)
        root = ET.fromstring(theme_part.blob)
        theme_cache[cache_key] = {
            "major": read_theme_role(root, "major"),
            "minor": read_theme_role(root, "minor"),
        }
    return cache_key, theme_cache[cache_key]

EAST_ASIAN_SCRIPTS = {"Hans", "Hant", "Jpan", "Hang"}
COMPLEX_SCRIPTS = {"Arab", "Hebr", "Deva", "Beng", "Taml", "Thai"}

def character_tags(character):
    codepoint = ord(character)
    if 0x3040 <= codepoint <= 0x30FF:
        return ["Jpan"]
    if 0x1100 <= codepoint <= 0x11FF or 0xAC00 <= codepoint <= 0xD7AF:
        return ["Hang"]
    if 0x2F00 <= codepoint <= 0x9FFF:
        return ["Hans", "Hant", "Jpan", "Hang"]  # locale disambiguates Han
    for tag, start, end in (
        ("Cyrl", 0x0400, 0x052F), ("Hebr", 0x0590, 0x05FF),
        ("Arab", 0x0600, 0x06FF), ("Deva", 0x0900, 0x097F),
        ("Beng", 0x0980, 0x09FF), ("Taml", 0x0B80, 0x0BFF),
        ("Thai", 0x0E00, 0x0E7F),
    ):
        if start <= codepoint <= end:
            return [tag]
    return []

def script_tags(text):
    tags = []
    for character in text:
        tags.extend(character_tags(character))
    return list(dict.fromkeys(tags))

def required_slots(text):
    slots = []
    for character in text:
        tags = set(character_tags(character))
        slot = "eastAsia" if tags & EAST_ASIAN_SCRIPTS else (
            "complexScript" if tags & COMPLEX_SCRIPTS else "latin"
        )
        if slot not in slots:
            slots.append(slot)
    return slots or ["latin"]

def raw_font_slots(rpr):
    slots = {}
    if rpr is None:
        return slots
    for slot, tag in (("latin", "a:latin"), ("eastAsia", "a:ea"),
                      ("complexScript", "a:cs")):
        child = rpr.find(qn(tag))
        if child is not None and child.get("typeface"):
            slots[slot] = child.get("typeface")
    return slots

THEME_TOKENS = {
    "+mj-lt": ("major", "latin"), "+mj-ea": ("major", "eastAsia"),
    "+mj-cs": ("major", "complexScript"), "+mn-lt": ("minor", "latin"),
    "+mn-ea": ("minor", "eastAsia"), "+mn-cs": ("minor", "complexScript"),
}

def expand_theme_token(face, theme_fonts):
    role_slot = THEME_TOKENS.get(face)
    return theme_fonts[role_slot[0]][role_slot[1]] if role_slot else face

def font_candidates(run, paragraph, theme_fonts, role):
    run_slots = raw_font_slots(run._r.rPr)
    ppr = paragraph._p.pPr
    paragraph_slots = raw_font_slots(None if ppr is None else ppr.defRPr)
    tags = script_tags(run.text)
    candidates = []
    for slot in required_slots(run.text):
        fallback_role = role
        explicit_source = None
        face = run_slots.get(slot)
        if face:
            explicit_source = "run"
        else:
            face = paragraph_slots.get(slot)
            if face:
                explicit_source = "paragraph defaults"
        if face:
            resolved = expand_theme_token(face, theme_fonts)
            if resolved:
                candidates.append((slot, resolved, explicit_source))
                continue
            # A generic +mj/+mn slot can be empty while the same role has a matching
            # script-specific theme face. Preserve the token's role for that fallback.
            if face in THEME_TOKENS:
                fallback_role = THEME_TOKENS[face][0]
            else:
                continue
        role_fonts = theme_fonts[fallback_role]
        slot_tags = [
            tag for tag in tags
            if (slot == "eastAsia" and tag in EAST_ASIAN_SCRIPTS)
            or (slot == "complexScript" and tag in COMPLEX_SCRIPTS)
            or (slot == "latin" and tag not in EAST_ASIAN_SCRIPTS | COMPLEX_SCRIPTS)
        ]
        candidates.extend(
            (slot, role_fonts["scripts"][tag], f"{fallback_role} theme script {tag}")
            for tag in slot_tags if role_fonts["scripts"].get(tag)
        )
        if role_fonts.get(slot):
            candidates.append((slot, role_fonts[slot], f"{fallback_role} theme {slot}"))
    return list(dict.fromkeys(candidates))

def iter_text_frames(shapes):
    """Shape text frames plus every table cell's text frame (a graphic frame
    has has_text_frame=False, so tables must be walked explicitly)."""
    for shape in shapes:
        if shape.has_text_frame:
            yield shape.text_frame
        if getattr(shape, "has_table", False):
            for row in shape.table.rows:
                for cell in row.cells:
                    yield cell.text_frame

def unresolved_graphic_font_regions(shapes):
    """Mark text systems whose full font cascade python-pptx does not expose."""
    for shape in shapes:
        if getattr(shape, "has_chart", False):
            yield {"shape": shape.name, "kind": "chart"}
        graphic_data = shape._element.find(".//" + qn("a:graphicData"))
        if graphic_data is not None and graphic_data.get("uri") == DIAGRAM_NS:
            yield {"shape": shape.name, "kind": "SmartArt"}

unresolved_fonts = []
for i, slide in enumerate(prs.slides):
    master_name, theme_fonts = theme_faces_for_slide(slide)
    print(i, "master:", master_name, "theme:", ascii(theme_fonts))
    title_shape = slide.shapes.title
    shapes = list(iter_shapes(slide.shapes))
    for frame in iter_text_frames(shapes):
        holder = getattr(frame, "_parent", None)  # the shape for ordinary frames
        for paragraph in frame.paragraphs:
            for run in paragraph.runs:
                role = "major" if (
                    title_shape is not None and
                    getattr(holder, "_element", None) is title_shape._element
                ) else "minor"
                faces = font_candidates(run, paragraph, theme_fonts, role)
                print(i, repr(run.text[:20]), "font candidates:", ascii(faces))
    unresolved_fonts.extend(
        {"slide": i + 1, **record} for record in unresolved_graphic_font_regions(shapes)
    )
if unresolved_fonts:
    raise LookupError(
        "font audit cannot verify chart/SmartArt text properties: "
        f"{unresolved_fonts}; inspect those package parts or render with production fonts"
    )
```

`run.font.name` exposes only the Latin slot, so it must not short-circuit inspection of explicit
`<a:ea>`/`<a:cs>` faces. python-pptx also does not evaluate the full placeholder -> layout ->
master inheritance chain; the output above remains a candidate list. Check matching layout/master
placeholders when the exact face matters. Han text needs the deck locale to distinguish Hans,
Hant, Japanese, and Korean mappings; add other script ranges when the task uses them rather than
claiming the Latin fallback is definitive.
Chart titles, legends, tick labels, data labels, and SmartArt nodes use additional DrawingML
font cascades across chart/diagram parts. The guard above deliberately fails closed until those
parts are audited directly or the deck is rendered and inspected with the production fonts.

## Text-fit verification

`python-pptx` exposes a text box's geometry, not the renderer's final glyph and line layout.
After any text or layout change, render all slides with the fonts used in production:

```bash
python -c "from pathlib import Path; Path('deck-render').mkdir(exist_ok=True)"
soffice --headless --convert-to pdf --outdir deck-render input.pptx
```

Inspect every page of `deck-render/input.pdf` for horizontal clipping and for the final line being
clipped or missing at the bottom. Rasterize the PDF when image inspection is easier. If this must
be an automated gate, use measured text bounds from a native renderer in both axes;
`shape.left + shape.width` is only a slide-boundary check, not an overflow test.

## Report contract

Summarize: slide count, per-slide one-line inventory, then findings ranked by user impact.
Extraction for repurposing goes to markdown with speaker notes preserved as blockquotes.
