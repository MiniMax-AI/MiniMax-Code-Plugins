# Read / extract a DOCX

Pick by fidelity needed.

## Fast text extraction (pandoc, if installed)

```bash
pandoc -t markdown input.docx -o extracted.md
```

Best structural fidelity for prose (headings become markdown headings, tables become pipe
tables). Prefer this when the goal is content, not coordinates.

## Structured access (python-docx)

```python
from contextlib import contextmanager
import zipfile
from pathlib import Path
from tempfile import TemporaryFile

from docx import Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.text.run import Run
from lxml import etree

MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_MEMBERS = 10_000
MAX_XML_PART = 20 * 1024 * 1024
MAX_ENTRY = 100 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED = 500 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types"

def require(condition, message):
    if not condition:
        raise ValueError(message)

SAFE_XML_PARSER = etree.XMLParser(
    load_dtd=False, resolve_entities=False, no_network=True,
    huge_tree=False, recover=False,
)

def xml_content_type(value):
    media_type = (value or "").split(";", 1)[0].strip().casefold()
    return media_type in {"application/xml", "text/xml"} or media_type.endswith("+xml")

def declared_xml_parts(archive, infos):
    """Classify XML by OPC declarations, not filename spelling alone."""
    by_name = {info.filename: info for info in infos}
    content_types_info = by_name.get("[Content_Types].xml")
    require(content_types_info is not None, "missing [Content_Types].xml")
    require(content_types_info.file_size <= MAX_XML_PART,
            "oversized XML part: [Content_Types].xml")
    with archive.open(content_types_info) as stream:
        content_types_blob = stream.read(MAX_XML_PART + 1)
    require(len(content_types_blob) <= MAX_XML_PART,
            "oversized XML part: [Content_Types].xml")
    root = etree.fromstring(content_types_blob, parser=SAFE_XML_PARSER)
    require(root.tag == f"{{{CONTENT_TYPES_NAMESPACE}}}Types",
            "invalid [Content_Types].xml root")
    defaults = {}
    overrides = {}
    for child in root:
        if child.tag == f"{{{CONTENT_TYPES_NAMESPACE}}}Default":
            extension = (child.get("Extension") or "").casefold()
            require(extension and extension not in defaults,
                    "invalid duplicate content-type default")
            defaults[extension] = child.get("ContentType") or ""
        elif child.tag == f"{{{CONTENT_TYPES_NAMESPACE}}}Override":
            part_name = child.get("PartName") or ""
            require(part_name.startswith("/") and part_name[1:] not in overrides,
                    "invalid duplicate content-type override")
            overrides[part_name[1:]] = child.get("ContentType") or ""
    xml_names = {"[Content_Types].xml"}
    for info in infos:
        suffix = info.filename.rsplit(".", 1)[1].casefold() if "." in info.filename else ""
        content_type = overrides.get(info.filename, defaults.get(suffix, ""))
        if (info.filename.casefold().endswith((".xml", ".rels"))
                or xml_content_type(content_type)):
            xml_names.add(info.filename)
    return xml_names

def validate_docx_archive(archive):
    infos = archive.infolist()
    require(len(infos) <= MAX_MEMBERS, "archive member count above limit")
    names = {info.filename for info in infos}
    require(len(names) == len(infos), "duplicate archive member names are unsafe")
    require("[Content_Types].xml" in names and "word/document.xml" in names,
            "missing required OPC members")
    require(sum(info.file_size for info in infos) <= MAX_TOTAL_UNCOMPRESSED,
            "declared total uncompressed size above limit")
    xml_names = declared_xml_parts(archive, infos)
    actual_total = 0
    for info in infos:
        require(info.file_size <= MAX_ENTRY, f"oversized part: {info.filename}")
        require(info.file_size / max(info.compress_size, 1) <= MAX_COMPRESSION_RATIO,
                f"suspicious compression ratio: {info.filename}")
        is_xml = info.filename in xml_names
        if is_xml:
            require(info.file_size <= MAX_XML_PART, f"oversized XML part: {info.filename}")
        chunks = []
        actual_size = 0
        with archive.open(info) as stream:
            while chunk := stream.read(64 * 1024):
                actual_size += len(chunk)
                actual_total += len(chunk)
                require(actual_size <= MAX_ENTRY, f"part exceeded read limit: {info.filename}")
                require(actual_total <= MAX_TOTAL_UNCOMPRESSED,
                        "archive exceeded total read limit")
                if is_xml:
                    chunks.append(chunk)
        require(actual_size == info.file_size, f"size mismatch: {info.filename}")
        if is_xml:
            etree.fromstring(b"".join(chunks), parser=SAFE_XML_PARSER)

@contextmanager
def validated_docx_source(path):
    """Yield one private, bounded snapshot for both validation and python-docx."""
    with Path(path).open("rb") as external_source, TemporaryFile() as source:
        copied = 0
        while chunk := external_source.read(64 * 1024):
            copied += len(chunk)
            require(copied <= MAX_ARCHIVE_BYTES, "compressed DOCX file size above limit")
            source.write(chunk)
        source.seek(0)
        with zipfile.ZipFile(source) as archive:
            validate_docx_archive(archive)
        source.seek(0)
        yield source

MC_NAMESPACE = "http://schemas.openxmlformats.org/markup-compatibility/2006"
MC_ALTERNATE_CONTENT = f"{{{MC_NAMESPACE}}}AlternateContent"
MC_CHOICE = f"{{{MC_NAMESPACE}}}Choice"
MC_FALLBACK = f"{{{MC_NAMESPACE}}}Fallback"
SUPPORTED_MC_NAMESPACE_URIS = {
    MC_NAMESPACE,
    qn("w:p").split("}", 1)[0][1:],
    qn("r:id").split("}", 1)[0][1:],
}

def alternate_content_branch(element):
    """Select the first Choice whose required namespace URIs are understood."""
    fallback = None
    for child in element.iterchildren():
        if child.tag == MC_CHOICE:
            required_prefixes = (child.get("Requires") or "").split()
            if required_prefixes and all(
                child.nsmap.get(prefix) in SUPPORTED_MC_NAMESPACE_URIS
                for prefix in required_prefixes
            ):
                return child
        elif child.tag == MC_FALLBACK and fallback is None:
            fallback = child
    return fallback

def unresolved_alternate_content(element):
    return {
        "kind": "AlternateContent",
        "requires": [
            (child.get("Requires") or "").split()
            for child in element.iterchildren()
            if child.tag == MC_CHOICE
        ],
        "reason": "no supported Choice and no Fallback",
    }

def iter_effective_children(root):
    """Yield one selected markup-compatibility branch, never Choice and Fallback."""
    for child in root.iterchildren():
        if child.tag != MC_ALTERNATE_CONTENT:
            yield "element", child
            continue
        branch = alternate_content_branch(child)
        if branch is None:
            yield "unreadable", unresolved_alternate_content(child)
        else:
            yield from iter_effective_children(branch)

def iter_part_blocks(root, parent):
    """Yield each paragraph/table once, descending through block content controls."""
    for child_kind, child in iter_effective_children(root):
        if child_kind == "unreadable":
            yield child_kind, child
            continue
        if child.tag == qn("w:p"):
            yield "paragraph", Paragraph(child, parent)
        elif child.tag == qn("w:tbl"):
            yield "table", Table(child, parent)
        elif child.tag == qn("w:altChunk"):
            relationship_id = child.get(qn("r:id"))
            part = getattr(parent, "part", None)
            relationship = None if part is None else part.rels.get(relationship_id)
            yield "unreadable", {
                "kind": "altChunk",
                "relationship_id": relationship_id,
                "target": None if relationship is None else relationship.target_ref,
                "content_type": None if relationship is None or relationship.is_external
                else relationship.target_part.content_type,
            }
        else:
            yield from iter_part_blocks(child, parent)

def iter_paragraph_items(paragraph):
    """Include runs/unreadable records in their selected, rendered order."""
    def walk(element):
        for child_kind, child in iter_effective_children(element):
            if child_kind == "unreadable":
                yield child_kind, child
                continue
            if child.tag == qn("w:r"):
                yield "run", Run(child, paragraph)
            elif child.tag != qn("w:p"):  # nested text-box paragraphs are yielded separately
                yield from walk(child)
    yield from walk(paragraph._p)

def iter_paragraph_runs(paragraph):
    """Yield only runs; paragraph_text separately reports unresolved alternatives."""
    for kind, item in iter_paragraph_items(paragraph):
        if kind == "run":
            yield item

def legacy_symbol_record(symbol):
    """Report font-specific w:sym content without guessing at a Unicode mapping."""
    font = symbol.get(qn("w:font"))
    character = symbol.get(qn("w:char"))
    return f"[unreadable legacy symbol font={font!r} char={character!r}]"

def run_text(run):
    pieces = []
    text_tags = {
        qn("w:br"), qn("w:cr"), qn("w:noBreakHyphen"), qn("w:ptab"),
        qn("w:t"), qn("w:tab"), qn("w:sym"),
    }
    for child_kind, child in iter_effective_children(run._r):
        if child_kind == "unreadable":
            pieces.append(f"[unreadable {child['kind']}: {child['reason']}]")
        elif child.tag in text_tags:
            pieces.append(legacy_symbol_record(child) if child.tag == qn("w:sym") else str(child))
    return "".join(pieces)

def paragraph_text(paragraph):
    pieces = []
    for kind, item in iter_paragraph_items(paragraph):
        pieces.append(
            run_text(item) if kind == "run"
            else f"[unreadable {item['kind']}: {item['reason']}]"
        )
    return "".join(pieces)

def cell_paragraph_text(paragraph):
    """Render cell controls as visible markers while honoring one MC branch."""
    pieces = []
    for kind, item in iter_paragraph_items(paragraph):
        if kind == "unreadable":
            pieces.append(f"[unreadable {item['kind']}: {item['reason']}]")
            continue
        for child_kind, child in iter_effective_children(item._r):
            if child_kind == "unreadable":
                pieces.append(f"[unreadable {child['kind']}: {child['reason']}]")
            elif child.tag == qn("w:t"):
                pieces.append(child.text or "")
            elif child.tag in (qn("w:tab"), qn("w:ptab")):
                pieces.append("<tab>")
            elif child.tag in (qn("w:br"), qn("w:cr")):
                pieces.append("<br>")
            elif child.tag == qn("w:noBreakHyphen"):
                pieces.append("-")
            elif child.tag == qn("w:sym"):
                pieces.append(legacy_symbol_record(child))
    return "".join(pieces)

def tc_text(tc, parent):
    """Cell text rebuilt per paragraph, keeping tabs and breaks visible.

    Joining only the w:t descendants concatenates separate paragraphs
    ("First" + "Second" -> "FirstSecond") and loses separators entirely.
    """
    paragraphs = []
    for kind, block in iter_part_blocks(tc, parent):
        if kind != "paragraph":  # nested tables are represented recursively, not duplicated here
            continue
        paragraphs.append(cell_paragraph_text(block))
    return " / ".join(paragraphs)

def iter_content_control_children(root, target_tag):
    """Find physical rows/cells through sdtContent without entering nested tables."""
    for child_kind, child in iter_effective_children(root):
        if child_kind == "unreadable":
            raise ValueError(
                f"unresolved AlternateContent while locating {target_tag}: {child}"
            )
        if child.tag == target_tag:
            yield child
        elif child.tag == qn("w:sdt"):
            for content in child.findall(qn("w:sdtContent")):
                yield from iter_content_control_children(content, target_tag)

def table_content(table):
    rows = []
    for row_element in iter_content_control_children(table._tbl, qn("w:tr")):
        rendered_cells = []
        row_properties = row_element.find(qn("w:trPr"))
        grid_before_node = None if row_properties is None else row_properties.find(qn("w:gridBefore"))
        grid_after_node = None if row_properties is None else row_properties.find(qn("w:gridAfter"))
        grid_before = 0 if grid_before_node is None else int(grid_before_node.get(qn("w:val"), "0"))
        grid_after = 0 if grid_after_node is None else int(grid_after_node.get(qn("w:val"), "0"))
        column = grid_before
        # row.cells repeats a merge-origin proxy for every grid position it spans.
        # Walk physical w:tc elements and expose the merge structure instead.
        for cell_element in iter_content_control_children(row_element, qn("w:tc")):
            cell_properties = cell_element.find(qn("w:tcPr"))
            grid_span = None if cell_properties is None else cell_properties.find(qn("w:gridSpan"))
            colspan = 1 if grid_span is None else int(grid_span.get(qn("w:val"), "1"))
            vertical = None if cell_properties is None else cell_properties.find(qn("w:vMerge"))
            vertical_merge = None if vertical is None else vertical.get(qn("w:val"), "continue")
            nested_tables = []
            unreadable = []
            for kind, block in iter_part_blocks(cell_element, table):
                if kind == "table":
                    nested_tables.append(table_content(block))
                elif kind == "unreadable":
                    unreadable.append(block)
            rendered_cells.append({
                "column": column, "colspan": colspan,
                "vMerge": vertical_merge,
                "text": tc_text(cell_element, table),
                "tables": nested_tables,
                "unreadable": unreadable,
            })
            column += colspan
        rows.append({
            "grid_before": grid_before,
            "cells": rendered_cells,
            "grid_after": grid_after,
        })
    return rows

with validated_docx_source("input.docx") as source:
    doc = Document(source)
    content_controls = list(doc.element.body.iter(qn("w:sdt")))
    blocks = list(iter_part_blocks(doc.element.body, doc))
    print("content controls:", len(content_controls), "top-level blocks:", len(blocks))
    for kind, block in blocks:
        if kind == "paragraph":
            print(block.style.name, "|", paragraph_text(block))
        elif kind == "table":
            print("table |", table_content(block))
        else:
            print("unreadable |", block)
```

Notes:

- `doc.paragraphs` includes only direct body paragraphs, `doc.tables` includes only direct body
  tables, and `Paragraph.runs` omits runs wrapped by inline content controls and other containers.
  Use the XML-backed traversal above and report the content-control count. It stops descending
  when a table is yielded, so table text is not also emitted as prose; `table_content()` handles
  nested tables recursively and emits `grid_before`, `grid_after`, `column`, `colspan`, and
  `vMerge` metadata for physical cells instead of duplicating merge-origin text through
  `row.cells`. It walks physical rows and cells through `w:sdtContent`; python-docx's public row
  and cell collections omit those wrapped elements. The row-level grid omissions are required
  for nonuniform tables whose cells do not start in logical column zero or do not extend to the
  final grid column.
  `mc:AlternateContent` is evaluated once: the first Choice whose required namespace URIs this
  extractor understands wins, otherwise the Fallback is used. An alternative without either a
  supported Choice or a Fallback is reported as unreadable; mutually exclusive branches must
  never be concatenated.
  Imported `w:altChunk` HTML/RTF/document parts are not modeled by python-docx; the traversal
  reports their relationship target and content type as `unreadable` instead of silently
  presenting an incomplete extraction. Convert them with a trusted office renderer before
  claiming their content was read. Each table-cell record carries its own `unreadable` list so
  an import nested in a cell is not lost from the report.
  A legacy `w:sym` code is specific to its symbol font, so the helpers preserve its position
  as an explicit unreadable record containing the font and character code rather than silently
  dropping visible content or guessing a Unicode character.
  Text boxes, headers, footers, and footnotes still require their own collections
  (`section.header/.footer`) or raw XML.
- For revision/comment metadata, inspect the XML parts directly: `word/comments.xml`,
  `w:ins`/`w:del` elements in `word/document.xml`.

## Reporting contract

When summarizing a document for the user, lead with: heading outline, paragraph count, table
count with dimensions, and any parts that could not be read. Do not silently skip unreadable
parts.
