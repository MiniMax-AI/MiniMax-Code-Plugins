# ticktick — TickTick task management

> Manage your TickTick (international) tasks, lists, habits, focus records and countdowns from MiniMax Code through the official TickTick MCP server. 适用于国际版 TickTick（ticktick.com）账号；国内版滴答清单用户请使用 `dida365` 插件。

## Try it

```text
What are my tasks today? Group them by list and priority.
```

```text
Split this week's exam prep into 5 daily tasks in my "Study" list, 2 PM every day, medium priority.
```

```text
Show me what I completed last week, then check in my "early rise" habit for today.
```

## How it works

This plugin connects MiniMax Code to the official TickTick MCP server:

- Endpoint: `https://mcp.ticktick.com` (Streamable HTTP only; SSE is not supported)
- Exposes 40+ official tools: task CRUD, list / column / folder management, comments, assignment, tags, habit check-ins, focus records and countdowns
- The bundled Skill teaches the agent to use these tools safely: look before changing, confirm before deleting, clarify ambiguous requests, and split complex requests into steps

## Requirements

- An **international TickTick (ticktick.com) account**. China-version 滴答清单 (dida365.com) accounts are a separate system with no shared data — use the `dida365` plugin in this repository instead.
- Authorization (the first is recommended):
  - **API Token (Bearer, verified working)**: TickTick web app → avatar → Settings → Account → API Token, then add the `Authorization: Bearer <your token>` header in your client's MCP configuration. MiniMax Code currently offers no OAuth connect UI for plugin-declared MCP servers, so use this method there.
  - **OAuth**: the TickTick MCP endpoint itself supports OAuth discovery; if your client provides a native authorization popup for remote MCP servers (e.g. Claude, Cursor), you can supply just the URL and let the client start the flow.
- This plugin ships no credentials and never asks you to hand credentials to the plugin itself; tokens stay between you, your client, and the official TickTick service.

## Data and network

- Network target: `mcp.ticktick.com` (HTTPS) only, the official TickTick service.
- Data usage: reads, creates, updates and deletes tasks, lists, habits, focus records and countdowns in your own account, only at your instruction.
- No data passes through any third-party server; this plugin collects and uploads nothing.
- Destructive operations (trashing tasks, dissolving folders) are irreversible — the agent is instructed to require your explicit confirmation first.

## Limitations

- Only basic operations for tasks, lists, habits, focus records and countdowns are supported; advanced features such as calendar views and smart lists are not available (an official MCP limitation).
- Habit check-in backfill is limited to the last 90 days; undone-task date-range queries span at most 14 days; focus records are returned at most one month per call.
- Completing tasks in a list in bulk is limited to 20 per call.

## Known issues (observed in manual testing)

- **`priority` gets stringified under the MiniMax-M3 model** (tested 2026-08-15): in MiniMax Code with MiniMax-M3, integers in tool arguments get forcibly quoted (`"priority": 5` → `"priority": "5"`), causing `create_task` / `update_task` / `batch_update_tasks` to be rejected by the server (`must be integer`). MiniMax-M2.7 and Kimi-K2.7-Code produce correct output on identical input, and calling the official MCP directly with a JSON number is verified to work. Mitigation: the bundled Skill ships parameter rules and self-check guidance; if your model still stringifies, create the task without a priority and set the flag manually in the app. All other fields (title, dates, lists) read and write normally.
- **Datetime offset format**: `dueDate` must pass the JSON Schema `date-time` check — write the offset as `+08:00`, not `+0800`.
- **`delete_task` requires both `task_id` and `project_id`** (get list IDs from `list_projects` or from the create_task response).

## Links

- Official MCP documentation: https://help.ticktick.com/articles/7438129581631995904
