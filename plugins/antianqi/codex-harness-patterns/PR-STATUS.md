# PR 状态

> 最后更新:2026-08-26

## 当前状态

| 项 | 值 |
|---|---|
| **PR 编号** | [#18](https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/18) |
| **PR URL** | https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/18 |
| **目标分支** | MiniMax-AI/MiniMax-Code-Plugins:main |
| **来源分支** | antianqi/MiniMax-Code-Plugins-1:main |
| **状态** | OPEN — review: CHANGES_REQUESTED by hetaoBackend(round 1 + round 2,正在修复) |
| **当前版本** | v1.0.4 (patch: 5 Skills rewritten against mcode 0.2.4 actual `task` / `bash` schema; 23-Skill frontmatter static check added) |
| **前一版本** | v1.0.3 (patch: 4 Skill bodies corrected per reviewer #2 round 1) |
| **Plugin size** | 23 Skills(在 64 上限内)+ 1 manifest + 1 README + 1 LICENSE |
| **变更** | +xxx / -xxx 行,x 文件 |
| **静态 CI** | ⚠️ [code]smith: SKIPPED |
| **CodeQL** | 待扫 |
| **官方 review** | ⚠️ hetaoBackend (COLLABORATOR): round 1 = 3 issues, round 2 = 6 specific points under the same PR; round 2 in flight |

## 已知 reviewer issues(2026-08-25 收到 round 1,2026-08-26 收到 round 2)

来自 hetaoBackend 评审。

### Issue 1 · 文档版本不一致
- **现状**:v1.0.2 manifest + OVERVIEW 跟历史 PR-STATUS.md / README changelog 不一致
- **修复**:本文件已重写,统一为 v1.0.3 / 23 Skills(2026-08-26)

### Issue 2 · Codex-only 工具参数(round 1)+ 不准确的 mcode 适配(round 2)
- **Round 1 现状**:5 个 Skill 用了 mcode 不存在的 Codex 工具参数:
  - `fork_turns` / `subagent=...` / `reasoning_effort` 等
- **Round 1 修复**:
  - 1f4530c2:SKILL.md 重写,移除 Codex-only 参数,标注为 "Codex 习惯 + mcode 工具的等价为 ..." 注释
  - 72952c9(v1.0.3 amend):example 改为 mcode 实际 `task(agent_name=...)` 调用形式;同步删除 `assets/agents/<name>/agent.md` 这种不存在的 host 内部路径断言
- **Round 2 现状**(在 `7de6d539` 上 reviewer 提出 6 个具体点):
  1. `fork-context-decision` 有重复 frontmatter block(round 1 未修干净)
  2. `fork-context-decision` example 仍含 `history=...` PLACEHOLDER
  3. `background-task` 仍含 `bash(task_name=..., run_in_background=true)` + `bash(action="kill")` 伪代码
  4. `delegate-with-context` / `parallel-fanout` 把 task 调用形状留给读者
  5. 必须按 mcode 实际契约重写 **或** 明确标 host-independent Codex 伪代码
  6. 加 23-Skill frontmatter 静态检查
- **Round 2 修复**(v1.0.4 amend):
  - 通过读 `C:\Users\Administrator\.minimax-code\node_modules\@minimax-ai\code\cli.js` 直接拿到 mcode 0.2.4 `task` / `bash` / `task_query` / `task_output` / `task_stop` 的实际 schema(`cli.js:B6c` / `cli.js:xza` / `cli.js:iRt`)
  - 5 个 Skill 全部用真实 mcode API 重写:
    - `task(description, prompt, subagent_type, run_in_background?)` — 4 个 params 都是真实 mcode 字段
    - `subagent_type` 是 canonical,`agent_name=` 是运行时别名(`cli.js:j6c` normaliser)
    - `mavis` 是 root agent,不是 sub-agent(没有 `agent.md` manifest);`subagent_type` 只能从 `{explore, worker, verifier}` 选
    - mcode 0.2.4 没有 `history=` / `fork_turns=` / `context_size=` — 3 fork 模式通过在 `prompt` 里内联多少 prior turns 来表达
    - mcode 0.2.4 没有 per-call `model_config_id` — 模型选择是 session-level,`model-router` 重写为思考框架 + spawn gate
    - 后台任务:`task(run_in_background: true)` 返回 `task_id`,用 `task_query` / `task_output` / `task_stop` 管理
    - 后台 shell:`bash(command, run_in_background: true)`,杀掉靠 host job-control API(Windows `Stop-Process`,POSIX `kill`)走**foreground** `bash` 调用
  - 新增 `test/codex-harness-patterns.test.mjs`:23-Skill frontmatter 静态检查 + 5 个 task-touching Skills 的 mcode schema pinning

### Issue 3 · plugin-authoring / memory 写行为未声明 host 边界
- **现状**:`plugin-author-helper` 和 `long-term-memory` 描述了网络/安装/写文件行为,未声明需 user 确认
- **修复**(commit 6f1a6150):每个描述副作用的章节加 "需要 user 确认 / 需要 plugin runtime 支持" 前缀

## 修复 commit 历史

| commit | 内容 |
|---|---|
| 5b7f1a8c | v1.0.2:README 4 段披露 |
| 1f4530c2 | reviewer #2 round 1(伪代码 + 适配说明) |
| 6f1a6150 | reviewer #3(plugin-author-helper / long-term-memory host 边界) |
| 72952c9 | v1.0.3 amend:replayer #2 round 1(实际 `task(agent_name=...)` 语法) |
| a9f80c3 | docs:version references 1.0.2 → 1.0.3 |
| aa77b1c | fix:hardcoded path + stale frontmatter reference 清理 |
| (v1.0.4) | reviewer #2 round 2:5 Skills 按 mcode 0.2.4 真实 `task` / `bash` schema 重写;新增 23-Skill frontmatter 静态检查 |
