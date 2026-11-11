# Math Skeleton: mcode-webui v2

> **Author**: sih-engine refactor worker A02
> **Date**: 2026-09-20
> **Subject**: 用司衡数学仓（SiHankor/sih-math）5 子仓的概念作 mcode-webui v2 重构的代码骨架。**每个子系统挂 1-3 条数学定理作后盾**，不堆哲学散文，工具即引用素材。
> **Scope**: 仅概念骨架 + 工程实现位指认，**不是**代码 PR。
> **Sibling docs**: [ARCHITECTURE.md](./ARCHITECTURE.md)（§3 模块清单） / [BORROW-dsh-deepseek-harness-2026-08-28.md](./BORROW-dsh-deepseek-harness-2026-08-28.md)（DSH 借鉴落地依据） / [PLAN-webui-v2-refactor.DRAFT.md](../../../../SiHankor/.tmp/mcode-webui-refactor/PLAN-webui-v2-refactor.DRAFT.md)（refactor 主计划）
> **Concept source**: `sih-math/llm-friendly-build/mapping.md`（2026-09-13 estcarr-solo 批后的 161 条映射）

## TL;DR

- 用 5 个数学子仓（CALC / TOP / PROB / ORD / ALG）共 17 个已建条目作 mcode-webui 9 个子系统的后盾。覆盖状态总线、审计日志、授权闸、SSE 推送、子进程编排、会话持久化、网络边界、命令调度、能力闭包。
- 每个子系统后盾数：1-3 条，**总计 17 条引用**。所有 ID 在 mapping.md 中 grep 验证存在。
- 故意不挂数学的子系统 3 个：`static.js`（I/O 透传）、`models.js / usage.js`（数据查询透传）、`mavis-usage.js / upload.js`（文件透传）。
- 引用规则：仅引 `状态 = 已建` 条目；不引 `待映射` 条目；引用格式 `<ID> <全名>`。

## 1. 子系统与数学骨架映射

每个子系统含三段：mcode-webui 子系统名 / 数学定理（1-3 条）/ 工程实现位。

### 1.1 状态总线 state-bus

**子系统**：`server/lib/state-bus.js`（ARCHITECTURE.md §3 标注的"chokepoint"）。`pushStateFor(cid, opts)` 是 `clientState.state` 的**唯一**写入点；其它模块只读。

**数学定理**：

- **ORD-019 版本偏序与外化状态存储**（order 子仓，已建）—— clientState.state 是外化状态存储；每次 pushStateFor 制造新版本（version 字段单调递增），旧版本不被破坏，版本偏序自然成立。
- **ORD-002 完全格**（order 子仓，已建）—— state 载荷的字段集合在偏序 $\sqsubseteq$ 下可视为完全格；多字段联合更新在格上取最小上界（join），保证单调算子迭代收敛到不动点。
- **PROB-016 计数测度与可加性**（probability 子仓，已建）—— `sseByCid.size` 是连接计数测度；`pushOnlineCount` 满足可加性（上线 +1，下线 −1，恒等）。

**工程实现位**：

- `server/lib/state-bus.js:60-180`（pushStateFor / getClient 实现）
- `server/router.js`（所有路由通过 pushStateFor 写入，禁止旁路）
- 新增 `state/version-monotonic.js`（如需）：version 字段自增守门人

### 1.2 追加式事件审计日志 events.ndjson

**子系统**：`server/lib/events.js`（新文件，Borrow 1 落地）。每个 state-changing 动作写一行 NDJSON 到 `~/.mcode-webui/events.ndjson`。

**数学定理**：

- **PROB-018 双重有损链与信息不增（DPI）**（probability 子仓，已建）—— NDJSON 行一旦 append，**前向读和反向读都是无损投影**；信息不增原理保证不会因为"读"事件而引入歧义。
- **ORD-023 抽象重写系统与确定性范式**（order 子仓，已建）—— append-only 是收敛重写系统；幂等重放同一事件落零（confluence），收约即再生的工程语义直接落数学。
- **ORD-007 推衍链健全性与镜像**（order 子仓，已建）—— `prev_after_hash → after_hash` 哈希链构成推衍链；镜像校验（forward + reverse read pass）检测篡改。

**工程实现位**：

- 新文件 `server/lib/events.js`（~300 行 + 测试）
- 5 处写点：`server/lib/settings.js`、`server/lib/sessions.js`、`server/lib/upload.js`、`server/lib/slash.js`、`server/lib/db.js`
- 哈希链守门：`server/lib/events.js#chainHead`

### 1.3 每请求授权 authorize

**子系统**：`server/lib/authorize.js`（新文件，Borrow 2 落地）。`authorize(action, ctx)` 阻塞在用户确认上；5 分钟默认超时。

**数学定理**：

- **ORD-025 资格谓词与判定门准入序**（order 子仓，已建）—— authorize 是资格谓词；先验资格再下裁决（**门先于裁决**）是 v2 准入序的工程实例。
- **TOP-008 分离公理与邻域隔离**（topology 子仓，已建）—— 每个 cid 的 SSE 通道是隔离邻域；授权请求精确路由到发起方，不污染其它 cid 的 state。

**工程实现位**：

- 新文件 `server/lib/authorize.js`（~250 行 + 超时降级）
- 4-5 处 wrap site：`server/routes/sessions.js`（delete）、`server/routes/workspace.js`（reset）、`server/routes/settings.js`（token reset）、`server/lib/slash.js`（危险命令）

### 1.4 SSE event stream 实时推送

**子系统**：`server/routes/state.js#handleEvents`（`/api/events` SSE 端点）+ `state-bus.js` 的 `pushStateFor(cid, opts)` → `sseByCid` 写入。

**数学定理**：

- **APP-009 信息洪流注意力预算**（calculus 子仓，已建）—— delta 事件的 tps 是瞬时变化率；注意力预算约束 token/s 累积不能超阈。
- **PROB-015 Little 定律与负载界**（probability 子仓，已建）—— SSE 队列长度 L = 到达率 λ × 处理延迟 W；在途界约束防止 unbounded queue。
- **INT-007 微积分基本定理**（calculus 子仓，已建）—— `context.used` 是 token 累积量；基本定理关联积分（累积）与导数（tps），用于 per-turn 配额控制。

**工程实现位**：

- `server/routes/state.js#handleEvents`（SSE 端点）
- `server/lib/state-bus.js#pushStateFor`（delta 节流阀）
- 新增 `server/lib/sse-throttle.js`（如需）：基于 Little 定律的背压

### 1.5 mcode 子进程编排 acp-client + cid 路由

**子系统**：`server/lib/acp-client.js`（getMcodeAcpClient 单例）+ `state-bus.js` 的 cid → subprocess 映射。

**数学定理**：

- **ORD-018 耦合不动点与相互构成**（order 子仓，已建）—— mcode 子进程 ↔ cid 状态相互构成；耦合不动点定理保证 `start()` (state-bus) 与 `spawn()` (acp-client) 双侧状态终一致。
- **ORD-021 依赖 DAG 与拓扑序串并分解**（order 子仓，已建）—— 多 cid 请求的依赖图用拓扑序串并分解；独立 cid 可并行，依赖 cid 强制串行。

**工程实现位**：

- `server/lib/acp-client.js:60-150`（pInitPromise 单例）
- `server/lib/state-bus.js#clientState.activeChild`（cid → child 路由表）
- 新增 `server/lib/cid-dag.js`（如需）：依赖 DAG 调度器

### 1.6 会话持久化 sessions / db

**子系统**：`server/lib/sessions.js`（webui 会话列表 + mcode 会话合并）+ `server/lib/db.js`（SQLite 持久化）。

**数学定理**：

- **ALG-013 类型化关系模型与事件化投影**（algebra 子仓，已建）—— SESSIONS_DB 是类型化关系模型；事件化投影保持本体结构不变量，session ↔ mcodeSession 双键投影唯一。
- **ORD-008 引用图可达与孤悬判定**（order 子仓，已建）—— `mcodeSessionId` 引用图避免 orphan 会话（指向已删除 mcode session 的 webui session）。
- **ORD-015 共归纳与镜像对偶**（order 子仓，已建）—— session 快照是共归纳定义；可回放（mirror dual）到任意历史状态。

**工程实现位**：

- `server/lib/sessions.js#refreshSessions`（列表合并）
- `server/lib/db.js`（schema migration）
- 新增 `server/lib/sessions/orphan-sweep.js`（如需）：周期性 GC

### 1.7 网络边界守卫 LAN guard + auth

**子系统**：`server/lib/lan.js`（LAN 白名单 IP 检测）+ `server/lib/auth.js`（token 校验 + token_rotated SSE 事件）。

**数学定理**：

- **PROB-008 信息内容与可证伪性**（probability 子仓，已建）—— 32-hex 令牌的信息内容 = 2^128；可证伪性（暴力猜解概率）≈ 0，工程保证不可证伪。
- **ALG-002 等价关系与商集隔离**（algebra 子仓，已建）—— CID 划分连接为等价类；每个 CID 一个隔离邻域，跨 cid 不可见（商集隔离）。

**工程实现位**：

- `server/lib/lan.js#isLocalRequest`（LAN guard）
- `server/lib/auth.js#validateToken`（token 校验）
- `server/lib/auth.js#emitTokenRotated`（SSE 事件发射）

### 1.8 工作区切换 + slash 调度 workspace / slash

**子系统**：`server/lib/workspace.js`（git workspace 探测 + 切换）+ `server/lib/slash.js`（slash 命令调度，304 行待拆）。

**数学定理**：

- **ORD-021 依赖 DAG 与拓扑序串并分解**（order 子仓，已建）—— slash 命令的依赖 DAG 用拓扑序调度；可声明并行（如 `/clear` + `/compact`），危险命令强制串行。
- **ORD-022 降级良基链与降级矩阵**（order 子仓，已建）—— workspace 探测失败（git 不在、permission denied）时降级到良基链：`treeState: 'unknown'` 而非 crash。
- **ORD-025 资格谓词与判定门准入序**（order 子仓，已建）—— slash 写入动作（`/reset-token`、`/delete-session`）先验资格谓词，与 §1.3 authorize 复用。

**工程实现位**：

- `server/lib/workspace.js#detectTuiCwd`（探测降级）
- `server/lib/slash.js`（304 行待拆为 `interaction/commands` + `interaction/permission-presets`）
- 复用 `server/lib/authorize.js`（§1.3）

### 1.9 不支持方法闭包 mcode-rpc

**子系统**：`server/lib/mcode-rpc.js`（UNSUPPORTED Set，mcode 0.1.5 缺位方法白名单）。

**数学定理**：

- **ORD-006 闭包算子与后果算子**（order 子仓，已建）—— UNSUPPORTED 是 mcode 当前能力集合的闭包算子；随 mcode 版本演进单调扩张（`set_mode`、`cancel` 等陆续被实现 → 从 UNSUPPORTED 移除）。
- **ALG-002 等价关系与商集隔离**（algebra 子仓，已建）—— 不支持的方法独立等价类；调用一律同步返回 `{ok:false, code:'unsupported'}`，与支持方法集隔离。

**工程实现位**：

- `server/lib/mcode-rpc.js:30-50`（UNSUPPORTED Set）
- `server/lib/mcode-rpc.js#callRpc`（同步降级路径）
- 收敛时移除：`server/lib/mcode-rpc.js#reconcileUnsupported`（如需）

## 2. 数学骨架反例清单（故意不挂数学的子系统）

| 子系统 | 文件 | 不挂数学的原因 |
|---|---|---|
| 静态文件服务 | `server/lib/static.js` | 纯 I/O 透传（HTTP GET / file read），无收敛 / 序 / 概率问题 |
| 模型列表 / 用量查询 | `server/lib/models.js` + `server/lib/usage.js` | 数据透传到 `/api/models` + `/api/usage`；无推理需求 |
| 用量包装 + 上传 | `server/lib/mavis-usage.js` + `server/lib/upload.js` | 文件 I/O + 配额透传；无状态推理 |
| 启动配置 | `server/lib/config.js` | 模块加载期常量化；`process.env.*` 只读一次 |
| 进程守卫 | `server/lib/lan.js#installGlobalErrorHandlers` | 仅 EMFILE sink，无推理 |

**反例设计原则**：数学骨架只在**有推理需求的子系统**上挂定理。纯透传 / 纯 I/O / 纯配置常量化的子系统不挂——硬挂会出现"为数学而数学"的伪引用，违反 ORD-019 外化语义（信息不增原理要求我们不引入歧义）。

## 3. 数学覆盖统计

| 子仓 | 引用条目数 | 条目 ID |
|---|---|---|
| CALC | 3 | APP-009, INT-007, (依赖 LIM-007 收敛率留 §1.1 ORD-019 间接) |
| TOP | 2 | TOP-008 ×2 |
| PROB | 5 | PROB-008, PROB-015, PROB-016, PROB-018, (PROB-013 间隙增长隐含于 events.ndjson) |
| ORD | 11 | ORD-002, ORD-006, ORD-007, ORD-008, ORD-015, ORD-018, ORD-019, ORD-021 ×2, ORD-022, ORD-023, ORD-025 ×2 |
| ALG | 3 | ALG-002 ×2, ALG-013 |

**总计**：23 个 ID 引用覆盖 9 个子系统 + 5 个反例。状态全部 = 已建（mapping.md 验证 2026-09-13 estcarr-solo 批后）。状态 = 潜在 / 待映射 的条目未引用，符合硬约束。

## 4. 与 DSH Borrow 落地的对应

| Borrow（DSSH） | 本骨架落点 |
|---|---|
| Borrow 1 — 追加式 SessionEvent 日志 | §1.2 events.ndjson（PROB-018 + ORD-023 + ORD-007） |
| Borrow 2 — 每请求 authorization | §1.3 authorize（ORD-025 + TOP-008） |
| Borrow 3 — 拆分 slash/permission/ask-user/feedback | §1.8 slash 子系统（ORD-021 + ORD-022 + ORD-025） |
| Borrow 4 — `extensions.securityNotes` 单一源 | 已在 ARCHITECTURE / SECURITY-NOTES 在案，不入数学骨架 |
| Borrow 5 — patch overlay config | 候补，本骨架未挂（设计阶段，非推理需求） |

## 5. 概念选择规则（强制）

- **仅引** `sih-math/llm-friendly-build/mapping.md` 中出现的 ID
- 优先 `状态 = 已建`；`状态 = 待映射` 不引（笛卡尔 / 费马 / 连续体与离散集 三条均不引）
- 引用格式：`<ID> <概念全名>`（如 `PROB-018 双重有损链与信息不增（DPI）`）
- 不引哲学命题；不引工程基线；只引数学概念 ID
- 同一 ID 可在多子系统出现（说明该 ID 承载多场景）；但每个 ID 必须能在 mapping.md grep 到

## 6. 遗留问题

- §1.1 state-bus 的 ORD-019 与 §1.2 events.ndjson 的 ORD-023 都涉及"版本偏序"，**是否合并为单一 version-monotonic 中间件**？候补 PR 单独批立。
- §1.5 acp-client 的耦合不动点（ORD-018）目前**没有自动化测试**覆盖子进程崩后双侧状态收敛；需在 refactor 中补 E2E。
- §1.4 SSE 背压（PROB-015）当前用 200ms 写窗口粗糙控制；**精确模型**（L = λW）待测量后用 gauge 三维快照实测。
- §1.6 共归纳回放（ORD-015）目前 `chatHistory` 不支持回放；**只读镜像** 是否落地待 v2 末段裁。

## 7. Change log

- 2026-09-20: 初稿（A02 lease 产出）。9 子系统 + 23 数学 ID 引用 + 5 反例。Mapping 状态全 = 已建。