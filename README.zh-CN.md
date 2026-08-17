<p align="center">
  <img src="assets/hero.svg" alt="MiniMax Code Plugins：一个目录、一个 PR，给 Agent 一项新能力" width="100%" />
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="CONTRIBUTING.md">贡献指南</a> ·
  <a href="docs/plugin-compatibility.md">Plugin 契约</a> ·
  <a href="SECURITY.md">安全</a>
</p>

<p align="center">
  <a href="https://github.com/hetaoBackend/MiniMax-Code-Plugins/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/hetaoBackend/MiniMax-Code-Plugins/ci.yml?branch=main&amp;style=flat-square&amp;label=build" alt="构建状态" /></a>
  <img src="https://img.shields.io/badge/Agent_Plugins-1.0-8b5cf6?style=flat-square" alt="Agent Plugins 1.0" />
  <img src="https://img.shields.io/github/license/hetaoBackend/MiniMax-Code-Plugins?style=flat-square&amp;color=22c55e" alt="Apache-2.0 License" />
  <img src="https://img.shields.io/badge/PRs-welcome-ec4899?style=flat-square" alt="欢迎提交 PR" />
</p>

## 一个目录，就是一个发布单元

MiniMax Code Plugins 是 MiniMax Code Agent Plugin 的社区入口。把 Plugin 放进
`plugins/<GitHub 用户名>/<Plugin 名>`，提交一个 PR，CI 会直接检查用户最终安装的那份代码。

```text
Fork  →  创建  →  开发  →  校验  →  Pull Request  →  被发现
```

不用另建仓库，不用写 Catalog JSON，也不用手抄 commit SHA。源码、文档、Review 和修改历史都在
一个地方。

## 30 秒创建第一个 Plugin

```bash
git clone https://github.com/<你的用户名>/MiniMax-Code-Plugins.git
cd MiniMax-Code-Plugins
npm install
npm run create -- <你的用户名>/my-first-plugin
```

脚手架会生成一个 Skill-first Plugin：

```text
plugins/<你的用户名>/my-first-plugin/
├── plugin.json
├── README.md
├── LICENSE
└── skills/
    └── my-first-plugin/
        └── SKILL.md
```

替换全部 `TODO`，然后运行：

```bash
npm run check
```

通过后，为这个 Plugin 提交一个 PR。完整 Review 要求见
[`CONTRIBUTING.md`](CONTRIBUTING.md)。

## Plugin 能给 Agent 加什么？

### Skills

把可复用的指令、工作流和领域知识打包。一个验证过的提示词方法，可以直接变成任何人都能安装的能力。

### MCP Servers

通过 `stdio`、`streamable-http` 或 `sse` 连接本地工具和远程服务。依赖、账号、网络目标和数据处理必须
在安装前说清楚。

### Skill + MCP

Skill 教会 Agent 怎么做，MCP 给它真正的工具。可移植包结构保持简单：

```text
plugin-root/
├── plugin.json
├── mcp.json                  # 可选
└── skills/                   # 可选
```

这个仓库只承接 **Agent 能力**。TUI Extension 是另一套独立扩展体系，不使用这里的包格式和加载流程。

## 安装并使用插件

Plugin 是一个遵循 Agent Plugins 1.0 契约的可移植目录。MiniMax Code 直接读取这个目录——不需要登记
Catalog，也不用手抄 commit SHA。

1. 在 [`plugins/<用户名>/<插件名>`](plugins/) 中挑选一个插件（或先用 [`examples/`](examples/) 里的
   插件试手）。
2. 把这个文件夹复制到你的 MiniMax Code 插件目录，或让 MiniMax Code 指向它的路径。
3. 保持以下必需的目录结构完整：

   ```text
   plugin-root/
   ├── README.md
   ├── LICENSE
   ├── plugin.json
   ├── mcp.json        # 可选
   └── skills/
       └── <skill-name>/
           └── SKILL.md
   ```

4. 重新加载会话。MiniMax Code 会随之自动：
   - 读取每一个 `skills/<skill>/SKILL.md`，并在其 `description` 命中时激活对应 Skill；
   - 通过 `stdio`、`streamable-http` 或 `sse` 连接 `mcp.json` 中声明的服务。

MiniMax Code 会替插件注入 `PLUGIN_ROOT` 与 `PLUGIN_DATA`，你无需自己设置。精确的契约、传输上限与
不支持的能力见 [`docs/plugin-compatibility.md`](docs/plugin-compatibility.md)。

安装前，请阅读插件自带的 README，了解它的示例 prompt、所需可执行文件或账号、网络目标与数据处理方式。

## 门槛也很简单

一个贡献必须：

- 位于 `plugins/<GitHub 用户名>/<Plugin 名>`；
- 包含 `plugin.json`、`README.md` 和 `LICENSE`；
- 至少提供一个有效的 Skill 或 MCP Server；
- 写清示例、依赖、网络访问和数据用途；
- 不包含密钥、私有地址、隐藏遥测、原生二进制或 symlink；
- 通过 `npm run check` 和人工 Review。

通过 Review 代表它可以作为社区软件被发现，不代表 MiniMax 背书或已经完成完整安全审计。安装前仍需阅读
源码和能力声明。

## 逛逛这个仓库

- [`plugins/`](plugins/)：社区 Plugin 源码
- [`examples/hello-mcode`](examples/hello-mcode/)：最小 Skill Plugin
- [`examples/hello-mcode-mcp`](examples/hello-mcode-mcp/)：零依赖 stdio MCP
- [`docs/plugin-compatibility.md`](docs/plugin-compatibility.md)：当前支持的精确契约
- [`docs/security-model.md`](docs/security-model.md)：校验与信任模型
- [`docs/architecture.md`](docs/architecture.md)：中央托管架构
- [`GOVERNANCE.md`](GOVERNANCE.md)：决策与维护者职责

## Community Preview

MiniMax Code 的公开 Plugin 能力仍在稳定中，所以首版契约刻意保持克制。Hooks、自定义 Agent、Commands、
LSP、Apps、通用 OAuth 和 TUI Extension 暂不作为当前 Agent Plugin 能力宣传。

带来一个真的有用的能力，给出一个无法误解的示例，然后用一个 PR 把它发布出来。

## License

仓库工具和文档使用 Apache-2.0。每个托管 Plugin 都必须包含并声明自己的开源 License。
