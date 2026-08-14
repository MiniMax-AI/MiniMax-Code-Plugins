---
name: convert-plugin
description: 在 DSH 与 mcode（MiniMax Code / pi）之间双向转换插件。当用户要求把 DSH 插件/preset 转成 mcode 插件、或把 mcode/pi 插件转成 DSH 插件时使用。
---

# 插件转换（DSH ↔ mcode）

本技能教 Agent 如何执行 DSH 与 mcode 之间的插件转换。转换核心（`core/run.js`）随本插件
安装在插件目录的 `core/` 下，零 npm 依赖，全程本地执行（无网络访问、无凭据）。

## 何时使用

- 用户想把 **DSH** 的 agent preset 或插件源码搬到 mcode / MiniMax Code；
- 用户想把 **mcode / pi** 的 extension 或插件包搬到 DSH；
- 用户询问两侧已有哪些插件（`list`）。

## 转换命令

插件目录即本技能所在插件的根目录（MiniMax Code 的 Local 插件中显示为 crossplug）：

```text
node "<插件目录>/core/run.js" dsh2mcode <DSH preset目录|插件源码文件> [--out <目录>]
node "<插件目录>/core/run.js" mcode2dsh <pi extension文件|插件包目录> [--out <目录>] [--host]
node "<插件目录>/core/run.js" list --side dsh|mcode
```

`--host`：mcode2dsh 输出 DSH **宿主组合插件**（`lib/index.js`，所有会话可用、不依赖 preset 选择）；
缺省输出 agent preset（`preset.yml` + `agent.cordis.yml` + `plugins/bridge.js` + `vendor/`）。

## 方向说明

### dsh2mcode（DSH → mcode）

| 输入 | 输出 |
| --- | --- |
| DSH agent preset 目录（`preset.yml` + `agent.cordis.yml`） | **agent-plugins.org 1.0.0 插件包**（`plugin.json` + `skills/`），复制到 `~/.minimax/plugins/<name>/` 后经 `/plugins` → Local 安装；工具行按映射表分类，结论逐行写入 `CONVERSION-REPORT.md` |
| DSH 插件源码文件（.js 动态插件） | **agent-plugins MCP 包**（`plugin.json` + `mcp.json` + `mcp-server.js`），工具经 MCP stdio 生效——mcode CLI 用户侧唯一的插件工具路径 |

### mcode2dsh（mcode → DSH）

| 输入 | 输出 |
| --- | --- |
| pi extension 文件/包目录 | 桥接 preset 或 host 插件：原 extension 工厂经 pi-API 垫片原样执行（逻辑零移植），工具/命令/事件桥接注册为 DSH 能力 |
| mcode 插件包（`plugin.json` / `.minimax-plugin` / `.claude-plugin`） | 自包含 preset：persona + `skills/` 复制（`dsh-skill-filesystem` 挂载） |

## 注意事项

- 转换是"脚手架 + 映射"：无法映射的能力生成带说明的桩，每项结论在 `CONVERSION-REPORT.md`。
- **mcode CLI 不加载 pi extension** ：dsh2mcode 输出的 pi extension 包仅独立 pi CLI 有效，
  面向 mcode 的产物以 agent-plugins MCP 包为准；事件桥接（before_agent_start / turn_end）仅在 pi / DSH 运行时生效。
- MCP 服务器不随 preset 迁移（DSH 侧需手工配置）；技能内容经 `~/.agents/skills` 共享，不转换。
- 转换结果安装后需刷新插件列表（`/plugins` 中 Ctrl+R）或重启相应工具。
