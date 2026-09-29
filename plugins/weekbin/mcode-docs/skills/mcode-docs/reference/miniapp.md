# MiniApp

MiniApp 是**给人操作的有界面应用**，不是给模型调的工具，也**不是「插件的一种内容」**。
插件容器与 Hook 契约见 `plugins.md`；本文件只讲 MiniApp。

## MiniApp 是什么

**给人操作的有界面应用**，不是给模型调的工具。官方口径：「MiniApps are
interactive apps packaged as MiniMax Plugins」（官方社区仓库 README）。

**仅桌面端提供**：0.5.8 随包 CLI 的 `mcode --help` 中无 miniapp 相关命令，
`mcode exec` 与 ACP 同样用不到。安装方式与插件一致：整个插件目录（含隐藏的
`.minimax-plugin/`）放入 `<数据目录>/plugins/`，重启桌面端后从 Mini App 入口打开。
官方社区仓库：<https://github.com/MiniMax-AI/MiniMax-Code-MiniApps>。

`chunks/chunk-4ESEMCSG.js` 导出
`computeMiniAppPackageDigests` / `computePluginDirectoryDigest`，并含
`MINIAPP_ARTIFACTS_EXCLUDED` 诊断码，说明 MiniApp 走独立的包摘要与产物排除逻辑。


## MiniApp 与 MCP 的差异

| | MCP 服务器 | MiniApp |
| --- | --- | --- |
| 本质 | 给模型加工具 | 给人加界面 |
| 使用者 | 模型自行调用 | 用户自己打开、自己点 |
| 交互形态 | 无界面，返回文本/结构化结果 | 有界面：表格、图表、表单、看板 |
| 何时发生 | 模型判断 | 用户点开 |
| 是否需要模型 | 是 | 不一定 |
| 运行环境 | 桌面端 / exec / ACP | **仅桌面端** |

两者不互斥：**MiniApp 内部可用 MCP 取数**。官方社区「Token 用量看板」即此形态——
面板是 MiniApp，读本地数据库靠 MCP 或插件自带脚本。概括：**MCP 负责取数，
MiniApp 负责人看**。

## 生命周期：三者完全不同

插件 / MCP 服务器 / MiniApp 最容易被当成一类，但生命周期机制几乎没有共同点。
下表中插件与 MCP 两列的细节分别在 `plugins.md` 与 `mcp-tools.md`。

| | 插件 | MCP 服务器 | MiniApp |
| --- | --- | --- | --- |
| 本质 | 磁盘上的能力包 | 工具接入 | 带界面的应用 |
| 何时生效 | 装上并启用后，跨会话持续 | Runtime 读配置时建连 | 打开页面时按需启动 |
| 有无进程 | 无独立进程 | stdio 有子进程 / http 远程 | 独立 Node 进程，端口宿主分配 |
| 何时结束 | 手动 disable / remove | 随 Runtime 结束 | 空闲回收，随时可停 |
| 状态位置 | 包本身在磁盘 | 连接状态 | `dataDir` |
| 热替换 | 需 /reload 或重启 | 重连 | 换代 + 两阶段提交，可回滚 |
| 启动失败 | 插件被禁用 | — | 进入隔离 quarantine |

### 插件

无运行进程，就是磁盘上的文件夹。启用后每个会话都装配，直到显式 disable/remove。
启用状态在每次装配能力时判定，禁用则不参与装配。插件激活可触发
`SessionStart`（来源 `plugin_activation`，C 级：`QSn(e,t){return e==="plugin_activation"?"startup":…}`）。
改完用 `/reload` 重载。

### MCP 服务器

生命周期**绑在 Runtime 上**：Runtime 读 `<数据目录>/mcp.json`、`<workspace>/.mcp.json`
或插件 `mcpServers` 后建连，Runtime 结束一并释放。

- `stdio`：宿主拉起**子进程**，随连接存在。
- `http` / `sse`：连远程，宿主只保持连接。
- 子进程仅继承 **17 个白名单环境变量**，无凭据；其余须在 `env` 显式声明。

### MiniApp

三者中**唯一自带独立运行时**。清单声明 `runtime.lifecycle: on-demand`，
**打开页面才启动** Node 进程，端口由宿主分配。

C 级机制（随包 `chunk-PF5H4F6R.js`）：

- **引用计数**：`admitRunningLease` / `release`，`leases` 集合；停进程前等租约归零。
- **空闲回收**：`scheduleIdleDrain` 仅在 `leases.size===0 && runtime` 时启动
  `idleTimer`（`idleStopPromise` 去重）。**两次打开之间进程可能已重启**。
- **可能复用**：`findReusableRuntime` 先尝试复用，`forceStart` 才强制新起进程。
- **两阶段停止**：`prepareStop` → `prepareStopOwned` → `commit` / `rollback`，
  准备阶段失败经 `SUPERSEDED` 路径回滚；`onPonr` 为不可回退点。
- **换代**：`miniAppGeneration` 支持热替换。
- **隔离**：`quarantined` / `cleanupOrQuarantine`，
  错误文案 `Mini App cleanup ownership is unproven`、`Mini App startup failed`。
- **持久化**：`stateStore` + 官方 `dataDir`（宿主为每插件创建的私有目录）。

> **最易踩坑**：进程随时可能被回收，**状态不能放内存**。官方要求
> "assume yours can be stopped and restarted between two page views:
> keep durable state in `dataDir`, not in memory"。
> `dispose()` 只能关入口自己启动的东西；宿主只停入口进程，
> 不负责清理它派生的子进程。

## MiniApp 怎么写

本质是「带清单的 Node 服务 + 一张页面」。

### 目录结构

```text
<plugin-id>/
  .minimax-plugin/plugin.json   插件清单
  package.json                  MiniApp 声明
  icon.png
  miniapp/
    miniapp.json                载荷根、Node 入口、页面路由
    client/                     发给页面的文件
    node/                       Node 入口及其依赖
  README.md / LICENSE
  skills/<name>/SKILL.md        可选
  *.mcp.json                    可选
  bindings/<name>.binding.json  可选
```

- 目录名 = `plugin.json.name`，须匹配 `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`，全仓库唯一。
- 仅 `artifacts` 列出的 `client/`、`node/` 成为运行时载荷；`node_modules` 被排除。
- 上限：1024 文件 / 单文件 16 MiB / 总计 64 MiB；禁符号链接与硬链接。
- 路径须可移植：仅 ASCII、无 `\`、无 `.`/`..` 段、不以 `.` 结尾。

### package.json

```json
{ "mcode": { "schemaVersion": 2, "miniApp": "./miniapp/miniapp.json" } }
```

`mcode` 内不得有其它键；顶层 `name`/`type`/`scripts` 随意。

### miniapp/miniapp.json

```json
{
  "schemaVersion": 1,
  "artifacts": { "client": ["./miniapp/client"], "node": ["./miniapp/node"] },
  "runtime": {
    "kind": "process",
    "entry": "./miniapp/node/server.mjs",
    "lifecycle": "on-demand"
  },
  "surface": { "path": "/dashboard" },
  "mcpEndpoints": []
}
```

| 字段 | 规则 |
| --- | --- |
| `artifacts.client` / `.node` | `miniapp/` 下非空唯一路径数组，须存在；被哈希与安装的全部内容 |
| `runtime.kind` | 固定 `process` |
| `runtime.entry` | `.mjs`/`.js`/`.cjs`，须在 `artifacts.node` 内；**用 `.mjs`** 以写 ESM `export` |
| `runtime.lifecycle` | `on-demand` 或省略 |
| `surface.path` | 页面路由；无 origin/query/片段/反斜杠 |
| `mcpEndpoints` | `{server,path}` 数组；`server` 必须是 `mcpServers` 中已声明者，安装时校验；无则 `[]` |

### Node 入口

```js
export async function start(context) {
  const { pluginRoot, dataDir, listen, signal, logger } = context;
  const server = createServer(/* ... */);
  await new Promise((r) => server.listen(listen.port, listen.host, r));
  signal.addEventListener('abort', () => server.close());
  return { async dispose() { await new Promise((r) => server.close(r)); } };
}
```

`context`：`pluginId`、`pluginRoot`（装好的包真实路径）、`dataDir`（宿主私有目录，
位置不透明，持久状态写这里）、`listen {host:"127.0.0.1",port}`（**必须绑这个**）、
`signal`（宿主停止时 abort）、`logger`（消息截断 4 KiB；**只有 fields 的键离开进程**）。

- 宿主以 ES module 导入，要求具名导出 `start`；返回 `{dispose}`，**缺 `dispose` 判为非法生命周期**。
- **禁用 `console.log` / `process.stdout.write`**（stdout/stdin 归宿主），一律走 `logger`。
- `start()` resolve 即就绪，**无健康检查路由**；不要在 `start` 里拉业务数据。
- 第三方运行时代码直接放进 `artifacts` 根，不依赖 `node_modules`。
- 起步模板：`examples/hello-miniapp/`，附 `miniapp-api.ts` 类型（仅编辑器提示，运行时不导入）。

> **适用范围**：以上契约来自官方社区仓库 `MiniMax-AI/MiniMax-Code-MiniApps`，
> 自述**验证于 MiniMax Code 桌面端 3.0.73**；桌面端目前支持 **macOS 与 Windows**。
> 终端版 `mcode` 不提供 MiniApp 能力。
