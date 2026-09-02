---
name: citation-verify
description: >-
  当用户需要核验参考文献真实性、检查 BibTeX 条目是否有误、审查论文引用是否可靠、
  排查 bibliography 中的错误条目、验证 DOI 与题录是否对得上、发现参考文献张冠李戴、
  做投稿前引用体检或审稿引用抽查时使用。同义场景：参考文献核验、引用核查、
  文献真伪鉴别、bib 文件检查、参考文献纠错、引用元数据比对、
  "帮我看看这些参考文献有没有问题""这个 DOI 对得上吗""有没有编造的引用"。
argument-hint: '[.bib 文件路径 | 论文草稿路径]'
metadata:
  domains: [verification]
  last_reviewed: '2026-08-18'
---

# citation-verify：参考文献核验闭环

## 目的

对一组参考文献条目做机器核验，逐项区分「通过 / 标识符冲突 / 查不到 / 暂时无法
核验」四种状态，并给出三级处置结论（auto-accept / 需作者确认 / 建议修订），
最终产出核验报告、修订建议与结构化审查结论。

核验理念（必须内化，并逐条体现在结论措辞里）：

- **标识符冲突 ≠ 查不到**：DOI 能解析但返回的元数据与条目对不上，往往意味着
  张冠李戴——条目真实存在、却引错了对象。这是比「查不到」更危险的错误，
  必须单独重点列出。
- **查不到 ≠ 伪造**：检索不到可能源于数据库覆盖缺口、拼写差异、文献过新或
  过老。严禁直接下「编造 / 伪造」结论，只能标 `[待人工核实]` 并给出人工核查路径。
- **失败结构化**：限流、鉴权失败是「本次未能核验」，不是「条目有问题」，
  二者在报告中必须分开呈现。
- **非破坏性**：不直接修改用户原始文件；修订建议单独成文，用户确认后才改动。

## 前置检查

1. 确认 bibverify MCP server 可用：当前工具列表中存在
   `verify_bib_file` / `doi_to_bibtex` / `rank_lookup_sources` / `explain_update_diff`。
   若不可用，告知用户用 `uvx bibverify mcp` 启动并在 MCP 配置中注册后重试；
   不可用时不做任何「假装核验」的输出。
2. 确认输入存在且可读：一个 `.bib` 文件，或一篇含「参考文献 / References /
   Bibliography」节的草稿（`.md` / `.tex` / 纯文本）。
3. 确认网络可用：核验依赖 DOI 解析与文献数据库查询；离线环境直接说明
   「当前无法联网核验」并终止，不缓存旧结论冒充新结果。
4. 计算 slug：取核验主题（通常用输入文件名去掉扩展名）做规范化——
   Unicode NFKC 规范化、转小写、去首尾空白、连续空白折叠为单个空格——
   再取 sha1 十六进制摘要前 8 位，作为产物目录名。

## 操作规程

### 1. 收集待验条目

- 输入为 `.bib` 文件：解析全部条目，逐条记录 citekey、entrytype 及
  title / author / year / journal（或 booktitle）/ doi / url 关键字段。
- 输入为论文草稿：定位「参考文献 / References / Bibliography」节，
  按顺序编码制条目（`[1] …`）或作者-年份条目逐条拆分，并保留原文行作为证据。
- 若草稿的参考文献节无法可靠拆分（格式混乱、条目数与文内引用数严重不符），
  在报告中记 warn，并建议用户改传 `.bib` 文件。
- 条目数为 0 时提前终止，报告「未发现可核验的参考文献条目」。

### 2. 调用 verify_bib_file

- 将整理出的 BibTeX 条目文本提交给 bibverify MCP 的 `verify_bib_file` 工具。
- 条目很多（如超过 50 条）时分批调用，避免单次请求过大触发限流；
  批与批之间稍作停顿。
- 保存每条返回的原始状态与证据字段，作为报告「证据」列的唯一来源，
  不凭记忆补写证据。

### 3. 逐项解读核验状态

| 状态 | 含义 | 处置基调 |
| --- | --- | --- |
| `verified` | 标识符可解析且元数据一致 | auto-accept，直接通过 |
| `identifier_conflict` | DOI 可解析，但元数据与条目不符（作者 / 年份 / 标题 / 期刊对不上） | 重点列出：疑似张冠李戴，进入「建议修订」或「需作者确认」 |
| `no_match` | 各来源均检索不到该条目 | 标 `[待人工核实]`，严禁判伪造；给出人工核查路径 |
| `rate_limited` | 触发数据源限流，本次未完成核验 | 稍后重试；不得当作失败或问题结论 |
| `auth_error` | 数据源鉴权失败（如缺少 API key） | 提示检查 bibverify 配置；同样不是条目问题 |

对 `identifier_conflict` 条目，逐字段列出冲突（条目声称值 vs 标识符解析值），
例如「条目作者为 Zhang 等，但 DOI 10.xxxx 解析到的作者为 Li 等」，
让用户一眼看出错配在哪里。

### 4. 三级处置

- **auto-accept**：`verified` 条目，无需任何动作。
- **需作者确认**：轻微差异或机器无法定夺的情形——例如年份差 1 年可能只是
  在线优先出版与正式卷期之差、作者缩写格式差异。列出差异点，请作者判断，
  不代为拍板。
- **建议修订**：`identifier_conflict` 中差异显著、基本可以确定条目写错的情形。
  用 `doi_to_bibtex` 拉取该 DOI 对应的正确 BibTeX 条目，再用
  `explain_update_diff` 生成「旧条目 → 新条目」的字段级差异说明，写入修订建议。
- **人工核查**（`no_match`）：在建议中给出三条人工路径——
  Google Scholar 按标题检索；CNKI / 万方按标题 + 作者检索（中文文献）；
  期刊官网按卷期页码定位。可用 `rank_lookup_sources` 为该条目排序推荐查询来源，
  把人工核查的成本降到最低。
- **重试**（`rate_limited` / `auth_error`）：等待后重跑本技能；重试仍失败则在
  报告中如实标注「本次未能核验」，不进入任何处置级别。

### 5. 落盘产物

目录：`output/citation-verify/<slug>/latest/`（每次完整复验覆盖 latest；
多轮迭代的旧轮次由 evidence-loop 归档到 `<round>/` 目录）：

- `report.md`：核验报告（模板见下），末尾附 ```review 块。
- `revision-suggestions.md`：修订建议，仅当存在「建议修订 / 需作者确认 /
  待人工核实」条目时生成；含正确 BibTeX 条目与字段级 diff。
- `review.json`：与报告末尾 ```review 块内容相同的结构化结论，便于程序消费。

### 6. 非破坏性写入

- 任何情况下不直接改写用户原始 `.bib` / 草稿文件。
- 用户明确确认修订建议后，才把确认过的条目写回原文件，并在报告中追加
  「已应用」记录（时间、条目、新旧值）。

## 输出模板

### 核验报告表（report.md 主体）

| # | 条目 (citekey) | 判定 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | zhang2023deep | verified | DOI 10.1000/xyz 解析元数据与条目一致 | auto-accept |
| 2 | li2022survey | identifier_conflict | 条目年份 2022，DOI 解析为 2021；期刊名不符 | 建议修订（见 revision-suggestions.md #2） |
| 3 | wang2020method | no_match | OpenAlex / Crossref 均未命中 | [待人工核实] Google Scholar / CNKI / 期刊官网 |

### review 块（报告末尾与最终回复中均输出）

```review
[
  {"level": "ok", "check": "citation", "title": "zhang2023deep 核验通过",
   "evidence": "DOI 10.1000/xyz 解析元数据与条目一致", "note": "auto-accept"},
  {"level": "error", "check": "citation", "title": "li2022survey 标识符冲突",
   "evidence": "条目年份 2022 / DOI 解析 2021，期刊名称不符",
   "note": "建议修订，正确条目见 revision-suggestions.md"},
  {"level": "warn", "check": "citation", "title": "wang2020method 未检索到",
   "evidence": "OpenAlex、Crossref 均无匹配",
   "note": "[待人工核实]，非伪造结论"}
]
```

level 约定：`identifier_conflict` 为 error；`no_match`、重试后仍
`rate_limited` / `auth_error` 为 warn；`verified` 为 ok。

## 本技能不做什么

- 不把 `no_match` 判定为伪造、编造或学术不端——只标 `[待人工核实]`。
- 不直接修改用户的 `.bib` 文件或论文草稿；修订建议单独成文，确认后才应用。
- 不评价文献的学术价值、相关性或重要性（那是综述与写作阶段的事）。
- 不检查正文 claim 是否有引用支撑（交给 claim-check）。
- 不主动检索新文献来补全证据链（交给 evidence-loop / literature-search）。
- 不在 `rate_limited` / `auth_error` 时下任何关于条目本身的结论。

## 收尾与下一步

1. 汇总统计：总数及 verified / identifier_conflict / no_match / rate_limited /
   auth_error 各多少条，在回复开头给出不超过 5 行的摘要，并附 ```review 块。
2. 指向产物路径 `output/citation-verify/<slug>/latest/`。
3. 建议下一步：
   - 有「需作者确认 / 建议修订」条目 → 请用户确认后应用修订，再复验一次；
   - 有 `[待人工核实]` 条目 → 用户人工核查后可改传 `.bib` 复验；
   - 需要连正文 claim 一起查 → 运行 claim-check 或 evidence-loop。
