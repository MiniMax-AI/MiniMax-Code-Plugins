# 插件

扩展 mcode 的东西分**三类**，类别不同，不能当成同一层并列：**能力单元**（Skill /
MCP 服务器 / Hook）、**插件**（分发容器）、**MiniApp**（给人点的界面应用）。
本文件讲前两类；**MiniApp 是另一类别，单列一份**，见 `miniapp.md`。

## 三类东西，别混为一谈

| | 能力单元 | 插件 Plugin | MiniApp |
| --- | --- | --- | --- |
| 本质 | 扩展 **Agent** 的零件 | **分发容器**，本身不是能力 | **给人点的界面应用** |
| 具体包括 | Skill / MCP 服务器 / Hook | 把左边这些装在一起的那个文件夹 | 看板、报表、审批面板 |
| 给谁用 | Agent（读 / 调）或系统（自动执行） | 安装器与宿主 | 人 |
| 有无运行时 | MCP `stdio` 有子进程 | **没有**，只是一份被反复读取的声明 | **独立 Node 进程**，按需启动 |

**分界线**：MiniApp 确实以插件形态分发（官方原文「MiniApps are interactive apps
packaged as MiniMax Plugins」），但**共享的是分发方式，不是类别**。判定看三样：
`package.json` 里的 `mcode` 字段、`miniapp/` 载荷根、Node 入口。三样齐全才是 MiniApp，
缺省的才是普通插件。

## 能力单元：扩展 Agent 的三种零件

### Skill：一套写好的工作方法

说明书性质，告诉 Agent「遇到这类任务先做什么、用哪些工具、怎么检查结果」。
**不新增任何工具**，只让 Agent 在特定任务上更专业、更一致。装好后用
`/<skill 名>` 调用。0.5.8 内置 16 个。

### MCP 服务器：给 Agent 接上新的工具

MCP（Model Context Protocol）是开放协议，作用是**给 Agent 增加可真正调用的工具**
（数据库、内部 API、公司系统）。对应「Agent 能做什么」，不是「Agent 知道怎么做」。
配置见 `mcp-tools.md`。

### Hook：到点自动跑的一条命令

「在某个时机自动执行的一条命令」，不用每次手动运行。依附于插件注册，事件名取自
Claude Code。详见本文「Hook 详解」。


## 插件：装东西的盒子

插件就是磁盘上的一个文件夹：里面有一份清单 `.minimax-plugin/plugin.json`，声明自己提供
哪些 Skill、哪些 MCP 服务器、哪些 Hook。对使用者来说意义是**一次安装，全部就位**。

它**没有自己的运行时**——不常驻进程、不占端口，只是一份被宿主反复读取的声明。装好并启用后
跨会话持续装配，直到显式 `disable` 或 `remove`。生效时机对比见 `miniapp.md` 的
「生命周期」一节。

## 安装与管理插件

```bash
# 看当前装了哪些，以及还能装哪些
mcode plugin list --available
# 装一个
mcode plugin add <plugin-id>
# 临时停用 / 恢复（不会删除）
mcode plugin disable <plugin-id>
mcode plugin enable <plugin-id>
# 卸载
mcode plugin remove <plugin-id>
# 浏览可安装的插件
mcode plugin marketplace
```

直接运行 `mcode plugin` 会打开交互式插件管理器，用方向键操作更省事；
TUI 内用 `/plugins [filter]`。

**范围限制**：官方目录支持安装官方插件与发现的本地插件；
**任意 marketplace 注册与 GitHub URL 导入未在 CLI/TUI 中开放**。


## 插件清单（manifest）怎么写

清单文件固定叫 `.minimax-plugin/plugin.json`，其中 `schemaVersion` **必须**写成 `1`，
写了清单之外的键会被直接拒绝。**合法字段全集**（源码 `MANIFEST_FIELDS`）：


| 字段 | 说明 |
| --- | --- |
| `$schema` | JSON Schema 地址 |
| `schemaVersion` | 固定为 `1` |
| `name` | 插件标识 |
| `displayName` | 展示名 |
| `version` | 版本 |
| `description` | 描述 |
| `author` | 作者 |
| `icon` / `darkIcon` | 明暗图标 |
| `category` | 分类 |
| `exampleQueries` | 示例查询 |
| `apps` | 应用引用 |
| `mcpServers` | MCP 服务器文件引用 |
| `skills` | SKILL.md 路径列表 |
| `hooks` | Hook 文件引用 |
| `hostBindings` | 宿主能力绑定 |

### `hostBindings`

元素须为严格 `schemaVersion: 1`，包含：

| 字段 | 说明 |
| --- | --- |
| `bindingId` | 绑定标识 |
| `logicalToolName` | 逻辑工具名 |
| `hostCapability` | `{ id, version }` |
| `requiredSkills` | 依赖的 Skill |
| `allowedSurfaces` | 允许的宿主表面，当前仅支持 `interactive` |

### 路径占位符

插件内路径支持 `${PLUGIN_ROOT}`（插件根目录）与 `${PLUGIN_DATA}`（插件数据目录）。

### 示例

```json
{
  "schemaVersion": 1,
  "name": "example-plugin",
  "displayName": "Example Plugin",
  "version": "0.1.0",
  "description": "示例插件",
  "author": "you",
  "icon": "icon.png",
  "category": "Other",
  "exampleQueries": ["用这个插件做……"],
  "apps": [],
  "mcpServers": [],
  "skills": ["skills/example/SKILL.md"],
  "hooks": ["hooks/notify.json"]
}
```

---


## Hook 详解：在插件里注册

Hook 就是「到点自动执行的一条命令」。你在插件里写好一条命令，再指明它在什么时候跑，
mcode 每次遇到那个时机就会执行它。

最常见的例子：想让每次回答结束后都收到通知，就监听 `Stop` 事件，指向一个发通知的脚本。
事件名取自 Claude Code，因此已有的 Claude Code Hook 配置可以直接迁过来；
来源格式支持 `MINIMAX`、`CLAUDE`、`CODEX` 三种。

Hook 会在 mcode 等待它跑完之前**阻塞**后续流程，所以只支持同步的命令型处理器
（`type: "command"`）。写注册文档时即使写了 `async`，也会被判为不支持
（`HOOK_HANDLER_UNSUPPORTED`）。

## 事件全集

```
SessionStart        SessionEnd          UserPromptSubmit
PreToolUse          PermissionRequest   PostToolUse
SubagentStart       SubagentStop        Stop
PreCompact          PostCompact
```

`SessionStart` 携带来源标识，取值为
`startup` / `resume` / `clear` / `compact` / `fork` / `plugin_activation`。

## 注册文档的引用方式

manifest 的 `hooks` 字段接受五种形式：

| 形式 | 说明 |
| --- | --- |
| 字符串 | `"hooks": "hooks/notify.json"` |
| 对象 | `"hooks": { "path": "hooks/notify.json" }` |
| 数组 | 上述两者的任意组合 |
| **内联对象** | 直接给出注册文档本身，`sourcePath` 记为 `<manifest>` |
| 省略 | 若默认路径下存在注册文件则自动纳入 |

注册文档的信封有两种等价写法：外层带 `"hooks"` 键，或直接以事件名为顶层键。

## 注册文档字段

| 字段 | 必需 | 约束 |
| --- | --- | --- |
| `type` | 是 | 恒为 `"command"` |
| `command` | 是 | 非空字符串 |
| `commandWindows` / `command_windows` | 否 | 仅 win32 生效，优先于 `command` |
| `timeout` | 否 | **整数秒**，取值 1–10；缺省 5000 ms；上限 10000 ms |
| `matcher` | 否 | 事件分组级；上限 256 字符；校验规则见下 |
| `args` | 否 | 字符串数组；**仅 `CLAUDE`**；给出即采用 exec 形式 |
| `shell` | 否 | `bash` 或 `powershell`；**仅 `CLAUDE`**；`args` 存在时忽略 |
| `if` | 否 | 工具谓词，形如 `Bash(rm *)`；**仅 `CLAUDE`**；仅 `PreToolUse`／`PermissionRequest`／`PostToolUse` |
| `additionalContextLimit` | 否 | 非负安全整数；**仅 `CODEX`**；仅 `PreToolUse`／`PostToolUse`／`SessionStart`／`UserPromptSubmit`／`SubagentStart` |

`timeout` 若为非整数、`< 1` 或 `> 10`，整条处理器记 `HOOK_SCHEMA_INVALID`。
`MINIMAX` 格式下空白 `matcher` 非法。

### `matcher` 校验

1. `*` 恒合法；
2. `UserPromptSubmit` 与 `Stop` 不校验内容；
3. `CODEX` 仅接受 `[A-Za-z0-9_|]+`；
4. 其余格式以 `|` 或 `,` 分支，每支须整体匹配 `[A-Za-z0-9_.:/-]+`；
5. 否则按**可移植正则**校验——仅允许非捕获组 `(?:...)`，拒绝环视、命名组、
   反向引用与悬空转义，且同一原子重复量词达 4 次即拒绝。

### 注册级上限

单个插件可执行处理器至多 **64** 个，超出部分记 `HOOK_HANDLER_LIMIT_EXCEEDED`。

## 命令解析

- 存在 `args` 时走 exec 形式，不经 shell；
- `MINIMAX`：无 `args` 时经系统默认 shell；`shell: bash` 转为 `bash -c`，
  `shell: powershell` 转为 pwsh；
- `CLAUDE`：POSIX 下默认 `sh -c`、`shell: bash` 转为 `bash -c`；win32 下优先
  Git Bash（环境变量 `CLAUDE_GIT_BASH_PATH`、`ProgramFiles` 等候选），否则 PowerShell。

`command` 形式要求 Hook 进程的 `PATH` 上存在 Node.js。

## 进程环境

**继承白名单仅 17 个变量**：

```
PATH  HOME  LANG  TERM  SHELL  USER  TMPDIR  TEMP  TMP
PATHEXT  SystemRoot  ComSpec  USERPROFILE  HOMEDRIVE  HOMEPATH
APPDATA  LOCALAPPDATA
```

**宿主注入**：

```
PLUGIN_ROOT  MINIMAX_PLUGIN_ROOT  CLAUDE_PLUGIN_ROOT  CODEX_PLUGIN_ROOT
PLUGIN_DATA  CLAUDE_PLUGIN_DATA
MINIMAX_PROJECT_DIR  CLAUDE_PROJECT_DIR  CODEX_PROJECT_DIR
```

`CLAUDE` 格式且事件位于工具使用上下文内时，追加 `CLAUDE_EFFORT`（取
`low` / `medium` / `high` / `xhigh` / `max`）。

因此 Hook 脚本**不得**依赖白名单以外的环境变量，其中包含任何凭据；
所需变量须由插件自身声明。插件包根目录为**只读**，可写状态应写入
`PLUGIN_DATA`，该目录由宿主以 `0700` 权限创建。

## stdin 输入

Hook 进程从 stdin 读取**单个** UTF-8 JSON 对象。事件特有字段先行展开，
其后写入下列固定键：

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "…",
  "turn_id": "…",
  "prompt_id": "…",
  "transcript_path": "…",
  "cwd": "…",
  "model": "…",
  "permission_mode": "…",
  "effort": { "level": "high" },
  "tool_name": "Bash",
  "tool_input": { }
}
```

- `turn_id`、`prompt_id`、`model`、`permission_mode`、`effort` 缺省时不出现在对象中；
- `transcript_path` 在尚无转录时为 `null`；
- 序列化结果超过 **1 MiB** 时不投递输入；
- `MINIMAX` 格式仅要求 `session_id` 与 `cwd` 非空；`CLAUDE` 另校验回合级字段。

## 退出码与输出

| 情形 | 结果 |
| --- | --- |
| 空输出 | 采用事件默认裁决 |
| 以 `{` 开头（`CODEX` 另接受 `[`） | 按 JSON 解析 |
| 其余文本 | 该事件支持纯文本上下文时并入 `additionalContext`，否则采用默认裁决 |
| **exit 2**（非 `MINIMAX`） | 触发事件级阻断效果，**JSON 无法覆盖** |
| `CODEX` 且退出码非零 | 不解释 stdout，采用默认裁决 |
| `CLAUDE` 且任意退出码 | 均解析 JSON |
| 被信号终止 | `HOOK_PROCESS_ERROR`，并终止同进程组残余进程 |
| 超时 | `HOOK_TIMEOUT` |
| stdout 或 stderr 超过 **64 KiB** | `HOOK_INVALID_OUTPUT` |
| 非法 JSON 或含未授权键 | `HOOK_INVALID_OUTPUT` |

`hookSpecificOutput.hookEventName` 若出现，必须与当前事件一致，否则整份输出作废。

### 默认裁决与合并

空输出时的默认裁决：`PermissionRequest` 为 `decision: "allow"` 加
`permissionDecision: "abstain"`；`PreToolUse` 为 `decision: "allow"` 加
`toolPermissionDecision: "abstain"`；其余事件为 `decision: "allow"`。

多个处理器作用于同一事件时按**最强裁决合并**（`deny` 优先于 `ask`，
`ask` 优先于 `defer`，`defer` 优先于 `allow`），而非后者覆盖前者。

## 控制输出字段

| 字段 | 取值 | 作用 |
| --- | --- | --- |
| `decision` | `allow` / `deny` / `ask` / `defer` | 通用裁决 |
| `reason` | ≤ 4096 字符 | 裁决理由 |
| `continue` | `false` 终止当前运行 | 通用控制 |
| `stopReason` | 字符串 | 终止原因 |
| `continuePrompt` | 字符串 | 续跑提示 |
| `defer` | 布尔 | 交回宿主裁决 |
| `suppressOutput` | 布尔 | **不**控制 `systemMessage` |
| `additionalContext` | ≤ 65536 字符 | 注入模型上下文 |
| `updatedInput` | 对象 | 改写工具入参 |
| `updatedResult` | 任意 | 替换模型可见的工具结果；审计与持久化保留原值 |
| `updatedResultFormat` | `CLAUDE` / `MINIMAX` | `updatedResult` 的所属方契约 |
| `postToolFeedback` | 字符串 | `CODEX` 的 `PostToolUse` 错误反馈，**不**构成硬停止 |
| `terminalSequence` | 字符串 | `CLAUDE` 专用、经白名单过滤的终端通知字节 |
| `systemMessage` | 字符串 | 仅供用户阅读，见下节 |

`decision: "block"` 或 `continue: false` 均标记为结构化阻断。

## 权限更新

`PermissionRequest` 可返回 `updatedPermissions` 数组，宿主以**原子**方式整体应用：

| 形态 | 必填字段 |
| --- | --- |
| `addRules` / `replaceRules` / `removeRules` | `rules`、`behavior`（`allow` / `deny` / `ask`）、`destination` |
| `setMode` | `mode`、`destination` |
| `addDirectories` / `removeDirectories` | `directories`、`destination` |

| 字段 | 合法取值 | 适用与约束 |
| --- | --- | --- |
| `behavior` | `allow` / `deny` / `ask` | 规则类形态，随 `rules` 数组逐条给出 |
| `destination` | `session` / `localSettings` / `projectSettings` / `userSettings` | 三类形态共用 |
| `mode` | `default` / `auto` / `acceptEdits` / `dontAsk` / `bypassPermissions` / `plan` | 仅 `setMode` |
| `permissionDecision` | `allow` / `deny` / `abstain`（缺省） | 通用裁决；`allow` 授权且不呈现产品界面 |
| `permissionAutoApproval` | `ordinary_only` / `any_prompt` | `CLAUDE` 仍复核 deny 与 ask 规则，`CODEX` 将 Hook 裁决视为最终批准 |
| `interrupt` | — | `CLAUDE` 的 `PermissionRequest` 专用，仅在 deny 时请求中止活动运行 |
| `toolPermissionDecision` | `allow` / `deny` / `ask` / `defer` / `abstain` | `PreToolUse` 专用，与「无裁决」相区分 |

## 时间预算

单个处理器的实际超时取声明值与事件剩余预算之较小者。普通事件总预算
**15 000 ms**，`SessionEnd` 为 **3 000 ms**，进程回收窗口为 **500 ms**。

## 诊断码

解析期：`HOOK_SCHEMA_INVALID`、`HOOK_EVENT_UNSUPPORTED`、
`HOOK_HANDLER_UNSUPPORTED`、`HOOK_HANDLER_LIMIT_EXCEEDED`。

运行期：`HOOK_ABORTED`、`HOOK_INVALID_INPUT`、`HOOK_INVALID_OUTPUT`、
`HOOK_PROCESS_ERROR`、`HOOK_PROCESS_EXITED`、`HOOK_TIMEOUT`。

---

## `systemMessage`：只给用户看，不进模型上下文

向 stdout 写**一个** JSON 对象并以 **exit 0** 退出：

```js
console.log(JSON.stringify({ systemMessage: "Checks complete. The report is ready." }));
```

- 在 TUI 中作为 `Hook · Stop` 形式显示在回复之后。
- **不进入** canonical model history、compaction 输入、最终回答复制与默认 Markdown 导出；
  但**确实**写入本地显示存储。
- 单独返回 `systemMessage` **不**触发额外的模型调用。
- 支持多行；消息与标题中的终端控制序列会被剥离。
- 提示颜色只是表现，不代表回合失败。
- 通知持久化在 Session 显示历史中，重开 Session 会恢复；重放同一消息不会重复。
- 相互独立的 Hook 调用可重复输出同一文本，各自产生独立通知。
- 通知归属其所在 Session；子 Session 的通知**不**向父 Session 广播。

若同时返回 `additionalContext`、`decision` 等控制字段，这些字段仍按各事件的
既有语义生效。`suppressOutput` **不**控制该通知。

> 这只是脚本的**输出**，不是 Hook 注册文档本身。

## 事件限制

- 同一显示行为适用于 Runtime 已发出通知的事件：`SessionStart` /
  `UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、
  `SubagentStart` / `SubagentStop`，以及**自动** `PostCompact`。
- `PreCompact` 与**手动** `PostCompact` 当前**不**发出该通知。
- `SessionEnd` 为尽力而为，不保证退出前显示。
- **Claude 兼容适配器**会丢弃 `PreCompact`、`PostCompact`、`SessionEnd` 的
  `systemMessage`；**Codex 适配器**会丢弃 `SessionEnd` 的。上述按格式的差异不随时间变化。
- 上述只覆盖**同步 command Hook**。
- 被取消或失败的回合**不会**触发正常的 `Stop` Hook。
- 只有带分类的插件用户消息会显示；诊断消息、终端控制通知与无分类的旧事件保持隐藏。
- 该行为仅涉及交互式 TUI 的呈现，headless 与 ACP 的输出策略不变。

## 源码构建下的手工验证

```bash
pnpm build
```

用独立的 `MINIMAX_DATA_DIR` 与启用的测试插件启动构建产物。
交互式 TUI **不接受** Headless 的 `exec --cwd` 选项；要用 shell 的工作目录选择测试 workspace。

验证步骤：

1. 提出一个不使用工具的简短请求，确认完成后出现一条 `Stop` 通知；
2. 重复该请求，确认即便文本完全相同仍产生第二条通知；
3. 切出再重开 Session，并重启 CLI，确认通知被保留且不重复；
4. 使用 `/copy` 与 `/export`，确认通知文本不在导出结果中；
5. 收窄终端宽度，确认多行文本仍可读。

验证上下文隔离时，**不得**将通知标记写入提示词，也**不得**要求模型读取 Hook 脚本。
判定请求确未接受该标记，须检视下一次模型请求与一次真实发生的 compaction 请求；
仅凭模型回答或 `/context` 用量统计不足以作为证据。
