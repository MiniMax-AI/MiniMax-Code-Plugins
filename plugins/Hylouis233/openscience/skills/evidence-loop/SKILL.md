---
name: evidence-loop
description: >-
  当用户希望一次性修好论文的证据链——先核验引用、再查正文支撑、对问题条目
  定向补检文献、迭代修订直到收敛——时使用。同义场景：证据闭环、
  引用修复流水线、核验-补检-修订迭代、边查边补、系统性消除无支撑论断、
  "帮我把这篇文章的引用问题全部查出来并补上文献""修到没有硬伤为止"。
argument-hint: '[论文草稿路径]'
metadata:
  domains: [verification]
  last_reviewed: '2026-08-18'
---

# evidence-loop：证据闭环编排器

## 目的

把 citation-verify（参考文献核验）、claim-check（正文支撑检查）、
literature-search（定向补检）串成一个最多 2 轮的闭环：

核验 → 汇总问题 → 定向补检 → 生成修订建议 → 用户确认 → 修订 → 复验。

每一轮的全部中间产物落盘，保证过程可审计、可回溯；任何一步失败都
结构化记录，不静默吞掉。

## 前置检查

1. 草稿存在且可读；其 `.bib` 或参考文献节能被 citation-verify 解析。
2. 本插件的 citation-verify、claim-check 可用；literature-search
   可用（补检依赖它；若不可用，闭环退化为「只查不补」，
   并在汇总中明确说明）。
3. bibverify MCP 可用（见 citation-verify 的前置检查）。
4. 与用户确认两条铁律：最大轮数固定为 2；每轮修订前必须经用户逐条确认。
5. 计算 slug：主题字符串做 Unicode NFKC 规范化、转小写、去首尾空白、
   连续空白折叠为单个空格后，取 sha1 十六进制摘要前 8 位。

## 操作规程

### 1. 第 R 轮核验（R 从 1 开始）

- 运行 citation-verify，收集：`identifier_conflict` 条目、`no_match` 条目、
  `rate_limited` 条目（稍后重试，不进补检）。
- 运行 claim-check，收集：无支撑 claim 清单、无源引用清单。
- 两份 ```review 结论原样归档到 `output/evidence-loop/<slug>/<R>/`。

### 2. 汇总问题清单

- 合并两类问题，按「位置 / 条目」去重，形成本轮问题清单 `problems.md`，
  每行含：问题类型（冲突引用 / 无支撑 claim / 无源引用 / 待人工核实）、
  位置、原文证据、所需动作。
- `rate_limited` 条目不进入补检，单独标注「稍后复验」。

### 3. 生成定向补检 query

逐条问题生成检索 query，写入 `queries.md`，每条注明对应的问题编号：

- 无支撑 claim：从 claim 原文提取核心名词与方法词，组合 2-4 个英文关键词；
  必要时附一个中文同义 query 供人工检索。
- `identifier_conflict`：用正确题录的标题关键词 + 第一作者姓，
  目标是找回正确文献的完整元数据。

### 4. 调用 literature-search 补检

- 逐条 query 调用 literature-search；provider 选择遵循
  其路由表（主题补检默认 OpenAlex，精确题录走 Crossref）。
- 补检失败（结构化 error）如实记录到本轮产物，不当作「没有文献」。
- 命中的 PaperDocument 追加到本轮 `candidates.json`。

### 5. 生成修订建议

写入 `output/evidence-loop/<slug>/<R>/revision-suggestions.md`，对每条问题
给出具体动作：

- 无支撑 claim → 从 candidates 中选 1-2 篇最相关文献，建议插入引用；
  新证据一律以 **[待复核]** 标注，要求用户确认其确实支撑该 claim。
- `identifier_conflict` → 附 `doi_to_bibtex` 拉取的正确条目与
  `explain_update_diff` 的字段级差异。
- 无源引用 → 建议删除引用标记，或指向补检命中的真实文献。

### 6. 用户确认与应用

- 逐条请用户确认：接受 / 拒绝 / 修改。
- 只对确认过的条目执行修订（改草稿、改 `.bib`）；未确认条目原样保留并
  继续标记。
- 修订完成后进入复验：R += 1，回到第 1 步。

### 7. 终止条件与决策树

满足任一条件即终止：

- 复验后无 error、无 warn（遗留 `rate_limited` 除外，单独说明）→ 成功收敛；
- 已完成 2 轮 → 停止迭代，输出遗留问题清单；
- 用户中止 → 保留当前稿与全部轮次产物；
- 连续 `rate_limited` / `auth_error` 导致无法继续 → 保留现状，如实说明。

决策树（文本版）：

```text
复验结果
├── 无 error 且无 warn ─────────────→ 收敛，输出 final-summary
├── 仍有可补检问题 且 轮数 < 2 ──────→ 回到第 3 步继续补检
├── 仍有可补检问题 且 轮数 = 2 ──────→ 终止，遗留项标 [待人工核实]
└── rate_limited / auth_error ──────→ 暂停迭代，稍后整体复验
```

### 8. 轮次间的状态管理

- 第 2 轮复验以「修订后的草稿 + .bib」为输入，不沿用第 1 轮的旧结论；
- 第 1 轮未被确认的问题自动带入第 2 轮 problems.md，标注「上轮遗留」；
- candidates.json 跨轮累积保留，但每轮修订建议只引用本轮补检命中的条目，
  避免「旧证据新用」造成出处混乱；
- 每轮开始列出本轮与上轮的问题数对比，让用户直观看到收敛趋势。

## 输出模板

problems.md 行格式：

| # | 类型 | 位置 | 证据 | 所需动作 |
| --- | --- | --- | --- | --- |
| P1 | 无支撑 claim | 引言 / 段2 / 句3 | "已有研究表明……" | 补检并插入引用 |
| P2 | 冲突引用 | li2022survey | 条目年份 2022，DOI 解析 2021 | 替换为正确条目 |

目录结构：

```text
output/evidence-loop/<slug>/
├── 1/
│   ├── citation-review.json      # 第 1 轮 citation-verify 结论
│   ├── claim-review.json         # 第 1 轮 claim-check 结论
│   ├── problems.md               # 汇总问题清单
│   ├── queries.md                # 定向补检 query
│   ├── candidates.json           # 补检命中的 PaperDocument
│   └── revision-suggestions.md   # 修订建议（新证据标 [待复核]）
├── 2/                            # 第 2 轮（如发生），结构同上
└── final-summary.md              # 终止时的总结与遗留清单
```

注意：轮次目录 `<round>/` 是本 skill 的显式例外，替代 `latest/` 契约（已在 research-workspace 的产物路径契约中登记）。

最终回复中的 ```review 块（汇总各轮）：

```review
[
  {"level": "ok", "check": "citation", "title": "第 2 轮复验通过",
   "evidence": "verified 18/20，无 identifier_conflict", "note": "闭环收敛"},
  {"level": "warn", "check": "citation", "title": "遗留 2 条 [待人工核实]",
   "evidence": "wang2020method、chen2019fast 各来源均未命中",
   "note": "建议人工核查 Google Scholar / CNKI / 期刊官网"}
]
```

## 本技能不做什么

- 不超过 2 轮迭代；不无限循环补检。
- 不绕过用户确认直接改稿、改 `.bib`。
- 不重复实现核验与检索逻辑本身（委托给 citation-verify / claim-check /
  literature-search）。
- 不评价论文写作质量与学术价值。
- 不把补检未命中当作「文献不存在」的结论。

## 收尾与下一步

1. 写 `final-summary.md`：轮次数、每轮问题数变化、已修订条目、遗留问题。
2. 回复中给出 5 行内摘要 + ```review 块 + 产物路径。
3. 遗留 `[待人工核实]` 条目 → 请用户人工核查；全部收敛 → 建议进入
   review-writing 成文，或再跑一次完整 citation-verify 存档。
