# opencode v2 章节 → mcode 能力对照

opencode v2 文档站（<https://opencode.ai/v2/docs/>）共 24 个章节。下表**逐条**给出 mcode 的真实对应情况。

对照原则：**有就说有，没有就明说没有并给替代做法**，不做模糊表述。
「无对应」不等于 mcode 弱，只说明该能力在此版本不存在。

## 总览

| # | opencode 章节 | mcode 对应 | 状态 |
| --- | --- | --- | --- |
| 1 | Intro | 安装、快速开始、三种使用形态 | ✅ |
| 2 | Config | `~/.minimax/config.yaml` + `/config` | ✅ |
| 3 | Migrate from V1 | 不适用（无分代迁移概念） | ➖ |
| 4 | Troubleshooting | 常见问题与安装修复 | ✅ |
| 5 | Agents | 内置 Agent + `agents.*` 配置 | ✅ |
| 6 | Models | `/model`、上下文档位、effort | ✅ |
| 7 | Skills | 内置 Skill + SKILL.md 扩展 | ✅ |
| 8 | Themes | `/theme` | ✅ |
| 9 | Commands | slash 命令全表 | ✅ |
| 10 | Plugins | `/plugins` + `mcode plugin` + manifest 契约 | ✅ |
| 11 | Providers | `/provider` + `mcode provider` + `custom_provider` | ✅ |
| 12 | Websearch | `web_search` 工具 + `features.webSearch` 开关 | ✅ |
| 13 | Network | `HTTP_PROXY` 等环境变量 | ✅ |
| 14 | Snapshots | 无文件快照回滚 | ❌ |
| 15 | Compaction | `/compact` | ✅ |
| 16 | Formatters | 无代码格式化器 | ❌ |
| 17 | References | `@` 引用、`--file` 附件 | ✅ |
| 18 | Attachments | `--file`、图片 `[Image #n]` | ✅ |
| 19 | Tools | 基础工具 + MCP 工具（Browser 未暴露给 TUI/CLI） | ✅ |
| 20 | MCP servers | `~/.minimax/mcp.json` + `.mcp.json` + `/mcp` | ✅ |
| 21 | Permissions | `PermissionMode` 5 值 + `/permission` | ✅ |
| 22 | Policies | 无独立策略层，由 PermissionMode 承载 | ⚠️ |
| 23 | Instructions | `AGENTS.md` + `mcode init` | ✅ |
| 24 | Sharing | 无远程分享；`/export` 导出 Markdown | ❌ |

此外 opencode 顶层导航还有 **Build / API / Console / Desktop / Web / Docker**：
mcode 开源范围为「terminal TUI, headless CLI, and ACP」，不提供官方托管控制台、
桌面端源码或 Web 端。

---

## 逐条说明

### 1. Intro ✅

对应 TUI / Headless / ACP 三形态。安装要求 Node.js `>=22.19 <23` 或 `>=24 <27`。
详见 `cli.md`。

### 2. Config ✅

主配置在数据目录的 `config.yaml`（macOS 为 `/Users/<用户名>/.minimax/config.yaml`）。
TUI 内 `/config` 查看生效的只读配置。结构见 `config.md`。

### 3. Migrate from V1 ➖

mcode 没有 V1/V2 分代。需要升级版本时用 `mcode update`（会检查并安装更新），
而不是做版本迁移。

### 4. Troubleshooting ✅

高频问题：

- `mcode: command not found` —— 确认全局 npm bin 在 `PATH`，用 `npm prefix -g` 查位置。
- Node 版本不受支持 —— 需 `>=22.19 <23` 或 `>=24 <27`，**不支持 Node 23**。
- npm 12 阻止安装脚本导致 SQLite 原生依赖缺失 —— 见 `cli.md` 的修复命令。
- 登录或 Provider 异常 —— `mcode --version`、`mcode login`、`mcode provider list`、`mcode provider test <id>`。

### 5. Agents ✅

内置 4 个：`mavis`、`explore`、`worker`、`verifier`。
配置在 `config.yaml` 的 `agents.*`（`tools`、`builtinTools`、`skills`、
`features.mavis|delegation|webSearch`、`persona.enabled`）。
`/parent` 可从子 Agent 会话返回父会话。详见 `agents-skills.md`。

### 6. Models ✅

`/model` 选择模型、上下文档位与思考强度。
`mcode -m <provider/model>` 只改当前 Session。
`--effort` 与 `--model` 相互独立，且不写回 Session。
配置键：`defaultModel`、`defaultModelContextWindow`、`defaultModelVariant`、`defaultModelThinking.effort`。

### 7. Skills ✅

内置 Skill，见 `agents-skills.md`。TUI 内 `/skills` 列出内置与用户 Skill。
Skill 以 `SKILL.md` 为入口，通过插件的 `skills` 数组挂载。

### 8. Themes ✅

`/theme` 选择配色与终端外观。`/settings` 配置终端界面，`/hotkeys` 查看与自定义快捷键。

### 9. Commands ✅

全表见 `commands.md`。

### 10. Plugins ✅

TUI `/plugins [filter]`；CLI `mcode plugin list|add|remove|enable|disable|marketplace`
（直接运行 `mcode plugin` 打开交互式 Plugin manager）。

清单路径 `.minimax-plugin/plugin.json`，`schemaVersion` 必须为 `1`，字段全集：
`$schema`、`schemaVersion`、`name`、`displayName`、`version`、`description`、`author`、
`icon`、`darkIcon`、`category`、`exampleQueries`、`apps`、`mcpServers`、`skills`、
`hooks`、`hostBindings`。

> 官方目录支持安装官方插件与发现的本地插件；**任意 marketplace 注册与 GitHub URL 导入
> 未在 CLI/TUI 中开放**。

### 11. Providers ✅

`/provider` 查看 Provider 与编辑 MiniMax 凭据；CLI `mcode provider` 子命令组。
第三方连接的 Base URL、模型列表、API Key 从环境变量读取（`MCODE_PROVIDER_API_KEY`
或 `--api-key-env` 指定）。自定义 header 位于 `custom_provider.<id>.options.headers`。
命令用法见 `cli.md`，配置键见 `config.md`。

### 12. Websearch ✅

内置 `web_search` / `web_fetch` 工具。
可在 `agents.default.features.webSearch` 关闭。
官方侧另有服务端托管的 Web Search（平台能力，非 mcode 本地能力）。

### 13. Network ✅

读取 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及小写形式；
`localhost`、`127.0.0.1`、`::1` 始终直连；无需设置 `NODE_USE_ENV_PROXY`。
交互会话、`exec`、更新下载与 Matrix 工具请求使用同一套代理规则。

### 14. Snapshots ❌

mcode **没有** opencode 那种文件系统快照与一键回滚。

需要"改坏了退回"时用 git：改动前建分支或提交，或用 `git stash` / `git restore`。

注意区分：`/history`、`/fork`、`/rewind` 操作的是**会话与对话**
（回退对话、分叉会话、重入历史输入），**不是**文件快照。

### 15. Compaction ✅

`/compact` 缩短当前对话；Hook 的 `PreCompact` / `PostCompact` 事件可挂接自定义处理。

### 16. Formatters ❌

mcode **没有**保存时自动格式化的 formatter 概念。

需要格式化时：让 Agent 显式调用项目自己的格式化命令（如 `npm run format`、
`ruff format`、`gofmt`），并在项目规则（`AGENTS.md`）中写明。

### 17. References ✅

通过 `--file` 附加文件，通过 `!` / `!!` 执行终端命令并把结果带给模型。
`/transcript` 可浏览、搜索完整对话。详见 `mcp-tools.md`。

### 18. Attachments ✅

- CLI：`--file <path>` 可重复。
- TUI：粘贴图片后 Composer 显示 `[Image #1]` 形式的标签与预览。
- 预览上限 **20 MB / 2500 万像素**；超限、格式不支持或读取失败时保留文字信息与原附件。
- 支持 Kitty 图片协议的终端与 regular 模式的 iTerm2 可直接显示图片，其它终端显示格式、尺寸与大小。

### 19. Tools ✅

基础工具：`read`、`write`、`edit`、`bash`、`grep`、`glob`、`task`、`todowrite`、
`skill`、`ask_user`、`web_search`、`web_fetch`。
外加 MCP 提供的 `mcp__*` 工具。**Browser 工具经实测未装配到 TUI/CLI**，属桌面端宿主能力，
终端侧改用 `web_search` / `web_fetch`。详见 `mcp-tools.md`。

### 20. MCP servers ✅

- 用户级：`~/.minimax/mcp.json`
- 项目级：`<workspace>/.mcp.json`（与 Desktop、exec、ACP 共用规则）
- TUI 查看：`/mcp`
- `env` 中可使用 `${PLUGIN_ROOT}`、`${PLUGIN_DATA}` 占位符

**注意**：没有 `mcode mcp` 这个 CLI 子命令（实跑确认不存在）。

### 21. Permissions ✅

`PermissionMode` = `default | acceptEdits | bypassPermissions | auto | off`。
`/permission [status | ask | auto | full]`，`/permissions` 查看待处理请求，
`/allow`、`/always`、`/deny`、`/decision` 处理单次决策。
详见 `permissions.md`。

### 22. Policies ⚠️

mcode **没有**独立的策略引擎层。相关语义由 `PermissionMode` 与运行时权限规则承载。
需要细粒度管控时用 `/permission` 选择最小可用权限档位，而不是寻找策略文件。

### 23. Instructions ✅

项目规则文件为 `AGENTS.md`。`mcode init [directory]` 用内置 `init` Skill
分析代码库并生成或完善 `AGENTS.md`。

### 24. Sharing ❌

mcode **没有** Gist 或远程会话分享。

可用替代：

- `/export [path.md]` —— 导出当前 Session 为 Markdown
- `/copy` —— 复制最后一条回复为 Markdown
- 产物自行提交到仓库或粘贴给他人

---

## 文档口径提醒

本对照表基于 **mcode 0.5.8（实跑，与官方仓库 `main` 同版本）**。
用户版本不同（尤其更新版本）时，`/changelog` 可查看随包更新记录，
并以 `mcode --help`、`<cmd> --help` 与 `/help` 为准。
