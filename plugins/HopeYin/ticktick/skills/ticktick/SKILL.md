---
name: ticktick
description: Manage TickTick (international, ticktick.com) tasks, lists, habits, focus records and countdowns through the official TickTick MCP server at mcp.ticktick.com. Use when the user asks to check, plan, create, update, complete or review tasks and habits on TickTick, or asks about focus history and countdowns.
---

# TickTick task management

Manage the user's tasks, lists, habits, focus records and countdowns through the official TickTick MCP server (`https://mcp.ticktick.com`, Streamable HTTP). This Skill is for **international TickTick (ticktick.com) accounts only**; for the China version (滴答清单 / dida365.com) use the `dida365` plugin instead.

## Before you start

- The user must have completed authorization (OAuth or API Token). If any tool call returns an authentication error, tell the user: TickTick web app → avatar → Settings → Account → API Token, or redo the OAuth flow.
- On first use, call `list_projects` to learn the user's list structure before operating on tasks.

## Operating rules

1. **Look before you change.** Before updating, completing, moving or deleting a task, locate it with `search_task` or `filter_tasks`, show the user exactly what you are about to do, then act.
2. **Deletion is irreversible.** `delete_task` moves a task to the trash and `delete_project_group` dissolves every list inside the folder — always get explicit user confirmation first.
3. **Be specific.** When a request is ambiguous (no list name, date or priority), ask before creating or modifying anything. Do not guess.
4. **Split complex requests.** "Review last week and reschedule this week" should run as: query → summarize to the user → confirm → batch operation.

## Tool map

- **Query**: `search_task` (keywords), `get_task_by_id`, `list_undone_tasks_by_time_query` (today / tomorrow / last7day / next7day, etc.), `list_undone_tasks_by_date` (max 14-day span), `list_completed_tasks_by_date`, `filter_tasks` (multi-condition)
- **Lists**: `list_projects`, `create_project`, `update_project`, `get_project_with_undone_tasks`; columns via `list_columns` / `create_column` / `update_column`; folders via `list_project_groups` / `create_project_group` / `update_project_group` / `delete_project_group`
- **Tasks**: `create_task`, `batch_add_tasks`, `complete_task`, `complete_tasks_in_project` (max 20 per call), `update_task`, `move_task`, `batch_update_tasks`, `delete_task` (requires both `task_id` and `project_id`)
- **Comments & assignment**: `get_comment`, `add_comment`, `delete_comment`, `assign_task`, `unassign_task`, `project_member`
- **Tags**: `list_tags`, `create_tag`
- **Habits**: `list_habits`, `create_habit`, `update_habit`, `get_habit_checkins`, `upsert_habit_checkins` (check-ins limited to the last 90 days)
- **Focus records**: `get_focuses_by_time` (max one month per call), `create_focus`, `delete_focus`
- **Countdowns**: `list_countdowns`

## Parameter conventions

- **Object parameters must be real JSON objects, never stringified JSON.** Testing shows some models (e.g. MiniMax-M3) emit `task` as a string and quote integers, corrupting every inner field type:
  - ❌ Wrong: `"task": "{\"title\": \"x\", \"priority\": 5}"`
  - ✅ Correct: `"task": {"title": "x", "priority": 5}`
  - If the server's `Received arguments` echo shows quoted values, the call was stringified — immediately resend in object form.
- Priority: 0 = none, 1 = low, 3 = medium, 5 = high. "High priority" means 5.
- **Pass `priority` as a JSON number** (`"priority": 5`, never quoted). If the server replies `task.priority: must be integer`, the value was stringified somewhere in the call chain: confirm you sent a number and retry once; if it still fails, the client's serialization layer is at fault — create the task without a priority and tell the user to set the flag manually in the TickTick app.
- Use ISO 8601 datetimes with an explicit offset, e.g. `2026-08-16T15:00:00-07:00`. The offset must contain a colon (`+08:00`); `+0800` is rejected by the date-time format check.
- Prefer `batch_add_tasks` / `batch_update_tasks` over repeated single calls.

## Typical flows

- **Today overview**: "What's on my plate today?" → `list_undone_tasks_by_time_query` (today), grouped by list and priority.
- **Plan breakdown**: "Split this week's exam prep into daily tasks" → confirm list and daily schedule first, then `batch_add_tasks`.
- **Evening review**: "What did I finish today? Check in my habits." → `list_completed_tasks_by_date` + `get_habit_checkins`, summarize, then `upsert_habit_checkins`.
- **Focus stats**: "How much did I focus this month?" → `get_focuses_by_time` and summarize the trend.

## Troubleshooting

- Task not found: ask for the list name, date or a keyword, or list candidates with `search_task` and let the user pick.
- Create/update failures: check parameters against the conventions above, split the request into smaller steps and retry.
- This MCP covers only basic operations for tasks, lists, habits, focus records and countdowns. Advanced features such as calendar views and smart lists are out of scope — do not promise them.
