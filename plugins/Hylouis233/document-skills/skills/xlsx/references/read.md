# Read / profile a workbook

```python
import openpyxl
import posixpath
import zipfile
from openpyxl.utils import get_column_letter
from xml.etree import ElementTree as ET

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CELL_TAG = f"{{{MAIN_NS}}}c"
FORMULA_TAG = f"{{{MAIN_NS}}}f"
VALUE_TAG = f"{{{MAIN_NS}}}v"

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
    return target.lstrip("/") if target.startswith("/") else posixpath.normpath(
        posixpath.join("xl", target)
    )

def cached_formula_coordinates(archive, part):
    """Find nonempty caches plus explicitly typed empty-string caches."""
    cached = set()
    coordinate = cell_type = value_text = None
    has_formula = value_seen = False
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

input_path = "input.xlsx"
formula_wb = openpyxl.load_workbook(input_path, read_only=True, data_only=False)
value_wb = openpyxl.load_workbook(input_path, read_only=True, data_only=True)
with zipfile.ZipFile(input_path) as archive:
    cached_formulas = {
        sheet_name: cached_formula_coordinates(archive, worksheet_part(archive, sheet_name))
        for sheet_name in formula_wb.sheetnames
    }
print("sheets:", value_wb.sheetnames)

def formula_text(value):
    if isinstance(value, str):
        return value
    if text := getattr(value, "text", None):       # ArrayFormula
        return text
    # DataTableFormula has no .text; render stable, useful attributes, not an address repr.
    fields = ("ref", "r1", "r2", "dt2D", "dtr", "ca", "del1", "del2")
    details = ", ".join(
        f"{name}={getattr(value, name)!r}" for name in fields if hasattr(value, name)
    )
    return f"{type(value).__name__}({details})"

def discover_dimension(worksheet):
    """Scan an untrusted read-only stream without relying on its <dimension>."""
    worksheet.reset_dimensions()
    min_row = min_column = max_row = max_column = None
    for row in worksheet.iter_rows():
        for cell in row:
            # A styled-but-empty cell has coordinates in a read-only stream but is not data.
            # Formula cells remain part of the logical range even when their cache is missing.
            if getattr(cell, "value", None) is None and getattr(cell, "data_type", None) != "f":
                continue
            row_index = getattr(cell, "row", None)       # EmptyCell has no coordinates
            column_index = getattr(cell, "column", None)
            if row_index is None or column_index is None:
                continue
            min_row = row_index if min_row is None else min(min_row, row_index)
            min_column = column_index if min_column is None else min(min_column, column_index)
            max_row = row_index if max_row is None else max(max_row, row_index)
            max_column = column_index if max_column is None else max(max_column, column_index)
    if max_row is None:
        return "A1:A1", None
    extent = (
        f"{get_column_letter(min_column)}{min_row}:"
        f"{get_column_letter(max_column)}{max_row}"
    )
    return extent, min_row

# Profile EVERY sheet by default; only narrow when the task names a specific sheet.
for sheet_name in value_wb.sheetnames:
    formula_ws = formula_wb[sheet_name]
    value_ws = value_wb[sheet_name]
    # Read-only iteration is bounded by the sheet's <dimension> metadata. A
    # non-Excel producer can declare a plausible but truncated range (for
    # example A1:B2 while data continues below it), so treat that metadata as
    # untrusted: reset both streams and discover the real bounds before reading.
    declared = formula_ws.calculate_dimension()
    discovered, first_populated_row = discover_dimension(formula_ws)
    # The value stream cannot distinguish a missing formula cache from a displayed blank,
    # so it follows the logical bounds discovered from the formula-preserving stream.
    value_ws.reset_dimensions()
    if discovered != declared:
        print(f"--- {sheet_name} --- declared {declared!r}; discovered real extent:")
    print(f"--- {sheet_name} --- dims:", discovered)

    if first_populated_row is None:
        rows, header = iter(()), None
    else:
        rows = value_ws.iter_rows(min_row=first_populated_row, values_only=True)
        header = next(rows, None)
    print("header:", header)
    for i, row in enumerate(rows):
        if i >= 5: break
        print(row)

    missing_cache_count = 0
    for formula_row, value_row in zip(formula_ws.iter_rows(), value_ws.iter_rows()):
        for formula_cell, value_cell in zip(formula_row, value_row):
            if (formula_cell.data_type == "f" and value_cell.value is None
                    and formula_cell.coordinate not in cached_formulas[sheet_name]):
                missing_cache_count += 1
                if missing_cache_count <= 10:
                    print("formula without cached value:", formula_cell.coordinate,
                          formula_text(formula_cell.value))
    print("formulas without cached values:", missing_cache_count)
formula_wb.close()
value_wb.close()
```

## Rules

- First pass always: sheet names, per-sheet dimensions, header row, 5 sample rows. Report
  those before any analysis. Multi-sheet workbooks report every sheet - a profile that
  silently covers only `sheetnames[0]` is incomplete. Begin the header/sample iterator at the
  discovered first populated row; leading blank rows are not a header.
- `read_only=True` streams large files; you lose random access (`ws["B2"]` works but is slow
  in read_only mode - iterate instead).
- `data_only=True` gives cached values. A file saved by a library (never opened in Excel)
  may return `None` for formulas with no cache. Compare each cell with the corresponding cell
  from a `data_only=False` workbook and detect formulas with `cell.data_type == "f"`; array and
  data-table formulas may not be strings beginning with `=`, so a string-prefix test is incomplete.
- Mixed-type columns: profile them (`set(type(v).__name__ for v in col)`) before converting;
  a column that is mostly numbers with a few text cells is a data-quality finding, not noise.
- Never load the full sheet into memory to "look at it" when `iter_rows` with a break would do.
