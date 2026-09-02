---
name: research-lifecycle
description: >-
  当用户提出研究主题、想开始一项新研究、问"接下来该做什么"、或要求继续上次的研究流程时使用。本技能是科研工作台的元路由器：把一个研究主题拆解为 question（问题界定）→ literature（文献调研）→ hypothesis（假设形成）→ experiment（实验/计算）→ analysis（数据分析）→ writing（写作成稿）六个阶段，逐阶段调用相应插件的 skill 执行，每个阶段结束经 stage-gate 门禁审批后进入下一阶段。同义触发场景：开始研究、开题、走流程、研究流程、lifecycle、继续上次的研究、阶段推进、研究项目管理、六阶段、从选题到成稿。
argument-hint: '[研究问题或主题]'
metadata:
  domains: [research-lifecycle, workflow, project-management]
  last_reviewed: '2026-08-18'
---

# research-lifecycle：六阶段研究流程路由器

## 目的

把"我想研究 X"这句话变成一条可执行、可暂停、可恢复、可审查的流程。本技能不亲自做检索、不做计算、不写论文——它负责：

1. 把研究主题规范化为 slug，建立项目级产物目录；
2. 按六阶段顺序调度对应的 skill 或插件；
3. 在每个阶段结束时移交给 `stage-gate`，等待用户审批后再推进；
4. 跨会话恢复：通过 `stage.yaml` 知道"上次走到哪、是批了还是要改"。

## 前置检查

1. **画像检查**：读取 CLAUDE.md 研究画像。任何小节仍是 `[填空]` 时停止，引导用户先运行 `cold-start-interview`（guardrail：不带空白画像猜测默认值）。
2. **工作区检查**：确认当前目录符合 `research-workspace` 约定；不符合时先运行 research-workspace 的初始化清单，或征得用户同意后以当前状态继续。
3. **参数解析**：`argument-hint` 传入研究主题。为空时向用户提问，不接受空主题启动。
4. **slug 生成**：按下方 slug 契约计算项目标识，检查 `output/` 下是否已有同名项目——有则询问用户"继续该项目"还是"换个主题"。
5. **恢复检查**：存在 `output/<slug>/stage.yaml` 时，读取 `current_stage` 与 `status`，跳到对应阶段继续（见"恢复指引"），而不是从头开始。

## slug 契约

项目标识 slug 的生成规则（全插件统一，research-workspace 与 stage-gate 依赖同一规则）：

1. 取用户输入的主题字符串，做 Unicode NFKC 规范化；
2. 转小写，去除首尾空白，把内部连续空白压缩为单个空格；
3. 对规范化后的 UTF-8 字节计算 SHA-1，取前 8 位十六进制字符作为 slug。

示例：主题 `钠离子电池 层状氧化物 掺杂` → 规范化后同原样 → sha1 前 8 位（如 `3f9a1c7e`）。

同一主题（规范化后相同）永远得到同一 slug，与大小写、全半角、多余空格无关；不同主题几乎不会碰撞。slug 只用于目录命名与归类，不追求可读性；需要可读名时在项目 `stage.yaml` 的 `note` 或阶段产物标题中保留原始主题。

## 六阶段总览

| 阶段 | 目标 | 调用的能力 | 主要产出物 |
| --- | --- | --- | --- |
| question | 把模糊主题收敛为可研究的问题 | 本技能内部执行 | research-question.md |
| literature | 摸清该问题的研究现状 | literature-search、literature-survey | 文献库 + 综述稿 |
| hypothesis | 提出可检验的假设 | 本技能内部执行 | hypothesis.md |
| experiment | 获取验证假设的数据 | 人工执行 + provenance-record 记录 | 实验/计算数据 + 运行记录 |
| analysis | 从数据得出结论 | 人工执行 + provenance-record 记录 | 分析脚本 + 图表 + 结论 |
| writing | 写成可交付的文稿 | review-writing + citation-verify | 论文/报告草稿 |

阶段之间一律经过 `stage-gate`：产出物落盘 → 生成 stage-report.md → 更新 stage.yaml 为 pending → **停止**，等用户 approve / revise / reject。

## 1 · question：问题界定

**目标**：把"我想研究钠离子电池正极"收敛为"O3 型层状氧化物在钠离子电池中的循环衰减是否可以通过 Mg/Ti 共掺杂抑制"这样可研究、可证伪的问题。

**执行规程**：

1. 复述用户对主题的描述，确认理解一致；
2. 从四个维度追问：对象（研究什么）、变量（操纵/测量什么）、范围（什么条件/体系）、动机（为什么值得做，应用还是机理）；
3. 起草 1-3 个候选研究问题，每个都标注"可检验性"自评：这个问题能否用数据回答？需要什么类型的证据？
4. 与用户选定最终问题，写入 `output/research-lifecycle/<slug>/latest/research-question.md`，内容包括：最终问题、候选问题及取舍理由、预期贡献的一句话表述；
5. 用 provenance-record 登记产物，然后调用 stage-gate。

**不做文献检索**——"这个问题别人做到哪了"是下一阶段的事，避免把 question 开成迷你综述。

## 2 · literature：文献调研

**目标**：回答三个问题：这个问题已被解决到什么程度？主流方法是什么？缺口（gap）在哪里？

**执行规程**：

1. 从 research-question.md 提取检索关键词（中英文各一组，画像中的关键词并入）；
2. 调用 `literature-search` 按画像中的数据源偏好检索（画像写"无权限"的库不碰）；
3. 调用 `literature-survey` 生成综述稿，所有论断必须带来源标签（guardrail 第 1 条），检索未覆盖的判断标 `[模型知识—待核实]`；
4. 综述稿末尾必须有一节"研究缺口与本文定位"，把缺口与 question 阶段的研究问题显式挂钩；
5. 产物落盘（`output/literature-search/<slug>/`、`output/literature-survey/<slug>/`），登记 provenance，调用 stage-gate。

**revise 常见原因**：关键词太宽/太窄、漏掉某篇关键文献、缺口论证不足。revise 意见注入后重跑本阶段，原稿归档不覆盖。

## 3 · hypothesis：假设形成

**目标**：基于文献缺口提出 1-3 个**可证伪**的假设，并为每个假设设计验证思路。

**执行规程**：

1. 重读 research-question.md 与综述的"研究缺口"一节；
2. 每个假设写成"在条件 C 下，对对象 O 施加干预 I，将观察到效应 E"的结构化句式；
3. 为每个假设列出：所需数据类型、可行方法（实验/计算/统计）、预期判别标准（什么结果算支持、什么算证伪）、风险（最可能失败在哪）；
4. 与用户选定主假设（最多保留一个备选），写入 `output/research-lifecycle/<slug>/latest/hypothesis.md`；
5. 登记 provenance，调用 stage-gate。

**诚实性要求**：假设可以错——写明判别标准的意义就在于允许被证伪。禁止把假设写成"必然正确的结论预告"。

## 4 · experiment：实验与计算

**目标**：获取能检验假设的数据。

**执行模式**：计算能力由本包计算类 skill 提供（python-analysis / r-analysis / remote-compute / hpc-slurm / run-monitor）。本阶段的做法：

1. 根据 hypothesis.md 生成**实验/计算方案书**（`experiment-plan.md`）：步骤、参数、对照设置、样本量或计算规模估算、预期产物清单；
2. 方案经 stage-gate 批准后执行：本地分析调用 python-analysis / r-analysis，远程提交与长任务调用 remote-compute / hpc-slurm / run-monitor；无可用算力环境时，由用户在画像所述的算力环境中**人工执行**；
3. 每完成一个关键步骤，用户（或助手代劳）运行 `provenance-record` 的 `record_run.py` 登记产物；远程/长任务必须抓回环境信息（调度系统作业号、软件版本、节点信息）写入 note；
4. 涉及远程提交、批量下载的动作一律按 guardrail 第 8 条先向用户说明并确认；
5. 原始数据放入 `data/` 后立即视为**只读**（research-workspace 约定），任何清洗都生成新文件。

**产物**：实验/计算方案书、原始数据（data/）、provenance.jsonl 运行记录。

## 5 · analysis：数据分析

**目标**：从 experiment 阶段的数据中得出对假设的判定。

**计算能力**：分析计算优先调用本包计算类 skill——本地分析用 python-analysis / r-analysis，远程与长任务用 remote-compute / hpc-slurm / run-monitor。

**执行规程**：

1. 分析代码放 `scripts/` 或 `notebooks/`，读取 `data/` 的原始数据（只读），结果输出到 `output/analysis/<slug>/`；
2. 每个关键图表或统计结果生成后立即 record_run 登记（tool 填实际用的工具，如 "python scripts/analyze.py"）；
3. 产出 `analysis-report.md`，必须包含：数据概况（样本量、缺失情况）、方法与参数、关键结果（数字与图）、对假设的判定（支持/不支持/无法判定，并写明依据的判别标准——来自 hypothesis.md）、局限性；
4. 判定为"无法判定"是合法结论，写明缺什么证据、建议补什么实验；
5. 统计显著性、效应量等数字必须与脚本输出逐项核对，禁止凭印象转述（guardrail 第 3 条：证据优先）；
6. 登记 provenance，调用 stage-gate。

**与 experiment 的往返**：analysis 发现数据不足时，stage-report 的"建议"一节写明"回到 experiment 补做 X"，由用户决定是否回退阶段（见决策树）。

## 6 · writing：写作成稿

**目标**：把前五个阶段的积累写成可交付的文稿。

**执行规程**：

1. 确定文稿类型（期刊论文/学位论文章节/项目报告/综述）与目标读者，参考画像中的写作语言、目标期刊与引用格式；
2. 调用 review-writing 生成大纲并逐节成稿；所有事实性论断必须带来源标签（guardrail 第 1 条），来自本流程的产物标 `[实验数据]` 并注明文件路径；
3. 参考文献条目生成后，调用 `citation-verify` 逐条核验（DOI、作者、年份、期刊），核验未通过的条目不得进入终稿；
4. 论文级结论定型时，按 `evidence-capsule` 冻结支撑该结论的产物集合；
5. 草稿完成后按 `reviewer-protocol` 做发布前审查（guardrail 第 7 条），error 清零后才算本阶段完成；
6. 产物落盘 `output/review-writing/<slug>/`，登记 provenance，调用 stage-gate。

## 阶段间门禁

每个阶段的最后一步固定相同：

1. 确认本阶段全部产物已落盘并登记 provenance；
2. 生成 stage-report.md（四节：本阶段做了什么/关键结果/风险与疑虑/建议）；
3. 更新 `output/<slug>/stage.yaml`（status: pending）；
4. **停止输出**，把审批三选项（approve / revise "意见" / reject）交给用户。

详细规程见 `stage-gate` SKILL.md。本技能不替用户做审批决定，也不在没有 stage.yaml 记录的情况下跳到下一阶段。

## 恢复指引

新会话中用户说"继续上次的研究"时：

1. 列出 `output/` 下所有含 stage.yaml 的项目，让用户确认是哪一个（只有一个时直接用）；
2. 读取 stage.yaml：`status: pending` → 向用户重述 stage-report 摘要并等待审批；`status: approved` → 进入下一阶段；`status: revise_requested` → 携带 note 中的意见重跑当前阶段；`status: rejected` → 展示结题说明，询问是否开启新项目；
3. 恢复时顺带检查 provenance.jsonl 的最后记录时间，向用户报告"距上次活动已 N 天"。

## 完整流程决策树

```text
开始：研究主题
  │
  ├─ 画像完整？ ──否──→ cold-start-interview ──→ 回到开始
  │是
  ├─ slug 已存在？ ──是──→ 读 stage.yaml 恢复到对应阶段
  │否
  ▼
[question] ──产出 research-question.md──→ stage-gate
  │ approve                                        ▲
  ▼                                                │ revise（意见注入，重跑）
[literature] ──检索+综述──→ stage-gate ────────────┘
  │ approve
  ▼
[hypothesis] ──产出 hypothesis.md──→ stage-gate
  │ approve
  ▼
[experiment] ──方案书→人工执行→数据──→ stage-gate
  │ approve
  ▼
[analysis] ──analysis-report.md──→ stage-gate
  │ approve                    │ revise 意见为"数据不足"
  ▼                            ▼
[writing]              回到 [experiment] 补做（stage-gate 记录回退原因）
  │ approve
  ▼
交付（writing 产物 + 证据胶囊 + reviewer 通过记录）

任意阶段 reject ──→ 写结题说明，流程终止，产物保留
```

## 输出模板

阶段推进时向用户输出的固定格式：

```markdown
## 阶段推进：<stage 名>（项目 <slug>）

- 本阶段目标：…
- 将调用：…
- 预计产物：…

（阶段完成后）

## 阶段待审批：<stage 名>

- stage-report：output/<slug>/reports/stage-report-<stage>.md
- 关键结果一句话：…
- 请选择：approve（进入 <下一阶段>）/ revise "你的意见" / reject
```

## 本技能不做什么

- 不亲自检索文献、不亲自跑计算、不亲自写论文正文——这些委托给对应插件与 skill，本技能只做调度与状态管理。
- 不跳过 stage-gate：即使产物看起来完美，也必须停下来等用户审批。
- 不替用户决定研究问题或假设：所有关键取舍（选哪个问题、信哪个假设）都以用户确认为准。
- 不修改其他阶段的归档产物：revise 是重跑并归档旧版，不是原地覆盖。
- 不亲自执行远程任务提交、批量下载等计算动作：这些委托给计算类 skill（remote-compute / hpc-slurm / run-monitor），本技能只做调度与状态管理。

## 收尾与下一步

- 项目 writing 阶段 approve 后：提醒用户证据胶囊是否已冻结、reviewer 审查记录是否随稿保存、投稿/交付属于对外动作需用户亲自执行。
- 全流程结束后询问："是否把本项目的关键产物整理进证据胶囊长期保存？"以及"是否开启新主题？"
- 任何阶段卡住超过一次 revise：主动建议用户考虑 `customize` 调整画像（例如数据源权限限制了 literature 质量），或缩小研究问题的范围。
