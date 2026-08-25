---
name: binder-ranking-audit
description: >-
  当需要重算并审计 binder campaign 的候选排序、核对 recorded 与 recomputed 是否一致时使用；对应 openbinder audit-ranking（--fixture/--source）。典型触发语："审计一下这个 campaign 的排序""recorded 和 recomputed 对得上吗""重算 top-N 命中率和 Spearman"。同义场景：ranking audit、排序审计、ensemble 重算、hit rate、缺失数据处理、missing data 报告。
argument-hint: '[--fixture synthetic-ranking|--source <source_id> --target <target> --out <dir>]'
metadata:
  domains: [protein-binder, ranking-audit, statistics]
  last_reviewed: '2026-08-20'
---

# binder-ranking-audit：排序审计（recorded vs recomputed）

## 目的

从公开的预计算分数与 wet-lab 标签出发，重算 ensemble 分数与排序指标（top-N 命中率、average precision、Spearman、随机基线），并与 recorded 排序并列对照。它的第一纪律：**缺失就是缺失**——缺分数的跳过并点名，缺标签的从标签指标排除，任何缺失都不得当零分、不得当非 binder。

## 前置检查

1. 输入二选一：
   - `--fixture synthetic-ranking`：内置合成 candidates + wet-lab 标签，完全离线；
   - `--source anthropic-claude-binder-v1 --target <target>`：真实源，**需要网络**，且依赖已发布的 `design_summary` 表与 wet-lab 标签表。
2. 真实源现状（必须如实告知用户）：pinned revision 上 `data/tables/` 等尚未上传完成，CLI 会打印结构化 unavailable 报告（缺哪些表、revision）并 **exit 2**——这是当前唯一正确的结果，不是故障。
3. 产物落盘：`output/binder-ranking-audit/<slug>/<timestamp>/`。"ranking audit complete" 是五个人工 stage gate 之一（stage-gate 技能来自 openscience 插件；未安装时直接向用户呈现审计结果并等其确认即可）。

## 1 · 执行审计

```bash
openbinder audit-ranking --fixture synthetic-ranking --out output/binder-ranking-audit/<slug>/<timestamp>/
openbinder audit-ranking --source anthropic-claude-binder-v1 --target <target> --out <dir>   # 网络
```

- fixture 标签规则：先取每条记录自带的 recorded 标签，再用 wet-lab 标签文件覆盖——**测量标签优先于记录标签**；两边都没有的候选保持无标签，永不默认成非 binder；
- 重算管线：按 target 分别 z-score / min-max 归一（退化 target 归一为 0.0 并披露注记）→ ensemble 为各 target 预测子 z-score 的算术平均（key 选择确定性）→ mid-rank 并列处理 → 纯 stdlib 指标。

## 2 · 产物与读法

- `ranking-audit-report.md` + `ranking-audit.json`，无墙钟时间、跨运行 byte-identical；
- 报告含：数据质量（重复 candidate_id）、**recorded vs recomputed 逐记录对照表**（两列分列，永不合并成一个"分数"）、overall 与 per-target 指标、缺失数据报告、diversity 检查（相同 score dict、top-10 前缀家族集中度）；
- 读报告时：recomputed 与 recorded 不一致是**发现**，不是错误——如实并列呈现，由用户判断。

## 3 · 真实源 unavailable 的如实处理

- `design_summary` 或 wet-lab 表在 pinned revision 不存在时：stderr 打印结构化 unavailable 报告（表名、revision、说明"发布方仍在上传"），exit 2；
- **绝不**从原始 vendor 曲线重建这些表，绝不拿 fixture 冒充真实表；
- 正确动作：等发布方完成上传后 `openbinder source lock` 重新锁定，再重跑审计。

## 输出模板

```markdown
## 排序审计结果：<campaign_id>

- 记录数 / 有效数；缺分数 n 个（已点名跳过）、缺标签 n 个（已排除）
- 指标：top-N hit rate / AP / Spearman / 随机基线（注明哪些是 recomputed）
- recorded vs recomputed：<一致要点与分歧要点，分歧逐条列出>
- diversity 检查：<相同 score dict、top-10 家族集中度>
- 或：unavailable 报告（缺哪些表、revision、下一步 re-lock）
```

## 本技能不做什么

- 不把缺失当零分、不把缺标签当非 binder：这是硬规则，无参数可以关闭。
- 不重建不存在的表：原始曲线不在本仓库的解析范围内。
- 不把高结构预测分数说成实验结合：指标是排序质量度量，不是结合能力的证据（docs/scope.md §4）。
- 不硬编码论文数字：每个 recomputed 指标都由代码从输入数据推导。

## 收尾与下一步

- 报告指标与缺失数据清单；真实源 unavailable 时明确"等上传完成 re-lock 后重跑"。
- 通过 stage-gate 审批后，下一步是 binder-report（审计产物纳入最终报告束，重算内容归类为 `recomputed`，recorded 内容保持 `recorded` 分列）。
