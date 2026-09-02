---
name: review-writing
description: >-
  当用户需要基于文献证据撰写综述、写论文引言或相关工作、把文献调研结果组织成
  规范成文、生成带 GB/T 7714 参考文献的综述初稿时使用。同义场景：综述写作、
  文献综述成文、相关工作撰写、调研报告写作、生成参考文献列表、
  "帮我写一篇关于 X 的综述""把分析结果写成文章""整理成 GB/T 7714 格式"。
argument-hint: '[综述主题]'
metadata:
  domains: [literature]
  last_reviewed: '2026-08-18'
---

# review-writing：综述成文与引用管理

## 目的

基于 literature-survey 的 `survey.md` + `evidence.json` 和 literature-search 的
`papers.json`，完成「大纲 → 分节写作 → 自审修订 → 引用编号 → 参考文献」
全流程，产出综述初稿 `draft.md` 与双格式参考文献（GB/T 7714-2015 文本 +
`references.bib`）。

底线：只使用证据库中真实存在的文献与论断，不新增无源内容。

## 前置检查

1. `output/literature-survey/<slug>/latest/{survey.md, evidence.json}` 存在；
   `output/literature-search/<slug>/latest/papers.json` 存在。
2. 与用户确认综述类型（领域综述 / 相关工作 / 引言）与目标篇幅。
3. slug 与上游一致（规范化：Unicode NFKC、转小写、去首尾空白、连续空白
   折叠为单个空格，sha1 前 8 位）。

## 操作规程

### 1. 大纲设计（含 evidence-map 白名单校验）

- 设计分节大纲，每节含三个属性：`title`（节标题）、`task`（本节写作任务
  一句话）、`evidence-map`（本节允许使用的分析字段列表）。
- evidence-map **只能引用** literature-survey 的 8 个固定字段名：
  领域整体研究概况 / 共性共识 / 争议矛盾 / 研究空白 / 时序演化 /
  方法迭代 / 子主题横向对比 / 总结展望。
- 白名单校验：剔除无效项并记录到大纲文件；某节 evidence-map 被剔空时
  回到大纲重新设计，不得带着空证据映射开写。
- 大纲写入 `output/review-writing/<slug>/latest/outline.md`，
  请用户确认后再动笔。

### 2. 分节写作

- 逐节写作：本节只能使用其 evidence-map 所列字段下的论断与 EvidenceItem。
- 文中引用以临时标记 `[paper_id]` 随行插入。
- 每节写完立即自审一轮：① 每个事实性论断是否挂了证据；
  ② 是否越出 evidence-map 范围；③ 是否完成本节 task。
- 自审不通过则修订该节，**每节最多修订 2 轮**；2 轮后仍不达标的段落标
  **[待复核]** 并保留现稿，继续下一节，不卡死整体流程。

### 3. 引用管理（成文后）

- 通读全稿，按 paper_id 在文中首次出现的顺序，把临时标记重编号为
  [1][2][3]…。
- 删除无源引用标记：凡在 papers.json 中找不到对应 paper_id 的引用，
  连同其标记一并删除，并在 `citation-audit.md` 记录删除位置与原因。
- 确认每个编号在参考文献表中恰好对应一条目，编号连续、无跳号、无重号。

### 4. 参考文献双格式输出

GB/T 7714-2015 常见类型模板（作者超过 3 位时取前 3 位、后接「, 等」；
西文作者姓全大写、名取首字母）：

- 期刊 [J]：`主要责任者. 题名[J]. 刊名, 年, 卷(期): 起止页码. DOI: xxxx.`
- 会议 [C]：`主要责任者. 题名[C]//会议论文集名. 出版地: 出版者, 出版年: 起止页码.`
- 学位论文 [D]：`主要责任者. 题名[D]. 保存地: 保存单位, 年份.`
- 预印本（电子资源）[EB/OL]：
  `主要责任者. 题名[EB/OL]. (发布日期)[引用日期]. 获取地址.`
  例：`VASWANI A, SHAZEER N, PARMAR N, 等. Attention is all you need[EB/OL]. (2017-06-12)[2026-08-18]. https://arxiv.org/abs/1706.03762.`

同时生成 `references.bib`：每篇一条 BibTeX（article / inproceedings /
phdthesis / misc 且 note 标注 preprint），citekey 用
「第一作者姓 + 年份 + 标题首词」；字段取自 papers.json 原始元数据，
缺失字段宁缺毋假。

### 5. 落盘

目录 `output/review-writing/<slug>/latest/`：

- `outline.md`：大纲（含每节 task 与校验后的 evidence-map）；
- `draft.md`：综述初稿（含 [待复核] 标注，如有）；
- `references.txt`：GB/T 7714-2015 格式参考文献表；
- `references.bib`：BibTeX 参考文献库；
- `citation-audit.md`：重编号映射 + 无源引用删除记录 + [待复核] 清单。

### 6. 行文要求

- 学术中文为主；术语首次出现时保留英文原文并附中译；
- 每段聚焦一个论点，段首给主题句；
- 争议内容并列呈现双方证据，不做无依据的裁决；
- 图表引用仅在 evidence 中有对应来源时使用。

## 输出模板

### references.txt 完整示例

```text
[1] VASWANI A, SHAZEER N, PARMAR N, 等. Attention is all you need[C]//Advances in Neural Information Processing Systems 30. Long Beach: Curran Associates, 2017: 5998-6008.
[2] 张三, 李四. 深度学习综述方法研究[D]. 北京: 清华大学, 2022.
```

### references.bib 条目示例

```bibtex
@inproceedings{vaswani2017attention,
  title     = {Attention Is All You Need},
  author    = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and others},
  booktitle = {Advances in Neural Information Processing Systems 30},
  year      = {2017},
  pages     = {5998--6008}
}
```

### outline.md 节示例

```markdown
## 2. 研究方法演进
- task: 梳理主流技术路线的迭代脉络
- evidence-map: [方法迭代, 时序演化]
```

### draft.md 引用样式

```markdown
自注意力机制完全取代循环结构后，长程依赖建模能力显著提升[1]；
后续工作沿两条路线迭代：稀疏化注意力[2] 与线性化近似[3]。
```

（[1][2][3] 为按出现顺序重排后的编号，与 references.txt / references.bib
一一对应。）

## 本技能不做什么

- 不编造文献、不虚构引用；无源引用只删不留。
- 不新增 evidence.json 之外的事实性论断（常识性过渡句除外）。
- 不做参考文献真伪核验与正文支撑审查（成文后交给 citation-verify 等核验类 skill）。
- 不替用户决定综述观点立场；争议处并列呈现各方证据。
- 不突破每节 2 轮修订上限去无限打磨。

## 收尾与下一步

1. 汇总：章节数、引用篇数、[待复核] 段落数、删除的无源引用数。
2. 指向 `output/review-writing/<slug>/latest/` 全部产物。
3. **强制建议**：成文后运行 citation-verify 做闭环质检——
   - `citation-verify` 核验 `references.bib` 每条文献的真实性；
   - `claim-check` 复查 `draft.md` 的论断支撑；
   - 或直接运行 `evidence-loop`，一键走完核验-补检-修订闭环。
