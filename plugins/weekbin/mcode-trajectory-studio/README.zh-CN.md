[English](README.md) | **简体中文**

# MCode Trajectory Studio

> 本地 MiniMax Code 会话的只读"飞行记录仪"，数据取自运行时自身的 SQLite 投影，
> 并附带一个可交互的本地 Studio 面板。

MiniMax Code 的本地运行时会为每个会话在 `<dataDir>/v2/sqlite/runtime-state.sqlite` 维护一份
SQLite 投影。本插件严格按照只读方式读取该投影，并将其转化为结构化的轨迹摘要与可浏览的时间轴
——从而无需打开原始会话文件，就能回答"这次花了多久""时间花在哪里""哪些工具运行过、哪些失败了"
"有多少轮、多少步""上下文预算用在哪里""压缩（compaction）何时发生"以及"派发了哪些子代理"。

## 试一试

```text
用 mcode-trajectory-studio 技能总结我最近更新的会话：
轮数、步数、LLM 与工具的墙钟时间、工具失败数，以及压缩（compaction）。
```

预期结果：agent 调用 `trajectory_summary`，汇报折叠后的统计值，并将 `ttftMs` 标注为不可用，
而不是对它进行估算。

```text
打开该会话的 Trajectory Studio 面板，让我自己看时间轴。
```

预期结果：agent 调用 `trajectory_studio`，拿到一个 `127.0.0.1` URL，并在宿主浏览器中打开。
面板显示时间总览、每轮记录表、每条记录的检查器、过滤器，以及后台任务列表。

## 能力

| 工具 | 用途 |
|---|---|
| `trajectory_list` | 最近的会话及其非内容元数据；可按 agent、kind 或时间过滤 |
| `trajectory_summary` | 等价于 dsh `sessionStats` 的折叠：轮数、步数、`llmMs`、`toolMs`、`decodeMs`、token、工具调用与失败、压缩、子代理、资产、触发来源 |
| `trajectory_get` | 分页的轨迹记录；`summary` 或 `full` 详情 |
| `trajectory_search` | 对标题、agent、状态和工作区路径做全文检索 |
| `trajectory_tasks` | 后台任务与子代理派发，含状态、耗时、命令或目标、子代理名、子会话 ID |
| `trajectory_task_output` | 某个任务捕获输出的有界尾部 |
| `trajectory_studio` | 启动或停止本地 Studio 网页面板 |

Studio 面板不是一摞行的堆叠，而是一段叙事。每个界面只回答一个问题，且不重复另一个界面的答案：

| 界面 | 回答的问题 |
|---|---|
| **Agent 与能力** | 此会话配置了什么——模型、工具白名单、技能、系统提示词 |
| **统计条** | 会话总量是多少——轮数、步数、LLM/工具/解码墙钟时间、token、失败数 |
| **时间轴** | 在时间上发生在何处——仅导航与缩放，不含文字 |
| **轨迹流** | 发生了什么——每条消息、每次工具调用一行，可快速扫读 |
| **检查器** | 恰好选中那一行的完整细节 |

- **侧边栏**是一棵极简的树。会话按 **git 仓库**分组，而非按路径：
  `git rev-parse --git-common-dir` 把一个项目的所有 worktree 折叠进同一个可折叠分组，因此长期
  存在的仓库不会在侧边栏里被打散。不在 git 树内的目录回退为按路径分组。**子代理会话递归嵌套在
  派发它的会话之下**，并带一个 caret 可展开——于是一次扇出读作一棵树，而不是一串长得一样的任务
  会话。行内只保留 caret 和标题；agent、分支、工作区和时长放在 tooltip 里，展开状态跨刷新持久化。
- **时间轴**使用三条共享同一可缩放坐标轴的泳道——`INPUT`（人类消息为蓝色，框架注入的上下文为
  紫色）、`MODEL`（请求拆分为思考段与输出段）和 `TOOLS`（已测量的任务区间为橙色，按记录间距
  推导出的空隙为灰色并标注为"推导"）。滚轮缩放，拖拽平移，双击复位。
- **侧边栏行整行可切换**，而不仅是 caret：点击折叠的父行会选中并展开它，点击已选中且展开的父行
  会折叠它。agent 过滤器是一个下拉框，其选项从数据中读取（`mavis`、`verifier`、`explore`……
  即该机器上实际配置的值），因为子代理预设因安装而异。
- **轨迹流**把消息与工具调用合并成一段叙事：`TOOL bash ▸ {载荷} ⇉ {结果}`，带已测量的耗时、
  子代理的 agent 徽标，以及一键跳进子代理自己的会话。注入的上下文在视觉上有别于用户键入的
  内容。可按人类输入、注入上下文、工具调用或仅失败过滤；也可按轮次 ID 或文本过滤。
- **主题**：浅色与深色，默认跟随系统，一键切换。全局 2px 紧凑圆角，细滚动条同时通过标准属性
  和 WebKit 伪元素实现。
- **轮次标题以人类序数打头**（`第 3 轮`），并把运行时的 turn ID 作为次要文字保留。
- **性能**：轨迹流渲染 150 行并在滚动时追加下一批；行有缓存且过滤从不重建 DOM；文本过滤做了
  防抖；轮次总量在服务端折叠，因此分页视图仍显示整轮数字。一个 600 行会话的切换从约 700 ms
  （含 227 ms 主线程卡顿）降到约 120 ms（无卡顿）。超大会话（1 万条以上记录）另有问题：统计
  折叠会在相关子查询里重新解析每一行的 JSON，因此现在改为在单次 join 中展开 `tool_calls`，并按
  会话的 `updated_at_ms` 缓存折叠结果——复访只需 1 ms，而非 383 ms。记录改为从服务端分页
  （每次 200 条），而不是一次取回 1000 条含完整内容；时间轴读取一份独立的紧凑投影，因此坐标轴
  始终覆盖整个会话。
- **检查器**是分页式的：概要（层级、状态、token 用量、上下文拆分）、载荷（工具参数或消息正文）、
  结果（结果文本加一块**失败证据**）、计时（记录时刻、请求/思考/解码耗时，以及工具耗时是
  "已测量"还是"缺失"）和 Schema。
- **失败定位**是一等公民：标题栏带一个 `⚠ N 处失败（定位）` 跳转，轨迹流内联标记每处失败，
  结果页把**硬**失败（Traceback、stderr、`is_error`）与**软**失败（非零退出码，往往只是 `grep`
  没找到东西）分开。一次调用可能报告成功，但其输出里含 Traceback，因此分类读的是文本，
  而不只是状态码。

## 读取哪些数据

| 来源 | 路径 | 用途 |
|---|---|---|
| SQLite 投影 | `<dataDir>/v2/sqlite/runtime-state.sqlite` | 主要来源。以 `mode=ro` 打开；绝不写入。 |
| 会话产物 | `<dataDir>/v2/sessions/YYYY/MM/DD/<stamp>-<id>/messages.jsonl` | 投影尚未索引的会话的兜底，以及投影字段缺失时的内容来源。 |

`<dataDir>` 按此顺序解析：`MINIMAX_DATA_DIR`、`MAVIS_DATA_DIR`，然后是 `~/.minimax`——其中
`~` 取 `HOME`，Windows 上取 `USERPROFILE`。位置没有任何写死。

在数据目录内部，插件先尝试规范布局 `v2/sqlite/runtime-state.sqlite` 与 `v2/sessions`，
再按一小串备选布局回退，因此即使某个构建把文件放在别处也仍可读取。命中非规范布局会以
warning 显式报告而不是静默通过；`--doctor` 会打印本机实际打开的路径。

### 值得了解的字段

- `usage.request_duration_ms` —— 每次请求的模型墙钟时间（`llmMs`）。
- `thinking_duration_ms` —— 每条记录的思考阶段耗时。
- `tool_calls[].tool_call_args`、`tool_call_result_data`、`tool_call_status` —— 工具输入、输出和
  状态（状态非 `2` 即为未成功）。
- `local_runtime_background_tasks` —— `created_at_ms`/`ended_at_ms` 给出精确的工具与子代理墙钟
  时间（`toolMs`）。
- `kind: compaction` 记录携带 `messagesBefore`/`messagesAfter` 与
  `tokensBefore`/`tokensAfter`。
- `context_usage.components` —— 每次请求对 SYSTEM_PROMPT / MEMORY / TOOLS / SKILLS / MESSAGES
  的拆分。
- `source` —— 触发模型调用的来源：`api`、`thread-goal`、`questionnaire`、`background-task`、
  `task`、`agent`、`greeting`。
- `local_runtime_sessions_fts` —— 覆盖会话元数据的 FTS5 索引。

## 诚实的局限

- **运行时并不持久化首 token 时间（TTFT）。** `ttftMs` 恒为 `null`，且从不估算。Studio 总览
  改用"思考段 vs 输出段"来呈现。
- **`decodeMs` 是近似值**：`Σ(request_duration_ms − thinking_duration_ms)`。
- `local_runtime_*` 表属于运行时内部细节。每张可选表、每个可选列和 JSON 字段在使用前都会被
  探测，缺失时降级为 `null`；未来的运行时变更应降低保真度，而不是让插件崩溃。若 SQLite 不可读，
  插件回退到 `messages.jsonl`，那里没有计时字段。
- 工具墙钟时间只对运行时记录为后台任务的调用可用；因此 `toolMs` 覆盖的是这些调用，而非每一次
  内联调用。
- 投影在会话写入时建立索引。极新的会话可能尚未出现；JSONL 兜底覆盖这种情况。
- **即便只读打开，SQLite 也需要数据目录可写**：WAL 数据库要求 `-shm` 文件存在。若数据目录位于
  只读挂载上、或属于其他用户，投影将无法打开：插件会报
  `sqlite_unavailable:attempt to write a readonly database` 并回退到 `messages.jsonl`，此时计时
  字段缺失。另一个进程正在写入的活跃 WAL 库可以正常并发读取。

## 隐私

- 本插件是**只读**的：绝不写入、移动或删除会话存储，也不创建任何自身文件——它不落任何磁盘状态。
- Studio 面板**仅绑定 `127.0.0.1`**，且该地址是常量、没有任何覆盖途径：任何环境变量、参数或
  配置项都无法把监听面放宽。
- 每个 API 路由都要求**访问凭据（capability token）**：随进程用 CSPRNG 新生成 256 位熵，通过
  URL 的 fragment（`#t=…`）交给调用方，仅存在于该 MCP server 进程的内存中，从不写入磁盘。
  由此有两点值得留意：
  - fragment 不会发往服务端，所以凭据不会进入请求日志、不会出现在静态资源的 `Referer` 里，也
    不会被服务端回显。请**原样**打开返回的 URL——去掉 `#t=…` 只能加载页面外壳，读不到数据。
  - mcode 每个会话启动一个 MCP server，因此两个会话会得到两个面板、两份凭据，一个会话的 URL
    无法打开另一个会话的面板。
- Host 校验、Origin 校验与 `Sec-Fetch-Site` 校验仍然保留，但它们**是 CSRF 栅栏而非授权**：它们
  挡的是网页，不是本机进程。真正挡住本机进程的是访问凭据。静态资源附带默认拒绝的 CSP
  （`script-src 'self'`、无内联脚本、无远程源），页面每个节点都用 `createElement` 构建、用
  `textContent` 写入——会话正文永远是文本，不会变成标记。
- `summary` 详情不返回任何消息文本、思考、工具参数或工具结果。
- `full` 详情需显式开启，并经过一个**两层**的密钥脱敏器。凭据在磁盘上的真实形态是「JSON 文档存在
  JSON 字符串里」——工具结果在 `tool_call_result_data` 里是**文本**字段（真实投影中 118,109 行有
  109,462 行如此），到达脱敏器时已经转义成 `{\"api_key\":\"…\"}`：
  - **A 层（结构化）**：字符串值若本身能解析为 JSON，就再按结构化数据走一遍按键名判定。只有真的
    脱掉了东西才重写该字符串，否则原样返回——面板里那些 JSON 工具结果不会因为脱敏而被重新排版。
  - **B 层（转义感知的文本规则）**：键值规则允许分隔符带任意层反斜杠并原样回填，因此即使文本不是
    合法 JSON（截断、混排正文）也能命中。
- 文本规则覆盖：私钥块、连接串内联凭据（含密码里本身带 `@` 的情况）、整个 `Authorization` 头、
  裸 scheme+token、provider 前缀 key（`sk-`/`ghp_`/`glpat-`/`xox*` 等）、定长 token
  （`github_pat_`/`npm_`/`hf_`/Google `AIza`/`ya29.`）、AWS key id、Azure `AccountKey=`、
  没有标签的 JWT，以及键值对。
- 凭据**键名**按词边界匹配而非精确名单，因此 `clientSecret`、`refreshToken`、`accessToken`、
  `authToken`、`apiSecret`、`xApiKey` 这类 camelCase 变体同样被脱敏，而计数（`inputTokens`）与
  寻址标识（`sessionId`）原样保留。任务描述与命令在数据源头即脱敏；会话标题只就地替换凭据子串。
  所有出站载荷在边界处再整体 sweep 一次，且 MCP 的**失败分支同样走这条 sweep**——只在成功时才脱敏
  的出口不算边界。
- **规则是幂等的**：同一份文本连过三遍（源头 / 逐记录 / 出口）与只过一遍结果相同，标记不会逐轮增长。
- **个人数据只在离开本机的那条出口上打码**：MCP 的结果会进入模型上下文，因此那里的 sweep 额外遮蔽
  邮箱与电话号码；面板是你自己的屏幕，遮蔽客户的邮箱只会毁掉你打开它的理由，所以面板保持原样。
- **路径折叠**：家目录、数据目录（`MINIMAX_DATA_DIR`，含容器/CI 中位于家目录之外的情况）以及
  `MCODE_TRAJECTORY_REDACT_ROOTS` 指定的额外根，会在**任意位置**折叠为 `~`（包括警告字符串内部，
  以及 Windows 路径在 JSON 里双反斜杠的形态）；**其他账号**的家目录保留形状、去掉账号名
  （`/home/<user>/…`）。这个开关只能多折叠、不能少折叠，因此它不是一条会削弱防护的配置面。
- 响应**按总量封顶，而不只是单个字符串**：事件列表按序列化字节裁剪到预算并回传
  `truncated`/`omitted`。SQLite 侧另有**单行上限**（8 MiB）：超限记录以 `oversized` 加字节数上报，
  既不整行读进内存，也不被静默丢弃。无换行符的 JSONL 记录无法把读缓冲区撑过 2 MiB 单行上限。
- 诊断信息有界：`warnings` 只保留最近 64 条，被丢弃的条数用 `warningsDropped` 如实上报。
- 文件包含性会 canonical 化途经的每一个组件、拒绝末段 symlink，并在 Linux 上通过 `/proc/self/fd`
  对真正打开的 fd 复核，从而拒绝「中间目录在 canonical 化与 open 之间被替换」。无 `/proc` 的平台
  （macOS、Windows）该残余竞态是**文档化的接受边界**：它需要同 UID 进程赢得微秒级时间窗，而这样的
  进程本就能直接读取该文件。
- 唯一会执行外部命令的地方是 `git rev-parse`（用于把同一仓库的 worktree 归并成一组）。它拿到的是
  **白名单环境变量**而不是整个 `process.env`，因此宿主导出的任何凭据都不会被继承；同时固定关闭
  `core.fsmonitor` 与 credential helper。（实测：仓库自带 `.git/config` 里的 `alias.rev-parse`
  无法劫持内置命令。）
- 不向任何地方上传；没有网络目的地，也没有遥测。

### 已知限制

把边界写清楚，而不是让你以为已经盖全：

- 脱敏器认的是凭据的**形状**与**凭据名**。既没有标签、也不符合任何 provider 形状的高熵字符串，
  对它而言不是凭据。
- PII 打码只覆盖邮箱与电话，且只在 MCP 出口；姓名、地址、客户名等不在模式识别的范围内。
- 未列入折叠根的绝对路径（例如 `/mnt/customers/<客户名>/…`）会原样返回——`summary` 模式里的
  `workspaceDir` 同样如此。把它加进 `MCODE_TRAJECTORY_REDACT_ROOTS` 即可折叠。
- **面板访问凭据会随工具结果进入会话记录**：`trajectory_studio` 把带 `#t=…` 的 URL 作为工具结果
  返回，而运行时会把工具结果写进会话存储，并在后续每一轮把上下文发给模型服务。缓解措施是这份凭据
  **随进程消亡**（只存在于该 MCP server 进程的内存里），且面板只监听回环，所以进程结束后它不再可用。
  若你希望凭据完全不进入模型上下文，请改用 `node server/main.mjs --serve` 在终端里自行启动，URL
  只会打印在你的终端上。
- `--doctor` 会**原样**打印数据目录与库路径：它是给你自己看、由你决定是否分享的诊断面，折叠掉路径
  就失去了意义。


## 环境要求

- MiniMax Code 0.4.0+（`mcode`），需支持 Agent Plugin 与 MCP。
- **Node.js 22.13.0 或更新**（`PATH` 上）——这是硬下限：`node:sqlite` 只有从该版本起才无需
  `--experimental-sqlite` 即可使用。低于此版本时插件会直接打印这句话并以非零码退出，而不是抛出
  模块解析错误。
- **已验证范围：`>=22.19 <23 || >=24 <27`** —— 与 mcode 自身 `engines` 字段完全一致。插件直接
  镜像该范围，不自行发明，因此两者永远不会互相矛盾。
- **全文检索另需该 Node 内置 SQLite 带 FTS5**，而 FTS5 **不随 Node 版本单调存在**（实测）：

  | Node | 内置 SQLite | FTS5 |
  |---|---|---|
  | 22.12.0 | — | 完全没有 `node:sqlite` |
  | 22.13.0 | 3.47.2 | 缺失 |
  | 22.15.0 | 3.49.1 | 缺失 |
  | 22.19.0 | 3.50.4 | 存在 |
  | 22.21.1 | 3.50.4 | 存在 |
  | 23.4.0 | 3.47.1 | 缺失 |
  | 23.11.0 | 3.49.1 | 缺失 |
  | 24.0.0 | 3.49.1 | 存在 |
  | 24.19.0 | 3.53.3 | 存在 |

  在已验证范围之内 FTS5 恒存在，`trajectory_search` 可正常工作。在 22.13.0–22.18.x 与全部 23.x
  上插件仍可运行，只是搜索降级为无匹配并给出明确告警，而不是抛错。
- 本插件**不含任何依赖、也不含原生模块**，因此自身不引入任何 ABI 约束。mcode 用 `better-sqlite3`
  （绑定到某个 Node ABI 的原生模块）写入投影；插件用运行时内置的 `node:sqlite` 读同一个 SQLite
  文件，而不是再放一份 ABI 不同的副本。两者共享的只是 SQLite 自身的磁盘格式。
- 具备 v2 SQLite 投影的本地运行时，或有 v2 会话产物以走兜底路径。
- 宿主浏览器能力用于自动打开面板；若无，面板 URL 仍可手动访问。

### 支持的平台

- **Linux**（`x86_64`，Node.js 24.19.0，mcode 0.4.12）——全部测试、MCP 握手与 Studio 面板
  都在该平台上跑过。
- **macOS 与 Windows** —— 本轮评审中已在 `windows-latest` 与 `macos-latest` 上跑完整个套件，
  两个平台均 0 失败（具体数字与「首次离开 Linux」查到的问题见下方证据表）。代码无需任何平台相关处理：路径
  统一走 `node:path`，主目录取 `HOME` 或 `USERPROFILE`，`git` 以 `execFile` + 参数数组调用而非
  shell，SQLite 驱动是 Node 内置的 `node:sqlite`。三个平台都要求 Node.js 22.13.0+。给读测试的人
  提一句：这套测试第一次离开 Linux 运行时查出三处平台假设，全部在**测试**而非插件里——临时路径未
  规范化就参与比较（macOS 的 `/var`、Windows 的短名 `RUNNER~1`）、一处只在 POSIX 成立的
  「已解析数据目录」断言、以及在 SQLite 仍持有文件句柄时删除临时目录（Windows 上 `EBUSY`，
  POSIX 上无影响）。
- 上面的 Node 矩阵是在每个版本上**实跑插件自身测试套件**测出来的，不是从发布说明推断的。
  套件结果与之完全吻合：22.19.0 / 22.21.1 / 24.0.0 / 24.16.0 / 24.19.0 上 **115 通过 / 0 失败**；
  22.13.0 / 22.15.0 / 23.4.0 / 23.11.0 上 **114 通过 / 0 失败 / 1 跳过**——那一条跳过正是 FTS5
  检索测试，它会自我标记为跳过而不是失败。这正是把「下限」与「FTS5 边界」分两个数字申明的原因。
  套件此后已增至 166 例（见下表）；这些行确立的是运行时的性质，与用例数无关。
  `tools/compat-matrix.mjs` 可按需重新核对这张表，而且是**断言**而非打印。会移动的 `22.x` / `24.x`
  线不在此表内固定——它们每年会解析到若干次新版本（最近一次核对时分别是 22.23.2 / SQLite 3.51.3
  与 24.20.0 / SQLite 3.53.4）。
- `git` 是可选的。它仅用于按仓库分组会话；没有它时，分组回退为按工作区路径。

### 测试证据

```bash
npm run validate                                 # 仓库校验器
cd plugins/weekbin/mcode-trajectory-studio
node --test                                      # 插件测试套件
node tools/compat-matrix.mjs                     # 断言当前 Node 的行为与申明一致
node server/main.mjs --doctor                    # 针对本机的数据源诊断
node tools/panel-e2e.mjs                         # 种一个恶意会话并启动面板
```

清单里有三条声明原本只能写在散文里，所以这里随包提供脚本而不是承诺。`tools/compat-matrix.mjs`
在「执行它的那个 Node」上跑完整套件，并在该版本的行为与清单不符时失败：它断言 `fail === 0`、
断言跳过数与「本机 SQLite 是否有 FTS5」一致、并断言每一条跳过都是 FTS5 检索测试。它做过变异自检
——注入一个失败、注入一个无关跳过，两种情况下它都以 1 退出——所以"通过"是有含义的。

| 验证方式 | 结果 |
|---|---|
| Node `24.19.0` 上跑 `compat-matrix`（最新一次） | 236 个测试：236 通过 / 0 失败 / 0 跳过（FTS5 存在，SQLite 3.53.3） |
| Node `22.13.0` 上跑 `compat-matrix`（上一修订） | 115 个测试：114 通过 / 0 失败 / 1 跳过（FTS5 缺失，SQLite 3.47.2） |
| Node `22.19.0` / `22.23.2` / `24.0.0` / `24.20.0` 上跑 `compat-matrix`（上一修订） | 115 个测试：115 通过 / 0 失败 / 0 跳过 |
| `windows-latest` 与 `macos-latest` 上跑 `node --test`（上一修订） | 两个平台均 115 个测试 / 0 失败 |
| Node `22.12.0` 上跑 `node server/main.mjs --doctor` | 拒绝启动，并点名下限与 `node:sqlite` |

标注「上一修订」的行是当时实测的数字，原样保留。套件已从那些行里的 115 例增长到 166 例，其中本次新增 28 例
（脱敏的转义形态与幂等性、MCP 失败分支及其出口 sweep、单行与告警上限、git 子进程环境、折叠根解析、面板隐私
默认、以及 JSONL 丢弃计数），其余增量来自前一轮补齐的 canary 套件。已在本地 Node `24.19.0` 上复测全过；其余
Node 版本与 Windows / macOS 尚未在此之后复测，下一次 CI 运行会覆盖。

后三行中的平台行是在上一轮评审中**第一次**在 Windows 与 macOS 上运行的，而正是这次运行让测试套件仍有
改动：它在**测试**里查出三处平台假设（临时路径未规范化就参与比较——macOS 的 `/var`、Windows 的短名
`RUNNER~1`；一处只在 POSIX 成立的「已解析数据目录」断言；以及在 SQLite 仍持有文件句柄时删除临时
目录，Windows 上是 `EBUSY` 而在 POSIX 上无影响）。三者均已修复。

本插件自带 CI：`.github/workflows/mcode-trajectory-studio.yml`，以 `paths:` 窄过滤到本插件，
不会替别人的改动花掉仓库的 CI 时间。它跑发布门禁、在 `ubuntu-latest`/`macos-latest`/
`windows-latest` 上以 Node 矩阵跑测试套件，并用独立的 `engines` job 钉住声明的 Node 下限。
PR 新增的 workflow 文件不会**为该 PR** 执行，因此在本 PR 上这些 job 要等文件落到 `main`
之后才会真正把关；下文引用的运行结果是从 fork 派发的，路线与 `tool-map-windows.yml` 已有的
做法一致。

插件自身的测试覆盖 SQLite 读取、JSONL 兜底、git 分组（含真实 worktree 合并）、输入来源、
工具调用/任务 join、agent 定义查找、脱敏、MCP 协议面、模块图（无环、界面层不 import
编排层、每个相对导入均可解析）、客户端格式化的边界情况、面板的请求围栏与错误契约、路径可移植性
（不写死任何本机路径，且非规范布局下仍能找到投影库），以及包声明本身（两份 manifest 与 MCP
描述文件、版本一致性、包体卫生与体积上限）。

之所以有五个专门的套件，是因为上一版的漏洞恰恰落在原有测试没覆盖的地方；每个套件都写成
「一律拒绝」无法通过：

- **`containment.test.mjs`** 在数据目录之外埋 canary，再分别用「任务目录 symlink」「两级跳转」
  「相对 symlink」「`output.log` 自身是 symlink」「会话目录 symlink」「`messages.jsonl` 是
  symlink」去够它。每条都断言 canary 不出现**且**读取被报告为不可用，并配一条必须成功的正向对照。
  同时钉住资源行为：无换行的大行会走增量缓冲上限的丢弃路径（`droppedOversized`），其后的行仍能折叠；
  打开后校验会拒绝落到根之外的 fd，而在无 `/proc` 时回退到文档化的接受边界。
- **`redact.test.mjs`** 钉住每一种曾泄漏的形态：JSON 对象形式、嵌套信封、**转义形态**
  （`{\"api_key\":\"…\"}`——运行时把工具结果存成 JSON 文本，这才是凭据在磁盘上的真实样子）、
  双层转义、`Authorization: Bearer …`、`Basic`、`proxy-authorization`、shell 命令里的头、工具调用
  描述，以及曾被精确名单漏掉的 camelCase 凭据键（`clientSecret`、`refreshToken`、`accessToken`、
  `authToken`、`apiSecret`、`xApiKey`）。每条都断言密钥消失**且**周边载荷存活，并断言 API 赖以寻址的
  标识符（`sessionId`）与用量计数（`inputTokens`）不会被误判成凭据、家目录路径在任意位置都被折叠、
  深度与总量字节上限成立。另有四组**性质**断言而不是例子断言：整份语料 ×4 组选项上的
  `redact(redact(x)) === redact(x)` 幂等性、任何一次 sweep 都不会让标记长出多余括号、截断标记跨轮稳定、
  以及「无敏感内容的 JSON 字符串必须逐字节原样返回」（A 层不得为了防护而重排读者的数据）。
  还钉住了**过度脱敏**：`npm_config_registry` / `HF_HOME` 这类同前缀环境变量必须原样保留，
  13 位时间戳不得被判成手机号，密码里含 `@` 的连接串不得只脱一半而漏出尾巴。
- **`panel-security.test.mjs`** 覆盖访问凭据（只发旧的固定头现在是 403、长度不等不崩、重复头被拒、
  正确的那个被接受且不回显）、进程隔离（一个面板的凭据打不开另一个面板）、仅回环绑定 + 在所有非回环
  地址上不可达 + 对端地址栅栏，以及一个带变异自检的扫描：任何已发布的资源一旦使用标记注入 sink 即失败。
- **`protocol.test.mjs`** 按 mcode 的方式以 stdio 启动**真实** MCP 进程并作为客户端驱动它：版本协商、
  七个工具及其注解、针对夹具投影的一次调用、full 详情在传输层已脱敏（含只有键名才能识别出的结构化
  凭据键，以及**藏在工具结果里的转义形态凭据**）、**失败分支与成功分支走同一条 sweep**、回复被裁剪到
  字节预算并回传 `truncated`/`omitted`、未知工具与未知方法、通知不被应答、`--doctor`，以及生命周期
  ——关闭 stdin 必须结束进程**且在面板运行中亦然**，因为遗留的监听会在每个会话上泄漏一个端口。所有
  等待都有上界，因此「不再应答的服务」会让套件失败，而不是把它挂住。
- **`node-version.test.mjs`** 断言下限与已验证范围、断言 FTS5 的说法与执行该测试的运行时上真实的
  `CREATE VIRTUAL TABLE … USING fts5` 一致、断言四处声明写着同一组数字，并断言没有引入原生模块。

面板另用浏览器做了端到端驱动：会话切换、树展开、时间轴导航、全部检查器分页、主题切换与失败证据块，
覆盖五档视口宽度；并用一个正文与工具入参里埋了 `<img src=x onerror=…>` 的会话确认它渲染为文本、
没有任何脚本执行。仓库测试套件跑的正是 CI 所用的同一个校验器。

本次安全加固后又用浏览器复核了受改动影响的那几项（`tools/panel-e2e.mjs` 配浏览器驱动，载荷含
`<img src=x onerror=…>`、`<svg onload=…>` 与 `"><script>…</script>`）：默认 summary 下首屏
**完全不拉正文**（开关未勾选、DOM 里没有载荷），勾选「显示正文」后三个载荷全部以**字面文本**渲染；
DOM 内**零个** `on*` 内联处理器、零 `javascript:` URL、零 `<img>`、无 `<svg onload>`，控制台零报错；
凭据在传输层就已成 `[redacted]` 才进页面（标题里的 `ghp_…` 抵达前端时已是 `[redacted]`）；
`localStorage` 内无 token、无 cookie；响应头实测为 `default-src 'none'` 的 CSP 与 `no-referrer`。
五档视口矩阵与主题/时间轴那几项是上一轮的结果，本轮未重跑。`tools/panel-e2e.mjs` 打印的自检清单也已
按新的 summary 默认更新——否则它会让人以为「打开就该看到载荷」。

## 安装

本仓库以源码形式托管插件。把本目录作为本地插件指向 MiniMax Code，或将
`plugins/weekbin/mcode-trajectory-studio/` 复制进你的插件目录。MCP 服务器条目会自动启动。

### 包的声明方式

本包与仓库里**所有已合并插件**采用同一套布局；官方 Marketplace 提交表单那套布局
（`.minimax-plugin/plugin.json` + `*.mcp.json`）不在此处提供：

| 文件 | 作用 |
|---|---|
| `plugin.json` | 便携式 Agent Plugins 注册表清单 |
| `.claude-plugin/plugin.json` | mcode 0.4.0+ 布局；指向 Skill 并声明 MCP 服务器 |
| `mcp.json` | 运行时读取的 MCP 描述文件 |
| `skills/mcode-trajectory-studio/SKILL.md` | 唯一的 Skill，位于同名目录下 |

运行时清单直接指向嵌套的 Skill 路径，因此只发布一份 SKILL.md，不再另存副本。
`tests/plugins/mcode-trajectory-studio/smoke.test.mjs` 按这套布局审计整个包，
并带有负向注入，确保审计不会误判为通过。

## 诊断

```bash
node server/main.mjs --doctor   # 解析后的数据目录、SQLite/FTS 可用性、最新会话统计
node server/main.mjs --serve    # 在 127.0.0.1 上独立运行 Studio 面板
```

## 代码结构

本插件不含依赖、无需构建，源码按分层拆分，任何文件都不必承担多重职责：

- `server/` —— `config` · `json` · `sqlite` · `fsutil`（基础层），`redact` · `git`
  （支撑层），`sessions` · `stats` · `tasks` · `events` · `search` · `jsonl`（领域层），
  `store`（门面），再由 `mcp` · `http` · `main`（接口层）对外。领域层模块以 `Store`
  门面作为第一个参数，因此层间依赖图保持为无环 DAG。
- `web/` —— `app.js` 只负责启动；各界面位于 `web/js/`：`state` · `bus` · `format` ·
  `icons` · `results`（叶子层），`api` · `storage` · `theme` · `banner` · `intents`
  （基础层），`sidebar` · `capability` · `stats` · `timeline` · `stream` · `inspector`
  （界面层），以及 `flow` · `controller` · `wire`（编排层）。界面层通过总线**广播意图**，
  而不是 import 动作本身，因此前端依赖图同样**无环**——这一点由测试强制执行。面板以
  ES 模块方式提供服务。
- `test/` —— 套件按「各自守住什么」分组，`release-gates` 另外检查本文档里的计数与断言是否
  仍与代码一致：`store`（数据层）、`protocol` 与 `egress-contract`（MCP 协议面，后者不含任何
  stub）、`http` 与 `panel-security`（面板路由与其渲染）、`panel-flow`（客户端竞态守卫，跑在
  手写 DOM 上）、`redact`（凭据与长度封顶）、`read-consistency`（同一会话在各表面对照）、
  `containment` 与 `portable-paths`（数据目录边界）、`modules`（import 图无环、且每个相对导入
  都能解析到真实文件）、`format`（客户端格式化边界）、`node-version` 与 `release-gates`。
  上架包审计位于仓库的 `tests/plugins/mcode-trajectory-studio/smoke.test.mjs`。

## 许可证

Apache-2.0。见 [LICENSE](LICENSE)。

## 设计说明

本插件背后的调研与界面比较——包括为何使用运行时 SQLite 投影而非会话 JSONL 产物——记录在
[DESIGN.md](DESIGN.md)。
