---
[meta]
title = "PROJECT CHARTER: mcode-webui v2"
status = "DRAFT"
author = "MOC + Mavis orchestration"
date = "2026-09-20"
session_id = "mvs_e9500b92a8a64ca18b0360a552725e8a"
version_target = "v2.0.0"
version_baseline = "v1.0.0"
license = "MIT"
upstream = "MiniMax-AI/MiniMax-Code-Plugins (Wzdhehe/mcode-webui fork)"
fork = "modacker/MiniMax-Code-Plugins (local working fork)"

[scope]
include = [
    "重构 plugins/Wzdhehe/mcode-webui/ 仓库内代码（保留仓库身份，不换仓）",
    "新增 events / alerts / authorize / interaction / feedback 子系统",
    "plugin.json 元数据补齐 + CI 校验脚本",
    "BORROW-harness-v2 / MATH-skeleton / PROJECT-CHARTER / ANTI-PATTERNS-FIX-PLAN 文档",
    "CI 矩阵（Node 22/24 × macOS/Linux/Windows）+ SBOM + CVE",
    "现有 11 条反面模式修复",
    "测试集（单元 + 集成 + 跨传输矩阵 stdio / sse / streamable-http）",
    "fork 路径：/Users/moc/workspaces/MiniMax-Code-Plugins/",
    "编排路径：/Users/moc/workspaces/SiHankor/.tmp/mcode-webui-refactor/",
]
exclude = [
    "MiniMax Code CLI 主仓代码改动",
    "/Users/moc/Harnessies/ 内 DSH 源码读取（待用户授权）",
    "Wzdhehe 接管后的合并 / PR 提交决策",
    "MiniMax-AI 上游 MiniMax-Code-Plugins 仓直接修改",
    "MiniMax Code CLI / Desktop 端代码",
    "MCP server / mavis runtime 代码（不在本 fork 范围内）",
]

[method]
mode = "司衡引擎租约模式（open → commit → close → reconcile）"
worker_agent = "worker"
verifier_agent = "verifier"
self_recheck_protocol = "主会话对每个 worker 子代理交付亲自跑一遍验证，不信 worker 自报"
batch_strategy = "批次 A（文档）→ 批次 B（核心代码）→ 批次 C（外围补强）→ 批次 D（测试集）"
batch_reason = "文档先定调；核心代码依赖文档；测试集验证核心代码；批次内 lease 互不重叠可并行"
sdgg_two_gates = "每个 lease close 过 SDDG 两道门：架构基线对齐 + 治理契约（事件流 / 决策落痕）"
close_gate_since = "2026-09-12"
upstream_ref = "sih-engine/doc/governance/BASELINE-v1.md"

[principles]
disjoint_files = "并行 writer 必须拥有互不重叠的文件（按 moc 工作流偏好：避免重复写 + 避免冲突）"
ai_friendly_format = "TOML frontmatter + Markdown 表格优先；不用 YAML（缩进黑洞）；不堆多层 JSON（嵌套黑洞）"
file_state_suffix = "TASK-XXX.DRAFT.md / .DONE.md / .ARCHIVED.md（按 moc 工作流偏好）"
decision_as_governance = "lease close 决策进 audit chain（按 SiHankor 工程基线第 4 条 + 决策 = 治理对象）"
no_prejudgment = "不事前给倾向判断；列候选可以列拒绝理由，推荐方案必须有数据/内容支撑（2026-08-08 moc 边界）"
backward_compatible = "v2.0.0 在 v1.0.0 token auth 已落地的基线上做加法；v1.0.1 API 不破坏"

[milestones]
a_docs = ["A01", "A02", "A03", "A04"]
b_core = ["B01", "B02", "B03", "B04", "B05"]
c_extras = ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08"]
d_tests = ["D01", "D02", "D03"]
total_leases = 19
batch_a_target = "4 件文档（harness 借鉴 / 数学骨架 / 反面清单 / 本章程）"
batch_b_target = "5 件核心代码（events / alerts / authorize / interaction / plugin.json+CI）"
batch_c_target = "8 件外围补强（db resolver / CI 矩阵 / 限流 / 虚拟化 / 搜索 / 导出 / 预测 / token 模态化）"
batch_d_target = "3 件测试与综合报告（单测 / 集成+跨传输 / verifier 报告）"

[references]
plan_root = "/Users/moc/workspaces/SiHankor/.tmp/mcode-webui-refactor/PLAN-webui-v2-refactor.DRAFT.md"
borrow_dsh_existing = "docs/BORROW-dsh-deepseek-harness-2026-08-28.md"
review_baselines_existing = "docs/REVIEW-sihankor-baselines-2026-08-28.md"
architecture_existing = "docs/ARCHITECTURE.md"
capabilities_existing = "docs/CAPABILITIES.md"
---

# PROJECT CHARTER: mcode-webui v2

> **更正注记（2026-09-20，webui-rigor-fix 批 M1）。** 本章程多处历史行引用
> `.github/workflows/ci.yml` 作为已交付产物——§6 基线表第 5 行（可重现性）、
> §7.3 lease C02 行、§9.1 反面模式表第 11 行——且 [scope] 块列有
> "CI 矩阵（Node 22/24 × macOS/Linux/Windows）+ SBOM + CVE"。这些引用
> 描述的是一个提交在 `plugins/Wzdhehe/mcode-webui/.github/workflows/`
> 之下的 workflow 文件：GitHub 只读取仓库根的 `.github/workflows/`，
> 子目录位置永不触发，一次也没有运行过。该死文件已在 webui-rigor-fix 批 H1
> 删除，真实门禁（市仓根 validate + 本地全量门 + 本地矩阵 recipe）现由
> `docs/CI.md` 如实承载。本注记更正记录，不重写下方历史行。

> 本章程定义 `modacker/MiniMax-Code-Plugins` fork 下 `plugins/Wzdhehe/mcode-webui/` 从 v1.0.0 → v2.0.0 重构的**范畴、目标、形态、里程碑、工作方法**。
> 它是 19 个 lease（A01-A04 / B01-B05 / C01-C08 / D01-D03）的总入口。
> 详尽编排见 `PLAN-webui-v2-refactor.DRAFT.md`，本章程为治理层与工程层的接缝。

---

## 1. 背景

### 1.1 现状（v1.0.0 / v1.0.1）

mcode-webui 是 **mcode agent runtime 的浏览器前端**：

- **形态**：Node.js 22.19+ HTTP + SSE 服务器 + 静态 SPA，**零 npm 依赖**
- **能力**：聊天流、工具执行、plan mode、ask-user、permission、workspace 切换、文件附件、配额、token auth（v1.0.1）
- **范围**：单一插件仓库，宿主在 `MiniMax-Code-Plugins/plugins/Wzdhehe/mcode-webui/`
- **状态**：v1.0.1 已修复 token auth 默认开 + 持久化 + 广播 + acknowledged 状态机，但**剩余 11 条工业级缺陷**（见 ANTI-PATTERNS-FIX-PLAN §反向清单）

### 1.2 演化动机（v1.0.0 → v2.0.0）

v1.x 在"功能完整 + token auth 安全基线"上站稳，但存在以下系统性缺陷：

| 维度 | v1.x 现状 | v2.0.0 目标 |
|---|---|---|
| 可验证性 | 无 append-only 事件流，无 hash chain | NDJSON 事件流 + SHA-256 hash chain（判据 1） |
| 可观察性 | 错误混 chat 流，无独立 anomaly 通道 | 独立 alerts 通道 + bell icon + 持久化（判据 2） |
| 可治理性 | LLM 可直接调危险端点（DELETE sessions 等） | per-request authorize() helper + UI 确认（判据 4） |
| 可重现性 | 无 SBOM，无 CVE，无 lockfile | SBOM 生成 + CVE 跟踪 + npm audit CI（判据 5） |
| 可发现性 | capabilities 无 description，文档对齐靠手工 | plugin.json description + CI 校验脚本（判据 7） |
| 数学化 | 决策无数学依据，子系统划分凭直觉 | 每个子系统挂 sih-math 定理（判据 8） |
| 单源真源 | plugin.json / README / SKILL 三处独立手维护 | CI 校验三件套一致（判据 9） |

> 简言之：v1.x 是「能用」+「默认安全」，v2.0.0 要做「工业可治理」+「架构可证伪」。

---

## 2. 目标：9 条工业级判据

v2.0.0 的 9 条工业级判据（与 `PLAN-webui-v2-refactor.DRAFT.md` §1 对齐）：

| # | 判据 | 一句话 | 主要承载 | 次要承载 |
|---|---|---|---|---|
| 1 | 可验证性 | 事件流可哈希链校验 | B01 | D01 / D02 |
| 2 | 可观察性 | 独立 anomaly 通道 + bell icon | B02 | D01 |
| 3 | 可移植性 | 零 npm 依赖 + Node 22.19+ | 全程约束 | C02（CI 矩阵） |
| 4 | 可治理性 | LLM 不能直接改东西 | B03 | D01 |
| 5 | 可重现性 | lockfile + SBOM + CVE | C02 | — |
| 6 | 可测试性 | CI 矩阵 + 覆盖率 ≥ 80% | C02 | D01 / D02 / D03 |
| 7 | 可发现性 | capabilities 元数据完整 | B05 | A01（借鉴元数据 schema） |
| 8 | 数学化架构 | 每条决策挂数学定理 | A02 | 全程约束 |
| 9 | 单源真源 | 三件套对齐（plugin.json / README / SKILL） | B05 | — |

每条判据在 §6「工业化基线」有详细承载关系。

---

## 3. 范畴与非目标

### 3.1 范畴（IN SCOPE）

**重构对象**：

- 仓库：`/Users/moc/workspaces/MiniMax-Code-Plugins/plugins/Wzdhehe/mcode-webui/`
- 保留仓库身份（**不切独立仓**，形态决策见 §4）
- v1.0.1 的 token auth / settings 路径 / 状态机**保持不破坏**（向后兼容）

**新增子系统**：

- `server/lib/events.js` — append-only NDJSON 事件流（B01）
- `server/lib/alerts.js` + `server/routes/alerts.js` — 独立 anomaly 通道（B02）
- `server/lib/authorize.js` — per-request authorize() helper（B03）
- `server/lib/interaction/` 拆分（commands / permission-presets / tool-ask-user / user-questions）（B04）
- `server/lib/feedback/` 拆分（command-feedback / message-feedback）（B04）

**新增文档**：

- `docs/PROJECT-CHARTER-webui-v2.md`（本文件 / A04）
- `docs/BORROW-harness-v2-2026-09-20.md`（A01）
- `docs/MATH-skeleton-webui-v2-2026-09-20.md`（A02）
- `docs/ANTI-PATTERNS-FIX-PLAN.md`（A03）
- `docs/VERIFICATION-REPORT.md`（D03）

**外围补强**：

- db.js path resolver bug 修复（C01）
- CI 矩阵 + SBOM + CVE（C02）
- 限流 + HTTPS 反代文档（C03）
- 聊天列表虚拟化 + SSE 批处理（C04）
- 跨 workspace 会话搜索（C05）
- 导出 Markdown / JSON（C06）
- 耗尽预测（C07）
- token onboarding 模态化（C08）

### 3.2 非目标（OUT OF SCOPE）

**明确不做**：

- ❌ 改动 `MiniMax Code CLI` 主仓代码（不在本 fork）
- ❌ 读取 `/Users/moc/Harnessies/` 内 DSH 源码（待用户授权；仅借鉴已公开的 `docs/BORROW-dsh-deepseek-harness-2026-08-28.md` 抽象层）
- ❌ 提交 PR 到上游 `MiniMax-AI/MiniMax-Code-Plugins`（待 Wzdhehe 接手）
- ❌ 改动 `MiniMax Code CLI / Desktop` 端代码
- ❌ 改动 `MCP server / mavis runtime`（不在本 fork）
- ❌ 任何 npm 依赖引入（判据 3 零 npm 依赖硬约束）
- ❌ 任何 v1.0.1 API 破坏性变更
- ❌ 任何写本计划文档 / 其他 lease 文件的越界动作

---

## 4. 形态：保留 plugin 形态，不切独立仓

**决策**：**保留 plugin 形态**（不切独立仓）。

**理由**：

1. mcode-webui 本质是 `mcode` runtime 的**前端 / 浏览器壳**，与 runtime 通过 `mcode acp` / `mcode exec` SSE/stdio 协议通信
2. 切独立仓会让 plugin loader 找不到入口，破坏 1.0 部署
3. Agent Plugins 1.0 规范明确要求 `plugin.json` + `SKILL.md` 形态
4. 现有用户安装路径（mavis / MiniMax Code plugin loader）不需变化

**形态契约**：

- 仓库路径不变：`plugins/Wzdhehe/mcode-webui/`
- 顶层 10 件文件结构保留（`plugin.json` / `SKILL.md` / `LICENSE` / `README.md` / `references/SECURITY-NOTES.md` / `docs/` / `server/` / `public/` / `test/` / `package.json`）
- `server.js` 入口不变
- `plugin.json` 元数据扩展（capability 加 description）但 schema 不变
- 子系统拆分走 `server/lib/` 子目录（interaction/feedback），不切仓

---

## 5. 借鉴源

v2.0.0 设计借鉴三类来源：

### 5.1 DSH（BORROW-dsh）

**源**：`docs/BORROW-dsh-deepseek-harness-2026-08-28.md`（已存在）

**借鉴条目**（按 `BORROW-dsh` §X）：

- BORROW-dsh 1（SessionEvent 日志）→ 落地 B01 events 模块
- BORROW-dsh 2（per-request 授权）→ 落地 B03 authorize 模块
- BORROW-dsh 3（subsystem split 5+2 包）→ 落地 B04 interaction/feedback 拆分
- BORROW-dsh 4（事件流 hash chain）→ 落地 B01 hash chain
- BORROW-dsh 5（anomaly 通道）→ 落地 B02 alerts 模块

### 5.2 Harness v2（BORROW-harness-v2）

**源**：`docs/BORROW-harness-v2-2026-09-20.md`（由 Lease A01 产出）

**作用域**：通用 agent harness 架构模式（不绑定具体实现）

**预期 5+ 条目**（每条四字段：对照来源 / 落地建议 / 工作量 / ROI 排序）：

- 借鉴 A：……（具体内容待 A01 close 后回填）
- 借鉴 B：……
- 借鉴 C：……
- ……

> 章程此处不引用 A01 具体条目（A01 与 A04 并行，A04 close 时 A01 可能尚未交付）。
> 详细借鉴映射在 A01 close 后由主会话复核时回填到本章程 §5.2。

### 5.3 sih-math（MATH-skeleton）

**源**：`docs/MATH-skeleton-webui-v2-2026-09-20.md`（由 Lease A02 产出）

**承接关系**（5 子仓）：

| 子仓 | 落地子系统 | 概念 ID（待 A02 close 确认） |
|---|---|---|
| calculus（114） | state-bus / SSE 频率控制（C04） | CAL-XXX |
| order（19+3=22） | 事件流单调 seq（B01） | ORD-XXX |
| probability（15+6=21） | hash chain 不可篡改证明（B01） | PROB-XXX |
| topology（8） | subsystem 模块边界（B04） | TOP-XXX |
| algebra（5） | 协议 schema 对位（B05） | ALG-XXX |

> 章程此处只列承接面，具体概念 ID 在 A02 close 后回填。

---

## 6. 工业化基线（9 判据承载关系）

> 本节与 `sih-engine/doc/governance/BASELINE-v1.md` 工程基线对齐。
> SiHankor 5 条工程基线 + 5 条工程禁条款是 v2.0.0 治理层的硬约束。

| # | 判据 | 承载章节 | 关键文件 | 验收动作 |
|---|---|---|---|---|
| 1 | 可验证性 | §7 milestone B01 | `server/lib/events.js` | `cat ~/.mcode-webui/events.ndjson \| jq`；改第二行 hash → verify-hash 报警 |
| 2 | 可观察性 | §7 milestone B02 | `server/lib/alerts.js` + `server/routes/alerts.js` | 触发 mcode 子进程 crash → bell 响 + events.ndjson `kind:"subprocess.exit"` |
| 3 | 可移植性 | §3 范畴 / §7 全程约束 | `package.json`（无 deps） | `node -e "require('./package.json').dependencies"` → `undefined` |
| 4 | 可治理性 | §7 milestone B03 | `server/lib/authorize.js` | DELETE sessions 触发 UI 确认；不点 = 不删 + `kind:"auth.declined"` |
| 5 | 可重现性 | §7 milestone C02 | `.github/workflows/ci.yml` + `scripts/gen-sbom.mjs` | `npm audit` 0 漏洞（或全部 ignore）+ `sbom.json` 存在 |
| 6 | 可测试性 | §7 milestone C02 + D 系列 | `test/` 目录 | `npm test` 全绿；覆盖率 ≥ 80% |
| 7 | 可发现性 | §7 milestone B05 | `plugin.json` + `scripts/check-docs-alignment.mjs` | 每个 capability 有 description；`npm run check` 通过 |
| 8 | 数学化架构 | §7 milestone A02 + 全程约束 | `docs/MATH-skeleton-webui-v2-2026-09-20.md` | 每个子系统引用 ≥ 1 条数学概念 ID |
| 9 | 单源真源 | §7 milestone B05 | `plugin.json` ↔ `README.md` ↔ `SKILL.md` | `scripts/check-docs-alignment.mjs` 退出码 0 |

**对齐 SiHankor 5 工程基线**：

1. **可验证性**（基线 1）→ 判据 1
2. **可观察性**（基线 2）→ 判据 2
3. **可移植性**（基线 3）→ 判据 3
4. **可治理性**（基线 4）→ 判据 4
5. **决策 = 治理对象**（基线 5）→ lease close 进 audit chain

**避开 5 工程禁条款**：

- 禁 1：禁止绕过事件流直接写状态 → B01 强制所有写点经 events.js
- 禁 2：禁止 LLM 直接调危险端点 → B03 authorize 强制 UI 确认
- 禁 3：禁止事件流无 hash chain → B01 SHA-256 强制链
- 禁 4：禁止 npm 依赖引入 → C02 CI 校验 `dependencies` 字段为空
- 禁 5：禁止 SDDG 两道门绕过 → C02 / D03 强制两道门

---

## 7. 里程碑：批次 A → B → C → D

> 19 个 lease 分布在 4 个批次，每个 milestone 含具体 lease 号 + 交付物 + 验收动作。

### 7.1 批次 A：文档（4 个 lease，可立即并行）

| Lease | 范畴 | 交付物 | 验收动作 | 判据 |
|---|---|---|---|---|
| A01 | 借鉴 Anthropic/OpenAI/通用 harness 模式 | `docs/BORROW-harness-v2-2026-09-20.md` | `head -50` 见 TL;DR；5+ 条目四字段齐全 | 7 |
| A02 | sih-math 5 子仓作代码骨架 | `docs/MATH-skeleton-webui-v2-2026-09-20.md` | 6+ 子系统；每个挂 1-3 条数学定理；概念 ID 可 grep | 8 |
| A03 | 11 条反面模式 + 修复路径 | `docs/ANTI-PATTERNS-FIX-PLAN.md` | 每条 grep 验证当前代码；修复路径引具体 lease | 全判据 |
| A04 | **本项目章程** | `docs/PROJECT-CHARTER-webui-v2.md` | TOML round-trip parse；5+ 章节；范畴/非目标显式 | 治理层 |

### 7.2 批次 B：核心代码（5 个 lease，依赖批次 A 设计依据）

| Lease | 范畴 | 交付物 | 父依赖 | 判据 |
|---|---|---|---|---|
| B01 | append-only NDJSON 事件流 + 哈希链 | `server/lib/events.js` + 5 写点 patch + `test/lib-events.test.js` | A02 | 1 |
| B02 | 独立 anomaly 通道 + bell icon | `server/lib/alerts.js` + `server/routes/alerts.js` + 前端 + test | B01 | 2 |
| B03 | per-request authorize() helper | `server/lib/authorize.js` + 4-5 wrap site + test | B01 | 4 |
| B04 | interaction/feedback 子系统拆分 | 6 个新文件 + 删 slash.js 304 行 + test | A01 | 7 |
| B05 | plugin.json 元数据 + 三件套对齐 + CI 校验 | `plugin.json` + `README.md` + `CONTRIBUTING.md` + `scripts/check-docs-alignment.mjs` | 无 | 7 + 9 |

### 7.3 批次 C：外围补强（8 个 lease，依赖批次 B）

| Lease | 范畴 | 交付物 | 父依赖 | 判据 |
|---|---|---|---|---|
| C01 | db.js path resolver 修 | `server/lib/db.js` + test | 无（独立 bug） | 6 |
| C02 | CI 矩阵 + SBOM + CVE | `.github/workflows/ci.yml` + `scripts/gen-sbom.mjs` + `.cve-ignore.json` | B05 | 5 + 6 |
| C03 | 限流 + HTTPS 反代文档 | `server/lib/rate-limit.js` + `docs/HTTPS-REVERSE-PROXY.md` | 无 | 4 |
| C04 | 聊天列表虚拟化 + SSE 批处理 | `public/app/main.js` + `server/lib/state-bus.js` + test | B02 | 6 |
| C05 | 跨 workspace 会话搜索 | `server/routes/sessions.js` patch + public/app + test | 无 | 7 |
| C06 | 导出 Markdown / JSON | `server/routes/export.js` + public/app + test | 无 | 7 |
| C07 | 耗尽预测 | `server/lib/quota-forecast.js` + UI + test | 无 | 7 |
| C08 | token onboarding 模态化 | `server.js` + `server/lib/auth.js` + public/app + test | B05 | 4 |

### 7.4 批次 D：测试集（3 个 lease，依赖批次 B+C）

| Lease | 范畴 | 交付物 | 父依赖 | 判据 |
|---|---|---|---|---|
| D01 | 单元测试集 | 5 个新增 test 文件（B01-B05 各一） | B01-B05 | 6 |
| D02 | 集成测试 + 跨传输矩阵 | `test/integration/` + `test/matrix/transports.test.js` | B01-B05 + C01 | 6 |
| D03 | 综合 verifier 报告 | `docs/VERIFICATION-REPORT.md` | D01 + D02 | 全部 |

### 7.5 依赖图

```
批次 A:  A01 A02 A03 A04  (4 个并行)
         ↓ ↓ ↓ ↓
批次 B:  B01 B02 B03 B04 B05  (B01 启 B02/B03; B04/A01 启; B05 独立)
         ↓ ↓ ↓ ↓ ↓
批次 C:  C01 C02 C03 C04 C05 C06 C07 C08
         ↓ ↓ ↓ ↓ ↓
批次 D:  D01 D02 D03
```

---

## 8. 工作方法：司衡租约模式

每个 lease 走四阶段：

```
open（主会话拉 worker）
   ↓
commit（worker 交付，含证据：grep / 测试 / 行数）
   ↓
reconcile（主会话亲自复核：读全文 / 跑 grep / 跑 npm test）
   ↓
close（过 SDDG 两道门：架构基线对齐 + 治理契约）
   ↓
next batch 启动
```

### 8.1 甲表形契约（每个 lease 必有）

- **概念锚**：lease 范畴 + 边界（§7 每个 milestone 第一行）
- **派生申报**：输入 / 输出 / 验收判据（§7 每个 milestone「验收动作」列）
- **机械对表**：退出码（0/1/2）/ 文件范围 / 父依赖（§7 每个 milestone「父依赖」列）

### 8.2 worker 报告契约

每个 worker 写 `TASKS/<LEASES>-TASK.DRAFT.md`，含：

- 做了什么（路径 + 行数）
- grep / 测试验证输出
- 9 条判据覆盖情况
- 退出码
- 遗留问题与 blockers

### 8.3 主会话复核协议

主会话**不信 worker 自报**，必跑：

1. 读 worker `TASK-XXX.DRAFT.md` 全文
2. 跑 `grep` / `npm test` / 文件存在性检查
3. 跟 §7 milestone 的验收对比
4. 关键 lease（B01 / B02 / B03 / C01 / D01）跑 verifier 子代理独立复核

### 8.4 SDDG 两道门（每个 lease close）

- **第一道**：架构基线对齐（SiHankor 5 工程基线 + 5 禁条款）
- **第二道**：治理契约（事件流写入 / 决策落 audit chain）

`close_gate_since = 2026-09-12`（DEC-024，GATE_SINCE 不溯往）。

### 8.5 退出码语义

| 退出码 | 含义 | 后续动作 |
|---|---|---|
| 0 | 完成 + 验收通过 | close → 下一批 |
| 1 | 范畴不足 / 内容不符 / 引用错误 | worker 报问题；主会话裁定修复 or halt |
| 2 | 工具异常 / 外部 blocker | 工具层先处置，再回归工作流 |

---

## 9. 反向清单

> 反向清单对应 Lease A03 输出（`docs/ANTI-PATTERNS-FIX-PLAN.md`）。
> A04 与 A03 并行执行，A04 close 时 A03 可能尚未交付。
> 本节提供**初步反向清单（基于主会话已知讨论 + PLAN §5 散落描述）**，详细修复路径待 A03 close 后回填或由对应 B/C lease 落地。

### 9.1 初步 11 条反面模式（基于已知讨论）

| # | 反面模式 | 当前代码位（待 A03 验证） | 影响 | 修复 lease |
|---|---|---|---|---|
| 1 | token stdout 泄漏（启动时 ASCII box 打印 token） | `server.js`（v1.0.1 14 行） | 安全：token 进入日志/滚动缓冲区 | C08 |
| 2 | settings 全覆盖（`currentToken` 反复暴露） | `server/lib/settings.js`（v1.0.1 acknowledged 状态机部分缓解） | 安全：stale client 仍能 scrape | C08 |
| 3 | 错误混 chat 流（用户面 console.warn 替代 anomaly 通道） | `server/routes/chat.js:141` | 可观察性：错误被当成 agent 输出 | B02 |
| 4 | 无 append-only 事件流 | 全局 | 可验证性：状态变更无审计 trail | B01 |
| 5 | 无 hash chain | — | 可验证性：事件可被静默篡改 | B01 |
| 6 | 无独立 anomaly 通道 | — | 可观察性：crash/timeout 不可见 | B02 |
| 7 | per-request 授权缺失（LLM 可直接 DELETE sessions） | `server/routes/sessions.js` / `server/routes/settings.js` | 可治理性：危险操作零门槛 | B03 |
| 8 | slash.js 单体 304 行（interaction/feedback 耦合） | `server/lib/slash.js` | 可维护性：子系统边界模糊 | B04 |
| 9 | db.js path resolver bug（5 个测试 fail） | `server/lib/db.js` | 可测试性：干净 checkout 跑不通 | C01 |
| 10 | SSE 无频率控制（state-bus 60Hz 风暴） | `server/lib/state-bus.js` | 可移植性：10k 消息卡顿 | C04 |
| 11 | 无 CI 矩阵 / SBOM / CVE | `.github/workflows/` | 可重现性：跨平台行为分裂 | C02 |

### 9.2 反向清单的治理位

- **A03**：详细化每条（当前代码位 grep 验证 + 影响分类 + 修复路径）
- **B/C lease**：落地修复（按 §7 表中「修复 lease」列）
- **D03**：综合 verifier 报告里 P0 修复状态总览

> 章程不重复 A03 详细化工作；本节只承载「反向清单存在 + 11 条初步框架 + 修复 lease 路由」三层信息。

---

## 10. 风险与回滚

### 10.1 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| A01 / A02 / A03 任意一个失败 | 批次 B 部分 lease 无法启动 | 批次内 lease 独立 commit；失败的进 PARK，不阻塞其他 lease |
| B01 失败（事件流是引擎底层） | 整批 halt | 关键 lease 失败 → 整批 halt 等待人工裁 |
| B02 / B03 失败（可观察性 / 可治理性） | 整批 halt | 同上 |
| C01 失败（db resolver bug） | 5 个测试 fail | 可独立修复，不阻塞核心 |
| C08 失败（token 模态化） | v1.0.1 token 安全受质疑 | 关键 lease，需人工裁 |
| npm 依赖意外引入（违反判据 3） | C02 CI 校验应报警 | C02 强制 `dependencies` 字段为空 |
| v1.0.1 API 破坏 | 用户现有部署挂 | 全程 backward_compatible 约束 + B05 三件套 CI 校验 |

### 10.2 回滚策略

- 每个 lease 独立 commit（**不批量 squash**）
- 批次内 lease 失败不阻塞其他 lease；失败的进 PARK
- 回滚：每个 lease 的 commit 可独立 `git revert <commit>`
- 关键 lease（B01-B03 / C08）失败 → 整批 halt，等待人工裁

### 10.3 状态跟踪

主会话侧维护 `STATE-webui-v2-refactor.md`（待写）：

| Lease | worker task_id | 状态 | verifier task_id | close 时间 | 备注 |
|---|---|---|---|---|---|

---

## 附录 A：本章程与 SiHankor 工程基线的对位

| SiHankor 基线 / 禁条款 | 在本章程承载位 |
|---|---|
| 工程基线 1（可验证性） | §6 判据 1 |
| 工程基线 2（可观察性） | §6 判据 2 |
| 工程基线 3（可移植性） | §6 判据 3 |
| 工程基线 4（可治理性） | §6 判据 4 |
| 工程基线 5（决策 = 治理对象） | §8.4 lease close 进 audit chain |
| 工程禁 1（绕事件流直接写状态） | §6 判据 1 + B01 强制 |
| 工程禁 2（LLM 直接调危险端点） | §6 判据 4 + B03 强制 |
| 工程禁 3（事件流无 hash chain） | §6 判据 1 + B01 SHA-256 |
| 工程禁 4（npm 依赖引入） | §3 范畴 + C02 CI 校验 |
| 工程禁 5（SDDG 两道门绕过） | §8.4 + C02 / D03 强制 |

---

## 附录 B：本章程变更日志

- 2026-09-20：v1 草案（Lease A04 首次产出，与 A01/A02/A03 并行；§5.2/§5.3 借鉴源与数学骨架待 A01/A02 close 后回填；§9 反向清单初步 11 条，待 A03 详细化后回填）

---

**章程状态**：DRAFT（待主会话 reconcile + verifier 复核 → DONE）
**对应编排计划**：`PLAN-webui-v2-refactor.DRAFT.md` §5 Lease A04
**下一动作**：主会话亲自读全文 + 跑 TOML round-trip parse + 跑 `head -50` / `wc -l` / `grep "^## "`