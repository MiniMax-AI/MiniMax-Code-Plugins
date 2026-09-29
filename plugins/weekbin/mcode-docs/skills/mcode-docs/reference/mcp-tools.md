# MCP 与内置工具

## MCP 配置

| 层级 | 路径 | 说明 |
| --- | --- | --- |
| 用户级 | `<数据目录>/mcp.json`（本机 `~/.minimax/mcp.json`） | 跨 workspace 生效 |
| 项目级 | `<workspace>/.mcp.json` | 由 Runtime 自动加载 |

项目级 MCP 与 Desktop、`exec`、ACP **共用配置规则**。

TUI 内用 `/mcp` 查看 MCP 能力与项目配置。

**注意**：**没有** `mcode mcp` 这个 CLI 子命令（实跑确认不存在）。

### 用户级格式

```json
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    },
    "my-server": {
      "command": "python3",
      "args": ["${PLUGIN_ROOT}/scripts/server.py"],
      "env": {
        "MCP_STATE_DIR": "${PLUGIN_DATA}/state"
      },
      "description": "说明文字",
      "enabled": true,
      "configured": true
    }
  }
}
```

字段：`type`、`command`、`args`、`env`、`description`、`enabled`、`configured`。
`env` 中可使用 `${PLUGIN_ROOT}` 与 `${PLUGIN_DATA}` 占位符。

## 工具

基础工具见 `agents-skills.md`。MCP 服务器提供的工具以 `mcp__<server>__<tool>` 形式出现。

## 附件与引用

### 命令行

```bash
mcode exec --file error.log --file ./trace.json "定位这次构建失败的原因。"
```

`--file` **可重复**。

### TUI

- 粘贴图片后 Composer 标出 `[Image #1]` 形式的编号，并在输入框上方显示预览。
- 继续输入或移开光标会收起预览；用左右方向键移回图片标签可再次查看。
- 空输入框连续按两次 `Esc`，或用 `/edit` 编辑上一条消息时，图片恢复为可操作的标签，
  支持删除、撤销和重新发送。
- 支持 Kitty 图片协议的终端，以及 regular 模式的 iTerm2 可直接显示图片；
  其它终端显示格式、尺寸与大小。
- 预览最多读取 **20 MB**、处理 **2500 万像素**；超限、格式不支持或读取失败时，
  保留文字信息与原附件。预览副本不影响原图发送，也不自动去重。

带空格的图片绝对路径在 macOS/Linux 终端支持直接粘贴、外层引号包裹
（如 `"/path/Screenshot 2026.png"`）或裸转义路径（如 `/path/Screenshot\ 2026.png`）。

## 终端内执行命令

见 `commands.md` 的「终端内直接执行命令」。要点：
`!cmd` 结果交给模型、`!!cmd` 仅本地显示，各保留最近 64 KiB，Tab 本地补全，
每条命令独立 Shell。

## 网络

`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及其小写形式均被读取；
`localhost`、`127.0.0.1`、`::1` 始终直连。详见 `config.md`。
