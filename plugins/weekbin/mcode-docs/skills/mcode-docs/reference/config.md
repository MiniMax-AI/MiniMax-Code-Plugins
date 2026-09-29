# mcode 配置

## 配置文件位置

「数据目录」是 mcode 保存全部配置与状态的根目录，各系统默认位置不同，且不随系统语言或区域变化。
`<用户名>` 指当前登录用户的名称。

| 系统 | 数据目录默认位置 |
| --- | --- |
| Windows | `C:\Users\<用户名>\.minimax\` |
| macOS | `/Users/<用户名>/.minimax/` |
| Ubuntu / Linux | `/home/<用户名>/.minimax/` |

三套系统都取**用户主目录**下的 `.minimax`，不使用 `%APPDATA%`、`%LOCALAPPDATA%` 或
`$XDG_DATA_HOME`（依据：0.5.8 随包源码中数据目录由 `homedir()` + `.minimax` 拼接，
无平台分支，C 级）。

可用 `MINIMAX_DATA_DIR` 环境变量改写到别处（例如隔离测试配置）。

| 用途 | 路径 |
| --- | --- |
| 主配置 | `<数据目录>/config.yaml` |
| 用户级 MCP | `<数据目录>/mcp.json` |
| 项目级 MCP | `<workspace>/.mcp.json` |
| 运行时权限状态 | `<数据目录>/permission.json` |
| 项目规则 | `<workspace>/AGENTS.md` |

TUI 内用 `/config` 查看**生效的只读配置**；`mcode exec --config <path>` 可为单次进程指定配置文件。

## 已验证的顶层键

| 键 | 说明 |
| --- | --- |
| `logLevel` | 日志级别 |
| `provider` | 内置 Provider 配置 |
| `defaultModel` | 默认模型，形如 `minimax/MiniMax-M3.1-Flash-Preview` |
| `permissionMode` | 权限模式，取值见 `permissions.md` |
| `custom_provider` | 自定义 Provider 映射 |
| `tui` | 终端界面行为 |
| `statusLine` / `customStatusLine` | 状态栏项，见下 |
| `defaultModelContextWindow` | 默认上下文窗口 |
| `defaultModelVariant` | 默认模型变体，如 `thinking` |
| `defaultModelThinking` | 含 `.effort`，保存默认思考强度 |

### `custom-command` 状态栏项

`custom-command` 把 `tui.customStatusLine.command` 指定的外部命令输出渲染到状态栏。
**最小可用配置**——只有 `command` 是必填：

```yaml
tui:
  statusLine:
    - custom-command    # 想显示哪几项就按顺序列
    - current-dir
  customStatusLine:
    command: ~/bin/my-status    # 唯一必填项
```

可选项：`display`（`inline` / `block`）、`position`（`above` / `below`）、
`colorMode`（`plain` / `ansi`）、`maxLines`、`timeoutMs`、`intervalSeconds`。
**写错的键会被静默丢弃，不会报错。** 命令的 stdout 即状态栏内容，
应保持轻量、避免长时间阻塞。

## `tui` 段

```yaml
tui:
  terminalTitle: [status, session-name, app-name]
  notifications:
    when: unfocused
    method: auto
    events: [turn-complete, turn-failed, permission-required, question-required]
```

### `terminalTitle`

- 可用项：`status`、`session-name`、`app-name`、`project-name`，可排序或省略。
- 设为 `null` 或 `[]` 可禁用标题更新。
- 未知项被忽略。
- 终端标题形如 `Needs approval | Fix login | MCode`；重命名或切换 Session 会更新。
- 未命名 Session 使用项目名与短 Session ID。

### `notifications`

| 键 | 取值 | 说明 |
| --- | --- | --- |
| `when` | `unfocused` / `always` / `never` | 何时通知 |
| `method` | `auto` / `osc9` / `osc777` / `bel` | 通知协议 |
| `events` | 事件数组 | 省略 = 全部四项；`[]` = 关闭 |

- 通知标识 Session 并抑制重复；完成通知会等待该 Session 的队列结束。
- `auto` 使用检测到的终端通知协议，失败回退到响铃。
- 已知前台聚焦默认抑制通知；焦点未知时为尽力而为。
- tmux 内 OSC 通知需要外层终端透传支持，可用 `method: bel` 回退。
- **配置改动需重启 mcode 生效。**

VS Code 终端默认显示进程名；要显示 mcode 的 Session 标题：

```json
"terminal.integrated.tabs.title": "${sequence}"
```

## 能力开关 `agents`

```yaml
agents:
  default:
    persona:
      enabled: false
    tools: [read, write, edit, bash, grep, glob]
    builtinTools: []
    skills: []
    features:
      mavis: false
      delegation: false
      webSearch: false
```

- `tools` —— 基础工具白名单
- `builtinTools` —— 额外启用的内置工具
- `skills` —— 启用的 Skill
- `features.mavis` / `delegation` / `webSearch` —— 子 Agent、委派、联网搜索开关
- `persona.enabled` —— 人格设定

## Memory 与其它开关

这几个开关的**默认值与直觉相反**：`memory`、`askUser`、`skillEvolve` 默认都是
**开启**，要关掉才需要显式写 `enabled: false`；只有 `memory.proactive` 默认关闭。

```yaml
memory:
  enabled: true      # 默认 true；写成 false 才关闭 Memory
  proactive: false   # 默认 false；开启后 Agent 主动写入记忆
  dailyDigest:
    enabled: false   # 默认 false

askUser:
  enabled: true      # 默认 true；置 false 时调用报 ASK_USER_DISABLED

skillEvolve:
  enabled: true      # 默认 true
```

**Memory 没有 TUI 命令入口**：命令表里不存在 `/memory`。它是后台能力，由配置开关
控制，不在 Composer 里手动调用。

## 网络代理

读取 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及其小写形式。
**无需**设置 `NODE_USE_ENV_PROXY`。`localhost`、`127.0.0.1`、`::1` 始终直连。

```bash
HTTPS_PROXY=http://127.0.0.1:7890 mcode
```

交互会话、`exec`、更新下载与 Matrix 工具请求使用相同代理规则。

## Telemetry

默认全部关闭，需分别开启（`telemetry.diagnostics` 等）。
`MCODE_DISABLE_TELEMETRY` 或 `DO_NOT_TRACK` 覆盖全部分析通道。

## 修改配置后的生效方式

- 大部分配置**重启 mcode 生效**（尤其 `tui` 段）。
- TUI 内可用 `/reload` 重载 TUI 配置与 Plugins。
- 改完建议用 `/config` 核对生效值。
