# codex-harness-patterns

A focused collection of Skills distilled from the **OpenAI Codex harness v0.149.0** execution
model (`codex-rs/core/`). These Skills teach a MiniMax Code agent how to survive long-running
multi-step tasks without losing focus, blowing its token budget, stalling on serial work,
shipping unverified changes, burning context on bad sub-agent briefs, drifting from the
original goal, paying main-model prices for cheap-model work, losing track of which
sub-agent is doing what, failing on transient errors without a budget, reading streaming
output without filling context, or losing work at session end.

## v1.0.3 changelog (this release)

> **类型**:patch · **Skill 主体修正** · 4 个 Skill 的 mcode 适配注释从"伪代码"升级到 mcode 实际 `task(agent_name=...)` 语法;修复 v1.0.3.1 草稿的 frontmatter 结构损坏

### Fixed

- `fork-context-decision` `0.1.2 → 0.2.0`:example 调用从 "Codex-style `task(subagent=..., fork_turns=...)` 伪代码" 改为 mcode 实际 `task(agent_name=..., brief=..., history=...)` 语法;清掉 v1.0.3.1 草稿的重复 `metadata:` 块、孤立 YAML、body 中重复 `# Fork Context Decision` 标题、stray `---` 分隔符(YAML 解析拿到错的 version 字段)
- `delegate-with-context` `1.0.2 → 1.1.0`:同上,example 改用 `agent_name="explore"`;删除"工具集是 yaml 写死"这种 host 内部实现细节的断言
- `parallel-fanout` `1.0.2 → 1.1.0`:同上;删除"Reads each agent's tool whitelist from mcode assets/agents/&lt;name&gt;/agent.md"这种引用不存在路径的断言
- `model-router` `0.3.2 → 0.3.3`:恢复 portable 3-tier rubric;删除"agent_type 已经隐含 tier"这种依赖不存在 yaml 配置的强断言;`reasoning_effort` 显式标注为 Codex-only、mcode 不暴露

### Compliance

- 4 段独立披露(no credentials / no network / no telemetry / no third-party services)— v1.0.2 已加,本版本未改
- 跨平台 path 解析 — `assets/agents/<name>/agent.md` 这种相对路径断言已删除
- Skill-only plugin(无 `mcp.json` / 无 `package.json` / 0 npm 依赖)— 不变
- 一个 commit 一个 fix — 本次 amend 把 4 个 Skill 的修复合到同一个 v1.0.3 commit,因为它们都是 reviewer issue 2 的同一根因(Codex-style 参数名 → mcode-actual 参数名)

### Not changed

- 23 skill 整体布局与触发条件
- 4 段独立披露格式
- License
- README 的其他部分

## v1.0.2 changelog (previous)

> **类型**:patch · **Skill 主体不变** · README 加 4 段独立披露(满足 mcode plugin 提交规范)

### Added

- README 新增 `Disclosure (per mcode plugin convention)` 一节,4 段独立披露:
  - **No credentials** — 不读 / 存 / 传 / 请求任何凭据
  - **No network** — 任何出站调用 / socket / 自动更新
  - **No telemetry** — 任何自身指标 / trace / event / log
  - **No third-party services** — 不绑 MCP / npm / 原生 binary / 外部 runtime
- PR #18 body 改为 `Design compliance / Validation / Test evidence` 三段式

### Compliance

- mcode `~/.minimax/memory/user.md` 第 36-42 行规定的 4 段披露格式 — 现在 README 显式列出
- 跨平台 path 解析 — 已验证无硬编码 `C:\` / `D:\` / `/Users/` / `/home/`
- Skill-only plugin (无 `mcp.json` / 无 `package.json` / 0 npm 依赖) — 已声明
- 一个 commit 一个 plugin 范围 — 此次只改 README

### Not changed

- 23 skill 主体(版本号不变)
- 23 skill frontmatter
- plugin.json 其他字段
- License

## v1.0.1 changelog (previous)

> **类型**:patch · **Skill 主体不变** · 文档收尾(OVERVIEW.md / STATUS.md 全面刷新 + PR #18 title 更新)

### Added

- `OVERVIEW.md` 全面刷新 — 23 Skills 按生命周期分组 + 完整生命周期图
- `PR-STATUS.md` 同步到 v1.0.0 状态
- PR #18 title 更新为 "v1.0.0 — 23 Skills covering complete agent lifecycle"
- PR #18 body 全面重写 — 23 Skills 表格 + v0.1.0 - v1.0.0 完整 changelog

### Not changed

- 23 skills 主体(版本号全部不变)
- 23 skills frontmatter

## v1.0.0 changelog (previous) 🎉

> **类型**:**MAJOR** · **Plugin 1.0 里程碑** · 5 个新 skill + 完整生命周期覆盖

### 🎉 v1.0 里程碑

Plugin 现在覆盖 Codex agent 的**完整生命周期**:
```
planning → decomposition → sub-agent parallelism → execution →
state tracking → tool discovery → skill/plugin authoring →
memory persistence → session branching
```

**23 个 Skill**(从 18 增加到 23),Plugin 覆盖率 **~90%+**。

### Added — 5 个新 Skill

| # | Skill | 用途 | 灵感来源 |
|---|---|---|---|
| 19 | `long-term-memory` | 跨 session 长期记忆设计(Phase 1/2 提取 + 合并 + citation) | `codex-rs/memories/` |
| 20 | `skill-auto-select` | 设计可被 LLM 可靠选择的 skill(三层匹配 + mention 语法) | `codex-rs/skills/` |
| 21 | `plugin-author-helper` | 写 marketplace Plugin(manifest 格式 + 3-layer sync + idempotency) | `codex-rs/core-plugins/` |
| 22 | `tool-discovery-pattern` | 设计可被 agent 发现的 tool(defer_loading + 7-type schema) | `codex-rs/tools/` |
| 23 | `session-branch-fork` | session 分支 / 回滚 / 恢复(paginated + lineage + ModelContext) | `codex-rs/thread-store/` |

### Coverage journey

- **v0.6.2 (开始)**:60% 覆盖
- **v0.7.0 (阶段 1 完成)**:78%
- **v0.7.5 (阶段 3 完成)**:88%
- **v1.0.0 (阶段 4 完成)**:~90%+

### Not changed

- 18 个原有 skill 主体不变,版本号不变
- 原有 18 skill 的 frontmatter / 触发条件不变

## v0.7.5 changelog (previous)

> **类型**:patch · **Skill 主体不变** · 研究状态更新(阶段 3 边角 crate 收口)

### Added

- 1 篇新知识笔记(对 `apply-patch` / `context-fragments` / `mcp-server` / `app-server-daemon`):
  - `P-148-156-edge-crates.md`(5KB)— Apply Patch Lark grammar + Context Fragments + MCP Server + App Server Daemon
- CATALOG 状态:🟢 108→112 / 🟡 3→3

### Key insight

**Codex 边角能力**:
- **Apply Patch** — 自有 Lark grammar,lenient 解析
- **Context Fragments** — 带 metadata 的 context 片段(`AnnotatedContent`)
- **MCP Server** — Codex 自身可作为 MCP tool(`codex_tool_runner`)
- **App Server Daemon** — 自我管理 binary + SHA256 + self-update loop

### Not changed

- 18 skill 主体(版本号全部不变)

## v0.7.4 changelog (previous)

> **类型**:patch · **Skill 主体不变** · 研究状态更新(阶段 2 周 8)

### Added

- 1 篇新知识笔记(对 `codex-rs/protocol/src/` 关键未读模块):
  - `P-128-protocol-capabilities-user-input.md`(7KB)— Capabilities + UserInput + OpenAI Models + Config Types + Permission Intersection
- CATALOG 状态:🟢 100→108 / 🟡 3→3

### Key insight

**Codex 协议层模式**:
- **跨 4 边界共享**(core / TUI / app-server / SDK) — 字段默认必须保留
- **TS + JsonSchema 双重 derive** — 自动生成 TypeScript + JSON Schema
- **`ts(export_to = "v2/")` 版本化** — 协议分版本
- **Two-stage Parse** — API 变化时自动 fallback
- **Intersection<T>** — 权限 / 配置用集合论组合
- **deprecated 但保留** — 向后兼容

## v0.7.3 changelog (previous)

> **类型**:patch · **Skill 主体不变** · 研究状态更新(阶段 2 周 7)

### Added

- 2 篇新知识笔记(对 `codex-rs/rollout/` + `codex-rs/models-manager/` 深读):
  - `P-117-127-rollout-persistence.md`(4KB)— zstd 压缩 + ReverseJsonlScanner + RolloutReferenceIndex
  - `P-128-133-models-manager.md`(5KB)— ModelsEndpointClient trait + 5min 文件 cache + 1177 行 models.json
- CATALOG 状态变更:`P-117/118/119/120 + P-128/129/130/132` 🟡→🟢(8 个)

### Key insight

- **zstd + 反向扫描** — 冷 rollout 自动压缩,反向读只取末段
- **RolloutReferenceIndex** — 不读文件就能回答"谁引用了我"
- **models.json 1177 行** — 完整 capability matrix(input_modalities/truncation_policy/prefer_websockets/...)
- **ModelsEndpointClient trait** — 多 provider 抽象

### Not changed

- 18 skill 主体(版本号全部不变)
- 18 skill frontmatter

## v0.7.2 changelog (previous)

> **类型**:patch · **Skill 主体不变** · 研究状态更新(阶段 2 周 6)

### Added

- 4 篇新知识笔记(对 `codex-rs/tools/` 25+ 文件深读):
  - `P-107-108-tool-discovery-search.md`(5KB)— DiscoverableTool 二维分类 + `defer_loading` 搜索结果
  - `P-109-111-dynamic-mcp-tool.md`(6KB)— 简单 vs 复杂适配器 + OpenAI 协议补全
  - `P-112-113-plugin-install-responses-api.md`(5KB)— Tool suggestion 审批 + Responses API 5 个类型
  - `P-114-116-json-schema-image-response-history.md`(5KB)— 7 type subset + BTreeMap 稳定输出
- CATALOG 状态变更:`P-107/108/109/110/111/112/113/114` 🟡→🟢(8 个)
- **🟢 首次突破 100 个已掌握模式**

### Key insight

**Tool 运行时全栈**:
- **Discovery** — DiscoverableTool(Connector/Plugin × Install/Enable 二维)
- **Search** — `defer_loading` 模式(搜索结果只含 name+description,schema 延迟加载)
- **Dynamic vs MCP** — 简单透传 vs 复杂 schema 补全(`properties` 必填兜底)
- **Install** — `request_plugin_install` 走 `tool_suggestion` 审批类型
- **JSON Schema** — OpenAI Structured Outputs 子集(7 type + 3 composition)
- **Responses API** — 5 个类型(Function / Custom / Namespace + 嵌套)

**Plugin 不直接涉及 tool**,但**借鉴模式**:
- "简单 vs 复杂适配器" — Plugin manifest 也是
- "defer loading" — Skill description 应当简洁
- "OpenAI 协议补全" — 跟 3rd-party 兼容
- "Tool suggestion 审批" — 任何"加新能力"都该走审批

### Not changed

- 18 skill 主体(版本号全部不变)
- 18 skill frontmatter

### Roadmap progress

| 阶段 | 状态 | 覆盖率 |
|---|---|---|
| 0 · 错判修正 | ✅ v0.6.2 | 60%→62% |
| 1 · 5 大核心 | ✅ v0.7.0 | 62%→78% |
| 2 · 周 5 agent + session | ✅ v0.7.1 | 78%→80% |
| **2 · 周 6 tools/** | ✅ **v0.7.2** | **80%→83%** |
| 2 · 周 7 rollout/ + models-manager/ | ⏳ 下一步 | — |

## v0.7.1 changelog (previous)

> **类型**:patch · **Skill 主体不变** · 研究状态更新(阶段 2 周 5)

### Added

- 4 篇新知识笔记(对 `codex-rs/core/src/agent/` + `codex-rs/core/src/{session,context_manager}/` 关键未读模块深读):
  - `P-134-138-agent-registry.md`(7KB)— AgentRegistry + Mutex/Atomic 双层 + "Customize OR reduce, never REPLACE" 角色覆盖
  - `P-140-142-context-manager.md`(5KB)— ContextManager `Arc<Vec>` CoW + history_version + reference snapshot diff
  - `P-158-turn-suspension.md`(6KB)— 完整 9 步 suspend 流程 + 7 大设计原则
  - `P-157-162-session-infrastructure.md`(5KB)— Rollout budget / MCP refresh / Input queue / Elicitation / Time reminder
- CATALOG 状态变更:`P-134 / P-137 / P-138 / P-140-142 / P-157-160` 🟡→🟢(10 个)

### Key insight

**Codex session 中断的完整生命周期** = `Op::SuspendTurnAndShutdown` → 9 步 suspend 流程 → `Op::RecoverTurn` 恢复。
关键设计:
- Snapshot vs Seal(descendants 检查接受 best-effort)
- Flush Before Cancel(持久化失败就让原 turn 继续)
- No Terminal Event(故意给 RecoverTurn 留恢复口)
- Event After Writer Closed(防并发写顺序)
- Handoff Drops State(pending input 不持久化)

### Not changed

- 18 skill 主体(版本号全部不变)
- 18 skill frontmatter

### Roadmap progress

| 阶段 | 状态 | 覆盖率 |
|---|---|---|
| 0 · 错判修正 | ✅ v0.6.2 | 60%→62% |
| 1 · 5 大核心 | ✅ v0.7.0 | 62%→78% |
| **2 · 周 5 agent + session** | ✅ **v0.7.1** | **78%→80%** |
| 2 · 周 6 tools/ | ⏳ 下一步 | — |

## v0.7.0 changelog (previous)

> **类型**:**minor** · **Plugin 里程碑** · 阶段 1(5 大核心 crate)整圈收口 · **Skill 主体不变**

### Added

- 4 篇新知识笔记:
  - `P-93-95-plugin-loader-marketplace-manifest.md`(7KB)— Plugin 运行时 + marketplace + manifest 三件套
  - `P-99-plugin-startup-sync.md`(4KB)— 3 层 fallback + lock file + SHA 缓存
  - `P-164-prompts-compact.md`(3KB)— compact 5 个 must-have
  - `P-165-prompts-goals.md`(5KB)— 4 大设计原则(防 prompt injection / 防偷工减料)
  - `P-166-168-prompts-permissions-realtime-review.md`(8KB)— 3 套 permissions + 3 套 realtime + 3 套 review
- CATALOG 状态变更:`P-93/94/95/99 + P-164/165/166/167/168` 全部 🟡→🟢

### 阶段 1 整圈收口

| 周 | crate | 状态 | 发布 |
|---|---|---|---|
| 1 | `codex-rs/memories/` 21 文件 | ✅ | v0.6.3 |
| 2 | `codex-rs/skills/` 10+ 文件 | ✅ | v0.6.4 |
| 3 | `codex-rs/thread-store/` 40+ 文件 | ✅ | v0.6.5 |
| 4 | `codex-rs/core-plugins/` 60+ 文件 + `codex-rs/prompts/` 4 套 | ✅ | **v0.7.0** |

**5 大核心 crate 全部完成**:
- ✅ memories (跨 session 长期记忆)
- ✅ skills (Plugin 直接对应物)
- ✅ thread-store (完整 session 持久化)
- ✅ core-plugins (Plugin 运行时)
- ✅ prompts (4 套 prompt 模板)

**Plugin 覆盖率**:**72% → 78%**(+6%,阶段 1 净增 16%)

### Not changed

- 18 skill 主体(版本号全部不变)
- 18 skill frontmatter

### Next

- 阶段 2(周 5-8):core/agent/ + core/session/ + tools/ + rollout/ + models-manager/ + protocol/
- 阶段 3(周 9-10):边角 crate 收口
- 阶段 4(周 11-12):5 个新 skill + Plugin v1.0

## v0.6.5 changelog (previous)

> **类型**:patch · **Skill 主体不变**(18 个 0.x.y 版本号不变) · 研究状态更新(阶段 1 周 3 完成)

### Added

- 6 篇新知识笔记(对 `codex-rs/thread-store/` 40+ 文件深读 — **完整 session 持久化层**):
  - `P-67-thread-sections.md`(4KB)— section 管理 + operation-tagged state access
  - `P-68-thread-projects.md`(4KB)— projects + `Option<Option<T>>` 三态 + idempotency key
  - `P-69-70-queue-search.md`(5KB)— queue change-based polling + search snippet
  - `P-71-72-migration-lineage.md`(6KB)— Legacy→Paginated migration + bounded subagent replay
  - `P-76-model-context-reconstruction.md`(4KB)— ReverseJsonlScanner + bounded replay
  - `P-77-thread-history-segmentation.md`(5KB)— 跨 segment 双向 cursor + 防溢出
- CATALOG 状态变更:`P-67 / P-68 / P-69 / P-70 / P-71 / P-72 / P-76 / P-77` 全部从 🟡→🟢
- **CATALOG 状态首次全清零**:`🟡 1→0` —— 所有 🟡 模式都进入 🟢

### Key insight

`thread-store/` 是 Codex session 持久化的**完整基础设施**:
- Sections / Projects / Queue / Search 提供**管理面**
- Rollout Lineage / Migration / ModelContext reconstruction 提供**历史面**
- ThreadStore trait + `LocalThreadStore` + `InMemoryThreadStore` 提供**抽象层**

新 skill `session-branch-fork`(阶段 4)的核心参考全部在这里。

### Not changed

- 18 skill 主体(版本号全部不变)
- 18 skill frontmatter

### Roadmap progress

| 阶段 | 状态 | 覆盖率 |
|---|---|---|
| 0 · 错判修正 | ✅ v0.6.2 | 60%→62% |
| 1 · 周 1 memories/ | ✅ v0.6.3 | 62%→64% |
| 1 · 周 2 skills/ | ✅ v0.6.4 | 64%→66% |
| **1 · 周 3 thread-store/** | ✅ **v0.6.5** | **66%→72%** |
| 1 · 周 4 core-plugins/ + prompts/ | ⏳ 下一步 | — |

## v0.6.4 changelog (previous)

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
| 3 | `parallel-fanout` | The user task is clearly decomposable into 2+ independent sub-tasks (independent files, independent probes, independent analyses). | v0.1.0 → v1.1.0 |
| 4 | `plan-stream-emit` | The user task is non-trivial and the user has not yet approved a plan; emit a structured plan before touching files. | v0.1.0 → 0.1.1 |
| 5 | `review-mode` | A non-trivial sub-task has just finished and the work is about to be marked done; the user wants verification before relying on the result. | v0.2.0 → 0.2.1 |
| 6 | `delegate-with-context` | About to call `task` to hand off a sub-task; the full conversation history is too large to forward and a minimal-context brief would do. | v0.2.0 → v1.1.0 |
| 7 | `world-state-tracking` | The task is long enough that the agent has lost the thread at least once, or `context-pressure-compact` is about to be applied. | v0.2.0 → 0.2.1 |
| 8 | `background-task` | A command is expected to take > 30 seconds, or the user wants a long-running process to coexist with ongoing work. | v0.2.0 → 0.1.1 |
| 9 | `goal-persistence` | A non-trivial task has just been stated (set the goal); the user has redirected (update the goal); or a `context-pressure-compact` is about to be applied (alignment check). | v0.3.0 → v1.0.1 |
| 10 | `model-router` | About to call `task` for a non-trivial sub-task, or about to spend the main model on work a cheaper model could do. | v0.3.0 → v0.3.3 |
| 11 | `completion-audit` | About to say "done" / "complete" / "ship it" on a non-trivial task. Derives requirements, identifies authoritative evidence, verifies each. | v0.4.0 → 0.4.1 |
| 12 | `fork-context-decision` | About to call `task` to hand off a sub-task. Decides how much parent context to give the sub-agent via the `fork_turns` parameter. | v0.4.1 → v0.1.0 → v0.2.0 |
| 13 | `subagent-family-tracking` | Spawned a sub-agent (or have one running). Track the parent/child tree so you do not lose children, duplicate work, or leave anyone running. | v0.5.0 → 0.5.1 |
| 14 | `goal-token-budgeting` | The user set an explicit `token_budget` on a goal. Track running usage against the budget and report the final number on completion. | v0.5.0 → 0.5.1 |
| 15 | `error-recovery-strategy` | A tool call, sub-agent task, or external operation failed. Decide between retry / switch / fallback / ask-user / skip. | v0.6.0 → 0.6.1 |
| 16 | `retry-with-backoff` | About to retry a `transient` error. State the policy first: max attempts, base delay, max delay, jitter, total time budget. | v0.6.0 → 0.6.1 |
| 17 | `streaming-output-reader` | A tool returns a long stream (SSE / WebSocket / `tail -f` / large log). Read in bounded chunks, synthesize, never loop. | v0.6.0 → 0.6.1 |
| 18 | `session-handoff` | The session is ending (user stepping away, time up, about to compact). Write a handoff file so next session can pick up in 30 seconds. | v0.6.0 → 0.6.1 |

## Disclosure (per mcode plugin convention)

The four sections below are explicit, independent disclosures as required by the mcode
plugin submission convention. They are the single source of truth for this Plugin's
runtime surface area; if any of them is false for a future change, update them in the
same commit.

### No credentials

The Plugin does not read, store, transmit, or request any credential. It does not declare
an OAuth flow, does not require environment variables, does not embed tokens, and does not
have a service account. The 23 Skills are pure Markdown instructions; activating a Skill
does not require or produce any secret material.

### No network

The Plugin makes no outbound network call. It does not bundle a fetch / download /
auto-update step; it does not register a webhook or a long-poll; it does not open a socket
of any kind. Skill contents are read from the local `skills/` directory only, and the
agent's existing tool surface (`bash`, `read`, `write`, `edit`, `grep`, `glob`, `task`)
is the only thing the Skills can ask the agent to do.

### No telemetry

The Plugin does not emit events, metrics, traces, or logs of its own. It does not register
a counter, does not tag rollouts, and does not write a heartbeat. Any observability the
Plugin produces is the same observability the agent would produce if a human typed the
same instructions by hand.

### No third-party services

The Plugin does not depend on any external service. It does not bundle a native binary,
does not call an MCP server, does not `npm install` anything at install time, and does
not require Python, Node, or any runtime besides the host agent. The 23 Skills are
self-contained Markdown; the `plugin.json` declares no `mcp.json` and no
`package.json`.

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
