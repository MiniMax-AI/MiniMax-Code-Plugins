# PR 状态

> 最后更新:2026-08-25

## 当前状态

| 项 | 值 |
|---|---|
| **PR 编号** | [#18](https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/18) |
| **PR URL** | https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/18 |
| **目标分支** | MiniMax-AI/MiniMax-Code-Plugins:main |
| **来源分支** | antianqi/MiniMax-Code-Plugins-1:main |
| **状态** | OPEN — review: CHANGES_REQUESTED by hetaoBackend |
| **当前版本** | v1.0.2 (patch: README 4-section disclosure) |
| **前一版本** | v1.0.1 (documentation refresh) |
| **Plugin size** | 23 Skills(在 64 上限内)+ 1 manifest + 1 README + 1 LICENSE |
| **变更** | +3xxx / -xxx 行,28 文件 |
| **静态 CI** | ⚠️ [code]smith: SKIPPED |
| **CodeQL** | 待扫 |
| **官方 review** | ⚠️ hetaoBackend (COLLABORATOR): 3 个 CHANGES_REQUESTED issues,正在修复 |

## 已知 reviewer issues(2026-08-25 收到)

来自 hetaoBackend 评审,3 个 blocking 问题:

### Issue 1 · 文档版本不一致
- **现状**:v1.0.2 manifest + OVERVIEW 跟历史 PR-STATUS.md / README changelog 不一致
- **修复**:本文件已重写,统一为 v1.0.2 / 23 Skills

### Issue 2 · Codex-only 工具参数
- **现状**:5 个 Skill 用了 mcode 不存在的 Codex 工具参数:
  - `fork_turns`(fork-context-decision, parallel-fanout, delegate-with-context)
  - `task_name`(background-task, delegate-with-context)
  - `bash(action="kill")`(background-task)
  - `subagent=...`(parallel-fanout, delegate-with-context)
  - `reasoning_effort`(model-router)
- **修复**:SKILL.md 重写,移除 Codex-only 参数,标注为 "Codex 习惯 + mcode 工具的等价为 ..." 注释,example 改为 mcode 实际工具调用形式

### Issue 3 · plugin-authoring / memory 写行为未声明 host 边界
- **现状**:`plugin-author-helper` 和 `long-term-memory` 描述了网络/安装/写文件行为,未声明需 user 确认
- **修复**:每个描述副作用的章节加 "需要 user 确认 / 需要 plugin runtime 支持" 前缀

## 修复计划(commit 拆分)

1. **commit 1**: 修 PR-STATUS.md / README changelog(版本统一)— 立即
2. **commit 2**: 修 5 个 SKILL.md,移除 Codex-only 参数 — 立即
3. **commit 3**: 修 plugin-author-helper + long-term-memory,加 user-confirmation 边界 — 立即

每个 commit 一个 fix,不掺其他改动。
