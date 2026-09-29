# mcode TUI slash 命令全表

在 TUI 输入框以 `/` 开头即可调用，分基础命令与分类命令两组。分类：

| 分类 | 管什么 |
| --- | --- |
| 基础命令 | 换模型、看状态、查配置与用量、压缩与导出 |
| Session 会话与对话 | 新建/切换/归档会话，回退、重发、改写提问、问侧问题 |
| Application 应用 | 侧栏、状态栏、主题、快捷键等应用设置 |
| Runtime 运行时 | 权限模式、后台任务、生效配置、登录与 Provider |
| Decision 决策 | 逐个回答 Agent 提问：允许、拒绝、补充说明 |
| Input 输入 | 增删工作目录、管理排队消息 |
| Transcript 对话记录 | 浏览与检索本会话输入历史 |
| Capability 能力 | 浏览、安装、启用、移除插件 |

**别名**：`/clear` → `/new`、`/exit` → `/quit`、`/resume` → `/sessions`、`/side` → `/btw`

**分类**：`Session` / `Runtime` / `Capability` / `Input` / `Transcript` / `Decision` / `Application`

---

## 输入判别规则（重要）

Composer 会把当前输入标记为 `Prompt`、`Command`、`Shell` 或 `Skill`，并提示按下 Enter 后
是发送、执行还是调用。

- **无参数的命令**只在命令名后**没有正文**时执行（允许尾随空白）。
  如果继续输入正文，整句作为**普通提示词**发送。
  例：`/context` 是命令；`/context 解释这个项目` 是普通提示词。
- **接受参数的命令**（如 `/sessions [query]`）仍按命令处理。
- Skill 调用形如 `/docs 解释 API`，会显示为带 instructions 的 Skill 调用。

---

## 基础命令

| 命令 | 别名 | 描述 |
| --- | --- | --- |
| `/help` | — | Show available commands（显示可用命令） |
| `/new` | `/clear` | Start a fresh session in the current workspace |
| `/model` | — | Choose a model（选择模型） |
| `/status` | — | Show account and model status |
| `/doctor` | — | Check the local config file（检查本地配置文件） |
| `/context` | — | Show the Runtime-owned context snapshot |
| `/skills` | — | List built-in and user Skills |
| `/mcp` | — | Inspect MCP capabilities and project configuration |
| `/usage` | — | Show session usage |
| `/compact` | — | Shorten the active conversation |
| `/export` | — | Export the current Session as Markdown（`[path.md]`） |

---

## 分类命令

### Session（会话与对话）

| 命令 | 参数 | 描述 |
| --- | --- | --- |
| `/sessions` | `[query]` | Search, resume, and manage sessions |
| `/goal` | `<objective \| action>` | Start or manage the current Session Goal |

`/goal` 不带 action 时把后续文字作为目标描述；带 action 时执行下列操作
（Composer 输入 `/goal` 会自动补全）：

| action | 作用 |
| --- | --- |
| `pause` | 暂停 Goal 的自动续跑 |
| `resume` | 恢复已暂停或被阻塞的 Goal |
| `edit` | 修改当前 Goal 的目标描述 |
| `clear` | 移除当前 Goal |
| `help` | 显示 Goal 语法与 budget 示例 |
| `budget=<n>` | 设置 token 预算，如 `budget=50K` |
| `budget=clear` | 移除 token 预算，回到不限制 |
| `/plan` | `[on \| off \| status \| view]` | Switch Plan Mode or view the latest Plan |
| `/review` | — | Review staged, unstaged, and untracked local changes |
| `/parent` | — | Return from a sub-agent session to its parent |
| `/btw` | `[question]` | Ask a side question without interrupting the running task |
| `/history` | — | 浏览当前 Session 的输入历史 |
| `/fork` | — | Fork from here：从历史用户消息创建子会话，不修改当前会话或文件 |
| `/rewind` | — | 回退会话；可选「仅回退会话」或「回退会话和文件」 |
| `/edit` | `[instructions]` | Edit this input：替换此提示词并从这里重新生成 |
| `/retry` | — | Resend the last message after a failed response |
| `/rename` | `[title]` | Rename the active session |
| `/archive` | — | Archive the active session |

### Runtime（运行时）

| 命令 | 参数 | 描述 |
| --- | --- | --- |
| `/permission` | `[status \| ask \| auto \| full]` | Choose or inspect the Runtime permission mode |
| `/tasks` | — | Inspect background agents and Runtime tasks |
| `/config` | — | Show the effective read-only configuration |
| `/steer` | `<message>` | Steer current work without interrupting it |
| `/login` | — | Sign in to use MiniMax Code Agent features |
| `/logout` | — | Sign out of the shared Desktop account |
| `/provider` | — | View providers and edit MiniMax credentials |

### Capability（能力）

| 命令 | 参数 | 描述 |
| --- | --- | --- |
| `/plugins` | `[filter]` | Browse, install, enable, and remove Plugins |

### Input（输入）

| 命令 | 参数 | 描述 |
| --- | --- | --- |
| `/add-dir` | `<path>` | Add a readable and writable workspace directory |
| `/queue` | — | Manage messages that run after the current response |

### Transcript（对话记录）

| 命令 | 描述 |
| --- | --- |
| `/transcript` | Browse, search, and inspect the full conversation |
| `/copy` | Copy last response as Markdown |

### Decision（决策）

| 命令 | 描述 |
| --- | --- |
| `/decision` | Reopen the pending action panel |
| `/allow` | Allow the pending tool once（本次允许） |
| `/always` | Always allow this action class（始终允许该类操作） |
| `/deny` | Deny the pending tool（拒绝） |
| `/permissions` | Show pending Runtime-owned permission requests |

### Application（应用）

| 命令 | 描述 |
| --- | --- |
| `/settings` | Configure the MCode terminal interface |
| `/statusline` | Choose, reorder, and preview status line items |
| `/theme` | Choose the MCode color theme and terminal appearance |
| `/hotkeys` | View and customize TUI keyboard shortcuts |
| `/reload` | Reload TUI configuration and Plugins |
| `/stop` | Interrupt the running turn |
| `/feedback` | Review and submit redacted product feedback（`<message>`） |
| `/checkin` | Claim the daily MiniMax account reward |
| `/changelog` | Show the packaged MCode update history |
| `/update` | Check for and install an MCode update |
| `/quit` | Exit Minimax Code（别名 `/exit`） |

---

## `/history`、`/fork`、`/rewind`、`/edit` 的实际行为

这四条共享一套「历史变更」交互（会话空闲时才可用）：

| 命令 | 英文文案 | 中文文案 | 行为 |
| --- | --- | --- | --- |
| `/fork` | Fork from here | 从这里创建分支 | 创建**子会话**，不修改当前会话或文件 |
| `/edit` | Edit this input | 编辑此输入 | 替换该提示词并**从这里重新生成**；后续对话与文件改动将被移除 |
| `/rewind` | Rewind conversation / Rewind conversation and files | 回退会话 / 回退会话和文件 | 移除后续消息；可选**保持文件不变**或**同时还原可安全恢复的文件改动** |

前置条件：开始或恢复一个 Session 后才能浏览历史；有回复正在运行时不可用
（`Stop the running response before changing Session history.`）。

> **注意**：`/rewind` 的「回退会话和文件」是**会话回退时顺带还原文件**，
> 这**不等于** opencode 那种可任意跳转的文件快照系统。mcode 没有全局文件快照。

---

## 侧会话（BTW）只读命令

`/btw`（别名 `/side`）从最近一个已提交的会话边界 fork 出临时侧会话，主任务继续运行不被中断。
侧会话以只读上下文继承主会话历史，工具权限与主会话一致，并被要求除非明确请求否则不做修改。

侧会话视图中仅以下命令可用：

`help`、`changelog`、`context`、`status`、`usage`、`export`、`transcript`、`copy`、`parent`

`/parent`（或 `Ctrl+/`）在侧会话与主会话视图间切换而不结束任何一方。
侧会话是临时的：不出现在 `/sessions` 中，切换到其他 Session 时自动清理。
空 Composer 中按 `Ctrl+C` 关闭并丢弃侧会话。

---

## 状态栏项（`/statusline`）

合法项 4 个：

| 项 | 含义 |
| --- | --- |
| `cache-read-ratio` | 缓存读取比例 |
| `context-remaining` | 剩余上下文 |
| `context-meter` | 上下文刻度（默认关闭） |
| `custom-command` | 自定义命令 |

源码提供的别名映射：

| 别名 | 归一到 |
| --- | --- |
| `status-protocol`、`vela` | `build-mode` |
| `workspace`、`cwd`、`project-dir` | `current-dir` |
| `git` | `git-branch` |
| `context-window` | `context-remaining` |
| `context-bar`、`context-gauge` | `context-meter` |
| `custom` | `custom-command` |

---

## 终端内直接执行命令

在 Composer 中输入 `!pwd`、`!git status`，按 Enter 立即在当前 Session 工作目录执行，
实时显示 stdout、stderr 与退出码。输入框显示 `Shell · Enter run`。

- `!命令` 的结果随下一条消息交给模型；执行本身**不发起**模型请求。
- `!!命令` **仅在 TUI 本地显示**输出，不发给模型。
- 两者输出与待发送上下文各保留最近 **64 KiB** 字符，超出显示截断提示。
- 按 `Tab` 请求本地补全（只读本地目录，不调用模型、不执行草稿）。
- 每条命令启动**独立 Shell**，`cd` 与 `export` 的效果仅限该条命令。
- 命令以当前操作系统用户权限执行；macOS 使用 Bash，Windows 优先 PowerShell。
