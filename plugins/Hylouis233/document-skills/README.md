# Document Skills

## The problem

Users keep asking coding agents for document deliverables — a Word report, a PDF handout, a slide
deck, a data workbook — and get unreliable results: ZIP files rewritten by hand and corrupted,
spreadsheets where formulas were typed as text, slide decks that no viewer opens, PDFs that are a
stack of screenshots instead of text. Office and PDF documents are container formats with strict
internal contracts, and an agent without format knowledge breaks them silently.

This Plugin installs four namespaced workbench Skills — `document-skills-docx`,
`document-skills-pdf`, `document-skills-pptx`, and `document-skills-xlsx` — that route each task
to the right standard tool (python-docx, python-pptx, openpyxl, pypdf, ReportLab, PyMuPDF),
enforce the container contracts (valid ZIP, correct content types, calculated dimensions), and
verify output before it is handed back. The namespaced IDs avoid overriding host-provided Skills
with generic names such as `docx`, `pdf`, `pptx`, or `xlsx`.

## Try it

```text
Use the document-skills plugin: open sales-2024.xlsx, add a sheet "Summary" with per-region
totals computed by formula, a bar chart of the top 5 products, and currency formatting.
```

Expected result: the agent loads the workbook with openpyxl, inspects sheet names, headers, and
dtypes, writes `SUMIF`/`COUNTIF` formulas (not pasted values), adds a native `BarChart` anchored
to the new sheet, applies number formats, and reports the cell ranges it changed.

```text
Use the document-skills plugin: create a PDF one-pager "Q3 launch checklist" from this outline
with a title block and a two-column checklist that fits exactly one A4 page.
```

Expected result: the agent generates the page with ReportLab flowables on an A4 canvas, measures
the checklist blocks, and confirms with pypdf that the output is exactly 1 page with extractable
text — not a screenshot.

## What the Skills do

Shared spine (all four Skills follow it):

1. Classify the request as **create**, **read**, **edit**, or **review**.
2. Check tool availability first and report missing dependencies instead of improvising.
3. Follow format-specific rules (packages below).
4. Run the post-generation verification checklist; fix and re-verify until it passes.
5. Report the output path, the page/sheet/slide inventory, and any remaining caveats.

Per format:

- **document-skills-docx** — create with python-docx from a heading outline; use python-docx first
  for routine structural edits (paragraphs, tables, images, styles, and text runs), and reserve
  direct OOXML surgery for fields, tracked changes, or package features python-docx cannot express;
  extract text with python-docx or `pandoc -t markdown`; postcheck with python-docx re-open and
  `soffice --headless --convert-to` PDF smoke test when LibreOffice is present. Depth references:
  CJK typography (east-asian font slots, 字号 table, char-based indents, GB/T 9704 page geometry)
  and scene patterns (academic paper, resume, official document, contract).
- **document-skills-xlsx** — openpyxl for reading, editing, styling, and native charts; formulas as
  formulas, never as pasted results; `data_only=True` only for reading cached values; date/number
  formats applied explicitly; recalculation contract documented (openpyxl writes formulas, the
  Skill sets `fullCalcOnLoad` so even manual-calc workbooks recalculate when a viewer opens them).
  Depth references: conditional formatting rules, structured tables, and honest pivot-style
  aggregation (openpyxl cannot create pivot tables; the reference gives the formula-sheet,
  frozen-values, and user-template routes).
- **document-skills-pptx** — python-pptx to build decks (7 common slide patterns: title, agenda,
  bullet, two image+text, table, chart, quote/closing); edit only named, existing shapes, never
  blind rewriting of the whole XML; text measured against shape width with font-size reduction
  rules; presentation-level verification via `python-pptx` re-open plus a rendered PDF smoke test
  when LibreOffice is available.
- **document-skills-pdf** — creation prefers ReportLab (real, selectable text with flowable
  structure) over HTML-to-print paths; extraction (text, coordinates, tables, images) and
  rasterization use PyMuPDF, while pypdf is reserved for page-level transforms such as split,
  merge, rotate, watermark, encryption, and forms; an explicit one-tool-per-job table prevents
  accidental API mixing. Note: ReportLab output is not tagged PDF/UA — when the user needs an
  accessible (screen-reader-ready) PDF, the PDF Skill says to report that limitation honestly
  instead of claiming accessibility.

## Verification-first output

Every Skill ends with the same rule: do not hand back a file you have not re-opened. The checklists
are specific (re-open the archive, confirm the sheet count and formula presence, confirm the slide
count, confirm page count and text extraction) and the Skills require reporting what was verified
versus what was assumed.

The [`tests/`](tests/) directory ships one runnable fixture script per format covering the
snippets with the worst silent-failure modes (PDF AcroForm clone-and-fill, watermark write,
encrypted extraction, CMYK conversion, soft masks; PPTX run-preserving edits, table-cell locating,
actual content extraction, grouped shapes, script-aware per-master themes; XLSX dialect sniffing,
array formulas, streamed extension checks, structural-reference audits; DOCX bounded package review,
content controls, per-run glyph checks, guarded replacement, and a LibreOffice-rendered numbering
restart). Each script is self-contained and exits non-zero on failure.

These heavyweight integration fixtures are intentionally not part of the repository-wide
`npm run check`. To run the same gate locally from this plugin directory:

```bash
python -m pip install -r tests/requirements-fixtures.txt
node --test tests/fixtures.integration.mjs
```

LibreOffice (`soffice`) must be available for the rendering checks. The path-filtered
`.github/workflows/document-skills.yml` workflow installs the pinned Python environment and
LibreOffice, then runs this fixture gate only when the document-skills plugin or its workflow
changes.

## Requirements

- Python 3.9+ with `python-docx`, `python-pptx`, `openpyxl`, `pypdf`, `reportlab`,
  `pymupdf` (`pip install python-docx python-pptx openpyxl pypdf reportlab pymupdf`).
- Optional: LibreOffice (`soffice`) for PDF smoke tests of DOCX/PPTX output; `pandoc` for
  markdown extraction from DOCX.
- Works on Windows, macOS, and Linux. All commands are given in cross-platform form; the Skills
  say how to resolve the skill directory path on each platform.

## Data and network

- No network access. All processing is local file conversion and generation.
- No credentials required.
- The Skills only read and write document files the user points at; temporary files go to the
  system temp directory and are cleaned up.

## License

Apache-2.0. See [LICENSE](LICENSE).
