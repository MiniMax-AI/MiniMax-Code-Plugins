---
name: evidence-capsule
description: >-
  当论文级结论定型、需要把支撑某个结论的全部产物（数据、代码、图表、环境记录）冻结成一个可长期保存、可复核的包裹时使用。同义触发场景：冻结证据、证据胶囊、capsule、保存复现材料、投稿前整理数据、补充材料打包、reproducibility、可复现性归档、审稿人要看原始数据。也用于历史项目的补录归档（标注 historical_content_unverified），以及回答"这个图还能重现吗"类问题。
argument-hint: '[结论名称或项目 slug]'
metadata:
  domains: [reproducibility, archiving, evidence]
  last_reviewed: '2026-08-18'
---

# evidence-capsule：证据胶囊

## 目的

论文里的每个关键结论，都应当有一个"证据胶囊"在背后撑着：一套冻结的文件 + 一份清单 + 重跑说明。审稿人质疑图 3 时，你给出的不是"我回头找找"，而是一个 sha256 可校验的包裹。

本技能同时规定**能力分级**：一个胶囊到底是"只是存下来了"还是"真的能重跑"，必须如实命名——夸大一级的危害远大于承认做不到。

## 前置检查

1. 明确本次冻结支撑的**具体结论**（一张图、一个统计结果、一组表格），一个胶囊对应一个结论，不搞大杂烩。
2. 确认支撑该结论的产物已全部登记 provenance（`.openscience/provenance.jsonl` 中有记录）。未登记的先补登。
3. 确认产物路径符合 research-workspace 契约；胶囊只收集，不整理散乱产物——结构问题先回 research-workspace 解决。

## 胶囊目录结构

```text
output/evidence-capsule/<slug>/<claim-kebab-case>/
├── manifest.json         # 清单：文件哈希、依赖、环境、创建时间
├── REPRODUCE.md          # 重跑步骤说明
├── capsule-report.md     # 本胶囊的能力分级与核查记录
├── files/                # 冻结的产物副本（数据、代码、图、表）
└── provenance.jsonl      # 相关登记记录的完整拷贝
```

## 能力四级（诚实命名）

| 级别 | 名称 | 含义 | 达成条件 |
| --- | --- | --- | --- |
| L1 | archived | 字节冻结 | 文件收齐、manifest 含每个文件的 sha256 与字节数；此后任何改动都能被检出 |
| L2 | traceable | 可追溯 | 在 L1 之上：manifest 记录依赖（软件/库/版本）与环境（env_hash 及详情）、provenance 拷贝完整 |
| L3 | re_executable | 可重执行 | 在 L2 之上：输入数据、代码、参数、环境说明**齐备**，第三方按 REPRODUCE.md 有能力尝试重跑 |
| L4 | reproduced | 已复现 | 在 L3 之上：**实际**在隔离环境重跑并把结果与原结果比对通过（数值一致或在声明的容差内） |

命名纪律（红线）：

- **未实际重跑比对，不得声称 reproduced**。"代码都在，理论上能跑"是 L3，不是 L4；声称 L4 必须附上重跑记录（何时、何地、谁跑的、比对结果）。
- 降级是常态：依赖的商用软件绝版、数据涉及合规不能分发，胶囊就停在 L2——如实写明卡点，这比凑一个名不副实的 L3 有价值得多。
- 级别只能由 capsule-report.md 中的核查记录支撑，不得只在口头或论文里宣称。

## 1 · 收集与冻结

1. 列出支撑结论的全部文件：原始数据（data/ 引用）、分析脚本、产出图表、关键中间结果；
2. 复制进 `files/`（保留相对路径结构，如 `files/output/analysis/.../stats.csv`）；**复制不移动**，原位置文件不动；
3. 计算每个文件的 sha256 与字节数；
4. 从 provenance.jsonl 中筛出与这些文件相关的记录，整行拷贝进胶囊的 `provenance.jsonl`；
5. 拷贝 `.openscience/env/` 中相关 env_hash 的详情文件（附在 manifest 的 env 字段或单独存放）。

## 2 · 写 manifest.json

模板（字段必填，无内容用空数组/空串，不删字段）：

```json
{
  "capsule_version": 1,
  "claim": "该胶囊支撑的一句话结论",
  "project_slug": "3f9a1c7e",
  "created": "2026-08-19T16:00:00+08:00",
  "capability": "traceable",
  "files": [
    {
      "path": "files/output/analysis/3f9a1c7e/20260819-153000/stats.csv",
      "sha256": "<64 位十六进制>",
      "bytes": 20481
    }
  ],
  "deps": [
    {"name": "python", "version": "3.12.10"},
    {"name": "pandas", "version": "2.2.2"}
  ],
  "env": {
    "env_hash": "02008886520f",
    "details_file": "env-02008886520f.txt"
  },
  "historical_content_unverified": false,
  "notes": "剔除 3 个离群样品；随机种子 42"
}
```

字段说明：

- `capability` 只取四级之一：`archived` / `traceable` / `re_executable` / `reproduced`；
- `historical_content_unverified`：历史文件补录专用标记，见第 4 节；
- `files` 覆盖胶囊内全部文件（包括 REPRODUCE.md 本身之外的每一个）。

## 3 · 写 REPRODUCE.md 与 capsule-report.md

REPRODUCE.md 固定结构：

```markdown
# 重跑说明：<claim>

## 输入
（哪些文件、来自哪里、各占多大）

## 环境
（操作系统、软件与版本、依赖安装方式；与 manifest 的 deps/env 一致）

## 步骤
（逐条可执行的命令；含参数与随机种子）

## 预期输出与比对方式
（重跑应得到什么文件；如何判定"一致"：数值精确相等 / 容差范围 / 视觉比对）
```

capsule-report.md 固定结构：

```markdown
# 证据胶囊核查报告：<claim>

- 能力级别：<archived|traceable|re_executable|reproduced>
- 级别依据：（对照四级条件逐条自评，哪条满足哪条不满足）
- 已知缺口：（如"原始测序数据 200GB 未收进胶囊，仅存校验和与获取方式"）
- 复跑记录：（仅 reproduced 级别必填：重跑时间、环境、比对结果）
- 核查人：<用户或 agent>  核查日期：<ISO 日期>
```

## 4 · 历史文件补录

为既往项目补做胶囊时：

1. 能找到原始登记记录的按正常流程冻结；
2. 找不到记录的（说不清哪次运行产生的、环境已不可考），照常收文件、算哈希，但 manifest 中 `"historical_content_unverified": true`，并在 capsule-report.md 的"已知缺口"写明：哪些内容无法追溯、为什么；
3. 历史胶囊的 capability 上限为 `traceable`——未经核实的产物无从判断能否重执行；
4. **不得**为补齐级别而事后编造运行记录（guardrail 第 2、3 条：编造比空缺危害大得多）。

## 5 · 复现验证（升级 reproduced 的唯一途径）

1. 准备隔离环境：新机器、新虚拟机或干净容器，只带胶囊内容；
2. 严格按 REPRODUCE.md 重跑，不依赖记忆中的"当时还装了个什么"——跑不通先修 REPRODUCE.md，不绕过；
3. 比对结果与原结果：数值结果逐项比对，图做哈希或像素级/容差比对；
4. 通过：把复跑记录写入 capsule-report.md，manifest 的 capability 改为 `reproduced`，重新计算受影响文件的哈希；
5. 不通过：**如实记录差异**，capability 停在原级，把差异列为新的研究问题——复现失败是发现，不是丑闻；隐瞒才是。

## 输出模板

```markdown
## 证据胶囊已冻结：<claim>

- 位置：output/evidence-capsule/<slug>/<claim>/
- 能力级别：<级别>（依据见 capsule-report.md）
- 文件数：N，总大小：X MB，全部 sha256 已记录
- 已知缺口：…（或"无"）

提醒：本胶囊为 <级别>。对外声称时请使用该级别名称，
不要升级为"可复现"——那需要一次真实的隔离重跑。
```

## 本技能不做什么

- 不执行复跑本身：复跑验证由用户或下游计算能力完成，本技能只定义流程、记录格式与命名纪律。
- 不担保内容正确：胶囊保证"这些字节没被改过"，不保证"这些字节是对的"——正确性审查归 reviewer。
- 不替代数据存档政策：基金或机构要求的长期存档（如学校数据仓库）按各自规定执行，胶囊是工作区级方案。
- 不分发：胶囊含受版权保护的输入文件（如商用软件输入、第三方数据）时，能否随论文公开由用户按画像中的合规要求决定。

## 收尾与下一步

- 冻结后提醒：把胶囊路径写进论文对应图表的注释或内部记录，建立"结论 ↔ 胶囊"映射。
- 投稿前建议：至少对支撑核心结论的胶囊做一次复现验证，能升级 reproduced 就升级。
- 交付前按 guardrail 第 7 条走 reviewer 审查时，把胶囊清单一并提交审查。
