---
name: stage-gate
description: >-
  当研究流程的任一阶段产出物完成、需要用户审批后推进时使用；通常由 research-lifecycle 在每个阶段末尾自动调用，用户也可以直接说"看看当前阶段状态""审批一下""approve""revise""reject""阶段门禁""stage gate"触发。本技能负责：把阶段产出物落盘、生成 stage-report.md（本阶段做了什么/关键结果/风险与疑虑/建议）、更新 output/<project>/stage.yaml，然后停止等待用户三选一——approve 进入下一阶段、revise 携带意见重跑本阶段（原产物归档不覆盖）、reject 终止并写结题说明。同义触发场景：阶段确认、继续下一步、打回重做、终止项目、恢复进度、上次进行到哪了。
argument-hint: '[approve|revise "意见"|reject|status]'
metadata:
  domains: [workflow, approval, project-management]
  last_reviewed: '2026-08-18'
---

# stage-gate：阶段审批门禁

## 目的

研究流程的每个阶段都可能走偏：文献检索漏了方向、假设设计有漏洞、分析结论站不住。stage-gate 在每个阶段结束时强制停下来，把"这一阶段的成果是否足以支撑下一步"的决定权交还给用户。它同时是流程的账本：stage.yaml 与 stage-report 共同记录"走到哪、批了什么、被打回过几次、为什么"。

本技能用 CLI 原生能力实现（读写文件 + 对话交互），不依赖任何外部服务。

## 前置检查

1. 确认目标项目的 slug 与 `output/` 目录结构符合 research-workspace 契约。
2. 门禁的调用方（通常是 research-lifecycle）必须已完成：本阶段产物全部落盘到 `output/<skill>/<slug>/`、关键产物已登记 provenance。未完成时拒绝进入审批，先把产物补齐。
3. 读取现有 `output/<slug>/stage.yaml`（存在时）：确认 `status`。若已是 `pending`（即用户还没批上一次），不得重复生成报告，直接向用户重述待审批内容。

## stage.yaml 规范

每个项目一份，固定路径 `output/<slug>/stage.yaml`。schema：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| project | string | 项目 slug（与目录名一致） |
| current_stage | string | 当前阶段：question / literature / hypothesis / experiment / analysis / writing |
| status | string | pending（等待审批）/ approved（已通过）/ revise_requested（打回重跑）/ rejected（已终止） |
| updated | string | 最近状态变更时间，ISO 8601 带时区 |
| note | string | 备注：revise 时为用户的修改意见；reject 时为终止原因；其余可留空 |

完整示例：

```yaml
project: 3f9a1c7e
current_stage: literature
status: revise_requested
updated: '2026-08-19T10:24:00+08:00'
note: >-
  综述漏掉了固态电解质方向的对比，关键词请加 "solid electrolyte"
  重跑 literature 阶段；另外研究缺口一节请更明确地对应研究问题。
```

写入规则：

- 任何变更都更新 `updated` 为当前时间；
- `status` 的合法取值只有上面四个，其他值一律视为文件损坏，停止并报告；
- 文件不存在时由本技能在第一次门禁时创建；`current_stage` 只允许按流程顺序前进或在 revise 时停留原地，回退阶段（如 analysis 打回到 experiment）必须在 note 中写明原因。

## 1 · 生成 stage-report.md

阶段产物齐了之后，生成阶段报告，固定四节：

```markdown
# 阶段报告：<stage 名>（项目 <slug>）

- 生成时间：<ISO 8601>
- 这是本阶段第 N 次提交审批

## 本阶段做了什么

（3-6 条，每条一行：执行了什么动作、调用了哪些 skill/插件、产生了哪些文件及其路径）

## 关键结果

（本阶段最重要的发现或产出，一句话一条，带来源标签；不得超过 8 条）

## 风险与疑虑

（诚实列出：检索覆盖不足、样本量偏小、某步骤依赖 [模型知识—待核实]、
与用户画像的潜在冲突等。没有也要写"无已知风险"，不得省略本节。）

## 建议

（对下一阶段的建议；revise 时此处说明本轮相对上轮改了什么）
```

报告存放规则：

- 主文件：`output/<slug>/reports/stage-report-<stage>.md`；
- **累积追加**：同一阶段第 N 次提交时，不覆盖旧报告，而是在文件末尾追加新的一节（标题带"第 N 次提交"），保留完整审批历史；
- 首次提交时若 `reports/` 目录不存在则创建。

## 2 · 提交审批并停止

1. 把 stage.yaml 更新为 `status: pending`、`current_stage` 为当前阶段、`note` 清空；
2. 向用户输出审批请求（见输出模板）；
3. **停止**。不预设用户会 approve，不以"产物看起来没问题"为由自动推进；
4. 等待期间不做任何下一阶段的工作。

## 3 · 处理用户三选一

### approve（通过）

1. stage.yaml 更新为 `status: approved`，`updated` 刷新；
2. 在 stage-report 末尾追加一行审批记录：`[approved] <时间>`；
3. 通知 research-lifecycle 进入下一阶段。

### revise "意见"（打回重跑）

1. 原产物**归档不覆盖**：把本阶段本次运行的产物目录复制（或移动）到 `output/<slug>/archive/<timestamp>/`，并在归档目录中放一份 `REVISE-NOTE.md`，内容为用户的修改意见原文；
2. stage-report **累积追加**：新一轮审批时在 `stage-report-<stage>.md` 末尾新增"第 N 次提交"一节，开头引用上轮意见，说明本轮如何回应；
3. stage.yaml 更新为 `status: revise_requested`，`note` 写入用户意见；
4. 把意见注入重跑 prompt：调用方（research-lifecycle 对应阶段）带着"上轮产物 + 用户意见 + 归档位置"重跑本阶段；新产物写新的时间戳目录并刷新 latest。

### reject（终止）

1. stage.yaml 更新为 `status: rejected`，`note` 写终止原因（用户没说就问一句）；
2. 生成结题说明 `output/<slug>/reports/closure.md`：项目主题、终止于哪个阶段、已完成的工作清单、产物位置、可能的后续（以后想重启时从哪里继续）；
3. 所有产物保留原位，不删除、不归档——终止只是状态标记；
4. 流程结束，向用户确认后续安排（开启新项目或离开）。

用户输入模糊时（如"还行吧""你看着办"），不得猜成 approve：追问一句"那你的选择是 approve、revise 还是 reject？"。审批决定必须来自用户的明确表达。

## 4 · 恢复指引

新会话中恢复项目进度：

1. 读取 `output/<slug>/stage.yaml`（多个项目时先让用户选定）；
2. 按 status 分支：
   - `pending`：重述 stage-report 的"关键结果"与"风险与疑虑"摘要，重新提交审批三选项；
   - `approved`：告知"上一阶段已通过"，询问是否进入下一阶段（或直接推进，取决于用户指令）；
   - `revise_requested`：展示 note 中的意见与归档位置，确认后重跑当前阶段；
   - `rejected`：展示 closure.md 摘要，询问是否开启新项目；
3. 恢复时检查 stage.yaml 的 `updated` 与 provenance.jsonl 最后记录，报告"距上次活动已 N 天"；超过 30 天时额外提醒"文献类产物可能已有新进展，literature 阶段结果建议复核 [待复核]"。

## 输出模板

提交审批时：

```markdown
## 阶段待审批：<stage 名>（项目 <slug>，第 N 次提交）

阶段报告：output/<slug>/reports/stage-report-<stage>.md

关键结果摘要：
- …（3-5 条）

风险与疑虑：
- …（原样转述，不打折扣）

请选择：
- **approve** —— 通过，进入 <下一阶段名>
- **revise "你的意见"** —— 打回重跑本阶段（原产物归档，不覆盖）
- **reject** —— 终止项目（写结题说明，产物保留）
```

## 本技能不做什么

- 不替用户审批：任何情况下都不自动 approve，包括"产物明显合格"和"用户上次都批了"。
- 不修改归档产物：`archive/` 下的内容只读，revise 重跑是生成新产物，不是修补旧产物。
- 不评判意见本身：用户的 revise 意见哪怕方向可疑，也如实注入重跑；有明显风险时（如意见要求删除不利数据）按 guardrail 提出异议，但决定权在用户。
- 不跨项目管理：一次只处理一个 slug 的门禁；多项目状态查询逐个项目进行。
- 不做质量审查本身：报告中的"风险与疑虑"来自执行阶段的自查；独立的质量审查按 reviewer-protocol 执行。

## 收尾与下一步

- approve 后：明确告知下一阶段名称、目标与预计产物，然后移交 research-lifecycle。
- revise 后：确认归档完成、意见已注入，再开始重跑；重跑完成重新走本门禁（提交次数 +1）。
- reject 后：输出 closure.md 路径与一句话总结，询问"开启新项目还是先到这里"。
- 任何时刻用户都可以运行 `stage-gate status` 查看当前项目状态，本技能原样展示 stage.yaml 与最近一次报告摘要。
