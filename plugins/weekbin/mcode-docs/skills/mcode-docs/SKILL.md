---
name: mcode-docs
description: >-
  MiniMax Code（mcode）概要说明与事实基线。用于回答 mcode 的命令与全量参数、
  TUI slash 命令、配置文件与键位、内置 Agent 与 Skill、插件与 MiniApp 编写契约、
  Hook 事件与输入输出契约、MCP 接入、权限模式、Plan Mode、会话管理、无头执行与
  ACP 接入，以及"mcode 是否具备某项能力"这类存在性判定。本 Skill 不止罗列功能：
  每条主张均按 A（本机实跑）／B（厂商随包文件）／C（官方源码定义）／D（运行时真实配置）
  四级取证，可追溯至 VERIFICATION.md；经核实不存在的能力明确标注为不存在并给出
  替代路径，而非以省略或推测代替。取证基线版本 0.5.8。
---

# mcode 概要说明与事实基线

本 Skill 提供 **MiniMax Code（`mcode`）** 的概要说明与事实基线：逐节说明它的使用形态、
命令面、配置、扩展机制与权限模型，并对"mcode 是否具备某项能力"给出可追溯的判定。

它遵守两项方法论约束，二者共同划定了这份文档的可信边界：

1. **仅陈述经核实存在的功能。** 每条主张都可追溯至 `VERIFICATION.md` 的取证记录，并标注证据等级——
   **A** 本机实跑命令得到的真实输出、**B** S1 随包发布的厂商第一手文件、
   **C** S2 源码中的权威定义（类型／常量／注册表）、**D** 本机运行时真实配置或状态文件。
2. **经核实不存在的能力明确标注为不存在**，而不以省略或推测代替，并同时给出替代路径。

因此它的定位不是功能罗列，而是一份**事实基线**：既说明有什么，也明确说明没有什么，
以及缺少某项能力时该走哪条路。

## 前置程序：确认版本

mcode 迭代频次较高，功能随版本变动。**回答任何功能性问题之前，须先确认版本**：

```bash
mcode --version
```

本 Skill 的取证基线为 **0.5.8**（本机实跑，与官方开源仓库 `main` 同版本）。
若用户版本与之不符，应明确提示版本差异，不得将新版本能力作为既有事实陈述。

## 三类高频误判

以下三点最易导致错误结论，须予注意：

| 常见误解 | 核实结果 |
| --- | --- |
| `mcode mcp add`、`mcode skill list`、`mcode agent` 等 CLI 子命令 | **不存在**。实跑回落到根帮助。相应能力由配置文件与 TUI slash 命令提供 |
| mcode 不具备 Hook 系统（因打包产物中检索不到 `PreToolUse`） | **存在**。兼容 Claude Code 事件模型，支持 `MINIMAX`/`CLAUDE`/`CODEX` 三种格式 |
| mcode 具备文件系统快照回滚、Gist 分享、格式化器、预热 | **均不存在**。`history`/`fork`/`rewind` 属会话与对话层面的操作，非文件快照 |

## mcode 的定位

运行于终端的 AI Coding Agent：解析代码库、修改文件、执行命令、运行测试；
每次工作保存为可继续的 Session。三种使用形态共用同一进程内 Runtime 生命周期：

- **交互式 TUI** —— `mcode`
- **无头执行** —— `mcode exec`，适用于脚本与 CI
- **ACP** —— `mcode acp`，供支持 Agent Client Protocol 的编辑器接入

安装（要求 Node.js `>=22.19 <23` 或 `>=24 <27`）：

```bash
npm install -g @minimax-ai/code \
  --allow-scripts=@minimax-ai/code,better-sqlite3 \
  --registry=https://registry.npmjs.org/
```

卸载：`npm uninstall -g @minimax-ai/code`；更新：`mcode update`。

## CLI 速查

```bash
mcode                      # 启动 TUI
mcode "任务描述"            # 带初始任务启动
mcode --continue           # 继续当前 workspace 最近的 Session
mcode --session            # 浏览 Session
mcode --session <id>       # 按 ID 打开
mcode --tui-mode fullscreen
mcode -m <provider/model>  # 仅本次 Session 换模型
mcode init                 # 分析代码库生成 AGENTS.md
mcode exec "..."           # 无头执行一次
mcode exec review          # 审查 staged/unstaged/untracked 改动
mcode acp                  # 以 ACP 服务运行
mcode login / logout       # 登录态（--region cn|global）
mcode update
mcode provider list|add|remove|test|use|set-minimax-key
mcode plugin list|add|remove|enable|disable|marketplace
```

完整参数见 `reference/cli.md`。经核实**不存在**的子命令见 VERIFICATION §1.1。

## TUI slash 命令

在 TUI 输入框以 `/` 开头即可调用，共 **52** 条 = 基础 11 + 分类 41。
分类及条数：Session 13、Application 11、Runtime 7、Decision 5、Input 2、
Transcript 2、Capability 1。

**核心命令**

| 命令 | 作用 |
| --- | --- |
| `/help` | 显示可用命令 |
| `/new`（别名 `/clear`） | 在当前 workspace 开新 Session |
| `/model` | 选择模型与思考强度 |
| `/status` | 账号与模型状态 |
| `/doctor` | 检查本地配置文件 |
| `/context` | Runtime 上下文快照 |
| `/skills` | 列出内置与用户 Skill |
| `/mcp` | 查看 MCP 能力与项目配置 |
| `/usage` | Session 用量 |
| `/compact` | 压缩当前对话 |
| `/export [path.md]` | 导出 Session 为 Markdown |

**会话与对话**：`/sessions`（`/resume`）、`/goal`、`/plan`、`/review`、`/parent`、
`/btw`（`/side`）、`/history`、`/fork`、`/rewind`、`/edit`、`/retry`、`/rename`、`/archive`

**运行控制**：`/permission`、`/tasks`、`/queue`、`/steer`、`/stop`、`/config`

**界面与能力**：`/settings`、`/statusline`、`/theme`、`/hotkeys`、`/plugins`、
`/provider`、`/reload`、`/add-dir`、`/transcript`、`/copy`

**决策与其它**：`/allow`、`/always`、`/deny`、`/permissions`、`/decision`、
`/login`、`/logout`、`/feedback`、`/checkin`、`/changelog`、`/update`、`/quit`（`/exit`）

全表（含参数提示与分类）见 `reference/commands.md`。

**输入判别规则**：无参数的命令只在命令名后没有正文时执行（允许尾随空白）；
一旦继续输入正文，整句作为普通提示词发送。`/context` 是命令，`/context 解释这个项目` 是提示词。
接受参数的命令（如 `/sessions [query]`）仍按命令处理。

## 权限模式

`PermissionMode` 取值：`default`、`acceptEdits`、`bypassPermissions`、`auto`、`off`。

TUI 中对应 Ask / Auto / Full access 三档界面文案：
`default` → "Confirm sensitive actions"、`auto` → "Ask only when risk is high"、
`bypassPermissions` → "Run without confirmation"。

`mcode exec --permission` 是**另一套命名空间**：`smart | full | off`。不要混用。

详见 `reference/permissions.md`。

## Hook 系统

mcode 支持**插件级同步 command Hook**，事件模型**兼容 Claude Code**：

```
SessionStart  SessionEnd  UserPromptSubmit  PreToolUse  PermissionRequest
PostToolUse   SubagentStart  SubagentStop  Stop  PreCompact  PostCompact
```

支持 `MINIMAX` / `CLAUDE` / `CODEX` 三种来源格式。**仅同步 `type: "command"` 受支持**，
`async` / `asyncRewake` 一经置 `true` 即判为不支持。

```json
{ "hooks": { "Stop": [ { "hooks": [
  { "type": "command", "command": "node \"${PLUGIN_ROOT}/scripts/notice.cjs\"", "timeout": 5 }
] } ] } }
```

`timeout` 单位为**秒**，取值 1–10（缺省 5000 ms，上限 10000 ms）。单插件可执行处理器至多 64 个。

Hook 进程从 stdin 读取单个 JSON 对象（含 `hook_event_name`、`session_id`、`cwd`、
`transcript_path` 及事件特有字段）；环境变量**只继承 17 个白名单变量**，
其余凭据须由插件自身声明，插件根目录只读，可写状态写入 `PLUGIN_DATA`。

控制输出可返回 `decision`、`reason`、`additionalContext`、`updatedInput`、
`updatedResult`、`systemMessage` 等字段；`PermissionRequest` 另可返回
`updatedPermissions` 原子更新权限。**exit 2**（非 `MINIMAX` 格式）触发阻断且
JSON 无法覆盖；多处理器按**最强裁决合并**。

输出 `{"systemMessage":"..."}` 并 exit 0，可在 TUI 显示提示而**不写入模型上下文**。

详见 `reference/plugins.md`。

## 配置

主配置 `~/.minimax/config.yaml`。关键键：`logLevel`、`provider`、`defaultModel`、
`permissionMode`、`custom_provider`、`tui`、`statusLine`、`defaultModelThinking.effort`。
MCP 单独放 `~/.minimax/mcp.json`（用户级）与 `<workspace>/.mcp.json`（项目级）。

`/config` 可查看生效的只读配置。完整键位见 `reference/config.md`。

## 内置 Agent 与 Skill

- **内置 Agent**：`mavis`、`explore`、`worker`、`verifier`
- **内置 Skill**：`code-review`、`deep-research`、`deploy-website`、`docx`、
  `edit-deployed-website`、`init`、`lark-tools`、`llm-call`、`mcode-tools-master`、`pdf`、
  `pptx`、`resume-codex`、`skill-creator`、`skill-refiner`、`visual-page`、`xlsx`

> 内置 Agent 以包内 `assets/agents/builtin-agents.json` 为准。用户在 `~/.minimax/agents/`
> 下自建的 Agent 不属于内置清单，不要混入。内置 Skill 以运行时 `~/.minimax/.builtin-skills/`
> 目录为准；在 0.5.8 中包内布局按 Agent 分散在 `assets/agents/mavis/skills/`。

详见 `reference/agents-skills.md`。

## 配套文档站

本插件附带一套**纯静态 HTML 文档站**，不依赖 MCP 服务，亦无需启动任何本地服务；
双击 `site/index.html` 即可离线阅读。其内容与本 Skill 一致，视觉系统参照 MiniMax 开放平台文档。

站点为**中英双语**，两份独立 HTML 共享同一套 `assets/style.css` 与 `assets/app.js`：
`site/index.html`（中文，默认入口）与 `site/index.en.html`（英文）。两版的锚点集合与顺序完全一致，
互相以 `#` 锚点交叉链接。顶栏提供语言切换，**不做任何语言自动判定**——打开哪份文件就是哪种语言，
确定性优先于猜测。主题同理：默认浅色，深色为用户手动选择后才生效并记住，不读系统偏好。
不使用 `fetch` 加载语言包——该接口在 `file://` 下被浏览器拦截，双击打开必须可用。

## 存在性问题的应答规程

回答"mcode 是否具备某项能力"时，按以下次序组织：

1. 先给出判定结论：**具备 / 不具备 / 具备但需开启特定开关**。
2. 若具备，给出**真实可执行**的入口（命令或配置路径）。
3. 若不具备，给出**替代路径**（例如"不提供文件快照回滚，应以 git 管理改动"）。
4. 涉及配置键时，提示用户经 `/config` 或 `mcode exec --config` 核对生效值。

## 参考文件

| 文件 | 内容 |
| --- | --- |
| `VERIFICATION.md` | 全部内容的取证台账，含反例与修正记录 |
| `reference/commands.md` | slash 命令全表 |
| `reference/cli.md` | CLI、`exec`、`acp` 完整参数 |
| `reference/config.md` | 配置文件结构与全部已知键 |
| `reference/agents-skills.md` | 内置 Agent、Skill 与扩展机制 |
| `reference/plugins.md` | 三类概念的区分、插件 manifest 与 Hook 契约 |
| `reference/miniapp.md` | MiniApp 契约、与 MCP 的差异、生命周期与编写 |
| `reference/mcp-tools.md` | 内置工具、MCP、附件 |
| `reference/permissions.md` | 权限模式、Plan Mode、会话管理 |
| `reference/coverage.md` | opencode v2 章节 → mcode 能力逐条对照 |
