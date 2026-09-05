# Edit an existing workbook

Copy the bounded loaders from [package.md](package.md) into the script. The same preflight must
run before the main editable load and before any raw ZIP/XML round-trip inventory. Define
`load_with_round_trip_audit()` from the prerequisite block later on this page before executing
the edit block; the workbook it returns is the one that must be edited and saved.

```python
import openpyxl
from datetime import date
from openpyxl.formula import Tokenizer
from openpyxl.styles import Font
from openpyxl.utils.cell import coordinate_to_tuple, range_boundaries

approved_feature_loss = False  # set True only after showing the inventory to the user
wb, dropped_parts, stripped_extensions = load_with_round_trip_audit("input.xlsx")
if (dropped_parts or stripped_extensions) and not approved_feature_loss:
    wb.close()
    raise RuntimeError(
        f"openpyxl would drop parts={dropped_parts!r}, extensions={stripped_extensions!r}; "
        "report this exact inventory and obtain confirmation before editing"
    )
ws = wb["Data"]

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
    # openpyxl 3.1 uses DefinedNameDict; 3.0 uses DefinedNameList. Support both.
    return names.values() if hasattr(names, "values") else names.definedName

def drawing_anchor_rows(drawing):
    """Return 1-based rows occupied by a string/one-cell/two-cell anchor."""
    anchor = drawing.anchor
    if isinstance(anchor, str):
        return (coordinate_to_tuple(anchor)[0],)
    rows = []
    if marker := getattr(anchor, "_from", None):
        rows.append(marker.row + 1)
    if marker := getattr(anchor, "to", None):
        rows.append(marker.row + 1)
    return tuple(rows)

def sparse_cells(sheet):
    """Walk instantiated cells only; worksheet bounds can span the full grid."""
    if not hasattr(sheet, "_cells"):
        raise RuntimeError("structural edits require a normal writable Worksheet")
    return sorted(sheet._cells.values(), key=lambda cell: (cell.row, cell.column))

def sparse_formula_cells(sheet):
    return (cell for cell in sparse_cells(sheet) if cell.data_type == "f")

def structural_references(workbook):
    """Inventory formulas/ranges that insert_rows/delete_rows will not rewrite."""
    refs = []
    for item in defined_name_values(workbook):
        refs.append(("defined name", item.name, item.attr_text))
    for sheet in workbook.worksheets:
        owner = sheet.title
        for cell in sparse_formula_cells(sheet):
            refs.append(("cell formula", f"{owner}!{cell.coordinate}",
                         formula_text(cell.value)))
        for cell in sparse_cells(sheet):
            hyperlink = cell.hyperlink
            if hyperlink is None:
                continue
            location = getattr(hyperlink, "location", None)
            target = getattr(hyperlink, "target", None)
            refs.append((
                "cell hyperlink",
                f"{owner}!{cell.coordinate}",
                (getattr(hyperlink, "ref", None), location, target),
            ))
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

def non_cell_references(workbook):
    return [reference for reference in structural_references(workbook)
            if reference[0] != "cell formula"]

def cell_formula_references(workbook):
    """Inventory ordinary, array, and data-table formulas before row/column moves."""
    refs = []
    for sheet in workbook.worksheets:
        for cell in sparse_formula_cells(sheet):
            value = cell.value
            refs.append((
                "cell formula",
                sheet.title,
                cell.coordinate,
                formula_text(value),
            ))
    return refs

def formula_may_intersect_rows(owner_sheet, formula, shifted_sheet, start_row):
    """Fail closed unless every range token is provably above/outside the shifted rows."""
    if not isinstance(formula, str) or not formula.startswith("="):
        return True
    tokens = Tokenizer(formula).items
    # These functions can manufacture references from strings or numeric
    # offsets that the RANGE-token audit below cannot see or rewrite safely.
    unmodeled_reference_functions = {"indirect", "offset", "address", "hyperlink"}
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
            if "[" in qualifier or ":" in qualifier:  # external or 3-D reference
                return True
            target_sheet = qualifier.strip("'").replace("''", "'")
        # Excel worksheet names are case-insensitive even though their spelling
        # is preserved in formulas and workbook metadata.
        if target_sheet.casefold() != shifted_sheet.casefold():
            continue
        try:
            _, min_row, _, max_row = range_boundaries(reference.replace("$", ""))
        except ValueError:  # named/dynamic reference: require a manual rewrite plan
            return True
        if min_row is None or max_row is None or max_row >= start_row:
            return True
    return False

# Address cells directly; check the header to confirm column meaning first
ws["D2"] = "=C2*1.08"                      # real formula
ws["E2"] = date(2025, 9, 30)
ws["E2"].number_format = "yyyy-mm-dd"
ws["F2"] = 1234.5
ws["F2"].number_format = "#,##0.00"

# Insert/delete does not adjust formulas or non-cell dependencies. Snapshot both inventories,
# but block only formula ranges that may intersect the shifted rows (plus the conservative
# non-cell inventory) so an audited formula such as D2 = C2*1.08 can proceed.
cell_formulas_before = cell_formula_references(wb)
intersecting_formulas = [
    reference for reference in cell_formulas_before
    if formula_may_intersect_rows(reference[1], reference[3], ws.title, 5)
]
unaudited_references = intersecting_formulas + non_cell_references(wb)
if unaudited_references:
    for reference in unaudited_references:
        print("structural-edit dependency:", reference)
    raise RuntimeError(
        "insert_rows is unsafe until cell formulas and non-cell references are audited"
    )
ws.insert_rows(5)

# Append a new sheet for derived output
summary = wb.create_sheet("Summary")
summary["A1"] = "Region"
summary["B1"] = "Total"
summary["A2"] = "EU"
summary["B2"] = "=SUMIF(Data!A:A,A2,Data!C:C)"

header_font = Font(bold=True)
for row in summary["A1:B1"]:
    for cell in row:
        cell.font = header_font

# After applying the planned rewrites, rerun the same inventory and compare it with the
# pre-edit snapshot before saving. A post-edit listing alone cannot reveal a stale formula.
print("cell formulas before:", cell_formulas_before)
print("cell formulas after planned rewrites:", cell_formula_references(wb))
print("non-cell references after planned rewrites:", non_cell_references(wb))

# Formula caches are not calculated by openpyxl. Force spreadsheet viewers to
# recalculate every edited formula instead of preserving a manual/stale input mode.
wb.calculation.fullCalcOnLoad = True
wb.calculation.forceFullCalc = True
wb.calculation.calcMode = "auto"
wb.save("input-edited.xlsx")
```

- Before editing an unknown workbook, detect what an openpyxl load/save round trip silently
  changes. Dropped parts (slicers, pivot caches, power-query connections) are only half the
  risk: features stored *inside* a retained part, such as `x14` extension lists in
  `xl/worksheets/sheet1.xml`, can be stripped while the archive member name stays. Inventory
  every worksheet extension record separately; a per-part set of coarse markers cannot detect
  one lost `<ext>` when another record keeps the same URI/namespace markers alive:

  ```python
  import zipfile
  from collections import Counter
  from tempfile import TemporaryFile
  from xml.etree import ElementTree as ET

  SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  EXT_TAG = f"{{{SHEET_NS}}}ext"

  def normalized_text(value):
      return (value or "").strip()

  def normalized_element(element):
      """Prefix/attribute-order independent, but sensitive to child values and order."""
      return (
          element.tag,                              # ElementTree expands prefixes to URI names
          tuple(sorted(element.attrib.items())),
          normalized_text(element.text),
          tuple((normalized_element(child), normalized_text(child.tail))
                for child in element),
      )

  def worksheet_extension_records(archive, info):
      """Return a multiset of (ext URI, normalized child content) for one worksheet."""
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
                  element.clear()                   # keep large non-extension sheets streaming
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
      """Return each lost (worksheet, URI, normalized children), including duplicates."""
      stripped = []
      for name in sorted(common_names):
          for (uri, children), count in (before.get(name, Counter())
                                         - after.get(name, Counter())).items():
              stripped.extend((name, uri, children) for _ in range(count))
      return sorted(stripped, key=repr)

  def load_with_round_trip_audit_from_source(source, **load_options):
      """Dry-run one workbook, then return a fresh edit copy from the same source."""
      require(not load_options.get("read_only"),
              "round-trip audit requires a normal writable Workbook")
      require(load_options.get("rich_text", True) is True,
              "round-trip audit must preserve rich-text cell runs")
      load_options["rich_text"] = True
      source.seek(0)
      before_names, before_extensions = archive_inventory(source)
      source.seek(0)
      audit_workbook = openpyxl.load_workbook(source, **load_options)
      try:
          with TemporaryFile() as output:
              audit_workbook.save(output)
              output.seek(0)
              after_names, after_extensions = archive_inventory(output)
      finally:
          audit_workbook.close()
      dropped = sorted(before_names - after_names)
      stripped_extensions = stripped_extension_records(
          before_extensions, after_extensions, before_names & after_names
      )
      # Saving can consume image streams and other resources. Reload a fresh editable
      # workbook from the same already validated identity instead of returning the dry-run copy.
      source.seek(0)
      editable_workbook = openpyxl.load_workbook(source, **load_options)
      return editable_workbook, dropped, stripped_extensions

  def load_with_round_trip_audit(path, **load_options):
      with validated_xlsx_source(path) as source:
          return load_with_round_trip_audit_from_source(source, **load_options)
  ```

  (openpyxl re-serializes every sheet it touches, so byte-identity of sheets is not a
  meaningful check. Expanded XML names normalize arbitrary prefixes, sorted attributes normalize
  serialization order, and the per-worksheet multiset still detects one missing record when an
  identical URI or even an identical duplicate record survives.)

## Rules

- `insert_rows`/`delete_rows` move cells but do **not** rewrite range references for you.
  Before structural edits, inventory cell formulas plus workbook defined names, tables,
  merged ranges, print areas/titles, autofilters, data validations, conditional formatting, and
  chart-series formulas and cell hyperlinks as above. Every hyperlink rewrite plan must update
  the anchor `ref` when its cell moves; an internal link must also update a destination stored in
  `location` or a `target` beginning with `#` when that destination moves. Treat formula-based
  `HYPERLINK()` references as dynamic and require a manual rewrite plan because their destination
  is a string token, not an ordinary range token.
  Refuse the insertion until every dependency that can intersect the shifted region has an
  explicit rewrite; after the edit, rerun both inventories and verify the expected references.
- Styling: import `Font` and assign the style to each cell. A range such as `ws["A1:F1"]`
  returns tuples of cells and cannot be styled as one object.
- Column widths: `ws.column_dimensions["A"].width = 28` - set after writing data, from the
  longest value you wrote, not a fixed guess.
- Freeze panes and autofilter improve usability cheaply:
  `ws.freeze_panes = "A2"; ws.auto_filter.ref = ws.dimensions`.
- Merged cells: avoid creating new merges; writing into a non-anchor merged cell raises.
- `.xlsm`: `load_validated_workbook(path, keep_vba=True)` and save with the same suffix, or macros are
  stripped.
- Do not delete sheets unless asked; hide instead (`ws.sheet_state = "hidden"`) when the goal
  is a cleaner tab bar.
