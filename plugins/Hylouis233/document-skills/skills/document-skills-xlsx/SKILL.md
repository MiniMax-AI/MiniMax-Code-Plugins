---
name: document-skills-xlsx
description: Read, edit, create, or fix spreadsheet files - .xlsx, .xlsm, .xltx, .csv, .tsv. Use this Skill whenever a spreadsheet is the primary input or output: opening and inspecting workbooks, editing cells or adding sheets, writing real formulas instead of pasted values, cleaning messy data, adding charts and formatting, converting between tabular formats, or diagnosing corrupted or slow-opening files.
---

# XLSX workbench

Spreadsheets are where agents do the most damage by being clever: pasted values where formulas
belong, dates written as text, whole-number floats displayed as `3.0000000001`. Follow the
contracts below.

## Step 0 - Check the toolchain

```bash
python -c "import defusedxml, openpyxl; print(openpyxl.__version__, defusedxml.__version__)"
```

- `.csv`/`.tsv` -> standard library `csv` module is fine and often better (streaming).
- `.xlsx`/`.xlsm`/`.xltx` -> openpyxl.
- Safe package preflight requires `defusedxml==0.7.1`; do not fall back to the standard XML
  parser for untrusted OOXML parts.
- Macro preservation: openpyxl keeps VBA in `.xlsm` only with `keep_vba=True` on load and save.
- Before **any** `openpyxl.load_workbook()` of an existing package, copy and use the bounded
  same-handle loader in [references/package.md](references/package.md). `read_only=True` does
  not bound shared strings, styles, or other package parts parsed during initialization.

## Step 1 - Classify the task

| Request | Route |
|---|---|
| Open, inspect, profile a workbook | [references/read.md](references/read.md) |
| Edit cells, add sheets, fix formatting | [references/edit.md](references/edit.md) |
| Build a new workbook (data + formulas + chart) | [references/create.md](references/create.md) |
| CSV/TSV in or out, messy data cleanup | [references/csv.md](references/csv.md) |
| Conditional formatting, structured tables, pivot-style aggregation | [references/formatting.md](references/formatting.md) |
| Safely open an existing OOXML package | [references/package.md](references/package.md) |

## Step 2 - Contracts that always apply

1. **Formulas are formulas.** If the user asks for a total/average/lookup, write `=SUM(B2:B10)`
   in the cell - never the computed number - unless the user explicitly asked to freeze values.
   openpyxl writes the formula; Excel/WPS/LibreOffice calculate on open.
2. **`data_only=True` reads cached values** (last calculated by a real app) and **loses
   formulas on save**. Use it only for reading values; never load, edit, and save with it.
3. **Types**: write `int`/`float`/`datetime`/`bool`, never formatted strings. Dates go in as
   `datetime` with `number_format='yyyy-mm-dd'`; currency as float plus
   `number_format='#,##0.00'` (or the locale-appropriate currency format string).
4. **Formulas are not recalculated by openpyxl.** After writing formulas, set
   `wb.calculation.fullCalcOnLoad = True` before saving so Excel/WPS/LibreOffice recalculate
   on open even when the workbook (typically one you loaded, which can carry
   `fullCalcOnLoad=False`) uses calculation mode `manual` - check
   `wb.calculation.calcMode`. You still cannot read results back without opening the file in
   a real spreadsheet app; verify formula strings and ranges structurally instead (see
   postcheck).
5. **Dimensions**: treat `<dimension>`, `ws.max_row`, and `ws.max_column` as untrusted hints.
   Discover logical cells with the sparse worksheet-XML scan in the read route; never expand an
   unknown rectangular range merely to find its bounds.
6. Save to a new path first; overwrite only on explicit request.

## Step 3 - Postcheck (mandatory)

Save this as `postcheck.py`, copy `load_validated_workbook()` and its dependencies from
[references/package.md](references/package.md), then pass the output path followed by every
sheet the task should produce, for example `python postcheck.py output.xlsx Sales Summary`:

```python
import openpyxl
import sys

if len(sys.argv) < 3:
    raise SystemExit("usage: python postcheck.py OUTPUT.xlsx EXPECTED_SHEET [...]")
output_path, *expected_sheets = sys.argv[1:]
# Populate this whenever the task requested specific display formats.
expected_number_formats = {
    # "Sales": {"D2": "#,##0.00", "E2": "yyyy-mm-dd"},
}
# Populate every formula the task intends to create or preserve.
expected_formulas = {
    # "Sales": {"D2": "=C2*1.08"},
}
# Populate every expected sheet with the exact used range required by the task.
expected_dimensions = {
    # "Sales": "A1:E20",
    # "Summary": "A1:C8",
}
wb = load_validated_workbook(output_path)

def require(condition, message):
    if not condition:
        raise ValueError(message)

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

print("sheets:", wb.sheetnames)
missing = set(expected_sheets) - set(wb.sheetnames)
require(not missing, f"missing expected sheets: {sorted(missing)}")
require(
    set(expected_dimensions) == set(expected_sheets),
    "expected_dimensions must declare the exact used range for every expected sheet",
)
calc = wb.calculation
print("calcMode:", getattr(calc, "calcMode", None),
      "fullCalcOnLoad:", getattr(calc, "fullCalcOnLoad", None))
if any(expected_formulas.values()):
    require(
        getattr(calc, "fullCalcOnLoad", False) is True
        or getattr(calc, "calcMode", None) == "auto",
        "formula output is not configured to recalculate in spreadsheet viewers",
    )
for ws in wb.worksheets:
    print(f"{ws.title} dims:", ws.dimensions)
    if ws.title in expected_dimensions:
        require(
            ws.dimensions == expected_dimensions[ws.title],
            f"{ws.title}: expected used range {expected_dimensions[ws.title]!r}, "
            f"got {ws.dimensions!r}",
        )
    # `expected_formulas` is the task contract, so verify those coordinates directly.
    # Never call unbounded iter_rows(): one styled extreme cell can make the rectangle huge.
    actual_formulas = {}
    for coordinate, expected_formula in expected_formulas.get(ws.title, {}).items():
        cell = ws[coordinate]
        actual_formula = formula_text(cell.value) if cell.data_type == "f" else None
        actual_formulas[coordinate] = actual_formula
        require(
            actual_formula == expected_formula,
            f"{ws.title}!{coordinate}: expected formula {expected_formula!r}, "
            f"got {actual_formula!r}",
        )
    print(f"{ws.title} expected formula cells:", list(actual_formulas.items())[:10])
    for coordinate, expected_format in expected_number_formats.get(ws.title, {}).items():
        actual_format = ws[coordinate].number_format
        require(actual_format == expected_format, (
            f"{ws.title}!{coordinate}: expected format {expected_format!r}, got {actual_format!r}"
        ))
wb.close()
```

Confirm: expected sheet names exist; used range matches expectations; intended formula cells
contain formula strings; when the task wrote formulas, the printout shows `fullCalcOnLoad: True`
(or `calcMode: auto`) so viewers will recalculate — otherwise set it and re-save; every
task-specific formatted cell is listed in `expected_number_formats` and matches. Report what
was verified and note that final rendered values require opening in a spreadsheet application.
