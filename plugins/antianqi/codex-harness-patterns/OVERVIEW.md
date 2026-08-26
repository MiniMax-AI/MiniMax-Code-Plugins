# codex-harness-patterns — Plugin 总览

> 最后更新:2026-08-26 · **v1.0.4** · **23 Skills**
> Plugin 覆盖率 ~90%+

## 一句话

> **23 个 skill** 把 mcode 从"灵机一动"的工作流,变成 Codex 团队在生产环境验证过的、**完整 agent 生命周期**的工程化体系:
> planning → decomposition → sub-agent parallelism → execution → state tracking → tool discovery → skill/plugin authoring → memory persistence → session branching

## 23 Skill 一览(按生命周期)

| # | Skill | 触发条件 | 一句话 |
|---|---|---|---|
| **规划与拆解** | | | |
| 1 | `plan-stream-emit` | 复杂任务 | 先出 `todowrite` 计划,等 ack 再动 |
| 2 | `parallel-fanout` | 任务可拆 2+ 独立子任务 | 显式 spawn,opt-in,fan-out + 聚合 |
| **子代理派发** | | | |
| 3 | `delegate-with-context` | 调 `task` 派发子 agent | 4-part 信封写进 `prompt`,`subagent_type` 三选一 |
| 4 | `fork-context-decision` | 调 `task` 派发 | 选 `all`/`N`/`none`,把对应内容内联到 `prompt` |
| 5 | `subagent-family-tracking` | 派发了 sub-agent | 跟踪父子线程树 Open/Closed 状态 |
| **执行与状态** | | | |
| 6 | `background-task` | 命令预期 > 30s | `task(run_in_background)` + `task_query`/`task_output`/`task_stop`,或 `bash(run_in_background)` |
| 7 | `streaming-output-reader` | 长流式输出 | bounded chunk + summary,最多 3 次读 |
| 8 | `tool-output-budget` | 工具输出过大 | token-aware head/tail/marker 截断 |
| 9 | `world-state-tracking` | 任务长到丢线索 | 持久化 world state 文件,挺过 compact |
| 10 | `context-pressure-compact` | 多步长任务,context 满 | structured snapshot,64K retention |
| **目标与成本** | | | |
| 11 | `goal-persistence` | 非平凡任务开始 | 设 goal + drift-check + 跟到 compact |
| 12 | `goal-token-budgeting` | 设了 token_budget | 50%/80%/100% 报告,跑超就停 |
| 13 | `model-router` | 子任务 / 重复任务 | cheap/medium/main 思考框架 + session-level 路由 |
| **质量保证** | | | |
| 14 | `review-mode` | 子任务完成 | 切 critic,PASS / FIX / REDO 判决 |
| 15 | `completion-audit` | 说 "done" 前 | 派生需求 + 找证据 + 逐项验 |
| **容错与接力** | | | |
| 16 | `error-recovery-strategy` | 任何失败 | retry / switch / fallback / ask / skip |
| 17 | `retry-with-backoff` | 准备重试 | 显式策略:max/base/max/jitter/budget |
| 18 | `session-handoff` | 会话结束 | 写 handoff 文件,下次 30 秒接上 |
| **新(v1.0.0)·持久化与发现** | | | |
| 19 | `long-term-memory` | 设计跨 session 记忆 | Phase 1/2 extract+consolidate+citation,git baseline |
| 20 | `skill-auto-select` | 设计可被 agent 选择的 skill | 3 层匹配 + `$name` mention + 防歧义 |
| 21 | `plugin-author-helper` | 写 marketplace plugin | manifest 格式 + 3-layer sync + idempotency |
| 22 | `tool-discovery-pattern` | 设计可被 agent 发现的 tool | defer_loading + 7-type schema + tool_suggestion |
| 23 | `session-branch-fork` | 设计 session 分支/回滚/恢复 | paginated + lineage + CAS + bounded replay |

## 完整生命周期图

```
┌──────────────────────────────────────────────────────┐
│                  完整 agent 生命周期                    │
└──────────────────────────────────────────────────────┘

  输入
   │
   ├─→ 【1. plan-stream-emit】      规划:出计划
   │
   ├─→ 【2. parallel-fanout】        拆解:fork 多个子任务
   │      │
   │      ├─→ 【3. delegate-with-context】  写简报 + 信封
   │      ├─→ 【4. fork-context-decision】  选 fork_turns
   │      └─→ 【5. subagent-family-tracking】  跟踪父子树
   │
   ├─→ 【6. background-task】        后台化长命令
   ├─→ 【7. streaming-output-reader】   bounded chunk 读流
   ├─→ 【8. tool-output-budget】     截断大输出
   │
   ├─→ 【9. world-state-tracking】   持久化世界状态
   ├─→ 【10. context-pressure-compact】  context 满时 snapshot
   │
   ├─→ 【11. goal-persistence】     设 goal,drift check
   ├─→ 【12. goal-token-budgeting】  50/80/100% 报告
   ├─→ 【13. model-router】        选 model,分 cheap/medium/main
   │
   ├─→ 【14. review-mode】         切 critic,出 verdict
   ├─→ 【15. completion-audit】     派生需求 + 验证
   │
   ├─→ 【16. error-recovery-strategy】 失败:retry/switch/ask
   ├─→ 【17. retry-with-backoff】   显式重试策略
   │
   ├─→ 【18. session-handoff】     写 handoff
   │
   ├─→ 【19. long-term-memory】    跨 session 记忆
   │      │
   │      ├─→ 【20. skill-auto-select】     选 skill
   │      ├─→ 【21. plugin-author-helper】 写 plugin
   │      └─→ 【22. tool-discovery-pattern】 选 tool
   │
   └─→ 【23. session-branch-fork】  分支 / 回滚 / 恢复
```

## 与 Codex 源码的对应

每个 Skill 的 frontmatter `metadata.inspired-by` 字段指向具体的 Codex 源文件。
Plugin 覆盖率 ~90%+ — 还有 ~12 个模式因安全/UI/voice/横向对比等原因被排除。

详见 `codex-harness-engineering/CATALOG.md`。

## 版本与里程碑

| 版本 | 阶段 | 发布 |
|---|---|---|
| v0.1.0 - v0.5.0 | 0 | 4→14 skills |
| v0.6.0 | 0 | 18 skills |
| v0.6.2 - v0.7.5 | 1-3 | 30+ 知识笔记 + 路线图 |
| **v1.0.0** | 4 | **23 skills(当前)** |

## 设计原则

每个 Skill 都遵循同一结构:
- `description` 用 4 行格式(`USE WHEN / TRIGGER PHRASES / SKIP WHEN`,EN+中文)
- "When to use" + "When NOT to use" 显式声明
- Process 编号步骤
- Output contract 给出契约
- Common pitfalls 列出反模式
- Verification checklist 供自检

这一致性让 LLM 能可靠选择 Skill,让维护者能审计 Skill 质量。
