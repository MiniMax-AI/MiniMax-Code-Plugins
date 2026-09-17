# Edit an existing DOCX

Editing has two tiers. Pick the lowest tier that can express the change.

## Tier 1 - python-docx structural edits (preferred)

python-docx opens the real package and rewrites it safely. Use it for: adding/removing
paragraphs, tables, images; changing styles; editing text of a specific run; find-replace over
paragraph text.

```python
from docx import Document
from docx.oxml.ns import qn

SAFE_RUN_CHILDREN = {
    qn("w:rPr"), qn("w:t"), qn("w:tab"), qn("w:cr"),
}
MODELED_PARAGRAPH_CHILDREN = {qn("w:pPr"), qn("w:r")}

def unsafe_run_content(run):
    unsafe = []
    for child in run._r:
        # Assigning run.text can reconstruct text, tabs, and ordinary line breaks only.
        ordinary_break = child.tag == qn("w:br") and dict(child.attrib) in (
            {}, {qn("w:type"): "textWrapping"},
        )
        if child.tag not in SAFE_RUN_CHILDREN and not ordinary_break:
            unsafe.append(child.tag.rsplit("}", 1)[-1])
    return unsafe

def replace_across_runs(paragraph, old, new):
    """Replace text-only matches; reject drawings, fields, and other lossy run content."""
    if not old:
        raise ValueError("old must not be empty")

    unmodeled = [
        child.tag.rsplit("}", 1)[-1]
        for child in paragraph._p
        if child.tag not in MODELED_PARAGRAPH_CHILDREN
    ]
    if unmodeled:
        raise ValueError(f"paragraph contains unmodeled inline containers: {unmodeled}")

    runs = list(paragraph.runs)
    text = "".join(run.text for run in runs)
    starts = []
    position = 0
    while (start := text.find(old, position)) != -1:
        starts.append(start)
        position = start + len(old)

    # Map each non-empty run to its character range in the original paragraph text.
    spans = []
    position = 0
    for index, run in enumerate(runs):
        end = position + len(run.text)
        if end > position:
            spans.append((index, position, end))
        position = end

    matches = []
    for start in starts:
        end = start + len(old)
        first, first_start, _ = next(s for s in spans if s[1] <= start < s[2])
        last, last_start, _ = next(s for s in spans if s[1] < end <= s[2])
        matches.append((start, end, first, first_start, last, last_start))

    # Validate every affected run before mutating any of them. Assigning run.text replaces the
    # run XML and would otherwise silently delete an inline drawing, field, footnote reference,
    # or a page/column break.
    affected_indexes = {
        index
        for _, _, first, _, last, _ in matches
        for index in range(first, last + 1)
    }
    unsafe = {}
    for index in affected_indexes:
        if children := unsafe_run_content(runs[index]):
            unsafe[index] = children
    if unsafe:
        raise ValueError(f"matched runs contain non-text content: {unsafe}")

    # Work backwards so changing a later match cannot move an earlier match.
    for start, end, first, first_start, last, last_start in reversed(matches):
        prefix = runs[first].text[:start - first_start]
        suffix = runs[last].text[end - last_start:]

        if first == last:
            runs[first].text = prefix + new + suffix
        else:
            runs[first].text = prefix + new
            for index in range(first + 1, last):
                runs[index].text = ""
            runs[last].text = suffix

    return len(starts)

doc = Document("input.docx")

# Address paragraphs by index over doc.paragraphs (body level). Tables' cells hold their own
# paragraphs: table.rows[i].cells[j].paragraphs
for par in doc.paragraphs:
    replace_across_runs(par, "TBD", "To be decided")

# Append content at a specific position: manipulate the XML tree
target = doc.paragraphs[7]._p
new_par = doc.add_paragraph("Inserted after the target.")
target.addnext(new_par._p)

doc.save("input.edited.docx")
```

The replacement text inherits the first matched run's formatting. Unmatched text before and
after it stays in its original runs, so its formatting is preserved. The routine fails before
making changes if the paragraph contains an inline container that `paragraph.runs` does not expose,
or if any matched run contains a drawing, field, reference, typed page/column break, or a
text-wrapping break with `w:clear` that `run.text` would destroy. Use raw OOXML for those cases.

## Tier 2 - raw OOXML surgery (only when Tier 1 cannot express it)

For field codes, sectPr surgery, tracked changes, or parts python-docx does not model.
Rules that keep the archive valid:

1. Operate on a **copy** of the file.
2. Run the bounded package validator below **before extracting anything**, then extract into a
   **new empty temporary directory for every input**. Never reuse a fixed `work/` directory:
   members absent from the next DOCX would remain there and be repacked as stale or confidential
   content.
3. Parse XML with `lxml`/`xml.etree` - never string replace. Text lives in `w:t` inside runs
   (`w:r`) inside paragraphs (`w:p`); a logical sentence can span several runs.
4. Repack with `[Content_Types].xml` first and stored/deflated entries only:

```python
import os
import unicodedata
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile
from lxml import etree

MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_MEMBERS = 10_000
MAX_XML_PART = 20 * 1024 * 1024
MAX_ENTRY = 100 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED = 500 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
MAX_MEMBER_COMPONENT_BYTES = 255
MAX_MEMBER_COMPONENT_UTF16_UNITS = 255
MAX_MEMBER_PATH_BYTES = 1024
MAX_MEMBER_PATH_UTF16_UNITS = 240
MAX_MEMBER_COMPONENTS = 64

def require(condition, message):
    if not condition:                       # remains active under python -O
        raise ValueError(message)

WINDOWS_DEVICE_NAMES = {
    "con", "prn", "aux", "nul", "conin$", "conout$",
    *(f"com{suffix}" for suffix in "123456789¹²³"),
    *(f"lpt{suffix}" for suffix in "123456789¹²³"),
}

def extraction_key(name):
    """Return a component key only for portable, canonical member names."""
    is_directory = name.endswith("/")
    path = name[:-1] if is_directory else name
    require(path and not name.startswith("/") and "\\" not in name,
            f"non-canonical archive member path: {name}")
    parts = path.split("/")
    require(len(parts) <= MAX_MEMBER_COMPONENTS,
            "archive member depth exceeds portable extraction limit")
    require(
        all(
            part not in {"", ".", ".."}
            and not any(character in ':<>|"?*' for character in part)
            and not any(ord(character) < 32 for character in part)
            and not part.endswith((".", " "))
            and unicodedata.normalize("NFC", part) == part
            and part.partition(".")[0].rstrip(" ").casefold() not in WINDOWS_DEVICE_NAMES
            for part in parts
        ),
        f"non-canonical archive member path: {name}",
    )
    require(
        all(
            len(part.encode("utf-8")) <= MAX_MEMBER_COMPONENT_BYTES
            and len(part.encode("utf-16-le")) // 2 <= MAX_MEMBER_COMPONENT_UTF16_UNITS
            for part in parts
        ),
        "archive member component exceeds portable extraction limit",
    )
    require(len(path.encode("utf-8")) <= MAX_MEMBER_PATH_BYTES
            and len(path.encode("utf-16-le")) // 2 <= MAX_MEMBER_PATH_UTF16_UNITS,
            "archive member path exceeds portable extraction limit")
    canonical = PurePosixPath(*parts).as_posix()
    require(canonical == path, f"non-canonical archive member path: {name}")
    key = tuple(unicodedata.normalize("NFC", part.casefold()) for part in parts)
    return key, tuple(parts), is_directory

def validate_extraction_paths(infos):
    """Reject aliases and file/directory collisions with a linear component trie."""
    root = {"children": {}, "member": False, "file": False, "spelling": None}
    for info in infos:
        key, spellings, is_directory = extraction_key(info.filename)
        node = root
        for normalized, spelling in zip(key, spellings):
            require(not node["file"],
                    "archive file and directory paths collide after extraction")
            child = node["children"].get(normalized)
            if child is None:
                child = {
                    "children": {}, "member": False, "file": False,
                    "spelling": spelling,
                }
                node["children"][normalized] = child
            else:
                require(child["spelling"] == spelling,
                        "archive member path spelling collides after extraction")
            node = child
        require(not node["member"], "archive member paths collide after extraction")
        require(is_directory or not node["children"],
                "archive file and directory paths collide after extraction")
        node["member"] = True
        node["file"] = not is_directory

safe_xml_parser = etree.XMLParser(
    load_dtd=False, resolve_entities=False, no_network=True,
    huge_tree=False, recover=False,
)

def validate_docx_archive(archive):
    """Enforce archive bounds and CRC before this same handle is extracted."""
    require(os.fstat(archive.fp.fileno()).st_size <= MAX_ARCHIVE_BYTES,
            "compressed DOCX file size above limit")
    infos = archive.infolist()
    require(len(infos) <= MAX_MEMBERS, "archive member count above limit")
    names = {info.filename for info in infos}
    require(len(names) == len(infos), "duplicate archive member names are unsafe")
    validate_extraction_paths(infos)
    require("[Content_Types].xml" in names and "word/document.xml" in names,
            "required DOCX package parts are missing")
    require(sum(info.file_size for info in infos) <= MAX_TOTAL_UNCOMPRESSED,
            "declared archive size exceeds the edit limit")
    actual_total = 0
    for info in infos:
        require(info.file_size <= MAX_ENTRY, f"oversized part: {info.filename}")
        require(
            info.file_size / max(info.compress_size, 1) <= MAX_COMPRESSION_RATIO,
            f"suspicious compression ratio: {info.filename}",
        )
        if info.filename.endswith((".xml", ".rels")):
            require(info.file_size <= MAX_XML_PART, f"oversized XML part: {info.filename}")
        actual_size = 0
        with archive.open(info) as stream:  # streams data and verifies its CRC
            while chunk := stream.read(64 * 1024):
                actual_size += len(chunk)
                actual_total += len(chunk)
                require(actual_size <= MAX_ENTRY, f"part exceeded read limit: {info.filename}")
                require(actual_total <= MAX_TOTAL_UNCOMPRESSED,
                        "archive exceeded total read limit")
        require(actual_size == info.file_size, f"size mismatch: {info.filename}")

input_path = Path("input.docx")
output_path = Path("output.docx").resolve()  # keep output outside the temporary tree
with TemporaryDirectory(prefix="docx-edit-") as scratch:
    src = Path(scratch)
    with ZipFile(input_path) as archive:
        validate_docx_archive(archive)         # same open handle; prevents validate/extract swap
        archive.extractall(src)

    # Apply the required XML edits under `src` here with `safe_xml_parser`.
    # Archive bounds are a safety gate, not a semantic XML-validity gate: Tier 2 may repair XML.
    content_types = src / "[Content_Types].xml"
    if not content_types.is_file():
        raise FileNotFoundError(content_types)
    files = sorted(
        (path for path in src.rglob("*") if path.is_file() and path != content_types),
        key=lambda path: path.relative_to(src).as_posix(),
    )

    with ZipFile(
        output_path, "w", compression=ZIP_DEFLATED, strict_timestamps=False
    ) as archive:
        archive.write(content_types, "[Content_Types].xml")
        for path in files:
            archive.write(path, path.relative_to(src).as_posix())
```

   The temporary directory is deleted after repacking. This writes relative POSIX archive names,
   does not add directory entries, and excludes `[Content_Types].xml` from the remaining files so
   it cannot be added twice.
5. If you touched part names or added parts, update `[Content_Types].xml` and
   `word/_rels/document.xml.rels` consistently - a mismatch here is the classic silent corrupt.

## Never do

- Blind find/replace on the raw XML string of `word/document.xml`.
- Deleting parts that look unused (styles, theme, settings) - viewers may require them.
- Editing a document that is open in Word (the save will collide with the lock file).

## Delivery

Save to `<original>-edited.docx` unless the user explicitly asked to overwrite. Run the
postcheck from SKILL.md step 4 on the output.
