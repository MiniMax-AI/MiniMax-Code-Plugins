---
name: literature-survey
description: >-
  当用户需要对已检索到的文献集合做整体分析、写文献调研报告、梳理某领域的
  研究概况 / 共识 / 争议 / 空白、提取文献证据为综述写作做准备时使用。
  同义场景：文献综述分析、领域调研、研究现状梳理、证据提取、文献精读笔记、
  "帮我分析这批论文讲了什么""这个领域的研究现状如何""这些文献有什么共识和分歧"。
argument-hint: '[主题或 papers.json 路径]'
metadata:
  domains: [literature]
  last_reviewed: '2026-08-18'
---

# literature-survey：文献集合全局分析

## 目的

读取 literature-search 产出的 `papers.json`，逐篇提取证据（EvidenceItem），
再按 8 个固定字段做全局综合，产出可被 review-writing 直接引用的
`evidence.json` 与 `survey.md`。

铁律：每一条 EvidenceItem 的 `quote` 必须来自真实读到的文本；读不到全文就
只基于摘要并标注 `abstract-only`；任何字段没有证据就写「现有检索结果不足以
支撑」，禁止编凑。

## 前置检查

1. `output/literature-search/<slug>/latest/papers.json` 存在且非空；
   若用户直接给了 papers.json 路径，以该文件为准。
2. 条目关键字段（title / abstract）大体完整；大面积缺 abstract 时提醒用户
   分析深度将受限，并询问是否继续。
3. slug 与上游一致：主题字符串做 Unicode NFKC 规范化、转小写、去首尾空白、
   连续空白折叠为单个空格后，取 sha1 十六进制摘要前 8 位。

## 操作规程

### 1. 逐篇提取 EvidenceItem

对每篇 PaperDocument：

- 通读可及文本（abstract 必有；url 指向开放获取页面时可尝试读取更多正文）。
- 提取 1-5 条 EvidenceItem：
  `{paper_id, claim, quote, page, confidence}`。
  - `claim`：用自己的话概括该文献支撑的一个论断；
  - `quote`：逐字摘录支撑该论断的原文句子——必须是真实读到的文本，
    不得凭印象改写；
  - `page`：全文可得时填页码或小节号；只有摘要时填 `"abstract"`；
  - `confidence`：`high`（全文核读）/ `medium`（摘要 + 部分正文）/
    `abstract-only`（仅摘要可读）。
- 读不到全文的一律标 `abstract-only`，claim 措辞随之保守化
  （用「该文摘要称……」而非直接断言）。

confidence 判定细则：

| 等级 | 含义 | 典型情形 |
| --- | --- | --- |
| high | 全文可读且已核读相关段落 | 开放获取正文可及 |
| medium | 摘要 + 部分正文（引言 / 结论）可读 | 页面仅公开部分章节 |
| abstract-only | 仅摘要可读 | 付费墙或仅元数据 |

提取数量与排除规则：

- 每篇 1-5 条，按与主题的相关度取量：核心文献取满，边缘文献 1 条即可；
- 同一 claim 不从同一篇重复提取；
- 与主题明显无关的文献不强行提取，在 survey.md 末尾附「已排除」清单及原因。

### 2. 全局综合：8 字段

严格按以下固定字段名输出——字段名一个都不能改，它们同时是
review-writing 中 evidence-map 的白名单：

1. **领域整体研究概况**：该文献集合勾勒出的领域全貌与核心问题。
2. **共性共识**：多篇文献一致认同的结论或做法。
3. **争议矛盾**：文献之间结论冲突或立场分歧之处。
4. **研究空白**：集合中无人解决、或被明确指出的未解问题。
5. **时序演化**：按年份梳理研究重心与方法随时间的变化。
6. **方法迭代**：关键技术路线的演进脉络（谁改进谁、解决了什么）。
7. **子主题横向对比**：把文献按子主题分组，横向比较目标 / 方法 / 结论。
8. **总结展望**：基于以上 7 项的综合判断与可能的下一步方向。

### 3. 论断挂证据

- 8 字段下的每个论断句末尾挂 EvidenceItem 引用：`[paper_id]`，
  多条并列用 `[paper_id1, paper_id2]`。
- 每个论断至少 1 条证据；共识类论断至少 2 条来自不同文献的证据。
- 某字段凑不出任何有证据的论断 → 该字段只写一句
  「现有检索结果不足以支撑此部分分析」，禁止编凑。

### 4. 落盘

目录 `output/literature-survey/<slug>/latest/`：

- `evidence.json`：全部 EvidenceItem 数组；
- `survey.md`：按 8 字段组织的分析正文，论断带 `[paper_id]` 引用。

## 输出模板

### evidence.json

```json
[
  {
    "paper_id": "https://openalex.org/W0123456789",
    "claim": "Transformer 完全基于注意力机制即可取得当时最优机器翻译效果",
    "quote": "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms ...",
    "page": "abstract",
    "confidence": "abstract-only"
  }
]
```

### survey.md 骨架

```markdown
# <主题> 文献调研分析

## 领域整体研究概况
……[paper_id]……

## 共性共识
……[paper_id1, paper_id2]……

## 争议矛盾
……

## 研究空白
……

## 时序演化
……

## 方法迭代
……

## 子主题横向对比
……

## 总结展望
……
```

## 本技能不做什么

- 不写成文综述（交给 review-writing）；`survey.md` 是分析底稿而非成稿。
- 不编造 quote 或页码；读不到就标 `abstract-only`。
- 不核验参考文献真伪（交给 citation-verify）。
- 不补充新检索；证据不足时如实标注，而不是自己临时补文献。
- 不输出 8 字段之外的分析维度（新增维度会破坏 evidence-map 白名单契约）。

## 收尾与下一步

1. 汇总：文献篇数、EvidenceItem 条数、8 字段中证据充足 / 不足各几项。
2. 指向 `output/literature-survey/<slug>/latest/`。
3. 建议下一步：运行 review-writing 成文；或对证据不足的字段回到
   literature-search 定向补检后重新分析。
