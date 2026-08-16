# dida365 — 滴答清单任务管理

> Skills for managing your 滴答清单 (Dida365 China) tasks, lists, habits, focus records and countdowns through the official Dida365 MCP server. 本插件是纯 Skill 包：教会 Agent 安全、专业地操作滴答清单官方 MCP（40+ 工具），并提供「周报/文章批量转待办」的场景化工作流。

## Try it

```text
我今天有哪些任务？按清单和优先级整理一下。
```

```text
帮我把这周的高数复习拆成 5 天的任务，放进「学习」清单，每天下午 2 点。
```

```text
帮我把这期技术周报整理一下，批量添加到滴答清单对应清单里。
```

## How it works

这是一个 **Skill-only 插件**，包含两个 Skill：

- `dida365`：任务管理守则 —— 先查后改、删除类操作（`delete_task` / `delete_project_group` / `delete_comment` / `delete_focus`）前必须明确确认、模糊请求先澄清、复杂请求拆步执行，附参数约定（优先级 0/1/3/5 必须为 JSON 数字、ISO 8601 日期偏移量带冒号、批量上限、`delete_task` 需要 `task_id` + `project_id`）和失败排查指引。
- `article2tasks`：场景化工作流 —— 把技术周报（批量）或单篇文章整理成待办，通过 `list_projects` 动态匹配你已有的清单并打标签，写入前必须预览确认。纯 MCP 调用，不依赖本地脚本，Windows / macOS / Linux 行为一致。

**为什么不自带 MCP 连接**：MCode 当前的可移植插件不支持插件级密钥/OAuth 配置，插件内声明的 MCP 连接无法携带你的凭据。因此本插件不内置 `mcp.json`，由你在客户端全局 MCP 设置中自行添加官方服务器（见下方配置）。

## Setup（一次性配置）

1. 获取 API 口令：网页版滴答清单 → 头像 → 设置 → 账户与安全 → API 口令。
2. 在 MiniMax Code 的**全局 MCP 设置**中添加服务器：
   - 类型：Streamable HTTP
   - URL：`https://mcp.dida365.com`
   - Header：`Authorization: Bearer <你的口令>`
3. 安装本插件，Skills 会在你提出任务管理需求时自动生效。

如果你的客户端为远程 MCP 提供原生 OAuth 弹窗（如 Claude、Cursor），也可以只填 URL 走 OAuth 授权。

需要一个**中国版滴答清单（dida365.com）账号**；国际版 TickTick 账号数据不互通，请使用本仓库的 `ticktick` 插件。

## Data and network

- 本插件自身**不发起任何网络请求**、不收集上传任何信息、不含任何凭据。
- 任务数据读写发生在你配置的官方 MCP 服务器（`mcp.dida365.com`，HTTPS）与你自己的账号之间，仅在你的指令下进行。
- `article2tasks` 会处理你提供的**周报正文、文章 URL 和本地文件路径**：这些内容由 Agent/模型读取和整理，整理结果（标题、推荐语、来源链接、分类、标签）可能写入你的滴答清单。请勿输入你不希望模型处理或写入任务列表的内容。
- 你的 API 口令只保存在你自己的客户端配置中，插件不会也无法读取它。

## 局限性

- 官方 MCP 仅支持任务、清单、习惯、专注记录、纪念日的基础操作；日历视图、智能清单等高级功能暂不支持。
- 习惯打卡补录范围限最近 90 天；未完成任务的日期范围查询跨度最大 14 天；专注记录一次最多查询一个月；批量完成清单内任务每次最多 20 个。

## 已知问题（实测记录）

- **`priority` 在 MiniMax-M3 模型下会被字符串化**（2026-08-15 实测）：在 MiniMax Code 中使用 MiniMax-M3 时，工具入参中的整数会被强制加引号（`"priority": 5` → `"priority": "5"`），导致 `create_task` / `update_task` / `batch_update_tasks` 被服务端拒绝（报 `must be integer`）。MiniMax-M2.7 和 Kimi-K2.7-Code 在相同输入下输出正常；直连官方 MCP 以 JSON 数字调用也已验证正常。应对：Skill 已内置传参规则与自检指引；若所用模型仍字符串化，先不带优先级创建任务，再到 App 内手动设置旗标。其余字段（标题、时间、清单等）读写正常。
- **时间偏移量格式**：`dueDate` 必须通过 JSON Schema `date-time` 校验，偏移量写作 `+08:00` 而非 `+0800`。
- **`delete_task` 需要同时提供 `task_id` 和 `project_id`**（清单 ID 可通过 `list_projects` 或创建任务的返回值获得）。

## Links

- 官方 MCP 文档：https://help.dida365.com/articles/7438132116019216384

## Credits

- `article2tasks` Skill 的「整理 → 预览 → 确认 → 执行」工作流与分类思路改编自 [article2ticktick](https://github.com/balabalabalading/article2ticktick)（MIT License），原作者 Mr.H。本实现改为纯 MCP 写入，不沿用其 URL Scheme + 本地脚本方案。
