# 故障排查

## 安装后缺少 Skills 或 MCP 工具

确认加载的是包含 `plugin.json`、`mcp.json` 和 `skills/` 的完整 Plugin 目录。MiniMax Code 应发现 `kling-ai`、`kling-ai-generate-image` 和 `kling-ai-generate-video` 三个 Skill，并且只有一个小写 `kling-ai` MCP server 指向 `https://klingai.com/mcp`。重新加载插件后新建会话以刷新工具快照。

如果 Plugin 显示已加载但第三方 MCP 工具没有进入 Agent 工具面，记录 MiniMax Code 版本、平台和 MCP 诊断后停止。不要让 Skill 用 shell、`curl` 或第二个本地 MCP server 绕过宿主工具注入。

## 未授权或未进入浏览器 OAuth

MiniMax 的公开 Agent Plugins 1.0 子集不能在 `mcp.json` 中声明通用 OAuth。本包依赖宿主对受保护资源执行标准发现、动态客户端注册和 S256 PKCE。若连接 `https://klingai.com/mcp` 后没有进入浏览器授权，记录诊断并停止；不要添加静态 `client_id`，不要手工粘贴 API Key、Token、Cookie 或授权头。

`kling-ai` 是包内 server key，`Plugin-MiniMaxCode` 是非秘密集成标识；两者都不应被当成 OAuth `client_name` 强行覆盖宿主注册信息。

## 上传或图生视频失败

- 刷新实时模式定义，并确认当前上传工具及其输出字段。
- 严格按返回内容原样复用上传引用。
- 如果模式定义返回或要求 `taskTraceId`，应在上传和生成过程中保持相同的值。
- 只使用所选实时工具声明的输入名称、值类型和参考素材角色；不要假设一定存在 `file_upload`、`first_image` 或仅接受字符串的参数值。

## 任务仍在运行

返回当前状态和任务编号，不在模型侧循环轮询。用户之后明确查询时只调用一次 `query_tasks`；如果仍未结束，继续返回当前状态，不创建第二个任务。

## 生成后没有媒体预览

MiniMax Code 的公开 Plugin 能力目前不包含 Apps/UI 扩展。使用宿主自动呈现的原生工具结果；没有原生媒体呈现时，返回同一次工具结果中的文本状态、任务编号和至多一个主结果链接。不要复制本地 `mcp-app/`、启动第二个 MCP server，或由 Skill 手写 Markdown 媒体作为替代。

## 生成失败

返回提供方的失败消息，并保留各项 ID 以供支持使用。不要自动创建替代任务，因为这可能再次消耗灵感值。

## 灵感值不足

告知用户余额不足，并请其充值后再试。不要自动重试。

## 提交超时且无法确定是否已创建任务

不要重试生成调用。先使用可用的 `taskTraceId`、`generationId` 或提供方任务列表筛选条件查询已有任务。如果提供方无法证明任务是否已创建，应告知用户提交状态未知，并询问是否要创建新任务。

## 结果链接已过期

签名输出 URL 可能是临时的。重新查询已保留的 `generationId` 以获取当前输出 URL，或者登录已授权账号后，在 Kling 官网查看生成历史记录。URL 过期不代表生成作品已丢失。不要记录签名 URL，也不要把它当作永久资产标识。
