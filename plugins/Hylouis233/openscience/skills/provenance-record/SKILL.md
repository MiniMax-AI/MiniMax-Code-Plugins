---
name: provenance-record
description: >-
  当任何 skill 或用户操作产生了工作区文件（报告、数据、图、脚本、下载的文献），需要登记"这是什么、谁产生的、在什么环境下产生的"时使用；所有关键步骤结束后都应调用本技能。同义触发场景：记录运行、登记产物、provenance、来源追溯、运行日志、record_run、实验记录、登记一下这次计算、这个文件哪来的。也用于回答溯源类问题：这个结果是哪次运行产生的、当时用的什么环境。
argument-hint: '[产物路径，可多个]'
metadata:
  domains: [provenance, reproducibility, data-management]
  last_reviewed: '2026-08-18'
---

# provenance-record：运行记录与来源追溯

## 目的

科研工作台的第一原则：**记录才算存在**。一个产物如果说不清是哪次运行、哪个工具、什么环境产生的，它在审稿人眼里就不存在——无法复核的证据不是证据。本技能通过 `.openscience/provenance.jsonl` 流水账，让工作区里的每个关键文件都能回答四个问题：

1. 什么时候产生的（ts）；
2. 谁产生的（tool / session / model）；
3. 在什么环境下产生的（env_hash → env/<hash>.txt）；
4. 还有哪些同批产物（paths）。

本技能自带纯标准库脚本 `scripts/record_run.py`，任何能跑 Python 3 的环境都能用，包括远程集群。

## 前置检查

1. 确认当前目录是工作区根目录（含或即将含 `.openscience/`）。脚本会自动创建 `.openscience/`，但写错位置等于没记——先确认 cwd。
2. 确认要登记的产物文件**已经落盘**：先写文件，后登记。登记不存在的路径等于伪造记录。
3. 批量产物（如一次运行输出 20 个文件）登记共同的上级目录即可，不必逐文件登记；关键产物（报告正文、最终图）建议单独登记一条并写 note。

## 何时必须登记

以下时机**必须**调用 record_run.py，不允许跳过：

1. 任何 skill 的运行产物写入 `output/` 之后；
2. 原始数据进入 `data/` 之后（note 写明来源：仪器导出/数据库下载/他人提供）；
3. 远程或长任务完成之后（见"远程与长任务"一节）；
4. 对 CLAUDE.md 画像、stage.yaml 等元数据的修改之后；
5. 证据胶囊（evidence-capsule）的每次冻结与更新。

反过来，纯探索性的临时文件（马上要删的草稿图）可以不登记，但一旦它被引用进任何产物，就必须补登记。

## 1 · 本地运行登记

在工作区根目录运行：

```bash
python <插件路径>/skills/provenance-record/scripts/record_run.py \
  --path output/literature-search/3f9a1c7e/latest/results.json \
  --tool literature-search \
  --session <会话标识> \
  --model <当前模型名> \
  --note "钠电正极关键词初检，OpenAlex 命中 213 条"
```

参数说明：

- `--path`：产物路径，可重复多次；路径不存在时脚本照样登记（它不做存在性校验），所以调用方必须先确认落盘；
- `--tool`：产生产物的工具或 skill 名，保持全工作区用词一致（用 skill 目录名，不要一会写简称一会写全称）；
- `--session` / `--model`：当前会话标识与模型名；不知道就留空，**不要编造**；
- `--note`：一句话说清这次运行干了什么、关键参数是什么；远程作业号、随机种子、数据版本号这类信息写在 note 里；
- `--format json`：机器可读输出，供其他工具解析。

## 2 · 远程与长任务

远程/长任务的核心要求：**环境信息必须抓回来**，否则记录只剩半条命。

1. 任务提交前：在 note 里记录调度系统作业号（如 Slurm 的 `sbatch` 返回）、队列、申请资源；
2. 任务完成后：把结果文件 rsync/scp 回工作区 `output/` 或 `data/`，然后登记；note 中写明：作业号、实际运行节点、软件版本（`module list` 或 `--version` 输出）、退出状态；
3. 远程环境的 env_hash 与本地不同是正常的——这正是 env_hash 的意义：如果条件允许，在远程也跑一次脚本（只登记远程侧中间产物），或把远程的 `python --version`、`lmod list` 输出贴进 note；
4. 跨机器同步的产物以**回到工作区的那一份**为登记对象，远程路径写入 note；
5. 任务失败也要登记：paths 指向日志文件，note 写失败原因——失败的运行同样是研究历史的一部分。

## 3 · 登记后的文件结构

```text
.openscience/
├── provenance.jsonl      # 每行一条 JSON 记录，只追加不修改
└── env/
    ├── 02008886520f.txt  # 某环境的 python/platform 详情
    └── a41f9c03d77e.txt  # 另一环境（如远程节点）
```

- `provenance.jsonl` 是**只追加**日志：写错的记录不删不改，追加一条新记录在 note 中说明"更正上一条"。
- `env/<hash>.txt` 按 hash 去重：同一环境只存一份详情，记录里只带 12 位 hash。
- 该目录纳入 evidence-capsule 时整体复制，不要截取片段。

## 4 · 溯源查询

回答"这个文件哪来的"类问题：

1. 按路径在 provenance.jsonl 中倒查（最后一条匹配记录为准）；
2. 展示该条记录全部字段，并用 `env/<env_hash>.txt` 展开环境详情；
3. 查不到时如实回答"该文件没有登记记录"，并按 guardrail 第 6 条建议补登记——不要根据文件内容推测来源然后当成事实陈述；
4. 需要审计某次运行的全部产物时，按相同 ts 与 tool 聚合查询。

## 记录字段规范

provenance.jsonl 每行一条 JSON，字段固定：

| 字段 | 类型 | 含义 | 缺失时的处理 |
| --- | --- | --- | --- |
| ts | string | 记录时间，ISO 8601 带时区 | 脚本自动生成，不缺 |
| paths | array | 本次登记的产物路径列表 | 至少一个，脚本强制 |
| tool | string | 产生产物的工具/skill 名 | 留空串，不编造 |
| session | string | 会话标识 | 留空串 |
| model | string | 模型名与版本 | 留空串 |
| env_hash | string | 环境指纹，sha256 前 12 位 | 脚本自动生成 |
| note | string | 自由备注：作业号、参数、关键上下文 | 留空串 |

读取方（evidence-capsule、溯源查询）按这个 schema 解析；新增字段应向后兼容（只加不改）。

## 5 · 完整示例

一次 analysis 阶段的登记序列（虚构示例）：

```bash
# 分析脚本跑完，产出图与统计表
python scripts/record_run.py \
  --path output/analysis/3f9a1c7e/20260819-153000/cycle-life.png \
  --path output/analysis/3f9a1c7e/20260819-153000/stats.csv \
  --tool "python scripts/analyze_cycle.py" \
  --session cli-2026-08-19-01 \
  --model "minimax-m2" \
  --note "循环寿命拟合，剔除 3 个离群样品，seed=42"

# 同日远程 DFT 任务抓回结果后
python scripts/record_run.py \
  --path data/2026-08-vasp-dos/ \
  --tool "vasp 6.4.2 (Slurm job 88213471)" \
  --note "DOS 计算完成，64 核 5.2 小时，节点 c12n04，已 rsync 回本地"
```

对应的 jsonl（节选，实际为一行一条）：

```json
{"ts": "2026-08-19T15:31:02+08:00", "paths": ["output/analysis/3f9a1c7e/20260819-153000/cycle-life.png", "output/analysis/3f9a1c7e/20260819-153000/stats.csv"], "tool": "python scripts/analyze_cycle.py", "session": "cli-2026-08-19-01", "model": "minimax-m2", "env_hash": "02008886520f", "note": "循环寿命拟合，剔除 3 个离群样品，seed=42"}
```

## 输出模板

登记完成后的确认输出：

```markdown
已登记 N 个产物 → .openscience/provenance.jsonl
- tool: <tool>  env_hash: <hash>（新环境 / 已有环境）
- note: <note>
```

溯源查询输出：

```markdown
## 来源追溯：<path>

- 产生时间：…（ts）
- 产生工具：…（tool / session / model）
- 运行环境：…（env_hash + 详情摘要）
- 备注：…（note）
- 同批产物：…（同条记录的其他 paths）
```

## 本技能不做什么

- 不验证产物内容的正确性：记录"它存在、它这样来"，不背书"它是对的"——正确性靠 reviewer 与各核验 skill。
- 不替用户回忆：登记时信息不全（如忘了 session）就留空，宁可缺字段也不补编造值（guardrail 第 2、3 条）。
- 不管理文件本身：不移动、不复制、不清理产物，只写日志。
- 不做版本控制：provenance 回答"怎么来的"，不回答"改了哪些"——后者是 Git 的职责。
- 不自动批量补登记历史文件：历史文件需要补录时走 evidence-capsule 的 `historical_content_unverified` 流程，逐批与用户确认。

## 收尾与下一步

- 登记完成后提醒调用方：产物路径契约（research-workspace）要求同步刷新 `latest/`。
- 阶段收尾时检查：本阶段产物是否全部有登记记录？缺登记的当场补登，再进入 stage-gate。
- 定期（如 evidence-capsule 冻结前）建议用户浏览一遍 provenance.jsonl，确认流水账与记忆中的研究过程一致。
