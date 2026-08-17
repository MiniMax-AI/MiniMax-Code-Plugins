# CSV / TSV and messy data

## Reading

```python
import csv

with open("input.csv", newline="", encoding="utf-8-sig") as f:   # utf-8-sig strips a BOM
    reader = csv.DictReader(f)
    for i, row in enumerate(reader):
        if i >= 5: break
        print(row)
```

- Always pass `newline=""` to `open` on every platform - it is the documented requirement,
  not a style choice.
- Sniff the dialect when provenance is unknown, and pass the detected dialect to the reader -
  seeking back alone does not reconfigure it, so semicolon exports would still parse as comma:

  ```python
  with open("input.csv", newline="", encoding="utf-8-sig") as f:
      sample = f.read(2048)
      f.seek(0)
      dialect = csv.Sniffer().sniff(sample)      # raises csv.Error on ambiguous input
      reader = csv.DictReader(f, dialect=dialect)
      for i, row in enumerate(reader):
          if i >= 5: break
          print(row)
  ```
- Never trust inferred dtypes in CSV: everything is a string. Convert explicitly with
  `try/except ValueError` per column and report counts of parse failures rather than dropping
  rows silently.

## Writing

```python
import csv
from pathlib import Path

FORMULA_PREFIXES = ("=", "+", "-", "@")

def spreadsheet_csv_field(value, *, mode="safe"):
    if mode not in {"safe", "raw"}:
        raise ValueError("mode must be 'safe' or 'raw'")
    if mode == "safe" and isinstance(value, str) and value.startswith(FORMULA_PREFIXES):
        return "'" + value
    return value

def delimiter_for(path):
    delimiter = {".csv": ",", ".tsv": "\t"}.get(Path(path).suffix.lower())
    if delimiter is None:
        raise ValueError("output must use a .csv or .tsv extension")
    return delimiter

output_path = Path("output.csv")  # use .tsv when tab-separated output was requested
with output_path.open("w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f, delimiter=delimiter_for(output_path))
    rows = [["Region", "Units", "Note"], ["EU", 120, "=2+2"]]
    writer.writerows([spreadsheet_csv_field(value) for value in row] for row in rows)
```

Use `mode="safe"` (the default above) when the CSV will be opened in Excel, LibreOffice,
Google Sheets, or another spreadsheet application. It neutralizes literal text beginning with
`=`, `+`, `-`, or `@` by prefixing an apostrophe, so the application does not interpret the
field as a formula. Numeric values, including negative numbers represented as numbers, are not
changed. This protection deliberately changes those serialized string values.

Use `mode="raw"` only when the user explicitly requires byte-for-value interchange with a
trusted machine consumer. Raw mode preserves the exact strings and provides **no spreadsheet
formula-injection protection**; do not present a raw export as safe to open in a spreadsheet.

## Converting

- CSV -> XLSX: read with `csv`, write with openpyxl; convert values to real types on the way
  through (dates via `datetime.strptime` with the format actually observed). Treat every
  remaining CSV field as data, not a formula. In particular, force strings beginning with `=`
  back to the string data type unless the user explicitly requested formula interpretation:

  ```python
  def write_csv_field(cell, value):
      cell.value = value
      if isinstance(value, str) and value.startswith("="):
          cell.data_type = "s"  # openpyxl otherwise promotes it to an XLSX formula
  ```
- XLSX -> CSV: use a separate `data_only=True` read so formulas export the cached values users
  see, not formula strings. Pair it with a formula-preserving read and report missing caches.
  `openpyxl` exposes both a missing cache and a present empty-string cache as `None`, so consult
  the worksheet XML. A nonempty `<v>` is cached; an empty `<v/>` is a valid displayed blank only
  when the formula cell explicitly has string-result type `t="str"`. A missing `<v>` or the bare
  empty `<v/>` that openpyxl writes for an uncalculated formula must fail closed. Cached values
  can still be stale until a spreadsheet application recalculates the workbook:

  ```python
  import csv
  import openpyxl
  import posixpath
  import zipfile
  from pathlib import Path
  from xml.etree import ElementTree as ET

  FORMULA_PREFIXES = ("=", "+", "-", "@")
  MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
  CELL_TAG = f"{{{MAIN_NS}}}c"
  FORMULA_TAG = f"{{{MAIN_NS}}}f"
  VALUE_TAG = f"{{{MAIN_NS}}}v"

  def spreadsheet_csv_field(value, *, mode="safe"):
      if mode not in {"safe", "raw"}:
          raise ValueError("mode must be 'safe' or 'raw'")
      if mode == "safe" and isinstance(value, str) and value.startswith(FORMULA_PREFIXES):
          return "'" + value
      return value

  def delimiter_for(path):
      delimiter = {".csv": ",", ".tsv": "\t"}.get(Path(path).suffix.lower())
      if delimiter is None:
          raise ValueError("output must use a .csv or .tsv extension")
      return delimiter

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
      """Find formula cells with a nonempty cache or an explicitly typed empty-string cache."""
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

  input_path = "input.xlsx"
  sheet_name = "Data"
  export_mode = "safe"  # use "raw" only for explicitly requested trusted machine interchange
  with zipfile.ZipFile(input_path) as archive:
      part = worksheet_part(archive, sheet_name)
      cached_formula_cells = cached_formula_coordinates(archive, part)
  formula_wb = openpyxl.load_workbook(input_path, read_only=True, data_only=False)
  value_wb = openpyxl.load_workbook(input_path, read_only=True, data_only=True)
  formula_ws, value_ws = formula_wb[sheet_name], value_wb[sheet_name]
  # Producer-written <dimension> metadata can look plausible while truncating real cells.
  # Reset both paired streams before their first iter_rows() call.
  formula_ws.reset_dimensions()
  value_ws.reset_dimensions()
  missing_caches = []
  output_path = Path("output.csv")
  temporary_path = output_path.with_suffix(output_path.suffix + ".tmp")
  with temporary_path.open("w", newline="", encoding="utf-8") as output:
      writer = csv.writer(output, delimiter=delimiter_for(output_path))
      for formula_row, value_row in zip(formula_ws.iter_rows(), value_ws.iter_rows()):
          for formula_cell, value_cell in zip(formula_row, value_row):
              if (formula_cell.data_type == "f" and value_cell.value is None
                      and formula_cell.coordinate not in cached_formula_cells):
                  missing_caches.append(formula_cell.coordinate)
          writer.writerow([
              spreadsheet_csv_field(cell.value, mode=export_mode) for cell in value_row
          ])
  formula_wb.close()
  value_wb.close()
  if missing_caches:
      temporary_path.unlink(missing_ok=True)
      raise RuntimeError(f"formula cells have no cached value: {missing_caches}")
  temporary_path.replace(output_path)
  ```

  Format numbers yourself only if the user needs a fixed display format; otherwise write raw
  cached values and say so. Export formula text from the `data_only=False` workbook only when
  the user explicitly requests formulas rather than displayed values.
- Large CSV -> keep it CSV or move to SQLite/Parquet; loading it all into one sheet to
  "preserve" it usually exceeds limits and helps nobody.

## Messy data cleanup contract

1. Profile before touching: row count, per-column types, null counts, duplicate-key check.
2. Report the cleanup plan and get on with it only for mechanical transforms (trim, case,
   date parsing, dedup on declared keys).
3. Every destructive step (dropping rows, overwriting values) must be counted and reported.
