# MCode Trajectory Studio — 设计文档

> 目标：把 dsh（DeepSeek Harness）Web 端 Trajectory 视图的能力，落到一个 MCode Agent Plugin 上，
> 用于查看 mcode 自身的会话轨迹（轮次 / 时长 / 调用入参 / 结果 / token / 压缩 / 子代理）。
>
> 状态：**已实现并通过验证**（2026-09-18）。设计决策见下文，实现落地情况见第 8 节。

---

## 0. 一句话结论

| 问题 | 结论 |
|---|---|
| 现有插件能用吗？ | **不能**。`hetaoBackend/minimax-code-trajectory` 读 `ledger.jsonl`，本机 487 个 session 里 **0 个**存在该文件，实测返回空列表。 |
| 读什么数据源？ | **SQLite**（`~/.minimax/v2/sqlite/runtime-state.sqlite`，只读），`messages.jsonl` 作 fallback。SQLite 覆盖面 480/482，字段量级碾压。 |
| 落成 MCP 还是 mini app？ | **MCP stdio server + 本地 HTTP Web UI**。规范明确「Apps or UI extensions」不是插件能力，但仓库内已有同作者的 `mcode-dynamic-workflows` 用「MCP + 本地 HTTP 面板」实现了 mini app 体验，且被仓库接受。 |
| 改他的版本还是另起炉灶？ | **另起炉灶**在 `plugins/weekbin/mcode-trajectory-studio/`，但借鉴其安全工程做法（拒绝 symlink、行大小上限、CSP）。 |

---

## 1. 前置门调研：现有插件已失效

### 1.1 事实

`plugins/hetaoBackend/minimax-code-trajectory/`（v0.2.0，MCP stdio，纯 Node 标准库）存在，名义上覆盖诉求。

但读它的源码：

```js
// lib/trajectory.mjs:167
const ledgerPath = path.join(sessionDir, 'ledger.jsonl');
// lib/trajectory.mjs:20
const available = discovery.sessions.filter((session) => session.ledgerState === 'file');
```

它**只**接受 `v2/sessions/YYYY/MM/DD/<session>/ledger.jsonl` 形态的会话。

### 1.2 实测

```bash
$ find ~/.minimax -name ledger.jsonl | wc -l
0
$ find ~/.dsh -name ledger.jsonl | wc -l
0
```

会话产物实际存在情况（`~/.minimax/v2/sessions`，共 487 个 session 目录）：

| 文件 | 存在数量 |
|---|---|
| `ledger.jsonl` | **0** |
| `display.jsonl` | 0 |
| `snapshot.json` | 0 |
| `messages.jsonl` | **487** |
| `history-catalog.json` | 445 |
| `user-message-locators.jsonl` | 445 |

直接跑它的 MCP server：

```json
// tools/call → list_minimax_sessions
{"sessions": [], "returned": 0, "discovered": 0, "unavailable": 482, "warnings": []}
```

**结论：该插件在本机完全不可用。** 它自述的 "Manifest-only sessions whose ledger has already been removed are counted as unavailable" 正是这个现象——`ledger.jsonl` 是它假设的旧形态，本机运行时不产出该文件。

这也印证了作者本人「做的不够好」的反馈，以及用户「读 sqlite 获取的信息更多一些」的判断。

---

## 2. dsh 轨迹能力基线（对标目标）

从本机安装的 dsh 包 README 提取的**能力契约**：

### 2.1 `@deepseek-ai/dsh-client-ui-trajectory`（UI 层）

- 按**轮次**组织的事件记录表，覆盖 user / assistant / tool / 嵌套子工具 / 压缩记录
- 轮次与步骤边界标示，带请求编号与累计用量
- **检查器**：点开单条记录 → token 用量、耗时、输入、输出、计时、图片、附件摘要
- **时间概览**：按真实开始时间 + 耗时投影；助手条区分 **TTFT** 与**解码时间**；悬停 500ms 显示精确时刻
- **交互**：拖选区间聚焦、滚轮缩放、右键清除/平移
- 流式跟随尾部；向上滚动暂停跟随
- 压缩请求单独落在 `Between turns` 区段
- 进行中记录**不虚构耗时**

### 2.2 `@deepseek-ai/dsh-session-stats`（统计层）

| 字段 | 含义 |
|---|---|
| `turns` | 含至少一个已关闭步的轮次 |
| `steps` | 已关闭的步（完成/失败/取消/max-tokens 全计） |
| `llmMs` | 模型墙钟时间之和 |
| `toolMs` | `tool/call` → `tool/result` 墙钟时间之和 |
| `ttftMs` / `ttftSteps` | 首 token 延迟之和及承载步数 |
| `decodeMs` / `decodeTokens` | 解码墙钟时间与提供方输出 token |

### 2.3 `@deepseek-ai/dsh-session-turn-outline`（导航层）

`turn` / `seq` / `prompt`（50 字符预览）/ `response`（120 字符预览）

---

## 3. 数据源对比（核心：接口差异）

### 3.1 三个候选

| 源 | 路径 | 覆盖 | 形态 |
|---|---|---|---|
| A `ledger.jsonl` | `v2/sessions/**/ledger.jsonl` | **0 / 487** | 线性事件流 |
| B `messages.jsonl` | `v2/sessions/**/messages.jsonl` | 487 / 487 | 线性消息流 |
| C **SQLite** | `v2/sqlite/runtime-state.sqlite` | **480 / 482 会话**，102 791 行 | 关系表 + JSON 列 + FTS5 |

### 3.2 字段对照

`R` = 直接可得，`D` = 可推导，`—` = 缺失

| dsh 能力 | A ledger | B messages.jsonl | **C SQLite** |
|---|---|---|---|
| turns / 轮次 | — | R | **R** `turn_id` / `turnId` |
| steps / 步 | — | R | **R** |
| llmMs 模型耗时 | — | — | **R** `usage.request_duration_ms` |
| toolMs 工具耗时 | — | — | **R** `background_tasks` `ended_at_ms - created_at_ms` |
| ttftMs 首 token | — | — | **—（运行时不落盘）** |
| decodeMs 解码时间 | — | — | **D** `request_duration_ms - thinking_duration_ms` |
| decodeTokens 输出 token | — | R `usage.output` | **R** `usage.output_tokens` |
| 输入（tool args） | — | R | **R** `tool_calls[].tool_call_args` |
| 结果（tool result） | — | R | **R** `tool_calls[].tool_call_result_data` |
| 调用状态 | — | — | **R** `tool_calls[].tool_call_status` |
| thinking + 思考耗时 | — | R（无耗时） | **R** `thinking_content` + `thinking_duration_ms` |
| 压缩记录 | — | — | **R** `kind=compaction` + `messagesBefore/After` + `tokensBefore/After` |
| 压缩失败 | — | — | **R** `kind=compaction_failed` |
| 子代理 / 嵌套任务 | — | — | **R** `parent_session_id` + `background_tasks` + `background_task_events` + `task_session_bindings` |
| 会话元数据 | manifest 极少 | manifest 极少 | **R** `agent_name` `title` `workspace_dir` `project_id` `session_kind` `status` `archived` `error_message` |
| 触发来源分类 | — | — | **R** `source`：`api` / `thread-goal` / `questionnaire` / `background-task` / `task` / `agent` / `greeting` |
| 上下文用量分解 | — | — | **R** `context_usage.components`：SYSTEM_PROMPT / MEMORY / TOOLS / SKILLS / MESSAGES |
| 遥测 | — | — | **R** `context_usage_telemetry`：model / localTokens / providerTokens / divergenceRate / toolCalibrationStatus |
| 全文搜索 | — | — | **R** `local_runtime_sessions_fts`（FTS5） |
| 附件 / 图片 | — | — | **R** `session_assets`（326 条，含 `asset_type` `path` `deliver-assets`/`media` tag） |
| 高精度行时间 | — | R | **R** `created_at_ms`（毫秒） |

### 3.3 关键证据摘录

SQLite 单行（`local_runtime_message_rows.data_json`）的真实字段普查（抽样 3000 行）：

```
TOP-LEVEL: msg_id, timestamp, turnId, source, msg_type, msg_content, role, turn_id,
           finish_reason, usage, context_usage, context_usage_telemetry, tool_calls,
           canonical_message_id, query_key, thinking_content, thinking_duration_ms,
           sourceContext, kind, metadata, operationId, committedRevision
usage.*:   total_tokens, context_window, input_tokens, output_tokens,
           request_duration_ms, cache_read
tool_calls[].*: tool_name, tool_call_id, tool_call_status, tool_call_args, tool_call_result_data
context_usage.*: contextWindowTokens, usedTokens, totalCountSource, components
```

压缩记录实例：

```json
{
  "kind": "compaction",
  "metadata": {
    "compactionId": "ctx_ea6d06bb-…", "strategyVersion": "local-pi-compaction-v1",
    "phase": "iteration", "messagesBefore": 356, "messagesAfter": 1,
    "tokensBefore": 353109, "tokensAfter": …
  }
}
```

耗时样例（本会话前几轮）：

```
turn_id              req_ms  think_ms  out_tok
turn_mu6wn97l_mf3vd6   4129      4369      904
turn_mu6wnx9w_ee64qg   2997      2632      531
turn_mu6wnx9w_ee64qg    900         —       38
turn_mu6wnx9w_ee64qg   2042       457       90
```

### 3.4 结论

**SQLite 完胜**，且是唯一能支撑 dsh 级功能的源。`messages.jsonl` 作为兜底（覆盖 SQLite 未收录的 2 个会话 + 字段缺失时回退）。

### 3.5 SQLite 的风险与缓解

| 风险 | 缓解 |
|---|---|
| 库 2.5 GB 且运行时正在写（WAL 17 MB） | 一律 `file:…?mode=ro` 只读打开，绝不写；不开 exclusive |
| 表名 `local_runtime_*`、列 `columnar_version` 属内部实现，可能变 | 用 `json_extract` 宽松读取 + 缺字段降级；不依赖固定列序；schema 探测失败即降级到 fallback |
| 大结果集 | 强制分页 + 行数上限；按 `session_id, id` 索引走 |
| 隐私（会话含敏感内容） | 本地 127.0.0.1 绑定 + Host/Origin 校验 + CSP + 每进程 capability token + 两层脱敏 + 无外网；不做任何上传 |
| 只读打开时运行时正在 checkpoint | `mode=ro` 下 SQLite 用 WAL 只读快照，安全 |

---

## 4. 形态决策：MCP 服务 vs Mini App

### 4.1 规范事实

`docs/plugin-compatibility.md:134-140`：

> The following are **not** currently public MCode Plugin capabilities in either runtime:
> … **Apps or UI extensions** …

即：**没有官方 mini app / UI 扩展通道**。用户「倾向 mini app」无法通过原生 UI 扩展实现。

### 4.2 但仓库内已有等价先例

同作者 `plugins/hetaoBackend/mcode-dynamic-workflows/`（v0.8.0）采用：

- `mcp.json` → MCP **stdio** server（`dist/main.mjs --stdio`），供 agent 调用
- `server/http.mjs` → 本地 `http.createServer`，服务 `web/index.html` + `web/js/*` + `style.css` + `/api/*`
- 工具 `workflow_dashboard` 「返回可收藏的本机可视化面板地址，无需 token」
- Skill 指导 agent 用宿主 `mcp_browser({action, input})` 打开该 URL
- 安全：`check(req.headers.host===new URL(origin).host)`、Origin 校验、自定义头防 CSRF、严格 CSP、`nosniff`、`no-store`

**这是仓库已接受的做法**，等价于「mini app 体验」。

### 4.3 决策

> **MCP stdio server（agent 侧）+ 本地 HTTP Web UI（人侧）**，共享同一数据层。

```
┌────────────────────────────┐
│  MCode (mcode 0.4.x)       │
│                            │
│  agent ──MCP stdio──┐      │
│                     ▼      │
│              trajectory-mcp│──┐
│  builtin Browser ◄──┐      │  │ 只读
│         ▲           │      │  ▼
│         │      HTTP 127.0.0.1:port
│         │           │      │  ~/.minimax/v2/sqlite/runtime-state.sqlite
│         └───────────┘      │  (fallback) v2/sessions/**/messages.jsonl
└────────────────────────────┘
```

- **MCP 侧**（给 agent）：`trajectory_list`、`trajectory_summary`、`trajectory_get`、`trajectory_search`、`trajectory_studio`
- **HTTP 侧**（给人）：交互式 Studio —— 时间概览、轮次表、检查器、筛选、搜索、压缩区段
- **打开方式**：`trajectory_studio` 返回 URL，Skill 用宿主 browser 工具打开（与先例一致）

---

## 5. 修改他的版本 vs 另起炉灶

### 决策：**另起炉灶**

| 维度 | 他的版本 | 我们需要 | 可复用性 |
|---|---|---|---|
| 数据源 | `ledger.jsonl`（不存在） | SQLite 只读 + JSONL 兜底 | 0% |
| 架构 | 一次性生成离线 HTML 文件 | 常驻 HTTP 服务 + 实时查询 | 低 |
| 交互 | 静态页面 | 可筛选/搜索/分页的活服务 | 低 |
| 隐私模型 | 默认不带任何文本 | 本地可视化需要内容（本机 127.0.0.1） | 不适用 |
| 安全检查 | symlink 拒绝、2 MiB 行上限、CSP | 同样需要 | **借鉴** |

理由：数据源与架构都不同，唯一值得复用是安全工程做法。同时他占用了 `minimax-code-trajectory` 这个名字，避免命名冲突与目录污染，另起炉灶更干净。

---

## 6. 插件设计

### 6.1 标识

| 项 | 值 |
|---|---|
| 目录 | `plugins/weekbin/mcode-trajectory-studio/` |
| `name` | `mcode-trajectory-studio` |
| 版本 | `0.1.0` |
| License | Apache-2.0（与仓库一致） |
| 目标运行时 | mcode 0.4.x（本机 0.4.12） |

### 6.2 目录结构（双布局，兼容 0.3.x 与 0.4.0+）

> 下面这份清单是**设计时的快照**（表内版本 `0.1.0` 即当时的值），保留是为了记录当初的双布局意图；
> 当前版本以 `plugin.json` 为准，实际的服务端模块见 `server/`：`config` · `json` · `sqlite` · `fsutil`
> · `redact` · `git` · `store` · `sessions` · `stats` · `tasks` · `events` · `search` · `jsonl` · `http`
> · `mcp` · `node-version` · `main`。

```
plugins/weekbin/mcode-trajectory-studio/
├── README.md
├── LICENSE                       # Apache-2.0
├── plugin.json                   # 便携 Agent Plugins 1.0（校验器 & 0.3.x）
├── mcp.json                      # 便携 MCP 声明
├── .claude-plugin/
│   └── plugin.json               # v0.4.0+ 首选清单（含 skills / mcpServers）
├── skills/
│   └── mcode-trajectory-studio/
│       └── SKILL.md              # 唯一的 Skill 声明
├── server/
│   ├── main.mjs                  # 入口：--stdio（默认） / --serve / --doctor / --help
│   ├── mcp.mjs                   # MCP JSON-RPC（stdio）
│   ├── store.mjs                 # 数据层：SQLite 只读 + JSONL fallback
│   ├── sqlite.mjs                # schema 探测 / 只读打开 / FTS5 探测
│   ├── http.mjs                  # 本地 HTTP + API + 静态资源
│   └── redact.mjs                # 脱敏 + 长度封顶
├── web/
│   ├── index.html
│   ├── app.js
│   └── style.css
└── test/
    └── store.test.mjs
```

### 6.3 MCP 工具

| 工具 | 作用 | 入参要点 |
|---|---|---|
| `trajectory_list` | 列出最近会话（元数据，无正文）；按快照游标翻页 | `limit`、`cursor`、`agent`、`kind`、`sinceMs`、`untilMs`、`includeArchived` |
| `trajectory_summary` | 单会话统计：turns / steps / llmMs / toolMs / decodeMs / tokens / 压缩数 / 工具调用数 | `sessionId` |
| `trajectory_turns` | 逐轮进展视图：每轮的记录数、LLM 耗时、输出 token | `sessionId`、`offset`、`limit` |
| `trajectory_assets` | 该会话交付/引用的文件清单（`trajectory_summary.assets` 的明细） | `sessionId`、`offset`、`limit` |
| `trajectory_agent` | 该会话派发时的 Agent 定义：模型、工具白/黑名单、MCP、Skill、系统提示词 | `sessionId` |
| `trajectory_find` | 在**单个**会话内按字面量检索记录（整机范围实测需数秒，故限定单会话） | `sessionId`、`query`、`offset`、`limit`、`detailLevel` |
| `trajectory_get` | 分页读取事件记录（轮次分组） | `sessionId`、`offset`、`limit`、`turnId`、`detailLevel` |
| `trajectory_search` | FTS5 全文检索；按快照游标翻页 | `query`、`limit`、`cursor` |
| `trajectory_tasks` | 列出该会话的后台任务与子 Agent 派发 | `sessionId`、`limit`、`offset`、`kind` |
| `trajectory_task_output` | 读取后台任务捕获输出的尾部 | `taskId`、`maxBytes` |
| `trajectory_studio` | 启动/复用本地 HTTP 面板，返回 URL | `sessionId?`、`port?`、`stop?` |

隐私默认：`detailLevel=summary` 不带正文；`full` 需显式请求，且结果经脱敏 + 长度封顶。

`turnId` 有三态，区别不可省略：不传表示不过滤；传 `null` 或 `''` 表示"该会话中不带轮次标识的记录"（轮次折叠会把这个分组报成 `turnId: null`，调用方把它传回来是合理请求）；传字符串表示精确匹配该轮次。把它与"不传"混为一谈，会让一个收窄的查询返回整个会话。

### 6.4 HTTP 面板（Studio）

对齐 dsh Trajectory 的观感：

1. **顶部 Overview 时间条** — 按 `created_at_ms` 投影真实开始/耗时；助手条区分「思考段」与「输出段」（用 `thinking_duration_ms` vs `request_duration_ms - thinking_duration_ms` 近似 dsh 的 TTFT/解码双色）；悬停显示精确耗时
2. **轮次记录表** — 按 `turn_id` 分组，标注轮次/步骤边界、请求编号、累计 token
3. **检查器** — 点开一条：token 用量（input/output/cache/total）、`request_duration_ms`、`thinking_duration_ms`、工具入参、工具结果、状态
4. **筛选** — 按人类/注入来源、按工具、按失败，以及按轮次 ID 与正文文本
5. **压缩区段** — `kind=compaction` 落独立 `Between turns` 段，显示 messages/tokens 前后
6. **子代理视图** — 通过 `parent_session_id` / `background_tasks` 展示嵌套
7. **搜索** — 走 FTS5
8. 长历史分页 + 只渲染可见行

### 6.5 安全基线（对齐先例，并按 review 修正）

监听与网络隔离：

- **仅绑定 `127.0.0.1`**，且地址是常量，无任何覆盖途径（环境变量/参数/配置都改不动）
- 请求级再挡一道：`req.socket.remoteAddress` 不是回环（含 `::1`、`::ffff:127.0.0.1`、`127.0.0.0/8`）
  直接 403 `forbidden_remote`
- `Host` 头必须等于监听 authority；带 `Origin` 时校验同源；`Sec-Fetch-Site` 为 cross-site / same-site 时拒绝
- 测试断言「所有非回环本地地址上都连不通」

授权（**不是** CSRF 栅栏）：

- 每个 MCP 进程启动面板时用 CSPRNG 生成 256 位 capability token，放在 URL fragment（`#t=…`）
- 每个 `/api/*` 都要求 `x-trajectory-token`，用 `timingSafeEqual` 等长比较；重复头/非字符串一律拒绝
- token 只在内存、不落盘、`stop()` 即失效；重启面板换新 token
- fragment 不发往服务端 → 不进请求日志、不进静态资源 Referer
- 进程隔离：mcode 每会话一个 MCP 进程 → 每会话一个面板一份 token，A 的 token 打不开 B 的面板
- 保留 Host/Origin/Sec-Fetch 校验作为纵深，但不把它们当授权

文件读取的包含性（唯一不变式）：

- 任何读取的 canonical（realpath）结果必须落在 canonical `dataDir` 之内
- 末段组件不得是 symlink；用 `O_NOFOLLOW` 关闭 realpath→open 之间的窗口
- **打开后再校验一次**：Linux 上读 `/proc/self/fd/<fd>` 拿到真正被打开的 inode 路径，再对 `dataDir`
  校验 → 关闭「中间目录在 realpath 与 open 之间被替换」的窗口。无 `/proc` 的平台（macOS / Windows）
  该竞态不在防护范围内，且这是**明确写进文档的**接受边界，不是隐含假设
- 用已打开 fd 做 fstat 取 size、做 stream 读 → 检查与读取是同一个 inode（无 TOCTOU）
- 每次目录遍历逐层用 `isDirectory()` 过滤（dirent 对 symlink 目录返回既非文件也非目录）
- canary 测试覆盖：目录 symlink / 两级跳转 / 相对 symlink / 末段文件 symlink / 根自身是 symlink，
  且每条都配正向对照；另加 `/proc` 后校验的机制测试与「同名前缀兄弟目录不算在内」测试

脱敏（覆盖凭据在磁盘上的真实形态）：

- 规则**有序**：私钥块 → 连接串内联凭据 → 整个 Authorization 头（含 scheme）→ 裸 scheme+token
  → provider 前缀 key → 定长 provider token → AWS key id → Azure AccountKey → 无标签 JWT
  → 转义 JSON 键值对 → 普通键值对 → PII（受开关控制）
- **两层，缺一不可**。凭据在磁盘上的真实形态是「JSON 文档存在 JSON 字符串里」：`tool_call_result_data`
  是 TEXT 字段（真实投影 118,109 行中 109,462 行如此），所以到达脱敏器时是 `{\"api_key\":\"…\"}`。
  - A 层：字符串值若能 `JSON.parse` 成对象/数组，就按结构化数据再走一遍按键名判定；**只有真的改动了
    才重写该字符串**，否则原样返回（否则面板里每个 JSON 工具结果都会被重新排版而什么也没保护到）。
    深度上限 4 层、单值上限 512 KiB。
  - B 层：键值规则的分隔符允许带任意层反斜杠并原样回填，因此对**不是合法 JSON** 的文本（截断、
    与散文混排）同样命中。规则的值**不允许跨越转义引号**——否则转义文档里的外层非敏感键会先把整段
    吃掉（回调看到无害的 key、返回原样，而扫描指针已经越过内层敏感对），内层凭据就此漏网。这条
    边界是实测出来的，测试里有专门的反例。
- 键值对允许 key 与分隔符之间夹引号（`{"api_key":"…"}`），替换时保留引号形状 → 结果仍是合法 JSON；
  连接串的 userinfo 段用贪婪匹配到**最后一个** `@`，因此密码本身含 `@` 时不会只脱一半而漏出尾巴
- **规则幂等**，且这是可测的性质而不是声明：`redact.test.mjs` 对整份语料 ×4 组选项断言
  `redact(redact(x)) === redact(x)`。三处实现细节是它成立的原因——未加引号的值字符类拒收 `]`，
  因此 `alreadyRedacted()` 额外接受缺右括号的 `[redacted`；`alreadyRedacted()` 还接受标记的**任意
  前缀**，否则小 `maxLength` 把标记截成 `[re` 后会被当作新值重新脱敏，标记逐轮变长；截断标记自身
  也被识别，避免第二次 sweep 去截断第一次的标记、让 omitted 计数漂移
- 定长 provider token 用长度锚定而不是只看前缀：`npm_config_registry` / `HF_HOME` 是普通环境变量，
  只按 `npm_` / `hf_` 前缀匹配会把它们一起脱掉，毁掉用户打开面板想看的东西
- 结构化键与自由文本都用**带词边界的包含**判定，`session[_-]?id` 例外（它是寻址标识不是凭据），
  因此 `clientSecret` / `refreshToken` / `accessToken` / `authToken` / `apiSecret` / `xApiKey` 这类
  camelCase 变体一律命中，而 `inputTokens` / `total_tokens` 等计数与 `sessionId` 等标识符原样保留
- 任务 description/command 在数据源头脱敏；会话 title 就地替换凭据子串、保留其余文本
- 每个出口（MCP tool result、HTTP API response）整体 sweep 一次，带上边界、深度、广度上限；
  **MCP 的错误分支走同一条 sweep**——只在成功时才脱敏的出口不算边界
- **路径折叠**：家目录、数据目录（`MINIMAX_DATA_DIR`，覆盖家目录在容器/CI 里被放到别处的情况）、
  以及 `MCODE_TRAJECTORY_REDACT_ROOTS` 追加的根，在**任意位置**折叠为 `~`，并同时折叠 Windows 路径
  在 JSON 列里双反斜杠的形态；**其他账号**的家目录保留形状、去掉账号名（`/home/<user>/…`）。
  该开关只可能多折叠、不可能少折叠，因此它与监听地址不同：它不是一条能削弱防护的配置面
- **PII（邮箱 / 电话）只在 MCP 出口打码**：MCP 结果会进入模型上下文，面板是读者自己的屏幕。两个
  出口共用一套规则、只有一个开关不同，这个区别在代码里是一处显式传参，不是隐含行为

数据量与进程卫生：

- SQLite 侧与 JSONL 侧都有**单行上限**：JSONL 2 MiB（缓冲区随分块即时封顶），SQLite `data_json`
  8 MiB。超限行以 `oversized` + 字节数上报——既不是整行读进内存，也不是静默丢弃；写 SQL 时用
  `CASE WHEN length(CAST(data_json AS BLOB)) <= ?` 让判定在 SQL 内侧完成，超限值根本不进
  JS 字符串。**这里必须按字节而不是字符计**：`length()` 作用在 TEXT 列上返回的是**字符数**而非 UTF-8 字节数，
  于是一条 4 字节码点的行会以四分之一的体量通过字节上限，然后被完整解析并返回——上限恰好
  放过了它要拦的那种行。CAST 成 BLOB 后 SQLite 直接读记录头里的字节长度，比逐字符扫描更便宜
- **分页游标按“已投递记录数”推导**，不是按“已读取记录数”。聚合字节预算会把一页裁短（1000 条
  裁到 209 条），此时若回传读取层的 `nextOffset`（1000），客户端会永久跳过 209-999 这些
  记录——预算生效了，会话却是不完整的。裁剪发生时游标取 `offset + 已投递条数`
- **会话列表与全文检索按快照游标翻页，不按行位置**。这两张表是插件里唯二按 `updated_at_ms DESC`
  排序的，而这一列恰好是运行时每写一次会话就改写的列——`LIMIT ? OFFSET ?` 数的是**位置**，于是翻页
  途中被写入的会话会跳到游标之上、再也不会被投递，而走查仍然以「没有下一页」收尾。12 条会话的夹具
  上实测：走查声称取齐 12 条，实际只交出 11 条不同的会话，还多交一条重复；`total` 与交付行数一致，
  调用方自己数一遍也发现不了。其余分页工具按 `id ASC` 或 `created_at_ms DESC` 排，两者只增不改，
  位置分页不会丢行，因此**只有这两个工具换成 keyset 游标**
- **排序键必须补次级键**。`updated_at_ms` 是毫秒戳，会话会在它上面打平（本机实测有 3 个会话共享同一
  个值）；只有部分确定的行序会把打平的一组按没人写下来的规则切在页边界两侧。次级键用主键
  `session_id`，行序由此变成全序
- **游标自带快照上界**。仅换 keyset 仍会丢掉“跳到游标之上”的行，所以每页都带着走查开始时钉下的那个
  时刻（`walkPinnedAtMs`），查询与 `total` 一并受它约束：走查途中被写入的会话会**同时**退出页和计数
  ——是被排除并计数，不是被丢弃却仍计数。上界对钉子取**严格小于**：毫秒戳同一毫秒内的写入与钉子前的
  写入无法区分，取闭区间会让移动的行留在窗口内、落到游标之上，于是整个缺陷在一毫秒的角落里原样存活
- **每轮进展要带上失败数，否则失败总数无法下钻**。`trajectory_summary` 一直发布 `toolFailures`，
  每条记录也一直带 `failureCount`，但轮次行两者都没有——于是「这一轮哪里出了问题」只能翻完整个
  会话逐条看 `toolCalls[].ok`。在实测的 21992 条记录 / 752 次失败 / 444 轮的会话上，这是 22 次调用、
  1.4 秒，外加一屏没人想要的记录。补上之后是 3 页轮次 + 1 次 `trajectory_get`（带 `turnId`，这个
  过滤器本来就有）。**代价要说清楚**：多一条 `json_each` 展开语句，冷启动折算从约 800ms 变成约
  1800ms——但它取代的正是那 22 次翻页（约 1430ms，且不可缓存），而折算是按会话签名缓存的。
  计数与 `trajectory_summary` 用同一判据，因此新增一条可验证的不变量：**Σ 每轮 failureCount
  === toolFailures**
- **「没有工具调用」要读作 0，不是缺席**。`json_each` 遇到缺失的路径一行都不产出，于是没有工具调用的
  轮次**根本不在**失败折算的结果里；`undefined` 读作「未统计」，会把调用方打回逐条翻页。
- **不发布面板上的 `branch`**。投影里根本没有「会话当时的分支」：`record_json` 没有，
  `source_context_json` 全机 5000 行只有 `origin` 与 `clientRequestId`，面板那个分支是**磁盘上的当前
  HEAD**。把它接到 `trajectory_list` 上，会让「上周在 X 分支的那个会话」得到一个看起来对、其实错的
  答案——对「找历史会话」来说，这比没有更糟
- **拿到正文的唯一入口要在 Skill 里点名**。`detailLevel: 'full'` 是唯一能拿到 `content` /
  `thinking` 的途径，`summary` 只给 `contentLength`。SKILL 里写过「优先 `summary`、请求 `full` 前
  先问用户」的政策，却**一次都没写出参数名**——而这两个工具的后半截就是消息正文。更糟的是枚举外的值
  被静默忽略：一条正文 16 字的记录，默认值、正确值和拼错的值三者里只有正确值带 `content`，另两者
  返回的记录里根本没有这个字段——**与「这个会话什么也没说」完全同形**，回复里没有任何提示。
  现在拼错会在 `note` 里点名实际使用的档位。设计规则：**被静默丢弃的参数，和被静默忽略的枚举值，
  都必须说出来**，否则调用方无法区分「照做了」与「照做了但没用」
- **游标要带着「它属于哪一次走查」**。游标只说从哪儿续，不说续的是哪一个问题：实测带上 `agent`
  过滤走了一半、把游标原样传回但漏掉 filter，第二页混进了非该 agent 的会话，而 `total` 报的是
  未过滤的总数；跨两个查询更糟——游标的键通常落在新查询所有匹配之上，页面直接为空。**空列表且没有
  note**，正是这个插件在别处极力避免的那种回答。因此游标里带一份走查身份的指纹（由查询与决定总体的
  过滤器算出），对不上就返回新问题的第一页并明说。指纹**不含 `limit`**——它决定携带多少，不决定哪些行
  匹配，把它算进去会把一次完全合法的续页判成换了一次走查
- **两种翻页约定各只发布一种**。`nextOffset`/`offset` 服务只增不改的顺序，`nextCursor`/`cursor`
  服务会被改写的排序键；同时发布两种，等于把选错的那一种留给模型，而回复里没有任何字段能提示选错了
- **预算对一条记录是软的**：游标由已投递条数推出，一页若一条都放不下就会回传同一个
  `nextOffset`，客户端会无限重取同一条。因此至少投递一条（该条已过单字段上限，超出量有界），
  并且这种情况也要把 `truncated` 置真——否则一次超预算数倍的回复会自称完整
- **JSONL 回退同样分页**。它此前每次从文件头重读且游标被丢弃，于是 5000 条的会话只返回
  前 1000 条并报告“已到末尾”。现在按 `offset` 续读，并用一条前瞻记录区分“文件到此为止”和
  “还有下一页”；`total` 回 `null` 而不是编一个数——折到页满就停，从不统计整份文件。
  超行上限被丢弃的行数经 `droppedOversized` 上报（此前在 store 里算出来却在路由里丢掉）
- 记录列表类工具（`trajectory_get` / `trajectory_tasks` / `trajectory_list` /
  `trajectory_search`）与面板的 overview 任务列表**共用同一条总帧预算**。只给事件列表设预算时，
  `limit: 2000` 的任务列表（description 即命令行）可以一次返回约 32 MB，且 MCP 帧里再翻一倍
- 诊断列表有上限（`WARNINGS_MAX = 64`），并回传 `warningsDropped`；长驻 MCP server 每次读失败都会
  追加一条，无上限即慢泄漏，而这份列表每次 `trajectory_list` 都会整体回传
- 唯一执行外部命令的地方是 `git rev-parse`：传**白名单环境变量**而不是整个 `process.env`
  （宿主导出的凭据不会被继承），固定 `-c core.fsmonitor=false -c credential.helper=`，并关掉
  `GIT_ASKPASS` / `SSH_ASKPASS` / 分页器。用户自己的 `~/.gitconfig` **故意保留**：`safe.directory`
  在那里，切断它会让所有非本用户 checkout 静默退化为按路径分组；探针不从中读取任何值
  （`rev-parse` 无 hooks、无分页器、不查凭据），且**实测**仓库自带 `.git/config` 里的
  `alias.rev-parse` 无法劫持内置命令

### 6.6 威胁模型与已知限制

写清楚哪些是防护、哪些是接受边界：

| 威胁 | 处置 |
|---|---|
| 网页（CSRF / DNS rebinding）读取本机面板 | Host 精确等于监听 authority + Origin 同源 + `Sec-Fetch-Site`；Host 精确比对天然免疫 rebinding |
| **本机其他进程**读取面板 | 每进程 capability token（256 位 CSPRNG，只在 fragment，内存态）。栅栏挡不住进程，凭据才是授权 |
| 凭据随 `full` 明细走出本机 | A+B 两层脱敏 + 出口 sweep + 出口 PII；实测覆盖全投影中所有转义形态的敏感键值对 |
| 会话数据被上传 | 无网络目的地、无遥测；唯一的出口是 MCP 结果进入模型上下文，故 PII 只在这一侧打码 |
| 恶意 symlink 把读操作引到 dataDir 之外 | canonical 化全路径 + `O_NOFOLLOW` + `/proc/self/fd` 复核；无 `/proc` 平台的残余竞态为文档化边界 |
| 超大行/超大响应耗尽内存 | 单行上限 + 单串上限 + 单响应字节预算，超限一律上报而不是静默丢弃 |
| 仓库自带 git 配置劫持探针 | 白名单 env + 固定 `-c`；alias 劫持内置命令已实测不可行 |

已知限制（**不是**待办，是边界）：

- 脱敏器认的是凭据的**形状**与**凭据名**；既无标签、也不符合任何 provider 形状的高熵字符串不在
  识别范围内。这是拒绝「用启发式去猜一切」的自觉选择：过度脱敏会连带毁掉读者要看的内容
- PII 只覆盖邮箱与电话，且只在 MCP 出口；姓名/地址/客户名不在模式范围
- 未列入折叠根的绝对路径原样返回（`summary` 的 `workspaceDir` 亦然），需要用户显式加根
- **面板 capability 会随工具结果进入会话记录**：运行时把工具结果落盘，并在后续轮次把上下文发给模型
  服务。缓解是它**随进程消亡**且面板只监听回环。希望凭据完全不入模型上下文时，用
  `node server/main.mjs --serve` 在终端自行启动即可（URL 只打印在终端）
- `--doctor` 原样打印数据目录与库路径：它是给人看、由人决定是否分享的诊断面


渲染层：

- 客户端零 `innerHTML` / `insertAdjacentHTML` / `outerHTML` / `document.write` / `srcdoc` / `eval` /
  `new Function` / `javascript:`，且 `setAttribute` 的名字必须是字面量
- 全部节点用 `createElement` 构建、用 `textContent` 写入 → 会话正文永远是文本
- CSP `default-src 'none'` + `script-src 'self'`（无内联脚本、无远程源）
- 上方 sink 清单由**带变异自检**的静态扫描守住（扫描器先证明自己抓得到，再扫真实资源）

其余：

- SQLite 一律只读打开（`readOnly: true`）；不写入任何会话产物
- 插件不创建任何文件：不写 PLUGIN_DATA、不写端口文件（面板端口只出现在工具返回值与 stdout）
- 单行 / **单响应**大小上限：JSONL 单行 2 MiB；事件列表按序列化字节裁剪到 4 MiB（MCP 因一次结果
  同时带 text 与 structuredContent，取一半预算），并回传 `truncated` / `omitted` 让客户端翻页
- JSONL 读入的缓冲区**逐块**封顶：单行无换行符时不会先累积到整文件再判断，而是超过 2 MiB 即丢弃
  该行并跳过到下一个换行
- 出口 sweep 同时限制深度（64）与广度（10000），避免深嵌套 `data_json` 造成栈耗尽
- 错误响应只回闭集内的固定码，非预期错误只写 stderr

### 6.7 校验器合规清单（`scripts/validate.mjs`）

- [ ] 目录名 = `plugin.json.name`，符合 `PLUGIN_NAME`，≤64 字符
- [ ] 全目录**无 symlink**
- [ ] `README.md`、`LICENSE` 非空
- [ ] `plugin.json` 声明 `license`
- [ ] 任何 `.md` / `plugin.json` / `mcp.json` 中**不得出现 `T`+`ODO` 占位字面量**
- [ ] 至少一个 Skill 或 MCP server
- [ ] SKILL.md 有 YAML frontmatter，`description` ≤1024，正文非空
- [ ] MCP transport ∈ {stdio, streamable-http, sse}

---

## 7. 已确定的取舍

1. **命名**：`mcode-trajectory-studio`（备选 `mcode-trajectory`、`mcode-flight-recorder` 未采用）。
2. **形态**：MCP stdio + 本地 HTTP 面板。Web UI 是本插件的核心——只给 MCP 工具无法回答「时间花在哪里」。
3. **TTFT**：mcode 不落盘 TTFT，因此 `ttftMs` 恒为 `null` 并明确标注不可用；Overview 改用「思考段 / 输出段」双色条（紫/绿）。

---

## 8. 实现落地情况（已交付）

### 8.1 文件清单

```
plugins/weekbin/mcode-trajectory-studio/
├── DESIGN.md                     本文件
├── README.md                     用户文档（含隐私与已知限制）
├── LICENSE                       Apache-2.0
├── plugin.json                   便携 Agent Plugins 1.0 清单
├── mcp.json                      MCP stdio 声明
├── .claude-plugin/plugin.json    v0.4.0+ 清单（含 skills / mcpServers）
├── skills/mcode-trajectory-studio/SKILL.md   唯一的 Skill 声明
├── server/
│   ├── main.mjs    入口：stdio / --serve / --doctor / --help
│   ├── store.mjs   数据层：SQLite 只读 + messages.jsonl 兜底
│   ├── mcp.mjs     MCP JSON-RPC + 13 个工具
│   ├── http.mjs    本地面板 + /api/* + 安全栅栏
│   └── redact.mjs  脱敏与长度封顶
├── web/
│   ├── index.html
│   ├── app.js      缩放/平移时间轴、轮次表、检查器、筛选
│   └── style.css
└── test/store.test.mjs           40 个测试
```

**零依赖**：仅用 Node 标准库（`node:sqlite` 要求 Node 22+，本机 24.19.0 验证通过），无构建步骤，无 `node_modules`。

### 8.2 验证结果

| 验证项 | 结果 |
|---|---|
| `npm run validate`（仓库校验器） | `OK plugin weekbin/mcode-trajectory-studio`，29 个插件全通过 |
| `npm run check`（全仓库 1121 测试） | **1120 pass / 0 fail / 1 skipped**。跳过的 1 例是 `if (hasBash)` 的 `else` 分支，本机有 bash 故不执行 |
| 插件自带测试 `node --test test/*.test.mjs` | **763 pass / 0 fail**（Node 22.23.2，FTS5 存在）。另在 **Node 25.9.0** 与 **Node 26.12.0** 上各跑一遍全量：**762 / 0 fail**（两版 FTS5 均存在），9 道门禁同样 9/9。这两版已在引擎矩阵里，理由见 §8.50 |
| 发布门禁 `node tools/release-gates.mjs` | **9 / 9 通过**。第 9 道是 `package-plainness`：每个出货文件做一次 `lstat`，没有可执行位也没有符号链接（§8.49）。第 8 道 `doc-test-counts` 要求上面这张表里的 763 等于套件实际**声明**的用例数，改了测试没改这张表就红 |
| 变异扫 `node tools/mutation-sweep.mjs` | **214 RED / 0 存活 / 0 problems / 36 脚本**。逐档把实现改坏，证明每一条被改坏的行为背后都有一道测试看着——「跑绿了」和「行为被钉住了」是两件事，这是唯一能区分它们的证据 |
| MCP `initialize` / `tools/list` / 13 工具调用 | 全部返回有效结果，真实数据 |
| `--doctor` 真实数据 | 500+ 会话可见，SQLite + FTS 均可用 |
| HTTP 面板（`node tools/browser-check.mjs`，真 Chrome 走 DevTools 协议） | `state=ready`，侧栏 60 个节点、8 个 agent 选项，截断提示按真实会话数显示；点击换会话、搜索命中、无匹配搜索都走通，无 console 错误。刻意不并入默认套件：它需要机器上有浏览器，而套件必须到处都跑得起来。它也是唯一抓到「侧栏把服务端结果二次过滤掉」和「marker 按大小写比较」这两处的地方——单元测试的词全是小写，两个缺陷在它们面前都是绿的 |
| 安全栅栏 | 缺自定义头 → 403；伪造 `Host` → 403 |
| 时间概览缩放 | 滚轮 184m→19m52s，标尺重算，91 条条形可见 |
| 检查器 | 计时 / Token / 上下文 5 段分解 / 思考 / 工具入参 / 结果 全部渲染 |
| 正文开关（`full`） | 正确加载入参、结果与完整文本 |
| 跨平台 CI（`.github/workflows/mcode-trajectory-studio.yml`） | ubuntu / macos / windows 三档跑全套件，最近一次 green 是 **2026-09-28**（HEAD `1857360`）。**§8.5 之后的审计工作尚未提交，因此一次也没进过 CI**——本节所有跨操作系统结论目前来自沙箱实验与推理，不是那台机器上跑出来的 |

### 8.3 实现期的三个发现

1. **FTS5 用的是自定义编码**：`*_terms` 列存 `c<码点十六进制>` token（如「轨迹」→ `c8f68 c8ff9`），直接 `MATCH` 明文永远搜不到。已复刻编码，见 `encodeFtsQuery()`。
2. **工具耗时能从 `background_tasks` 精确取**：`ended_at_ms - created_at_ms`，比按行时间戳配对更准。`kind` 只出现 `bash` / `subagent` 两种。
3. **压缩记录有完整前后指标**：`messagesBefore/After` 与 `tokensBefore/After`，可直接呈现压缩收益。

### 8.4 与 dsh 的能力差距（诚实记录）

| dsh 能力 | 本插件 | 说明 |
|---|---|---|
| turns / steps / llmMs / toolMs / decodeMs / decodeTokens | ✅ 对等 | 见 `trajectory_summary` |
| ttftMs / ttftSteps | ❌ 不可得 | 运行时不落盘，恒为 `null`，不臆造 |
| 轮次表 + 检查器（用量/耗时/入参/结果） | ✅ 对等 | 检查器还多了 5 段上下文分解 |
| 时间概览双色助手条 | ✅ 近似 | 用「思考段 / 输出段」代替「TTFT / 解码」 |
| 压缩 `Between turns` 区段 | ✅ 对等 | `kind=compaction` 带前后指标 |
| 嵌套子工具 / 子代理 | ✅ 对等 | `parent_session_id` + `background_tasks` |
| 时间轴缩放 / 平移 / 重置 | ✅ 对等 | 滚轮缩放、拖拽平移、双击重置 |
| 全文搜索 | ✅ 对等 | 复刻 runtime 的分词编码 |
| 附件 / 图片摘要 | ⚠️ 部分 | 有 `session_assets` 计数，未渲染图片 |
| 分页 + 只渲染可见行 | ⚠️ 部分 | 有分页与 `offset`/`nextOffset`；前端一次性渲染前 800 条，未做虚拟滚动 |

### 8.5 面板交互修订（v0.1.0 二轮）

| 反馈 | 处理 |
|---|---|
| 侧边栏会话应按 workspace 分类并支持折叠 | 按 `workspaceDir` 分组，组头显示路径尾段与数量徽标，可折叠，折叠状态存 `localStorage`；另加「折叠切换」一键全折/全展 |
| 时间轴应按 INPUT / MODEL / TOOL 三行叙事，而不是按轮次堆叠 | 重做为三条共享时间轴的通道：INPUT（用户消息）、MODEL（请求，内含思考/输出双色段）、TOOL（后台任务与子代理，另加由记录间隔推导的浅色等待段）。通道内重叠块贪心装箱为子行。缩放/平移/重置保留 |
| 默认显示正文，溢出单行省略，点开侧边栏看详情 | `detailLevel` 默认为 `summary`（需要正文时显式请求 `full`）；记录行 `white-space: nowrap` + `text-overflow: ellipsis`；空正文时依次回退到思考内容、工具名，不再显示「（无正文）」；点击行打开右侧检查器 |
| 后台任务/子代理不能展开、看不出作用 | 改为可展开卡片：任务 ID、起止时刻、耗时、所属轮次、执行模式、子代理名、工具调用 ID、子会话 ID、完整命令，以及打开子会话轨迹 / 定位调用记录。**面板不再渲染输出日志尾部**（该区域已移除）；`/api/task-output` 与 `trajectory_task_output` 仍提供尾部，输出路径与 id 形状由服务端重建，不接受存储的 URI |

新增能力对应关系：

- `metadata.childSessionId` 让子代理任务可以下钻到自己的会话轨迹（已在真实数据上验证：点开 `verifier` 子代理后跳转到 `Goal verification` 会话）。
- `output.log` 读取走独立工具 `trajectory_task_output`，路径由数据目录 + 任务 ID 重建（不信任存储的 URI），任务 ID 有严格形状校验，拒绝符号链接，只读尾部若干字节。

### 8.6 面板安全基线（不变）

`127.0.0.1` 绑定 + `Host`/`Origin` 校验 + API 强制自定义头 + 默认拒绝的 CSP。
注意 CSP 的 `style-src 'self'` 会拦下 HTML 里的内联 `style` 属性——样式必须走外部 CSS 或 CSSOM。

### 8.7 二轮重构：按维度展开、消除重复（v0.1.0 三轮）

用户对照 dsh 的实际 Trajectory 界面提出三点：

| 反馈 | 处理 |
|---|---|
| 按 workspace 分组时还要看是不是 git tree，是的话归为一类 | 新增 `server/git.mjs`：用 `git rev-parse --path-format=absolute --git-common-dir` 解析仓库（worktree 共享 common-dir，正是合并键），同仓库的所有 worktree 合成一组。实测 `CTAS` 组把 3 个工作区 60 个会话合并为一类，分组数从上百降到 39。非 git 目录回退路径分组 |
| 内容要详细：用户输入、注入上下文、hooks、工具入参输出、schema，尤其失败处要能定位 | 见下 |
| 按维度展开，不要平铺直叙，不要在不同功能里重复信息 | 见下 |

**信息架构（每个面只回答一个问题，不重复）**

| 面 | 回答 |
|---|---|
| Agent 与能力 | 这个会话被配置成什么（模型 / 工具白名单 / 技能 / 系统提示） |
| 统计条 | 会话总量（轮次 / 步骤 / 三类墙钟 / token / 失败数） |
| 时间轴 | 何时发生（仅导航与缩放，不含正文） |
| 轨迹流 | 发生了什么（每条消息、每次工具调用一行） |
| 检查器 | 选中那一行的完整细节 |

**按维度展开的实现**

- **人类输入 vs 框架注入**：`store.mjs` 新增 `classifyInput()`，依据 `sourceContext.origin.type`
  与 `source` 判定。实测本机 2546 条用户行中 174 条问卷、3 条后台任务回灌为注入。前端用蓝色
  `INPUT` 与紫色 `注入` 区分。
- **工具入参与结果同行**：`#taskIndex()` 按 `toolCallId` 把 `local_runtime_background_tasks` 关联
  到工具调用上，一行显示 `TOOL bash ▸ {入参} ⇉ {结果} · {实测耗时}`。实测某会话 181 次调用中
  104 次拿到实测耗时，其余为进程内工具、如实显示 `—` 而不估算。
- **Agent 能力维度**：新增 `getAgentDefinition()` 读取 `local_runtime_session_agent_definitions`，
  展示 provider/model/variant/上下文窗口/最大输出/工具白名单/技能/系统提示。151 个会话有此记录。
- **失败定位**：`classifyResult()` 基于运行时自己的 `details.is_error`、`Command exited with code N`
  与结果文本里的 `Traceback` / `[stderr]` 分级——**硬失败**（Traceback/stderr/is_error）与
  **软失败**（非零退出，`grep` 无匹配属此类，不应当成真故障）。关键点：全库 4103 次"失败"调用里
  0 次带 stderr、260 次带 Traceback；且**存在调用状态码为 2（成功）但输出含 Traceback 的情况**，
  只看状态码会漏掉，所以判级读文本而非只看状态码。检查器"结果"页给出失败证据块
  （is_error / 退出码 / 调用状态码 / 判级）并直接从 Traceback 行开始截取。
- **Schema**：运行时不持久化工具入参 schema（dsh 同样显示 "Schema unavailable"），分页给出明确解释
  而不是留空。
- **hooks**：本机 observability 目录与 `plugin-hook-cache` 均无 hook 事件落盘，因此不展示——
  不编造不存在的数据。

**删除的重复**：移除了独立的「后台任务/子代理」面板（它的信息已在 TOOL 行里，属重复），
移除与工具行重复的任务计数卡片；时间轴明确标注"仅用于定位与缩放，正文见下方轨迹流"。

### 8.8 三轮：侧边栏树形化与极简化（v0.1.0 四轮）

| 反馈 | 处理 |
|---|---|
| 子代理应放在主 agent 的子目录，呈树形结构 | 侧边栏改为树：按 `parentSessionId` 把子代理会话挂到派发它的会话下，**递归多层**（子代理还能再派子代理），父行左侧给 caret 展开/折叠。父会话被过滤掉时子行提升为根，保持可达 |
| 参考会话选择处，尽可能精简 | 行内只留 caret + 标题。原先的 agent 徽标、分支、子标记、目录尾段、相对时间五件套全部移入 tooltip；仓库组头从「GIT/DIR 文字徽标 + 仓库名 + N 工作区 + 计数胶囊」简化为「文件夹图标 + 名 + 暗色计数」，git 组用绿色图标、非 git 组用灰色图标区分而不占文字 |

配套细节：

- 展开状态存 `localStorage`（与折叠状态分开），刷新后保持
- 选中某会话时自动展开其全部祖先（`revealAncestors`），避免选中项藏在折叠节点里
- caret 点击 `stopPropagation`，展开不会误触发会话切换（已实测验证）
- 图标用内联 SVG（`createElementNS`），不依赖字体或远程资源，符合 CSP `default-src 'none'`
- 实测：161 个根项、43 个带子节点；展开后子行缩进 6px → 20px

### 8.9 四轮：交互细化与性能（v0.1.0 五轮）

| 反馈 | 处理 |
|---|---|
| 层级缩进关系优化 | 缩进从 14px/层降到 12px/层并**在第 4 层封顶**，改用「每层一条发丝引导线」表达层级（`repeating-linear-gradient` + `--d` 变量），浅缩进也能读出嵌套关系 |
| 高亮要和当前显示的详细信息一致 | 三处修正：(1) 选中会话若被 limit/搜索/agent 筛选排除，用 `/api/sessions?id=` 强制补进列表，保证高亮行一定存在；(2) 去掉每次切换的重复 `renderSessions()`（原先渲染两遍）；(3) 选中后 `scrollIntoView` 把高亮行滚进视野——高亮对了但看不见等于没对 |
| 整行都可展开收起，而不是只有图标 | 整行 click 即切换：折叠态点击 → 选中并展开；已选中且展开时点击 → 收起。caret 保留为视觉提示，不再需要精确点击 |
| agent 分类改下拉框，选项动态 | 换成 `<select>`，选项来自 `/api/agents`（`GROUP BY agent_name`），实测本机为 `mavis(294) / verifier(89) / explore(70) / worker(34)`。子代理预设因机器而异，故不硬编码 |
| 切换显示非常卡，优化 SQL / 加懒加载 | 见下 |

**性能：先量化再优化**

逐层计时后发现**瓶颈不在 SQL**——服务端全部是毫秒级：

```
   4 ms  listSessions(300)
  27 ms  getStats
  19 ms  getEvents full 1000
   2 ms  listBackgroundTasks(2000)
```

真正的问题是**前端全量重建**：一次会话切换产生 5691–9243 个 DOM 节点，633–1200 个流行一次性创建，并有 10 次阻塞型长任务（最长 227ms）。

| 优化 | 效果 |
|---|---|
| `/api/overview` 不再返回 events（原先取了 summary 却在 `refreshEvents` 里被 full 覆盖丢弃） | 省一次查询 + 大 payload |
| 轨迹流分页懒加载：首批 150 行，滚动到底再追加（DOM 增量 append，不重建） | DOM 从 9243 → 4593 |
| 行对象缓存（`state.streamRows`），筛选只在缓存上过滤 | 筛选不再重建行对象 |
| 搜索/文本筛选 **140ms 防抖** | 连续输入不再逐字符渲染 |
| 侧边栏图标改为「构建一次 + cloneNode」 | 每次渲染不再重建 ~120 个 SVG |
| 轮次汇总改服务端 `GROUP BY turn_id` | 分页后轮次头仍是全量准确值，且省掉客户端每次重算 |
| 每次切换只渲染一次侧边栏 | 去掉重复渲染 |

**实测（同一批 5 次切换）：**

| 指标 | 改前 | 改后 |
|---|---|---|
| 切换耗时 | 633 / 668 / 1104 / 794 ms | **165 / 64 / 195 / 137 / 110 ms** |
| 阻塞型长任务 | 10 次（最长 227ms） | **0 次** |
| DOM 节点 | 5691 – 9243 | **4593** |

### 8.10 五轮：视觉统一、主题与两处隐蔽 bug（v0.1.0 六轮）

| 反馈 | 处理 |
|---|---|
| 滚动条细一点、兼容主流浏览器 | 同时用标准属性（`scrollbar-width: thin` + `scrollbar-color`，Firefox 与 Chrome 121+）和 `::-webkit-scrollbar` 伪元素（旧 Blink/WebKit）。注意实现上二者在 Chrome 里互斥——设置了标准属性后伪元素被忽略，所以两条路径都调到一致的细条 |
| 切换仍慢；大会话可加分页或 loading | 见下「性能二轮」 |
| 轨迹流不同分类样式要统一、默认一行 | 所有行统一为固定 `min-height: 24px` + `line-height: 18px`，实测 91 行**高度全为 24px**；把原先第二行的标记 chip（思考/压缩）改为行内；工具行摊平为 flex 直接子元素 |
| TOOLS 为什么两行？是分类吗？ | **不是分类，是时间重叠的并行执行**。贪心装箱把同一时刻并发运行的调用放到第二子行。已在提示行明确写出：「同一通道出现多行表示这些调用在时间上重叠（并行执行），不是分类」 |
| Agent 能力手风琴没有箭头，看不出默认收起 | `<summary>` 加三角 caret，收起时朝右、展开时旋转 90°（CSS `details[open]` 驱动），hover 变强调色 |
| 轮次优先显示第 N 轮，而非 hash | 轮次头改为 `第 N 轮` 主显 + turn hash 次要，序号来自服务端按 `MIN(created_at_ms)` 排序的轮次列表 |
| 时间轴点击没反应 | 根因：点击只开检查器，但目标行可能在分页批次之外，滚动找不到就静默失败。改为 `locateRow`/`locateToolCall`：**持续向服务端要页直到该记录被加载**，再持续渲染直到进入 DOM，最后滚入视野。实测点击 MODEL 块 → 检查器打开且目标行高亮可见 |
| 不要大圆角 | `--radius` 统一 2px，chips/徽标/面板/输入框全部跟随（原 8/6/999px 全撤） |
| 增加黑白主题切换 | 三态（跟随系统/深色/浅色）：默认 `auto`，一次点击就是浅↔深翻转；浅色变量在 `prefers-color-scheme` 媒体查询与 `[data-theme="light"]` 各写一份，这样系统偏好无需脚本即可生效，不会闪错主题。持久化到 `localStorage` |

**性能二轮：找到真正的慢点**

第一轮优化后仍慢，继续量化发现两个新问题：

1. **`getStats` 对超大会话是主瓶颈**。10,819 条记录的会话耗时 **556ms**——原因是用相关子查询 `SUM((SELECT COUNT(*) FROM json_each(...)))` 对**每一行**重新解析 JSON。改成 `json_each` join 单次展开，并把压缩计数并入同一次扫描，降到 **377ms**。
2. **历史会话不变，却每次重算**。新增按 `sessionId|updated_at_ms` 键控的有界缓存（96 条，LRU 淘汰）。复访 **383ms → 1ms**。
3. **一次请求拉太多**。原先每次切换都请求 1000 条 full 记录（大会话 **6.1 MB**）只为渲染前 150 条。改为服务端分页：只取 `EVENT_PAGE=200` 条，滚动再取。同时时间轴改走独立的紧凑端点 `/api/timeline`（不含正文，只取时间戳/角色/来源/耗时），与分页的轨迹流解耦，保证轴仍覆盖整会话。
4. 新增切换时的 loading 遮罩，避免大会话首屏无反馈像卡死。

**两个隐蔽 bug（都写进了回归测试）**

1. **SQL 别名与真实列同名**：`local_runtime_message_rows` 有自己的 `turn_id`、`role`、`source` 列。把 JSON 表达式 `AS turn_id` 后，驱动取到的是真实列而非表达式，导致轮次汇总**静默返回 null**，界面上一整片「未分轮」。已改用不重名的别名（`turn_key`/`role_json`/`source_json`）并统一 `COALESCE(turn_id, turnId, turn_id列)`，让汇总与事件投影对同一条记录得出同一个轮次。
2. **端口被占用时静默回退**：改端口逻辑在 `EADDRINUSE` 时自动换端口，于是旧进程继续占着 7391、新代码跑在随机端口上——看起来像「改了没生效」。现在请求端口被占用时会向 stderr 明确告警。

### 8.11 六轮：载荷结果合并、徽标对齐与一处「看不见的溢出」（v0.1.0 七轮）

| 反馈 | 处理 |
|---|---|
| 载荷与结果应放在一起，分开看增加阅读难度 | 合并为「载荷 / 结果」一页：工具入参 → 任务描述 → 同轮思考 → 完整结果 → 附带细节 一次滚动读完。检查器分页从 5 个减到 4 个 |
| Assistant / Input / Tool 徽标要左对齐 | 工具行原先用 `padding-left: 22px` 做缩进，把整行内容（含徽标）右移了 12px。改为**内阴影**标记（`box-shadow: inset 3px 0 0`）而不是 padding/border——两者都会推动内容。实测 5 种视口宽度下徽标左边界都只有一个值 |
| 工具调用处文字重叠溢出 | 见下 |

**一处「看不见的溢出」**

用 `scrollWidth > clientWidth` 检测时**报 0 处溢出**，但截图里明明在压字。原因是 `.srow-meta` 用了 `justify-content: flex-end`（右对齐），内容超宽时向左溢出——而 **`scrollWidth` 只统计右侧溢出，不计左侧**，所以这个检测方法对右对齐容器完全失效。

改用「首个子元素的 left 是否小于容器 left」重新检测，立刻暴露：**91 行里 35 行溢出，最严重 57px**。

修法两条并用：
1. 右列加宽到 138px、字号降到 10px、去掉 `思` 后的空格，让真实内容放得下；
2. `.srow-meta` 及其子元素都加 `overflow: hidden` + `min-width: 0` + 文本省略——即使将来内容再变宽也是被裁切，而不是盖住正文。

修复后 5 种宽度（2567 / 1760 / 1440 / 1280 / 1100）下：溢出 0、正文越界 0。

**教训记一笔**：检测布局溢出不能只看 `scrollWidth`。右对齐容器、`direction: rtl`、负边距都会让溢出发生在左侧而 `scrollWidth` 无感。用「子元素边界 vs 容器边界」比较才可靠。

### 8.12 七轮：时长条补图例，并暴露一处运行时数据不一致（v0.1.0 八轮）

「计时」页那条双色进度条原先**没有图例**——颜色含义只能靠猜。现在补齐：

- 条下方给出图例：`■ 思考段 2.63s` `■ 输出段 365ms（近似）`，右侧 `合计 3.00s`
- 色块与时间轴 MODEL 通道一致（紫＝思考段、绿＝输出段），一处认知覆盖两个界面
- 明确写出推导关系：**输出段 = 请求耗时 − 思考耗时**，且运行时不记录首 token 时刻，所以它是推导值而非实测解码时间

**顺带发现一处运行时的数据不一致**

补齐图例时暴露：部分记录里运行时记的 `thinking_duration_ms` **不小于** `request_duration_ms`（本机约 3% 的行）。原先的实现在这种情况下会把思考段钳到 100%、输出段算成 0ms，图例会显示「输出段 0ms（近似）」——**看起来像一个真实的测量结果，实际是两个互相矛盾的字段被硬凑出来的**。

改为显式识别这种情况：
- 只画思考段（100%），不再硬凑一个 0ms 的输出段
- 图例只列出真实存在的段，不列 0 宽度的段
- 说明改为：「运行时为这条记录记下的思考耗时（4.37s）不小于请求耗时（4.13s），两个数值互相矛盾，因此只按思考段绘制，不推导输出段。」

另补两种兜底：记录没有思考段时只画整段并说明；记录没有模型请求耗时（如纯工具调用）时不留空白，而是说明为什么没有条、并指向上方的「工具耗时(实测)」——避免空白被误读成面板坏了。

### 8.13 `trajectory_find` 的命中定位收敛为单源

`trajectory_find` 有两个读取器：SQLite 投影，以及索引器尚未追到的会话回落到 `messages.jsonl`。二者都回答「这个 needle 在这条记录的哪一处」，但**各写了一份实现**，于是对同一条记录给出不同答案：

- 投影那份只对 `msg_content` / `thinking_content` 生成片段。needle 落在工具调用里时，命中停在 `field: 'other'` 且 `snippet` 为 `null`——刚要了 `full` 详情的调用方只被告知「记录 42，去读吧」。真机实测：用户的原话里拿一个词去搜本会话，193 条命中里前 5 条有 3 条是这种。
- 兜底那份把 `field` **硬编码**成 `'content'`，并从 `event.content` 取片段。而它的匹配谓词读工具调用载荷用的是 `part.input ?? part.args ?? {}`——运行时写的是 `part.arguments`，这两个键在真实 artifact 里都不存在，于是**每个**工具调用往 haystack 里贡献 `{}`。本机最大的 6 个 artifact 里 1,273 个 `toolCall` part 的键集全是 `('arguments','id','name','type')`，无一例外。两个后果：只出现在工具参数里的词在兜底路径上**搜不到**（投影路径能找到，同一会话，两条回复都不会说「来源不一致」）；落在思考里的词被标成 `content`，且因为 `event.content` 里没有该词，`full` 详情下 `snippet` 也是 `null`——与投影路径刚修掉的那个死胡同完全同形。

**教训记一笔**：两份实现各写一份「needle 在哪」的判断，就等于给「定位」和「引用」两件事各留了一个可以独立漂移的选择——漂移出来的形态还不是报错，是一句自信的错话（`field: 'content'`）。凡是「先判断某东西在哪、再按那个位置取」的逻辑，判断和取值必须共用同一个返回定位的函数，而不是各写一份再指望它们一致。

修法：抽出 `locateNeedle({content, thinking, calls}, needle)`，两个读取器都调它；`field` 与 `snippet` 由同一次定位产出，不存在「标签说 A、片段取自 B」的组合。兜底路径经 `foldJsonl` 把定位挂在 `event.matchLoc` 上——只挂在搜索路径上，`trajectory_get` 的分页回复不带它，因为那是未过脱敏的原文。参数先于结果：`arguments` 在投影里已是字符串、在 artifact 里是对象，`locateNeedle` 两者都折叠成文本，而 `null` 保持 `null`（否则 `JSON.stringify(null)` 会让搜「null」命中每一个没有结果的调用）。

`matchedToolCall` 一并落到契约里（`'args'` / `'result'`）：shell 的结果常回显自己的命令行，同一个词常常同一次调用的两半都在，参数才是「模型写了什么」的那一半。

**真机复验**（本机一个未被索引的 50MB artifact，session `bXZzXzA5…`）：

- 修复前，只出现在工具 `arguments` 里、正文与思考里都没有的词，搜索返 0；同一份文件上跑新旧两版谓词对比，`exhaustion` 是 `旧=not found / 新=FOUND`。另两个探测词（`Pixar-rendered`、`output_file_path`）旧谓词也能搜到——它们同时出现在思考段里，所以旧代码对它们的缺陷不是漏报，而是**标成 `content` 且 `full` 下没有片段**。三种情况都复验过：新谓词全部命中，`field='other'`、`matchedToolCall='args'`、片段含 needle。
- 投影路径在真实会话（22115 条记录）上取 `mcode-trajectory-studio`：2 条命中，一条 `field='thinking'`、一条 `field='other'` 且 `matchedToolCall='result'`，片段都含 needle——这两条在修复前分别是「标签说思考但无片段」与「标签说 other 且无片段」。
- 一个返 0 的反证：`plugins` 在该 artifact 里独立 `grep` 计数就是 0，所以那次 0 是诚实的，而不是又一次漏报。探针先自证目标存在，再拿它的读数当证据。

### 8.14 两套翻页约定之间的静默失配

`trajectory_list` / `trajectory_search` 按 `cursor` 翻页，其余五个工具按 `offset` 翻页。拆分不是洁癖——前者排的是 `updated_at_ms DESC`（运行时每写一次会话就改写的那一列），按行号走会静默丢掉走查期间移动的行；后者排的是只增不改的键，位置稳定。理由在 Skill 与 §7 都写着。

**但调用方会在两套之间串。** 而**没有任何一层校验工具参数**（schema 的 `minimum` 只是文档），于是传错键得到的是沉默：

- `trajectory_turns` + `cursor: 3` → 回复 `returned: 5, nextOffset: 5, total: 445`，**无 `note`**。那是 445 轮会话的第 0 页，摆出的样子和你要的页一模一样。
- `trajectory_list` + `offset: 3` 是更糟的方向：它的回复里**根本没有 `offset` 字段**，所以答复中没有任何东西与请求矛盾，调用方连「没生效」都看不出来。

被静默忽略、且返回错误页码的参数，与被静默忽略的枚举值是同一种失败：调用方分不清「照做了」和「照做了但没用」。所以它必须被说出来。

修在 `tools/call` 出站的那一个汇聚点（`withPagingNote`），因为这个条件**在任何一个 handler 内部都检测不出来**——它们都拿不到自己被传了什么参数，也都不校验。规则：

- `note` 是**追加**而不是替换。一次调用可以同时错两处（要的详情级别 + 用来翻页的键），调用方改好一个又弄坏另一个时需要同时听到两件事；已有 note 时用 `;` 接上。
- 正确的键**不发声**。每次调用都挂 note 是同一个缺陷的另一顶帽子：调用方学会跳过它，恰好需要它的那条回复也被跳过了。
- 已经失败的回复不挂。失败的读取没有「页」可言，note 描述的是一个没人问过的问题。
- `cursor: null` 不算翻页尝试——那是走查结束的标记。

5 个变异分别拆掉：完全不发声、只发一个方向、对正确的键也发、覆盖已有 note、挂到失败回复上。全部 RED。

### 8.15 「接口够用吗」的考察，以及两个没有落地的候选

目标里「找历史会话」是一项明确用途。逐条核对现有 11 个工具之后，**有一个真实缺口**：

> 「上周我们在消息正文里讨论 X 的那个会话是哪个？」——今天无工具可答。

`trajectory_search` 走 FTS5，而本机的 `local_runtime_sessions_fts` 只索引 `session_id` / `agent_name` / `title` / `workspace_dir` / `purpose` / `status` / `session_type` 七列，**没有消息正文**。全库只有这一个 FTS 表。所以按内容找会话只能靠 `title` 或 `purpose` 命中；`purpose` 仅在派发子代理时记录（本机 614 个会话里约 439 个有），其余会话只能按元数据匹配。

代价实测（本机 4.4GB 库 / 16GB 内存，111,775 行消息、693MB 载荷）：

| 查询 | 耗时 |
|---|---|
| 整表 `LIKE`（裸计数，重复 3 次） | 722ms / 1037ms / **1900 / 1797 / 1900ms** |
| 端到端回复形状（带 `LIMIT 400`） | 730 / 847 / 779 ms |

也就是说 Skill 里写的「整机范围需数秒」在**本机热缓存下是 0.7–1.9 秒**，不是数秒。但这是热读数：库 4.4GB、内存 16GB，页缓存常驻。文档里原有的 6.4s 应是冷读数，我无法在本机复现冷态，**因此不据此推翻「限定单会话」的理由**——真机上冷启动数秒的整机扫描，不是可以顺手加的一个工具。

第二个候选**明确不落地**：跨会话按文件路径查「哪个会话动过 X」。`local_runtime_session_assets` 全机只有 **746 行 / 50 个会话**，而本机会话有 615 个——资产索引覆盖 3%。查它只要 0ms，而它会对另外 97% 的会话**自信地回答「没有」**。快而错的答复比没有答复更糟，与 §8.13 里「会话当时的分支」那条一个道理：不落地，并把理由写在这里，免得下次再想一遍。

### 8.16 已在多会话上复核的不变量

Skill 承诺「逐轮相加等于会话总量」。此前只在单个会话上验过，这次在最近 60 个会话上逐个走完全部轮次并核对五项：`turnCount` vs `summary.turns`、`Σcount` vs `events`、`ΣllmMs` vs `llmMs`、`ΣoutputTokens` vs `decodeTokens`、`ΣfailureCount` vs `toolFailures` —— **60/60 全部精确相等，零不匹配，且没有投影路径上的轮次返回 `failureCount: null`**。

过程中探针自己报过一次「1 个会话不匹配」（445 轮对 200，正好等于我传的 `limit`）。真因是探针读了 `nextCursor`，而 `trajectory_turns` 发的是 `nextOffset`——**探针的错，不是代码的错**。这与 §8.13 里那条 `locateNeedle` 的教训同源：before/after 的结论只能建立在与被测代码语义一致的探针上。

### 8.17 验证工具本身的两处缺陷：假阴性，和一个会跑的对象

第 16 项的验收里，真浏览器检查出现一次 `exit 1`。同一份代码空闲时连跑三次都是 0，第一反应是重载下的偶发。

**它不是偶发。第一处是构造出来的假阴性。** `tools/browser-check.mjs` 在点击之后一律 `setTimeout(1200~1500)` 再断言 —— 用一个猜的时长冒充等待：机器安静时通过，机器不空时报告失败。这与 `protocol.test.mjs` 头部那条正好是镜像——那里说「预算是给卡住的服务端的，不是给慢的服务端的」，而这里没有把预算和「还没好」区分开。

假阴性的代价比跑得慢更高：这个文件唯一的职责就是当证据，一个在健康代码树上会叫的检查，恰恰让人不再相信它报的通过。值得注意的是同一个文件里**早就有**一处改对了（第 320 行选中会话后的轮询，注释写明「固定 1.5s 会读到上一个会话的行并当成这一个的报出来」），剩下 5 处是当时漏改的残留，所以这次是补齐它自己的既定做法。改法：`waitFor(expression)` 轮询页面条件，满足才继续；超时时把手头状态交回断言，让断言报**真实到达的状态**而不是编一个通过。

**改完仍然失败，于是还有第二处，而且更根本：被检查的对象每次都在变。**

选主体的 SQL 是 `ORDER BY MAX(updated_at_ms) DESC LIMIT 1` —— 取「最近写入的关联任务所属会话」。那不是选一个主体，是给「此刻谁在忙」拍一张快照，**而运行这个检查本身就会写后台任务**：它选的常常正是检查自己所在的会话。六次连跑选中了两个不同会话，渲染出 669 行对 81 个工具行，于是有时过有时不过。这看起来像面板 flaky，实际是每次换了个被测对象。

改成「关联任务最多的会话」后，主体不跑了，但**每次都失败** —— 这是更好的失败：关联任务最多的那个会话有 14984 条，而**它的第一屏一条都没有**。任务索引是有界的，长会话里最旧的记录（也就是面板首先加载的那些）不带 task id，于是无论点多少行都找不到一个根本不存在的按钮。「哪个会话关联任务最多」和「哪个会话能看见一个」是两个问题。

所以第二个问题问的是 store 本身，走面板同一条数据路径，而不是在检查脚本里重写一遍索引查找：候选按固定顺序试，取**第一屏确实带 output 调用**的那个。选择因而既确定又**构造上可满足**——一个显不出按钮的主体根本不会被选中。当前选到的是「Upgrade skill-sync」，首屏 179 个调用里 123 个带捕获输出，五次连跑完全一致。

顺带把两处「只能说出 `(empty)` / `no row among N`」的失败详情补成能自证的：点了哪个按钮、检查器里此刻有什么、`<pre>` 有几个。现在这个文件报的失败本身就是证据。

**教训记一笔**：验证工具的失败信号，和被测代码的失败信号是同一类东西，都要经得起「换一个主体重跑一遍」。一个 flaky 的门禁比没有门禁更糟——它会让人习惯性地忽略红色。**注意**这两处由复现与连跑验证，不由单元测试固定：`tools/browser-check.mjs` 本身就是被测物，它要起真实 Chrome，`node --test` 那一层覆盖不到。这一点如实记在这里，而不是让「全绿」看起来比实际更宽。

### 8.18 真浏览器检查里最后两处平台假设

跨平台这一维专门查了一遍 `browser-check.mjs`，挖出两处，第二处比第一处危险：

**① 浏览器路径写死成 macOS。** `const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'` —— 一个字符串、一个平台。Linux 与 Windows 上它跑不起来，打印一句路径然后 `exit 1`。CI 的 workflow 里有一句注释说「browser 的那一半天然是手工的，不进 CI」，所以这**是有意的**；但一个文件在自己套件跑的两个平台上悄悄跑不了，和「刻意保持手工」不是一回事——读文件的人分不出这两者。改为按平台给候选（macOS 的三个 `.app`、Linux 的五个 google-chrome/chromium、Win32 的三个 `.exe`），`CHROME_PATH` 可覆盖，且**替换**而不是追加候选：显式指定的路径不存在就该说它不存在，而不是悄悄去驱动另一个浏览器。找不到时报的是「找过哪些地方」，不是只报没找到的那一个。

**② `process.env.HOME` —— Windows 上通常没有这个变量。** 旧代码是 `dataDir = process.env.HOME ? \`${process.env.HOME}/.minimax\` : '/tmp'`，在 Windows 上落到 `/tmp`，那是不存在的路径。于是 store 打开的是**一个空的库**，下面每一条检查都在对着什么都没有的东西跑。这比跑不起来更糟：跑不起来会红，对着空库跑可能绿。修法不是另写一份解析，而是**直接用插件自己的** `resolveDataDir` / `resolveHomeDir`（`server/config.mjs`，本来就是 `override → HOME → USERPROFILE`），顺带保证这个工具读的数据目录和插件在三个平台上读的是同一个。

候选表抽到 `tools/chrome-paths.mjs`，平台是**参数**而不是导入时读 `process.platform`——这才使一项跨平台断言在一台 mac 上能被钉住：这是唯一能让「Windows 会被问到什么路径」这件事得到检查的办法。测试钉住的是每个平台的**形状**（POSIX 绝对路径 / 带盘符的 `.exe` / 全用正斜杠 / 未知平台返回空列表而不是别家的），因为「静默退化成空」才是失败形态，而空列表和「跑了但没找到」长得一样。

`tools/panel-e2e.mjs` 与 `tools/compat-matrix.mjs` 复查过：都用 `mkdtemp` 与共享的 `bootstrap`，无同类问题。

### 8.19 一个合法路由缺文件，报的是 500

面板的客户端模块按**形状**提供：`/js/<name>.js` 是路由，不必改路由表就能上线一个新模块。于是「文件在不在」这件事被推迟给了后面那次 `readFile`，而它的任何失败都被报成 `static_unavailable`：

```
/nope        → 404 not_found          （不匹配任何静态形状）
/js/nope.js  → 500 static_unavailable （匹配了，所以交给了读；读失败就是 500）
```

同一个缺失，在根目录是 404、在 `/js/` 下是 500。排障的人会被送去查服务端，而不是查他刚改名的那个文件；一个例行 miss 还会触发 5xx 告警。响应体本身是干净的（`{"error":"static_unavailable"}`，无路径、无栈），穿越尝试 `/js/%2e%2e/server/store.mjs` 也是 404 —— 所以这不是泄漏，是一个会指错方向的错误分类。

**修的过程中我先修过头了一次，值得记一笔。** 第一版把分支写成 `ENOENT || ENOTDIR → 404`，然后变异 B 存活 —— 因为在当前路由形状下 `ENOTDIR` **根本不可达**（`/js/` 与 `/js` 不匹配 `CLIENT_MODULE`，在读之前就 404 了）。但更根本的问题是：`ENOTDIR`（某个路径分量不是目录）和 `EISDIR`（目标本身是目录）**都不证明资源不存在**，它们都留着「东西在那儿，只是读不了」的可能。把它们报成 404，是把「拒绝回答」换成了一个**调用方会照着行动的断言**——这是两个错误里更糟的那个。原来把它们留在 500 恰恰是对的。

于是规则被提成一个有名、可断言的函数 `staticResourceIsAbsent(errorCode)`：**只有 `ENOENT` 返回 true**，其余（`EISDIR`/`ENOTDIR`/`EACCES`/`EMFILE`/undefined）一律 500。直接断言这张表，而不是去构造一个 EISDIR —— 那需要在交付的 `web/` 里种一个名字像模块的目录，留下的测试残留比它证明的代码更糟。

三档变异分别拆掉：完全不区分（一律 500）、把规则放宽成「任何错误都算缺失」（`EISDIR` 也报 404）、以及 404 却带 `static_unavailable` 这个码（两个断言，只有一个为真）。全部 RED。

### 8.20 一个数不是它名字说的那个数

查 `trajectory_task_output` 时，判据选的是**不含任何解释**的那种：工具返回的内容应当等于磁盘上那个文件。拿 25 个真实任务一比，报出两条不一致 —— 但**两条都是探针的错**，这本身已经成了本会话的第四次同型事故：

- `bytes` 是**文件字节数**，我拿 JS 的 `text.length`（UTF-16 码元）去比。含中文时后者必然更小。
- 更根本的是那些任务**正在运行**、`output.log` 在追加，我在工具读完之后才去读盘。

改成与运动目标无关的不变量、并只取已结束的任务之后，仍有 4/40 报 `byteLength(text) > bytes` —— 按 `readTaskOutput` 的实现这**结构上不可能**（buffer 就按 `size` 分配）。真因在 MCP handler：`text: redactText(output.text, ...)`，**脱敏会让文本变长**（凭据被替换成更长的占位符，实测 +1、+9 字节）。所以「返回文本是文件后缀」「文本字节数等于 bytes」这两条，在这条路径上**从一开始就不成立**。

**顺着这条线找到的真缺陷在面板那一侧。** 面板把 `payload.bytes`（文件大小）当成了「已显示多少」：

```
真实任务 bg_21d082ec：文件 50791 字节，面板写「仅显示末尾 50791 字节」
实际显示：末尾 16384 字节
```

夸大了三倍，而且是**用户读到的字**。一个有界读取如果不说明它的界，那就不是一条结论，是字符串上的一件装饰品。

修法：把那句话提成可测的 `taskOutputBlock(payload, maxBytes)` —— 显示数取 `min(bytes, maxBytes)`，并在同一句里给出文件大小作为对照（`仅显示末尾 16384 字节，共 50791`），这样读者既知道看了多少、也知道漏了多少。**面板是唯一知道自己在请求什么上限的地方**，所以这个数该由它算。SKILL 里也补了一句：`bytes` 是**文件**大小不是返回量，`truncated: false` 才代表拿到了整个文件；否则模型读到「很长的 bytes 配很短的 text」会当成矛盾。

四档变异分别拆掉：拿文件大小当显示数、把上限写死成常量、去掉截断提示、去掉对照数。全部 RED。

**这一轮的教训**：`payload.bytes` 这个名字**在两个消费者那里各自被理解成另一件事**——服务端按「文件多大」算，面板按「给了多少」用。字段名在两边都不是错，缺的是有一处把这句话说出来。**凡是同一个数字在两个地方被当成两种量，就有一处会用错，而两边都不会报错。**

### 8.21 同一条回复里两个数各说各话

上一节的判据是「找不出一致」，于是把它套到 `trajectory_list` 的另一个数上：`agents[].count` 对 `countSessions({agent})`。7 个 agent 分组里 4 个对不上。

**但这次探针是对的**，而且对账方式决定了结论站得住：从 store 自己的数据路径读两边（`listAgents()` 与 `countSessions({agent})`），期望值不手写。

```
agent          agents.count   按该名过滤的 total
mavis                183                  172      ← 11
verifier              57                   53      ←  4
general                4                    1      ←  3
coder                  2                    1      ←  1
sum(agents.count) = 633        同一条回复的 total = 614
```

归因（只用 SQL，不用于判定）：多出的 19 行**全部是 `archived = 1`**，且 `visibility` 在本机恒为 `'visible'`。

真因是**第二份「哪些会话算数」的拷贝**。`sessions.mjs` 里 `sessionFilter` 聚合 `archived = 0` 与 `visibility <> 'hidden'`，紧挨着的 `listAgents` 有一份自己的 `GROUP BY`，**一条条件都没有**。同一个文件在 `sessionFilter` 上方写着这件事的后果：

> 一份 `total` 和它所数的行对不上，比没有 `total` 更糟，因为它会被相信。

而这里比那更糟一档：**两个数在同一个对象里**。`trajectory_list` 同时返回 `agents` 与 `total`；面板的筛选下拉直接打印 `${name} (${count})`（`flow.js` 的 `loadAgents`）。于是筛选菜单写 `mavis (183)`，同一屏的 `total` 是 614，点下去回来 172。

修法不是给 `listAgents` 补一条 `archived = 0`，而是**让它调用 `sessionFilter`** —— 那个文件本来就声明过这个函数存在的理由。总体（`archived` / `visibility`）取自它，**切片**（`agent` / `kind` / `sinceMs` / `parentSessionId`）不取：词表必须在「过滤后为空」时仍然完整，那正是调用方需要知道名字写错了的时候；但它不该描述调用方**看不见**的会话。于是只被已归档会话拥有的名字默认缺席、在 `includeArchived` 下回来 —— 而那正是能真的按它过滤的那个范围。三个调用点一起透传，否则同一分歧会换个方向再来（`total` 含归档而 `count` 不含）：`trajectory_list` 取自己的 `filters.includeArchived`，`/api/agents` 取与 `/api/sessions` 同一个 query 参数。

**验证**。6 条新测试，其中一条是不变量本身：对回复里每个名字，`count === countSessions({agent})`。修复前 6 条全红、7 条既有用例全绿（既有用例确实看不见这个缺陷——它们的 fixture 里没有归档会话）。变异加到 8 档全 RED，其中 F 档就是「把 `${population}` 从 WHERE 里删掉」，即缺陷的原始形状。fixture 因此要能造出 `archived` / `hidden` 会话：**一个每一行都在线的机器分不出「尊重这些条件的过滤」和「忽略这些条件的过滤」，因为它们在每一行上都相等。**

**教训**：总体是**被策略排除**的那些行，切片是调用方**自己收窄**的那些行。这两者共用一个谓词函数时，它们会一起漂。

### 8.22 两道截断，方向相反

上面几轮的判据都是「两个数对不上」。这一轮换一个更钝的问题：**每个已声明的参数真的被用到了吗**。29 个参数探针里报出两个 `INERT`，都是探针自己的问题（`maxBytes` 那次挑了一个输出只有几百字节的任务，于是任何上限都返回全文）——先证伪再往下走。

真缺陷是在追查「`maxBytes` 越大、回来的文本越少」时撞上的。**那不是错觉**：

```
maxBytes=131072  →  64000 字符，… [truncated 1383 chars]    文件末尾不在回复里
maxBytes=262144  →  64000 字符，… [truncated 70554 chars]   文件末尾不在回复里
maxBytes=16384   →   16412 字符，无截断                        文件末尾在回复里
```

真机 2,725,910 字节的任务日志，最后一行 `mutations=0  survived=0  notApplied=25  mapBad=21`。**要 262144 字节反而拿不到最后一行，要 16384 字节才拿得到。**

真因是**两道截断方向相反**：

- `readTaskOutput` 特意读**尾部**（`start = size - limit`）——因为「这个任务为什么失败」的答案在末尾；
- 出口脱敏按**字符**定上限（`maxLength: 64000`），而 `boundLength` 一律 `body.slice(0, maxLength)`，保留**头部**。

第二道把第一道悄悄撤销了。它以前不是完全不可见：末尾有 `… [truncated N chars]` 标记。但那个标记落在一段 64000 字符载荷的**最后一行**，而被扔掉的恰恰是读者要的那部分。

修法：给 `boundLength` 一个方向。`keep` 默认 `'head'`（标题、错误消息、命中片段都该留头），只有**确实读了尾部**的两个面说 `'tail'`：`trajectory_task_output`（MCP，`maxLength: 64000`）与 `/api/task-output`（面板，`maxLength: 262144`）。`keep` 在 `redactText` / `redactValue` / `redactPayload` 三条路上**全透传**——传了却被 `walk` 丢掉，就是我上一轮刚审出来的那类「被静默忽略的参数」。

**面板那条路由的余量只有 28 个字符**，因为它的字节上限（262144）和字符上限（262144）几乎相等，差的正是读时前置的 `… [tail of N bytes]\n`。我一度推断它「不可能触发」而准备把改动撤掉，**是测试把这个推断推翻了**：改掉断言后它确实触发，而且原先被丢掉的正是日志**最后 28 个字符**——也就是末行的尾巴。

6 条测试、修复前 4 条红（另 2 条守的是标记算术与幂等性，这两件事本来就是对的，不算证据）；6 档变异全红，含「`keep` 被接受却不被读取」这一档专门打**只看调用点**的审阅者。修复后每一档都以文件最新内容结尾。

**教训**：一道有界读取要先问**哪一端才是要的**。两层各自合理的截断叠在一起，可能精确地撤销对方。

### 8.23 「不能搜」被说成了「没有匹配」

`searchSessions` 有一行早退：

```js
if (!store.db || !store.hasFts || !query) return EMPTY;   // unsearchable: false
```

`EMPTY` 是 `{ sessions: [], total: 0, failed: false, unsearchable: false }`。而同一个文件在下面十几行处专门把**第三种状态**命名为 `unsearchable`，注释里写着这正是为了避免「塌成一个空列表」—— 然后**「整张索引表都不存在」这一档自己塌成了空列表**。索引表**存在但缺列**（第 141 行）返回 `unsearchable: true`，是对的；**表根本不存在**被当成良性态。

后果落在面板上。`wire.js` 为「查询产不出东西」准备了三块横幅，第一条注释写着「三种情况，读者的下一步各不相同」，判断依据正是 `searchUnsearchable` / `searchFailed` 两个标志位。两者都不为真时，它落到最后一条：

```
banner('没有匹配的会话。')
```

而**没有 FTS5 是本插件记录在案的一种真实配置**（compat-matrix 那行写着 22.13.0–22.18.x 与每个 23.x）。在那类运行库上，面板搜索框对**任何**查询都回答「没有匹配的会话」，而这台机器**根本不能搜**。

MCP 那一侧却是对的 —— `trajectory_search` 自己在 handler 里查 `hasFts`，发 `ftsAvailable: false` 加一条 note。**同一个 store、同一个问题，一边诚实一边编了一个结论**，成因还是那一条：**两处各判一次「能不能搜」**。

修法一行：`!store.db || !store.hasFts` 走 `{ ...EMPTY, unsearchable: true }`，`!query` 保持 `EMPTY`（没输入不是「不能搜」）。连带要修的是措辞：store 改成 `unsearchable` 之后，handler 的 note 分支按原来的顺序会先命中 `unsearchable`，于是把「索引不包含所需字段」说给一台**根本没有索引**的机器 —— **是我这次改动引入的措辞退化，被新测试当场逮住**。现在 `!store.hasFts` 先判，note 才是「这个 Node 运行库的 SQLite 没带 FTS5」。

测试三条，其中一条同时断言 store、MCP、面板三处。修复前新测试变红、既有用例全绿。变异四档：A 把无索引退回 `EMPTY`（缺陷本身）、B 把 schema 不匹配也退回（验证 `unsearchable` 没有整体失效）、**C 打 `http.mjs` 的转发而不是 MCP** —— store 说对了、客户端也没错，只有「让真相传出去」那两行可以错，而这两行错在哪里都看不出来。D 反向守住「空查询仍是普通空答案」，否则修 A 的顺手改法会让面板在第一次按键之前就宣称运行库坏了。

**教训**：一条降级路径被修好之后，**要检查它下游的每一层有没有各自也判了一次**。本例里 MCP 一直是对的，所以「改 store」这个动作看起来只会让 MCP 变好 —— 真正被暴露的是它把一个面板侧的缺陷顺手也修了，而面板侧原本没有任何测试覆盖这条分支。

### 8.24 把所有降级路径列全，逐条比两侧

§8.15 与 §8.23 的根因是同一条：**同一个事实在两处各判一次**。与其继续一处处撞，不如把「本插件无法完成」的降级路径枚举出来，对每条比 MCP 与面板给的是不是同一个答案。构造一台好机器，逐条施加降级，再对同一件事调工具与路由：

| 降级 | MCP | 面板 | 结论 |
|---|---|---|---|
| 无 SQLite | `ftsAvailable:false` + note | `searchUnsearchable:true` | 一致 |
| 无 FTS 表 | 同上 | 同上 | 一致 |
| FTS 表缺列 | note 说明 schema 不符 | `searchUnsearchable:true` | 一致 |
| 产物读不到 | `available:false` | `available:false` | 一致 |
| 无 assets 表 | `available:false` + note | （无此路由） | MCP 独有，已披露 |
| **无 background_tasks 表** | **无任何字段** | **无任何字段** | **两侧都沉默** |
| 会话未索引且无产物 | `source:"sqlite"` | `source:"sqlite"` | 两侧都沉默 |

**两条真缺陷，都出在「守卫」而不是「查询」上。**

`tasks.mjs` 的两处早退是 `if (!store.db || !tableExists(…)) return [];` / `return 0;`。而同一个文件对**另一种**失败方式是有告警的：`task_count_failed: … so total=0 means "not counted"`。模块自己的注释写着「一次失败的计数回答 0，是带数字的谎」—— 只对「查询抛异常」说了，对「表根本不存在」没说。

而 `test/silent-degradation.test.mjs` 的开头把这个文件建立在一份清单上：五个读取「**在查询抛异常时**」退回零。**守卫在 `prepare` 之前就返回，不是一次 throw** —— 于是这份专门盯这个病类的文件，整份清单里没有这一档。

第二层缺陷藏在第一层里面：`task_count_failed` **早就被记录了**，但 `trajectory_tasks` 的回复里**根本没有 `warnings` 键**（它是唯一没有这个键的列表工具）。模块以为自己在披露，接口把披露丢了 —— 所以那条告警**无法通过任何路径到达模型**。

修法三处：`Store` 构造器里按安装级能力各告警一次（与 `fts5_unavailable`、`search_columns_missing` 并列，不在守卫里告警，否则 count 与 list 各报一次会灌满上限 64 的环）；守卫读 `store.hasTasks` 标志；回复加 **`tasksAvailable`** 字段。

**为什么必须是字段而不是告警**：告警在**构造期**产生，而回复按「本次调用期间新增的」做范围化 —— 正确地把它排除了，于是模型仍然只看到 `total: 0`。这与 §8.16 的分诊同构：`available: false`、`ftsAvailable`、`unsearchable` 都是**能力字段**，`warnings` 是过程记录，两者不能互相顶替。

变异五档全部 RED，其中两档值得单说：**A 原本打在守卫上，存活** —— 把它关掉后查询照常抛出、走 `task_count_failed`，答案同样诚实，**这是等价变异**，验证后换成打回复上的能力字段（按纪律：等价变异换目标，不加夹具）。E 与 D 则暴露了我测试里的两个真空档：既没断言「本次的告警**确实出现**在回复里」，也没断言「早于本次的告警**不出现**」—— `trajectory_tasks` 是范围化惯用法的新使用者，此前没有任何东西为它钉这条。

**教训**：`silent-degradation` 这类文件最容易把自己**列出来的失效方式**当成全集。清单是按「查询抛异常」写的，于是「守卫提前返回」整类不在其中。**任何按机制枚举的清单，都要用另一种机制去打一遍。**

### 8.25 「零」不是「什么都没做」

§8.24 的表里最后一行已经点了名：**会话未索引且无产物 → 两侧都沉默**。那一轮修的是它上面一行。这一项是被真机数据逼出来的：

```sql
SELECT COUNT(*) FROM local_runtime_sessions s
WHERE NOT EXISTS (SELECT 1 FROM local_runtime_message_rows m WHERE m.session_id = s.session_id);
-- 18 / 633
```

**18 个会话有会话行、没有消息行**，磁盘 650 个产物目录里**一个都不对应**。年龄从 **160.6 小时到 3066.0 小时（7 到 128 天）**，9 个已归档 —— 所以这不是索引器滞后，是永久状态。其中 4 个是 `session_kind='task'` 且带 `parent_session_id`：**确实被派发过的子 Agent**；其余带实质标题（"Skill Sync Upgrade"、"A. WHEN 判据: 量化决策矩阵 + 反跑偏护栏"）且成对重复。

三个工具对它们全都说「什么都没做」：

```
trajectory_summary : turns=0 steps=0 toolCalls=0   warnings=[]   ← 没有抛 session_not_indexed
trajectory_turns   : source=sqlite total=0 turns=0
trajectory_get     : source=sqlite total=0 returned=0
```

**根因在 `stats.mjs` 的 `getStats`**：它只判会话行在不在，不判消息行数。

```js
if (!store.db || !session) return null;   // 只在「会话行不存在」时返回 null
```

于是 `computeStats` 对零行跑聚合，返回 `{turns: 0, steps: 0, toolCalls: 0}` —— 守卫永不触发。而 `mcp.mjs` 的 `trajectory_summary` 写着 `if (!stats) throw new Error('session_not_indexed:…')`，注释声称「null fold 就是一个尚未索引的会话」：**这个错误码实际只为「有产物、没会话行」而存在**，对它真正要描述的状态是死代码。§8.24 那张表把这一格标成「两侧都沉默」，标的正是它。

**修法**：判据与披露分开，且判据要三个事实而不是一个。

```js
export function recordsUnavailable({ sessionExists, projectionRows, artifact } = {}) {
  if (sessionExists !== true) return false;
  if (projectionRows !== 0) return false;
  return !hasArtifactEvidence(artifact);
}
```

三个条件各自有一种错法，缺一个就又变成一个新的谎：

- `sessionExists` —— `/api/events` 的 id 来自 query string，**从不先解析**。少了它，一个听都没听过的 id 会被报成「记录丢了」，第一个谎旁边立刻多第二个。
- `projectionRows` 必须**是计数**，不是某一页。轮次过滤后空掉的一页也是空页；`null`（计数查询失败）**不能折成 0**，否则一台没看成投影的机器会被报成一台看了、什么都没找到的机器。为此 `Store` 加了 `messageRowCount`，它与 `messageSignature` 分开：后者是缓存键，只需**变**，前者是被当作数字读的，`null` 是第三个答案。
- `artifact` —— 已找到并读完的产物**本身就是关于这个会话的证据**，哪怕一行都没解析出来。

判据放在 `jsonl.mjs`、紧挨 `hasArtifactEvidence`，理由与后者相同：HTTP 与 MCP 不能各判一次。

**修的过程中发现第二个、更隐蔽的矛盾**：`trajectory_summary` 不做产物回退（产物没有计时、没有 usage、没有工具调用行，折不出汇总）。于是「有会话行 + 有产物 + 零索引行」—— 也就是 `jsonl.mjs` 开篇写的那个**新会话**场景 —— `trajectory_summary` 报 `turns: 0`，而同一时刻 `trajectory_get` 在列出那条记录。**先问的那个工具，与后问的两个工具互相矛盾。** 所以 summary 另发一个对称字段 `recordsInArtifact`（两个字段互斥，测试里钉死）。不发 `source`，因为那个字段在这个工具上恒为 `'sqlite'`，不会变的东西不该占一个字段。

**为什么必须是字段**：同 §8.24 —— 这不是「本次调用失败」，是**关于某个会话的安装级事实**，`warnings` 会被「本次新增」的范围化正确排除。

五个面各发一次：`trajectory_summary`、`trajectory_turns`、`trajectory_get`、`trajectory_find`、`/api/events`，面板 `flow.js` 读成一条披露行（`state.js` 加字段，切换会话时清零 —— 与累积型的 `eventsMalformedLines` 不同，这是会话的属性而不是页的）。

**测试**：新增 `test/unavailable-records.test.mjs` 11 例 + `panel-flow` 3 例 + `skill-contract` 2 例。**修复前 5 红 / 6 绿** —— 红的正好是缺陷的那些面，绿的是「不许过度声称」的对照（索引正常、产物可读、搜索确实命中 / 确实没命中、未知 id、计数失败、判据自身），它们**本就该在修复前是绿的**。变异 14 档全红：A 去掉存在性守卫、B 把 `null` 折成零、C 无视产物、D 让 `messageRowCount` 把异常折成 0、E/F/G/H/I/M/N 逐个面停止披露（I/N 是「读失败」也算「没找到」，两个互相矛盾的发现同时出现）、J 路由停止披露、K/L 面板不读 / 不清。

### 8.26 我自己漏掉的那一个面

§8.25 修完四个面之后，我按自己的清单去数，发现 `trajectory_find` —— **第 11 个工具，也是唯一没被点名的一个** —— 仍然是原样。真机一验：

```
UNREADABLE  q="the"        -> {source:sqlite, total:0, returned:0, matches:0}
UNREADABLE  q="projection" -> {source:sqlite, total:0, returned:0, matches:0}
REAL        q="the"        -> {source:sqlite, total:22207, returned:5, matches:5}
```

**两个查询给出同一个 0，而 `the` 在真会话上是 22,207 条** —— 这个 `total` 根本不是查询的函数。搜索返回 0 是四个面里最容易被误读的一个：它读起来是对**内容**的判断（「这个词在这个会话里从没出现过」），而真相是**一条记录都没被看过**。

**为什么漏**：`DESIGN.md` §8.24 的降级表把「会话未索引且无产物」写成了一行**状态**，于是它在下一轮读起来像是一个**已知的类别**，而不是一个**要逐个工具清点的清单**。我照着「四个面」这个数去改，而那个数从来不是查出来的，是我在 §8.24 抄下来的。

**教训**：**面数要么查出来，要么别写。**

### 8.27 状态词不是答案

§8.26 的方法论是「面要查、不要抄」。这一项是**顺着它查出来的第二处**：既然会话行上还有别的字段，就把它们全看一遍。

`local_runtime_sessions` 上有 `status`、`error_code`、`error_message`。真机 43 个会话带错误信息：

```
status=error        ENOSPC: no space left on device, write
status=started      当前已达到 Token Plan 用量上限 … (2067)
status=interrupted  Local runtime restarted before this turn completed.
status=aborted      aborted
status=error        Mandatory V2 Agent prompt is missing: _v2/coding/SYSTEM.md.hbs.
status=error        BYOK provider custom_provider:alibaba-cloud-model-studio upstream error:
                      The value of the enable_thinking parameter is restricted to True.
```

`sessionSummary`（`sessions.mjs`）**八个字段全发**，`trajectory_list` / `trajectory_search` / `/api/sessions` 都带着 `errorMessage`。而 `stats.mjs` 的 `computeStats` 从**同一行**复制了七个字段，**丢掉了第八个** —— 于是「这次运行怎么了」这个问题的答案停在 `status: "error"`。

**状态词是最坏的形态**：它读起来就是一个答案。一个只说了「错了」的字段，比不说更糟，因为模型会拿它去回答用户。

而**最早失败的那批会话恰恰是最糟的一档**：它们只有一条消息行、`turns: 1`，`steps: 0`、`toolCalls: 0`。summary 报的是「跑了一轮、什么也没干」—— **这句是真的，也是零信息量**，因为整个故事就是那个错误消息。

**根因在夹具**：`tools/fixture.mjs` 的 `local_runtime_sessions` **没有 `error_message` 列**。也就是说，没有任何夹具能造出一个「失败的会话」，整条路径**零覆盖**。这与该文件里 `agent` helper 那段注释记载的是同一个错误 —— **夹具造不出的形态，就是没人走过的路径**。

修法两处：夹具加列与 `errorMessage` 参数；`computeStats` 按条件透传（只在有内容时出现，空串与 null 都不发）。`error_code` 存在但本插件没有一处读它，**故意不加进夹具** —— 造一个没有代码路径能到达的列，正是那个文件存在的意义所要避免的。

测试 5 例，修复前 **3 红 / 2 绿**（红的正好是「说了原因」「两个映射口径一致」「脱敏」，绿的两个是「没失败就不发」和「空串不发」）。变异 4 档全红：A 退回原样、B 无条件发布（每个健康会话都带一个空串）、C 存在性判断不再区分空串、D 映射层不再脱敏 —— D 特别值得说：它不是让 summary 与 list 对齐，而是让 summary 变成**list 从来没有过的出口**，因为失败会话的错误文本「routinely quotes the command that failed」，密钥就是这么进的错误串。

**教训**：**同一张行被映射两次，就要去比两次。**

### 8.28 把「承诺」和「能力」分开测

把 §8.27 的方法论再走一遍：拿真机的 `PRAGMA table_info` 去比夹具的 SCHEMA，看还有哪些列是夹具造不出来的。本插件读的四个表里，`local_runtime_message_rows`、`local_runtime_session_agent_definitions`、`local_runtime_session_assets` 全列齐备，`local_runtime_background_tasks` 只差一个 `delivered_at_ms`。**真正有洞的是夹具写 `''` 的那些地方**，因为它们根本不是「缺列」，而是「有列、永远空」。

`local_runtime_sessions_fts.purpose_terms` 就是这样一个。`sessionSummary` 的下一行有八个字段，`purpose` 不在其中，可它被 `SEARCHABLE_COLUMNS` 索引、被 `trajectory_search` 查询、被工具描述用最重的措辞承诺：

> a sub-agent's dispatch objective is indexed, **so a word from it matches a session whose title never mentions it**

真机 **439 / 633 个会话带 `purpose`** —— 三分之二，不是边角。而测它的只有一句 `SEARCHABLE_COLUMNS.includes('purpose_terms')`：**那是一个 JavaScript 数组的断言，不是索引的断言**。能力还在、名字还在打印，这正是能力悄悄消失时的样子。

夹具把 `purpose_terms` 写死成 `''`，所以**没有任何一个测试能造出一个「带可搜派发目标」的会话**。

改完之后测出来的结论要老实说：**能力是好的**，端到端 4 例全绿。这不是缺陷，是**零覆盖的承诺**。但它值不值得写变异？因为夹具是这条链上唯一断过的一环 —— 现在夹具的索引写入、交给它的分词器、以及查询从哪个常量拼出来，三处都有变异盯着，其中**只有最后一处是旧测试看得见的**。

顺手发现 `runtime` 列也缺，但**它只是被映射、没有任何代码读它**（`sessions.mjs:38` 之外零引用），所以按 §8.27 的规矩**故意不加** —— 造一个没有代码路径能到达的列，正是夹具存在的意义所要避免的。

**另一处**：`test/skill-contract.test.mjs` 里那条「Skill 与工具描述口径一致」的断言，提取方式是「Tools 段里**第一次出现**的 `trajectory_search`」。我给 `trajectory_summary` 写新散文时提到了「`trajectory_list` 与 `trajectory_search` 发布同一段文本」，于是正则抓住那句散文、截出 79 个字符，然后报「字段枚举里没有 purpose」。已改成按**编号条目** `
\d+\.\s+\`trajectory_search\`` 定位（2574 字符的真实条目）。

**教训**：**一段「读作 A、实为 B」的提取规则，会被下一句无关的散文改掉。**

### 8.29 stderr 说得对，不等于调用方听得见

唯一没审过的工具是 `trajectory_studio` —— 因为它是**唯一会起一个服务器**的那个，也是唯一一个参数里带着「一个具体地址」的那个。

先说查过没问题的部分：`LISTEN_ADDRESS = '127.0.0.1'` 是硬常量，全仓没有一处 `process.env` 能覆盖它（`config.mjs` 只读 home / data / redactRoots 三类），`server.listen(target, LISTEN_ADDRESS, …)` 每一处都显式传；外加 `isLoopbackPeer` 与 `Host` 头校验两道。**「只监听回环」是结构性成立的，不是注释里的一句承诺。**

缺陷在另一个参数上。`port` 由模型传入，`listenOnFreePort` 对被占用的端口不报错 —— 改用临时端口并正常返回。**这是对的**，而它上面那段注释恰恰写明了「换一个端口」为什么不够：

> Silently moving to another port hides the real problem: something else is already serving the requested one, so the old panel keeps answering and **the reader is looking at stale code**.

然后它只 `process.stderr.write`。**运维看得见，调用方看不见。** 真机实测：

```
请求 port = 54831
回复: {"port":54832, "reused":false, ..., "note":"Open the URL exactly as returned …"}
```

一个能用的 URL、一个不同的端口、**一句解释都没有**，而 `note` 里那条既有的能力提示是整条回复唯一的字符串 —— 那正是「照你说的做完了」的形状。读者若在浏览器里已经开着 54831 那个面板，**他没有办法把它和这个区分开**。

修法用的是本插件早就有的机制：`note` 的定义就是「**something in the call did not do what you asked**」。两种情形给两种措辞，因为它们不是同一件事：端口**被别人占着**（本次启动被挪走）与**面板已在运行**（复用，不替换 —— 替换会让调用方手里那条 URL 失效）。并且**追加而不是替换**：能力提示那句是「这个 URL 可以交出去」的唯一理由，拿它换一句端口提示不是任何人要的交易。

测试 4 例，修复前 **2 红 / 2 绿**（红的正是缺陷面）。变异 5 档：A 回复不再说、B 说了却不点名是哪个端口、C 复用被套用「被占用」的措辞、D 第二句把能力提示顶掉、E studio 谎称自己满足了请求。

**教训**：**`process.stderr.write` 是给运维的，`note` 是给调用方的。**

### 8.30 文档里那个数字，和它旁边那条命令对不上

跨版本实测（22.19.0 / 24.12.0，SQLite 3.50.4，FTS5 存在）跑完，两个版本的套件都是 639 例通过、0 失败。而本机按显式文件列表跑是 638 例。差 1。

差在哪：`test/panel-dom.mjs` 是**辅助模块**，一个 `test()` 都没有。Node 的**默认**测试 glob（`**/test/**/*.mjs`）把它也当成测试文件收进去，报告成一个通过的「测试」——它确实加载并运行了没报错，但那不是用例。而 README 记录的运行命令正是**裸 `node --test`**，旁边写的数字是 638。**命令与它自己旁边那个数字对不上。**

修法是**把命令写全**而不是去凑数字：

```
node --test test/*.test.mjs
```

理由有两条，第二条更重要：**Node 的默认 glob 是随版本变的行为**，把套件的文件集合押在它上面，本身就是一处跨版本隐患。显式列表同时让 README 的数字、`doc-test-counts` 门禁、以及三个 README 的引用对齐到同一组文件上。

顺带又撞上一次**同一类错误**（§8.26 面数抄的、§8.28 按首现提取、这次门禁把命令的**拼法**当成了它**声称的内容**）：`doc-test-counts` 的行匹配是 `` /`node --test`/ ``，带收尾反引号。我把那一行改成 `node --test test/*.test.mjs` 之后，门禁报「**DESIGN.md states the Plugin's own suite on 0 lines**」—— 文档没动过，也不可能是错的，它只是认不出新的拼法。已改成 `` /`node --test[^`]*`/ ``，并说明为什么这个尾缀才是重点。门禁本来就要求**恰好命中一行**且该行**必须带计数**，所以放宽是安全的：`DESIGN.md` 里那句提到 `node --test` 的散文没有计数，命中不了。

**教训**：**改了被键控对象的拼法，要改键控者的本意，不要改文档去迁就键控者。**

### 8.31 算出来了，然后扔在最后一步

`trajectory_turns` 的 SQL 里写着 `MIN(created_at_ms) AS first_ms` —— 它**是那一行 `ORDER BY` 的依据** —— 而映射成返回对象时被丢掉了。于是轮次行是 `{turnId, count, llmMs, outputTokens, failureCount}`。

模型能看出第 40 轮在第 39 轮之后，**说不出它们是什么时候**。要给一轮定时间，只能翻 `trajectory_get` 直到某条记录带上时间戳；在两万条记录的会话上，那就是**把整个会话翻一遍**。

这一项与 §8.27 同构：**数据算出来了，在最后一步被扔掉**。区别是 §8.27 扔掉的是一行上的第八个字段，这个扔掉的是**一个聚合**。

补上之后，它立刻暴露了**第二个、更老的分歧**：

| 来源 | 轮次顺序 |
|---|---|
| 投影 | `ORDER BY first_ms ASC` —— 永远按时间 |
| 产物 | **文件顺序** |

而这不是假设。全机 **613 个产物文件里有 21 个**的时间戳是倒退的（一处 `1786968363541 → 1786968361812`，约 1.7 秒）。所以**同一个会话从投影读和从产物读，轮次顺序不同**，而模块自己写着的不变式是「调用方无法从记录本身分辨走了哪条路」。修法是让产物侧也按 `firstMs` 排，无时间的轮次保留文件顺序、排在最后（不能定位的东西不能被当成「很早」，也不能当成 epoch）。

**这一分歧此前完全不可见，因为没有任何字段说明这些行是什么顺序。**

**夹具也写错了形状。** 写产物夹具时我把 `timestamp` 放在**顶层**，而真机 613 个文件**全部**把它放在 `message` 里面。代码读 `record.message.timestamp` 是对的，**夹具错**。全仓三个文件这么写（含一个本轮之前就有的），已改。

**教训一**：**两个实现之间的分歧，如果没有任何字段能暴露它，就等于不存在** —— 所以「把某个值发出来」本身就是修复手段，不只是加信息。

**教训二**：**夹具写出运行时从不产生的形状，比没有夹具更糟**

### 8.32 五个读记录的面，四个有回退

把 §8.31 的模式系统性地扫了一遍（把每个 SQL 别名和它的映射对着看），`getTimeline` 的别名全都映射了 —— 但**另一处不对称**露出来：

| 面 | 投影无行时回退到 `messages.jsonl`？ |
|---|---|
| `trajectory_get` | 是 |
| `trajectory_turns` | 是 |
| `trajectory_find` | 是 |
| `trajectory_summary` | 否（它折不出汇总，改为另发字段） |
| **`/api/timeline`** | **否** |

构造一个「有会话行、有产物、零索引行」的会话，实测：

```
trajectory_get    : {"source":"jsonl","returned":3,"total":null}
trajectory_turns  : {"source":"jsonl","total":1}
/api/timeline     : {"points":0,"truncated":false,"firstAt":null}
```

**`truncated: false` 是本插件能做出的「这个列表是完整的」的最强断言。** 于是面板给读者看了同一会话的记录（3 条）和轮次（1 轮），而轴线说：没有定时活动，而且没有更多。回复里没有任何东西能把它和一个真的空闲的会话区分开。

修法与另外四处同一个键（`sessionRows === 0`）。但**轴线的回退会画出「只有输入标记、没有模型条」**，因为产物没有记录时长 —— 而那正是「模型从未回答」的图。所以回退还必须配披露：回复带上 `source`，面板加一行说明。

`sessionRows` 用的是 `store.messageRowCount(sessionId)` 而不是 `rows.length`：折叠在 6000 处截断，**投递长度是下界**，把它当作「这个会话有多少行」是一个等着别人踩的坑。

**顺带又踩了一次自己刚记下的坑**：探针夹具我又把 `timestamp` 写在顶层 —— 真机会说「时间全是 null」，而这次是对的。§8.31 的教训是**当场就用**：第二次犯的代价是一次探针。

变异 7 档：A 不回退、B 回退但不说是从哪来的、C 回退只读一页却声称轴线完整、C2 回退点丢掉文件里记录的时刻、D 给一个从没记录过时长的记录编一个时长（画成比例尺上的测量，而它测的是零）、E 面板不说、F 面板不清。

其中 **C 第一版存活**：原打算打 `messageRowCount` → `rows.length`，但唯一的消费者问的是 `=== 0`，折叠又在 6000 处停 —— 两者对**读这个字段的所有代码**行为完全相同。按纪律**换目标而不是造一个 6001 行的夹具**（那样要花一个大测试去证明一个没人会误读的字段）。

**教训**：**等价的变异只有一个：**

### 8.33 两条路由在描述同一个会话，只有其中一条说话

修完 §8.32，我没有停在这条轴线上，而是**拿真机 + 真 HTTP 栈**把面板的四条路由跑了一遍（不是单元夹具）。结果：

```
UNREADABLE  /api/overview stats : turns:0 steps:0 toolCalls:0 events:0   ← 无标志
            /api/events         : recordsUnavailable: true
            /api/timeline       : points:0 truncated:false

REAL        /api/overview stats : turns:453 steps:22409 … errorMessage:"…Token Plan 用量上限…"
            /api/timeline       : points:6000 truncated:true
```

顺带确认了 §8.27 的 `errorMessage` **确实透到了面板**（那台机器的配额错误整条出来了），以及 `/api/timeline` 的 6000 上限带 `truncated: true`，两处都对。

而第一条是新的一处不对称：`/api/events` 与 `/api/overview` 都发布由**同一批消息行**推出的形状，事件那条带 `recordsUnavailable`，overview 内嵌的 `stats` 不带。面板之所以看到的是对的，**只因为它恰好两条都调** —— 单读任何一条的读者看到的不是。而 overview 恰恰是**头部那几个总数**的来源。

修法是同一个判据（`recordsUnavailable`，同一个 `messageRowCount`，探产物用同一个 `readJsonlTurnSummaries`）。`overview()` 因此变成 async —— 它之前是同步的，**这正是它没法披露的原因**：探产物要 I/O。

面板侧两处：把标志也挂到 stats 的解析上，以及 —— **这是我改动里自己踩的顺序坑** —— 我先把 reset 放在 `loadEvents` 里，结果它把 overview handler 刚设好的标志又抹掉了，而 `loadEvents` 是会话内翻页都会走的路径。正确的模式是旁边那行 `unreadableRows`：**只在切换会话时清零**，页面到达时 OR 上。新的那条面板测试（记录页为空、totals 带标志）当场把这个顺序问题打了出来。

**变异两档存活，都是同一类**：
- C 打 `projectionRows` 本身**存活** —— 唯一消费者问 `=== 0`，把非零折成 `null`（=计数失败）与折成原值**对所有读它的代码行为相同**。换目标：改成打「忽略产物证据」。
- D 的面板那档第一版也存活过 —— 补的测试原本走的是正常路径，标志从事件页就来了。改成让事件页**什么都不带**，只靠 totals。

**教训**：**当一个值有两个来源时，先问清它该在哪里被清零。** 「每次加载前清零」对累积量是对的，对**两条路径都会提供**的判据是错的 —— 它会在后到的那条路径上被抹掉，而那条路径恰好是最容易失败的那条。「两个分支对**所有读它的代码**都不可区分」。判据要落在消费者上，不是字段本身。

**面板那个 F 档也第一版存活**，因为切到下一个会话时新请求会覆盖这个字段 —— 测试等 B 加载完，就分不出「重置」与「覆盖」。把它改成用 `deferred` 把 B 的响应**扣住**，看切换与应答之间的那个窗口 —— **那才是读者真正看得见的窗口**。 —— 它看起来像覆盖，而且刚才让我短暂地怀疑起产品 bug（真机一读才发现是夹具错）。

**变异里也撞到一次等价变异**：原本打 `?? null` → `?? 0`，**存活**。因为 `created_at_ms` 是 `NOT NULL`，`MIN()` 永远不会返回 null，两个分支行为相同。按纪律**换目标而不是加夹具**（要造出 null 就得让夹具违背 schema），改成打「取第一条记录的时刻还是最后一条」。 这已经是这一轮第三次出现「选择/匹配规则读作 A、实为 B」：§8.26 面数是抄的、§8.28 提取按首现、这里门禁认的是拼法。**凡是「按某个字符串选中某一行/某一条/某个工具」的规则，都要问一遍：它选中的是我说的那个东西，还是只是长得像。** 模块的注释把理由写对了、代码只做了一半，而**注释不会因为只做了一半而变红**。凡是模块自己写下「静默做 X 会掩盖问题」的地方，就该问一句：**这个问题被说给谁听了。** `first occurrence` 读起来像「那个条目」，实际含义是「这个词第一次出现在哪」；两条差一个数量级，失败时却报成完全不相干的消息（字段枚举缺失）。凡是靠位置或靠首现做选择的测试，选择条件本身要能被单独验证 —— 判据：**这条测试在它声称检查的东西不存在时，会不会读到别的东西而不是失败。** 这次是因为按 §8.26 去查「谁读了消息行」才顺带看见「谁读了会话行」；而如果没有真机那 43 个错误消息撑着，这个差异在代码里只是「七个字段 vs 八个字段」，看起来像一条无害的取舍。 「四个面」和「五个面」之间隔着一次 `grep -n "name: 'trajectory_" server/mcp.mjs`。写下一个覆盖面数字之前，先确认哪些工具真的读了消息行 —— 本插件里 `trajectory_assets`/`trajectory_agent`/`trajectory_tasks` 各读各的表，`trajectory_search` 搜的是会话行而不是记录行，只有四个（现在是五个）真的碰 `local_runtime_message_rows`。

顺带发现：**M 档变异存活** —— 我把锚点写成了一段注释并只改注释，于是那一档什么都没测。这与早前一轮把两档改成「只动注释」是同一个错。**一档变异如果改完之后被测代码的行为不变，它就不是变异，是装饰。** 判据：改完之后先 `grep` 确认锚点那一段的行为真的变了，再跑。

**教训**：`session_not_indexed` 这个错误码**早就为这个状态写好了**，模块的注释也早就描述对了它的含义，只是判据从来没走到那里。**一个从未触发过的错误码不是文档，是一句注释。** 找到它比找到缺陷更快。

### 8.34 问错了问题的检查，连着三次都是同一个答案

`tools/browser-check.mjs` 用真 Chrome 走一遍面板，最后一步是点开一个后台工具调用捕获的输出。这条断言连挂三次，报告长这样：

```
FAIL  a background tool call offers its captured output — offered by no row among 69 tool rows
```

同一份输出里，**它自己刚说过**：`27 of 181 calls on its first page carry captured output`。两个数字都是它自己算的，都不是编的。**一个自己算出的数字推翻自己刚做出的结论，这条线索比失败消息本身更早一步指向根因。**

差在「first page」是哪一个的 first page。检查用 store 取一页记录（200 条）来选会话，然后驱动页面去点；而面板首屏只渲染 `STREAM_PAGE` = 150 条**流式行** —— 一条记录占一行，它的每个工具调用**再各占一行**。200 条记录带着 181 个调用，打包成 381 行，第一个带捕获输出的调用落在**第 327 行**。首屏 150 行里它一行都不在，于是页面渲染出 69 个工具行、没有一个带按钮。真机上量出来是这样：

```
同步本地与远程分支代码   200 记录  181 调用  17 可用  →  首个可用行 327  ✗ 首屏看不到
Upgrade skill-sync      200 记录  179 调用 123 可用  →  首个可用行   4  ✓
```

**教训一：问 A 再看 B，B 上什么都没有的时候，先确认 A 和 B 是同一个问题。** 这一条检查的注释已经写过一次教训（「问『哪个会话拥有最多后台任务』和问『哪个会话**显示**了一个』是两个问题」），修法是「向 store 问面板的数据路径，而不是在这里重实现」。方向对，**但问的单位还是错的**：它把 store 的整页当成了屏幕。**换成另一个数据源，不等于换对了问题。**

修法不是把 150 这个数在检查里再写一遍，而是**让它只有一份**：`web/js/rows.js` 导出 `packStreamRows` / `firstRenderBatch` / `offeredCalls` / `firstScreenOffersOutput`，面板的 `loadEvents` 和检查的候选筛选**都从它取**。这是这里唯一站得住的形状 —— 复制一份的数字今天对，明天就会各自漂移，而这正是本节开头那个失败的全部成因。

**教训二：剩下的接缝要单独钉住，不能只测算术。** 打包本身没有常量（记录就是行、调用各占一行），所以把 `loadEvents` 换回自己内联 push 是**等价变异**，行为完全一样，按纪律**换目标而不是加夹具**。真正的接缝在渲染器那边：`firstRenderBatch` 是 `appendStreamRows` 的复述，没有任何东西保证两者不漂。于是补了一条**真数 DOM 行**的测试（用面板自己的 DOM 桩驱动真的 `stream.js`），它同时也是 G 档变异（把渲染批次改成 `STREAM_PAGE * 4`）唯一的杀手 —— 那一档骗过了所有「页面正常渲染、点两下仍有按钮」的检查，只有**数渲染出来的行**能看见它。

**教训三：锚点失效的变异不是弱变异，是静默变异。** 同一轮扫描里 `mutate-unavailable-records.sh` 的 L 档报 `ANCHOR MISSING`。原因是 §8.33 把面板清零那行从 `loadEvents` 的 reset 挪到了 overview handler（那里用 `payload.stats` 赋值而不是 OR），L 档锚的正是被删掉的那两行。**它报的是「锚点缺失」，不是「存活」** —— 这个区别救了这轮：脚本把这种情况记成 `fail=1` 而不是悄悄跳过。但**上一次有人跑它是什么时候，无从判断**：一个不再产出证据的档位，看起来和一个产出红证据的档位在清单里长得一模一样。**清单要区分「这档没找到自己的对象」和「这档报告了红」**。现在 L 档改瞄 `state.eventsRecordsUnavailable = payload.stats?.recordsUnavailable === true;`，14/14 全红。

本节合计 15 条测试 + 7 档变异。真浏览器一次跑通，并且它选会话的那一行现在把两个数都打出来了：

```
Upgrade skill-sync — 41 of 179 calls on its first screen carry captured output (123 within the fetched page)
```

41 与 123 的差**就是原来那个坑的宽度**，现在它常驻在输出里而不是只活在一次失败里。

### 8.35 MCP 接口够不够用：先把「哪张表没人读」量出来

这一轮的问题是「11 个工具够不够、易用性上要不要拓展」。这个问法容易答成猜想，所以改成可证伪的两步：**先把 11 个工具的真实契约拉出来**（`tools/list` 自己，不是文档），**再把真机每张非空表的行数列出来，与插件读过的表对照**。

第一步的结果是确认了一件好事：`local_runtime_sessions_fts` 是全库**唯一**的 FTS，索引的只有会话元数据（`session_id_terms`/`title_terms`/`workspace_dir_terms`/`purpose_terms`/`status_terms`/`session_type_terms`），**没有任何消息正文的索引**。所以 `trajectory_find` 把范围限定在单个会话不是取舍，是**被迫的** —— 全机正文检索在这台机器上没有可用的执行计划。

第二步列出了差距。非空表按行数排，头几名是：

```
350905  local_runtime_background_task_events      ← 无人读
114185  local_runtime_message_rows                ← 已读
109887  local_runtime_token_usage                 ← 无人读
 58190  local_runtime_background_tasks            ← 已读
 24321  local_runtime_turn_diff_journal           ← 无人读
   1404  local_runtime_turn_diffs                 ← 无人读（最大缺口）
    633  local_runtime_sessions                   ← 已读
```

插件一共只读过 6 张表。`local_runtime_turn_diffs` 是最要紧的一张：**1,404 个 change set，横跨 633 个会话中的 351 个（55%），8,431 个文件条目，1,234 个可撤销，带完整 unified diff**。而

```
$ grep -rn "turn_diff\|file_changes\|undoable" server/ web/ skills/
（无输出）
```

一个词都没有。问「这个会话到底改了我的什么」，插件给出的答案是翻 `trajectory_get` —— 而那是**Agent 声称自己做了什么**，不是**实际落盘了什么**。对一个写代码的会话轨迹工具，这正是它存在的理由，而它在数据库里躺着一列。

新工具 `trajectory_changes`（第 5 个工具位，紧邻同为「产物」的 `trajectory_assets`）。设计里有三处是**先量了真机再定**的，不是拍脑袋：

1. **路径有两种形态。** 工作区内的文件**存相对路径**，工作区外的存绝对路径。真机实测：3,299 条相对路径**全部**落在自己的 `workspace_dir` 内，5,132 条绝对路径**全部**在外。所以相对路径在这里按该轮自己的 `workspace_dir` 解析，**永远输出绝对路径**。交给模型一条 `src/app.js`，等于让它自己猜是哪个 checkout。
2. **scratch 占多数，而且不能过滤掉。** 8,431 个条目里 4,883 个（58%）在 `/tmp` 或 macOS 的 `/var/folders` —— 是这些会话在动仓库之前生成的 apply 脚本与 brief。过滤掉等于篡改发生过的事，所以选择是**报出来**：每轮和每页都给 `scratchFiles`，让读者能把「82 个文件的一轮」和「其中 5 个是真正的仓库改动」分开。
3. **`status` 与 `revertedAtMs` 没有信号。** 1,404 行的 `status` 全是 `active`，`reverted_at_ms` 全是 NULL。照录（运行时若记录了回滚就该回答），但**不当作发现**呈现 —— 读者看到一千多行同一个值，什么也没学到。

**夹具抓到了一个设计弱点，不是我想到了的。** `FIXTURE_WORKSPACE` 在 `/tmp` 下，于是「按临时目录前缀判 scratch」把仓库文件全判成了 scratch，`scratchFiles` 全线失真。改成**在工作区之外**且**在临时目录里**才算 scratch，并补了一条专门钉住它的测试。真机上两种定义结果一致（绝对路径全在 workspace 外），所以量数据看不出来 —— **量数据只能证明它没坏，证明不了它是对的**。CI 沙箱、容器工作区、任何 `TMPDIR` 下的检出都会踩到第一版。

**又撞了一次「上限比它上面的上限还松」。** 每文件 diff 上限我先写 32 KiB，而 MCP 出口的每字符串上限是 20,000 字符。实测：`diffBytes` 报 32768，实际发出去 20026 字符 —— 上限**从未生效**，是 redaction 先切的，而那个标志是按切之前的文本算的，**报了一个调用方根本没收到的字节数**。这是本会话第 N 次「算出来的数字对不上旁边那条命令」，只不过这次两个上限都在自己手里。修法两条：上限降到 16 KiB（留在出口限制之下），以及**删掉 `diffBytes`** —— redaction 会重写这些字符串，任何在它之前量的长度都在描述一份收不到的文本。`diffTruncated` 这一个诚实的标志，胜过另一个看着精确、实际不可能对的数字。顺带把出口上限从 `mcp.mjs` 里的字面量提成 `EGRESS_MAX_LENGTH_MCP`，否则这两个上限之间的关系**没法被任何测试检查**。

**写完之后，把新工具在真机上整个跑了一遍 —— 结果不是零缺陷，是一处口径错误。**

夹具只能表达我想到的形状，所以新工具一落地就该拿真数据扫：探针先自证真的够到了行
（`1406 change sets / 351 sessions`），再对每个会话按调用者该有的方式**翻完所有页**，累计
**1,406 轮 / 8,457 个文件条目**。查了 15 类异常：会话行缺失、未索引、空轮、`file` 为 null、
status 越界、`workspace_dir` 为空、相对路径逃出工作区、绝对路径落在工作区内、同轮重复路径、
负数行数、分页游标提前变 null、交付轮数与 `total` 不符…… **全部为零**，一个都没有。

但正因为扫到了，才去核对那两个聚合数字的**口径** —— 一核对就发现描述和实现说的不是一件事：

```
这一页实际：7 个文件，其中 2 个 scratch
回复里写的：matchedFiles 3048   scratchFiles 2212      ← 全会话
工具描述写的："How many files the page covers"          ← 这一页
```

327 个 turn 的会话里，1 页装着 7 个文件，回复报 3,048。按描述去算比例的读者会得到 73%，而这一页实际是 29%。**两个数字都是真的，错的只是口径，而且页面上没有任何东西与一个全会话的数矛盾。** 这比缺字段更糟。

修法不是改数字，是**把口径写进名字**：`scratchFiles` → `matchedScratchFiles`（与 `matchedFiles` 对齐，都带 `matched` 这个前缀），描述改成明写「session-wide, not page-scoped」，SKILL 两处同步。轮级那个 `scratchFiles` 本来就是页内口径、名字也不用改 —— **同名不同口径是最容易骗过人的一种**，所以保留的那个也补了对照。

**原来的测试为什么会放过去**：它断言 `reply.scratchFiles === 3` 而当时只取了一页 —— **测试把错误语义原样编码进去了**，所以它是绿的。测试能锁住一个数，锁不住它指什么。新的断言把两个口径并排放（`assert.notEqual(page.matchedFiles, page.turns[0].fileCount)`），并要求聚合值**不随页移动**。新增变异 J 档：把会话级改成页级，测试必须红。

**教训**：**字段的「口径」是契约的一部分，和类型一样要钉。** 名字与描述不一致时，读者只能选一个信 —— 而页内数据永远看起来合理，因为它们确实在页上。**扫真数据证明的是「没坏」，口径这种契约错误只有在有人把两句话对着读的时候才会露出来。**

**写完当晚自查跨平台时，发现自己刚写的代码里就有一处平台硬编码。**

`grep -rn "'/tmp\|/var/folders" server/*.mjs` 在整个 server 里只命中一行 —— `changes.mjs` 的
scratch 判据，两个 POSIX 字面量。**在 Windows 上，`os.tmpdir()` 是
用户目录下的 `AppData\Local\Temp`（Windows 的 `os.tmpdir()`），两个前缀一个都不匹配**，于是每一个 scratch 文件
都被报成仓库改动，一个纯脚本轮次给出 `scratchFiles: 0`。而这个字段存在的全部意义就是
「别把 82 个文件的一轮当成 82 次仓库修改」，它归零时页面上没有任何东西自相矛盾 —— 只会安静
地给出与事实相反的答案。

修法是 `os.tmpdir()` 为准，外加两个 POSIX 根保留（真机上那些会话确实写在那里，且 macOS 的
`tmpdir()` 只指向**当前用户**的目录，与共享 `/tmp` 不是一回事）。盘符根比大小写不敏感，
因为 Windows 在卷以下就是如此。两条变异钉住它：去掉 `tmpdir()` 那条分支（回到 POSIX 字面量）、
去掉盘符的大小写不敏感。测试把 Windows 路径当**数据**传进去跑在 macOS 上 —— 这是
`path-folding.test.mjs` 已经在用的办法：**没有办法让 macOS 进程看到一个 Windows 临时目录，
诚实的做法是拿外部的根去测那个谓词，而不是假装宿主变了。**

**教训**：**「这台机器上跑过了」不等于「跨平台没问题」，尤其对一条只在本平台存在的路径。**
判据：**任何涉及「某台机器的某个约定位置」的判据，先问它在另外两个平台上叫什么。** 而
`grep` 一个平台字面量在**自己写的代码**里，比在别人写的代码里更该先做一遍 —— 这一行是两小时前
我自己加的。

**同一轮里还查出第二处，而它在测试里，不在实现里。**

CI 的矩阵是 `ubuntu / macos / windows` 三平台（`.github/workflows/mcode-trajectory-studio.yml`），
所以自查时顺带看了自己新写的断言能不能在三个平台都说同一件事。答案是不能：

```
assert.ok(FIXTURE_WORKSPACE.startsWith('/tmp/'))   ← 三个平台全绿
```

`FIXTURE_WORKSPACE` 是字面量 `/tmp/...`，Node 按当前盘符解析：

| 平台 | 解析后 | 在 `os.tmpdir()` 下？ |
|---|---|---|
| Linux | `/tmp/trajectory-fixture-home/ws` | 是 |
| **macOS** | `/tmp/...` | **否**（macOS 的 tmpdir 是 `/var/folders/...`） |
| **Windows** | `C:\tmp\...` | **否**（`AppData\Local\Temp`） |

**在两个平台上，这条断言是因为一个不成立的理由而绿的**，而它上方的注释宣称了一个它并没有在验
的性质。我中途还写过一个 `if (workspaceIsInTempDir)` 分支，诊断输出（`t.diagnostic`）直接显示
它是**死分支** —— 三个平台都不会进。

修法不是把断言写得更聪明，而是**让夹具能表达这个形状**：新增一条测试把 `workspace_dir` 显式建在
`os.tmpdir()` 之下（CI 沙箱、容器工作区、`TMPDIR` 下的检出），并在断言之前**先断言前提** ——
不带 workspace 时那个路径确实被判为 scratch。前提不成立就直接红，而不是安静地退化成恒真式。

**教训**：**一条测试在三个 CI 平台全绿，仍可能是错的。** 当断言的理由依赖一个平台事实时，
「通过」与「被验证」是两件事。这已经是本轮第三次同一类：browser-check 问 A 却在 B 上找、
`detail-level` 按编号切片后 `indexOf` 返回 -1、这里前提为假却仍然通过 —— **选择规则与前提规则
本身必须能被单独验证，否则它们就是一条不说的规则。**

**新工具落地当晚，第一个想到的「Skill 调用坑」就是它和 `trajectory_assets` 会不会被混 —— 量出来是会，而且混了就是错的。**

```
351 个有 change set 的会话
  └─ 329 个（94%）assets 为 0
两者都有的 22 个里，19 个数字不同，而且是双向不同：
    71 个改动 / 112 个交付      84 个改动 / 8 个交付
```

而 `trajectory_summary` 只报 `assets`、不报改动，于是模型读完 summary 看到 `assets: 0`，最自然的
结论是「什么也没产出」—— 对 94% 的会话是错的，其中一个实际改了 84 个文件。**这是用一个正确
工具给出的自信的错误答案**，正是这份文档一开头要杜绝的那种。

修法是让两个事实**并排**出现在 summary 里：`changedTurns` + `changesAvailable`。不报文件数，是量过
才决定的：

| 算法 | 最坏会话（328 个 change set） |
|---|---|
| `COUNT(*)` | **0.03 ms** |
| `SUM(json_array_length(...))` | **206 ms** |
| 进程内解析同一批 JSON | **965 ms** |

summary 是 Skill 让读者**先调**的那个工具，文件数 `trajectory_changes` 已经以 `matchedFiles` 给出。
只放便宜的轮数，并补了一条**先剥注释再扫源码**的断言 —— 第一版它扫到了我自己解释「为什么不用它」
的那段说明。

**加完字段才发现我自己的新字段带进了一个缓存缺陷。** `getStats` 的缓存键是
`sessionId|messageSignature`，而 **change set 是在它自己那一轮的消息行之后才落盘的**：

```
351 个会话 → 320 个（91%）的最后一条 change set 晚于最后一条消息行
滞后：中位 422 ms，最大 135 秒
```

「刚跑完、现在问它做了什么」这个最常见的时刻，恰恰是一份几百毫秒前算好的 summary 在说
`changedTurns: 0`，而且**会一直这么说下去**。加 `changeSignature` 进缓存键修掉。**教训**：一个值
如果进了缓存，**缓存键必须包含它所依赖的全部事实** —— 原来那个键是正确的，直到我给它加了第二个
来源。

写这个测试时又踩两次自己的坑，都记在这里：① 在**活着的** store 底下 DROP 表，被缓存正确地挡住，
我却以为能力探测坏了 —— 探针要问 store，就得让 store 重新读；② 想往 store 写数据，才想起它**按
设计以只读打开** —— 正确的写法是另开一个可写连接，正好也更忠实（运行时写、插件读）。

**最后是 `portable-paths` 门禁抓到了我**：为了跨平台，我在测试里写了完整的 Windows 临时目录字面量，
又在注释和本文里写了一遍，三处都命中它的「Windows 家目录」禁例。**门禁是对的** —— 它禁止的正是
「把某台机器的家目录写死成答案」，而我为了测外平台形状确实写了这个形状。两处文档改写（含义不
丢），测试文件按**精确文件名**进 `EXEMPT`（按模式放宽就会让下一个真硬编码溜过去）。并且验证了
豁免没开洞：临时造一个新文件塞进 `test/`，门禁照样报红。
**为跨平台写的字面量，会撞上为跨机器写的门禁** —— 这两条规则不矛盾，但动外平台路径前要知道有这么
一道门在等。

**同一个陷阱在面板上是另一种形状，而我只拆了一半。**

MCP 侧把 `assets` 与 `changedTurns` 并排之后，面板这一侧得回答同一个问题。查的结果是两件事同时成立：

- 面板统计栏有 **14 张卡，`assets` 根本没有出现** —— 所以我担心的那个误读在人这一侧**不存在**；
- 但**反过来也成立**：人打开面板问「这个会话动过我的文件吗」，**一个文件相关的数字都没有**。面板答了十四个会话总数，唯独不答这个。

补第 15 张卡「改动轮次」，读同一个字段 —— 两个面回答同一个问题，不能给出不同答案。

**写的时候又踩了「沉默不是零」，而且是我自己先犯的：**

```js
if (stats.changesAvailable !== false)   // ← 缺失被翻译成了「可用」
```

测试当场把它打出来：`changesAvailable` **缺失**时卡片显示 `0`。而缺失意味着**这个数没有来源**，
显示 0 是一个无法支撑的断言。收紧成只有显式 `true` 才算数：

| 服务端给的东西 | 卡片显示 |
|---|---|
| `changesAvailable: true, changedTurns: 0` | `0`（数过了，确实是零） |
| `changesAvailable: false` | `未记录`（灰态，同 TTFT 那一行） |
| **字段完全缺失** | `未记录`（沉默不是零） |

后两行渲染成同一个字是**有意的** —— 两者都撑不起一个数字；但**计数的零和没计数的零绝不能看起来
一样**，所以留了一条对照断言。

**教训**：**`a !== false` 看起来是在处理「未知」，实际是在把「未知」翻译成「可用」。** 唯一能显示
数字的许可，是服务端明确说了「我数过」。这是本文第三次同一类形状（`recordsUnavailable`、
`changesAvailable`、面板的 `is-na`）—— 形状各不相同，但「**沉默必须原样传递**」这条规则只有一处，
每多一个面就多一次把它翻译掉的机会。

**补完面板之后，差一点重演 §8.33 —— 而形状完全一样。**

面板那三条测试用的是**夹具 payload**：它们证明「面板会**读** `changedTurns`」，**不**证明
「`/api/overview` 会**发** `changedTurns`」。这就是 §8.33 当年的形状 —— 两条路由描述同一个会话，
其中一条沉默，而所有夹具级测试都是绿的，因为夹具把字段喂进去了。

先用真 HTTP 栈量了一次，**没有重演**：

```
有 change set：  changedTurns 4, changesAvailable true
无该表：        changedTurns 0, changesAvailable false   ← 不是沉默的 0
```

但探针只该活一次，所以补进已有的请求级夹具（`overview-disclosure.test.mjs` —— 那个文件的存在
理由正是「两条路由只有一条说话」），两条断言各自验证过「回退必须变红」：路由不再发布该字段、
路由在缺表时声称 `available`。

**教训**：**夹具级测试证明的是「消费方会读」，不是「生产方会发」。** 一个字段被画出来却没有
路由发布它，是 §8.33 那个缺陷往上挪了**一层**，而对每一层夹具级测试都是绿的。判据：**任何新增
字段都要有一条穿过真实边界的断言** —— 走真的 `createRequestHandler` 或真 HTTP，不是夹具 payload。

**剩下三张没人读的表，也量了，也**没有**加。** 列在这里是因为「没做」也是结论，下一个人不必重新推一遍：

| 表 | 行数 | 量出来的样子 | 不做的理由 |
|---|---|---|---|
| `local_runtime_background_task_events` | 350,905 | `output_updated` 占 176,182，但**平均每个任务只有 3.03 次**心跳，最多 1,853；跑最久的几个任务只有 0–1 次 | 确实带新信息（`lastOutputOffset` 能回答「它卡住了吗」，现在 `trajectory_tasks` 只有 status 与时长），但密度太低，排进候选而不是当成缺陷 |
| `local_runtime_token_usage` | 109,887 | **`reasoning_tokens` 全库求和 = 0** | 读它等于加一列永远为 0 的字段。§8.27 已经为此定过规矩：造不可达的列是反模式 |
| `local_runtime_turn_diff_journal` | 24,321 | `tool` 行 22,057 / `turn` 行 2,319，带 `before_json`/`after_json` | 是**二阶细化** —— 能把「哪个文件」归因到「哪次工具调用」。而工具调用本来就在 transcript 里，`trajectory_changes` 已经把文件和 diff 给全了。归因是有用的一步，但它不回答任何当前答不出的问题 |

**变异脚本自己抓到三件事，其中一件是「存活 = 覆盖有洞」：**
- A 档锚点在 `mcp.mjs` 里匹配到 2 处（两个工具的回复形状相同）→ 报「锚点缺失」而不是给假证据。这类失败模式脚本已经把它记成 `fail=1` 而不是跳过，但**上一版锚点写错时的沉默，正是它存在的理由**。
- **H 档存活**：去掉 `tableExists` 探测后，回复**完全不变** —— 因为查询自己抛错、被 catch、返回同一个 `unavailable`。这是**等价变异**吗？不完全是：warning 日志会多出 `turn_diff_list_failed`，也就是把「这个运行时没有这张表」报成「读这张表时出错了」。**回复上无法区分，warning 上可以**，所以补了一条测试钉在那里，并带一条真失败的对照项（否则「从不 warn」的构建也能过）。判据同 §8.33：**两个分支对所有读它的代码是否可区分** —— 这里读它的代码是运维看的那份日志。
- G 档是那个「上限不生效」的形状，直接打掉它。

13 条测试 + 9 档变异，全红。门禁在这一轮把 4 处工具名册和 SKILL 的编号列表全部抓了出来（`protocol`/`skill-contract`/`store`/`egress-contract`/`tool-limits`/`release-gates`），是它们按设计工作。其中 `detail-level.test.mjs` 暴露出自己**按编号切片**（`'5. \`trajectory_find\`'`）：我插入一个工具后编号移位，`indexOf` 返回 -1，`slice(-1, …)` 交给断言一段**与该工具毫无关系的文本** —— 一个悄悄不再守护的守护。改成按 `/^\d+\. \`tool\`/m` 锚定条目：**不依赖编号，但仍是条目级**，于是「`trajectory_find` 条目里提到 `trajectory_get` 导致按名字切片切错句」这个它本来要防的错也不会回来。

**教训**：**审计「接口够不够用」，最省力的第一步不是想，是数。** 想出来的是「也许缺一个按时间过滤」这种；数出来的是「55% 的会话有一张没人读的表」。而**等价变异存活时，先问读它的还有谁** —— 这一次答案是「运维看的那份日志」，不是返回值。

---

### 8.36 两个数各自都对，读者还是会拿它们互相核对

上一节给 `trajectory_summary` 加了 `changedTurns`（§8.35）。这次量的是**它和 `trajectory_turns` 的关系** ——
Skill 明确教读者「先看 summary 的总数，再用 turns 拆到每轮」，所以这两个数**必然会被放在一起比**。

真机一量：

```
change set 行            1,417
其中 turn 在消息里找不到的   307   ← 占全部文件条目的 11.8%
changedTurns > turnsTotal 的会话   7 / 351
最极端的一个              changedTurns=165 / turnsTotal=2
```

`changeAggregate` 数的是 `local_runtime_turn_diffs` 的**行数**，`trajectory_turns` 数的是消息里出现过的
**distinct turn**。两张表由运行时**各自独立写入**，不要求对「有哪些轮次」达成一致：

| 现象 | 根因 |
|---|---|
| 307 条 change set 的 `turn_id` 在消息里没有 | 变更集写了，转录那部分没写（或已被裁剪） |
| 7 个会话 `changedTurns` 严格大于 turn 总数 | 全部 change set 都属于转录没有的轮 |

**两个数都是真的，缺的只是「它们不是同一个东西」这句话。** 页面上没有任何东西自相矛盾 —— 除非
读者拿它们互相核对，而 Skill 恰好教他这么做。

复现走的是真 handler，不是夹具断言：6 条 change set、2 条消息行、其中 1 条 turn 对得上
→ `changedTurns: 6` / `turnsTotal: 1`，两个回复都**没有 note**。

**修法不是把 `changedTurns` 改小** —— 那会报 1，然后藏掉 5 条真实变更。是把差值发布出来：

- `trajectory_summary.unmatchedTurns` / `trajectory_changes.unmatchedTurns` —— 有多少条变更集
  指向转录没有的轮
- `trajectory_changes` 每行的 `turnInTranscript` —— 同一件事，逐行
- 面板那张卡的副标题原本写「该会话记录到文件改动的轮数」，**这正是那句被藏起来的话**，改成按
  `unmatchedTurns` 切换措辞

真机上现在是：`changedTurns=165 / unmatchedTurns=165 / turnsTotal=2`，一眼可见。

#### 中途自己犯的那个错：把口径差异写成 `warnings`

第一版把这条写进了 `summary.warnings`，理由是「读者需要被告知」。结果**一条既有测试变红**：

```
expected: []
actual:   ['changedTurns counts change sets, not turns of this transcript: 3 of 3 ...']
```

那个 fixture 造的正是「3 条 change set、0 条消息行」。看代码的人会觉得这个 caveat 有理，**但它
是错的** —— 本插件里 `summary.warnings` 的定义是「某个聚合没算出来，所以它的 `0` 不是发现」。
两个数都是从真实行算出来的。往这里塞东西，等于告诉读者**你手里那个数不可信**，而它完全可信。

**口径不同 ≠ 降级。** 这是「能力字段 vs 过程记录」的第四次出现：flags 是能力，`warnings` 是过程，
两者都不能省，但也不能互相冒名。改回独立字段，并把这条规则写进测试的注释里（变异 R 档专门打它）。

#### 又一次 287 ms：同一个错误，隔一个字段重犯

新加的孤儿计数第一版写成：

```sql
WHERE m.session_id = d.session_id AND COALESCE(m.turn_id, '') = COALESCE(d.turn_id, '')
```

**287 ms**（最忙的会话，330 条 change set），对照原来那个计数是 **0.01 ms** —— 三万倍。而 §8.35 刚刚
为了这个字段砍掉过一个 206 ms 的文件计数，**理由是同一个：这是 Skill 让读者第一个调的工具**。

根因：`COALESCE` 把索引键包进了函数，planner 用不上 `(session_id, turn_id, role, id)`，每条 change set
都重扫一遍会话的消息行。

```
COALESCE(...) = COALESCE(...)        287.00 ms
m.turn_id IS d.turn_id                 0.20 ms     ← 1400 倍
```

`IS` 在 SQLite 里本来就是 NULL-safe 的比较，语义与 `COALESCE` 完全一致 —— 我为了「可读性」加的那个
包装，正是不可读性的来源。

**教训**：**在同一段代码里修掉的性能问题，会在隔壁字段原样复发，因为它是同一个习惯。** 所以这次
不是加注释，是加**会红的测试**（Q 档变异 + 一条源码断言），钉住 `IS` 而不是钉住注释。

#### 一个我自己断言写错的插曲

面板测试我先写成 `assert.doesNotMatch(clean, /转录/u)`，理由是「干净会话不该出现告诫」。但干净的
那句是「变更集数（**对应**转录轮次）」—— 正常说明里本来就有这两个字。**断言抓的是词，不是意图。**
改成匹配告诫自己的措辞（`不在转录`）。

这与 §8.35 那条「断言的期望值必须从被测对象自己读出来」是同一条：断言要钉的是**被测对象说了什么**，
不是我心里那个词的集合。

**教训**：**测试要匹配意图的措辞，不是意图里的词。** 一个词出现在两处含义相反的地方时，按词断言
会绿掉它本该拦下的东西，也会红掉它本该放过的。

---

### 8.37 「那次会话到底要做什么」，以及它为什么不能从标题推出来

§8.35 定了「审计接口够不够用，先数表」。这次照着做，73 张表里有一张从没被读过：

```
grep -rn "thread_goals\|threadGoals" server/ web/ skills/ tools/   →  0
```

`local_runtime_thread_goals` 存的是**运行时给这次运行记下的目标原文**。量完之后，三件事让它成为真缺口
而不是「又多一个能读的表」：

**一、原文只有这一份。** `local_runtime_sessions_fts` 的列是 session id / agent / title / workspace /
purpose / status / type —— **没有目标**；而真机上 15 个带目标的会话**没有一个**有 `messages.jsonl` 产物。
所以「那次要做什么」在这个插件里无处可查。

**二、它不是标题的另一种写法。** 对全部 15 行做分词后算 Jaccard 重叠，**13 行低于 0.15**：

| `title` | `objective` |
|---|---|
| 同步本地与远程分支代码 | 继续深挖当前插件的方方面面可能存在的问题，持续优化迭代… |
| 查询项目前后端架构 | 整理并落地一套比较好的后续方案，可以很方便的集成更多的动画效果 |
| 排查项目部署缺少的组件 | 尽可能删除所有对这台远程机器的操作记录和访问记录 |

标题是真实行上的真实字段，所以**任何回复上都没有东西与读者的推论矛盾**。这就是它必须单独发布、
不能留给推断的原因：**从一个正确字段推出的错误结论，和一个正确结论长得一模一样。**

**三、它根本搜不到。** 五个普通中文查询（插件 / 测试 / 文档 / 动画 / 部署）命中 13 个带目标的会话，
**FTS 一个都没命中**（goal-only 全部）；**15 个会话里 0 个**能被自己目标里的词找到。

#### 为什么不把目标塞进 FTS 查询

运行时建那张表，插件是只读消费者，`pragma_table_info` 实测确认没有目标列 —— 加不进去。所以目标走
一条**独立通道**：`goalObjectiveMatches()` 用字面 `LIKE` 扫目标表，实测 **0.070 ms**，对照走 634 行
的 FTS 索引，这个代价没有优化空间。

两条边界都是量出来的：

- **不进 `total`、不进 cursor。** 行走是 FTS 行走，把第二个来源折进任何一处，游标的含义就取决于
  「哪个来源碰巧命中了」—— 这是游标唯一不能有的性质。目标命中的行仍然**搭页面走**，并带
  `objectiveMatched: true` 和命中的原文，所以读者分得出来。
- **不依赖 FTS5。** 这条通道是普通表扫描，在**完全没有索引的机器上仍然工作** —— 而那正是最不能
  丢掉这个字段的环境（Node 在 22.13.0–22.18.x 与整个 23.x 上捆绑的 SQLite 都不带 FTS5）。第一版
  把它 gate 在 `hasFts` 后面，E 档变异立刻存活。

真机效果：搜「插件」现在能找到标题写着「同步本地与远程分支代码」的那次会话 —— 因为它目标里写着
「继续深挖**当前插件**」。2–13 ms。

#### 三个我自己犯的错，都被已有的东西抓住

**一、我把目标原样发出去，泄露了凭据。** `trajectory_summary` 侧我顺手加了目标字段，却只让
`workspaceDir` 过了 `redactPath`，没走 `redactPayload` 扫描。新写的测试当场打出来：

```
actual: '修好 ~/.ssh/id_rsa 这个 key，token 是 sk-proj-AAAABBBBCCCCDDDDEEEEFFFF'
```

目标是**用户为启动这次运行而敲的原文**，里面会有本机路径、分支名、粘贴的片段或 key。这是本插件
至今最自由的一段文本。

**二、脱敏测试本身有个洞，两条断言只验了「有一个面被扫过」。** summary 和 search 各有一次调用，
循环断言对两者用了同一套逻辑，于是**删掉任意一个都还有另一个满足断言**，整条测试照样绿 —— I 档变异
存活就是这么来的。补的是每面各断言一次「扫描确实在这个回复上跑过」（`/[redacted]/`），
而这正是我记忆里那条「断言的期望值必须从被测对象自己读出来」的又一次。

**三、我把 `warnings` 写成了嵌套空数组。** 加第五个降级源时写成
`[agg.degraded, ...]` 而不是 `[...agg.degraded, ...]` —— `agg.degraded` 本来就是数组。`filter(Boolean)`
**保留空数组**，于是 `warnings` 变成 `[[]]`：一条既有的、专门盯这个的测试立刻红了。

**教训**：**新增一个降级源时，先看它前面的兄弟是数组还是字符串。** `filter(Boolean)` 不筛空数组，
而嵌套空数组在 warnings 里是唯一一种「让每个读者的『有没有降级？』都回答是、却不指名任何东西」的值。

#### 一条既有测试抓到的真缺陷：`searchSessions` 有了两套回复形状

加了目标字段之后，那条「整个对象 deep-equal 而非只查空」的测试红了 —— 它本来就写着要钉住整个形状。
四条早退路径（空查询、无 FTS5、索引缺列、查询失败）**全都没有新字段**，正常路径有。

修的不是断言，是实现：`EMPTY` 里带上这两个字段。顺带发现早退路径其实**应该**跑目标通道
（见上面「不依赖 FTS5」）。

**教训**：**给回复加字段要覆盖每一条路径，包括什么都不返回的那些。** 「成功路径加了字段」不等于
「这个函数有了这个字段」。

9 条测试 + 9 档变异，全红。

#### 收尾时全变异扫抓到的：两档「假红」和一次等价变异

全扫第一轮报 167 档全红 / 0 存活，但**带着 5 条 PROBLEM**——而那 5 条比那 167 条红更要紧：

**一、锚点失效。** `mutate-search-encoding` 的 M5 和 `mutate-search-unsearchable` 的 A/B 报
「ANCHOR MISSING」—— 我改早退路径时把它们脚下的锚点挪走了。**报「锚点缺失」比报「红」严重**：
那一档对声称守护的面已经不再产出任何证据，而清单上它看起来和别的档一样。

**二、A 档一直在测它没声称要测的东西。** 修好锚点后它转绿了，但我「收窄」它、只想让它打
`unsearchable` 那一面时，它**立刻存活**：

```
mutate: goalOnly({ unsearchable: true })  →  { ...EMPTY, unsearchable: true }
SURVIVED
```

根因：`EMPTY` 里已经有 `unsearchable: false`，所以显式的 `true` 和 guard 的 `extra` 参数**是同一个值
穿了两种外衣** —— 我写的「收窄」是个**等价变异**。而这一档此前的红，真实来源是目标通道被一起关掉了，
不是 `unsearchable` 标志 —— **后者从未被任何断言钉住**。

改成 `return EMPTY`（真的丢标志）才真红。补了两条断言把这个面钉住，并把它写进测试注释。

**教训**：**变异存活时，先核对「它改的和我以为的是同一件事吗」，再谈测试有没有洞。** 等价变异不是弱
变异，是**不可见变异** —— 它为某个面报出一个并不存在的通过。而「收窄一个变异以只测它声称的那一面」
本身要当证据看：**收窄结果必须自己先真红**，否则收窄把证据抹了。

**教训**：**脚本报 SURVIVED 时先确认它真的应用了。** 我手工复现时手写了一份锚点，缩进与脚本里的不同，
python 的 `assert count == 1` 失败，差点被我读成「测试没洞」。脚本会打印 `MUTATION DID NOT LAND`，
但只在锚点非空时；手工复现必须用脚本自己的锚点文本。

---

### 8.38 有 120 轮死过，而 7 个会话读起来一次都没出错

§8.35 立的规矩是「先数表」。这一轮照做：73 张表，剔除已读过的、剔除明显不是「运行事实」的
（`query_view_states` 是面板 UI 状态、`file_api_uploads` 全是哈希、`pi_history` 的内容在消息投影里也有），
剩下 `local_runtime_turn_ingress` —— **2,466 行，插件零引用**。

它记的是**运行时受理一轮的记录**：何时受理、序号、什么 claim 了它、队列有没有确认、怎么结束。

真机一量：

```
ingress turns               2,466  （582 个会话）
  completed                 2,344
  aborted                       64
  failed                        56
  accepted                       2
转录里完全没有的轮               27   （13 completed / 10 failed / 4 aborted）
```

**那 120 个失败与中止的轮里，有 14 个在消息投影中一行都不存在**，散落在 7 个会话上。这 7 个会话用本
插件现有的每一个工具看过去是什么样：

```
mvs_684590f847174d43a08d  status=idle  turns=62  toolCalls=2866  errorMessage=none  warnings=0
mvs_bfaaea693e3042048f14  status=idle  turns=76  toolCalls=5907  errorMessage=none  warnings=0
```

一次干净的跑完，14 轮死在中间，**没有任何一个字段与「它出了问题」矛盾** —— 因为转录里真的没有那些
轮，所以除了这张表之外无处可查。这就是它的形状：**不是「读到了坏消息」，是「坏消息不在任何地方」。**

#### 这张表能回答什么、不能回答什么，是量出来的

`pragma_table_info` 返回十六列，**没有一列记录「为什么失败」**。所以这个工具没有 `reason` 字段 ——
加一个就是「把读者最想要的那一个事实放在一个猜测后面，还给它一个字段名」。它说的是「哪一轮死了、
什么时候死的」，永远不说「为什么」。D 档变异专打这一点。

另一半是 `claim_source` —— 运行时记录「**谁发起的**」的唯一地方，而 `thread-goal` 是第二大来源，
**668 / 2,466**。§8.37 刚发布的目标原文，正是这个机制启动的轮次。剩下的 1,603 轮 `claim_source` 是
NULL，占多数，**报成 `null` 而不是归给 user**（E 档变异）。

两个数字刻意分开，因为它们答不同的问题，且**互不为子集**：

| | 数字 | 含义 |
|---|---|---|
| `failedOrAborted` | 3 | 运行时说这些轮**结局坏了** |
| `missingFromTranscript` | 4 | 投影**没有携带**这些轮 —— 其中 1 个**成功完成** |

把两者合并，就会像 §8.36 那样告诉读者「14 轮死了」而实际是 27 轮只是不可见，然后他不再信这个数字
（C 档变异）。

#### 同一个 `COALESCE` 陷阱，我这次一开始就避开了

`ingressAggregate` 里那句 `m.turn_id IS i.turn_id` 是刻意的 —— 与 §8.36 一字之差、一格之隔：

```
COUNT(*) only                 0.12 ms
+ missing (IS)                0.82 ms      ← 用的
+ missing (COALESCE)        389.99 ms
```

最大会话 471 条 ingress × 23,732 条消息。F 档变异 + 一条源码断言钉住它，因为**这个属性行为上不可观测**
—— 两种写法返回同样的行，只有代价不同。

#### 缓存键：同一个坑，隔一个字段

`getStats` 的键加上 `ingressSignature` 之前，一个在受理时死掉的轮**不写任何消息行、不动会话行**，
所以消息签名和会话行都不动 —— 于是在它死之前算出的 summary 会一直报 `turnsFailedOrAborted: 0`，
**进程活多久就说多久**。这正是这个字段存在的意义所反对的那张清洁证明。

修完验了「修复前必红」：把签名从键里去掉，那条测试立刻红。

**教训**：**§8.35 已经为 change set 付过一次这个代价，§8.38 又为 intake 付了一次。** 一个字段的
缓存键缺一个来源，只有在**读机制**时才撞得见，扫描找不到。给缓存键加第二个来源的人，下一个字段
一定会再犯 —— 所以这里留下的是一条会红的测试，不是一条注释。

11 条测试 + 10 档变异，全红。

---

### 8.39 一个复现不出来的数字不是证据

§8.38 收尾时跑完全变异扫，输出是这么三行：

```
RED: 178
SURVIVED: 0
problems: 3
```

前两个数字来自 31 个脚本各自的 `RED` / `SURVIVED` 行，可信。第三个不是 —— 它来自那条命令里
一个**当场写下的 grep 模式**，没有写进任何文件、没有重跑过、复现不了，而**退出码是 0**。

于是一个「有 3 个问题」的结果和一个「干净扫完」的结果，在输出里长得一模一样。这不是数字错了，
是**这个数字没有口径**：没人能照着它去查那 3 个是什么，下一次谁跑都拿不到同一个数。

根因不是那条 shell，是**31 个变异脚本没有统一入口**——各自会跑、各自会 `fail=1`，但「整轮扫下来
怎么样」这件事只存在于某个人当时敲的那一行里。于是有了 `tools/mutation-sweep.mjs`：

```
node tools/mutation-sweep.mjs            # 全部
node tools/mutation-sweep.mjs --root DIR # 临时副本（测试用）
```

**类别取的是「让结论作废」，不是「让结论难看」：**

| 类别 | 它拦的是什么 |
|---|---|
| `anchor-missing` / `did-not-land` | **没应用下去的变异照样打印 RED** —— 那是给一个从未跑过的 mutant 开的绿灯 |
| `survivor` | 变异活了：没有测试钉住它改的那一面 |
| `tree-drift` | 脚本没把工作树还原，之后每个结论都读在一棵没人记得被编辑过的树上 |
| `silent` | 一个都没跑的脚本也照样打印统计，读起来像「全杀」 |
| `crash` | 非零退出但归因不出来的那一类失败 |

有问题就**非零退出**——这一条才是让 `problems: 3` 再也不能被读成通过的东西。

**换掉那个复现不了的数字之后，它立刻指出了两档死掉的变异：**

```
problems: 2
  - mutate-changes-tool.sh anchor-missing: server/mcp.mjs
  - mutate-changes-tool.sh anchor-missing: server/stats.mjs
```

B 档和 M 档。而 §8.35 当时报的是「18/18 全红」——**对这两档，那句话本来就不成立**：它们一行证据
都没产出，却在清单里和别的档长得一模一样。两档都是 §8.38 造成的，而且**两种坏法不同**：

- **B 档是歧义，不是缺失。** 它锚的是 `nextOffset: delivered === 0 || offset + delivered >= reachable
  ? null : offset + delivered,`。§8.38 的 `trajectory_ingress` **逐字复用了同一行回复形状**，一份
  变两份 —— 锚点从唯一变成两处。
- **M 档是缺失。** 它锚的是整条缓存键，而 §8.38 正好给这条键加了第三个来源 `ingressSignature`。

**教训一：一个新工具复用旧回复形状，会静默废掉以那份形状为锚的变异档。** 复制回复形状是有意的、
是对的，所以锚点不能锚在「恰好目前唯一」的那段文本上——它得**锚在它守护的那个工具上**，
也就是 `release-gates.mjs` 早就在用的做法。为此给脚本加了 `mutate_case <tool> <file> <from> <to>`：
只在该工具的 `case` 块内替换。

**教训二：锚「整行表达式」的档，每加一个缓存来源就要重锚一次，而重锚是一个会被静默跳过的步骤。**
M 档改成只锚那一个来源（`|${store.changeSignature(sessionId)}`），从此**不管键里还有什么、几个**都成立。
顺带补了 `anchor_inline`（行内锚不能带尾换行，否则和「锚点缺失」长得一样）。

10 条测试。六档逐一打掉实现验证过「修复前必红」：去掉 exit-code、去掉 drift 判定、去掉 silent 判定、
去掉 crash 判定、去掉 survivor 计数、让 `--root` 失效 —— **六档全红**，tree 逐字节恢复。

**教训三：连「我在测一个扫描器」这件事，都先问扫描器会不会喊。** 只报过「没问题」的检测器，和从不
看的检测器无法区分。所以每条检查都配了**对照项**（干净的那次必须不喊），以及**合成输入**（它必须喊）。

**还有一条自己踩的：测它的那个测试，也是往仓库目录写文件的。** `node --test test/*.test.mjs`
**并发跑各文件**，而 `release-gates.test.mjs` 正在 `cp` 整棵树 —— 复制走到一半文件没了，ENOENT 落在一个
**从没碰过变异**的门禁头上。已知的纪律是「改工作树的东西不与读同一棵树的东西并发」，而我把它当成了
「变异脚本」的身份，而不是「写工作树」这个行为。修法不是加锁，是**让被测对象能换根**（`--root`）——
一个只能靠改真树来取结论的检测器，在全量套件里本来就取不到结论。

10 条测试 + 新增第 8 道门禁 `doc-tool-count`（工具计数**从 `TOOLS` 推导**，不写死字符串）。

**顺带抓到的：工具计数在本轮漂移了两次而没人发现。** README 写着「the seven declared tools」，
DESIGN 的目录树写着「MCP JSON-RPC + 10 个工具」，而服务器已经服务十三个工具好几轮了。门禁现在把计数
**从 `TOOLS.length` 推导**并要求四处当前声明一致——写死 `thirteen` 的门禁会在第十四个工具落地那一刻
变成第二个需要被记住的东西，那正是它要防的缺陷。它**只查做当前声明的文件**：`DESIGN.md` 是只增不改的
日志，它那些编号章节里写着当年是多少就是多少，事后去"修正"它们才是错的。

---

### 8.40 两个工具从未被变异证明过

**怎么找到的：数。** 把 13 个工具名逐个 `grep -l` 过 `tools/mutate-*.sh`，11 个有脚本，
`trajectory_agent` 和 `trajectory_assets` **一个都没有**。

这两个工具的**行为测试都在**（合计 11 例）。所以不是没测，而是**没有任何证据证明那些测试会咬**。
一份从没被看见失败过的测试套件，和没有测试是同一种装饰 —— 而本插件关于出口与披露的全部主张，
都压在「已知会红」的测试上。而且这恰好是最不该没覆盖的两个面：它们交出去的是**文件路径**和
**系统提示词**，都是本插件控制不了的自由文本，写在路径/提示词里的凭据正是从这条看起来最普通的路走的。

补 `tools/mutate-agent-assets-tool.sh`，10 档。**第一次跑，3 档存活**，而这 3 档是**三种不同的坏法**：

| 档 | 坏法 | 判据 |
|---|---|---|
| C | **变异成立的条件夹具到不了** | `truncated: false` 在预算真的生效时是撒谎，但 2 MiB 预算 vs 十二条 6 字符名字的夹具 = 几 KB，`bounded.truncated` 本来就是 `false`，改不改成 `false` **没有任何断言能看见** |
| F | **等价变异** | 见下 |
| J | 同 C | 单条记录预算软，但披露只有一个字段能说，而原来的定义只有几百字节，两个字段本来都是 0 |

**F 那一档讲的是另一件事，而且它没有报错。** 它的原始目标是「路径不折叠，绝对 home 目录从这条出去」，
删掉那行显式 `redactPath`。它**应用成功了**（映射里确实没有了），11 条测试**全绿**。
按纪律先问「它改的和我以为的是同一件事吗」，答案是**是**：`redactPath` 就是 `foldHomePaths`，
而它下面那个通用行扫描拿到的是**同一组 `homeDir` 和 `roots`** —— 两处折叠干同一件事，
删掉一处什么都不改。**等价变异不是弱变异，是不可见变异**：它为某个面报出一个并不存在的通过。
按纪律**换目标，不加夹具**：改成「行不再说清是哪个文件」，既有断言立刻红。

**教训：死档不止「锚点失效」一种。** 变异语料此前记录过两种（锚点缺失 / 锚点歧义），
§8.40 又添两种：

- **等价变异**：改的东西和声称守护的面不是同一件事；
- **不可达变异**：改动是真的，但**夹具永远到不了它成立的条件**，于是它在为一个什么都没测的面报通过。

后一种最安静，因为它连「存活」都算不上 —— 测试是真绿的，变的只是没人看过那一面。

**自己又踩了一次「期望值必须从被测对象自己读出来」**：给 agent 的截断写 `omitted > 0`，
红了。回去读 `boundPayloadList` —— `omitted = items.length - kept.length`，而单条超预算时
记录**仍然被保留**（置了 `overBudget` 之后照样 push），所以 `omitted: 0` 而 `truncated: true`
**是契约不是缺陷**。改成断言 `omitted === 0` 并写清理由：正因为精确为零，才挡住「看到
truncated 就顺手把记录丢掉」这个诱人的改法。

**顺带抽了 `tools/mutation-lib.sh`**（故意不叫 `mutate-` 开头，否则会被扫描器的 glob 当成一个
变异脚本跑）。`mutate` / `mutate_case` / `anchor` / `anchor_inline` / `check_red` 只写一遍 ——
否则「让一个变异结论可信」这件事会在每个新脚本里重做一次、重错一次。抽取时**顺带看见复制品里一个
潜伏 bug**：`mutate_case` 在目标 case 是文件里最后一个时，`end` 为 `-1`，`rest[end:]` 等于 `rest[-1:]`
—— 取最后一个字符，把文件写坏。`trajectory_changes` 不是最后一个，所以从未触发。

10 档全红，2 条新测试（资产列表跨预算、定义跨预算），全套件 736。

---

### 8.41 会话本身只占 2%，而没有任何办法只读它

这一节换了方法。前面几轮是静态审计加变异证伪，**还没有端到端地当成模型去用一遍**——
而用户点名的第一优先就是「找历史会话」和「找历史会话的**进展和内容**」。于是照着 Skill
的建议，对着真实库跑了一遍「找到一场会话，读它的内容」。

**读不出来。不是慢，是根本走不完。** 那场会话 5,343 条 event，走完全部记录：

```
calls to read all:          27
reply text walked:          24.6 MiB
wall clock:                 3,198 ms
```

而按角色数一遍：

```
assistant      5,272   98.7%
null              62    1.2%
user                9    0.2%
```

**人类真正说过的话是 9 条，占 0.2%，读它们要付 24.6 MiB。** 全库更极端：`assistant` 112,290 /
116,304，`user` **2,388（2.1%）**，`null` 1,626。

这个代价不是「贵」，是**否决性**的：24.6 MiB 的 `full` 详情远超任何模型的上下文，而 `full` 恰恰是
Skill 明确要求「不要自行加宽」的那一档。于是**安全路径的价格，等于这个问题根本问不出来** ——
一个守着隐私的面具，把它的另一面也一起锁上了。

三个工具的入参里没有任何一个按角色过滤：

```
trajectory_turns : sessionId, offset, limit
trajectory_find  : sessionId, query, offset, limit, detailLevel
trajectory_get   : sessionId, offset, limit, turnId, detailLevel
```

`trajectory_find` 也不行——它是跨全部角色的文本检索，不是过滤器。所以唯一的走法是走完再本地丢。

**修法**：`trajectory_get` 加 `role`，与 `turnId` **完全对称**地放在同一层——过滤必须落在
offset 之前，否则 `total` 和游标就是错的：

```
                calls   bytes      wall
不带过滤           27   24.6 MiB   3198 ms
role: 'user'       1    5.5 KiB      5 ms
```

**4,570 倍的字节差。** 三态与 `turnId` 同构：`undefined` 不筛，字符串筛该角色，`null` 筛**没有角色**
的那批（真机上 1,626 条，是真实分组，不是假想），`null` 与省略**不能塌缩**。

**过滤器必须在两个来源上都成立。** `trajectory_get` 在投影无行时会回落到会话自己的
`messages.jsonl`；投影上筛、artifact 上不筛，同一个问题会因为**这条会话恰好有没有被索引**
得到两个答案，而回复里没有任何字段能指出跑的是哪一个。这正是 `turnId` 当年被挪进那一层要防的形状。

**而我第一版就在这件事上摔了**：过滤器读的是 `record.role`，而 artifact 一行里的 role 住在
**`message` 里**——和事件本身取自同一个对象。结果每一行都读成「无角色」，过滤器**照样执行**、
照样返回记录，只是返回了错误的那一批。**一个会跑、但回答了另一个问题的过滤器，比不跑更难发现**，
因为它的回复形状完全正常。测试当场抓到（返回的 `role` 是 `null` 而不是 `user`）。
现在 C 档专门守这一行。

6 条测试 + 6 档变异全红。整套件 742。

**教训**：**「接口够不够用」不该靠通读 schema 判断，要靠真的走一遍模型会走的路。** 这一节里
schema 什么都没说错——`turnId`、`offset`、`limit` 全都在位，`detailLevel` 也被认真限制了。
缺的不是某个已有字段写错了，是**一个没有人想到要问的问题**，而它只在真的把 5,343 条读完之后
才显出形状。

---

### 8.42 自己写的验收脚本在掷硬币

§8.41 收尾时 `tools/browser-check.mjs` 失败了一次：

```
FAIL  a background tool call offers its captured output — offered by no row among 81 tool rows
```

紧接着再跑三次全过。**5 次里 1 次。** 这种东西不能当「偶发」放过——一个时灵时不灵的验收步骤
不是门禁，是硬币，而硬币不会告诉你它什么时候会立起来。

**根因不是我想的那个。** 我先猜是「实时数据在数、面板在渲染，两者错开」。读完代码才知道不是。
那一段是：

```js
const rows = [...document.querySelectorAll('[data-tool-call-id]')];
for (const row of rows) {
  row.click();
  const offered = [...document.querySelectorAll('#inspector button')]...;
  if (offered) return { found: true, rows: rows.length };
}
```

**`row.click()` 之后立刻读 inspector。** 而 `openInspector` 里 `refreshSelectionHighlight()` 是
**同步**的（立刻给那一行打 `aria-selected`），**按钮却是异步取数后才出现的**。所以循环里每一次
读到的都是**上一行**的内容。机器满载时（那次正好紧跟一场 30 分钟的全变异扫）每读都是旧值 →
`found: false`。

**而它同样能假阳性**：读到**前一行**的按钮就报 `found: true`。一个能替没验证过的行发通行证的检查，
比漏报更坏——它让整套验收的结论不可信。

那段代码上面本来就有一句注释，说明作者**已经**修过一次同类的摇摆（固定前缀改成遍历
全部渲染行）。**修了一半**：知道「哪些行在屏上」是运气，不知道「读到的 inspector 属于哪一行」是
时序。

**修法不是加等待，是两件事一起**：

1. **只点已知必须出按钮的那一行。** `offeredCalls(...)` 返回的就是那些行，把它们的
   `call.id` 记下来，直接 `document.querySelector('[data-tool-call-id="…"]')`。不再依赖
   「恰好哪些行被渲染了」。
2. **等答案，而不是抢答。** 点击后轮询到按钮出现为止。

**等待是总量有界的，不是每行一个期限。** 第一版每行 8 秒，而首屏有 **41** 条带输出的行 —— 真失败时
要跑好几分钟才吐出一个词。**一个跑几分钟才报错的检查，是会被跳过的检查**，而它存在的意义恰恰是
在没人盯着的时候跑。总预算 6 秒，实测失败路径 **18.5 秒**返回。

两个方向都验过：

```
正常        ok    offered by the row for call call_function_byr70zbmh5uj_1, out of 68 rendered tool rows   13.0 s
按钮改坏    FAIL  no button after waiting on 41 row(s) that carry output, among 68 rendered tool rows      18.5 s
候选清空    FAIL  no button after waiting on 0 row(s) that carry output, among 68 rendered tool rows
```

失败信息现在**指名它点的那一次调用**，并且说清等了多久、候选多少、渲染多少——原来那句
「offered by no row among 81 tool rows」把这三件事全压掉了。

**教训一：一个验收步骤的答案不能取决于机器快慢。** 读到的是异步更新的前一个状态，等于把
**每一次**结果都交给时序决定，而且往两个方向都错。

**教训二：我自己在这个坑里又读浅了一次。** 修完第一版跑出来是 `undefined`。我先怀疑 `ids` 没接上，
去查了管线——不是。真正的原因写在脸上：`JSON.stringify((async () => …)())` 里的
`JSON.stringify` **先于 await 求值**，它序列化的是 **Promise 对象**（没有自有属性），于是拿到字符串
`"{}"`，`awaitPromise` 无事可等。文件里其他探针都写成那个形式，是因为它们的 IIFE 是**同步**的。
正确写法是直接返回对象，让 `awaitPromise: true` 去 await 解析结果。**读代码读到能预测它的输出为止，
不是读到「看起来对」为止。**

**顺手查了同一类问题的其余七处，结论是「没有」。** §8.42 那个检查能假阳性，而「点了不读、等」这个
模式在同一类缺陷里是最容易成片的，所以逐个查了 `browser-check.mjs` 里全部七个交互点。
七个都等了：切会话等 `aria-current` 变、两次搜索分别等 `items > 0` 和 `/没有匹配/`（这两个条件
**只可能在结果落地后成立**）、选会话轮询 title 与行数、点按钮等 `#inspector pre` 有内容。

中间怀疑过一次 265 行那个 `waitFor`：条件里的 `search.value === term` 是 evaluate 自己同步写进去的，
而 `items > 0` 在搜索前的旧列表上也成立——**看起来**等了个寂寞。**用实验否掉的**：把那一处等待换成
0 延时，立刻读到 `items = 0`（列表正被 `input` 处理器清空）和一条**上一步的陈旧横幅**。
而 `items > 0` 恰好把这个中间窗口排除在外，所以那处是对的。`tools/panel-e2e.mjs` 则根本没有这类交互
——它的夹具是**故意设计成不需要任何点击**的（"every payload renders without anyone having to click
anything"）。

**教训三：怀疑要靠实验推翻，不能靠推理保留。** 「等了个寂寞」和「等对了」在代码上长得一样。

---

### 8.43 一个守卫在缺依赖时会静默变成空操作

`shasum` 是 Perl 的，Linux coreutils 发的是 `sha1sum`。33 个变异脚本都用它做**还原校验**：

```bash
BASELINE_SUMS=$(for f in …; do shasum "$f"; done)
…
if [ "$(for f in …; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then   # 退出时比对
```

**缺工具只是小事的一半。大的一半是「缺了会怎样」**：两边都返回空串，`[ "" != "" ]` 为假，
于是脚本打印

```
tree restored byte-for-byte
```

——一句**肯定的断言**，而它比对的两个空串什么都没验。**一个守卫在依赖缺失时静默变成空操作，比没有守卫
更坏，因为它照旧声称自己验过了。** 而这一行正是开发者判断「能不能接着跑下一个脚本」的唯一依据。

CI 不跑这些脚本，所以这不是 CI 阻塞；但 §8.39 之后 `tools/mutation-sweep.mjs` 成了**统一入口**，
Linux 上跑它就是文档里的用法。

修法：**先找可用的，再没有就致命**。`shasum` → `sha1sum` → `openssl dgst -sha1`，
三个都没有就打印需要哪三个并 `exit 1`。三种工具的输出格式互不相同（`shasum` 与 `sha1sum` 同格式，
`openssl` 是 `SHA1(file)= hash`），但**两次调用自洽**，比较照样成立。

33 个脚本全部装上同一个守卫。三个分支都用 PATH 沙盒实测过（把 `PATH` 设成**等于**沙盒——
第一次写成 `$SB:$PATH`，真路径被追加回去，沙盒等于没建，测出来的「通过」是假的）：

| 环境 | 结果 |
|---|---|
| 无 `shasum`，有 `openssl` | 两档全红 + `tree restored byte-for-byte`，**且是真验的** |
| 无 `shasum` 无 `openssl` 无 `sha1sum` | `no SHA-1 tool available: need one of shasum, sha1sum, openssl` / **exit 1** |
| 把 `restore()` 废掉（沙盒一） | `TREE NOT RESTORED -- web/js/storage.js differs from where the run started` + `do not trust this run` |

第三行是这条修复的**证据**：修复前在 Linux 上，那一句会是 `tree restored byte-for-byte`。

**这一轮我又违反了自己的纪律**，而且是在自己刚写完的纪律上：为了做反面实验，我把某个脚本的
`restore()` 改成空操作，脚本正确地报了漂移，**但我自己忘了把工作树改回来**。是那句
`web/js/storage.js differs from where the run started` 顺带指出来的——脚本知道，我没想到。
最后从脚本遗留在 `mktemp` 目录里的备份按哈希对回原状（三个备份互相一致且都与当前不同），
清理了残留。**「让脚本报告漂移」和「自己不留漂移」是两件事。**

---

### 8.44 一个过滤器参数被静默吃掉，于是「跑哪个脚本」由不得自己

按用户的**跨操作系统**要求扫发布代码，结论是两条**否定**的：`server/changes.mjs` 那个
`POSIX_TEMP_ROOTS = ['/tmp', '/var/folders']` 看着是 POSIX 硬编码，但 `os.tmpdir()` 是
`isScratchPath` 的**默认参数**且同在判定路径里，Windows 的 `AppData\Local\Temp` 因此被覆盖；
`MCODE_TRAJECTORY_REDACT_ROOTS` 用的是 `path.delimiter` 而不是 `:`，所以 Windows 上那种
「盘符 + 用户目录」形态的根不会被从中间劈开。**发布代码的跨平台处理是对的**，不制造发现。

**但我这一轮自己加的代码有平台问题**——查「有没有测试 spawn bash」时才发现：

```
$ grep -rl "spawn.*bash" test/      → 没有既有命中
```

`test/mutation-sweep.test.mjs` 是**唯一**一个，而它是 §8.39 才加的。`tools/mutate-*.sh` 全是 bash，
于是一台没有 Git Bash 的 Windows 上，这 6 条测试会把**整套件**拖红——而失败原因与被测代码无关。

**先让运行器能回答这个平台问题**，而不是崩：加 `bashAvailable()` 探测、`spawn` 的 `error` 监听
（否则 Node 抛未处理的 `error` 事件，进程直接死在栈上而不是给出一个结论），并把 `no-bash` 写成
第 7 个问题类别。然后测试按能力分成两半：需要 bash 的 4 条 `if (hasBash)` 包起来，不需要的
（分类器、`--list`、空树）到处都跑；在没有 bash 的机器上跑一次，得到的是 1 条
`without bash the runner names the platform instead of failing`——**一个说明机器的结果，而不是四个
说明机器的失败**。用 PATH 沙盒（`env PATH=<无 bash 的目录>`）实测通过。

**然后，同一次排查里撞到一个更蠢的 bug，是我自己写的扫描器的：**

```
$ node tools/mutation-sweep.mjs panel-storage
RED: 196   SURVIVED: 0   problems: 0   scripts: 33      ← 跑了全部 33 个
```

```js
const filters = args.filter((arg, i) => !arg.startsWith('--') && i !== rootIndex + 1);
```

`--root` 不存在时 `rootIndex === -1`，于是 `rootIndex + 1 === 0`，守卫把**位置 0 排除掉**——
而位置 0 就是那个过滤器。**参数被静默吃掉，跑的是错的脚本集合，而输出是一份完全合理的统计。**
这正是「一个被悄悄忽略的参数，返回了错误的页面」那一类，我在这个项目里为 MCP 工具写过同样的判据
（§7 那个 `cursor` / `offset` 串用的案例）。

**教训一：一个守卫里的「不排除它」，在选项缺席时会变成「排除第一个位置参数」。** 写成
`i !== rootIndex + 1` 看着像在排除选项的值，实际上选项缺席时那个值就是第 0 个。

补测试时又差点做成假证据两次：

- 先写成 `--list agents-list`（`--list` 在前），**在 bug 回退时依然绿**——因为 `--list` 占了
  位置 0，bug 不发作。必须写成 `agents-list --list`，**过滤器在前**才是坏掉的那个形状。
- 先忘了 `--list`，于是它**真的在套件里跑了一次针对真实工作树的全扫**——从读这棵树的套件内部改这棵树。
  那条纪律就是给变异脚本定的，而违反它的测试**不会失败**，它只是报告树在变异中途碰巧长什么样：
  它给一个 8/8 全红的脚本报了 **8 个存活**。用 `--list` 回答同一个问题，且什么都不跑。

两个方向都验过：修复在位 11/11，**把修复改回去测试立刻红**，文件逐字节恢复。

**教训二：验证「测试抓得住 bug」时，测试的参数顺序本身可能就是它抓不住的原因。**

**教训三：改正则 / 改括号这类手术，先 `node --check`。** 我用脚本搬 `} else {` 时先搬错了位置，
又用一个「第一个单独的 `}`」的启发式找收尾括号——那是**函数**的括号，不是 `if` 的，于是把
`treeWith` 的收尾吃掉了一半。`node --check` 一步就指出来了，而肉眼看缩进看不出来。

---

### 8.45 一个「超时」和一个「超时」是同一个缺陷，而它穿着测试超时的外衣

这一轮开场的两个悬案，现在归到一处：

- 全量套件长期是 **742 通过 / 1 失败**，那 1 例找不到原因——按名字筛不出，按时间筛不出，
  套件整体跑一次要 65 秒，单独再跑就超时；
- `mutate-static-404.sh` 在变异扫里被 **30 分钟硬上限 SIGKILL**，报成 `crash: exited SIGKILL`。

第二个一直挂着「要不要放宽上限」这个问题。**答案是上限没毛病，是脚本慢。**

#### 先看那 1 例失败到底是什么

```
✖ test/http.test.mjs (60002.587291ms)
ℹ tests 12   ℹ pass 11   ℹ cancelled 1
real 60.12   user 58.57   sys 0.42
```

`user` 几乎吃满 `real`——**烧 CPU，不是等 I/O**。所以「挂住」不是死锁，是有人在算。

报出来的是**文件级**超时而不是某个测试超时，这一点一开始把我引偏了：我以为卡住的是
第 12 个测试（`a legal module route…`），单独跑它 4.6 ms 通过，`1..11 + 13`、`11 + 12`、
`1..8 + 12` 各种组合都不挂，「位置」和「内容」都解释不了。

真正的判别是**按真实前缀递进**：

| 执行到 | 结果 |
|---|---|
| 前 13 个 | ok (13) |
| 前 17 个 | ok (17) |
| 前 21 个 | ok (21) |
| **前 23 个** | **HANG after 11** |
| 前 25 个 | HANG after 11 |

再单独钉住 22 和 23：

```
t22 only    ok (1)   12.6 秒      ← 通过了，只是慢到离谱
t23 only    HANG
```

**一个测试通过要 12.6 秒**——这才是真正的读数。t23 是把同一件事做五遍（翻页），所以直接超时。

#### 把 12.6 秒拆开

`test/http.test.mjs` 里 22/23 的夹具是 1000 条 × 20 KB。把测试 1–12 原样摊成一个平铺脚本
逐步打点，**23 步总共 10 毫秒**——被测代码没问题。然后分段计时：

| 阶段 | 耗时 |
|---|---|
| 造夹具 1000 × 20 KB | 1.0 ms |
| `boundPayloadList`（4 MiB 字节预算） | 11.7 ms |
| **`redactPayload`（出口扫描）** | **2177.6 ms** |
| `JSON.stringify` | 10.0 ms |

**它守护的东西比它自己便宜 200 倍。** 出口扫描在**每个**响应上跑——面板的和 MCP 的都跑，
而一个 `full` 详情页要送几 MB 工具输出过去。

再把 11 条脱敏规则逐条计时（20,000 个 `x`）：

```
key: value        10.066 ms      ← 其余 10 条加起来不到它的一半
conn string        0.243 ms
authorization      0.116 ms
...
```

而且它**不是二次退化**——2500/5000/10000/20000 四个长度都是 0.5 ns/char，是**线性的高常数**。

#### 为什么

```js
/(["']?)([A-Za-z0-9_.-]{1,64})\1(\s*[:=]\s*)(...)/g
```

`(["']?)` 可以匹配空串，于是 `\1` 必然成功，接着引擎要在**每一个起始位置**上
把分隔符 `[:=]` 试一遍——键长 1 到 64，每失败一次回退一格，**64 次**。
在一段**根本没有分隔符**的文本里，这 64 次全部失败，然后前进一个字符再来。

#### 改法，以及改法里唯一有讲究的地方

加一条边界断言 `(?<![A-Za-z0-9_.-])`：一段键字符的**内部**不再提供键名起点。

**断言必须放在可选引号之后**，写成 `(["']?)(?<![A-Za-z0-9_.-])` 而不是反过来。

而**我一开始给的理由是错的**，这一点是靠量出来的，不是想出来的。我先写了一条测试，
断言 `xx"api_key":"值"` 必须脱敏，然后把断言挪到引号前面——**测试照样绿**。
单测三条正则才发现：`xx"api_key":"V"` 这个形状，**上面那条转义 JSON 规则（247 行）已经覆盖**，
它两边都要带引号，先跑，先中。所以那个形状有两重覆盖，写错位置根本看不出来。

**只有一重覆盖的形状是「值里带转义引号」**，也就是值本身是个嵌套文档：247 行**按设计**拒绝它
（值能跨过 `\"` 正是它吞掉邻接敏感对的起点），tier A 也够不着（外层字符串自己不是 JSON）。
在那儿：

| | `xx"api_key":"va\"lue"` |
|---|---|
| 改前 | 匹配到 offset 2 → 脱敏 ✓ |
| **断言在引号前** | **一条都不匹配 → 值明文出网** |
| **断言在引号后** | 匹配到 offset 2 → 脱敏 ✓ |
| 247 行 | 不匹配（按设计） |

**一个性能修复把脱敏漏出去，是这次改动唯一不能碰的方向**，所以测试钉的是这个形状，
不是那个看起来更像回事的形状。

#### 等价性是查出来的，不是断言出来的

拿插件**自己的 153 个源文件**、191 个 20,000 字符窗口做差分，两种写法**每一个匹配位置都相同**。
合成边界集里只有两处分歧，都在「键名超过 `{1,64}` 上限」：旧写法会从串尾往回取 64 个字符当键名。
`isSensitiveKey` 是**锚定**的，所以那么长的键名在两种写法下都判为不敏感，**两边都原样返回**——
这是跑 `isSensitiveKey` 验的，不是我推的。

#### 数字

| | 前 | 后 |
|---|---|---|
| `redactPayload`，4 MiB 回复 | 2177.6 ms | **61.6 ms**（35×） |
| 同一条规则，20,000 字符 base64 | 10.2 ms | **0.17 ms**（61×） |
| `http.test.mjs` 全文件 | 25 个里 11 个 + 超时 | **25/25，1.97 秒** |
| `mutate-static-404.sh` | 30 分钟上限 SIGKILL | **8.10 秒，3 档全红** |

最后一行是这个发现的收口：**那 1 例失败和那个 `crash` 从来就是一件事**，
变异脚本每档都要跑一遍 http 套件，套件慢就变成脚本超时，脚本超时就被报成 `crash`——
一个**不是崩溃的崩溃**。「要不要放宽 30 分钟上限」这个问题问错了对象。

#### 成本测试里不写挂钟

代价断言没有用毫秒阈值，而是**比值**：同样长度、同样一遍扫描，一段有分隔符、一段没有，
断言前者不超过后者 3 倍 + 2 ms。机器快慢同时缩放两边，比值不变——**验收步骤的答案不取决于机器快慢**。

代价测试在修复前确实变红（200,000 字符：256 ms 超界）；引号测试在错误写法下确实变红。
两条都不是摆设。

#### 自己写进注释里的一个错误事实

代码注释里那句「挪到引号前面会让 `xx"api_key":` 的值明文出网」是我根据推理写的，
**被自己的测试证伪了**，真实原因是 247 行已经覆盖了那个形状。改注释的依据换成了实测的
嵌套文档形状和三个偏移量。**注释里断言一个没量过的事实，比不写更糟。**

### 8.46 第四轮评审是**对着当前 HEAD** 提的，而我差点漏掉它

复盘 PR #56 的时候，我先取到的是三轮 `CHANGES_REQUESTED`——按输出截断看，够写一份「三轮 13 条」的复盘。**第四轮存在**，2026-10-09，head `1857360b`，正是当时的 HEAD，状态也是 `CHANGES_REQUESTED`，而它被 `head -30` 截掉了。

先数条数再读内容。评审列表一共 5 条，其中 4 条是同一个人的四轮。

#### 四轮的 5 条：已修，但**零变异覆盖**

5 条都有实现、有测试（`test/review-round4.test.mjs`，16 例全过）。但把第 4 轮的修复关键词丢进变异脚本清单：

```
tasksOmitted            （无）
taskIndexTruncated      （无）
malformed               （无）
handleRpcEnvelope       （无）
TASK_LIST_MAX_ROWS      （无）
hasArtifactEvidence     unavailable-records
```

**测试全绿，而没有任何一档变异证明这些修复回归时会被抓住。** 这正是 §8.40「两个工具从未被变异证明过」的同一形状，换了一批对象——那一轮的教训是**零覆盖要靠脚本全集对比才发现**，这一次是先有评审清单、再拿清单去比对，才看见同一片空白。

补 `tools/mutate-review-round4.sh`，7 档，每档把评审描述的行为放回去，要求套件变红。

#### 第一跑：6 红，**1 存活**，而存活的那一档最有价值

```
RED      A a trimmed task page advances by the rows read        (pass=14 fail=2)
RED      B a page stopped on its look-ahead forgets …            (pass=15 fail=1)
RED      C an artifact that yielded no event is not evidence …  (pass=13 fail=3)
RED      D the task index cannot report being capped            (pass=15 fail=1)
RED      E omissions are counted against the read window …      (pass=15 fail=1)
SURVIVED F one request can materialise every row …              (pass=16 fail=0)
RED      G an empty batch is answered with an empty reply        (pass=15 fail=1)
```

F 存活，而 F 守的正是第 5 条缺陷的第一半：

```js
assert.ok(page.returned <= TASK_LIST_MAX_ROWS, …)
```

`returned` 是**回复里交付了几行**，缺陷说的是**读的时候物化了几行**。`TASK_LIST_MAX_ROWS = 262`，而字节预算本来就会把交付裁到 ~262——**读上限在不在，这句断言都成立**。测试量的不是缺陷发生的地方。

修法是让断言看**读被要求了多少行**：store 是真 `openStore` + 真 SQLite，把 `listBackgroundTasks` 遮蔽一层记录传入的 `limit`，再断言每次都 `<= TASK_LIST_MAX_ROWS`，并且第一条**自证**探针真的触发过（否则断言全是空转）。重跑 7/7 全红。

**夹具到不了的变异**在 §8.40 出现过一次，那次的处理是造数据；这次同一形状的处理是**换一个可观测的边界**。两个都是「测试是真绿的，只是没人看过那一面」。

#### 我自己新脚本里的一个反向缺陷

```
tools/mutate-review-round4.sh: line 172: fail: unbound variable
```

我漏了 `fail=0`。`check_red` 只**赋值**不初始化，全绿时它是未定义的——`set -u` 下摘要那一步直接中止并非零退出。**唯一应该报成功的那一次运行报了失败。**

这是 §8.43「守卫在缺依赖时静默变成空操作」的**反方向**：那一次是缺工具让守卫变成空操作还照样声称验过了；这一次是变量未初始化让干净运行变成红灯。前者更坏，但两者同源——**收尾那一步的失败方向，决定了这份证据是在保护你还是骗你**。查了其余 32 个脚本，只有我新写的这个缺。

#### MCP 接口：按模型会走的路重走一遍

真进程、stdio、真投影，13 次调用：

| 问题 | 工具 | 字节 | 耗时 |
|---|---|---|---|
| 找会话 | `trajectory_list` | 19.0 KiB | 25 ms |
| 这场在做什么 | `trajectory_find` | 0.6 KiB | 1 ms |
| **用户问了什么** | `trajectory_get`（不加 role） | **3023.5 KiB** | 346 ms |
| **用户问了什么** | `trajectory_get`（`role: 'user'`） | **19.1 KiB** | 7 ms |
| 哪一轮出问题 | `trajectory_turns` | 45.3 KiB | 561 ms |
| 后台任务 | `trajectory_tasks` | 88.4 KiB | 7 ms |

被测的那场会话有 **5,831 条记录，其中 11 条是用户消息（0.2%）**。§8.41 那个问题——「用户到底问了什么」——在真实数据上仍然是**一次 3 MB 的调用**，而加上 `role` 是 **19 KiB**，11 条中文提问直接可读。修的是真问题，不是夹具。

错误契约逐条也对：未知会话 `session_not_found`、未知工具 `unknown_tool`、`limit: 0` 被夹、负 offset 归零，以及**畸形行返回 `{"id":null,"error":{"code":-32700}}`**——后者我第一次量出来是「无应答」，那是**我的驱动只按自增 id 匹配**，服务端回的是 `id: null`，跟那条帧根本对不上号。驱动错，不是服务端错。

#### HTML 面板：真实投影全路由实扫

真 `openStore` 打真实数据库，逐条查状态 / content-type / nosniff / CSP / 4 MiB 预算 / 家目录泄漏 / 凭据泄漏：`meta`、`agents`、`sessions`、`search`、`overview`、`timeline`、`events`（summary / full / role / 翻页）、未知路由——**problems: 0**。栅栏四道全 403：缺 capability、**只带旧的固定头**、伪造 Host、cross-site。静态资源免 capability，`/js/nope.js` 与 `/../package.json` 都是 404。真 Chrome 全流程 exit 0。

**这份扫描第一跑报了两个 FAIL，两个都是扫描自己的期望写错了**：把「未知路由必须是 404」写成「必须是 200」；以及「只带旧固定头」那条我顺手把真 capability 也带上了，于是 200 是对的、403 才是错的。**验收步骤的失败先怀疑验收步骤本身**——和 §8.42 同一课。

#### 一处不对称：故意不改

`/api/events` 读 `id / detailLevel / offset / limit / turnId`，**不读 `role`**，所以 HTTP 侧传 `role=user` 会被静默忽略并返回全量——字节数与不加时一模一样。

量过之后**没有改**：`role` 是 §8.41 为 MCP 那一面加的，面板 `flow.js` 从不发它，文档也没有把 `/api/events` 的参数集当公开契约。HTTP 端点忽略未知 query 参数是常态，不是谎报。**它是一个不对称，不是一个缺陷**，记在这里是因为「静默吃掉的过滤器」在这个插件里有过前科（§8.44）——我看过，也判过，结论是那一条。

#### 与 CI 的关系（仍未闭合）

`1857360` 那次 CI 是绿的（ubuntu/macos/windows）。**§8.5 之后的全部工作至今没有进过 CI**，本节也一样。跨操作系统的结论目前来自 PATH 沙箱实验与推理，不是那台机器上跑出来的。这一条写在 §8.2 的表里，不是留给记忆。

### 8.47 第一次让 CI 看全部工作，它立刻抓到一处从未在本地出现过的回归

把 14 个提交压成一个推上去之后，CI 第一次跑到了 §8.5 之后的全部代码。它绿了三档，
**在 Node 22.13.0 上红了**：

```
compatibility assertion failed on Node 22.13.0:
  - 7 test(s) failed on a supported release
  - expected 1 skip(s) with FTS5 absent, saw 33
```

**这条线路上跑过的每一个 22.13.0 都是绿的**——因为 §8.18 那轮把它作为门禁跑过。
变了的是套件：`test/` 从 115 长到 753，**多出来的搜索用例全都依赖 FTS5**。

#### 第一行：7 个测试的前提假设了 FTS5 存在

| 测试 | 为什么失败 |
|---|---|
| `a word from the objective finds the session its title never mentions` | 靠索引按标题找，无索引就没有匹配 |
| `the search control: a session with no goal is still findable by its title` | 同上 |
| `objective matches ride on the page …` | 同上 |
| `an empty query is still an ordinary empty answer` | 它自己第一行就写着 `assert.equal(store.hasFts, true, 'this case needs a store that can search')` |
| `a runtime without FTS5 still finds a run by what it was asked` | **它靠 `DROP TABLE local_runtime_sessions_fts` 模拟无 FTS5**——而真无 FTS5 的运行时上那张表压根不存在，`DROP` 自己先炸 |
| `a healthy projection records no warnings at all` | store 正确地发了 `fts5_unavailable`，而这条断言是「一条警告都没有」 |
| `a task count that could not run is recorded …` | 断言恰好 1 条警告，多出来的那条正是上面那条 |

**七条全在测试侧，产品的每一次行为都是对的**：降级时说真话、不把缺索引说成「没有匹配」、
把无索引报成 `unsearchable`。CI 抓的是**测试的前提**，不是插件的行为。

前五条加 `{ skip: fixtureHasFts5() ? false : '…no FTS5' }`——它们的前提不可用，就该跳过。
第五条方向相反：它要**有**一张表才能 drop，所以没有 FTS5 时跳过，理由里必须写明 FTS5，
因为 `compat-matrix` 断言「每一个跳过都必须与 FTS5 有关」。

后两条**不跳过**。它们测的正是「读不了的时候有没有说真话」，而这恰恰是在缺 FTS5 的运行时上
最需要成立的行为——在那里跳过它们，等于用「健康路径的覆盖」换「降级路径的覆盖」。
改成**按名字滤掉**那条合法警告（`fts5_unavailable:`），并另加一条断言说明滤掉的这条在该运行时上
本就该在列表里。**按名字滤，不按位置滤**：滤「最后一条」会在 store 多发一条时把通过变成空转。

#### 第二行：坏掉的是工具自己，不是插件

```js
const expectedSkips = fts5 ? 0 : 1;   // 只在「恰好一个测试依赖 FTS5」时为真
```

33 个跳过全部与 FTS5 有关，**逐条检查那条就在下面、而且一直是对的**；错的只有这个数。
一个「允许跳过多少个」的**计数**，除了「以后永远别加测试」之外没法保持为真。

改成用理由表达：**有 FTS5 时一个都不能跳过；没有 FTS5 时每一个跳过都必须指名 FTS5**，
外加反向的一条——没有 FTS5 却一个都没跳过，也算问题，因为那说明降级路径在这里没被覆盖，
而「零跳过」读起来和「一切正常」一模一样。

#### 而这个工具**一个测试都没有**

判定逻辑原本内联在 `main()` 里，而文件末尾是裸的 `main()`——**import 这个模块会跑整套件**，
所以没有任何测试能碰它。唯一提到它的测试检查的是它不 import 依赖。

**「本该抓住谎报的那道检查，本身在撒谎」**，而它连被测的资格都没有。

抽出 `compatibilityProblems({ node, fts5, verified, suite })`，加 `import.meta.url` 入口守卫，
配 `test/compat-contract.test.mjs` 七例——其中一例就是 CI 报的**那 33 条**：照抄那次运行的形状，
断言它不构成失败。再补 `tools/mutate-compat-contract.sh` 六档，逐条拆掉契约的每一半，
全红。**六档全都是「判定变成通过」，不需要一个坏掉的插件才能暴露**。

#### 本地怎么复现的，以及复现不了的那一条

CI 跑的是 Node 22.13.0，本机没有。所以在临时副本里给 `ftsModuleAvailable` 加一个
`MTS_FORCE_NO_FTS5` 开关——**它同时决定夹具建不建索引表和 store 的 `hasFts`**，所以两侧一致。

第一次跑**逐条复现了那 7 个失败**，修完 0 失败。剩下的 `an FTS5 claim matches what this runtime
can actually do` 是**模拟自己的问题**：我把探针强制成 false，而本机 SQLite 真的能建 FTS5 表，
而这条测试的全部职责就是「探针必须与真实能力一致」——**它抓到了我的假探针**。
不打补丁时它通过，这一点单独量过。

**能造出来的假环境只能造到这里。** 剩下的 38 个跳过与 22.13.0 上会看到的完全一致，
而 `22.13.0` 是 `supported=true / verified=false`（量过），所以 `compat-matrix` 不会再报区间那条，
**exit 0**。

### 8.48 Windows 上的 40 个失败，四个根因，其中一个是我自己刚写进去的

CI 的 Windows job 被 25 分钟上限掐掉，但产物里留着 TAP：**678 个测试、40 个失败**。
按 `failureType` 分开看，只有 17 例是断言失败，其余 23 例是 `hookFailed`。

#### 23 例 `EBUSY`：夹具里从不关闭的数据库句柄

`new DatabaseSync(dbPath).exec(...)` 这种一行式句柄用完就丢，POSIX 允许删除打开的文件，
Windows 不允许，于是每个测试结束时的 `rm` 撞上 EBUSY。改成 `tools/fixture.mjs` 里的
`withProjectionDb` / `dropProjectionTable`，10 处 DROP 和 9 处一行式句柄全部迁移。

还有一处**顺序**问题：`fixtureDir(t)` 先注册 `t.after(rm)`，`harness(t)` 后注册
`t.after(stop + close)`。写 `/tmp/hook-order.mjs` 实测 node:test 的 after 按注册顺序 FIFO 执行，
所以 `rm` 必然先于 `store.close()`——**重试多少次都没用，close 还没执行**。
合成一个钩子按 stop → close → rm 走。

**这一类在 macOS 上无法实证**，只能靠结构与 CI 验证。

#### 17 例断言失败：四个根因，没有一个相同

**其一，入口守卫在 Windows 上恒为假。** ``import.meta.url === `file://${process.argv[1]}` ``
在 POSIX 上成立，在 Windows 上不成立——`argv[1]` 是带盘符的反斜杠路径，模板拼出的是
`file://D:\a\...`，而真的 `import.meta.url` 是 `file:///D:/a/...`。

后果正是这个工具存在的理由所反对的形状：`node tools/mutation-sweep.mjs --list` **打印空、退出 0**，
读起来和「没有脚本可跑」一模一样。同一个模式在 `tools/compat-matrix.mjs` 里也有一份。
`server/main.mjs` 早就是对的写法（`pathToFileURL(path.resolve(...))`），仓库里有现成范式。

**其二，`isWithin` 的分隔符。** 测试喂 `/a/data`，函数拼的是 `path.sep`。该函数的文档写明
**只接受规范化路径**，而所有调用方都先过 `realpath`，两侧同平台同拼法——所以是**测试越界**，
不是产品缺陷。改成按平台构造路径。

**其三与四是真缺陷，都关于盘符**：

| 现象 | 根因 |
| --- | --- |
| `scratchFiles: 0`（该是 1） | POSIX 临时根 `/tmp` 匹配不到带盘符的 `D:/tmp/...` |
| 路径折叠出 `D:~\ws\src\app.js` | 根写成 `/tmp/...` 不含盘符，折叠后盘符留在 `~` 前面 |
| `path: 'src/app.js'` 过滤到 0 条 | needle 用正斜杠，路径是反斜杠 |

前两条的**共同形状是「根没有盘符，路径有盘符」**，而这正是 Windows 上 `path.resolve`
给 drive-relative 根加上盘符的结果。修法都是「根没写盘符时，按位置比较」。

第三条最隐蔽：过滤器是**子串匹配**，而 needle 由读者敲、路径由宿主拼。

#### 我自己刚写进去的一个回归，被既有测试当场抓住

修折叠时先写成 `(?:[A-Za-z]:)?`，第一版套件就红了 5 条：
`sqlite_discovered:` 里的 **`d:`** 被当成盘符吃掉，产出 `sqlite_discovere~/.minimax/…`。

**红得很快，是因为套件里本来就有一条 `an embedded home path in a warning is collapsed too`。**
如果我为了这轮改动新建测试而不是先跑套件，这个回归会带着「12/12 通过」进提交。

三次改法才对，顺序不能颠倒：

1. `(?:[A-Za-z]:)?` —— 吃掉单词里的 `d:`
2. `(?:[A-Za-z]:[/\\])?` —— 组**消耗**了分隔符，而 variant 自己以分隔符开头，于是盘符没被吸收，`D:~` 留着
3. `(?:[A-Za-z](?=:(?=[/\\])))?` —— 分隔符跟在冒号后，**断言的是根的第一位**

而**冒号后必须有分隔符**这一条，又要靠**可选组无法锚定其后内容**才成立：组在 `D:x\...` 上放弃之后，
裸 variant 仍会匹配**路径内部**的根，产出 `D:x~\ws`——一个既不是该目录也不是任何真实东西的路径。
所以边界也得有：根前不能是路径名字符。

**这里有一个推不出来的结论**：`sqlite_discovered:` 里的 `d:` 和真盘符 `D:` 后面的字符**完全相同**
（都是一个字母、一个冒号、一个分隔符）。**没有任何 lookaround 能把它们分开**，因为在字符串里
它们就是同一串字符。唯一能做判定的地方是**往前看**：卷号不能在单词中间，所以
`(?<![A-Za-z0-9])` 放在字母**之前**才有效——放在冒号之后就只是在看根的第一位。

#### 一次我诊断错了的地方

先认定「CRLF 下门禁锚点静默失配」，给 `tools/release-gates.mjs` 加了 `readText` 并接到 9 处读文件上。
把整棵树转成 CRLF（158 个文件）做 A/B：**8 道门禁的结论一模一样**。
所有锚点恰好都容忍 `\r`——`indexOf("\n    case '")` 在 CRLF 上仍然命中，
`\blength\s*\(` 之类没有 `$` 锚的正则也不受影响。

**在没有证据之前写下的「修复」，和一个没有证据的诊断是同一种东西。** 撤掉，`git diff` 归零。

真正失败的两条在**测试自己身上**：`editTools` / `editMcp` 的锚点用字面 `\n`，
CRLF checkout 下 `block.includes('export const TOOLS = [\n')` 必为 false，
报的是 `the mutation anchor is gone from TOOLS`——**一个明明写着该字符串的文件说它没有**。
按 §8.45 的办法把树转成 CRLF 实测：修前 2 红（正是 CI 那两条），修后 11/11。

#### 门禁自己抓到的一个数

改完后套件 760/760 通过，而 `doc-test-counts` 报 `test/ declares 761`。
差的那 1 个是 `test/mutation-sweep.test.mjs` 里 `if (hasBash)` 的 `else` 分支——
**这台机器有 bash，所以那条永不执行**。门禁数的是声明数，与它的文档一致，
所以文档同步成 761 而不是 760。

**这一条不用修**：它在 `else` 分支里是对的（有 bash 就不该跑「没有 bash 时」的用例），
按平台跳过的形状和「循环内声明」不是同一件事，门禁的职责只到声明数为止。

#### 一档死了，而它死的样子是「绿色」

改完跑全变异扫：**208 RED / 1 problem**。那一档报 `anchor-missing: server/changes.mjs` ——
I 档的锚点钉在我替换掉的那一行上，因为过滤器改用了 `matchesPathNeedle`。

**锚点失效的档位不产出任何证据。** 它在 tally 里是 0，而那个 0 与测试无关：
换成任何别的写法它都是 0，只是这次报了出来。扫之所以能说出这件事，
是因为它给每一类问题单独命名，而不是只数 RED 和存活。

补档时发现两处真空：

- I 档重锚到调用点（**同一个变异，只是换了施加的位置**）
- `server/redact.mjs` 的 `foldHomePaths` **一个档位都没有**。`mutate-tail-direction.sh`
  也改这个文件，但它只跑 `test/tail-direction.test.mjs`——那个文件从不读折叠后的路径。
  **插件每一处出口都依赖的函数，只被测试自己的读法覆盖着。**
  新建 `tools/mutate-home-folding.sh`，跑三个文件：折叠契约、不得损坏周围文本、可移植路径。

#### 写出来又删掉的两档

折叠先写了四档，其中两档 **SURVIVED**（71 条全绿）。量出来的原因是重叠覆盖：
卷号周围的两个 lookaround，在组件边界存在时**都是多余的**——
variant 必然以分隔符开头，所以「冒号后有分隔符」已经被后文保证；
卷号也不可能从单词中间起步，那正是组件边界禁止的。

**改对改错都绿的档位不是证据，是一个看起来像覆盖的数字。** 两档都删掉，
并在脚本里写明它们各自为什么多余、以及去掉组件边界时该怎样一起加回来。

顺带一个坑：heredoc 会加尾随换行，所以不以行尾结束的锚点片段**永远**匹配不上，
报的还是 `anchor-missing`——读起来像源码变了。`anchor_inline` 就是为这个存在的。

**214 RED / 0 存活 / 0 problems / 36 脚本**，跑完 `shasum -c` 校验 162 个文件逐字节还原。

#### 第二轮 CI：40 → 12，而这 12 例里有两例是我自己写的

Windows job 跑完（不再被 25 分钟上限掐掉），TAP 里 **748 通过 / 12 失败**。
上一轮把 23 例 EBUSY 修掉之后，剩下的仍然全是句柄，但**是三种不同的形状**：

| 形状 | 例数 | 表面 |
| --- | --- | --- |
| 回调拿到的句柄没人关 | 5 | `damage(new DatabaseSync(dbPath))` |
| `t.after` 注册顺序颠倒 | 4 | 后注册的 close 排在先注册的 rm **之后** |
| store 压根没关 | 1 | 只注册了 `rm` |

**形状一**读起来像「句柄是回调的事」，而回调从不拥有它——句柄属于夹具，没人关。
POSIX 能删打开的文件所以看不见，Windows 拒绝，于是 5 条测试全部在拆除时报 EBUSY，
而**被测代码完全没问题**。

**形状二**是 FIFO 的另一面：`finish(store)` 先注册、`broken.close()` 后注册，
于是 rm 先跑。**正确的顺序在所有这些测试里都是同一个**，所以写成一次、第二个
`t.after` 根本不再注册。

**形状三**里那个测试自己写了注释说「Close before removing」，却只注册了 `rm`。

另外两例是**我这一轮新写的测试自己有平台假设**：

- `the guard spelling …` 用 `path.join(path.parse(process.cwd()).root, …)` 造「POSIX 样本」，
  在 Windows 上造出来的是 `\\srv\\repo\\…`——**一个贴着 POSIX 标签的 Windows 路径**，
  于是「POSIX 上两种拼法一致」这条断言**恰恰在最需要它的平台上失败**。
  样本既然按平台命名，就必须用那个平台的 `path.posix` / `path.win32` 造。
- 期望值里写死了 `/tmp/run/apply.py`。那个字段是**绝对路径**，绝对路径照样过
  `path.resolve`，照样带上宿主卷号。**写死字面量等于断言一个本平台产不出的文件**。

顺带把同一个测试里一处**空断言**改掉：它把 `pathToFileURL(path.resolve(x)).href`
和它自己比，对任何输入都为真——包括坏的那一个。现在断言的是产出的 URL 以 `file:///`
开头，也就是 `import.meta.url` 真正具有的形状。

**CI 的失败清单对这一版提交是穷尽的**：Windows 上每出现一次这个形状就报一次 EBUSY，
所以这 12 例就是全部。修完再推，由 CI 复核。

---

## §8.49 门禁全绿，缺陷却漏到了插件外面

### 主工作流是绿的，仓库级门禁不是

`mcode-trajectory-studio.yml` 压成一次提交后，run `38206477803` 七个 job 全绿：
`contract gates`、`suite`（ubuntu / macos / windows）、`engines`（24 / 22.19.0 / 22.13.0）。

但同一个 head 上还有另外两个工作流，其中 `CI` 的 `validate` 是红的。
它的 1118 例里**只有 1 例失败**：

```
not ok 1051 - package is plain: ASCII paths, no symlinks, no executable bits, no BOM
```

读完整日志（先数 `not ok` 条数再读内容，而不是 `tail`）拿到的是宿主仓库
`tests/plugins/mcode-trajectory-studio/smoke.test.mjs` 的
`package is plain: …`，断言是 `assert.equal(st.mode & 0o111, 0)`。

`git ls-files -s` 在插件下数出 **17 个 `100755`**：`tools/mutate-*.sh`。
其中 16 个的时间戳早于这一轮，只有 `mutate-home-folding.sh` 是新写的——
**说明这不是「新脚本忘了改权限」，而是一批脚本长期带着这个位而没人看**。

### 为什么本地门禁一条都没抓到

这是本节真正要记的东西。逐条问「这道门禁为什么看不见」：

| 门禁 | 为什么看不见 |
|---|---|
| 其余七道 | 读的是文件**内容**（版本号、引擎声明、SQL 字面量、文档计数），从不 `lstat` |
| 套件 763 例 | 每个脚本都以 `spawn('bash', [path])` 启动（`tools/mutation-sweep.mjs` 的 `run()`），**从来不依赖那个位** |
| 脚本之间 | 用 `. tools/mutation-lib.sh` 源入，`source` 不需要可执行位 |
| 变异扫 | 只看每个档位「能不能变红」，一个被 chmod 成 755 的脚本照样全红 |

**这 17 个位对插件的任何一项功能都是惰性的**，所以没有任何一条以「功能
是否正确」为判据的检查有理由发现它。唯一一个以「这份产物长什么样」为判据的检查在
插件外面，而它是在插件自己的门禁已经盖过章之后才说话的。

结论不是「再加一个门禁」，而是：**插件的可发布性判据不该全部由行为测试承担**。

### 修法与它自己的证据

修掉是两步，都必要：

1. `chmod -x` + `git update-index --chmod=-x` 剥掉 17 个位（内容零改动，
   `git diff --cached --stat` 显示 `17 files changed, 0 insertions(+), 0 deletions(-)`）。
2. 新增第 9 道门禁 `package-plainness`（`tools/release-gates.mjs`），对
   `walkPlugin()` 走出来的每个文件做一次 `lstat`：符号链接和 `mode & 0o111`。

为什么门禁读**文件系统**而不是问 git：发出去的是文件本身；一个问 git 的门禁会在
「检出时已经丢了 mode」的那次运行上照样通过。仓库级那条检查才是对**已提交状态**
的判据，两者各管一段。

门禁带两条红路径测试（`test/release-gates.test.mjs`），并且做过 A/B：
把 `package-plainness` 那段从文件里摘掉（1802 字符、1 个 `await gate(`），
两条测试**同时变红**；`cp` 回备份后 `shasum -c` 确认逐字节还原。
「不红的测试不是护栏」这条在这里是可验证的，不是原则。

测试用 `chmod` 而不是「写一个带权限的夹具文件」，理由写在测试注释里：
**mode 才是缺陷本身**，一个不带执行位的新建文件会通过这道门禁，什么也证明不了。

### 顺带修掉的一处悬空承诺

门禁文件头部那份清单只列了 1–7，而实际有 8 道：`doc-tool-count` 从来没被列进去。
这正是本节的主题的另一个形状——**清单和实际不符**，只是这次漏的是一行文档而不是
一个权限位。补齐后重新编号，`doc-test-counts` 随即要求把文档里的 761 同步成 763。

### 计数：声明 763，执行 762

`compat-matrix` 实测 `tests=763 pass=763`，README 那张表写的就是这个数。
本机直接跑套件是 **762**，差的一条是 `test/mutation-sweep.test.mjs` 里
`if (hasBash)` 的 `else` 分支——本机有 bash，所以那条永不执行（§8.48 末已记）。
**声明数与执行数不是同一个数**，门禁比对的是前者，所以文档写 763 是对的；
但把 `node --test` 的输出抄进文档就会写成 762。

### 推上去之后：Windows 红的正是我刚写的测试

`86c04fe` 上 `CI`/`validate` 与 CodeQL 都绿了，主工作流的 `suite (windows-latest)` 红了。
从产物 `trajectory-suite.tap` 数：`762 tests / 761 pass / 1 fail / 0 skipped`，
唯一的 `not ok` 是

```
not ok 500 - the package-plainness gate rejects a shipped file carrying an executable bit
```

失败信息是 `the gate accepted an executable shipped file`。**门禁没错，错的是测试的前提**：
Windows 的 `chmod` 只切换只读属性，`stat.mode` 不携带执行位，所以
`stat.mode & 0o111` 对**任何**文件恒为 0。于是：

- 门禁在 Windows 上**正确且沉默**——它找不到东西，是因为那里没有东西；
- 而「把文件 chmod 成 0o755 然后期望门禁发现它」这条断言，
  **任何 Windows 文件系统都产不出它需要的那个状态**。

这和 §8.48 那两例「我自己新写的测试带平台假设」是同一类：**上一轮刚记完的教训，
下一轮自己又踩**，而且踩的是同一形状——把一个只在某平台成立的事实当成普遍事实。

修法是加 `skip`，但**跳过条件本身必须可证伪**，所以它不是 `process.platform !== 'win32'`
而是去问文件系统：

```js
await writeFile(probe, 'x');  await chmod(probe, 0o600);
const withoutExecute = (await lstat(probe)).mode & 0o100;
await chmod(probe, 0o700);
const withExecute    = (await lstat(probe)).mode & 0o100;
return withoutExecute === 0 && withExecute !== 0;
```

测试需要回答的不是「这是不是 Windows」，而是「这里能不能造出一个可执行文件」，
**只有后者是那条断言真正依赖的前提**。写死平台名等于在一处无法失败的地方
又断言了一次环境。

这条路径也做过 A/B：把探针强制成 `false`，测试 12 变成
`# SKIP this filesystem keeps no POSIX permission bits…`，其余 12 例仍绿——
即跳过是**说明机器**而不是**让套件变红**。符号链接那一条**不需要跳过**
（Windows 上符号链接照样建得出来），CI 上它是 `ok 501`。

---

## §8.50 声明了却从没跑过的 Node 大版本

第五轮评审只提了一个阻断项，但它指向的是一个结构问题：
**插件的 `VERIFIED_RANGE_TEXT` 写着 `>=22.19 <23 || >=24 <27`，而 CI 的引擎矩阵只有 22 和 24。**

`>=24 <27` 覆盖 **24、25、26** 三个大版本。25 与 26 从来没有对应过任何一个 job。

### 评审报的那个失败，我能一字不差地复现

评审给的是：`test/containment-attacks.test.mjs` 里有一处 `openContainedRead(...)`
只取真值、丢掉返回的 `FileHandle`；Node 26 在垃圾回收时关闭句柄会**报错**
（22/24 只是弃用警告），于是测试结束后冒出异步活动。

装上 Node 26.12.0 跑那个文件：

```
ℹ tests 11 / ℹ pass 10 / ℹ fail 1
ℹ Error: A resource generated asynchronous activity after the test ended. … "A FileHandle
  object was closed during garbage collection. … Please close FileHandle objects explicitly.
  File descriptor: 14 (…/sess-a/messages.jsonl)"
```

**11 = 10 个子用例 + 1 个文件级失败**，与评审报的 10 pass / 1 fail 是同一件事。

我没有只按描述改，而是先把全部 `openContainedRead` 调用点核了一遍：

| 调用点 | 所有权 |
|---|---|
| `test/containment-attacks.test.mjs` 的符号链接根测试 | **只取真值，句柄丢弃** |
| 同文件的 `the session artifact itself is readable` | `try/finally` 里 `opened.handle.close()` |
| `test/containment.test.mjs` 的 `/proc` 测试 | `try/finally` 里关闭 |
| `server/tasks.mjs` 的任务输出 | `try/finally` 里关闭 |
| `server/jsonl.mjs` 三处 | 句柄交给 `createReadStream`，`finally` 里销毁 |

**只有一处**，评审的定位准确，其余（含 server 侧两处）都正确。改完 Node 26 上
`10 pass / 0 fail`，全量 `762 / 0 fail`。

### 25 也在声明范围里，同样没有 job

评审只提 26，是因为缺陷出现在 26。但同一条论证对 25 完全成立：
范围既然写了 `>=24 <27`，读者就会把 24 以上的每一行都当成被承诺过的。

所以 25 和 26 一起加进矩阵（`22.13.0`、`22.19.0`、`24`、`25`、`26`）。
加之前两版都实测过，不是假设：

| Node | 内置 SQLite | FTS5 | compat-matrix |
|---|---|---|---|
| 25.9.0 | 3.51.3 | 存在 | `tests=763 pass=763 fail=0` exit 0 |
| 26.12.0 | 3.54.0 | 存在 | `tests=763 pass=763 fail=0` exit 0 |

两个值都写进了 `server/node-version.mjs` 的实测表和两个 README —— 那个文件的前提
就是「measured rather than assumed」，新测的版本不记进去等于白测。

### 让这条不再靠人记

`tests/plugins/mcode-trajectory-studio/smoke.test.mjs` 里加了一条：
从 `server/node-version.mjs` 读出 `VERIFIED_RANGE_TEXT`，把每个 `>=X <Y` 子句展开成
它承诺的大版本集合，再从 workflow 里读出矩阵，断言前者是后者的子集。

范围是**解析出来的**而不是抄进来的。旁边同时写死 `>=24 <27` 和 `24, 26` 的那种检查，
正是某天一个改了另一个没改却仍然绿的检查。

它落在仓库侧而不是插件门禁里，是因为门禁的根是 `PLUGIN = tools/..`，**刻意读不到
仓库的 workflow** —— 插件是独立安装的，这是对的取舍。代价是「矩阵 vs 声明范围」
这条不变量没人管，于是它归仓库自己的测试管。

变红验证：把矩阵里的 `'26'` 删掉，那一条立刻报
`the Plugin claims Node 26 but the CI matrix never starts one (matrix covers 22, 24, 25);
add the job, or narrow VERIFIED_RANGE_TEXT`，恢复后 `shasum -c` 确认逐字节还原。

### 记下来的一句

**绿的 22 和绿的 24 不能证明任何一个没有 job 启动过的版本。**
这不是 Node 26 特有的性质，只是 Node 26 让它显形了 ——
把 GC 里关闭句柄从弃用警告变成错误，等于把「一直泄漏、只是没人报」变成了「会报」。

---

## 附录 A：本机环境事实
```
dsh         0.1.5-rc.1   (~/.nvm/versions/node/v24.19.0/bin/dsh)
mcode       0.4.12
node        v24.19.0
sqlite3     3.45.1
数据根       ~/.minimax  (MAVIS_DATA_DIR / MINIMAX_DATA_DIR 均未设置)
SQLite      ~/.minimax/v2/sqlite/runtime-state.sqlite  2.5 GB (+17 MB WAL)
会话产物     ~/.minimax/v2/sessions/YYYY/MM/DD/<ts>-<sessionId>/
上游仓库    MiniMax-AI/MiniMax-Code-Plugins
```

## 附录 B：dsh 相关包（对标参考）

```
dsh-client-ui-trajectory        UI 视图（轮次表 + 时间概览 + 检查器）
dsh-session-stats               turns/steps/llmMs/toolMs/ttftMs/decodeMs
dsh-session-turn-outline        轮次导航（prompt/response 预览）
dsh-session-projection          客户端读模型注册表
dsh-session-query-sqlite        FTS5 全文检索（独立派生库）
dsh-session-telemetry(-otel)    遥测捕获 seam
dsh-compaction                  压缩 seam
```