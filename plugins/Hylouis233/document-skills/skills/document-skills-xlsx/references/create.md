# Create a workbook from scratch

```python
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.chart import BarChart, LineChart, Reference

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Sales"

headers = ["Region", "Product", "Units", "Unit price", "Revenue"]
ws.append(headers)
rows = [
    ("EU", "Widget", 120, 9.5),
    ("EU", "Gadget", 80, 21.0),
    ("US", "Widget", 200, 9.5),
]
for r_i, (region, product, units, price) in enumerate(rows, start=2):
    ws.cell(row=r_i, column=1, value=region)
    ws.cell(row=r_i, column=2, value=product)
    ws.cell(row=r_i, column=3, value=units)
    ws.cell(row=r_i, column=4, value=price)
    ws.cell(row=r_i, column=5, value=f"=C{r_i}*D{r_i}")   # formula, not value

last = len(rows) + 1
ws.cell(row=last + 1, column=4, value="Total")
ws.cell(row=last + 1, column=5, value=f"=SUM(E2:E{last})").font = Font(bold=True)

# Header styling
for cell in ws[1]:
    cell.font = Font(bold=True, color="FFFFFF")
    cell.fill = PatternFill("solid", fgColor="1F4E79")
    cell.alignment = Alignment(horizontal="center")

# Number formats on data columns
for r_i in range(2, last + 2):
    ws.cell(row=r_i, column=4).number_format = "0.00"
    ws.cell(row=r_i, column=5).number_format = "#,##0.00"

widths = {"A": 10, "B": 16, "C": 8, "D": 12, "E": 12}
for col, w in widths.items():
    ws.column_dimensions[col].width = w
ws.freeze_panes = "A2"

# Native chart bound to the sheet data
chart = BarChart()
chart.type = "col"
# The source has one bar per sales row (including two separate Widget rows), not
# a product aggregate, so keep the title explicit about that granularity.
chart.title = "Revenue by transaction row"
chart.y_axis.title = "Revenue"
data = Reference(ws, min_col=5, min_row=1, max_row=last)          # includes header for series name
cats = Reference(ws, min_col=2, min_row=2, max_row=last)
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
chart.width, chart.height = 16, 9
ws.add_chart(chart, "G2")

wb.save("report.xlsx")
```

## Rules

- `ws.append(list)` for row-oriented data; `ws.cell(row=, column=, value=)` when you need the
  cell object anyway (styling, formats).
- A chart references cells - it does not copy data. Keep the referenced range contiguous and
  include the header row when using `titles_from_data=True`.
- Multiple sheets: one topic per sheet, `wb.create_sheet(name)`; cross-sheet formulas use
  `SheetName!A1` syntax (quote the name if it contains spaces: `'Sales Data'!A1`).
- `LineChart` for trends, `BarChart` for comparisons, `PieChart` only for few categories that
  sum to a whole.
- Excel row limit 1,048,576 and column limit 16,384 are hard; streaming writes should chunk
  via `write_only=True` workbooks when generating hundreds of thousands of rows.
