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

FORMULA_OPERATORS = ("=", "+", "-", "@", "＝", "＋", "－", "＠")

def begins_spreadsheet_formula(value):
    index = 0
    while index < len(value) and (ord(value[index]) <= 0x20 or value[index] == "\ufeff"):
        index += 1
    return value.startswith(FORMULA_OPERATORS, index)

def spreadsheet_csv_field(value, *, mode="safe"):
    if mode not in {"safe", "raw"}:
        raise ValueError("mode must be 'safe' or 'raw'")
    if mode == "safe" and isinstance(value, str) and begins_spreadsheet_formula(value):
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
Google Sheets, or another spreadsheet application. It scans past leading C0 controls/spaces and
BOMs, then prefixes the **complete original field** with an apostrophe when the next character is
`=`, `+`, `-`, `@`, or the corresponding fullwidth operator. Importers can strip or ignore leading
tab/CR/LF/BOM characters before formula detection, and CSV quoting does not neutralize them.
Benign control-prefixed text is preserved. Numeric values, including negative numbers represented
as numbers, are not changed. This protection deliberately changes formula-like serialized strings.

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
- XLSX -> CSV: use a `data_only=True` read so formulas export the cached values users
  see, not formula strings. Pair it with the sparse XML profile and report missing caches.
  `openpyxl` exposes both a missing cache and a present empty-string cache as `None`, so consult
  the worksheet XML. A nonempty `<v>` is cached; an empty `<v/>` is a valid displayed blank only
  when the formula cell explicitly has string-result type `t="str"`. A missing `<v>` or the bare
  empty `<v/>` that openpyxl writes for an uncalculated formula must fail closed. Cached values
  can still be stale until a spreadsheet application recalculates the workbook. Copy the
  bounded helpers from [package.md](package.md) and `worksheet_xml_profile()` from
  [read.md](read.md) first: raw ZIP inspection and the value workbook must share one already
  validated source identity. Refuse a logical CSV rectangle above the explicit cell budget;
  never call an unbounded `iter_rows()` after `reset_dimensions()`.

  ```python
  import csv
  import os
  import openpyxl
  import posixpath
  import zipfile
  from pathlib import Path
  from tempfile import mkstemp
  from openpyxl.utils import get_column_letter
  from openpyxl.utils.cell import coordinate_to_tuple
  from xml.etree import ElementTree as ET

  FORMULA_OPERATORS = ("=", "+", "-", "@", "＝", "＋", "－", "＠")
  MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
  CELL_TAG = f"{{{MAIN_NS}}}c"
  FORMULA_TAG = f"{{{MAIN_NS}}}f"
  VALUE_TAG = f"{{{MAIN_NS}}}v"
  INLINE_STRING_TAG = f"{{{MAIN_NS}}}is"
  MAX_EXPLICIT_CELLS = 1_000_000
  MAX_CSV_EXPORT_CELLS = 5_000_000

  def begins_spreadsheet_formula(value):
      index = 0
      while index < len(value) and (ord(value[index]) <= 0x20 or value[index] == "\ufeff"):
          index += 1
      return value.startswith(FORMULA_OPERATORS, index)

  def spreadsheet_csv_field(value, *, mode="safe"):
      if mode not in {"safe", "raw"}:
          raise ValueError("mode must be 'safe' or 'raw'")
      if mode == "safe" and isinstance(value, str) and begins_spreadsheet_formula(value):
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
      part = target.lstrip("/") if target.startswith("/") else posixpath.normpath(
          posixpath.join("xl", target)
      )
      require(part in archive.namelist(), f"worksheet part is missing: {part}")
      return part

  input_path = "input.xlsx"
  sheet_name = "Data"
  export_mode = "safe"  # use "raw" only for explicitly requested trusted machine interchange
  output_path = Path("output.csv")
  temporary_path = None
  try:
    descriptor, temporary_name = mkstemp(
        dir=output_path.parent, prefix=f".{output_path.name}.", suffix=".tmp"
    )
    temporary_path = Path(temporary_name)
    os.close(descriptor)
    with validated_xlsx_source(input_path) as package_source:
      value_wb = openpyxl.load_workbook(package_source, read_only=True, data_only=True)
      try:
          package_source.seek(0)
          with zipfile.ZipFile(package_source) as archive:
              part = worksheet_part(archive, sheet_name)
              profile = worksheet_xml_profile(archive, part)
          if profile["missing_formula_count"]:
              raise RuntimeError(
                  "formula cells have no cached value: "
                  f"{profile['missing_formula_samples']}"
              )
          value_ws = value_wb[sheet_name]
          value_ws.reset_dimensions()
          if profile["bounds"] is None:
              rows = iter(())
          else:
              min_row, min_column, max_row, max_column = profile["bounds"]
              export_cells = (max_row - min_row + 1) * (max_column - min_column + 1)
              require(export_cells <= MAX_CSV_EXPORT_CELLS,
                      f"CSV export rectangle is too large: {export_cells} cells")
              rows = value_ws.iter_rows(
                  min_row=min_row, min_col=min_column,
                  max_row=max_row, max_col=max_column,
                  values_only=True,
              )
          with temporary_path.open("w", newline="", encoding="utf-8") as output:
              writer = csv.writer(output, delimiter=delimiter_for(output_path))
              for value_row in rows:
                  writer.writerow([
                      spreadsheet_csv_field(value, mode=export_mode) for value in value_row
                  ])
      finally:
          value_wb.close()
  except Exception:
      if temporary_path is not None:
          temporary_path.unlink(missing_ok=True)
      raise
  require(temporary_path is not None, "CSV temporary output was not created")
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
