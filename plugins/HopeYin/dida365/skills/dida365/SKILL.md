---
name: dida365
description: Manage 滴答清单 (Dida365 China) tasks, lists, habits, focus records and countdowns through the official Dida365 MCP server at mcp.dida365.com. Use when the user asks to check, plan, create, update, complete or review tasks and habits on dida365.com, or asks about focus history and countdowns.
---

# 滴答清单任务管理

通过滴答清单官方 MCP 服务器（`https://mcp.dida365.com`，Streamable HTTP）管理用户的任务、清单、习惯、专注记录和纪念日。本 Skill 只适用于**中国版滴答清单（dida365.com）账号**；国际版 TickTick 账号请使用 `ticktick` 插件。

## 使用前确认

- 用户必须已完成授权（OAuth 或 API 口令）。如果任何工具调用返回认证错误，提示用户：网页版滴答清单 → 头像 → 设置 → 账户与安全 → API 口令，或重新走 OAuth 授权。
- 首次协助时，可以先调用 `list_projects` 了解用户的清单结构，再执行任务操作。

## 操作守则

1. **先查后改**。更新、完成、移动、删除任务前，先通过 `search_task` 或 `filter_tasks` 确认目标任务，把将要执行的操作告诉用户，再执行。
2. **删除不可逆**。`delete_task` 会把任务移入垃圾箱，`delete_project_group` 会解散文件夹下所有清单 —— 执行前必须得到用户的明确确认。
3. **描述要明确**。用户表述模糊时（没说是哪个清单、哪天、什么优先级），先问清楚再创建或修改，不要猜。
4. **复杂请求拆步执行**。例如「把上周任务复盘并重新安排这周」应拆成：查询 → 汇总给用户 → 确认后批量操作。

## 工具速查

- **查询**：`search_task`（关键词）、`get_task_by_id`、`list_undone_tasks_by_time_query`（today / tomorrow / last7day / next7day 等）、`list_undone_tasks_by_date`（跨度最大 14 天）、`list_completed_tasks_by_date`、`filter_tasks`（多条件组合）
- **清单**：`list_projects`、`create_project`、`update_project`、`get_project_with_undone_tasks`；分组用 `list_columns` / `create_column` / `update_column`；文件夹用 `list_project_groups` / `create_project_group` / `update_project_group` / `delete_project_group`
- **任务**：`create_task`、`batch_add_tasks`、`complete_task`、`complete_tasks_in_project`（每次最多 20 个）、`update_task`、`move_task`、`batch_update_tasks`、`delete_task`（需同时提供 `task_id` 和 `project_id`）
- **评论与指派**：`get_comment`、`add_comment`、`delete_comment`、`assign_task`、`unassign_task`、`project_member`
- **标签**：`list_tags`、`create_tag`
- **习惯**：`list_habits`、`create_habit`、`update_habit`、`get_habit_checkins`、`upsert_habit_checkins`（打卡范围限最近 90 天）
- **专注记录**：`get_focuses_by_time`（一次最多查一个月）、`create_focus`、`delete_focus`
- **纪念日**：`list_countdowns`

## 参数约定

- **对象参数必须传真正的 JSON 对象，绝不能传字符串化的 JSON**。实测发现部分模型（如 MiniMax-M3）会把 `task` 写成字符串、把整数加引号，导致内部字段类型全部失真：
  - ❌ 错误：`"task": "{\"title\": \"x\", \"priority\": 5}"`
  - ✅ 正确：`"task": {"title": "x", "priority": 5}`
  - 若服务端回显的 `Received arguments` 里参数值带引号，说明本次调用已被字符串化，立即改用对象形式重发。
- 优先级：0 = 无，1 = 低，3 = 中，5 = 高。用户说「高优先级」时用 5。
- **`priority` 必须以 JSON 数字类型传递**（`"priority": 5`，不要加引号）。若服务端报 `task.priority: must be integer`，说明值在链路上被字符串化：先确认自己传的是数字后原样重试；仍失败则说明客户端序列化层存在问题，改为不带优先级创建任务，并告知用户在滴答清单 App 里手动设置旗标。
- 日期时间使用 ISO 8601 并带时区，例如 `2026-08-16T15:00:00+08:00`。注意偏移量必须带冒号（`+08:00`），`+0800` 会被 date-time 格式校验拒绝。
- 批量操作建议优先用 `batch_add_tasks` / `batch_update_tasks`，减少调用次数。

## 典型场景

- **今日概览**：「我今天有哪些任务？」→ `list_undone_tasks_by_time_query`（today），按清单和优先级整理输出。
- **学习计划拆解**：「帮我把这周的高数复习拆成每天的任务」→ 先确认清单和每天的时间安排，再用 `batch_add_tasks` 批量创建。
- **晚间复盘**：「看看我今天完成了什么，给习惯打卡」→ `list_completed_tasks_by_date` + `get_habit_checkins`，汇总后用 `upsert_habit_checkins` 补打卡。
- **专注统计**：「我这个月专注了多久？」→ `get_focuses_by_time`，按月汇总趋势。

## 失败排查

- 找不到任务：让用户补充清单名、日期或关键词，或先 `search_task` 列出候选让用户指认。
- 创建 / 更新失败：检查参数是否符合上方约定，把复杂请求拆小后重试。
- 该 MCP 仅支持任务、清单、习惯、专注、纪念日的基础操作；日历视图、智能清单等高级功能不在能力范围内，不要承诺。
