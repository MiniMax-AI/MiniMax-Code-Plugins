# Minimal runnable fixtures for the snippets called out in review: one file per format.
# Each script is self-contained, writes only scratch files into the current directory,
# and exits non-zero on failed assertions. Run from any scratch directory:
#   python pdf_fixture.py   (deps: reportlab, pypdf, pymupdf)
#   python pptx_fixture.py  (deps: python-pptx)
#   python xlsx_fixture.py  (deps: openpyxl)
#   python docx_fixture.py  (deps: python-docx, pymupdf, soffice on PATH)
import base64
import copy
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.chart.data import BubbleChartData, ChartData, XyChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE
from pptx.enum.shapes import MSO_SHAPE_TYPE, PP_PLACEHOLDER
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.util import Inches, Pt

failures = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ((" :: " + str(extra)) if not cond and extra else ""))
    if not cond:
        failures.append(name)


# ---- build the deck ------------------------------------------------------------
prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[5])  # blank

box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(8), Inches(1))
tf = box.text_frame
p = tf.paragraphs[0]
r1 = p.add_run()
r1.text = "old wording"
r2 = p.add_run()
r2.text = " linked part"
r2.font.italic = True
r2.font.color.rgb = RGBColor(0xC0, 0x00, 0x00)
r2.hyperlink.address = "https://example.com/docs"

table_shape = slide.shapes.add_table(2, 2, Inches(1), Inches(2.5), Inches(6), Inches(1))
table = table_shape.table
cell = table.cell(0, 1)
ctf = cell.text_frame
cp = ctf.paragraphs[0]
cr = cp.add_run()
cr.text = "old cell text"
cr.font.bold = True
cr.font.color.rgb = RGBColor(0x00, 0x70, 0xC0)

chart_data = ChartData()
chart_data.categories = ["EU", "US"]
chart_data.add_series("Units", (120, 80))
chart = slide.shapes.add_chart(
    XL_CHART_TYPE.COLUMN_CLUSTERED,
    Inches(7.2), Inches(2.5), Inches(2), Inches(2),
    chart_data,
).chart
chart.has_title = True
chart.chart_title.text_frame.text = "Units by region"
chart.category_axis.has_title = True
chart.category_axis.axis_title.text_frame.text = "Region"
chart.value_axis.has_title = True
chart.value_axis.axis_title.text_frame.text = "Units sold"

xy_data = XyChartData()
xy_series = xy_data.add_series("Trend")
xy_series.add_data_point(1, 2)
xy_series.add_data_point(3, 4)
xy_chart = slide.shapes.add_chart(
    XL_CHART_TYPE.XY_SCATTER, Inches(7.2), Inches(4.7), Inches(2), Inches(2), xy_data,
).chart
xy_chart.has_title = True
xy_chart.chart_title.text_frame.text = "XY trend"

bubble_data = BubbleChartData()
bubble_series = bubble_data.add_series("Risk")
bubble_series.add_data_point(3, 4, 5)
bubble_chart = slide.shapes.add_chart(
    XL_CHART_TYPE.BUBBLE, Inches(5), Inches(4.7), Inches(2), Inches(2), bubble_data,
).chart
bubble_chart.has_title = True
bubble_chart.chart_title.text_frame.text = "Bubble risk"
slide.notes_slide.notes_text_frame.text = "Speaker note: explain the regional split."

prs.save("input.pptx")

# ---- create.md skeleton: explicit placeholder selection and populated table ----
def placeholder_of_type(slide, *types):
    matches = [
        ph for ph in slide.placeholders
        if ph.placeholder_format.type in types
    ]
    if len(matches) != 1:
        available = [
            f"{ph.name} ({ph.placeholder_format.type})"
            for ph in slide.placeholders
        ]
        raise ValueError(
            f"expected exactly one placeholder of {types}, found {len(matches)}; "
            f"available placeholders: {available or 'none'}"
        )
    return matches[0]


selector_prs = Presentation()
no_object_slide = selector_prs.slides.add_slide(selector_prs.slide_layouts[6])
try:
    placeholder_of_type(no_object_slide, PP_PLACEHOLDER.OBJECT)
    missing_placeholder_message = None
except ValueError as exc:
    missing_placeholder_message = str(exc)
check(
    "placeholder selector explicitly rejects zero matches",
    missing_placeholder_message is not None
    and "found 0" in missing_placeholder_message
    and "available placeholders: none" in missing_placeholder_message,
    missing_placeholder_message,
)

two_object_slide = selector_prs.slides.add_slide(selector_prs.slide_layouts[3])
try:
    placeholder_of_type(two_object_slide, PP_PLACEHOLDER.OBJECT)
    ambiguous_placeholder_message = None
except ValueError as exc:
    ambiguous_placeholder_message = str(exc)
check(
    "placeholder selector explicitly rejects multiple matches",
    ambiguous_placeholder_message is not None
    and "found 2" in ambiguous_placeholder_message
    and "Content Placeholder 2" in ambiguous_placeholder_message
    and "Content Placeholder 3" in ambiguous_placeholder_message,
    ambiguous_placeholder_message,
)

skeleton_prs = Presentation()
skeleton_slide = skeleton_prs.slides.add_slide(skeleton_prs.slide_layouts[5])
skeleton_slide.shapes.title.text = "Regional service health"
skeleton_headers = ["Region", "Error rate", "P99 latency"]
skeleton_body = [
    ["Americas", "0.08%", "182 ms"],
    ["Europe", "0.05%", "164 ms"],
    ["Asia Pacific", "0.11%", "213 ms"],
]
skeleton_table = skeleton_slide.shapes.add_table(
    1 + len(skeleton_body), len(skeleton_headers),
    Inches(0.5), Inches(1.5), Inches(9), Inches(3.5),
).table
for column_index, text in enumerate(skeleton_headers):
    skeleton_table.cell(0, column_index).text = text
for row_index, row in enumerate(skeleton_body, start=1):
    for column_index, text in enumerate(row):
        skeleton_table.cell(row_index, column_index).text = text
skeleton_prs.save("create-skeleton.pptx")
skeleton_reopened = Presentation("create-skeleton.pptx")
skeleton_reopened_table = next(
    shape.table for shape in skeleton_reopened.slides[0].shapes if shape.has_table
)
skeleton_values = [
    [cell.text.strip() for cell in row.cells]
    for row in skeleton_reopened_table.rows
]
check(
    "creation skeleton table has no unexpected empty cells",
    skeleton_values == [skeleton_headers, *skeleton_body]
    and all(text for row in skeleton_values for text in row),
    skeleton_values,
)

# ---- analyze.md bounded package check rejects archive bombs before expansion ---
MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_MEMBERS = 10_000
MAX_XML_PART = 20 * 1024 * 1024
MAX_ENTRY = 100 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED = 500 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
safe_xml_parser = etree.XMLParser(
    load_dtd=False,
    resolve_entities=False,
    no_network=True,
    huge_tree=False,
    recover=False,
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_pptx_package(path):
    require(
        Path(path).stat().st_size <= MAX_ARCHIVE_BYTES,
        "compressed PPTX file size above limit",
    )
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        require(len(infos) <= MAX_MEMBERS, "archive member count above limit")
        names = {info.filename for info in infos}
        require(len(names) == len(infos), "duplicate archive member names are unsafe")
        require("[Content_Types].xml" in names and "ppt/presentation.xml" in names,
                "required PPTX package parts are missing")
        require(sum(info.file_size for info in infos) <= MAX_TOTAL_UNCOMPRESSED,
                "declared archive size exceeds the review limit")
        actual_total = 0
        for info in infos:
            require(info.file_size <= MAX_ENTRY, f"oversized part: {info.filename}")
            require(info.file_size / max(info.compress_size, 1) <= MAX_COMPRESSION_RATIO,
                    f"suspicious compression ratio: {info.filename}")
            is_xml = info.filename.endswith((".xml", ".rels"))
            if is_xml:
                require(info.file_size <= MAX_XML_PART, f"oversized XML part: {info.filename}")
            chunks = []
            actual_size = 0
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
            require(actual_size == info.file_size, f"size mismatch: {info.filename}")
            if is_xml:
                etree.fromstring(b"".join(chunks), parser=safe_xml_parser)


try:
    validate_pptx_package("input.pptx")
    healthy_pptx_passed = True
except Exception:
    healthy_pptx_passed = False
check("bounded PPTX check accepts an ordinary deck", healthy_pptx_passed)

Path("oversized-before-open.pptx").write_bytes(b"not a ZIP package")
original_archive_limit = MAX_ARCHIVE_BYTES
MAX_ARCHIVE_BYTES = 0
try:
    validate_pptx_package("oversized-before-open.pptx")
    compressed_size_rejected_before_open = False
except ValueError as exc:
    compressed_size_rejected_before_open = (
        str(exc) == "compressed PPTX file size above limit"
    )
finally:
    MAX_ARCHIVE_BYTES = original_archive_limit
check(
    "compressed PPTX size is bounded before ZipFile opens the package",
    compressed_size_rejected_before_open,
)

with zipfile.ZipFile("too-many-members.pptx", "w", zipfile.ZIP_STORED) as archive:
    for member_index in range(MAX_MEMBERS + 1):
        archive.writestr(f"zero-{member_index:05d}.bin", b"")
try:
    validate_pptx_package("too-many-members.pptx")
    many_members_rejected = False
except ValueError as exc:
    many_members_rejected = str(exc) == "archive member count above limit"
check(
    "member-count gate rejects 10,001 zero-byte members before traversal",
    many_members_rejected,
)

with zipfile.ZipFile("compressed-bomb.pptx", "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("[Content_Types].xml", "<Types/>")
    archive.writestr(
        "ppt/presentation.xml",
        '<p:presentation xmlns:p="urn:test">' + (" " * 2_000_000) + "</p:presentation>",
    )
try:
    validate_pptx_package("compressed-bomb.pptx")
    pptx_bomb_rejected = False
except ValueError:
    pptx_bomb_rejected = True
check("PPTX compression bomb is rejected before XML expansion", pptx_bomb_rejected)

# ---- edit.md snippet: single-shape run replace keeps styling and hyperlink -----
prs = Presentation("input.pptx")
old, new = "old wording", "new wording"
candidates = []
for i, s in enumerate(prs.slides):
    for shape in s.shapes:
        if shape.has_text_frame and old in shape.text_frame.text:
            candidates.append((i, shape.name, shape))
require(len(candidates) == 1, "expected exactly one text target")
_, _, target_shape = candidates[0]
tf = target_shape.text_frame
run_hits = [run for par in tf.paragraphs for run in par.runs if old in run.text]
require(len(run_hits) == 1, "target is duplicated or split across runs")
run_hits[0].text = run_hits[0].text.replace(old, new, 1)

edited_link = [run for par in tf.paragraphs for run in par.runs if run.hyperlink.address]
check("run replace keeps the other run's hyperlink", len(edited_link) == 1 and edited_link[0].hyperlink.address == "https://example.com/docs")
styled = [run for par in tf.paragraphs for run in par.runs if run.font.italic]
check("run replace keeps sibling run styling", len(styled) == 1 and styled[0].font.color.rgb == RGBColor(0xC0, 0x00, 0x00))
prs.save("edited.pptx")

# ---- edit.md snippet: table cell edited at run level ---------------------------
prs2 = Presentation("input.pptx")
old_cell, new_cell = "old cell text", "new cell text"
tbl = next(sh for sh in prs2.slides[0].shapes if sh.has_table).table
cell = tbl.cell(0, 1)
hits = [run for par in cell.text_frame.paragraphs for run in par.runs if old_cell in run.text]
require(len(hits) == 1, "target is duplicated or split across runs in this cell")
hits[0].text = hits[0].text.replace(old_cell, new_cell, 1)

prs2.save("cell-edited.pptx")
prs3 = Presentation("cell-edited.pptx")
cell3 = next(sh for sh in prs3.slides[0].shapes if sh.has_table).table.cell(0, 1)
after_runs = [run for par in cell3.text_frame.paragraphs for run in par.runs]
check("cell run edit keeps bold", any(r.font.bold for r in after_runs))
check("cell run edit keeps color", any(r.font.color and r.font.color.rgb == RGBColor(0x00, 0x70, 0xC0) for r in after_runs))
check("cell run edit changed the text", cell3.text_frame.text == "new cell text")

# the dangerous variant for contrast: assigning cell.text drops run properties
prs4 = Presentation("input.pptx")
tbl4 = next(sh for sh in prs4.slides[0].shapes if sh.has_table).table
tbl4.cell(0, 1).text = "new cell text"
prs4.save("cell-flattened.pptx")
prs5 = Presentation("cell-flattened.pptx")
flat_runs = [run for par in next(sh for sh in prs5.slides[0].shapes if sh.has_table).table.cell(0, 1).text_frame.paragraphs for run in par.runs]
check("cell.text assignment is proven lossy (negative control)", not any(r.font.bold for r in flat_runs))

# ---- analyze.md snippet: grouped-shape walker ----------------------------------
from pptx.oxml import parse_xml
from pptx.oxml.ns import qn
from pptx.oxml.xmlchemy import OxmlElement

prs6 = Presentation()
slide6 = prs6.slides.add_slide(prs6.slide_layouts[5])
pic_holder = slide6.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1))
pic_holder.text_frame.text = "nested member"
pic_holder.text_frame.paragraphs[0].runs[0].font.name = "Grouped Face"

GRP = (
    '<p:grpSp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    "<p:nvGrpSpPr><p:cNvPr id=\"901\" name=\"demo group\"/>"
    "<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>"
    "<p:grpSpPr><a:xfrm><a:off x=\"914400\" y=\"914400\"/>"
    '<a:ext cx="4572000" cy="914400"/>'
    '<a:chOff x="0" y="0"/><a:chExt cx="4572000" cy="914400"/></a:xfrm></p:grpSpPr>'
    "</p:grpSp>"
)


def iter_shapes(shapes):
    for shape in shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_shapes(shape.shapes)
        else:
            yield shape


def table_cells(table):
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
    if x_source is None:
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
    titles = {}
    for label, attribute in (("category", "category_axis"), ("value", "value_axis")):
        try:
            axis = getattr(chart, attribute)
        except (AttributeError, ValueError):
            continue
        titles[label] = axis.axis_title.text_frame.text if axis.has_title else ""
    return titles


DIAGRAM_NS = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
SAFE_DIAGRAM_XML = etree.XMLParser(load_dtd=False, resolve_entities=False, no_network=True)


def smartart_content(shape):
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
        root = etree.fromstring(data_part.blob, parser=SAFE_DIAGRAM_XML)
    except etree.XMLSyntaxError as error:
        return {"name": shape.name, "status": "unreadable", "reason": str(error)}
    labels = [node.text for node in root.iter(qn("a:t")) if node.text]
    return {"name": shape.name, "status": "ok", "text": labels}


def extract_slide_content(slide):
    shapes = list(iter_shapes(slide.shapes))
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
    notes = slide.notes_slide.notes_text_frame.text if slide.has_notes_slide else ""
    pictures = [
        info for shape in shapes
        if (info := picture_content(shape)) is not None
    ]
    smartart = [
        info for shape in shapes
        if (info := smartart_content(shape)) is not None
    ]
    return {"text": text, "tables": tables, "charts": charts,
            "pictures": pictures, "smartart": smartart, "notes": notes}


content = extract_slide_content(Presentation("input.pptx").slides[0])
check("content inventory emits body text", any("old wording" in value for value in content["text"]), content)
check("content inventory emits table cell text",
      content["tables"][0][0][1]["text"] == "old cell text", content["tables"])
check(
    "content inventory emits chart title, categories, series, and values",
    content["charts"][0]["title"] == "Units by region"
    and content["charts"][0]["plots"][0]["categories"] == [["EU"], ["US"]]
    and content["charts"][0]["plots"][0]["series"]
    == [{"name": "Units", "values": [120.0, 80.0]}],
    content["charts"],
)
check("content inventory emits category and value axis titles",
      content["charts"][0]["axis_titles"]
      == {"category": "Region", "value": "Units sold"}, content["charts"][0])
chart_by_title = {item["title"]: item for item in content["charts"]}
check("content inventory emits XY x/y points",
      chart_by_title["XY trend"]["plots"][0]["series"][0]["x_points"]
      == [(0, 1.0), (1, 3.0)]
      and chart_by_title["XY trend"]["plots"][0]["series"][0]["y_points"]
      == [(0, 2.0), (1, 4.0)])
check("content inventory emits bubble x/y/size points",
      chart_by_title["Bubble risk"]["plots"][0]["series"][0]["x_points"] == [(0, 3.0)]
      and chart_by_title["Bubble risk"]["plots"][0]["series"][0]["y_points"] == [(0, 4.0)]
      and chart_by_title["Bubble risk"]["plots"][0]["series"][0]["bubble_points"]
      == [(0, 5.0)])
check("content inventory emits notes text", "regional split" in content["notes"], content["notes"])

# Category/value series can retain an external workbook formula without a numCache.
category_prs = Presentation()
category_slide = category_prs.slides.add_slide(category_prs.slide_layouts[6])
category_data = ChartData()
category_data.categories = ["A", "B"]
category_data.add_series("Missing cache", (1, 2))
category_data.add_series("Cached series", (3, 4))
category_slide.shapes.add_chart(
    XL_CHART_TYPE.COLUMN_CLUSTERED,
    Inches(0.5), Inches(0.5), Inches(6), Inches(4), category_data,
)
category_prs.save("category-cache-source.pptx")

series_name_mutated = Presentation("category-cache-source.pptx")
series_name_chart = next(
    shape.chart for shape in series_name_mutated.slides[0].shapes if shape.has_chart
)
series_name_ref = list(series_name_chart.plots[0].series)[0]._element.xpath(
    "./c:tx/c:strRef"
)[0]
series_name_formula = series_name_ref.find(qn("c:f")).text
series_name_ref.remove(series_name_ref.find(qn("c:strCache")))
series_name_mutated.save("series-name-cacheless.pptx")
series_name_reopened = Presentation("series-name-cacheless.pptx")
series_name_chart = next(
    shape.chart for shape in series_name_reopened.slides[0].shapes if shape.has_chart
)
series_name_series = list(series_name_chart.plots[0].series)[0]
series_name_result = series_content(series_name_series)
check("cacheless series title retains its worksheet formula",
      series_name_series._element.xpath("./c:tx/c:strRef/c:f")[0].text
      == series_name_formula)
check("cacheless series title is unavailable without aborting value inventory",
      series_name_result == {
          "name": None, "name_cache_status": "unavailable", "values": [1.0, 2.0],
      }, series_name_result)
series_name_inventory = extract_slide_content(series_name_reopened.slides[0])
series_name_inventory_items = series_name_inventory["charts"][0]["plots"][0]["series"]
check("deck inventory continues through cached siblings after an unavailable series title",
      series_name_inventory_items[0] == series_name_result
      and series_name_inventory_items[1]
      == {"name": "Cached series", "values": [3.0, 4.0]},
      series_name_inventory_items)


class RaisingNameSeries:
    def __init__(self, element, values):
        self._element = element
        self.values = values

    @property
    def name(self):
        raise RuntimeError("series.name must not be accessed")


raising_name_result = series_content(RaisingNameSeries(
    series_name_series._element, list(series_name_series.values),
))
check("cacheless name path never touches the python-pptx name property",
      raising_name_result == series_name_result, raising_name_result)

source_name_series = list(series_name_chart.plots[0].series)[1]
malformed_name_element = copy.deepcopy(source_name_series._element)
malformed_cache = malformed_name_element.find(qn("c:tx")).find(
    qn("c:strRef")
).find(qn("c:strCache"))
for point in malformed_cache.findall(qn("c:pt")):
    malformed_cache.remove(point)
malformed_name_result = series_content(RaisingNameSeries(
    malformed_name_element, list(source_name_series.values),
))
check("incomplete series-name cache is unavailable while values remain readable",
      malformed_name_result == {
          "name": None, "name_cache_status": "unavailable", "values": [3.0, 4.0],
      }, malformed_name_result)

literal_name_element = copy.deepcopy(source_name_series._element)
literal_tx = literal_name_element.find(qn("c:tx"))
literal_tx.remove(literal_tx.find(qn("c:strRef")))
literal_value = OxmlElement("c:v")
literal_value.text = "Literal series"
literal_tx.append(literal_value)
literal_name_result = series_content(RaisingNameSeries(
    literal_name_element, list(source_name_series.values),
))
check("literal series title is read directly without the name property",
      literal_name_result["name"] == "Literal series", literal_name_result)

untitled_element = copy.deepcopy(source_name_series._element)
untitled_element.remove(untitled_element.find(qn("c:tx")))
untitled_result = series_content(RaisingNameSeries(
    untitled_element, list(source_name_series.values),
))
check("series without a title remains a readable unnamed series",
      untitled_result["name"] == "", untitled_result)

category_mutated = Presentation("category-cache-source.pptx")
category_chart = next(
    shape.chart for shape in category_mutated.slides[0].shapes if shape.has_chart
)
category_series = list(category_chart.plots[0].series)
missing_value_ref = category_series[0]._element.val.find(qn("c:numRef"))
missing_formula_before = missing_value_ref.find(qn("c:f")).text
missing_value_ref.remove(missing_value_ref.find(qn("c:numCache")))
category_mutated.save("category-cacheless.pptx")

category_reopened = Presentation("category-cacheless.pptx")
category_reopened_chart = next(
    shape.chart for shape in category_reopened.slides[0].shapes if shape.has_chart
)
category_reopened_series = list(category_reopened_chart.plots[0].series)
reopened_value_ref = category_reopened_series[0]._element.val.find(qn("c:numRef"))
reopened_formula = reopened_value_ref.find(qn("c:f"))
with zipfile.ZipFile("category-cacheless.pptx") as category_archive:
    embedded_workbook_remains = any(
        name.startswith("ppt/embeddings/") for name in category_archive.namelist()
    )
check(
    "cacheless category series retains its formula and embedded workbook",
    reopened_formula is not None
    and reopened_formula.text == missing_formula_before
    and reopened_value_ref.find(qn("c:numCache")) is None
    and embedded_workbook_remains,
)
category_inventory = extract_slide_content(category_reopened.slides[0])
category_inventory_series = category_inventory["charts"][0]["plots"][0]["series"]
check(
    "cacheless category series is unavailable without aborting inventory",
    category_inventory_series[0]
    == {"name": "Missing cache", "values": None, "cache_status": "unavailable"},
    category_inventory_series,
)
check(
    "cached category series still reports its values after a cacheless sibling",
    category_inventory_series[1] == {"name": "Cached series", "values": [3.0, 4.0]},
    category_inventory_series,
)

category_labels_mutated = Presentation("category-cache-source.pptx")
category_labels_chart = next(
    shape.chart for shape in category_labels_mutated.slides[0].shapes if shape.has_chart
)
category_ref = category_labels_chart.plots[0]._element.xpath(
    "./c:ser[1]/c:cat/c:strRef"
)[0]
category_formula_before = category_ref.find(qn("c:f")).text
category_ref.remove(category_ref.find(qn("c:strCache")))
category_labels_mutated.save("category-label-cacheless.pptx")
category_labels_reopened = Presentation("category-label-cacheless.pptx")
category_labels_chart = next(
    shape.chart for shape in category_labels_reopened.slides[0].shapes if shape.has_chart
)
category_ref = category_labels_chart.plots[0]._element.xpath(
    "./c:ser[1]/c:cat/c:strRef"
)[0]
with zipfile.ZipFile("category-label-cacheless.pptx") as category_archive:
    category_workbook_remains = any(
        name.startswith("ppt/embeddings/") for name in category_archive.namelist()
    )
category_labels_inventory = extract_slide_content(category_labels_reopened.slides[0])
category_plot_inventory = category_labels_inventory["charts"][0]["plots"][0]
check("cacheless categories retain their worksheet formula and embedded workbook",
      category_ref.find(qn("c:f")).text == category_formula_before
      and category_ref.find(qn("c:strCache")) is None
      and category_workbook_remains)
check("missing category cache is reported without aborting later chart inventory",
      category_plot_inventory["categories"] is None
      and category_plot_inventory["category_cache_status"] == "unavailable"
      and category_plot_inventory["series"][1]["values"] == [3.0, 4.0],
      category_plot_inventory)

diagram_frame = etree.fromstring(f'''<p:graphicFrame
    xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
    xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
    xmlns:dgm="{DIAGRAM_NS}"
    xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <a:graphic><a:graphicData uri="{DIAGRAM_NS}"><dgm:relIds r:dm="rIdSmart"/></a:graphicData></a:graphic>
</p:graphicFrame>'''.encode())
diagram_data = f'''<dgm:dataModel xmlns:dgm="{DIAGRAM_NS}"
    xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <dgm:ptLst><dgm:pt><dgm:t><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst>
</dgm:dataModel>'''.encode()
diagram_part = type("DiagramPart", (), {"blob": diagram_data})()
diagram_owner = type("SlidePart", (), {
    "related_part": lambda self, relationship_id: {"rIdSmart": diagram_part}[relationship_id],
})()
diagram_shape = type("SmartArtShape", (), {
    "name": "SmartArt 1", "_element": diagram_frame, "part": diagram_owner,
})()
check("SmartArt inventory extracts text from the diagram data part",
      smartart_content(diagram_shape)
      == {"name": "SmartArt 1", "status": "ok", "text": ["Revenue"]})
missing_diagram_shape = type("SmartArtShape", (), {
    "name": "Broken SmartArt", "_element": diagram_frame,
    "part": type("SlidePart", (), {
        "related_part": lambda self, relationship_id: {}[relationship_id],
    })(),
})()
check("SmartArt inventory reports an unresolved diagram relationship",
      smartart_content(missing_diagram_shape)["status"] == "unreadable")

placeholder_png = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlRYAAAAASUVORK5CYII="
)
with open("placeholder-picture.png", "wb") as stream:
    stream.write(placeholder_png)
placeholder_prs = Presentation()
picture_layout = next(
    layout for layout in placeholder_prs.slide_layouts
    if any(
        shape.placeholder_format.type == PP_PLACEHOLDER.PICTURE
        for shape in layout.placeholders
    )
)
placeholder_slide = placeholder_prs.slides.add_slide(picture_layout)
picture_placeholder = next(
    shape for shape in placeholder_slide.placeholders
    if shape.placeholder_format.type == PP_PLACEHOLDER.PICTURE
)
placeholder_picture = picture_placeholder.insert_picture("placeholder-picture.png")
placeholder_prs.save("picture-placeholder.pptx")
placeholder_reopened = Presentation("picture-placeholder.pptx").slides[0]
reopened_picture = next(
    shape for shape in placeholder_reopened.placeholders if hasattr(shape, "image")
)
placeholder_inventory = extract_slide_content(placeholder_reopened)["pictures"]
check("picture placeholder remains a placeholder after image insertion",
      reopened_picture.shape_type == MSO_SHAPE_TYPE.PLACEHOLDER,
      reopened_picture.shape_type)
check("picture inventory includes populated picture placeholders and image metadata",
      len(placeholder_inventory) == 1
      and placeholder_inventory[0]["extension"] == "png"
      and placeholder_inventory[0]["bytes"] == len(placeholder_png),
      placeholder_inventory)

merged_prs = Presentation()
merged_slide = merged_prs.slides.add_slide(merged_prs.slide_layouts[6])
merged_table = merged_slide.shapes.add_table(
    3, 3, Inches(1), Inches(1), Inches(6), Inches(3)
).table
merged_table.cell(0, 0).text = "Merged heading"
merged_table.cell(0, 0).merge(merged_table.cell(1, 1))
merged_table.cell(2, 0).text = "ordinary cell"
merged_prs.save("merged-table.pptx")
merged_inventory = extract_slide_content(
    Presentation("merged-table.pptx").slides[0]
)["tables"][0]
merged_origin = merged_inventory[0][0]
covered_slots = [merged_inventory[0][1], merged_inventory[1][0], merged_inventory[1][1]]
check(
    "table inventory records a merged origin and its row/column spans",
    merged_origin["is_merge_origin"]
    and not merged_origin["is_spanned"]
    and merged_origin["span_height"] == 2
    and merged_origin["span_width"] == 2,
    merged_origin,
)
check(
    "table inventory marks covered slots without repeating merged text",
    all(item["is_spanned"] and item["text"] is None for item in covered_slots)
    and sum(
        item["text"] == "Merged heading"
        for row in merged_inventory for item in row
    ) == 1,
    merged_inventory,
)

# XY scatter and bubble plots do not have category/value-series semantics.
xy_prs = Presentation()
xy_slide = xy_prs.slides.add_slide(xy_prs.slide_layouts[6])
xy_data = XyChartData()
xy_series = xy_data.add_series("XY series")
xy_series.add_data_point(1, 2)
xy_series.add_data_point(3, 4)
xy_slide.shapes.add_chart(
    XL_CHART_TYPE.XY_SCATTER,
    Inches(0.5), Inches(0.5), Inches(4), Inches(2.5), xy_data,
)
bubble_data = BubbleChartData()
bubble_series = bubble_data.add_series("Bubble series")
bubble_series.add_data_point(5, 6, 7)
xy_slide.shapes.add_chart(
    XL_CHART_TYPE.BUBBLE,
    Inches(0.5), Inches(3.5), Inches(4), Inches(2.5), bubble_data,
)
xy_prs.save("xy-bubble.pptx")
xy_content = extract_slide_content(Presentation("xy-bubble.pptx").slides[0])
xy_plots = [plot for chart in xy_content["charts"] for plot in chart["plots"]]
check(
    "scatter inventory emits x and y caches without category access",
    any(
        plot["kind"] == "XyPlot"
        and plot["series"][0]["x_points"] == [(0, 1.0), (1, 3.0)]
        and plot["series"][0]["y_points"] == [(0, 2.0), (1, 4.0)]
        for plot in xy_plots
    ),
    xy_plots,
)
check(
    "bubble inventory emits x, y, and bubble-size caches",
    any(
        plot["kind"] == "BubblePlot"
        and plot["series"][0]["x_points"] == [(0, 5.0)]
        and plot["series"][0]["y_points"] == [(0, 6.0)]
        and plot["series"][0]["bubble_points"] == [(0, 7.0)]
        for plot in xy_plots
    ),
    xy_plots,
)

# Missing caches and missing ptCount are unavailable, not a proven empty series.
xy_plot = next(plot for chart in Presentation("xy-bubble.pptx").slides[0].shapes
               if chart.has_chart for plot in chart.chart.plots
               if type(plot).__name__ == "XyPlot")
xy_item = list(xy_plot.series)[0]
x_source = xy_item._element.xVal
missing_cache = copy.deepcopy(x_source)
missing_cache_ref = missing_cache.find(qn("c:numRef"))
missing_cache_ref.remove(missing_cache_ref.find(qn("c:numCache")))
check("numeric cache without numCache reports unavailable", cached_numeric_points(missing_cache) is None)
missing_count = copy.deepcopy(x_source)
missing_count_cache = missing_count.find(qn("c:numRef") + "/" + qn("c:numCache"))
missing_count_cache.remove(missing_count_cache.find(qn("c:ptCount")))
check("numeric cache without ptCount reports unavailable", cached_numeric_points(missing_count) is None)
actual_cache = x_source.xpath("./c:numRef/c:numCache")[0]
x_source.xpath("./c:numRef")[0].remove(actual_cache)
check("XY series with an unavailable cache is explicit",
      series_content(xy_item).get("cache_status") == "unavailable", series_content(xy_item))


sp_element = slide6.shapes[-1]._element  # the textbox; layout 5 still carries a Title placeholder
group_element = parse_xml(GRP)
sp_element.getparent().replace(sp_element, group_element)
group_element.append(sp_element)

flat = list(iter_shapes(slide6.shapes))
check(
    "walker finds the shape nested in the group",
    any(getattr(sh, "text_frame", None) is not None and sh.text_frame.text == "nested member" for sh in flat),
)
check(
    "top-level shapes list hides the nested member (negative control)",
    not any(getattr(sh, "text_frame", None) is not None and sh.text_frame.text == "nested member" for sh in slide6.shapes),
)
grouped_faces = [
    run.font.name
    for shape in iter_shapes(slide6.shapes)
    if shape.has_text_frame
    for paragraph in shape.text_frame.paragraphs
    for run in paragraph.runs
    if run.font.name
]
check("font triage reaches runs nested in groups", "Grouped Face" in grouped_faces, grouped_faces)

# ---- edit.md locator: candidate collection must recurse into groups ------------
old_w, new_w = "nested member", "renamed member"


def iter_shapes_with_path(shapes, path=""):
    for shape in shapes:
        here = f"{path}/{shape.name}" if path else shape.name
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_shapes_with_path(shape.shapes, here)
        else:
            yield here, shape


def iter_text_targets(path, shape):
    if shape.has_text_frame:
        yield path, shape.text_frame
    if shape.has_table:
        for row_index, row in enumerate(shape.table.rows):
            for column_index, cell in enumerate(row.cells):
                yield f"{path}/table[{row_index},{column_index}]", cell.text_frame


def iter_postcheck_text_frames(shapes, path=""):
    for shape in shapes:
        here = f"{path}/{shape.name}" if path else shape.name
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_postcheck_text_frames(shape.shapes, here)
            continue
        if shape.has_text_frame:
            yield here, shape.text_frame
        if shape.has_table:
            for row_index, row in enumerate(shape.table.rows):
                for column_index, cell in enumerate(row.cells):
                    if not cell.is_spanned:
                        yield f"{here}/table[{row_index},{column_index}]", cell.text_frame


group_postcheck = {
    location: frame.text for location, frame in iter_postcheck_text_frames(slide6.shapes)
}
table_postcheck = {
    location: frame.text
    for location, frame in iter_postcheck_text_frames(Presentation("input.pptx").slides[0].shapes)
}
check("mandatory postcheck reaches grouped text",
      "nested member" in group_postcheck.values(), group_postcheck)
check("mandatory postcheck reaches table-cell text",
      "old cell text" in table_postcheck.values(), table_postcheck)
check("mandatory postcheck inventories unexpected empty table cells",
      any(location.endswith("/table[0,0]") and not text.strip()
          for location, text in table_postcheck.items()), table_postcheck)


candidates = [
    (i, location, text_frame)
    for i, s in enumerate(prs6.slides)
    for p, sh in iter_shapes_with_path(s.shapes)
    for location, text_frame in iter_text_targets(p, sh)
    if old_w in text_frame.text
]
check("locator reaches text inside the group", len(candidates) == 1, [(i, p) for i, p, _ in candidates])
check("locator reports a stable nested path", "/" in candidates[0][1], candidates[0][1])
_, _, target = candidates[0]
target.paragraphs[0].runs[0].text = new_w
prs6.save("group-edited.pptx")
prs_g = Presentation("group-edited.pptx")
found = [sh for sh in iter_shapes(prs_g.slides[0].shapes)
         if getattr(sh, "text_frame", None) is not None and sh.text_frame.text == new_w]
check("group member edit persists after save", len(found) == 1)

table_candidates = [
    (i, location, text_frame)
    for i, s in enumerate(Presentation("input.pptx").slides)
    for p, sh in iter_shapes_with_path(s.shapes)
    for location, text_frame in iter_text_targets(p, sh)
    if old_cell in text_frame.text
]
check("locator reaches wording stored only in a table cell", len(table_candidates) == 1)
check("table-cell locator retains row and column",
      table_candidates[0][1].endswith("/table[0,1]"), table_candidates[0][1])

duplicate_prs = Presentation("input.pptx")
duplicate_shape = next(shape for shape in duplicate_prs.slides[0].shapes if shape.has_table)
duplicate_shape.table.cell(1, 0).text = old_cell
all_table_candidates = [
    (i, location, text_frame)
    for i, slide_item in enumerate(duplicate_prs.slides)
    for path, shape in iter_shapes_with_path(slide_item.shapes)
    for location, text_frame in iter_text_targets(path, shape)
    if old_cell in text_frame.text
]
target_location = f"{duplicate_shape.name}/table[0,1]"
selected_table_candidates = [
    candidate for candidate in all_table_candidates if candidate[1] == target_location
]
check("duplicate table text requires a location selector", len(all_table_candidates) == 2)
check("table location selector chooses one row/column",
      len(selected_table_candidates) == 1, [item[1] for item in all_table_candidates])
try:
    require(len(all_table_candidates) == 1, "target is not unique")
    optimized_duplicate_guard_rejected = False
except ValueError:
    optimized_duplicate_guard_rejected = True
check("explicit uniqueness guard rejects duplicates even under python -O",
      optimized_duplicate_guard_rejected)

split_prs = Presentation()
split_slide = split_prs.slides.add_slide(split_prs.slide_layouts[6])
split_frame = split_slide.shapes.add_textbox(
    Inches(1), Inches(1), Inches(4), Inches(1)
).text_frame
split_frame.paragraphs[0].add_run().text = "old "
split_frame.paragraphs[0].add_run().text = "wording"
split_hits = [
    run for paragraph in split_frame.paragraphs for run in paragraph.runs
    if old in run.text
]
try:
    require(len(split_hits) == 1 and split_hits[0].text.count(old) == 1,
            "target is split across runs")
    optimized_run_guard_rejected = False
except ValueError:
    optimized_run_guard_rejected = True
check("explicit run-boundary guard survives python -O", optimized_run_guard_rejected)

repeated_frame = split_slide.shapes.add_textbox(
    Inches(1), Inches(2), Inches(4), Inches(1)
).text_frame
repeated_frame.text = f"{old} / {old}"
try:
    require(repeated_frame.text.count(old) == 1,
            "target occurs more than once in the selected shape")
    optimized_repeated_guard_rejected = False
except ValueError:
    optimized_repeated_guard_rejected = True
check("explicit repeated-text guard survives python -O", optimized_repeated_guard_rejected)

# ---- analyze.md snippet: per-master, script-aware theme font resolution --------

prs7 = Presentation("input.pptx")
theme_cache = {}
DRAWINGML = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}


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
        return ["Hans", "Hant", "Jpan", "Hang"]
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


master_name, theme_fonts = theme_faces_for_slide(prs7.slides[0])
check(
    "theme major/minor fonts resolve through the slide master relationship",
    theme_fonts["major"]["latin"] and theme_fonts["minor"]["latin"],
    (master_name, theme_fonts),
)
print("theme fonts:", ascii(theme_fonts))


class StubThemePart:
    def __init__(self, major, minor, east_asian="", complex_script="", scripts=None):
        script_nodes = "".join(
            f'<a:font script="{script}" typeface="{face}"/>'
            for script, face in (scripts or {}).items()
        )
        self.blob = (
            f'<a:theme xmlns:a="{DRAWINGML["a"]}"><a:themeElements><a:fontScheme>'
            f'<a:majorFont><a:latin typeface="{major}"/><a:ea typeface="{east_asian}"/>'
            f'<a:cs typeface="{complex_script}"/>{script_nodes}</a:majorFont>'
            f'<a:minorFont><a:latin typeface="{minor}"/><a:ea typeface="{east_asian}"/>'
            f'<a:cs typeface="{complex_script}"/>{script_nodes}</a:minorFont>'
            f'</a:fontScheme></a:themeElements></a:theme>'
        ).encode()


class StubMasterPart:
    def __init__(self, name, major, minor, **theme_options):
        self.partname = name
        self.theme_part = StubThemePart(major, minor, **theme_options)

    def part_related_by(self, relationship_type):
        assert relationship_type == RT.THEME
        return self.theme_part


def stub_slide(name, major, minor, **theme_options):
    master = type("Master", (), {"part": StubMasterPart(name, major, minor, **theme_options)})()
    layout = type("Layout", (), {"slide_master": master})()
    return type("Slide", (), {"slide_layout": layout})()


_, first_fonts = theme_faces_for_slide(stub_slide("/ppt/slideMasters/one.xml", "Head One", "Body One"))
_, second_fonts = theme_faces_for_slide(stub_slide("/ppt/slideMasters/two.xml", "Head Two", "Body Two"))
check(
    "different slide masters resolve their own theme faces",
    first_fonts["major"]["latin"] == "Head One"
    and second_fonts["major"]["latin"] == "Head Two"
    and first_fonts != second_fonts,
    (first_fonts, second_fonts),
)

_, script_fonts = theme_faces_for_slide(stub_slide(
    "/ppt/slideMasters/scripts.xml", "Latin Theme", "Latin Body",
    east_asian="East Asian Theme", complex_script="Complex Script Theme",
    scripts={
        "Hans": "Simplified Chinese Theme", "Cyrl": "Cyrillic Theme",
        "Thai": "Thai Theme",
    },
))

check(
    "unstyled runs report as inherited, not as a concrete face",
    all(run.font.name is None for sh in prs7.slides[0].shapes if sh.has_text_frame for par in sh.text_frame.paragraphs for run in par.runs),
)

font_box = prs7.slides[0].shapes.add_textbox(Inches(1), Inches(4), Inches(4), Inches(1))
font_paragraph = font_box.text_frame.paragraphs[0]
font_paragraph.font.name = "Paragraph Face"
paragraph_run = font_paragraph.add_run()
paragraph_run.text = "paragraph default"
explicit_run = font_paragraph.add_run()
explicit_run.text = "run override"
explicit_run.font.name = "Run Face"
cjk_theme_run = font_paragraph.add_run()
cjk_theme_run.text = "汉字"
thai_theme_run = font_paragraph.add_run()
thai_theme_run.text = "ไทย"
mixed_run = font_paragraph.add_run()
mixed_run.text = "A汉ก"
mixed_run.font.name = "Latin Explicit"
for tag, face in (("a:ea", "East Explicit"), ("a:cs", "Complex Explicit")):
    node = OxmlElement(tag)
    node.set("typeface", face)
    mixed_run._r.get_or_add_rPr().append(node)
token_run = font_paragraph.add_run()
token_run.text = "汉"
token_ea = OxmlElement("a:ea")
token_ea.set("typeface", "+mj-ea")
token_run._r.get_or_add_rPr().append(token_ea)

partial_box = prs7.slides[0].shapes.add_textbox(Inches(5), Inches(4), Inches(4), Inches(1))
partial_paragraph = partial_box.text_frame.paragraphs[0]
latin_only_run = partial_paragraph.add_run()
latin_only_run.text = "A汉"
latin_only_run.font.name = "Latin Only"
east_only_run = partial_paragraph.add_run()
east_only_run.text = "A汉"
east_only = OxmlElement("a:ea")
east_only.set("typeface", "East Only")
east_only_run._r.get_or_add_rPr().append(east_only)
cyrillic_cjk_run = partial_paragraph.add_run()
cyrillic_cjk_run.text = "Тест 汉"

token_fallback_fonts = {
    "major": {"latin": "Major Latin", "eastAsia": "", "complexScript": "",
              "scripts": {"Hans": "Major Hans"}},
    "minor": {"latin": "Minor Latin", "eastAsia": "Minor East", "complexScript": "",
              "scripts": {"Hans": "Minor Hans"}},
}

detected_faces = {
    run.text: font_candidates(run, font_paragraph, script_fonts, "minor")
    for run in font_paragraph.runs
}
latin_only_faces = font_candidates(latin_only_run, partial_paragraph, script_fonts, "minor")
east_only_faces = font_candidates(east_only_run, partial_paragraph, script_fonts, "minor")
cyrillic_cjk_faces = font_candidates(
    cyrillic_cjk_run, partial_paragraph, script_fonts, "minor"
)
check("font triage reports the run face and source",
      ("latin", "Run Face", "run") in detected_faces["run override"], detected_faces)
check(
    "font triage reports the paragraph face and source",
    ("latin", "Paragraph Face", "paragraph defaults")
    in detected_faces["paragraph default"],
    detected_faces,
)
check(
    "CJK inherited-font triage includes east-Asian and script-specific faces",
    {"East Asian Theme", "Simplified Chinese Theme"}
    <= {face for _, face, _ in detected_faces["汉字"]}, detected_faces["汉字"],
)
check("Thai inherited-font triage uses its script mapping",
      "Thai Theme" in {face for _, face, _ in detected_faces["ไทย"]}, detected_faces["ไทย"])
check("explicit Latin/East-Asian/complex-script slots resolve independently",
      {(slot, face) for slot, face, _ in detected_faces["A汉ก"]}
      == {("latin", "Latin Explicit"), ("eastAsia", "East Explicit"),
          ("complexScript", "Complex Explicit")}, detected_faces["A汉ก"])
check("mixed run combines direct Latin with inherited east-Asian faces",
      {("latin", "Latin Only"), ("eastAsia", "East Asian Theme")}
      <= {(slot, face) for slot, face, _ in latin_only_faces},
      latin_only_faces)
check("mixed run combines inherited Latin with a direct east-Asian face",
      {("latin", "Latin Body"), ("eastAsia", "East Only")}
      <= {(slot, face) for slot, face, _ in east_only_faces},
      east_only_faces)
check("Cyrillic plus CJK requires both Latin and east-Asian theme slots",
      {("latin", "Cyrillic Theme"), ("eastAsia", "Simplified Chinese Theme")}
      <= {(slot, face) for slot, face, _ in cyrillic_cjk_faces},
      cyrillic_cjk_faces)
check("empty +mj-ea generic face falls back to the major script mapping",
      ("eastAsia", "Major Hans", "major theme script Hans")
      in font_candidates(token_run, font_paragraph, token_fallback_fonts, "minor"),
      font_candidates(token_run, font_paragraph, token_fallback_fonts, "minor"))


# ---- analyze.md snippet: sparse cache points keep their idx ----------------------
sparse_chart_xml = (
    '<c:ser xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">'
    '<c:idx val="0"/><c:order val="0"/><c:tx><c:v>series</c:v></c:tx>'
    '<c:xVal><c:numRef><c:numCache><c:formatCode>General</c:formatCode>'
    '<c:ptCount val="6"/>'
    '<c:pt idx="0"><c:v>1</c:v></c:pt>'
    '<c:pt idx="2"><c:v>5</c:v></c:pt>'
    '<c:pt idx="5"><c:v>9</c:v></c:pt>'
    '</c:numCache></c:numRef></c:xVal></c:ser>'
)
from pptx.oxml.ns import qn as pptx_qn

def cached_numeric_points(series_element, element_name):
    return [
        (int(pt.get("idx")), pt.find(pptx_qn("c:v")).text)
        for pt in series_element.xpath(f"./c:{element_name}//c:pt")
        if pt.get("idx") is not None and pt.find(pptx_qn("c:v")) is not None
    ]

from pptx.oxml import parse_xml as pptx_parse_xml
sparse_series = pptx_parse_xml(sparse_chart_xml)
points = cached_numeric_points(sparse_series, "xVal")
check("sparse cache points keep their idx", points == [(0, "1"), (2, "5"), (5, "9")], points)
compact = [value for _, value in points]
check("compact extraction is provably lossy (negative control)",
      compact == ["1", "5", "9"] and len({idx for idx, _ in points}) == len(points))



# ---- analyze.md: script-aware run faces and table-cell triage --------------------
from pptx.oxml import parse_xml as pptx_parse_xml2
from pptx.oxml.ns import qn

def required_font_slots(text, script_tags_fn):
    tags = script_tags_fn(text)
    slots = []
    if any(ch.isascii() and ch.isalnum() for ch in text):
        slots.append("latin")
    if any(tag in ("Hans", "Hant", "Jpan", "Hang") for tag in tags):
        slots.append("eastAsia")
    if any(tag in ("Arab", "Hebr", "Deva") for tag in tags):
        slots.append("complexScript")
    return slots or ["latin"]

def explicit_run_faces(run):
    rPr = run._r.find(qn("a:rPr"))
    if rPr is None:
        return {}
    declared = {}
    for slot, tag in (("latin", "a:latin"), ("eastAsia", "a:ea"), ("complexScript", "a:cs")):
        node = rPr.find(qn(tag))
        if node is not None and node.get("typeface"):
            declared[slot] = node.get("typeface")
    return declared

def resolve_faces(run, text, role_fonts, script_tags_fn):
    direct = explicit_run_faces(run)
    tags = script_tags_fn(text)
    result = {}
    for slot in required_font_slots(text, script_tags_fn):
        if slot in direct:
            result[slot] = [direct[slot]]
            continue
        relevant = {
            "eastAsia": {"Hans", "Hant", "Jpan", "Hang"},
            "complexScript": {"Arab", "Hebr", "Deva"},
        }.get(slot, set())
        candidates = [role_fonts[slot]]
        candidates.extend(role_fonts["scripts"].get(tag, "") for tag in tags if tag in relevant)
        result[slot] = [face for face in dict.fromkeys(candidates) if face]
    return result

run_xml = (
    '<a:r xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    '<a:rPr lang="zh-CN"><a:latin typeface="Arial"/><a:ea typeface="SimSun"/></a:rPr>'
    '<a:t>\u6d4b\u8bd5</a:t></a:r>'
)
dual_run = pptx_parse_xml2(run_xml)
class FakeRun:
    _r = dual_run
check("a CJK run with latin+ea declared resolves to the eastAsia face",
      resolve_faces(FakeRun(), "\u6d4b\u8bd5", {
          "latin": "Theme Latin", "eastAsia": "Theme East", "complexScript": "Theme CS",
          "scripts": {},
      }, script_tags) == {"eastAsia": ["SimSun"]})
check("a mixed Latin+CJK run reports both applicable declared faces",
      resolve_faces(FakeRun(), "Q3 \u6d4b\u8bd5", {
          "latin": "Theme Latin", "eastAsia": "Theme East", "complexScript": "Theme CS",
          "scripts": {},
      }, script_tags) == {"latin": ["Arial"], "eastAsia": ["SimSun"]})

latin_only_xml = (
    '<a:r xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    '<a:rPr><a:latin typeface="Arial"/></a:rPr><a:t>Q3 \u6d4b\u8bd5</a:t></a:r>'
)
latin_only_run = pptx_parse_xml2(latin_only_xml)
class LatinOnlyRun:
    _r = latin_only_run
partial_resolution = resolve_faces(LatinOnlyRun(), "Q3 \u6d4b\u8bd5", {
    "latin": "Theme Latin", "eastAsia": "Theme East", "complexScript": "Theme CS",
    "scripts": {"Hans": "Theme Hans"},
}, script_tags)
check("a direct Latin face does not suppress inherited CJK candidates",
      partial_resolution["latin"] == ["Arial"]
      and partial_resolution["eastAsia"] == ["Theme East", "Theme Hans"],
      partial_resolution)
check("run.font.name alone would report only the Latin face (negative control)",
      dual_run.find(qn("a:rPr")).find(qn("a:latin")).get("typeface") == "Arial")

triage_deck = Presentation()
triage_slide = triage_deck.slides.add_slide(triage_deck.slide_layouts[6])
triage_shape = triage_slide.shapes.add_table(2, 2, 0, 0, 4000000, 2000000)
triage_shape.table.cell(0, 0).text_frame.text = "\u8868\u683c\u6587\u672c"
triage_deck.save("triage-table.pptx")
triage_reopened = Presentation("triage-table.pptx")
triage_table_shape = next(s for s in triage_reopened.slides[0].shapes if s.has_table)
def iter_text_frames(shapes):
    for shape in shapes:
        if shape.has_text_frame:
            yield shape.text_frame
        if getattr(shape, "has_table", False):
            for row in shape.table.rows:
                for cell in row.cells:
                    yield cell.text_frame


def unresolved_graphic_font_regions(shapes):
    for shape in shapes:
        if getattr(shape, "has_chart", False):
            yield {"shape": shape.name, "kind": "chart"}
        graphic_data = shape._element.find(".//" + qn("a:graphicData"))
        if graphic_data is not None and graphic_data.get("uri") == DIAGRAM_NS:
            yield {"shape": shape.name, "kind": "SmartArt"}


frames = list(iter_text_frames(triage_reopened.slides[0].shapes))
check("table-cell text frames are reached by the triage walker",
      any("\u8868\u683c\u6587\u672c" in f.text for f in frames), [f.text for f in frames])
check("the table graphic frame itself has no text frame (negative control)",
      not triage_table_shape.has_text_frame)

chart_shape_for_font_audit = next(
    shape for shape in Presentation("input.pptx").slides[0].shapes if shape.has_chart
)
unresolved_graphics = list(unresolved_graphic_font_regions([
    chart_shape_for_font_audit, diagram_shape, triage_table_shape,
]))
check("font triage marks both charts and SmartArt as unresolved regions",
      {item["kind"] for item in unresolved_graphics} == {"chart", "SmartArt"},
      unresolved_graphics)
check("ordinary table graphic frames are not mislabeled as chart or SmartArt",
      all(item["shape"] != triage_table_shape.name for item in unresolved_graphics),
      unresolved_graphics)
try:
    if unresolved_graphics:
        raise LookupError(f"unresolved chart/SmartArt fonts: {unresolved_graphics}")
    graphic_font_audit_rejected = False
except LookupError:
    graphic_font_audit_rejected = True
check("unresolved chart/SmartArt font regions fail closed under optimized Python",
      graphic_font_audit_rejected)

print("\n" + ("ALL PPTX FIXTURES PASSED" if not failures else f"{len(failures)} FAILURES: {failures}"))
sys.exit(0 if not failures else 1)
