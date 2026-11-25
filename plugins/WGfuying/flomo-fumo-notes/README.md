# flomo 浮墨笔记 (flomo-fumo-notes)

把对话里值得留下的想法，整理成**你自己写法**的 flomo memo；也能回头翻旧笔记，找出还在盘旋的那条线。

这个 Plugin 通过 flomo 官方 MCP 服务器连接你的 flomo 账号，包含两个 Skill：

| Skill | 做什么 | 什么时候触发 |
| --- | --- | --- |
| `flomo-capture` | 把对话中的想法整理成 memo 草稿，**确认后**才写入 flomo | 你说“记一下”“保存到 flomo”，或让你扫一遍当前对话 |
| `flomo-daily-echo` | 读目标日期的 memo，再去找相关旧 memo，找出真实存在的张力，输出**一条**值得继续讨论的回声 | 你说“看看昨天我记了什么”“做个每日回顾” |

设计上的两条底线：

1. **默认不写入。** 起草和保存是分开的动作，保存权始终在你手上。
2. **没有张力就不硬编。** 回声宁可沉默，也不制造泛泛的“AI 洞察”。

## Try it

```text
把刚才关于我产品的想法整理成一条 flomo memo
```

```text
看看昨天我记了什么，生成一条回声
```

```text
帮我找出我关于读书的所有 flomo 笔记
```

```text
搜一下我关于 AI 和独立开发相关的 flomo 记录
```

## Requirements

- 一个 flomo 账号，且**已开通 PRO 或 MAX 会员**（flomo 的 MCP 服务是会员功能）。
- 首次使用需要在 MiniMax Code 内完成一次授权（OAuth），授权后即可读写你的 flomo 笔记。
- 第一次保存或回顾时，Plugin 会询问一次偏好（例如“只在我说保存时提醒”还是“帮我挑值得存的”），并把答案写进插件内的 `profile.md`。

## Skills and profile files

```text
skills/
├── flomo-capture/
│   ├── SKILL.md      # 保存协议：入口判断、标签策略、写入规则、工具速查
│   └── profile.md    # 共享画像（初始为模板，初始化后写入你的写法与偏好）
└── flomo-daily-echo/
    ├── SKILL.md      # 回声协议：检索预算、输出结构、自检
    └── profile.md    # 共享画像
```

`profile.md` 位于插件安装目录内，是你的本地文件：Plugin 会从真实 memo 样本里学习你的标签习惯、长度和语气，并把**已确认的偏好**（提醒方式、回声数量等）保存在同一份文件里。删除插件即删除该文件，笔记本身始终留在 flomo。

## Requirements and compatibility

这个仓库采用便携的 Agent Plugins 1.0 布局。**直接安装本仓库包的运行时只会获得两个 Skill 和 MCP 服务器定义**；插件图标、分类、示例提问和自定义子代理（`flomo-curator`）只在通过 MiniMax manifest 安装时生效，这部分声明在 `.minimax-plugin/plugin.json` 中。

flomo 官方 MCP 没有删除笔记的工具，误写只能在 flomo 客户端里撤销。

## Data and network

- 会访问 `https://flomoapp.com/mcp`（flomo 官方 MCP 服务器，HTTPS，OAuth 授权）。
- 只读写你本人 flomo 账号下的笔记与标签；不会把笔记内容发送到第三方服务。
- 授权凭据由 MiniMax Code 的 MCP 授权流程保管，不写在插件包里。

## License

Apache-2.0，见 [LICENSE](./LICENSE)。
