# ticktick — TickTick task management

> Skills for managing your TickTick (international) tasks, lists, habits, focus records and countdowns through the official TickTick MCP server. 适用于国际版 TickTick（ticktick.com）账号；国内版滴答清单用户请使用 `dida365` 插件。

## Try it

```text
What are my tasks today? Group them by list and priority.
```

```text
Split this week's exam prep into 5 daily tasks in my "Study" list, 2 PM every day.
```

```text
Show me what I completed last week, then check in my "early rise" habit for today.
```

## How it works

This is a **Skill-only Plugin** containing one Skill:

- `ticktick`: task-management rules — look up before mutating, require explicit confirmation before destructive actions (`delete_task` / `delete_project_group` / `delete_comment` / `delete_focus`), clarify ambiguous requests, and split complex requests into steps. Ships parameter conventions (priority 0/1/3/5 as a JSON number, ISO 8601 datetimes with colon offsets, batch limits, `delete_task` requiring both `task_id` and `project_id`) and troubleshooting guidance.

**Why no bundled MCP connection**: MCode's portable Plugins currently cannot carry per-plugin secrets/OAuth configuration, so an MCP connection declared inside a Plugin cannot authenticate. Instead of shipping a dead `mcp.json`, this Plugin asks you to add the official server yourself in your client's global MCP settings (see Setup below).

## Setup (one-time)

1. Get an API Token: TickTick web app → avatar → Settings → Account → API Token.
2. Add a server in MiniMax Code's **global MCP settings**:
   - Type: Streamable HTTP
   - URL: `https://mcp.ticktick.com`
   - Header: `Authorization: Bearer <your token>`
3. Install this Plugin; the Skill activates whenever you ask about task management.

If your client provides a native OAuth popup for remote MCP servers (e.g. Claude, Cursor), you can supply just the URL and authorize via OAuth instead.

Requires an **international TickTick (ticktick.com) account**; China-version 滴答清单 (dida365.com) accounts are a separate system with no shared data — use the `dida365` Plugin in this repository instead.

## Data and network

- This Plugin itself **makes no network requests**, collects and uploads nothing, and ships no credentials.
- Task data is read and written between the official MCP server you configured (`mcp.ticktick.com`, HTTPS) and your own account, only at your instruction.
- Your API Token lives only in your own client configuration; the Plugin cannot read it.
- Destructive operations (trashing tasks, dissolving folders, deleting comments or focus records) are irreversible — the Skill instructs the agent to require your explicit confirmation first.

## Limitations

- The official MCP covers only basic operations for tasks, lists, habits, focus records and countdowns; advanced features such as calendar views and smart lists are not available.
- Habit check-in backfill is limited to the last 90 days; undone-task date-range queries span at most 14 days; focus records are returned at most one month per call; completing tasks in a list in bulk is limited to 20 per call.

## Known issues (observed in manual testing)

- **`priority` gets stringified under the MiniMax-M3 model** (tested 2026-08-15): in MiniMax Code with MiniMax-M3, integers in tool arguments get forcibly quoted (`"priority": 5` → `"priority": "5"`), causing `create_task` / `update_task` / `batch_update_tasks` to be rejected by the server (`must be integer`). MiniMax-M2.7 and Kimi-K2.7-Code produce correct output on identical input, and calling the official MCP directly with a JSON number is verified to work. Mitigation: the bundled Skill ships parameter rules and self-check guidance; if your model still stringifies, create the task without a priority and set the flag manually in the app. All other fields (title, dates, lists) read and write normally.
- **Datetime offset format**: `dueDate` must pass the JSON Schema `date-time` check — write the offset as `+08:00`, not `+0800`.
- **`delete_task` requires both `task_id` and `project_id`** (get list IDs from `list_projects` or from the create_task response).

## Links

- Official MCP documentation: https://help.ticktick.com/articles/7438129581631995904
