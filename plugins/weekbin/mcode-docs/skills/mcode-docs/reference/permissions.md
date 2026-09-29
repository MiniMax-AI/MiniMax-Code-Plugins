# 权限、Plan Mode 与会话

## 权限模式

`PermissionMode` 共 **5** 个取值（源码 `packages/config/src`）：

```
"default" | "acceptEdits" | "bypassPermissions" | "auto" | "off"
```

TUI 界面文案：

| 内部取值 | 界面文案 | 含义 |
| --- | --- | --- |
| `default` | Ask | Confirm sensitive actions（敏感操作先确认） |
| `auto` | Auto | Ask only when risk is high（仅高风险时确认） |
| `bypassPermissions` | Full access | Run without confirmation（不确认） |
| `acceptEdits` | — | 自动接受编辑类操作 |
| `off` | — | 关闭权限管控 |

### 三套命名空间，不要混用

| 场景 | 取值 |
| --- | --- |
| TUI `/permission [status \| ask \| auto \| full]` | `ask` / `auto` / `full`（界面语义） |
| `config.yaml` 的 `permissionMode` | `default` / `acceptEdits` / `bypassPermissions` / `auto` / `off` |
| `mcode exec --permission` | `smart` / `full` / `off`（`ask` 需 TUI/ACP） |

**建议**：在不熟悉的代码库中，选择能够完成任务的**最小权限**。

## 处理单次决策

| 命令 | 作用 |
| --- | --- |
| `/allow` | 本次允许该待决工具 |
| `/always` | 始终允许该类操作 |
| `/deny` | 拒绝该待决工具 |
| `/decision` | 重新打开待决操作面板 |
| `/permissions` | 查看 Runtime 持有的待决权限请求 |

**注意**：`/always` 授予的是**操作类别**（action class）级别的永久允许，
范围大于单次工具。在陌生仓库中慎用。

## Plan Mode

`/plan [on | off | status | view]` —— 在修改代码前先审阅实现计划。

- 进入或退出 Plan 的下一条消息会走恢复选择流程。
- 选择 `Keep my draft` 或按 `Esc` 后，草稿可继续编辑、重新发送，不会发布本次发送的结果。
- 未生效的 Plan 切换会被保留。
- 若恢复发送时会话已被另一轮占用，草稿保留并提示失败，由用户再次发送。

## 会话管理

| 能力 | 入口 |
| --- | --- |
| 新建 | `/new`（别名 `/clear`）、命令行 `mcode` |
| 浏览 / 继续 / 管理 | `/sessions [query]`（别名 `/resume`）、`mcode --session`、`mcode --continue` |
| 重命名 | `/rename [title]` |
| 归档 | `/archive` |
| 历史回溯 | `/history`、`/fork`、`/rewind`、`/edit` |

> **注意**：会话**重命名**用 `/rename [title]`。mcode **没有**独立的 `/name` 命令
> （该名称在 TUI 源码的两个命令注册表中均不存在）。
| 导出 | `/export [path.md]` |
| 复制最近回复 | `/copy` |

`/sessions` 支持普通文本搜索，也支持 `id:`、`path:`、`type:`、`status:`、`model:` 筛选。

### 历史变更三命令

| 命令 | 行为 |
| --- | --- |
| `/fork` | 从历史用户消息创建**子会话**，不修改当前会话或文件 |
| `/edit` | 替换该提示词并从这里**重新生成**；后续对话与文件改动将被移除 |
| `/rewind` | 移除后续消息；可选「仅回退会话（文件不变）」或「回退会话和文件（还原可安全恢复的文件改动）」 |

前置条件：需已启动或恢复 Session；回复运行中不可用
（`Stop the running response before changing Session history.`）。

> `/rewind` 的文件还原是**会话回退的附带行为**，不等于全局文件快照系统。
> mcode **没有** opencode 那种可任意跳转的文件快照与一键回滚。

## 运行控制

| 命令 | 作用 |
| --- | --- |
| `/stop` | 中断当前回合 |
| `/queue` | 管理当前回复之后才运行的消息；暂停队列按 `c` 可从队首继续 |
| `/steer <message>` | 不中断地引导当前工作 |
| `/tasks` | 查看后台 Agent 与 Runtime 任务 |
| `/goal <objective \| action>` | 启动或管理当前 Session Goal |

Composer 中按 `Enter` 将输入 steer 给当前回合；按 `Alt+Enter` 放入 Queue 留给下一回合。
已排队的最新消息可用 `Alt+↑`（macOS 为 `Option+↑`）或 `Shift+←` 召回。

## Side 会话（`/btw`）

- `/btw [question]`（别名 `/side`）从最近一个已提交的会话边界 fork 出临时侧会话，
  **主任务继续运行且不被中断**。
- 侧会话以只读上下文继承主会话历史，工具权限与主会话一致，沿用当前权限模式且不追加独立确认。
- `/parent` 或 `Ctrl+/` 在侧会话与主会话视图间切换，不结束任何一方。
- 侧会话是**临时**的：不出现在 `/sessions` 中，切换 Session 时自动清理。
- 切换快捷键只切换已创建的侧会话，**不会创建**侧会话；尚未执行 `/btw` 时会黄色提示。

侧会话视图中只有只读命令可用：`help`、`changelog`、`context`、`status`、`usage`、
`export`、`transcript`、`copy`、`parent`。
