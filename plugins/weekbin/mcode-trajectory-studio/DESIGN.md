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
- `src/http.mjs` → 本地 `http.createServer`，服务 `web/index.html` + `app.js` + `style.css` + `/api/*`
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
│   ├── SKILL.md                  # 顶层（0.4.0+）
│   └── mcode-trajectory-studio/
│       └── SKILL.md              # 字节一致副本（0.3.x & 校验器）
├── server/
│   ├── main.mjs                  # 入口：--stdio（默认） / --serve / --doctor
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
| `trajectory_list` | 列出最近会话（元数据，无正文） | `limit`、`agent`、`since` |
| `trajectory_summary` | 单会话统计：turns / steps / llmMs / toolMs / decodeMs / tokens / 压缩数 / 工具调用数 | `sessionId` |
| `trajectory_get` | 分页读取事件记录（轮次分组） | `sessionId`、`offset`、`limit`、`detailLevel` |
| `trajectory_search` | FTS5 全文检索 | `query`、`limit` |
| `trajectory_studio` | 启动/复用本地 HTTP 面板，返回 URL | `sessionId?`、`port?` |

隐私默认：`detailLevel=summary` 不带正文；`full` 需显式请求，且结果经脱敏 + 长度封顶。

### 6.4 HTTP 面板（Studio）

对齐 dsh Trajectory 的观感：

1. **顶部 Overview 时间条** — 按 `created_at_ms` 投影真实开始/耗时；助手条区分「思考段」与「输出段」（用 `thinking_duration_ms` vs `request_duration_ms - thinking_duration_ms` 近似 dsh 的 TTFT/解码双色）；悬停显示精确耗时
2. **轮次记录表** — 按 `turn_id` 分组，标注轮次/步骤边界、请求编号、累计 token
3. **检查器** — 点开一条：token 用量（input/output/cache/total）、`request_duration_ms`、`thinking_duration_ms`、工具入参、工具结果、状态
4. **筛选** — 按 `source`（api/thread-goal/questionnaire/background-task/task）、按角色、按工具名、仅失败
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
  JS 字符串。**这里必须按字节而不是字符计**：`length()` 作用在 TEXT 列上返回的是字符数，
  于是一条 4 字节码点的行会以四分之一的体量通过字节上限，然后被完整解析并返回——上限恰好
  放过了它要拦的那种行。CAST 成 BLOB 后 SQLite 直接读记录头里的字节长度，比逐字符扫描更便宜
- **分页游标按“已投递记录数”推导**，不是按“已读取记录数”。聚合字节预算会把一页裁短（1000 条
  裁到 209 条），此时若回传读取层的 `nextOffset`（1000），客户端会永久跳过 209-999 这些
  记录——预算生效了，会话却是不完整的。裁剪发生时游标取 `offset + 已投递条数`
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
├── skills/SKILL.md               顶层 Skill（0.4.0+）
├── skills/mcode-trajectory-studio/SKILL.md   字节一致副本（0.3.x + 校验器）
├── server/
│   ├── main.mjs    入口：stdio / --serve / --doctor
│   ├── store.mjs   数据层：SQLite 只读 + messages.jsonl 兜底
│   ├── mcp.mjs     MCP JSON-RPC + 6 个工具
│   ├── http.mjs    本地面板 + /api/* + 安全栅栏
│   └── redact.mjs  脱敏与长度封顶
├── web/
│   ├── index.html
│   ├── app.js      缩放/平移时间轴、轮次表、检查器、筛选
│   └── style.css
└── test/store.test.mjs           18 个测试
```

**零依赖**：仅用 Node 标准库（`node:sqlite` 要求 Node 22+，本机 24.19.0 验证通过），无构建步骤，无 `node_modules`。

### 8.2 验证结果

| 验证项 | 结果 |
|---|---|
| `npm run validate`（仓库校验器） | `OK plugin weekbin/mcode-trajectory-studio`，29 个插件全通过 |
| `npm run check`（全仓库 363 测试） | **363 pass / 0 fail** |
| 插件自带测试 `node --test` | **18 pass / 0 fail** |
| MCP `initialize` / `tools/list` / 6 工具调用 | 全部返回有效结果，真实数据 |
| `--doctor` 真实数据 | 500+ 会话可见，SQLite + FTS 均可用 |
| HTTP 面板（Playwright 实开） | 渲染正常，无 console 错误 |
| 安全栅栏 | 缺自定义头 → 403；伪造 `Host` → 403 |
| 时间概览缩放 | 滚轮 184m→19m52s，标尺重算，91 条条形可见 |
| 检查器 | 计时 / Token / 上下文 5 段分解 / 思考 / 工具入参 / 结果 全部渲染 |
| 正文开关（`full`） | 正确加载入参、结果与完整文本 |

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
| 默认显示正文，溢出单行省略，点开侧边栏看详情 | `detailLevel` 默认改为 `full`；记录行 `white-space: nowrap` + `text-overflow: ellipsis`；空正文时依次回退到思考内容、工具名，不再显示「（无正文）」；点击行打开右侧检查器 |
| 后台任务/子代理不能展开、看不出作用 | 改为可展开卡片：任务 ID、起止时刻、耗时、所属轮次、执行模式、子代理名、工具调用 ID、子会话 ID、完整命令、**输出日志尾部**（`~/.minimax/background-tasks/<id>/output.log`，最多 16 KiB），以及三个操作：查看输出 / 打开子会话轨迹 / 定位调用记录 |

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

修复后 5 种宽度（2560 / 1760 / 1440 / 1280 / 1100）下：溢出 0、正文越界 0。

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
