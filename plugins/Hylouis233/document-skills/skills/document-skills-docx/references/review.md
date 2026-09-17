# Review / repair a DOCX

## Symptom-driven triage

| Symptom | Likely cause | Fix route
|---|---|---|
File will not open at all | broken ZIP (truncated, wrong repack) | run the bounded health check below; if entries are damaged, recover from the user's original or prior version |
Opens with "unreadable content" repair prompt | content-types / rels mismatch, invalid XML | Tier 2 surgery: validate XML parses, check `[Content_Types].xml` covers every part extension |
Text present but styles lost | document rebuilt from scratch instead of edited | redo as edit on the original package |
Images missing | media parts not repacked or rels broken | verify `word/media/*` exist and `document.xml.rels` references them |
Fonts render differently on another machine | non-embedded fonts | expected; report which fonts are referenced (`w:rFonts` values) |

## Programmatic health check

```python
import zipfile
from pathlib import Path
from lxml import etree

path = "input.docx"
MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_MEMBERS = 10_000
MAX_XML_PART = 20 * 1024 * 1024
MAX_ENTRY = 100 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED = 500 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types"

# Security limits must survive `python -O` (which strips assert statements),
# so every check raises explicitly instead of asserting.
def require(condition, message):
    if not condition:
        raise ValueError(message)

safe_xml_parser = etree.XMLParser(
    load_dtd=False,
    resolve_entities=False,
    no_network=True,
    huge_tree=False,
    recover=False,
)

def xml_content_type(value):
    media_type = (value or "").split(";", 1)[0].strip().casefold()
    return media_type in {"application/xml", "text/xml"} or media_type.endswith("+xml")

def declared_xml_parts(archive, infos):
    """Classify XML from OPC declarations plus conventional suffixes."""
    by_name = {info.filename: info for info in infos}
    content_types_info = by_name.get("[Content_Types].xml")
    require(content_types_info is not None, "missing [Content_Types].xml")
    require(content_types_info.file_size <= MAX_XML_PART,
            "oversized XML part: [Content_Types].xml")
    with archive.open(content_types_info) as stream:
        content_types_blob = stream.read(MAX_XML_PART + 1)
    require(len(content_types_blob) <= MAX_XML_PART,
            "oversized XML part: [Content_Types].xml")
    root = etree.fromstring(content_types_blob, parser=safe_xml_parser)
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
# Check the package itself before ZipFile materializes its central directory.
require(Path(path).stat().st_size <= MAX_ARCHIVE_BYTES,
        "compressed DOCX file size above limit")
with zipfile.ZipFile(path) as z:
    infos = z.infolist()
    # Check the count before building sets, summing sizes, or opening any member.
    require(len(infos) <= MAX_MEMBERS, "archive member count above limit")
    names = {info.filename for info in infos}
    require(len(names) == len(infos), "duplicate archive member names are unsafe")
    require("[Content_Types].xml" in names and "word/document.xml" in names,
            "missing required OPC members")
    require(sum(info.file_size for info in infos) <= MAX_TOTAL_UNCOMPRESSED,
            "declared total uncompressed size above limit")
    xml_names = declared_xml_parts(z, infos)
    actual_total = 0
    for info in infos:
        require(info.file_size <= MAX_ENTRY, f"oversized part: {info.filename}")
        ratio = info.file_size / max(info.compress_size, 1)
        require(ratio <= MAX_COMPRESSION_RATIO, f"suspicious compression ratio: {info.filename}")
        is_xml = info.filename in xml_names
        if is_xml:
            require(info.file_size <= MAX_XML_PART, f"oversized XML part: {info.filename}")
        chunks = []
        actual_size = 0
        # Stream every bounded member to verify decompression and CRC. Do not call testzip()
        # before the limits: it would expand every member regardless of declared risk.
        with z.open(info) as stream:
            while chunk := stream.read(64 * 1024):
                actual_size += len(chunk)
                actual_total += len(chunk)
                require(actual_size <= MAX_ENTRY, f"part exceeded read limit: {info.filename}")
                require(actual_total <= MAX_TOTAL_UNCOMPRESSED, "archive exceeded total read limit")
                if is_xml:
                    chunks.append(chunk)
        require(actual_size == info.file_size, f"size mismatch: {info.filename}")
        if is_xml:
            etree.fromstring(b"".join(chunks), parser=safe_xml_parser)
```

These limits are conservative review defaults, not a DOCX specification. Raise one only for an
explicitly trusted, expected large input, and keep the streaming/per-part checks in place.

Then the SKILL.md postcheck (python-docx re-open, optional soffice PDF smoke test).

## Report format

State what is broken, the minimal repair applied, and what could not be verified without the
target viewer (exact pagination, field updates, embedded font rendering).
