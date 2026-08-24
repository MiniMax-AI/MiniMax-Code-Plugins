# PR 状态

> 最后更新:2026-08-24

## 当前状态

| 项 | 值 |
|---|---|
| **PR 编号** | [#18](https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/18) |
| **PR URL** | https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/18 |
| **目标分支** | MiniMax-AI/MiniMax-Code-Plugins:main |
| **来源分支** | antianqi/MiniMax-Code-Plugins-1:main |
| **状态** | OPEN |
| **当前版本** | v0.6.1 (patch — frontmatter only) |
| **前一个版本** | v0.6.0 |
| **变更** | +3391 / -0 行,21 个文件 |
| **本地 CI** | ✅ CI: success |
| **第三方 bot** | [code]smith: SKIPPED |
| **安全扫描** | ⏳ CodeQL: 跑过前两次,需要再确认最新 |
| **官方 review** | ⏳ 等维护者 |

## 版本演进

| 版本 | Skills | 主要内容 | 累计 PR 变更 |
|---|---|---|---|
| v0.1.0 | 4 | tool-output-budget / context-pressure-compact / parallel-fanout / plan-stream-emit | +836 |
| v0.2.0 | 8 | + review-mode / delegate-with-context / world-state-tracking / background-task | +1451 |
| v0.3.0 | 10 | + goal-persistence / model-router | +2272 |
| v0.4.0 | 12 | + completion-audit / fork-context-decision;goal-persistence + parallel-fanout 升 v1.0 | +2799 |
| v0.5.0 | 14 | + subagent-family-tracking / goal-token-budgeting;context-pressure-compact + delegate-with-context 升 v1.0 | +3387 |
| v0.6.0 | 18 | + error-recovery / retry / streaming / session-handoff | +3387 |
| **v0.6.1** | **18** | **frontmatter 关键词化(无 skill 变化)** | **+3391** |

## v0.6.1 关键变化

**只改 frontmatter,不改 skill 本体**:

```yaml
# 之前
description: "When a tool call, sub-agent task, or external operation fails, 
              decide between retry / switch / fallback / ask-user / skip..."

# 之后
description: |
  Classify error into 4 buckets (transient / deterministic / stale / unknown) 
  and pick one of 5 actions (retry / switch / fallback / refresh-then-retry / 
  ask-user / skip).
  USE WHEN: tool returns non-success, sub-agent `status: closed-failed`, 
            exception escapes, timeout fires, weird partial-success result, 
            ECONNREFUSED / 5xx / 429 / timeout / permission denied / 
            "command not found" / "fail" / "error" / "出错了" / "挂" / "失败".
  TRIGGER PHRASES: "出错了", "failed", "挂", "error", "失败", "fail", 
            "permission denied", "command not found", "ECONNREFUSED", 
            "timeout", "挂了", "再试一次", "retry", "这不行", "没用", 
            "fallback", "退路", "不行", "跑不通", "broken".
  SKIP WHEN: operation succeeded, error is in user input (clarification case),
            error is part of expected flow (grep 0 matches).
```

**4 段结构**:`USE WHEN` / `TRIGGER PHRASES` / `SKIP WHEN` / 用途

**为什么这次**:
- LLM 看到 "ECONNREFUSED" / "permission denied" / "出错了" / "retry" 这些**真实信号**会精确触发
- 不依赖 LLM 理解抽象描述("when planning complex work" 这种)
- 每次匹配都成功 = skill 真正被用上

**没解决的部分**:
- LLM 仍然**不会**主动每 N 步自检"现在该用什么 skill"
- 这要靠 mavis 工具层加 hook API(Level 4)才能彻底解决
- 在那之前,你(用户)的提醒 + 关键词匹配是兜底

## 完整生命周期覆盖(18 skill,v0.6.1)

```
规划:        plan-stream-emit
拆分:        parallel-fanout + fork-context-decision + delegate-with-context
执行:        background-task + streaming-output-reader
子 agent:    subagent-family-tracking + model-router
质量:        review-mode + completion-audit
状态:        world-state-tracking + goal-persistence + goal-token-budgeting
容错:        error-recovery-strategy + retry-with-backoff
token:       tool-output-budget + context-pressure-compact
收尾:        session-handoff
```

## 当前 18 个 Skill(版本 v0.6.1)

| # | Skill | v | 灵感来源(Codex) | 分类 |
|---|---|---|---|---|
| 1 | `tool-output-budget` | 0.1.1 | `codex-rs/utils/output-truncation/` | 节省 token |
| 2 | `context-pressure-compact` | 1.0.1 | `codex-rs/core/src/compact.rs` | 节省 token |
| 3 | `parallel-fanout` | 1.0.1 | `core/src/thread_manager.rs` (FuturesUnordered) | 并行 |
| 4 | `plan-stream-emit` | 0.1.1 | `protocol/src/protocol.rs` (PlanUpdate / PlanDelta) | 规划 |
| 5 | `review-mode` | 0.2.1 | `protocol/src/protocol.rs` (EnteredReviewMode) | 质量 |
| 6 | `delegate-with-context` | 1.0.1 | `protocol/src/protocol.rs` (InterAgentCommunication) | 拆解 |
| 7 | `world-state-tracking` | 0.2.1 | `codex-rs/core/src/context/world_state.rs` | 状态 |
| 8 | `background-task` | 0.2.1 | `core/src/unified_exec/` + `CleanBackgroundTerminals` | 效率 |
| 9 | `goal-persistence` | 1.0.1 | `ext/goal/templates/goals/continuation.md` | 状态 |
| 10 | `model-router` | 0.3.1 | `codex-rs/model-provider-info/` + `models-manager/` | 成本 |
| 11 | `completion-audit` | 0.4.1 | `ext/goal/templates/goals/continuation.md` (completion-audit 段) | 质量 |
| 12 | `fork-context-decision` | 0.4.1 | `core/src/session/multi_agents.rs` (fork_turns) | 成本 |
| 13 | `subagent-family-tracking` | 0.5.1 | `agent-graph-store/` | 拆解 |
| 14 | `goal-token-budgeting` | 0.5.1 | `ext/goal/src/accounting.rs` | 状态 |
| 15 | `error-recovery-strategy` | 0.6.1 | `code-mode/src/grpc_session/reconnect.rs` | 容错 |
| 16 | `retry-with-backoff` | 0.6.1 | 同上(retry policy 显式化) | 容错 |
| 17 | `streaming-output-reader` | 0.6.1 | `core/src/client.rs::WebsocketSession` + `unified_exec/` | 效率 |
| 18 | `session-handoff` | 0.6.1 | `state/src/runtime/recovery.rs` | 状态 |

## 个人仓库 release

| 版本 | URL |
|---|---|
| v0.6.1 | https://github.com/antianqi/codex-harness-patterns/releases/tag/v0.6.1 |
| v0.6.0 | https://github.com/antianqi/codex-harness-patterns/releases/tag/v0.6.0 |
| v0.5.0 | https://github.com/antianqi/codex-harness-patterns/releases/tag/v0.5.0 |
| v0.4.0 | https://github.com/antianqi/codex-harness-patterns/releases/tag/v0.4.0 |
| v0.3.0 | https://github.com/antianqi/codex-harness-patterns/releases/tag/v0.3.0 |
| v0.2.0 | https://github.com/antianqi/codex-harness-patterns/releases/tag/v0.2.0 |
| v0.1.0 | https://github.com/anianqi/codex-harness-patterns/releases/tag/v0.1.0 |

## 怎么查 PR 状态

```bash
cd C:\Users\Administrator\codex-harness-fork-active
gh pr view 18
gh pr checks 18
gh pr view 18 --comments
```

## 怎么继续加 skill

1. 在 `codex-harness-engineering/CATALOG.md` 找下一个 🟢 模式(当前都是 🟢, 48 个)
2. 在 `codex-harness-engineering/knowledge/P-NN-*.md` 写研究笔记
3. 写 SKILL.md,frontmatter 用 v0.6.1 关键词化格式
4. 复制到 fork 的 skills/ 目录
5. 更新 plugin.json / README / CHANGELOG
6. commit + push(自动更新 PR)
7. 同步 standalone 仓库,标新 tag,发 release
