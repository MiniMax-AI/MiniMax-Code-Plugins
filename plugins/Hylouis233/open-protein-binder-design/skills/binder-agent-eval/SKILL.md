---
name: binder-agent-eval
description: >-
  当需要在相同的阶段输入上评测 LLM agent 的结构化决策、或对比多个 provider 的决策质量时使用；对应 openbinder evaluate-agent（--provider/--compare/--case）与 openbinder provider doctor。典型触发语："用 mock provider 跑一遍 decision case 评测""对比一下几个 provider 在同一批 case 上的表现""先 doctor 一下 minimax 配置通不通"。同义场景：agent 评测、decision evaluation、visible/hidden 分层、泄露检查、provider 对比、冻结决策。
argument-hint: '[--provider mock|replay|anthropic|minimax|--compare a,b --case <cases.json> --out <dir>]'
metadata:
  domains: [protein-binder, llm-evaluation, leakage-control]
  last_reviewed: '2026-08-20'
---

# binder-agent-eval：agent 决策评测与 provider 对比

## 目的

让 MiniMax、Claude、ReplayProvider、MockProvider 在**完全相同的阶段输入**上产出结构化 JSON 决策，然后按协议遵守、证据使用、编造信号、不确定性处理、与 recorded decision 的字段级一致、token 与成本逐项评分。它回答的是"研究决策能力"的可比性，不是蛋白模型能力——本仓库永远不评测也不重跑任何蛋白模型。

## 前置检查

1. case 文件就绪（如 `evals/decision-cases.json`）：每个 case 显式分 `visible`（可以进 prompt）与 `hidden`（仅评分侧：recorded decision、wet-lab 标签、final rank、每 case 唯一的 `TRAP-` 陷阱 token）。
2. 选 provider：
   - `mock` / `replay`：**完全离线**，不需要任何环境变量；replay 的决策直接取自 case 文件 hidden 半的 recorded decision（评分通道，永不进 prompt）；
   - `anthropic` / `minimax`：需要 `OPENBINDER_LLM_*` 环境变量与网络；配置缺失时 CLI 打印结构化 JSON 错误并 exit 2——**不设默认 endpoint/model/key**。MiniMax 的能力以 `provider doctor` 实测为准，不预设。
3. 联网 provider 先体检：`openbinder provider doctor --provider minimax [--json]`（配置完整性、可达性、模型接受度、JSON 输出、长 prompt、usage 上报、超时与错误结构；任何 fail 或缺配置 exit 2）。
4. 产物落盘：`output/binder-agent-eval/<slug>/<timestamp>/`。"evaluation plan complete" 是五个人工 stage gate 之一：评测方案（case 集、provider 名单、评分维度）先经 stage-gate 批准再跑。stage-gate 技能来自 openscience 插件；未安装时直接向用户确认评测方案后再跑即可。

## 1 · 泄露红线（先于一切）

- `build_request` 在类型层面不接收 hidden 参数；泄露守卫在**任何模型调用之前**扫描组装好的 prompt：TRAP token、recorded action/prose、wet-lab/rank JSON 片段，命中即 `LeakageError`，CLI **exit 3** 并打印泄露细节；
- exit 3 是红线事件：停止、报告、排查 prompt 组装链路，**不得**删掉陷阱 token 重跑来"通过"。

## 2 · 冻结先于评分

每个决策在读入任何 recorded decision 之前，先冻结到 `frozen/<case_id>__<provider>.json`（含 SHA-256 摘要）。评分永远针对冻结件，不接受"评分时再补一口"的决策。

## 3 · 执行评测

```bash
# 离线单 provider
openbinder evaluate-agent --provider mock --case evals/decision-cases.json --out output/binder-agent-eval/<slug>/<timestamp>/
# 多 provider 对比（逐provider顺序跑，合并一份报告）
openbinder evaluate-agent --compare replay,mock --case evals/decision-cases.json --out <dir>
```

- 启发式评分覆盖：JSON 合法性、协议违反、证据覆盖、不确定性承认（token 集 Jaccard）、编造信号、与 recorded decision 的字段级一致；**不可计算的 case 排除并披露数量，永不猜测**；
- 终止性非法输出记为 `invalid_output`，最多 2 次格式修复重试，不进入正式结果；越界 evidence ID 记为协议违反而非静默丢弃；
- 产物：`agent-comparison-report.md` + `agent-eval-results.json`，含固定的 Method-and-limitations 节、无墙钟时间——相同输入 byte-identical。

## 输出模板

```markdown
## 决策评测结果：<case 文件> × <provider 名单>

- 每 provider：case 数、invalid_output 数、各评分维度要点
- 冻结件：frozen/ 目录（SHA-256 已记录）
- 泄露守卫：通过（未命中任何 TRAP/recorded 片段）/ exit 3 红线详情
- 不可计算 case：<n 个，已排除并披露>
- 局限：复述报告中的 Method-and-limitations 要点（离线对照 ≠ 真实模型能力）
```

## 本技能不做什么

- 不评蛋白模型：评的是**研究决策**，不声称任何模型会设计 binder。
- 不泄露 hidden：任何把 hidden 内容带进 prompt 的做法都是红线，无例外。
- 不猜缺失配置：缺 env 就 exit 2，不造默认 key/endpoint。
- 不把 mock/replay 的对照结果表述成真实模型的能力结论。

## 收尾与下一步

- 报告每 provider 的评分要点、冻结件位置与不可计算 case 数；联网 provider 结果标注模型标签与成本。
- 下一步通常是 binder-ranking-audit 或 binder-report（把评测产物纳入最终报告束，内容归类为 `model-generated`）。
