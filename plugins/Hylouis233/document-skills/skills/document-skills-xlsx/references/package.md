# Bounded XLSX package loading

Every route that opens an existing `.xlsx`, `.xlsm`, or `.xltx` must preflight the package
before `openpyxl` or route-specific ZIP/XML inspection parses it. Copy these helpers into the
working script. `validated_xlsx_source()` supplies a bounded raw package handle;
`load_validated_workbook()` loads a normal workbook; and `open_validated_workbook()` keeps a
read-only source handle alive until its workbook is closed. Every helper validates and parses
the same open-file identity.

```python
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from defusedxml import ElementTree as DefusedET
from openpyxl.utils.cell import range_boundaries
from tempfile import TemporaryFile
import openpyxl
import zipfile

CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
SPREADSHEETML_NAMESPACES = {
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "http://purl.oclc.org/ooxml/spreadsheetml/main",
}
WORKSHEET_CELL_TAGS = {
    f"{{{namespace}}}c" for namespace in SPREADSHEETML_NAMESPACES
}
WORKSHEET_RANGE_TAGS = {
    f"{{{namespace}}}{local_name}"
    for namespace in SPREADSHEETML_NAMESPACES
    for local_name in ("mergeCell", "hyperlink")
}
WORKSHEET_SINGLE_CELL_REF_TAGS = {
    f"{{{namespace}}}comment" for namespace in SPREADSHEETML_NAMESPACES
}
WORKSHEET_MULTI_RANGE_TAGS = {
    f"{{{namespace}}}{local_name}"
    for namespace in SPREADSHEETML_NAMESPACES
    for local_name in ("conditionalFormatting", "dataValidation", "scenarios")
}
MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_MEMBERS = 10_000
MAX_XML_PART = 20 * 1024 * 1024
MAX_WORKSHEET_XML = 100 * 1024 * 1024
MAX_ENTRY = 100 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED = 500 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
MAX_WORKSHEET_MATERIALIZED_CELLS = 1_000_000
MAX_WORKSHEET_RANGE_LIST_CHARS = 65_536
MAX_WORKSHEET_RANGE_TOKENS = 100_000

def require(condition, message):
    """Security gates must remain active under python -O."""
    if not condition:
        raise ValueError(message)

def canonical_member_name(name):
    """Reject ambiguous, absolute, or parent-traversing OPC member names."""
    require(name and "\\" not in name and "\x00" not in name,
            f"invalid archive member name: {name!r}")
    is_directory = name.endswith("/")
    path = name[:-1] if is_directory else name
    require(path and not path.startswith("/"), f"absolute archive member path: {name}")
    parts = path.split("/")
    require(all(part not in ("", ".", "..") for part in parts),
            f"non-canonical archive member path: {name}")
    canonical = PurePosixPath(*parts).as_posix() + ("/" if is_directory else "")
    require(canonical == name, f"non-canonical archive member path: {name}")
    return canonical.casefold()

def safe_xml_root(blob, member_name):
    try:
        return DefusedET.fromstring(
            blob, forbid_dtd=True, forbid_entities=True, forbid_external=True
        )
    except Exception as error:
        raise ValueError(f"unsafe or malformed XML part: {member_name}") from error

def worksheet_element_cell_cost(element, member_name):
    """Bound cells that openpyxl creates while binding worksheet XML."""
    tag = element.tag
    if tag in WORKSHEET_CELL_TAGS:
        return 1
    if tag not in WORKSHEET_RANGE_TAGS | WORKSHEET_SINGLE_CELL_REF_TAGS:
        return 0
    reference = element.get("ref") or ""
    require(reference and len(reference) <= 64,
            f"invalid materialized worksheet range in {member_name}: {reference!r}")
    try:
        min_column, min_row, max_column, max_row = range_boundaries(reference)
    except (TypeError, ValueError) as error:
        raise ValueError(
            f"invalid materialized worksheet range in {member_name}: {reference!r}"
        ) from error
    require(
        all(isinstance(value, int) for value in
            (min_column, min_row, max_column, max_row))
        and 1 <= min_column <= max_column <= 16_384
        and 1 <= min_row <= max_row <= 1_048_576,
        f"invalid materialized worksheet range in {member_name}: {reference!r}",
    )
    if tag in WORKSHEET_SINGLE_CELL_REF_TAGS:
        require(
            min_column == max_column and min_row == max_row,
            f"comment reference must identify one cell in {member_name}: {reference!r}",
        )
    return (max_column - min_column + 1) * (max_row - min_row + 1)

def worksheet_element_range_token_cost(element, member_name):
    """Bound MultiCellRange objects constructed from worksheet sqref lists."""
    if element.tag not in WORKSHEET_MULTI_RANGE_TAGS:
        return 0
    reference = element.get("sqref") or ""
    require(
        len(reference) <= MAX_WORKSHEET_RANGE_LIST_CHARS,
        f"worksheet range list is too long in {member_name}",
    )
    return len(reference.split())

def read_bounded_member(archive, info, limit, *, capture):
    chunks = [] if capture else None
    actual_size = 0
    with archive.open(info) as stream:
        while chunk := stream.read(64 * 1024):
            actual_size += len(chunk)
            require(actual_size <= limit, f"part exceeded read limit: {info.filename}")
            if chunks is not None:
                chunks.append(chunk)
    require(actual_size == info.file_size, f"size mismatch: {info.filename}")
    return b"".join(chunks) if chunks is not None else actual_size

def validate_xlsx_package(source):
    """Bound every member before openpyxl sees this same seekable source."""
    source.seek(0, 2)
    compressed_size = source.tell()
    source.seek(0)
    require(compressed_size <= MAX_ARCHIVE_BYTES, "compressed XLSX file size above limit")
    try:
        archive_context = zipfile.ZipFile(source)
    except zipfile.BadZipFile as error:
        raise ValueError("input is not a valid XLSX ZIP package") from error
    with archive_context as archive:
        infos = archive.infolist()
        require(len(infos) <= MAX_MEMBERS, "archive member count above limit")
        names = {info.filename for info in infos}
        require(len(names) == len(infos), "duplicate archive member names are unsafe")
        canonical_names = [canonical_member_name(info.filename) for info in infos]
        require(len(set(canonical_names)) == len(canonical_names),
                "archive member names collide case-insensitively")
        require(all(not (info.flag_bits & 1) for info in infos),
                "encrypted archive members are not supported")
        require(
            {"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"} <= names,
            "required XLSX package parts are missing",
        )
        require(sum(info.file_size for info in infos) <= MAX_TOTAL_UNCOMPRESSED,
                "declared total uncompressed size above limit")

        content_types_info = next(
            info for info in infos if info.filename == "[Content_Types].xml"
        )
        require(content_types_info.file_size <= MAX_XML_PART,
                "oversized XML part: [Content_Types].xml")
        require(
            content_types_info.file_size / max(content_types_info.compress_size, 1)
            <= MAX_COMPRESSION_RATIO,
            "suspicious compression ratio: [Content_Types].xml",
        )
        content_types_blob = read_bounded_member(
            archive, content_types_info, MAX_XML_PART, capture=True
        )
        content_types_root = safe_xml_root(content_types_blob, "[Content_Types].xml")
        require(content_types_root.tag == f"{{{CONTENT_TYPES_NS}}}Types",
                "invalid content-types root")
        default_types = {}
        override_types = {}
        for declaration in content_types_root:
            if declaration.tag == f"{{{CONTENT_TYPES_NS}}}Default":
                key = (declaration.get("Extension") or "").casefold()
                target = default_types
            elif declaration.tag == f"{{{CONTENT_TYPES_NS}}}Override":
                part_name = declaration.get("PartName") or ""
                require(part_name.startswith("/"), "invalid content-type part name")
                key = canonical_member_name(part_name[1:])
                target = override_types
            else:
                continue
            content_type = declaration.get("ContentType") or ""
            require(key and content_type and key not in target,
                    "invalid or duplicate content-type declaration")
            target[key] = content_type.partition(";")[0].strip().casefold()

        actual_total = len(content_types_blob)
        worksheet_materialized_cells = 0
        worksheet_range_tokens = 0
        for info in infos:
            require(info.file_size <= MAX_ENTRY, f"oversized part: {info.filename}")
            require(
                info.file_size / max(info.compress_size, 1) <= MAX_COMPRESSION_RATIO,
                f"suspicious compression ratio: {info.filename}",
            )
            extension = info.filename.rpartition(".")[2].casefold()
            content_type = override_types.get(
                canonical_member_name(info.filename), default_types.get(extension, "")
            )
            is_xml = (
                info.filename.casefold().endswith((".xml", ".rels"))
                or content_type in {"application/xml", "text/xml"}
                or content_type.endswith("+xml")
            )
            is_worksheet_xml = (
                is_xml
                and info.filename.casefold().startswith("xl/worksheets/")
                and content_type.endswith(".worksheet+xml")
            )
            if is_xml:
                xml_limit = MAX_WORKSHEET_XML if is_worksheet_xml else MAX_XML_PART
                require(info.file_size <= xml_limit,
                        f"oversized XML part: {info.filename}")
            if info.filename == "[Content_Types].xml":
                blob = content_types_blob
            else:
                member_data = read_bounded_member(
                    archive, info, xml_limit if is_xml else MAX_ENTRY,
                    capture=is_xml and not is_worksheet_xml,
                )
                actual_size = (
                    len(member_data) if is_xml and not is_worksheet_xml else member_data
                )
                actual_total += actual_size
                require(actual_total <= MAX_TOTAL_UNCOMPRESSED,
                        "archive exceeded total read limit")
                blob = member_data if is_xml and not is_worksheet_xml else None
            if is_worksheet_xml:
                try:
                    with archive.open(info) as stream:
                        for _, element in DefusedET.iterparse(
                            stream, events=("end",), forbid_dtd=True,
                            forbid_entities=True, forbid_external=True,
                        ):
                            worksheet_materialized_cells += worksheet_element_cell_cost(
                                element, info.filename
                            )
                            worksheet_range_tokens += worksheet_element_range_token_cost(
                                element, info.filename
                            )
                            require(
                                worksheet_materialized_cells
                                <= MAX_WORKSHEET_MATERIALIZED_CELLS,
                                "worksheet cell materialization budget exceeded",
                            )
                            require(
                                worksheet_range_tokens <= MAX_WORKSHEET_RANGE_TOKENS,
                                "worksheet range-token budget exceeded",
                            )
                            element.clear()
                except Exception as error:
                    if isinstance(error, ValueError):
                        raise
                    raise ValueError(
                        f"unsafe or malformed XML part: {info.filename}"
                    ) from error
            elif is_xml and info.filename != "[Content_Types].xml":
                xml_root = safe_xml_root(blob, info.filename)
                for element in xml_root.iter():
                    worksheet_materialized_cells += worksheet_element_cell_cost(
                        element, info.filename
                    )
                    worksheet_range_tokens += worksheet_element_range_token_cost(
                        element, info.filename
                    )
                    require(
                        worksheet_materialized_cells
                        <= MAX_WORKSHEET_MATERIALIZED_CELLS,
                        "worksheet cell materialization budget exceeded",
                    )
                    require(
                        worksheet_range_tokens <= MAX_WORKSHEET_RANGE_TOKENS,
                        "worksheet range-token budget exceeded",
                    )
    source.seek(0)

@contextmanager
def validated_xlsx_source(path):
    """Yield a private validated snapshot, isolated from later path mutation."""
    with Path(path).open("rb") as external_source, TemporaryFile() as source:
        copied_size = 0
        while chunk := external_source.read(64 * 1024):
            copied_size += len(chunk)
            require(copied_size <= MAX_ARCHIVE_BYTES,
                    "compressed XLSX file size above limit")
            source.write(chunk)
        source.flush()
        source.seek(0)
        validate_xlsx_package(source)
        source.seek(0)
        yield source

def load_validated_workbook(path, **options):
    """Load a non-streaming workbook from the exact handle that passed preflight."""
    require(not options.get("read_only"),
            "use open_validated_workbook for read_only=True")
    with validated_xlsx_source(path) as source:
        return openpyxl.load_workbook(source, **options)

@contextmanager
def open_validated_workbook(path, **options):
    """Keep the validated source alive until its openpyxl workbook is closed."""
    with validated_xlsx_source(path) as source:
        workbook = openpyxl.load_workbook(source, **options)
        try:
            yield workbook
        finally:
            workbook.close()
```

Do not weaken these bounds in a route-specific copy. A task may choose smaller limits. If a
valid workbook exceeds a limit, report the limit and ask the user before raising it; never retry
an untrusted package without bounds.
