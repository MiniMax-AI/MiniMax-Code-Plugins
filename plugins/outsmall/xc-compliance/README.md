# 霄楚合规 AI 助手 / xc-compliance

MiniMax Code 原生插件0.1.0，提交社区评审；不是旧 Mini-Agent 配置包。尚未实际安装、未完成MiniMax模型验收，社区收录和官方上架均未确认。

适用：制造商和卖家出口欧盟前的资料梳理、报告型号对应、标签说明书、责任人安排及历史风险案例参考。示例：“成人布艺收纳袋出口德国，报告是A1、销售是A2，我尚未提供报告，先帮我判断应核对什么。”预期结果：条件性清单与真实可追溯来源，不凭型号不同判造假或确认覆盖。

## 依赖与数据

需要支持插件的MiniMax Code及用户自己的模型账号/额度。模型订阅或API费用按MiniMax规则；本插件不包含模型凭证，不提供公司付费代理，也不承诺免费无限使用。无本地可执行文件、安装脚本、hooks或额外包依赖。

MCP仅访问 https://agent.xiaochucompliance.com/agent-tools/mcp ，Streamable HTTP，当前公开只读、无需API Key。只发送必要产品/风险关键词和公开链接；冻结来源库无实时现行性保证。流程Apache-2.0；案例库、检索实现和内部规则留在服务器，不随包发布。

## 安装与验收

此目录同时保留portable plugin.json/mcp.json及新格式.claude-plugin/plugin.json；Skill两份字节相同，用于版本兼容。须按实际客户端插件导入入口校验，不把本地校验当作客户端可用。先查已有xc-compliance并更新原插件，不重复创建。

验收需观察真实工具调用与来源，核对摇铃0988/07、GPSR范围/职责、同例追问、报告未提供时的条件判断、空结果与错误区别及署名。未接通时应明确说明限制，不编造检索结果。

## 社区贡献

拟提交plugins/outsmall/xc-compliance，遵守仓库贡献流程；先运行官方npm run check并保留结果，再交总控唯一GitHub负责人提交。PR、社区收录与MiniMax厂商批准是不同状态。

官方依据：https://github.com/MiniMax-AI/MiniMax-Code-Plugins/blob/main/CONTRIBUTING.md
兼容说明：https://github.com/MiniMax-AI/MiniMax-Code-Plugins/blob/main/docs/plugin-compatibility.md
