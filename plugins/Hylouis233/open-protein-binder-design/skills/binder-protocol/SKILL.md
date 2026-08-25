---
name: binder-protocol
description: >-
  当需要把 binder 设计协议草稿编译成结构化 protocol.yaml、校验协议、或按阶段切出 stage slice 时使用；对应 openbinder protocol validate/compile/show 三个子命令。典型触发语："把这份 protocol 草稿编译一下""校验这个 protocol.yaml""把 cofold_scoring 阶段的切片拿出来"。同义场景：协议编译、protocol compiler、十阶段、stage slice、阶段上下文、protocol validate。
argument-hint: '[validate <protocol.yaml>|compile <draft.yaml>|show <protocol.yaml> --stage <stage_id>]'
metadata:
  domains: [protein-binder, protocol, stage-gate]
  last_reviewed: '2026-08-20'
---

# binder-protocol：协议编译、校验与阶段切片

## 目的

长篇散文协议没法直接驱动可审计的流程。本技能把人写的协议草稿编译成规范的 `protocol.yaml`（`ProtocolSpec`）：十个规范阶段逐一显式声明 inputs、allowed decisions、required outputs、hard rules、stop conditions，使每个阶段可寻址、可切片、可校验。编译产物是 replay、evaluate-agent、audit-ranking 共同依赖的"流程宪法"。

十个规范阶段（`CANONICAL_STAGE_IDS`）：

`target_research → construct_selection → epitope_selection → method_allocation → candidate_generation → candidate_filtering → cofold_scoring → optimization → final_ranking → delivery`

## 前置检查

1. 草稿 YAML 已存在（参考 `fixtures/synthetic/protocol-draft.yaml` 的 draft 形式：`stages` 为映射、无 `schema_version`）。
2. 若草稿引用 source_id，决定校验强度：传 `--sources-dir sources/` 则检查 `source-registered` 规则；不传则跳过该规则（协议可以引用本检出中未登记的源，但跳过是显式的，不是静默猜测）。
3. 若有 `source.lock.json`，compile 时传 `--lock` 把 pinned revision 写进 `protocol-source.json`；没有 lock 时该字段为 `null`/`unresolved`——**永不猜 revision**。
4. 产物落盘：`output/binder-protocol/<slug>/<timestamp>/`。

## 1 · 编译（compile）

```bash
openbinder protocol compile <draft.yaml> --out output/binder-protocol/<slug>/<timestamp>/ \
  [--sources-dir sources/] [--lock source.lock.json]
```

产出三个文件并登记 provenance：

- `protocol.yaml` — 规范 `ProtocolSpec`（draft 的 stages 映射被归一化为有序列表）；
- Markdown 报告 — 编译过程与全部校验发现；
- `protocol-source.json` — 源引用（locked revision 或 `null`/`unresolved`）。

有任何 error 级校验发现时 compile 失败：exit 2，产物照常写出供排查，状态标注 failed。

## 2 · 校验（validate）

```bash
openbinder protocol validate <protocol.yaml> [--sources-dir sources/]
```

- 除 schema 形状外检查域规则：阶段覆盖与顺序、stage_id 唯一、每阶段完整性（inputs/outputs/hard rules 等）、`cofold_scoring`/`final_ranking`/`delivery` 三个产出结论的阶段必须声明结果报告方式（防止预测被写成测量）；
- 每条发现打印 `[error|warn] rule (stage)`；存在 error 时 exit 2，仅有 warn 时 exit 0 但必须把 warn 原样转述给用户确认是有意为之。

## 3 · 阶段切片（show --stage）

```bash
openbinder protocol show <protocol.yaml> --stage cofold_scoring
```

- 输出该阶段的紧凑 JSON 切片：阶段定义 + 全局规则 + 前序阶段产出；`ranking_rules` 只对 `final_ranking`/`optimization` 两个排序相关阶段附带。
- **这是给模型/计划用的唯一正确上下文形式**：不要把整份 protocol 喂给每次调用。规划型 agent（binder-planner）做计划时只能用 stage slice。

## 4 · 阶段门禁

"protocol compiled" 是五个人工 stage gate 之一：编译与校验通过后，把 `protocol.yaml`、报告、`protocol-source.json` 的路径与 warn 清单提交 stage-gate 审批，用户 approve 后才进入 replay/eval 阶段。revise 时归档旧产物、带着意见重跑，不覆盖。stage-gate 技能来自 openscience 插件；未安装 openscience 时，直接向用户呈现产物与 warn 清单、等用户口头 approve / revise / reject 即可，其余流程不变。

## 输出模板

```markdown
## 协议编译/校验结果：<protocol_id>

- 产物：`protocol.yaml` / 编译报告 / `protocol-source.json` 的路径
- 阶段数与覆盖：<N 阶段，是否覆盖十个规范阶段>
- 校验发现：<逐条 [error|warn]，无则写"no issues">
- 源引用：<locked revision 或 unresolved>
- 待审批：是 / 否（stage gate 状态）
```

## 本技能不做什么

- 不发明协议内容：编译是结构化与校验，不替作者补写科学决策；草稿缺什么就如实报 error。
- 不猜 revision：没有 lock 时 `protocol-source.json` 写 `null`/`unresolved`。
- 不跳过 stage gate：编译通过 ≠ 可以直接进入下一步，审批权在用户。
- 不把 warn 当 ok：warn 必须逐条向用户披露。

## 收尾与下一步

- 报告编译状态与全部发现，提交 stage-gate 等待 approve / revise / reject。
- approve 后：下一步通常是 binder-replay（回放已记录的 campaign）或 binder-agent-eval（用 stage slice 驱动决策评测）。
