---
name: binder-report
description: >-
  当需要把 output/ 下已产生的 replay、agent 评测、ranking 审计产物汇总成最终报告束时使用；收集既有 artifact、按六类证据分级标注、生成 limitations 并提交 stage-gate 审批。典型触发语："把这些产物汇总成最终报告""出一份 binder 最终报告和 limitations""把 replay/评测/审计结果打包成报告束"。同义场景：最终报告、报告束、evidence grading、limitations、claim check、收尾报告。
argument-hint: '[<slug>]'
metadata:
  domains: [protein-binder, reporting, evidence-capsule]
  last_reviewed: '2026-08-20'
---

# binder-report：最终报告束汇总

## 目的

把分散在 `output/binder-replay/`、`output/binder-agent-eval/`、`output/binder-ranking-audit/` 下的产物收拢成一份可交付的最终报告束，并为报告中的每一条内容贴上证据分级标签。本技能是**组装与标注**，不重新计算任何指标、不生成任何新结论——报告束里的每个数字都必须能回溯到一个已落盘的 artifact 和一条 provenance 记录。

## 前置检查

1. 至少存在一类上游产物：`replay-report.md`/`replay-state.json`、`agent-comparison-report.md`/`agent-eval-results.json`、`ranking-audit-report.md`/`ranking-audit.json`；一份都没有时拒绝组装，先回上游技能补产物。
2. 核对 `.openscience/provenance.jsonl`：每个被引用的 artifact 都有对应登记记录（tool、paths、note）；找不到登记的 artifact 只能标注为"来源待核实"，不得当作正式结论引用。
3. 产物落盘：`output/binder-report/<slug>/<timestamp>/`。"final report" 是五个人工 stage gate 之一，报告束完成后**必须**提交 stage-gate 审批。

## 1 · 收集产物

在 `output/` 下定位本项目 slug 的最新一轮产物，清单化记录每个文件的路径与 provenance 条目。缺哪一类（如还没做 audit）就在报告束中如实写"本次未包含"，不得留空章节假装做过。

## 2 · 组装报告束

固定四个成员：

- `campaign-replay-report`：replay 产物的汇总（campaign 状态、时间线要点、全部 gap；多 campaign 逐一列出）；
- `agent-comparison-report`：评测产物汇总（provider 名单、评分要点、invalid_output 数、冻结件位置、不可计算 case 数）；
- `ranking-audit-report`：审计产物汇总（指标、recorded vs recomputed 分歧、缺失数据清单；真实源 unavailable 时收录 unavailable 报告原文要点）；
- `limitations.md`：局限与非声明，至少覆盖：本仓库不运行任何蛋白模型、不生成新 binder 序列；未复现论文 wet-lab 命中率；结构预测高分 ≠ 实验结合；mock/replay 对照 ≠ 真实模型能力；真实源 tables 当前 unavailable 的缺口。

## 3 · 证据分级（每条内容必标）

报告正文中的每一处实质内容必须归入且仅归入六类之一：

| 标签 | 含义 | 本仓库典型来源 |
| --- | --- | --- |
| `recorded` | 原始 campaign 记录中的内容 | replay 时间线、recorded 排序 |
| `recomputed` | 本仓库代码从输入数据重算的结果 | ranking 指标、ensemble |
| `model-generated` | LLM agent 在评测中产出的内容 | 冻结决策、评分 |
| `externally imported` | 外部平台返回并校验通过的内容 | handoff 导入（当前无） |
| `experimentally measured` | 实验测量值 | wet-lab 标签 |
| `unavailable` | 确认拿不到的 | 未上传完成的 tables |

分级纪律（docs/scope.md §8）：Claude 原始 campaign 至多称 `traceable`；重跑对比通过的统计才可称 `reproduced`；没有重跑蛋白模型的 generation campaign **永远**不能称 `reproduced`。

## 4 · 提交 stage-gate 审批

报告束落盘并登记 provenance 后，走 openscience stage-gate：呈现四类产物路径、关键结果摘要、全部风险与缺口，等用户 approve / revise / reject。revise 时归档旧报告束、带意见重跑，不覆盖。未安装 openscience 插件时，直接向用户呈现上述内容、等其口头三选一即可；revise 时仍需归档旧报告束、不覆盖。

## 输出模板

```markdown
## 最终报告束：<slug>（<timestamp>）

- campaign-replay-report：<路径>（campaign 状态与 gap 计数）
- agent-comparison-report：<路径>（provider 与无效输出计数）
- ranking-audit-report：<路径>（或"本次未包含"）
- limitations.md：<路径>
- 证据分级统计：recorded n / recomputed n / model-generated n / externally imported n / experimentally measured n / unavailable n
- 待审批：stage-gate（final report）
```

## 本技能不做什么

- 不重算：报告束只引用已落盘 artifact 的内容；发现数字要变，回上游技能重跑。
- 不调和 recorded 与 recomputed 的分歧：并列呈现，不"平均"掉。
- 不省略 limitations：六类之外无内容，limitations.md 不得为空壳。
- 不替用户审批：报告束完成 ≠ 项目完成，stage-gate 三选一只能由用户回答。

## 收尾与下一步

- approve：报告束可作为证据胶囊归档（能力等级按 §3 纪律如实标注，通常 traceable / re_executable 而非 reproduced）。证据胶囊来自 openscience 插件；未安装时报告束保留在 `output/` 下即可。
- revise：归档本轮报告束，意见注入对应上游技能重跑后重新组装。
- reject：写结题说明，产物保留原位。
