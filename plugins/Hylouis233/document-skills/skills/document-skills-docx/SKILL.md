---
name: document-skills-docx
description: Create, read, edit, or review Microsoft Word .docx documents. Use this Skill whenever the task involves a .docx file - generating reports, letters, or structured documents from scratch; extracting or reorganizing content; applying consistent formatting (headings, tables, styles, headers/footers, page numbers); editing an existing document while preserving its layout; or checking that a produced document actually opens and renders.
---

# DOCX workbench

A `.docx` file is a ZIP archive of XML parts around one `word/document.xml`. Treat the format
with respect: silent corruption is the default failure mode when agents edit the XML blind.

## Step 0 — Resolve paths and check the toolchain

Resolve this Skill's directory once (`SKILL_DIR` = the folder containing this SKILL.md), then
check what is installed before promising anything:

```bash
python -c "import docx; print(docx.__version__ if hasattr(docx,'__version__') else 'ok')"
```

- `python-docx` present -> full create/read/edit support.
- `python-docx` missing but `pandoc` present -> read/extract requests can still
  be served by the pandoc route in [references/read.md](references/read.md);
  report that structural reads, edits, and creation are unavailable
  (`pip install python-docx`) and stop only for those routes. Never hand-write
  OOXML as a substitute.
- Both missing -> report the missing tools and stop.
- `pandoc` present -> prefer it for text/markdown extraction (fast, faithful).
- `soffice` present -> enables the PDF smoke test in postcheck.

## Step 1 — Classify the task

| Request looks like | Route | Go to |
|---|---|---|
| "Write / create / generate a document" (no input file) | Create | [references/create.md](references/create.md) |
| "Edit / change / add to this document" (input file given) | Edit | [references/edit.md](references/edit.md) |
| "Read / extract / summarize / convert" | Read | [references/read.md](references/read.md) |
| "Check / fix / why is it broken" | Review | [references/review.md](references/review.md) |

Two depth references slot in before create/edit: [references/cjk.md](references/cjk.md)
whenever the document contains CJK text (east-asian fonts, 字号, char-based indents, 公文
geometry), and [references/scenes.md](references/scenes.md) when the request matches a known
scene - academic paper, resume, official document (公文), or contract.

Two routes can chain (read -> edit, create -> review). Never skip classification; it decides
between python-docx generation and raw XML surgery, which have opposite safety profiles.

## Step 2 — Shared rules that always apply

1. **Never edit `word/document.xml` with find/replace on rendered text.** Run-level splits mean
   the visible word "contract" may be spread across three `<w:t>` nodes. Use the edit route's
   paragraph-index addressing instead.
2. **Prefer modifying an existing document with python-docx when the change is structural**
   (add paragraphs, tables, images, styles); drop to raw XML only for things python-docx cannot
   express (field codes, exotic properties, tracked-change surgery).
3. **Always write to a new output path first.** Only overwrite the source when the user explicitly
   asked for in-place modification, and then only after the postcheck passes.
4. **Keep styles semantic.** Use `Heading 1..4` styles instead of "bold 16pt text" so
   navigation, TOC fields, and accessibility keep working.
5. **Units**: lengths in the XML are twentieths of a point (twips); python-docx accepts
   `.inches`/`.cm`/`.Pt` helpers - use the helpers.
6. **Non-ASCII**: write files as UTF-8 without BOM; declare encoding when opening text side
   files.

## Step 3 — Execute the route

Follow the referenced file for concrete code patterns, then continue to postcheck. Do not
improvise container-level operations (re-zipping, renaming parts) outside the patterns in
[references/edit.md](references/edit.md).

## Step 4 — Postcheck (mandatory before handing back the file)

Run every applicable item and report results explicitly:

1. Re-open the output with python-docx (`Document(path)`); confirm it parses and count
   paragraphs/tables.
2. If `soffice` exists: `soffice --headless --convert-to pdf <output.docx> --outdir <tmp>`
   must exit 0; the PDF is a smoke test, keep or delete it per the user's ask.
3. Verify requested features landed: search the re-opened document for the expected heading
   texts, table row counts, or inserted image count.
4. Report: output path, paragraph/table counts, what was verified, what could not be verified
   locally (e.g. exact pagination in MS Word), and any font substitutions expected.

If a check fails, fix and re-run; do not deliver with a known-broken archive.
