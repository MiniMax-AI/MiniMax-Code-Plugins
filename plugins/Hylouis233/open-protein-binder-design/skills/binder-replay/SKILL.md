---
name: binder-replay
description: >-
  当需要回放已记录的 binder 设计 campaign、重现每一步"当时知道什么、决定了什么"时使用；对应 openbinder replay（--fixture/--events/--source）。典型触发语："帮我回放一下 IL-7Ra 的 binder campaign""回放那个失败的 campaign""看看当时每一步都知道了什么"。同义场景：campaign replay、事件流回放、replay report、gap 分析、时间线重建。
argument-hint: '[--fixture synthetic-success|synthetic-failure|--events <jsonl> --campaign <id>|--source <source_id> --target <target>]'
metadata:
  domains: [protein-binder, campaign-replay, provenance]
  last_reviewed: '2026-08-20'
---

# binder-replay：campaign 事件流回放

## 目的

回放把公开的 campaign 过程记录（per-design provenance）归一化成统一事件流，重建 campaign 状态与逐步时间线：每一步当时掌握了什么证据、做了什么决定、哪里是缺口。成功**和**失败的 campaign 都回放——失败 campaign 的 gap 往往比成功的时间线更有信息量。全程不执行任何蛋白模型、不调任何 LLM。

## 前置检查

1. 确认输入三选一：
   - `--fixture {synthetic-success, synthetic-failure}`：内置合成 fixture，完全离线；
   - `--events <campaign-events.jsonl> --campaign <campaign_id>`：自带事件流，离线；
   - `--source anthropic-claude-binder-v1 --target <target> [--campaign <id>]`：从已登记源按下载策略逐条拉取 per-design `provenance.json`，**需要网络**。
2. `--source` 模式额外检查：源已 lock；未知 target/campaign 会 exit 2 并列出 API 实际提供的可选项——把列表原样给用户，不猜。
3. 产物落盘：`output/binder-replay/<slug>/<timestamp>/`；同一源多 campaign 时每个 campaign 一个子目录。

## 1 · 执行回放

```bash
# 离线 fixture
openbinder replay --fixture synthetic-failure --out output/binder-replay/<slug>/<timestamp>/
# 自带事件流
openbinder replay --events events.jsonl --campaign <campaign_id> --out <dir>
# 真实源（网络，策略门控）
openbinder replay --source anthropic-claude-binder-v1 --target <target> --out <dir>
```

产物（`replay-report.md` + `replay-state.json` + provenance 记录）：

- 报告四节：Summary / Timeline / Decisions / **Gaps**；
- `--source` 模式的报告追加 `## Source availability` 一节，如实列出 design_summary / wetlab_labels / docs / manifests 四类表的可用状态；
- 每次运行登记 provenance（campaign、status、gaps 数）。

## 2 · gap 语义（报告的核心纪律）

- 以下情况一律记为 gap：**跳过的规范阶段、不归属于任何阶段的事件、未 finalize 的事件流**；
- gap 是"记录里没有什么"，**永不插值、永不脑补**——不把相邻步骤的内容缝进缺口；
- 声明了但缺失的字段以 `None` + `missing_fields` 呈现；CLI 会打印缺失计数，转述时不得抹掉。

## 3 · 确定性

- 报告与状态文件**逐字节确定**：相同输入重跑产出 byte-identical  artifact；报告不含任何墙钟时间（`ts` 只存在于 `.openscience/provenance.jsonl`）；
- 因此 replay 产物可以直接进证据胶囊与对比报告，diff 即审计（证据胶囊来自 openscience 插件；未安装时产物照常落盘保存即可，不影响 replay 本身）。

## 4 · 失败语义

- 未知 campaign / 缺文件 / 未知 target：exit 2，错误信息列出实际可选项；
- 下载被策略拦截（`blocked`）：exit 2 + 结构化原因，是纪律生效；
- 源不可达（`unavailable`）：exit 2，是 source gap，**不等于 campaign 不存在**；
- 回放本身不需要审批：五个人工 stage gate 不含 replay，事件回放永不阻塞等待批准。

## 输出模板

```markdown
## 回放结果：<campaign_id>

- 状态：<status>；事件数 / 设计数
- 产物：replay-report.md / replay-state.json 路径
- 时间线要点：<3-6 条关键步骤与决定>
- Gaps：<逐条列出；无则写"无已知缺口">
- Source availability（--source 时）：<四类表状态>
- provenance：已登记（tool=openbinder:replay）
```

## 本技能不做什么

- 不执行蛋白模型：回放的是**记录**，candidate 生成与打分永远不在本仓库重跑。
- 不调 LLM：replay 引擎是纯规则重建；要模型决策请用 binder-agent-eval。
- 不填补 gap：缺口如实报告，"没记录"永远不写成"没发生"或"失败了"。
- 不承诺复现：没有重跑蛋白模型，generation campaign 永远不能叫 reproduced（docs/scope.md §8）。

## 收尾与下一步

- 向用户报告 campaign 状态、时间线要点与全部 gap；有 missing_fields 时明确计数。
- 下一步通常是 binder-ranking-audit（审计该 campaign 的排序）或 binder-agent-eval（在相同阶段输入上评测模型决策）。
