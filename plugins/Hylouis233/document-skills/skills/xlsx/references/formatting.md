# Conditional formatting, tables, and pivot-style aggregation

## Conditional formatting (openpyxl)

Rules attach to a range and survive openpyxl round trips. Scopes smaller than the whole
column keep files fast and avoid formatting ghost rows:

```python
from openpyxl.formatting.rule import CellIsRule, ColorScaleRule, DataBarRule, FormulaRule
from openpyxl.styles import Font, PatternFill

red_fill = PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid")
red_font = Font(color="9C0006")

def last_populated_row(sheet, *, first_data_row=2, min_col=1, max_col=6):
    # Conditional formatting uses a normal in-memory Worksheet. Its sparse cell store avoids
    # iterating/materializing every row up to an inflated max_row.
    populated_rows = (
        cell.row for cell in sheet._cells.values()
        if first_data_row <= cell.row
        and min_col <= cell.column <= max_col
        and cell.value is not None
    )
    return max(populated_rows, default=first_data_row - 1)

# Do not use ws.max_row: a styled but empty cell can inflate it far below the data.
last = last_populated_row(ws)

# With only a header row every range below would be inverted
# ("D2:D1"); openpyxl rejects those ranges, so guard before building rules.
if last < 2:
    print("skipping conditional formatting: no populated data rows below the header")
else:
    # value-based rule
    ws.conditional_formatting.add(
        f"D2:D{last}",
        CellIsRule(operator="lessThan", formula=["0"], fill=red_fill, font=red_font),
    )

    # whole-row highlight: FormulaRule anchored with $ on the key column
    ws.conditional_formatting.add(f"A2:F{last}", FormulaRule(formula=["$D2<0"], fill=red_fill))

    # gradient and data bars for magnitude scanning
    ws.conditional_formatting.add(
        f"C2:C{last}",
        ColorScaleRule(start_type="min", start_color="FFFFFF", end_type="max", end_color="63BE7B"),
    )
    ws.conditional_formatting.add(
        f"E2:E{last}",
        DataBarRule(start_type="min", end_type="max", color="638EC6"),
    )
```

Restrict the scan to the columns that define the data region. If the data is already a declared
Table, its ref is authoritative instead: use
`openpyxl.utils.cell.range_boundaries(ws.tables["TData"].ref)[3]` for `last`.

- FormulaRule formulas are US-locale and relative to the range's top-left cell - `$D2` (lock
  column, free row) is what makes the whole-row pattern work.
- Multiple rules on one range evaluate by priority; if exactly one should apply, set
  `stopIfTrue=True` on the earlier rules.

## Structured tables

A real Table gives filter UI, banded styling, and structured references:

```python
from openpyxl.worksheet.table import Table, TableStyleInfo

last = last_populated_row(ws)
if last < 2:
    raise ValueError("cannot create a data table without populated rows")
tbl = Table(displayName="TData", ref=f"A1:F{last}")   # name has no spaces
tbl.tableStyleInfo = TableStyleInfo(name="TableStyleMedium9", showRowStripes=True)
ws.add_table(tbl)
```

One Table per sheet region; the ref must cover the headers. Do not also draw manual borders
over a Table range.

## Pivot-style aggregation - the honest contract

**openpyxl cannot create pivot tables.** It preserves existing ones on a load/save round trip,
but building the pivot cache from scratch is not supported. Offer these routes and say which
one you took:

1. **Formula sheet (live, recalculates)** - the default. A `SUMIFS`/`COUNTIFS`/`AVERAGEIFS`
   grid keyed on a unique-values column reproduces most pivot outputs and stays a formula
   per contract rule 1. Build every sheet reference from the real source sheet's name -
   hard-coding `Data!` breaks on any workbook whose sheet is named differently:

   ```python
   import openpyxl
   import posixpath
   import zipfile
   from xml.etree import ElementTree as ET

   MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
   DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
   PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

   def cached_formula_coordinates_for_sheet(path, sheet_name):
       """Distinguish a typed cached blank from a formula with no cached result."""
       with zipfile.ZipFile(path) as archive:
           workbook = ET.fromstring(archive.read("xl/workbook.xml"))
           sheet = next(
               item for item in workbook.iter(f"{{{MAIN_NS}}}sheet")
               if item.attrib["name"] == sheet_name
           )
           relationship_id = sheet.attrib[f"{{{DOC_REL_NS}}}id"]
           relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
           target = next(
               item.attrib["Target"]
               for item in relationships.iter(f"{{{PKG_REL_NS}}}Relationship")
               if item.attrib["Id"] == relationship_id
           )
           part = target.lstrip("/") if target.startswith("/") else posixpath.normpath(
               posixpath.join("xl", target)
           )
           cached = set()
           coordinate = cell_type = value_text = None
           has_formula = value_seen = False
           with archive.open(part) as source:
               for event, element in ET.iterparse(source, events=("start", "end")):
                   if event == "start" and element.tag == f"{{{MAIN_NS}}}c":
                       coordinate = element.attrib["r"]
                       cell_type = element.attrib.get("t")
                       has_formula = value_seen = False
                       value_text = None
                   elif event == "end" and coordinate is not None:
                       if element.tag == f"{{{MAIN_NS}}}f":
                           has_formula = True
                       elif element.tag == f"{{{MAIN_NS}}}v":
                           value_seen = True
                           value_text = element.text
                       elif element.tag == f"{{{MAIN_NS}}}c":
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

   def sheet_ref(sheet):
       # Always quote: valid titles such as Q1-Data are ambiguous when left bare.
       # Excel escapes an apostrophe inside a quoted title by doubling it.
       escaped = sheet.title.replace("'", "''")
       return f"'{escaped}'!"

   src = sheet_ref(ws)                              # e.g. "'Sales'!" or "'Raw Data'!"
   source_path = "input.xlsx"  # the same original path used to load formula-preserving `wb`
   cached_region_formulas = cached_formula_coordinates_for_sheet(source_path, ws.title)
   value_wb = openpyxl.load_workbook(source_path, read_only=True, data_only=True)
   value_ws = value_wb[ws.title]
   value_ws.reset_dimensions()
   regions = []
   seen_region_keys = set()
   missing_region_caches = []
   source_rows = ws.iter_rows(min_row=2, min_col=1, max_col=1)
   value_rows = value_ws.iter_rows(min_row=2, min_col=1, max_col=1)
   for source_row, value_row in zip(source_rows, value_rows):
       source_cell, value_cell = source_row[0], value_row[0]
       region = value_cell.value if source_cell.data_type == "f" else source_cell.value
       if (source_cell.data_type == "f" and region is None
               and source_cell.coordinate not in cached_region_formulas):
           missing_region_caches.append(source_cell.coordinate)
           continue
       if region is None or region == "":             # keep valid falsey values: 0 and False
           continue
       key = (type(region), region)                    # do not collapse False and numeric 0
       if key not in seen_region_keys:
           seen_region_keys.add(key)
           regions.append(region)                     # stable source order; no mixed-type sort
   value_wb.close()
   if missing_region_caches:
       raise RuntimeError(
           f"aggregation keys have no cached value: {missing_region_caches}"
       )

   ws2 = wb.create_sheet("ByRegion")
   ws2.append(["Region", "Units", "Revenue"])
   for i, region in enumerate(regions, start=2):
       ws2.cell(row=i, column=1, value=region)
       ws2.cell(row=i, column=2, value=f"=SUMIF({src}A:A,A{i},{src}C:C)")
       ws2.cell(row=i, column=3, value=f"=SUMIF({src}A:A,A{i},{src}D:D)")
   ```

   Unique values themselves are formulas only with array/dynamic functions - extracting them
   in Python (as above) and writing them as values is the accepted split; the aggregates stay
   live.

2. **Frozen pivot values (Python-side grouping)** - when the user wants a one-shot analysis
   report, not a living workbook. Group in pure Python (or pandas if already installed),
   write values, and **label the sheet** ("values as of generation, not recalculated").

3. **User's Excel/template pivot** - when the workbook already has slicers or a pivot the
  user maintains, edit around it and re-run the `round_trip_changes` check from
  [edit.md](edit.md) before saving.

## Postcheck additions

1. Re-open and count `ws.conditional_formatting` ranges; confirm the intended ranges exist
   and anchor rows match the data (a rule left on `D2:D1048576` from an earlier resize is a
   defect).
2. Confirm Table names are unique workbook-wide and refs cover the header row.
3. For the formula-sheet route, assert the aggregate cells contain formula strings, per the
   main postcheck.
