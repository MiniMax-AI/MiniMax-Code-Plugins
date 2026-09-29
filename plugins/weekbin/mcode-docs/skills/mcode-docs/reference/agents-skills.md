# Agent、Skill 与工具

## 内置 Agent

| Agent | 用途 |
| --- | --- |
| `mavis` | 主 Agent |
| `explore` | 只读探索：不创建或编辑文件 |
| `worker` | 有界执行任务 |
| `verifier` | 独立验证交付物 |

双源互证：包内 `assets/agents/builtin-agents.json` 内容为
`["mavis", "explore", "worker", "verifier"]`，与运行时数据目录下的实际 Agent 目录完全一致。

> **注意**：运行时 `~/.minimax/agents/` 下若出现更多目录（如项目自建的 `coder`、
> `spec-expert` 等），属**用户自建 Agent**，不属于内置清单。判定内置 Agent 时
> 以包内 `builtin-agents.json` 为唯一依据，不要用运行时目录做统计。

**注意**：包内 `assets/agents/` 另有 `_default`、`desktop-task`、`workflow` 等目录，
属于配置/模板资产，**不是**内置 Agent 列表的一部分。

### 子会话

- 子 Agent 会话中用 `/parent` 返回父会话。
- 侧会话（`/btw`）以只读上下文继承主会话历史，权限与主会话一致，
  除非明确请求否则不做任何修改。

## Agent 配置

在 `config.yaml` 的 `agents` 段控制，见 `config.md`：

```yaml
agents:
  default:
    tools: [read, write, edit, bash, grep, glob]
    builtinTools: []
    skills: []
    features:
      mavis: false
      delegation: false
      webSearch: false
```

`features.delegation` 控制是否能委派子任务，`features.mavis` 控制主 Agent 能力，
`features.webSearch` 控制联网搜索。

## 内置 Skill

| Skill | 用途 |
| --- | --- |
| `code-review` | 代码审查 |
| `deep-research` | 深度研究（分步执行） |
| `deploy-website` | 发布网站到公网 URL |
| `edit-deployed-website` | 编辑已部署的网站 |
| `docx` | Word 文档创建/读取/编辑/修复 |
| `pdf` | PDF 生成、格式化、填写与读取 |
| `pptx` | PowerPoint 读取、创建与编辑 |
| `xlsx` | Excel/CSV 读取、创建、公式与图表 |
| `init` | 分析代码库生成 `AGENTS.md` |
| `lark-tools` | 飞书/Lark 全能力（CLI + 原生通道） |
| `llm-call` | 直接调用配置的 LLM 模型 |
| `mcode-tools-master` | 发现并调用 App/Connector 工具 |
| `resume-codex` | 从 Codex CLI 或 VS Code 会话继续任务 |
| `skill-creator` | 创建/改进 Skill |
| `skill-refiner` | 用证据驱动的最小补丁精修 Skill |
| `visual-page` | 主动生成可视化 HTML 页面 |

TUI 内 `/skills` 列出内置与用户 Skill。

**注意**：`xlsx`、`pdf`、`pptx`、`docx` 等在 Linux 上需要可用的本地字体；
`visual-page`、`deploy-website` 属于产出型 Skill，需要相应宿主能力或网络可达。

## 自定义 Skill

Skill 以 `SKILL.md` 为入口，通过插件 manifest 的 `skills` 数组挂载：

```json
{ "skills": ["skills/my-skill/SKILL.md"] }
```

`SKILL.md` 带 YAML frontmatter（至少 `name` 与 `description`）。
相关开关：`skills.external.enabled`（外部 Skill）、`skillEvolve.enabled`（自演进）。

## 宿主工具

| 工具 | 作用 |
| --- | --- |
| `read` | 读取文件 |
| `write` | 写文件 |
| `edit` | 精确编辑文件 |
| `bash` | 执行终端命令 |
| `grep` | 内容搜索（ripgrep） |
| `glob` | 按文件名/路径搜索 |
| `task` | 派发子 Agent |
| `todowrite` | 维护任务清单 |
| `skill` | 调用 Skill |
| `ask_user` | 向用户收集结构化决策 |
| `web_search` | 联网搜索 |
| `web_fetch` | 抓取 URL 原始文本 |

此外还有 MCP 提供的 `mcp__*` 工具。**Browser 工具经实测未装配到 TUI/CLI**——即便本机
`beta.browserUseTooling` 为真，`mcode exec` 自列的工具清单中也没有 `navigate`／`open_tab`／
`screenshot` 等条目；它属桌面端宿主能力。终端侧需要联网取信息时用 `web_search` 与
`web_fetch`（见 VERIFICATION §9、§14.5）。

## Bash 工具的真实行为

- **退出码 0 才算成功**；结果保留退出、信号、超时、取消与部分输出等事实。
- 大输出保留**首尾**，首响应文本预算 **24 KiB**，持久化成功时给出完整日志引用。
- 前台等待：有原生 `task_output` 时最多等 **60 秒**，之后返回同一命令的后台任务 ID；
  总命令超时默认 **600 秒**，上限 **600 秒**。无 `task_output` 时保持前台，
  默认 **120 秒**、上限 **300 秒**。
- `task_output` 按字节偏移读取；一次成功读取也可能报告命令失败。
- 可选的 `description` 只影响 TUI 摘要，不影响执行与权限检查。

## 停止对话与后台工作

显式停止（如 TUI 中按 `Esc`）会取消该对话在当前进程内拥有的后台 Bash 命令与子 Agent，
包括 `task_append` 续跑及其子回合派生的工作。完成通知不再自动唤醒对话。

用 `/clear` 或切换 Session 离开对话时，会停止当前回合并暂停 Goal 与排队指令，
但**后台工作继续运行**。

只取消本地拥有的运行中任务；由其它 Runtime 进程持有的任务不受影响。
