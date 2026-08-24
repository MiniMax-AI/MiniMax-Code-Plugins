# codex-harness-patterns

A focused collection of Skills distilled from the **OpenAI Codex harness v0.149.0** execution
model (`codex-rs/core/`). These Skills teach a MiniMax Code agent how to survive long-running
multi-step tasks without losing focus, blowing its token budget, stalling on serial work,
shipping unverified changes, burning context on bad sub-agent briefs, drifting from the
original goal, paying main-model prices for cheap-model work, losing track of which
sub-agent is doing what, failing on transient errors without a budget, reading streaming
output without filling context, or losing work at session end.

## v0.6.4 changelog (this release)

> **类型**:patch · **Skill 主体不变**(18 个 0.x.y 版本号不变) · 研究状态更新(阶段 1 周 2 完成)

### Added

- 6 篇新知识笔记(对 `codex-rs/skills/` 10+ 文件深读 — **Plugin 直接对应物**):
  - `P-85-skill-selection-algorithm.md`(6KB)— 显式 + 隐式 selection,`O(T + (N_s + N_t) * S)` 复杂度,三层匹配
  - `P-86-skill-loading.md`(6KB)— 加载抽象 + 缓存 + system skills 嵌入式分发
  - `P-87-skill-frontmatter-parser.md`(6KB)— frontmatter 解析 + `repair_frontmatter_scalar_fields` 容错
  - `P-88-skill-mention-extractor.md`(5KB)— `$skill-name` + `[$name](path)` 链接语法
  - `P-89-implicit-skill-invocation.md`(5KB)— shell 命令隐式调用检测 + 平台感知分词
  - `P-92-skill-metadata-model.md`(6KB)— 完整 11 字段 metadata + 双形态抽象
- CATALOG 状态变更:`P-85 / P-86 / P-87 / P-88 / P-89 / P-92` 全部从 🟡→🟢

### Key insight

Codex skills 系统的 selection/loading/parser/mentions/model 5 个核心模块**直接对应我们 Plugin 的结构**。
Plugin 当前的"skill 选取"能力**远弱于** Codex skills/ — 这是新 skill `skill-auto-select` 的来源(阶段 4 计划)。

### Not changed

- 18 skill 主体(版本号全部不变)
- 18 skill frontmatter

### Roadmap progress

| 阶段 | 状态 | 覆盖率 |
|---|---|---|
| 0 · 错判修正 | ✅ v0.6.2 | 60%→62% |
| 1 · 周 1 memories/ | ✅ v0.6.3 | 62%→64% |
| **1 · 周 2 skills/** | ✅ **v0.6.4** | **64%→66%** |
| 1 · 周 3 thread-store/ | ⏳ 下一步 | — |

## v0.6.3 changelog (previous)

> **类型**:patch · **Skill 主体不变**(18 个 0.x.y 版本号不变) · 研究状态更新(阶段 1 周 1 完成)

### Added

- 4 篇新知识笔记(对 `codex-rs/memories/` 21 文件深读):
  - `P-78-memory-phase1.md`(6KB)— Memory Phase 1:per-rollout extraction,JSON schema 强制 + `buffer_unordered` 并发 + 4 类高信噪比判定
  - `P-79-memory-phase2.md`(8KB)— Memory Phase 2:global consolidation,10 步线性流程 + 全局单 lock + 内部 consolidation agent 锁死配置
  - `P-80-memory-citation.md`(4KB)— MemoryCitation 协议 + `<citation_entries>` / `<rollout_ids>` 解析
  - `P-84-memory-workspace-git.md`(8KB)— Memory workspace + git baseline 模式
- CATALOG 状态变更:`P-78 / P-79 / P-80 / P-84` 全部从 🟡→🟢
- CATALOG §9.2 memory 系统状态列加上"状态"字段

### Not changed

- 18 skill 主体(版本号全部不变)
- 18 skill frontmatter
- Plugin 主合约 / 触发条件 / 输出契约

### Roadmap progress

| 阶段 | 状态 | 覆盖率 |
|---|---|---|
| 0 · 错判修正 | ✅ v0.6.2 完成 | 60%→62% |
| 1 · 5 大核心 crate | 🟢 周 1 完成 | 62%→64% |
| 1 · 周 2 skills/ | ⏳ 下一步 | — |

## v0.6.2 changelog (previous)

> **类型**:patch · **Skill 主体不变**(18 个 0.x.y 版本号不变) · **元数据 + 文档更新**

### Added

- **CATALOG §7 修正**:把之前标 ⛔"范围外"的 4 个 session/thread 模式(`P-49 Fork` / `P-50 Rollback` /
  `P-51 Recover` / `P-52 History Mode`)重新归类为 🟡"待深读" — 它们的真实实现位置是
  `codex-rs/thread-store/`(40+ 文件,完整 fork/revert/recover/segmentation 实现),不是"范围外"。
- **CATALOG §8 修正**:把 `P-63 Skills runtime` 和 `P-64 Memory system` 从 ❌"不在 4 个重点"
  改为 🟡"待深读" — 它们是 Codex 跨 session 长期记忆和 skill runtime 的核心实现,**直接对应
  我们 Plugin 自身结构**(`codex-rs/skills/` + `codex-rs/memories/`)。
- **CATALOG §9 新增**:2026-08-24 复盘发现 ~100 个未研究模式草案,挑选 50+ 高价值列入。最高价值:
  - ⭐⭐⭐⭐⭐ `memories/` Phase 1/2(per-rollout extraction + global consolidation)
  - ⭐⭐⭐⭐⭐ `skills/` 完整 runtime(selection / loading / parser / mentions)
  - ⭐⭐⭐⭐ `core-plugins/` marketplace 运行时
  - ⭐⭐⭐⭐ `tools/` discovery / search / dynamic tool
  - ⭐⭐⭐⭐ `prompts/` 完整 4 套 prompt 模板

### Documentation

- 新增 `research-log/2026-08-24-resurvey-findings.md`(25KB) — 完整复盘报告
- 新增 `RESEARCH-ROADMAP.md`(12KB) — 2-3 月系统性补完计划(阶段 0-4)
- 新增 6 篇纠错笔记(`knowledge/P-{49,50,51,52,63,64}-*.md`)— 详述错判反思 + 实际代码位置

### Honest acknowledgment

这次复盘揭示了 Plugin 实际**只覆盖了 Codex 模式库的 ~60%**。18 skill 跟现有 66-pattern
CATALOG 是一对一覆盖(每个 skill 对应 1 个或几个 P-XX),看起来很整齐,但底层有 6 个错判
没真正读代码就标了 — 意味着对 Codex 怎么管 session/thread/memory 这块没真正搞懂。

`v0.6.2` 不解决覆盖率问题,只**诚实记录**。系统性补完由 v0.7.0 起按周推进。

## v0.6.1 changelog (previous)

### Changed

**Trigger descriptions rewritten across all 18 Skills** for better LLM matching. Each
`description:` frontmatter field now uses a structured 4-line format:

```yaml
description: |
  <one-sentence purpose>.
  USE WHEN: <comma-separated concrete signals and keywords>.
  TRIGGER PHRASES: <user-original-language phrases the user might say>.
  SKIP WHEN: <anti-patterns where this skill does not apply>.
```

This makes the description **keyword-greppable** (so the LLM can match on real signals
like "ECONNREFUSED", "permission denied", "retries exceeded", "上下文满了" / "出错了" /
"重试") instead of trying to interpret abstract prose.

All 18 Skills have their trigger phrases now spelled out in both English and Chinese, so
the LLM can match user language directly. Skill versions bumped to `0.1.1` (or
`1.0.1` for the v1.0 skills).

## Try it

Install from `/plugins` → **Local**, then ask any of:

```text
"Read docs/internal-spec.md and summarize the data model — keep the full file off the main context"

"Refactor the auth subsystem across these 5 files. Plan first, then execute."

"Investigate why the test suite is flaky. Decompose into independent probes and run them in parallel."

"I'm at turn 35 of an open-source contribution. Compress the conversation so I can keep going."

"You just finished the migration — review your own diff for off-by-ones and edge cases."

"Spawn a sub-agent to scan the codebase for unused imports. Give it a tight brief, not the full history."

"Start a long dev server in the background so I can keep asking you things while it warms up."

"Set the goal of this thread: migrate the auth subsystem to OIDC alongside SAML. Drift-check before
each non-trivial change."

"This sub-task is a one-shot file reformat — use the cheap model for it."

"Before you say 'done' on the auth refactor, run a completion audit. Show me the evidence for each requirement."

"I'm about to spawn 4 sub-agents. Decide the fork_turns for each — full history or just the brief?"

"Show me the sub-agent family tree — which are still running?"

"This goal has a 20,000-token budget. Tell me at 50% / 80% / 100%."

"The bash command just failed with 'permission denied'. Retry? Switch tool? Ask me?"

"Read this 50K-line build log without filling the context. Stream-read it and summarize."

"It's the end of the day. Write a handoff file so tomorrow's session can pick up."
```

**Expected result**: the agent picks the right Skill, follows the documented process, and produces
output that matches the Skill's output contract (see each Skill's `SKILL.md` for its specific
contract and example).

## What this Plugin adds (v0.6.0, 18 Skills)

Eighteen Skills, all Skill-only (no MCP server, no network access):

| # | Skill | When to activate | v |
|---|---|---|---|
| 1 | `tool-output-budget` | A tool returns output you suspect is too large to keep verbatim (large logs, JSON, fetched HTML, minified files). | v0.1.0 → 0.1.1 |
| 2 | `context-pressure-compact` | The task is multi-step and long; the running `todowrite` exceeds 5 items, or the agent has been reasoning for many turns. | v0.1.0 → v1.0.1 |
| 3 | `parallel-fanout` | The user task is clearly decomposable into 2+ independent sub-tasks (independent files, independent probes, independent analyses). | v0.1.0 → v1.0.1 |
| 4 | `plan-stream-emit` | The user task is non-trivial and the user has not yet approved a plan; emit a structured plan before touching files. | v0.1.0 → 0.1.1 |
| 5 | `review-mode` | A non-trivial sub-task has just finished and the work is about to be marked done; the user wants verification before relying on the result. | v0.2.0 → 0.2.1 |
| 6 | `delegate-with-context` | About to call `task` to hand off a sub-task; the full conversation history is too large to forward and a minimal-context brief would do. | v0.2.0 → v1.0.1 |
| 7 | `world-state-tracking` | The task is long enough that the agent has lost the thread at least once, or `context-pressure-compact` is about to be applied. | v0.2.0 → 0.2.1 |
| 8 | `background-task` | A command is expected to take > 30 seconds, or the user wants a long-running process to coexist with ongoing work. | v0.2.0 → 0.1.1 |
| 9 | `goal-persistence` | A non-trivial task has just been stated (set the goal); the user has redirected (update the goal); or a `context-pressure-compact` is about to be applied (alignment check). | v0.3.0 → v1.0.1 |
| 10 | `model-router` | About to call `task` for a non-trivial sub-task, or about to spend the main model on work a cheaper model could do. | v0.3.0 → 0.3.1 |
| 11 | `completion-audit` | About to say "done" / "complete" / "ship it" on a non-trivial task. Derives requirements, identifies authoritative evidence, verifies each. | v0.4.0 → 0.4.1 |
| 12 | `fork-context-decision` | About to call `task` to hand off a sub-task. Decides how much parent context to give the sub-agent via the `fork_turns` parameter. | v0.4.0 → 0.4.1 |
| 13 | `subagent-family-tracking` | Spawned a sub-agent (or have one running). Track the parent/child tree so you do not lose children, duplicate work, or leave anyone running. | v0.5.0 → 0.5.1 |
| 14 | `goal-token-budgeting` | The user set an explicit `token_budget` on a goal. Track running usage against the budget and report the final number on completion. | v0.5.0 → 0.5.1 |
| 15 | `error-recovery-strategy` | A tool call, sub-agent task, or external operation failed. Decide between retry / switch / fallback / ask-user / skip. | v0.6.0 → 0.6.1 |
| 16 | `retry-with-backoff` | About to retry a `transient` error. State the policy first: max attempts, base delay, max delay, jitter, total time budget. | v0.6.0 → 0.6.1 |
| 17 | `streaming-output-reader` | A tool returns a long stream (SSE / WebSocket / `tail -f` / large log). Read in bounded chunks, synthesize, never loop. | v0.6.0 → 0.6.1 |
| 18 | `session-handoff` | The session is ending (user stepping away, time up, about to compact). Write a handoff file so next session can pick up in 30 seconds. | v0.6.0 → 0.6.1 |

## Requirements

- **MiniMax Code** with Agent Plugins 1.0 support.
- **No Python, no Node, no external services.** These Skills are pure Markdown instructions; the
  agent applies them with its existing tools (`bash`, `read`, `write`, `edit`, `grep`, `glob`, `task`).
- **No MCP server, no network, no credentials.** This Plugin does not start any process or open any
  socket. It only adds Skill files to the agent.

## Data and network

- **No network access.** This Plugin adds Skills only; it does not call out.
- **No credentials, tokens, env vars, or telemetry.** The agent does not need any of these to
  apply the Skills.
- **No data leaves your machine.** The Skills operate on whatever the agent can already see in
  the workspace.

## Security model

The Skills are read-only instructions. They cannot be used to exfiltrate data, run untrusted code,
or escalate privileges beyond the agent's existing capability set. The only side effect is the
agent choosing to use its existing tools (e.g. `write` a compact summary to disk) — exactly as
the user would do manually.

## How the Plugin is validated

The Plugin was developed against the official `npm run check` workflow (see
`docs/plugin-compatibility.md` in the upstream `MiniMax-Code-Plugins` repo). It declares only
the portable subset (Skills + manifest), includes a real example prompt in this README, and
carries an Apache-2.0 LICENSE matching the host repository.

## License

Apache-2.0
