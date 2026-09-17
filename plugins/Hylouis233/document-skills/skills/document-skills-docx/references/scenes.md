# Scene patterns: paper, resume, official document, contract

When the request matches a known scene, start from its skeleton instead of improvising
structure. Every scene below still goes through the normal create/edit route and postcheck;
this file only fixes structure, typography conventions, and scene-specific verification.

## Academic paper (中文学术论文 shape)

Skeleton: 标题 (二号黑体 or per journal) -> 作者 -> 单位 -> 摘要 -> 关键词 -> numbered body
(1 / 1.1 / 1.1.1) -> 参考文献 -> optional 附录/致谢.

- Headings carry the numbering as literal text when no journal template is supplied; heading
  styles stay semantic (`Heading 1..4`) so navigation and TOC keep working.
- Figures/tables: caption paragraph below the object, numbered per chapter
  (图 2-1 / 表 3-2); reference in text before the object appears.
- References: GB/T 7714 style is the common Chinese requirement - build each entry as a
  plain paragraph with a hanging indent, not a numbered Word list (journals re-style anyway).
- Fonts by convention: 正文宋体小四, fixed or 1.5 line spacing, first-line indent two chars -
  see [cjk.md](cjk.md) for the mechanics.
- Out of scope: equations as OMML and journal-specific LaTeX export - offer the PDF route or
  the journal's own template instead of hand-building OMML.

## Resume

- One page unless the user explicitly says otherwise; the constraint is content curation,
  not shrinking fonts below 10 pt.
- Structure: 姓名+联系方式 header -> 求职意向 (optional) -> 经历 (reverse chronological) ->
  教育 -> 技能. Section headings as `Heading 2`, entries as styled paragraphs, bullets via
  `List Bullet`.
- ATS-safe means: real text (no text boxes, no multi-column layout, no icons), standard
  section names, dates as plain text `2024-03` not fields.
- A single subtle table for the contact header is acceptable; skill-rating bars and other
  graphic devices are not - they print wrong and break parsers.
- Verify: render with soffice, confirm one page, confirm all text extracts from the PDF.

## Official document (公文, GB/T 9704 shape)

Structure: 版头 (发文机关标志+文号) -> 标题 (二号宋体加粗 per current practice) -> 主送机关 ->
正文 (三号仿宋) -> 附件说明 -> 发文机关署名+成文日期 -> 抄送 -> 印发信息.

- Body hierarchy is fixed: 一、 -> （一） -> 1. -> （1）; never skip or reorder levels.
- Page geometry and line spacing values: see [cjk.md](cjk.md) - the GB/T table and fixed
  28-30 pt spacing live there.
- The red 发文机关标志 header is a graphics-level element python-docx does not model;
  generate the document without it and tell the user to add it in their official template,
  or ask for their template file and edit inside it.
- Numbers: Arabic numerals for dates and quantities per the standard; 成文日期 as
  2026年8月16日 with Arabic numerals.

## Contract

Skeleton: 标题 -> 当事人 block (名称/住所/法定代表人 per party) -> 鉴于 (recitals, optional) ->
numbered 条款 -> 签署 block.

- Clause numbering as literal text with a fixed hierarchy (第一条 / 1.1 / (a)); do not use
  auto-numbered lists - counter restarts and cross-references become fragile.
- Defined terms: bold at first definition only; thereafter plain. Search for the term to
  confirm it is defined exactly once before bolding.
- Cross-references as literal text ("见第 5.2 条"); after edits, grep every 第 X 条 reference
  and verify the target still exists at that number.
- Signature block: a borderless 2-column table (甲方/乙方 rows for 签字、盖章、日期) at the
  end. `keep_with_next` on preceding paragraphs alone does not stop table rows from splitting
  across pages - apply the row-level guard to the table itself:

  ```python
  from docx.oxml import OxmlElement
  from docx.oxml.ns import qn

  def keep_table_together(table):
      for row in table.rows:
          trPr = row._tr.get_or_add_trPr()
          if trPr.find(qn("w:cantSplit")) is None:
              trPr.append(OxmlElement("w:cantSplit"))   # a row never splits mid-row
      for row in table.rows[:-1]:
          for cell in row.cells:
              for par in cell.paragraphs:
                  par.paragraph_format.keep_with_next = True  # row sticks to the next row
  ```

  Then verify in the rendered PDF that the whole block landed on one page.
- Verification beyond the standard postcheck: every defined term defined once; every
  cross-reference resolves; signature block on one page in the rendered PDF.

## Routing note

Scenes chain: pick the scene skeleton, then execute it through
[create.md](create.md) (new document) or [edit.md](edit.md) (user supplied a draft), applying
[cjk.md](cjk.md) whenever the document contains CJK text.
