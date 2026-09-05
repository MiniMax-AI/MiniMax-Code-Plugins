# Read / profile a workbook

Copy the bounded loaders from [package.md](package.md) into the script before running this
route. The package preflight must finish before either openpyxl or the raw XML scan starts.

```python
import posixpath
import zipfile
from openpyxl.utils import get_column_letter
from openpyxl.utils.cell import coordinate_to_tuple
from xml.etree import ElementTree as ET

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CELL_TAG = f"{{{MAIN_NS}}}c"
FORMULA_TAG = f"{{{MAIN_NS}}}f"
VALUE_TAG = f"{{{MAIN_NS}}}v"
INLINE_STRING_TAG = f"{{{MAIN_NS}}}is"
MAX_EXPLICIT_CELLS = 1_000_000
MAX_PROFILE_RECTANGLE_CELLS = 100_000

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
    part = target.lstrip("/") if target.startswith("/") else posixpath.normpath(
        posixpath.join("xl", target)
    )
    require(part in archive.namelist(), f"worksheet part is missing: {part}")
    return part

def worksheet_xml_profile(archive, part):
    """Discover physical logical cells without expanding their rectangular gaps."""
    min_row = min_column = max_row = max_column = None
    explicit_cell_count = 0
    formula_count = missing_formula_count = 0
    missing_formula_samples = []
    coordinate = cell_type = value_text = formula_display = None
    has_formula = value_seen = inline_string_seen = False
    with archive.open(part) as source:
        for event, element in ET.iterparse(source, events=("start", "end")):
            if event == "start" and element.tag == CELL_TAG:
                coordinate = element.attrib.get("r")
                require(coordinate is not None, f"cell without a coordinate in {part}")
                cell_type = element.attrib.get("t")
                has_formula = value_seen = inline_string_seen = False
                value_text = formula_display = None
            elif event == "end" and coordinate is not None:
                if element.tag == FORMULA_TAG:
                    has_formula = True
                    if element.text is not None:
                        formula_display = "=" + element.text
                    else:
                        details = ", ".join(
                            f"{key}={value!r}" for key, value in sorted(element.attrib.items())
                        )
                        formula_display = f"<f {details}>"
                elif element.tag == VALUE_TAG:
                    value_seen = True
                    value_text = element.text
                elif element.tag == INLINE_STRING_TAG and cell_type == "inlineStr":
                    inline_string_seen = True
                elif element.tag == CELL_TAG:
                    explicit_cell_count += 1
                    require(explicit_cell_count <= MAX_EXPLICIT_CELLS,
                            f"too many explicit worksheet cells in {part}")
                    row_index, column_index = coordinate_to_tuple(coordinate)
                    require(1 <= row_index <= 1_048_576 and 1 <= column_index <= 16_384,
                            f"cell coordinate outside XLSX limits: {coordinate}")
                    scalar_value = value_seen and (
                        value_text not in (None, "") or cell_type == "str"
                    )
                    populated = has_formula or scalar_value or inline_string_seen
                    if populated:
                        min_row = row_index if min_row is None else min(min_row, row_index)
                        min_column = (column_index if min_column is None
                                      else min(min_column, column_index))
                        max_row = row_index if max_row is None else max(max_row, row_index)
                        max_column = (column_index if max_column is None
                                      else max(max_column, column_index))
                    valid_cache = value_seen and (
                        value_text not in (None, "") or cell_type == "str"
                    )
                    if has_formula:
                        formula_count += 1
                        if not valid_cache:
                            missing_formula_count += 1
                            if len(missing_formula_samples) < 10:
                                missing_formula_samples.append((coordinate, formula_display))
                    coordinate = None
                element.clear()
            elif event == "end":
                element.clear()
    if max_row is None:
        bounds, extent, first_populated_row = None, "A1:A1", None
    else:
        bounds = (min_row, min_column, max_row, max_column)
        extent = (
            f"{get_column_letter(min_column)}{min_row}:"
            f"{get_column_letter(max_column)}{max_row}"
        )
        first_populated_row = min_row
    return {
        "part": part,
        "bounds": bounds,
        "extent": extent,
        "first_populated_row": first_populated_row,
        "formula_count": formula_count,
        "missing_formula_count": missing_formula_count,
        "missing_formula_samples": missing_formula_samples,
        "explicit_cell_count": explicit_cell_count,
    }

def bounded_sample_rows(worksheet, profile, *, max_cells=MAX_PROFILE_RECTANGLE_CELLS):
    """Return a header plus at most five rows, rejecting expansion before iter_rows()."""
    if profile["bounds"] is None:
        return iter(())
    min_row, min_column, max_row, max_column = profile["bounds"]
    sample_max_row = min(max_row, min_row + 5)
    sample_cells = (sample_max_row - min_row + 1) * (max_column - min_column + 1)
    require(sample_cells <= max_cells,
            f"sample rectangle is too large: {worksheet.title} ({sample_cells} cells)")
    return worksheet.iter_rows(
        min_row=min_row, min_col=min_column,
        max_row=sample_max_row, max_col=max_column,
        values_only=True,
    )

def worksheet_declared_dimension(worksheet):
    """Return producer metadata without forcing an unsized read-only worksheet scan."""
    if worksheet.max_row is None or worksheet.max_column is None:
        return None
    return worksheet.calculate_dimension()

input_path = "input.xlsx"
with validated_xlsx_source(input_path) as package_source:
    value_wb = openpyxl.load_workbook(package_source, read_only=True, data_only=True)
    try:
        package_source.seek(0)
        with zipfile.ZipFile(package_source) as archive:
            profiles = {
                sheet_name: worksheet_xml_profile(
                    archive, worksheet_part(archive, sheet_name)
                )
                for sheet_name in value_wb.sheetnames
            }
        print("sheets:", value_wb.sheetnames)

        # Profile EVERY sheet by default; only narrow when the task names a specific sheet.
        for sheet_name in value_wb.sheetnames:
            value_ws = value_wb[sheet_name]
            declared = worksheet_declared_dimension(value_ws)
            profile = profiles[sheet_name]
            discovered = profile["extent"]
            value_ws.reset_dimensions()
            if discovered != declared:
                print(f"--- {sheet_name} --- declared {declared!r}; discovered real extent:")
            print(f"--- {sheet_name} --- dims:", discovered,
                  "explicit cells:", profile["explicit_cell_count"])

            if profile["bounds"] is None:
                rows, header = iter(()), None
            else:
                rows = bounded_sample_rows(value_ws, profile)
                header = next(rows, None)
            print("header:", header)
            for row in rows:
                print(row)

            for coordinate, formula in profile["missing_formula_samples"]:
                print("formula without cached value:", coordinate, formula)
            print("formulas:", profile["formula_count"],
                  "without cached values:", profile["missing_formula_count"])
    finally:
        value_wb.close()
```

## Rules

- First pass always: sheet names, per-sheet dimensions, header row, 5 sample rows. Report
  those before any analysis. Multi-sheet workbooks report every sheet - a profile that
  silently covers only `sheetnames[0]` is incomplete. Begin the header/sample iterator at the
  discovered first populated row; leading blank rows are not a header.
- `read_only=True` streams large files; you lose random access (`ws["B2"]` works but is slow
  in read_only mode - iterate instead).
- A worksheet with no `<dimension>` is unsized in read-only mode. Report its declared extent
  as `None` and continue with the sparse XML profile; never call
  `calculate_dimension(force=True)`, which scans the worksheet before the profile budgets apply.
- `data_only=True` gives cached values. A file saved by a library (never opened in Excel)
  may have no cache for a formula. Use the sparse XML profile's `<f>` and `<v>` inventory to
  detect those cells without a second rectangular workbook traversal; array, shared, and
  data-table formula records may not contain ordinary formula text.
- Mixed-type columns: profile them (`set(type(v).__name__ for v in col)`) before converting;
  a column that is mostly numbers with a few text cells is a data-quality finding, not noise.
- Never use an unbounded `iter_rows()` even with a later `break`: it can manufacture empty
  cells before the caller regains control. Pass all four bounds from the sparse XML profile and
  enforce a rectangle budget first.
