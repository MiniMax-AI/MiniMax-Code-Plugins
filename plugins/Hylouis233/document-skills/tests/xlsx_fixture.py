# Minimal runnable fixtures for the snippets called out in review: one file per format.
# Each script is self-contained, writes only scratch files into the current directory,
# and exits non-zero on failed assertions. Run from any scratch directory:
#   python pdf_fixture.py   (deps: reportlab, pypdf, pymupdf)
#   python pptx_fixture.py  (deps: python-pptx)
#   python xlsx_fixture.py  (deps: openpyxl)
#   python docx_fixture.py  (deps: python-docx, pymupdf, soffice on PATH)
import base64
import csv
import sys
import zipfile
from pathlib import Path
from tempfile import TemporaryFile

import openpyxl

failures = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ((" :: " + str(extra)) if not cond and extra else ""))
    if not cond:
        failures.append(name)


# ---- csv.md snippet: sniffed dialect actually reaches the reader ---------------
semicolon_csv = "region;units;note\nEU;120;first\nUS;80;second\n"
with open("input.csv", "w", newline="", encoding="utf-8") as f:
    f.write(semicolon_csv)

with open("input.csv", newline="", encoding="utf-8-sig") as f:
    sample = f.read(2048)
    f.seek(0)
    dialect = csv.Sniffer().sniff(sample)
    reader = csv.DictReader(f, dialect=dialect)
    rows = list(reader)

check("sniffer detects the semicolon dialect", dialect.delimiter == ";", dialect.delimiter)
check("rows parse into per-column values", rows[0] == {"region": "EU", "units": "120", "note": "first"}, rows[0])

# negative control: default comma reader splits the whole line as one key
with open("input.csv", newline="", encoding="utf-8-sig") as f:
    naive = next(csv.DictReader(f))
check("default reader is proven wrong here (negative control)", list(naive.keys())[0] == "region;units;note", naive)

# ---- csv.md conversion: formula-looking input remains literal text -----------
formula_looking = '=HYPERLINK("https://example.invalid", "click")'
csv_wb = openpyxl.Workbook()
csv_cell = csv_wb.active["A1"]
csv_cell.value = formula_looking
csv_cell.data_type = "s"
csv_wb.save("csv-text.xlsx")
csv_reopened = openpyxl.load_workbook("csv-text.xlsx", data_only=False)
check("formula-looking CSV field keeps its exact text", csv_reopened.active["A1"].value == formula_looking)
check("formula-looking CSV field is not an XLSX formula", csv_reopened.active["A1"].data_type == "s")

unsafe_wb = openpyxl.Workbook()
unsafe_wb.active["A1"] = formula_looking
check("plain assignment is proven unsafe (negative control)", unsafe_wb.active["A1"].data_type == "f")

CSV_FORMULA_PREFIXES = ("=", "+", "-", "@")


def spreadsheet_csv_field(value, *, mode="safe"):
    if mode not in {"safe", "raw"}:
        raise ValueError("mode must be 'safe' or 'raw'")
    if mode == "safe" and isinstance(value, str) and value.startswith(CSV_FORMULA_PREFIXES):
        return "'" + value
    return value


def delimiter_for(path):
    delimiter = {".csv": ",", ".tsv": "\t"}.get(Path(path).suffix.lower())
    if delimiter is None:
        raise ValueError("output must use a .csv or .tsv extension")
    return delimiter


formula_like_fields = ["=1+1", "+SUM(A1:A2)", "-2+3", "@cmd", "plain", "-7", -7]
with open("spreadsheet-safe.csv", "w", newline="", encoding="utf-8") as output:
    csv.writer(output).writerow([spreadsheet_csv_field(value) for value in formula_like_fields])
with open("spreadsheet-safe.csv", newline="", encoding="utf-8") as exported:
    safe_fields = next(csv.reader(exported))
check("spreadsheet-safe CSV neutralizes all four formula prefixes",
      safe_fields[:4] == ["'=1+1", "'+SUM(A1:A2)", "'-2+3", "'@cmd"], safe_fields)
check("safe CSV preserves benign text and numeric values",
      safe_fields[4:] == ["plain", "'-7", "-7"], safe_fields[4:])
check("raw CSV mode preserves exact formula-like literal strings",
      [spreadsheet_csv_field(value, mode="raw") for value in formula_like_fields[:4]]
      == formula_like_fields[:4])
try:
    spreadsheet_csv_field("=1+1", mode="unknown")
    invalid_csv_mode_rejected = False
except ValueError:
    invalid_csv_mode_rejected = True
check("CSV export rejects an ambiguous safety mode", invalid_csv_mode_rejected)

tabular_rows = [["Region", "Units", "Note"], ["EU, West", 120, "contains\ttab"]]
with open("spreadsheet-safe.TSV", "w", newline="", encoding="utf-8") as output:
    csv.writer(output, delimiter=delimiter_for("spreadsheet-safe.TSV")).writerows(tabular_rows)
with open("spreadsheet-safe.TSV", newline="", encoding="utf-8") as exported:
    tsv_rows = list(csv.reader(exported, delimiter="\t"))
check("TSV export selects a tab delimiter case-insensitively",
      tsv_rows == [[str(value) for value in row] for row in tabular_rows], tsv_rows)
check("CSV export retains its comma delimiter", delimiter_for("output.csv") == ",")
try:
    delimiter_for("output.txt")
    unknown_tabular_suffix_rejected = False
except ValueError:
    unknown_tabular_suffix_rejected = True
check("tabular export rejects an unknown extension", unknown_tabular_suffix_rejected)

# ---- edit.md snippet: round_trip_changes detects dropped parts AND stripped extensions ----
from collections import Counter
from xml.etree import ElementTree as ET

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Data"
ws.append(["Region", "Units"])
ws.append(["EU", 120])
wb.create_sheet("Keep")["A1"] = "keep"
wb.save("plain.xlsx")

with zipfile.ZipFile("plain.xlsx") as zin:
    payload = {name: zin.read(name) for name in zin.namelist()}

# simulate an unsupported extension part (what a slicer/queries part looks like in the zip)
payload["xl/slicers/slicer1.xml"] = b"<slicer xmlns='stub'/>"
payload["xl/media/large.bin"] = b"x14:" * 32_768  # binary payload must never be marker-scanned

# Two records deliberately share a URI/namespace but carry different child content. A coarse
# presence set cannot see one disappear while the other survives.
SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
X14_NS = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"
EXT_URI = "{00000000-0000-0000-0000-000000000000}"
KEEP_EXT = (
    f'<ext uri="{EXT_URI}" xmlns:x14="{X14_NS}"><x14:stub id="keep"/></ext>'
).encode()
KEEP_EXT_ALT_PREFIX = (
    f'<ext uri="{EXT_URI}" xmlns:alt="{X14_NS}"><alt:stub id="keep"/></ext>'
).encode()
DROP_EXT = (
    f'<ext uri="{EXT_URI}" xmlns:sx="{X14_NS}"><sx:stub id="drop"/></ext>'
).encode()
EXT_LIST_BOTH = b"<extLst>" + KEEP_EXT + DROP_EXT + b"</extLst>"
EXT_LIST_KEEP = b"<extLst>" + KEEP_EXT_ALT_PREFIX + b"</extLst>"
EXT_LIST_DROP = b"<extLst>" + DROP_EXT + b"</extLst>"
payload["xl/worksheets/sheet1.xml"] = payload["xl/worksheets/sheet1.xml"].replace(
    b"</worksheet>", EXT_LIST_BOTH + b"</worksheet>")
payload["xl/worksheets/sheet2.xml"] = payload["xl/worksheets/sheet2.xml"].replace(
    b"</worksheet>", EXT_LIST_DROP + b"</worksheet>")

with zipfile.ZipFile("extended.xlsx", "w", zipfile.ZIP_DEFLATED) as zout:
    for name, data in payload.items():
        zout.writestr(name, data)

partial_payload = dict(payload)
partial_payload["xl/worksheets/sheet1.xml"] = partial_payload[
    "xl/worksheets/sheet1.xml"
].replace(EXT_LIST_BOTH, EXT_LIST_KEEP)
with zipfile.ZipFile("partial-extension.xlsx", "w", zipfile.ZIP_DEFLATED) as zout:
    for name, data in partial_payload.items():
        zout.writestr(name, data)

EXT_TAG = f"{{{SHEET_NS}}}ext"


def normalized_text(value):
    return (value or "").strip()


def normalized_element(element):
    return (
        element.tag,
        tuple(sorted(element.attrib.items())),
        normalized_text(element.text),
        tuple((normalized_element(child), normalized_text(child.tail)) for child in element),
    )


def worksheet_extension_records(archive, info):
    records = Counter()
    extension_depth = 0
    with archive.open(info) as stream:
        for event, element in ET.iterparse(stream, events=("start", "end")):
            if event == "start":
                if extension_depth:
                    extension_depth += 1
                elif element.tag == EXT_TAG:
                    extension_depth = 1
            elif extension_depth:
                if extension_depth == 1:
                    children = tuple(
                        (normalized_element(child), normalized_text(child.tail))
                        for child in element
                    )
                    records[(element.attrib.get("uri", ""), children)] += 1
                    element.clear()
                    extension_depth = 0
                else:
                    extension_depth -= 1
            else:
                element.clear()
    return records


def archive_inventory(source):
    with zipfile.ZipFile(source) as archive:
        names = set(archive.namelist())
        extensions = {}
        for info in archive.infolist():
            if (info.filename.startswith("xl/worksheets/")
                    and info.filename.endswith(".xml")):
                extensions[info.filename] = worksheet_extension_records(archive, info)
        return names, extensions


def stripped_extension_records(before, after, common_names):
    stripped = []
    for name in sorted(common_names):
        for (uri, children), count in (before.get(name, Counter())
                                       - after.get(name, Counter())).items():
            stripped.extend((name, uri, children) for _ in range(count))
    return sorted(stripped, key=repr)


def round_trip_changes(path, **load_options):
    before_names, before_extensions = archive_inventory(path)
    wb = openpyxl.load_workbook(path, **load_options)  # same options as the real edit
    with TemporaryFile() as output:
        wb.save(output)
        output.seek(0)
        after_names, after_extensions = archive_inventory(output)
    wb.close()
    dropped = sorted(before_names - after_names)
    stripped_extensions = stripped_extension_records(
        before_extensions, after_extensions, before_names & after_names
    )
    return dropped, stripped_extensions


dropped, stripped = round_trip_changes("extended.xlsx")
check("injected slicer-like part is detected as dropped", "xl/slicers/slicer1.xml" in dropped, dropped)
check("each stripped worksheet extension record is reported with worksheet and URI",
      sum(item[0] == "xl/worksheets/sheet1.xml" and item[1] == EXT_URI
          for item in stripped) == 2,
      stripped)
check("clean workbook reports nothing", round_trip_changes("plain.xlsx") == ([], []))
inventory_names, inventory_extensions = archive_inventory("extended.xlsx")
check("binary archive parts are named but never marker-scanned",
      "xl/media/large.bin" in inventory_names
      and "xl/media/large.bin" not in inventory_extensions)

partial_names, partial_extensions = archive_inventory("partial-extension.xlsx")
coarse_needles = (b"extLst", X14_NS.encode(), EXT_URI.encode())
coarse_before = {needle for needle in coarse_needles
                 if needle in payload["xl/worksheets/sheet1.xml"]}
coarse_after = {needle for needle in coarse_needles
                if needle in partial_payload["xl/worksheets/sheet1.xml"]}
check("coarse marker presence misses one removed extension record (negative control)",
      coarse_before == coarse_after == set(coarse_needles),
      (coarse_before, coarse_after))
partial_loss = stripped_extension_records(
    inventory_extensions, partial_extensions, inventory_names & partial_names
)
check("granular extension inventory detects only the removed child-content record",
      len(partial_loss) == 1
      and partial_loss[0][0] == "xl/worksheets/sheet1.xml"
      and partial_loss[0][1] == EXT_URI
      and "drop" in repr(partial_loss[0][2]),
      partial_loss)
check("extension inventory keeps records separated by worksheet identity",
      inventory_extensions["xl/worksheets/sheet2.xml"]
      == partial_extensions["xl/worksheets/sheet2.xml"]
      and bool(partial_extensions["xl/worksheets/sheet2.xml"]),
      partial_extensions)

# ---- formatting.md snippet: sheet references built from the real sheet title -------
wb_f = openpyxl.Workbook()
src = wb_f.active
src.title = "Raw Data"          # space forces quoting
src.append(["Region", "Units", "Price"])
src.append(["EU", 3, 10])
src.append(["US", 4, 20])
agg = wb_f.create_sheet("ByRegion")


def sheet_ref(sheet):
    escaped = sheet.title.replace("'", "''")
    return f"'{escaped}'!"


ref = sheet_ref(src)
agg.append(["Region", "Units"])
agg["A2"] = "EU"
agg["B2"] = f"=SUMIF({ref}A:A,A2,{ref}B:B)"
wb_f.save("agg.xlsx")
wb_g = openpyxl.load_workbook("agg.xlsx")
check("formula references the real sheet name", wb_g["ByRegion"]["B2"].value == "=SUMIF('Raw Data'!A:A,A2,'Raw Data'!B:B)", wb_g["ByRegion"]["B2"].value)
apostrophe_sheet = wb_f.create_sheet("O'Brien")
apostrophe_sheet["A1"] = 1
agg["B3"] = f"=SUM({sheet_ref(apostrophe_sheet)}A:A)"
wb_f.save("apostrophe-agg.xlsx")
apostrophe_formula = openpyxl.load_workbook("apostrophe-agg.xlsx")["ByRegion"]["B3"].value
check(
    "quoted sheet reference doubles apostrophes",
    apostrophe_formula == "=SUM('O''Brien'!A:A)",
    apostrophe_formula,
)
hyphen_sheet = wb_f.create_sheet("Q1-Data")
hyphen_sheet["A1"] = 1
agg["B4"] = f"=SUM({sheet_ref(hyphen_sheet)}A:A)"
wb_f.save("hyphen-agg.xlsx")
hyphen_formula = openpyxl.load_workbook("hyphen-agg.xlsx")["ByRegion"]["B4"].value
check("ambiguous punctuation is protected by quoting", hyphen_formula == "=SUM('Q1-Data'!A:A)", hyphen_formula)

# Falsey values are valid categories; blank filtering must not discard or conflate them.
falsey_ws = openpyxl.Workbook().active
for value in ("Category", 0, False, "", None, 0, False):
    falsey_ws.append([value])
regions = []
seen_region_keys = set()
for (region,) in falsey_ws.iter_rows(min_row=2, min_col=1, max_col=1, values_only=True):
    if region is None or region == "":
        continue
    key = (type(region), region)
    if key not in seen_region_keys:
        seen_region_keys.add(key)
        regions.append(region)
check(
    "aggregation preserves numeric zero and boolean false as distinct categories",
    len(regions) == 2
    and type(regions[0]) is int and regions[0] == 0
    and type(regions[1]) is bool and regions[1] is False,
    [(type(value).__name__, value) for value in regions],
)

# ---- edit.md structural audit includes non-cell dependencies ------------------
from openpyxl.chart import BarChart, Reference
from openpyxl.drawing.image import Image
from openpyxl.formula import Tokenizer
from openpyxl.formatting.rule import CellIsRule, ColorScaleRule, DataBarRule, FormulaRule
from openpyxl.utils.cell import coordinate_to_tuple, range_boundaries
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table


def formula_text(value):
    if isinstance(value, str):
        return value
    if text := getattr(value, "text", None):
        return text
    fields = ("ref", "r1", "r2", "dt2D", "dtr", "ca", "del1", "del2")
    details = ", ".join(
        f"{name}={getattr(value, name)!r}" for name in fields if hasattr(value, name)
    )
    return f"{type(value).__name__}({details})"


def defined_name_values(workbook):
    names = workbook.defined_names
    return names.values() if hasattr(names, "values") else names.definedName


def drawing_anchor_rows(drawing):
    anchor = drawing.anchor
    if isinstance(anchor, str):
        return (coordinate_to_tuple(anchor)[0],)
    rows = []
    if marker := getattr(anchor, "_from", None):
        rows.append(marker.row + 1)
    if marker := getattr(anchor, "to", None):
        rows.append(marker.row + 1)
    return tuple(rows)


def structural_references(workbook):
    refs = []
    for item in defined_name_values(workbook):
        refs.append(("defined name", item.name, item.attr_text))
    for sheet in workbook.worksheets:
        owner = sheet.title
        for row in sheet.iter_rows():
            for cell in row:
                if cell.data_type == "f":
                    refs.append(("cell formula", f"{owner}!{cell.coordinate}",
                                 formula_text(cell.value)))
        for table in sheet.tables.values():
            refs.append(("table", owner + "!" + table.name, table.ref))
        for merged_range in sheet.merged_cells.ranges:
            refs.append(("merged range", owner, str(merged_range)))
        if sheet.auto_filter.ref:
            refs.append(("auto filter", owner, sheet.auto_filter.ref))
        for label, value in (
            ("print area", sheet.print_area),
            ("print title rows", sheet.print_title_rows),
            ("print title columns", sheet.print_title_cols),
        ):
            if value:
                refs.append((label, owner, str(value)))
        for validation in sheet.data_validations.dataValidation:
            refs.append(("data validation range", owner, str(validation.sqref)))
            for formula in (validation.formula1, validation.formula2):
                if formula:
                    refs.append(("data validation formula", owner, str(formula)))
        for conditional_range in sheet.conditional_formatting:
            refs.append(("conditional formatting range", owner, str(conditional_range.sqref)))
            for rule in sheet.conditional_formatting[conditional_range]:
                for formula in getattr(rule, "formula", ()):
                    refs.append(("conditional formatting formula", owner, str(formula)))
        for index, chart in enumerate(sheet._charts, start=1):
            refs.append(("drawing anchor", f"{owner} chart {index}", drawing_anchor_rows(chart)))
            for element in chart._write().iter():
                if element.tag.rsplit("}", 1)[-1] == "f" and element.text:
                    refs.append(("chart series", f"{owner} chart {index}", element.text))
        for index, image in enumerate(sheet._images, start=1):
            refs.append(("drawing anchor", f"{owner} image {index}", drawing_anchor_rows(image)))
    return refs


def cell_formula_references(workbook):
    refs = []
    for sheet in workbook.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                if cell.data_type == "f":
                    value = cell.value
                    refs.append((
                        "cell formula",
                        sheet.title,
                        cell.coordinate,
                        formula_text(value),
                    ))
    return refs


def formula_may_intersect_rows(owner_sheet, formula, shifted_sheet, start_row):
    if not isinstance(formula, str) or not formula.startswith("="):
        return True
    tokens = Tokenizer(formula).items
    unmodeled_reference_functions = {"indirect", "offset", "address"}
    if any(
        token.type == "FUNC" and token.subtype == "OPEN"
        and token.value.rstrip("(").rsplit(":", 1)[-1]
        .lstrip("@").rsplit(".", 1)[-1].casefold()
        in unmodeled_reference_functions
        for token in tokens
    ):
        return True
    for token in tokens:
        if token.type != "OPERAND" or token.subtype != "RANGE":
            continue
        reference = token.value
        target_sheet = owner_sheet
        if "!" in reference:
            qualifier, reference = reference.rsplit("!", 1)
            if "[" in qualifier or ":" in qualifier:
                return True
            target_sheet = qualifier.strip("'").replace("''", "'")
        if target_sheet.casefold() != shifted_sheet.casefold():
            continue
        try:
            _, min_row, _, max_row = range_boundaries(reference.replace("$", ""))
        except ValueError:
            return True
        if min_row is None or max_row is None or max_row >= start_row:
            return True
    return False

class LegacyDefinedNames:
    """Minimal openpyxl 3.0-style DefinedNameList surface."""
    definedName = [DefinedName("LegacyRange", attr_text="'Legacy'!$A$1")]


class LegacyWorkbook:
    defined_names = LegacyDefinedNames()
    worksheets = []


check(
    "structural audit supports openpyxl 3.0 DefinedNameList",
    structural_references(LegacyWorkbook())
    == [("defined name", "LegacyRange", "'Legacy'!$A$1")],
)


audit_wb = openpyxl.Workbook()
audit_ws = audit_wb.active
audit_ws.title = "Audit"
audit_ws.append(["Value"])
audit_ws.append([1])
audit_ws.append([2])
audit_ws["C1"] = "=SUM(A2:A3)"
audit_wb.defined_names.add(DefinedName("AuditRange", attr_text="'Audit'!$A$2:$A$3"))
audit_ws.add_table(Table(displayName="AuditTable", ref="A1:A3"))
audit_ws.merge_cells("B2:B3")
audit_ws.auto_filter.ref = "A1:A3"
audit_ws.print_area = "A1:B3"
audit_ws.print_title_rows = "1:1"
audit_ws.print_title_cols = "A:A"
validation = DataValidation(type="whole", formula1="'Audit'!$A$2")
validation.add("A2:A3")
audit_ws.add_data_validation(validation)
audit_ws.conditional_formatting.add("A2:A3", FormulaRule(formula=["A2>0"]))
chart = BarChart()
chart.add_data(Reference(audit_ws, min_col=1, min_row=1, max_row=3), titles_from_data=True)
audit_ws.add_chart(chart, "C1")
with open("anchor.png", "wb") as stream:
    stream.write(base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlRYAAAAASUVORK5CYII="
    ))
audit_ws.add_image(Image("anchor.png"), "E5")
audit_references = structural_references(audit_wb)
reference_kinds = {kind for kind, _, _ in audit_references}
formula_references = cell_formula_references(audit_wb)
check(
    "structural audit covers names, tables, filters, validation, formatting, and charts",
    {"defined name", "cell formula", "table", "merged range", "auto filter", "print area",
     "print title rows", "print title columns", "data validation range",
     "data validation formula", "conditional formatting range",
     "conditional formatting formula", "chart series", "drawing anchor"} <= reference_kinds,
    reference_kinds,
)
check("drawing audit records an image anchored at the insertion row",
      ("drawing anchor", "Audit image 1", (5,)) in audit_references, audit_references)
check(
    "structural audit snapshots ordinary cell formulas before row insertion",
    formula_references == [("cell formula", "Audit", "C1", "=SUM(A2:A3)")],
    formula_references,
)
check("intersecting formula ranges are blocked before row insertion",
      formula_may_intersect_rows("Audit", "=SUM(A2:A3)", "Audit", 3))
check("audited formula ranges above the insertion can proceed",
      not formula_may_intersect_rows("Data", "=C2*1.08", "Data", 5))
check("sheet qualifiers are matched case-insensitively",
      formula_may_intersect_rows("Summary", "=SUM(data!A5:A6)", "Data", 5))
check("a genuinely different sheet remains outside the shifted rows",
      not formula_may_intersect_rows("Summary", "=SUM(Archive!A5:A6)", "Data", 5))
check("INDIRECT string references require a manual structural rewrite plan",
      formula_may_intersect_rows("Data", '=SUM(INDIRECT("A5:A6"))', "Data", 5))
check("OFFSET numeric row references require a manual structural rewrite plan",
      formula_may_intersect_rows("Data", "=SUM(OFFSET(A1,4,0,2,1))", "Data", 5))
check("implicit-intersection INDIRECT references require a manual rewrite plan",
      formula_may_intersect_rows("Data", '=@INDIRECT("A5:A6")', "Data", 5))
check("OFFSET used by the range operator requires a manual rewrite plan",
      formula_may_intersect_rows("Data", "=SUM(A1:OFFSET(A1,5,0))", "Data", 5))
check("INDIRECT text inside a string does not create a dynamic reference",
      not formula_may_intersect_rows(
          "Data", '=IF(A1="INDIRECT(A5:A6)",1,0)', "Data", 5
      ))

stale_wb = openpyxl.Workbook()
stale_ws = stale_wb.active
stale_ws["A5"], stale_ws["A6"] = 10, 20
stale_ws["B1"] = "=SUM(A5:A6)"
stale_formula_before = cell_formula_references(stale_wb)
stale_ws.insert_rows(5)
check(
    "insert_rows leaves intersecting formulas stale (negative control)",
    stale_formula_before == [("cell formula", "Sheet", "B1", "=SUM(A5:A6)")]
    and stale_ws["B1"].value == "=SUM(A5:A6)"
    and (stale_ws["A6"].value, stale_ws["A7"].value) == (10, 20),
    (stale_formula_before, stale_ws["B1"].value),
)

safe_wb = openpyxl.Workbook()
safe_ws = safe_wb.active
safe_ws.title = "Data"
safe_ws["C2"], safe_ws["D2"] = 100, "=C2*1.08"
safe_before = cell_formula_references(safe_wb)
safe_dependencies = [
    reference for reference in safe_before
    if formula_may_intersect_rows(reference[1], reference[3], "Data", 5)
]
if not safe_dependencies:
    safe_ws.insert_rows(5)
    safe_wb.calculation.fullCalcOnLoad = True
    safe_wb.calculation.forceFullCalc = True
    safe_wb.calculation.calcMode = "auto"
    safe_wb.save("audited-structural-edit.xlsx")
safe_reopened = openpyxl.load_workbook("audited-structural-edit.xlsx", data_only=False)
check("audited non-intersecting formula path reaches save",
      safe_reopened["Data"]["D2"].value == "=C2*1.08")
check("formula edit forces recalculation after save",
      safe_reopened.calculation.fullCalcOnLoad is True
      and safe_reopened.calculation.calcMode == "auto")

legacy_name = DefinedName("LegacyName", attr_text="Audit!$A$1")
legacy_names = type("LegacyDefinedNames", (), {"definedName": [legacy_name]})()
legacy_workbook = type("LegacyWorkbook", (), {"defined_names": legacy_names})()
check("defined-name adapter supports openpyxl 3.0 collections",
      list(defined_name_values(legacy_workbook)) == [legacy_name])

formula_only = openpyxl.Workbook()
formula_only.active["A1"] = "=Data!A5"
check("structural guard sees formulas before row insertion",
      structural_references(formula_only)
      == [("cell formula", "Sheet!A1", "=Data!A5")],
      structural_references(formula_only))

audited_wb = openpyxl.Workbook()
audited_ws = audited_wb.active
audited_ws.title = "Data"
audited_ws["B2"] = "=A2*2"
audited_ws["A5"] = "shift me"
audited_references_before = structural_references(audited_wb)
audited_unchanged = {("cell formula", "Data!B2", "=A2*2")}
unaudited_references = [
    reference for reference in audited_references_before
    if reference not in audited_unchanged
]
if not unaudited_references:
    audited_ws.insert_rows(5)
    audited_ws["D2"] = "=C2*1.08"
    audited_wb.save("audited-edit.xlsx")
audited_reopened = openpyxl.load_workbook("audited-edit.xlsx", data_only=False)
check("exact dependency allowlist lets an audited edit reach save",
      audited_references_before == [("cell formula", "Data!B2", "=A2*2")]
      and unaudited_references == []
      and audited_reopened["Data"]["A6"].value == "shift me"
      and audited_reopened["Data"]["B2"].value == "=A2*2"
      and audited_reopened["Data"]["D2"].value == "=C2*1.08")

unsafe_wb = openpyxl.Workbook()
unsafe_ws = unsafe_wb.active
unsafe_ws.title = "Data"
unsafe_ws["A5"], unsafe_ws["A6"] = 10, 20
unsafe_ws["B1"] = "=SUM(A5:A6)"
unsafe_dependencies = [
    reference for reference in structural_references(unsafe_wb)
    if reference not in audited_unchanged
]
unsafe_blocked_before_insert = bool(unsafe_dependencies)
check("intersecting formula not on the exact allowlist is blocked before insertion",
      unsafe_blocked_before_insert
      and unsafe_ws["A5"].value == 10 and unsafe_ws["A6"].value == 20,
      unsafe_dependencies)

# and the edit itself still works after the warning path
wb2 = openpyxl.load_workbook("plain.xlsx")
wb2["Data"]["B2"] = "=B2*1"  # formula stays a formula
wb2["Data"]["B2"].number_format = "#,##0.00"
wb2.save("edited.xlsx")
wb3 = openpyxl.load_workbook("edited.xlsx")
check("edited cell keeps a formula string", isinstance(wb3["Data"]["B2"].value, str) and wb3["Data"]["B2"].value.startswith("="))
expected_number_formats = {"Data": {"B2": "#,##0.00"}}
format_matches = all(
    wb3[sheet][coordinate].number_format == expected
    for sheet, cells in expected_number_formats.items()
    for coordinate, expected in cells.items()
)
check("task-specific number format mapping is verified", format_matches)

# ---- read.md snippet: multi-sheet profiles cover every sheet ----------------------
import posixpath
from openpyxl.worksheet.formula import ArrayFormula, DataTableFormula

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CELL_TAG = f"{{{MAIN_NS}}}c"
FORMULA_TAG = f"{{{MAIN_NS}}}f"
VALUE_TAG = f"{{{MAIN_NS}}}v"

wb_h = openpyxl.Workbook()
wb_h.active.title = "First"
wb_h.active["A1"] = "=1+1"
wb_h.active["A2"] = ArrayFormula("A2:A3", "=ROW(A2:A3)")
wb_h.active["C1"] = "=literal"
wb_h.active["C1"].data_type = "s"
wb_h.active["D1"] = "+literal"
wb_h.active["E1"] = "-literal"
wb_h.active["F1"] = "@literal"
second = wb_h.create_sheet("Second")
second["A1"] = "plain"
second["A2"] = "=2+2"
second["B1"] = DataTableFormula(ref="B1:B2", r1="C1")
wb_h.save("multi.xlsx")
# openpyxl writes an empty <v/> for uncached formulas. Remove those elements explicitly so
# this fixture represents a truly absent cache rather than a cached displayed blank.
with zipfile.ZipFile("multi.xlsx") as archive:
    multi_members = {name: archive.read(name) for name in archive.namelist()}
for name in [item for item in multi_members if item.startswith("xl/worksheets/")
             and item.endswith(".xml")]:
    root = ET.fromstring(multi_members[name])
    for cell in root.iter(CELL_TAG):
        if cell.find(FORMULA_TAG) is not None:
            cached_value = cell.find(VALUE_TAG)
            if cached_value is not None:
                cell.remove(cached_value)
    multi_members[name] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
with zipfile.ZipFile("multi.xlsx", "w", zipfile.ZIP_DEFLATED) as archive:
    for name, data in multi_members.items():
        archive.writestr(name, data)
formula_wb = openpyxl.load_workbook("multi.xlsx", read_only=True, data_only=False)
value_wb = openpyxl.load_workbook("multi.xlsx", read_only=True, data_only=True)
profiled = list(value_wb.sheetnames)
uncached = {(sn, fc.coordinate, formula_text(fc.value))
            for sn in profiled
            for frow, vrow in zip(formula_wb[sn].iter_rows(), value_wb[sn].iter_rows())
            for fc, vc in zip(frow, vrow)
            if fc.data_type == "f" and vc.value is None}
check("multi-sheet profile iterates every sheet", profiled == ["First", "Second"], profiled)
check("uncached formulas found on both sheets", {item[0] for item in uncached} == {"First", "Second"}, uncached)
check("array-formula objects are detected by data_type", ("First", "A2", "=ROW(A2:A3)") in uncached, uncached)
data_table_entry = next(item for item in uncached if item[:2] == ("Second", "B1"))
check("data-table formulas have stable diagnostic text",
      data_table_entry[2].startswith("DataTableFormula(ref='B1:B2', r1='C1'")
      and "0x" not in data_table_entry[2], data_table_entry)
formula_wb.close()
value_wb.close()

# csv.md: value export uses the cached-value workbook and reports every missing cache.
def worksheet_part(archive, sheet_name):
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    sheet = next(
        item for item in workbook.iter(f"{{{MAIN_NS}}}sheet")
        if item.attrib["name"] == sheet_name
    )
    relationship_id = sheet.attrib[f"{{{DOC_REL_NS}}}id"]
    relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    target = next(
        item.attrib["Target"] for item in relationships.iter(f"{{{PKG_REL_NS}}}Relationship")
        if item.attrib["Id"] == relationship_id
    )
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join("xl", target))


def cached_formula_coordinates(archive, part):
    cached = set()
    coordinate = None
    cell_type = None
    has_formula = value_seen = False
    value_text = None
    with archive.open(part) as source:
        for event, element in ET.iterparse(source, events=("start", "end")):
            if event == "start" and element.tag == CELL_TAG:
                coordinate = element.attrib["r"]
                cell_type = element.attrib.get("t")
                has_formula = value_seen = False
                value_text = None
            elif event == "end" and coordinate is not None:
                if element.tag == FORMULA_TAG:
                    has_formula = True
                elif element.tag == VALUE_TAG:
                    value_seen = True
                    value_text = element.text
                elif element.tag == CELL_TAG:
                    valid_cache = value_seen and (
                        value_text not in (None, "") or cell_type == "str"
                    )
                    if has_formula and valid_cache:
                        cached.add(coordinate)
                    coordinate = None
                element.clear()
            elif event == "end":
                element.clear()
    return cached


with zipfile.ZipFile("multi.xlsx") as archive:
    multi_part = worksheet_part(archive, "First")
    cached_formula_cells = cached_formula_coordinates(archive, multi_part)
formula_wb = openpyxl.load_workbook("multi.xlsx", read_only=True, data_only=False)
value_wb = openpyxl.load_workbook("multi.xlsx", read_only=True, data_only=True)
formula_ws, value_ws = formula_wb["First"], value_wb["First"]
formula_ws.reset_dimensions()
value_ws.reset_dimensions()
missing_caches = []
export_mode = "safe"
with open("formula-values.csv", "w", newline="", encoding="utf-8") as output:
    writer = csv.writer(output)
    for formula_row, value_row in zip(formula_ws.iter_rows(), value_ws.iter_rows()):
        for formula_cell, value_cell in zip(formula_row, value_row):
            if (formula_cell.data_type == "f" and value_cell.value is None
                    and formula_cell.coordinate not in cached_formula_cells):
                missing_caches.append(formula_cell.coordinate)
        writer.writerow([
            spreadsheet_csv_field(cell.value, mode=export_mode) for cell in value_row
        ])
with open("formula-values.csv", newline="", encoding="utf-8") as exported:
    exported_values = [value for row in csv.reader(exported) for value in row]
check("XLSX-to-CSV reports formulas with no cached value", set(missing_caches) >= {"A1", "A2"}, missing_caches)
check("XLSX-to-CSV does not leak formula strings into value output",
      not any(value.startswith("=") for value in exported_values), exported_values)
check("XLSX-to-CSV safe mode neutralizes cached literal text for spreadsheet consumers",
      {"'=literal", "'+literal", "'-literal", "'@literal"} <= set(exported_values),
      exported_values)
formula_wb.close()
value_wb.close()


def write_formula_cache_fixture(path, cache_kind):
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Data"
    sheet["A1"] = ('=IF(TRUE,"","x")' if cache_kind == "empty-string" else "=1+1")
    workbook.save(path)
    with zipfile.ZipFile(path) as archive:
        members = {name: archive.read(name) for name in archive.namelist()}
    root = ET.fromstring(members["xl/worksheets/sheet1.xml"])
    cell = next(item for item in root.iter(CELL_TAG) if item.attrib["r"] == "A1")
    cached_value = cell.find(VALUE_TAG)
    if cache_kind == "nonempty":
        cell.attrib.pop("t", None)
        if cached_value is None:
            cached_value = ET.SubElement(cell, VALUE_TAG)
        cached_value.text = "2"
    elif cache_kind == "empty-string":
        cell.set("t", "str")
        if cached_value is None:
            cached_value = ET.SubElement(cell, VALUE_TAG)
        cached_value.text = None
    elif cache_kind == "bare-empty":
        cell.attrib.pop("t", None)
        if cached_value is None:
            cached_value = ET.SubElement(cell, VALUE_TAG)
        cached_value.text = None
    elif cache_kind == "absent":
        cell.attrib.pop("t", None)
        if cached_value is not None:
            cell.remove(cached_value)
    else:
        raise ValueError(cache_kind)
    members["xl/worksheets/sheet1.xml"] = ET.tostring(
        root, encoding="utf-8", xml_declaration=True,
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in members.items():
            archive.writestr(name, data)


def export_formula_values(source_path, output_path):
    sheet_name = "Data"
    with zipfile.ZipFile(source_path) as archive:
        part = worksheet_part(archive, sheet_name)
        cached_cells = cached_formula_coordinates(archive, part)
    formula_book = openpyxl.load_workbook(source_path, read_only=True, data_only=False)
    value_book = openpyxl.load_workbook(source_path, read_only=True, data_only=True)
    formula_sheet, value_sheet = formula_book[sheet_name], value_book[sheet_name]
    formula_sheet.reset_dimensions()
    value_sheet.reset_dimensions()
    missing = []
    destination = Path(output_path)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    with temporary.open("w", newline="", encoding="utf-8") as output:
        writer = csv.writer(output)
        for formula_row, value_row in zip(formula_sheet.iter_rows(), value_sheet.iter_rows()):
            for formula_cell, value_cell in zip(formula_row, value_row):
                if (formula_cell.data_type == "f" and value_cell.value is None
                        and formula_cell.coordinate not in cached_cells):
                    missing.append(formula_cell.coordinate)
            writer.writerow([spreadsheet_csv_field(cell.value) for cell in value_row])
    formula_book.close()
    value_book.close()
    if missing:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"formula cells have no cached value: {missing}")
    temporary.replace(destination)


write_formula_cache_fixture("cached-value.xlsx", "nonempty")
write_formula_cache_fixture("cached-empty.xlsx", "empty-string")
write_formula_cache_fixture("bare-empty-cache.xlsx", "bare-empty")
write_formula_cache_fixture("missing-cache.xlsx", "absent")
with zipfile.ZipFile("cached-value.xlsx") as archive:
    cached_value_cells = cached_formula_coordinates(archive, worksheet_part(archive, "Data"))
with zipfile.ZipFile("cached-empty.xlsx") as archive:
    cached_empty_cells = cached_formula_coordinates(archive, worksheet_part(archive, "Data"))
with zipfile.ZipFile("bare-empty-cache.xlsx") as archive:
    bare_empty_cells = cached_formula_coordinates(archive, worksheet_part(archive, "Data"))
with zipfile.ZipFile("missing-cache.xlsx") as archive:
    truly_missing_cells = cached_formula_coordinates(archive, worksheet_part(archive, "Data"))
check("XML cache inventory accepts nonempty and typed empty-string caches",
      cached_value_cells == cached_empty_cells == {"A1"},
      (cached_value_cells, cached_empty_cells))
check("XML cache inventory rejects bare empty <v/> and an absent cache",
      bare_empty_cells == truly_missing_cells == set(),
      (bare_empty_cells, truly_missing_cells))


def profile_missing_formula_caches(source_path):
    with zipfile.ZipFile(source_path) as archive:
        cached_cells = cached_formula_coordinates(archive, worksheet_part(archive, "Data"))
    formula_book = openpyxl.load_workbook(source_path, read_only=True, data_only=False)
    value_book = openpyxl.load_workbook(source_path, read_only=True, data_only=True)
    formula_sheet, value_sheet = formula_book["Data"], value_book["Data"]
    formula_sheet.reset_dimensions()
    value_sheet.reset_dimensions()
    missing = [
        formula_cell.coordinate
        for formula_row, value_row in zip(formula_sheet.iter_rows(), value_sheet.iter_rows())
        for formula_cell, value_cell in zip(formula_row, value_row)
        if (formula_cell.data_type == "f" and value_cell.value is None
            and formula_cell.coordinate not in cached_cells)
    ]
    formula_book.close()
    value_book.close()
    return missing


check("workbook profiling accepts nonempty and typed blank formula caches",
      profile_missing_formula_caches("cached-value.xlsx") == []
      and profile_missing_formula_caches("cached-empty.xlsx") == [])
check("workbook profiling reports absent and untyped empty formula caches",
      profile_missing_formula_caches("missing-cache.xlsx") == ["A1"]
      and profile_missing_formula_caches("bare-empty-cache.xlsx") == ["A1"])


def write_region_key_fixture(path, cache_kind):
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Data"
    sheet.append(["Region", "Units", "Revenue", "Source Region"])
    sheet.append(["=D2", 2, 4, "EU"])
    workbook.save(path)
    with zipfile.ZipFile(path) as archive:
        members = {name: archive.read(name) for name in archive.namelist()}
    root = ET.fromstring(members["xl/worksheets/sheet1.xml"])
    cell = next(item for item in root.iter(CELL_TAG) if item.attrib["r"] == "A2")
    value = cell.find(VALUE_TAG)
    if cache_kind == "nonempty":
        cell.set("t", "str")
        if value is None:
            value = ET.SubElement(cell, VALUE_TAG)
        value.text = "EU"
    elif cache_kind == "empty-string":
        cell.set("t", "str")
        if value is None:
            value = ET.SubElement(cell, VALUE_TAG)
        value.text = None
    elif cache_kind == "absent":
        cell.attrib.pop("t", None)
        if value is not None:
            cell.remove(value)
    else:
        raise ValueError(cache_kind)
    members["xl/worksheets/sheet1.xml"] = ET.tostring(
        root, encoding="utf-8", xml_declaration=True,
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in members.items():
            archive.writestr(name, data)


def aggregation_regions(source_path):
    formula_book = openpyxl.load_workbook(source_path, data_only=False)
    source_sheet = formula_book["Data"]
    with zipfile.ZipFile(source_path) as archive:
        cached_cells = cached_formula_coordinates(archive, worksheet_part(archive, "Data"))
    value_book = openpyxl.load_workbook(source_path, read_only=True, data_only=True)
    value_sheet = value_book["Data"]
    value_sheet.reset_dimensions()
    regions = []
    missing = []
    for source_row, value_row in zip(
        source_sheet.iter_rows(min_row=2, min_col=1, max_col=1),
        value_sheet.iter_rows(min_row=2, min_col=1, max_col=1),
    ):
        source_cell, value_cell = source_row[0], value_row[0]
        region = value_cell.value if source_cell.data_type == "f" else source_cell.value
        if (source_cell.data_type == "f" and region is None
                and source_cell.coordinate not in cached_cells):
            missing.append(source_cell.coordinate)
            continue
        if region is not None and region != "":
            regions.append(region)
    value_book.close()
    formula_book.close()
    if missing:
        raise RuntimeError(f"aggregation keys have no cached value: {missing}")
    return regions


write_region_key_fixture("region-key-cached.xlsx", "nonempty")
write_region_key_fixture("region-key-empty.xlsx", "empty-string")
write_region_key_fixture("region-key-missing.xlsx", "absent")
cached_regions = aggregation_regions("region-key-cached.xlsx")
aggregate_book = openpyxl.Workbook()
aggregate_book.active["A1"] = cached_regions[0]
check("formula-backed aggregation key is copied from its cached displayed value",
      aggregate_book.active["A1"].value == "EU"
      and aggregate_book.active["A1"].data_type != "f")
check("typed cached blank aggregation keys are skipped",
      aggregation_regions("region-key-empty.xlsx") == [])
try:
    aggregation_regions("region-key-missing.xlsx")
    missing_region_cache_rejected = False
except RuntimeError as error:
    missing_region_cache_rejected = "A2" in str(error)
check("aggregation fails closed when a formula key has no cached value",
      missing_region_cache_rejected)

export_formula_values("cached-value.xlsx", "cached-value.csv")
with open("cached-value.csv", newline="", encoding="utf-8") as exported:
    cached_value_rows = list(csv.reader(exported))
check("nonempty cached formula result exports its displayed value",
      cached_value_rows == [["2"]], cached_value_rows)
export_formula_values("cached-empty.xlsx", "cached-empty.csv")
with open("cached-empty.csv", newline="", encoding="utf-8") as exported:
    cached_empty_rows = list(csv.reader(exported))
check("cached empty-string formula result exports as a displayed blank",
      cached_empty_rows == [[""]], cached_empty_rows)
Path("missing-cache.csv").write_text("sentinel\n", encoding="utf-8")
try:
    export_formula_values("missing-cache.xlsx", "missing-cache.csv")
    missing_cache_rejected = False
except RuntimeError as error:
    missing_cache_rejected = "A1" in str(error)
check("formula with no XML cache element is rejected", missing_cache_rejected)
check("failed cache audit preserves the prior destination and removes its temporary file",
      Path("missing-cache.csv").read_text(encoding="utf-8") == "sentinel\n"
      and not Path("missing-cache.csv.tmp").exists())
Path("bare-empty-cache.csv").write_text("sentinel\n", encoding="utf-8")
try:
    export_formula_values("bare-empty-cache.xlsx", "bare-empty-cache.csv")
    bare_empty_rejected = False
except RuntimeError as error:
    bare_empty_rejected = "A1" in str(error)
check("untyped bare empty <v/> from an uncalculated formula is rejected",
      bare_empty_rejected)
check("bare-empty rejection preserves destination and removes temporary output",
      Path("bare-empty-cache.csv").read_text(encoding="utf-8") == "sentinel\n"
      and not Path("bare-empty-cache.csv.tmp").exists())

# SKILL.md contract: fullCalcOnLoad makes viewers recalculate even in manual calc mode.
calc_wb = openpyxl.Workbook()
calc_ws = calc_wb.active
calc_ws["A1"] = 1
calc_ws["A2"] = 2
calc_ws["A3"] = "=SUM(A1:A2)"
calc_wb.calculation.calcMode = "manual"
calc_wb.calculation.fullCalcOnLoad = False  # simulate a source that does not recalc on load
calc_wb.save("stale-calc.xlsx")
stale_reopened = openpyxl.load_workbook("stale-calc.xlsx")
check("workbook without fullCalcOnLoad round-trips the stale flag (negative control)",
      not bool(getattr(stale_reopened.calculation, "fullCalcOnLoad", False)),
      stale_reopened.calculation)
stale_reopened.calculation.fullCalcOnLoad = True
stale_reopened.save("manual-calc.xlsx")
calc_reopened = openpyxl.load_workbook("manual-calc.xlsx")
check("fullCalcOnLoad survives save/reload",
      bool(getattr(calc_reopened.calculation, "fullCalcOnLoad", False)),
      calc_reopened.calculation)
check("manual calc mode survives save/reload",
      getattr(calc_reopened.calculation, "calcMode", None) == "manual",
      calc_reopened.calculation)
check("reloaded formula cell still holds the formula string",
      calc_reopened.active["A3"].value == "=SUM(A1:A2)", calc_reopened.active["A3"].value)
calc_reopened.close()

# ---- SKILL.md postcheck: formula inventory stays sparse at worksheet limits ----
formula_bound_wb = openpyxl.Workbook()
formula_bound_ws = formula_bound_wb.active
formula_bound_ws["D2"] = "=1+1"
formula_bound_ws["XFD1048576"].number_format = "0.00"  # styled but empty extreme cell
formula_bound_wb.save("formula-bound.xlsx")
formula_bound_reopened = openpyxl.load_workbook("formula-bound.xlsx", data_only=False)
formula_bound_ws = formula_bound_reopened.active


def expected_formula_inventory(sheet, expected):
    actual = {}
    for coordinate, expected_formula in expected.items():
        cell = sheet[coordinate]
        actual_formula = formula_text(cell.value) if cell.data_type == "f" else None
        if actual_formula != expected_formula:
            raise ValueError(
                f"{coordinate}: expected {expected_formula!r}, got {actual_formula!r}"
            )
        actual[coordinate] = actual_formula
    return actual


check("extreme styled cell inflates the rectangular worksheet bounds (negative control)",
      formula_bound_ws.max_row == 1_048_576 and formula_bound_ws.max_column == 16_384,
      (formula_bound_ws.max_row, formula_bound_ws.max_column))
original_iter_rows = formula_bound_ws.iter_rows
formula_bound_ws.iter_rows = lambda *args, **kwargs: (_ for _ in ()).throw(
    RuntimeError("unbounded iter_rows must not run")
)
try:
    bounded_formulas = expected_formula_inventory(formula_bound_ws, {"D2": "=1+1"})
finally:
    formula_bound_ws.iter_rows = original_iter_rows
check("formula postcheck uses bounded public coordinate lookups",
      bounded_formulas == {"D2": "=1+1"}, bounded_formulas)
formula_bound_reopened.close()


# ---- edit.md snippet: extension detection is prefix-independent ------------------
X14_URI = b"http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"
MC_URI = b"http://schemas.openxmlformats.org/markup-compatibility/2006"
EXTENSION_MARKERS = {
    "extLst": b"extLst",
    "x14 namespace": X14_URI,
    "markup compatibility": MC_URI,
}

def markers_in(data):
    return {label for label, marker in EXTENSION_MARKERS.items() if marker in data}

custom_prefix_sheet = (
    b'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    b'xmlns:sx="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" '
    b'xmlns:ooo="http://schemas.openxmlformats.org/markup-compatibility/2006">'
    b'<ooo:AlternateContent><sx:extLst/></ooo:AlternateContent></worksheet>'
)
found = markers_in(custom_prefix_sheet)
check("namespace markers detect custom-prefix x14 extensions", "x14 namespace" in found, found)
check("namespace markers detect custom-prefix markup compatibility", "markup compatibility" in found, found)
check("local-name marker detects any-prefix extLst", "extLst" in found, found)
legacy_prefix_markers = {b"x14:", b"mc:AlternateContent"}
check("prefix markers are provably blind to custom prefixes (negative control)",
      not any(marker in custom_prefix_sheet for marker in legacy_prefix_markers))

# ---- formatting.md guard: header-only sheets skip conditional formatting ---------
def last_populated_row(sheet, *, first_data_row=2, min_col=1, max_col=6):
    populated_rows = (
        cell.row for cell in sheet._cells.values()
        if first_data_row <= cell.row
        and min_col <= cell.column <= max_col
        and cell.value is not None
    )
    return max(populated_rows, default=first_data_row - 1)


def add_demo_formatting(sheet):
    last = last_populated_row(sheet)
    if last < 2:
        return 0
    sheet.conditional_formatting.add(
        f"D2:D{last}", CellIsRule(operator="lessThan", formula=["0"]),
    )
    sheet.conditional_formatting.add(
        f"A2:F{last}", FormulaRule(formula=["$D2<0"]),
    )
    sheet.conditional_formatting.add(
        f"C2:C{last}",
        ColorScaleRule(start_type="min", start_color="FFFFFF",
                       end_type="max", end_color="63BE7B"),
    )
    sheet.conditional_formatting.add(
        f"E2:E{last}", DataBarRule(start_type="min", end_type="max", color="638EC6"),
    )
    return 4


header_wb = openpyxl.Workbook()
header_ws = header_wb.active
header_ws.append(["A", "B", "C", "D", "E", "F"])
header_ws["F100"].number_format = "0.00"  # styled empty cell inflates max_row
try:
    header_ws.conditional_formatting.add(
        "D2:D1", CellIsRule(operator="lessThan", formula=["0"]),
    )
    inverted_range_rejected = False
except (TypeError, ValueError):
    inverted_range_rejected = True
check("unguarded header-only range is rejected (negative control)", inverted_range_rejected)
check("style-only ghost row inflates max_row (negative control)", header_ws.max_row == 100)
check("populated-row scan ignores a style-only ghost row", last_populated_row(header_ws) == 1)
check("header-only guard skips all four formatting rules", add_demo_formatting(header_ws) == 0)
header_wb.save("header-only-formatting.xlsx")
header_reopened = openpyxl.load_workbook("header-only-formatting.xlsx")
check("header-only workbook saves and reopens with no conditional formatting",
      len(header_reopened.active.conditional_formatting) == 0)

data_wb = openpyxl.Workbook()
data_ws = data_wb.active
data_ws.append(["A", "B", "C", "D", "E", "F"])
data_ws.append([1, 2, 3, -1, 5, 6])
data_ws["F100"].number_format = "0.00"
check("data rows receive all four formatting rules", add_demo_formatting(data_ws) == 4)
data_ranges = {str(item.sqref) for item in data_ws.conditional_formatting}
check("conditional formatting stops at the last populated row despite ghost styles",
      data_ranges == {"D2", "A2:F2", "C2", "E2"}, data_ranges)
data_wb.save("data-formatting.xlsx")
data_reopened = openpyxl.load_workbook("data-formatting.xlsx")
check("all four formatting rules survive save/reopen",
      len(data_reopened.active.conditional_formatting) == 4)


# ---- read.md: implausible <dimension> is reset before streaming ------------------
dim_wb = openpyxl.Workbook()
dim_ws = dim_wb.active
dim_ws.append(["h1", "h2"])
dim_ws.append([1, 2])
dim_ws.append([3, 4])
dim_ws["C4"] = "=SUM(A2:B3)"
dim_wb.save("dimension.xlsx")
# Corrupt the sheet's dimension metadata the way non-Excel producers do.
import zipfile as dim_zip
with dim_zip.ZipFile("dimension.xlsx") as archive:
    members = {name: archive.read(name) for name in archive.namelist()}
members["xl/worksheets/sheet1.xml"] = members["xl/worksheets/sheet1.xml"].replace(
    b"<dimension ref=\"A1:C4\"/>", b"<dimension ref=\"A1:B2\"/>"
)
with dim_zip.ZipFile("dimension.xlsx", "w") as archive:
    for name, data in members.items():
        archive.writestr(name, data)

from openpyxl.utils import get_column_letter


def discover_dimension(worksheet):
    worksheet.reset_dimensions()
    min_row = min_column = max_row = max_column = None
    for row in worksheet.iter_rows():
        for cell in row:
            if getattr(cell, "value", None) is None and getattr(cell, "data_type", None) != "f":
                continue
            row_index = getattr(cell, "row", None)
            column_index = getattr(cell, "column", None)
            if row_index is None or column_index is None:
                continue
            min_row = row_index if min_row is None else min(min_row, row_index)
            min_column = column_index if min_column is None else min(min_column, column_index)
            max_row = row_index if max_row is None else max(max_row, row_index)
            max_column = column_index if max_column is None else max(max_column, column_index)
    if max_row is None:
        return "A1:A1", None
    extent = (f"{get_column_letter(min_column)}{min_row}:"
              f"{get_column_letter(max_column)}{max_row}")
    return extent, min_row


dim_value = openpyxl.load_workbook("dimension.xlsx", read_only=True, data_only=True)
dim_formula = openpyxl.load_workbook("dimension.xlsx", read_only=True, data_only=False)
dim_ws_ro = dim_value.active
check("plausible but truncated dimension limits streaming (negative control)",
      dim_ws_ro.calculate_dimension() == "A1:B2" and dim_ws_ro.max_row == 2,
      (dim_ws_ro.calculate_dimension(), dim_ws_ro.max_row))
streamed_before_reset = [row for row in dim_ws_ro.iter_rows(values_only=True)]
discovered_value_dimension, discovered_value_first_row = discover_dimension(dim_ws_ro)
discovered_formula_dimension, discovered_formula_first_row = discover_dimension(dim_formula.active)
streamed_after_reset = [row for row in dim_ws_ro.iter_rows(values_only=True)]
dim_value.close()
dim_formula.close()
check("formula-preserving dimension scan retains uncached formulas in the logical range",
      discovered_formula_dimension == "A1:C4"
      and discovered_formula_first_row == 1
      and discovered_value_dimension == "A1:B3"
      and discovered_value_first_row == 1,
      ((discovered_value_dimension, discovered_value_first_row),
       (discovered_formula_dimension, discovered_formula_first_row)))
check("reset_dimensions restores the real extent",
      len(streamed_before_reset) == 2
      and len(streamed_after_reset) == 4
      and streamed_after_reset[2][:2] == (3, 4),
      (len(streamed_before_reset), streamed_after_reset[-1]))

csv_formula_wb = openpyxl.load_workbook("dimension.xlsx", read_only=True, data_only=False)
csv_value_wb = openpyxl.load_workbook("dimension.xlsx", read_only=True, data_only=True)
csv_formula_ws, csv_value_ws = csv_formula_wb.active, csv_value_wb.active
check("both CSV source streams initially trust the truncated dimension (negative control)",
      csv_formula_ws.calculate_dimension() == "A1:B2"
      and csv_value_ws.calculate_dimension() == "A1:B2")
csv_formula_ws.reset_dimensions()
csv_value_ws.reset_dimensions()
csv_stream_rows = list(zip(csv_formula_ws.iter_rows(), csv_value_ws.iter_rows()))
check("CSV export resets both paired streams before iterating",
      len(csv_stream_rows) == 4
      and len(csv_stream_rows[-1][0]) == 3
      and len(csv_stream_rows[-1][1]) == 3
      and csv_stream_rows[-1][0][2].data_type == "f"
      and csv_stream_rows[-1][1][2].value is None,
      [(len(formula_row), len(value_row)) for formula_row, value_row in csv_stream_rows])
csv_formula_wb.close()
csv_value_wb.close()

offset_wb = openpyxl.Workbook()
offset_ws = offset_wb.active
offset_ws["A7"], offset_ws["B7"] = "Region", "Units"
offset_ws["A8"], offset_ws["B8"] = "EU", 120
offset_ws["A2"].number_format = "0.00"  # styled but empty: not part of the data range
offset_ws["C8"] = "=SUM(B8)"            # uncached formula: remains part of the range
offset_wb.save("leading-blank-rows.xlsx")
offset_formula_wb = openpyxl.load_workbook(
    "leading-blank-rows.xlsx", read_only=True, data_only=False,
)
offset_value_wb = openpyxl.load_workbook(
    "leading-blank-rows.xlsx", read_only=True, data_only=True,
)
offset_formula_extent, offset_formula_first = discover_dimension(offset_formula_wb.active)
offset_value_wb.active.reset_dimensions()
offset_rows = offset_value_wb.active.iter_rows(
    min_row=offset_formula_first, values_only=True,
)
offset_header = next(offset_rows, None)
offset_sample = next(offset_rows, None)
check("styled empty cells do not move the formula-preserving logical range",
      (offset_formula_extent, offset_formula_first) == ("A7:C8", 7),
      (offset_formula_extent, offset_formula_first))
check("header sampling skips six leading blank rows",
      offset_header[:2] == ("Region", "Units")
      and offset_sample[:2] == ("EU", 120),
      (offset_header, offset_sample))
offset_formula_wb.close()
offset_value_wb.close()

empty_dimension_wb = openpyxl.Workbook()
empty_dimension_wb.save("empty-dimension.xlsx")
empty_dimension_ro = openpyxl.load_workbook("empty-dimension.xlsx", read_only=True)
check("dimension scan handles an actually empty worksheet",
      discover_dimension(empty_dimension_ro.active) == ("A1:A1", None))
empty_dimension_ro.close()


print("\n" + ("ALL XLSX FIXTURES PASSED" if not failures else f"{len(failures)} FAILURES: {failures}"))
sys.exit(0 if not failures else 1)
