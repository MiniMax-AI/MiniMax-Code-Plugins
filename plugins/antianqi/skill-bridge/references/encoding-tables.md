# Encoding Tables

> v0.1 status: the converter only distinguishes **UTF-8** vs **GBK**. We do not
> maintain a static GBK→Unicode table; we use `iconv-lite` for full-table
> decode when needed.
>
> This document explains the detection algorithm so future contributors can
> extend it to GB2312, Big5, etc.

## How detection works

1. Read the file as raw bytes.
2. Try strict UTF-8 decode (no replacement chars = success).
3. Else try `iconv-lite` GBK decode. If it yields CJK characters without replacement chars, the source is GBK → re-decode and continue.
4. Else: declare `unknown`; leave as lossy UTF-8; warn the user.

## Why not `chardet`?

`chardet` (and `franc` for languages) is a probabilistic library. In our use case the false-positive cost is high: silently mis-decoding a SKILL.md produces a skill that loads but contains garbled instructions. The "two passes, prefer the one with no replacement chars" approach has a low false-positive rate for the binary-clean files we care about.

## GBK vs GB18030 vs GB2312

GB18030 is a superset of GBK which is a superset of GB2312. `iconv-lite` supports GBK and GB18030 out of the box; we use GBK because that's what we observed in the openclaw workspace dumps. If you see GB18030-only files (rare), switch the encoding name in `lib/detect.js`.

## Filename mojibake

GBK **filenames** (vs GBK **file contents**) are a separate, harder problem:

- A GBK-encoded filename is stored as raw bytes on disk (NTFS / ext4 store bytes; the encoding is only a convention).
- Reading a directory listing via `Get-ChildItem` (PowerShell) returns names in the **system code page** on Windows (CP936 for Chinese systems) — and loses information if the system code page is different.
- There is no "GBK filename to UTF-8 filename" mapping without a complete byte-level decode of the directory.

For v0.1, we do NOT rename files. We surface the warning and let the user rename manually:

```
$ mcode-skill-bridge suggest-filename  '�̾�����.md'
```

(planned for v0.2; for now, the CLI's `analyze` command flags the directory listing.)

## Extending

To add support for a new encoding:

1. Add the encoding name to `lib/detect.js`:
   ```js
   if (iconv.encodingExists('big5')) {
     // try Big5 decode
   }
   ```
2. Add a fixture under `tests/fixtures/encoding/big5.txt` and a test in `tests/detect.test.mjs`.
3. Update this document.

## Why we don't bundle a GBK table

`iconv-lite`'s GBK table is ~50KB compressed. Bundling our own would double the package size for a single encoding. If `iconv-lite` ever stops working for us, we can ship a minimal table covering the GBK basic range (0x8140-0xFEFE, ~21000 entries) as a separate npm package.
