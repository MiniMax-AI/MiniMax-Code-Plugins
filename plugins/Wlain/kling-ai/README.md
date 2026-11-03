# 可灵 AI

通过可灵国内远程 MCP，在 MiniMax Code 中创建和查询图片、视频与动作任务。插件只连接 `https://klingai.com/mcp`，不启动本地 MCP server，也不包含 API Key、Token 或 Cookie。

## 试一试

```text
使用可灵生成一张 16:9 的电影感雨夜城市图片。
```

预期行为：MiniMax Code 先通过系统浏览器连接用户的可灵账号，加载远程工具；参数明确后只提交一次生成任务，并返回任务编号和当前结果。

## 功能

- 文生图、图生图与参考素材创作
- 文生视频、图生视频与动作控制
- 查询账号灵感值、任务状态和已有结果
- 上传素材与管理可复用 Element
- 保留 `generationId` / `taskTraceId`，避免结果不明确时重复计费提交

## 要求与当前兼容性

- 中国大陆可灵账号；服务端点固定为 `https://klingai.com/mcp`。
- 真实生成可能消耗账号灵感值，具体以可灵账号和实时工具说明为准。
- 需要 MiniMax Code 支持受保护远程 MCP 的 OAuth discovery、动态客户端注册或宿主管理的预注册客户端，以及 Authorization Code + S256 PKCE。

MiniMax Code 3.0.67 可以发现本插件和三个 Skills，但当前公开 runtime 没有在远程 MCP 返回标准 `401` 后启动浏览器 OAuth，因而无法完成 `tools/list` 和工具注入。MiniMax Code 的公开 Agent Plugin 契约也说明 generic OAuth 尚不是公开能力。该兼容性问题正在 [MiniMax Code issue #120](https://github.com/MiniMax-AI/minimax-code/issues/120) 跟踪；在宿主完成支持和真实联调前，本贡献只能作为 Draft 评审，不宣称实时 MCP 已可用。

## OAuth 与安全边界

- 登录和 token 生命周期必须由 MiniMax Code 管理；插件不会要求用户在对话中粘贴凭据。
- `X-Kling-Integration: Plugin-MiniMaxCode` 只是非秘密集成标识，不是授权头或 OAuth 客户端名。
- 每个明确的生成意图至多提交一次。失败、超时或结果未知时先查询原任务，不盲目重试。
- 退出或切换账号、删除 Element 等状态变更只在用户明确要求时执行。

## 数据与网络

- 业务网络目标是 `https://klingai.com/mcp`，以及可灵工具响应中明确返回的一次性上传地址或结果地址。
- 用户提示词、明确提供的参考素材和生成参数会发送给可灵以完成所请求的操作。
- 账号凭据由宿主管理，不进入插件文件、对话或日志。
- 工具返回的签名地址可能包含临时访问能力，不应复制到诊断日志或公开 Issue。

## 包结构

```text
kling-ai/
├── plugin.json
├── mcp.json
├── README.md
├── LICENSE
└── skills/
    ├── kling-ai/
    ├── kling-ai-generate-image/
    └── kling-ai-generate-video/
```

## 验证

在 `MiniMax-Code-Plugins` 仓库根目录运行：

```bash
npm install
npm run check
```

静态校验覆盖目录布局、Manifest、MCP transport、Skills、许可证、占位符和路径安全。真实 runtime 验收还必须在支持 OAuth 的 MiniMax Code 构建中完成浏览器授权、`tools/list`、只读账号查询和一次用户确认后的生成测试。

## 许可证

[MIT](./LICENSE)
