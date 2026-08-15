# dida365 — 滴答清单任务管理

> Manage your 滴答清单 (Dida365 China) tasks, lists, habits, focus records and countdowns from MiniMax Code through the official Dida365 MCP server. 在 AI 对话里直接管理你的滴答清单：查任务、建计划、做复盘、习惯打卡，不用切换应用。

## Try it

```text
我今天有哪些任务？按清单和优先级整理一下。
```

```text
帮我把这周的高数复习拆成 5 天的任务，放进「学习」清单，每天下午 2 点，中优先级。
```

```text
看看我上周完成了哪些任务，然后给我的「早起」习惯补上今天的打卡。
```

```text
帮我把这期技术周报整理一下，批量添加到滴答清单对应清单里。
```

## How it works

本插件将 MiniMax Code 连接到滴答清单官方 MCP 服务器：

- Endpoint: `https://mcp.dida365.com`（Streamable HTTP，不支持 SSE）
- 提供 40+ 个官方工具：任务增删改查、清单 / 分组 / 文件夹管理、评论、指派、标签、习惯打卡、专注记录、纪念日
- 附带两个 Skill：
  - `dida365`：教 Agent 安全地使用这些工具 —— 先查后改、删除前确认、模糊请求先澄清、复杂请求拆步执行
  - `article2tasks`：场景化工作流 —— 把技术周报（批量）或单篇文章整理成待办，自动匹配你已有的清单并打标签，写入前必须预览确认。全程纯 MCP 调用，不依赖本地脚本或 URL Scheme，Windows / macOS / Linux 行为一致

## Requirements

- 一个**中国版滴答清单（dida365.com）账号**。国际版 TickTick 账号数据不互通，请使用本仓库的 `ticktick` 插件。
- 授权（推荐第一种）：
  - **API 口令（Bearer Token，已验证可用）**：网页版滴答清单 → 头像 → 设置 → 账户与安全 → API 口令，创建后在客户端的 MCP 配置中添加 `Authorization: Bearer <你的口令>` 请求头。MiniMax Code 目前不为插件声明的 MCP 服务器提供 OAuth 连接界面，请使用此方式。
  - **OAuth**：滴答清单 MCP 端点本身支持 OAuth 发现，如果你的客户端为远程 MCP 提供原生授权弹窗（如 Claude、Cursor），可以只填 URL 由客户端发起授权。
- 本插件不包含任何密钥，也不要求你向插件本身提供凭据；凭据只存在于你和客户端、滴答清单官方服务之间。

## Data and network

- 网络目标：仅 `mcp.dida365.com`（HTTPS），滴答清单官方服务。
- 数据用途：在你的指令下读取、创建、更新、删除你自己账号下的任务、清单、习惯、专注记录和纪念日数据。
- 数据不经过任何第三方服务器，本插件自身不收集、不上传任何信息。
- 删除任务（移入垃圾箱）、解散文件夹等操作不可逆，Agent 被指示在执行前必须得到你的明确确认。

## 局限性

- 仅支持任务、清单、习惯、专注记录、纪念日的基础操作；日历视图、智能清单等高级功能暂不支持（官方 MCP 的限制）。
- 习惯打卡补录范围限最近 90 天；未完成任务的日期范围查询跨度最大 14 天；专注记录一次最多查询一个月。
- 批量完成清单内任务每次最多 20 个。

## 已知问题（实测记录）

- **`priority` 在 MiniMax-M3 模型下会被字符串化**（2026-08-15 实测）：在 MiniMax Code 中使用 MiniMax-M3 时，工具入参中的整数会被强制加引号（`"priority": 5` → `"priority": "5"`），导致 `create_task` / `update_task` / `batch_update_tasks` 被服务端拒绝（报 `must be integer`）。MiniMax-M2.7 和 Kimi-K2.7-Code 在相同输入下输出正常；直连官方 MCP 以 JSON 数字调用也已验证正常。应对：Skill 已内置传参规则与自检指引；若所用模型仍字符串化，先不带优先级创建任务，再到 App 内手动设置旗标。其余字段（标题、时间、清单等）读写正常。
- **时间偏移量格式**：`dueDate` 必须通过 JSON Schema `date-time` 校验，偏移量写作 `+08:00` 而非 `+0800`。
- **`delete_task` 需要同时提供 `task_id` 和 `project_id`**（清单 ID 可通过 `list_projects` 或创建任务的返回值获得）。

## Links

- 官方 MCP 文档：https://help.dida365.com/articles/7438132116019216384

## Credits

- `article2tasks` Skill 的「整理 → 预览 → 确认 → 执行」工作流与分类思路改编自 [article2ticktick](https://github.com/balabalabalading/article2ticktick)（MIT License），原作者 Mr.H。本实现改为纯 MCP 写入，不沿用其 URL Scheme + 本地脚本方案。
