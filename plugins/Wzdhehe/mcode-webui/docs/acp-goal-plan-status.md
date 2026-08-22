# mcode acp 0.1.4 goal / plan / sub-session 现状

> 调查日期: 2026-08-19
> 目标: 给 webui 移植 mcode TUI 的 goal / plan / 子 agent session 功能

## TL;DR

| 功能 | mcode TUI | mcode acp 0.1.4 协议 | webui 端状态 | 阻塞点 |
|------|----------|----------------------|--------------|--------|
| **goal (目标追踪)** | ✅ TUI 头部显示 | ❌ 没发 goal_update 事件 | ⚠️ 仅能解析 chat 文本 (不工作, mcode 不输出) | mcode 0.1.4 不支持 acp 协议 |
| **plan (Plan mode)** | ✅ TUI 出方案让你审 | ❌ available_commands 没 /plan | ✅ 客户端渲染已 OK (parseChatLines + renderPlanBlock + 弹窗), server 端 v0.5.bx-9 接好 plan_update (0.1.5+ 自动 work) | 等 mcode 0.1.5+ 暴露 |
| **EnterPlanMode** | ✅ TUI 弹窗确认 | ❌ 没发 current_mode_update | ✅ 客户端已有 showPlanMode() + 弹窗, server 端 v0.5.bx-9 接好 mode_update | 同上 |
| **子 agent session** | ❌ TUI 也没 | ❌ 0.1.4 acp 只暴露 `sessionCapabilities: {list, resume, close}`, 没 subagent | ✅ webui 已有 mcode sessions 列表 (sidebar) + 切换, 但 "subagent" 概念 mcode 0.1.4 整个不支持 | mcode 需先支持 |

## 探测方法

跑了 `goal-plan-probe.cjs` (在 `webui/` 目录) — spawn `mcode acp`, 跑 `session/prompt` "用一句话回答 hi", 抓所有 events:

```
event types: {
  "available_commands_update": 2,
  "agent_thought_chunk": 14,
  "agent_message_chunk": 1
}
```

**没看到** plan_update / goal_update / current_mode_update / plan_removed / session_info_update。

## mcode 0.1.4 available_commands (10 个)

```
help / new / model [provider/model[#variant]] / status / doctor / context
  / skills [filter] / mcp [filter] / usage / compact [instructions]
```

**没有** /goal, **没有** /plan, **没有** /provider (0.1.4 TUI-only, 不在 acp)。

## mcode 0.1.4 acp sessionUpdate enum (从 cli.js bundle 实测, 65 refs)

```
agent_thought_chunk, agent_message_chunk, user_message_chunk,
tool_call, tool_call_update, available_commands_update,
current_mode_update, plan_update, plan_removed,
usage_update, config_option_update, session_info_update
```

虽然 enum 里有 `plan_update` / `current_mode_update` / `goal_update` 名字, 但实测**不主动发**。可能是 0.1.4 bundle 已经预留了 type, 留给 0.1.5+ 实现。

## webui 端当前实现

### 客户端 (public/index.html)

- ✅ `parseChatLines` (L4438) 解析 chat 文本里 `Plan: 标题` + `Plan complete.` + 1./2./3. 选项块 → 渲染成内嵌 `.plan-block` (v0.5.ab)
- ✅ `state.goal` → 右栏 GOAL section (v0.5.aj)
- ✅ `state.plan` → 弹窗 `#plan-modal` (v0.4.0)
- ✅ `state.enterPlanMode` → 弹窗 `#planmode-modal` (v0.5.ab)
- ✅ `renderGoal()` / `renderPlan()` / `showPlanMode()` + sendPlanAnswer / sendPlanModeAnswer / sendAskAnswer

**结论**: 客户端所有 UI 都已经写好, 缺的是 server 端接 mcode 协议事件。

### server 端 (server.js)

- ❌ v0.5.bx 之前: streamAcpPrompt 没收 plan_update / mode_update / goal_update (只在 thought/message/tool_call/tool_update/usage 分支处理)
- ✅ **v0.5.bx-9**: 加上 plan_update / plan_removed / current_mode_update / goal_update 事件处理 (写到 `cs.plan` / `cs.goal` / `cs.enterPlanMode` + pushState)
  - 0.1.4 不发, 0.1.5+ 来了自动 work
- ✅ `acp.mjs` (v0.5.bx-9) prompt callback 加 'plan_update' / 'plan_removed' / 'mode_update' / 'goal_update' 4 个新 kind 透传
- ✅ `/api/debug/inject` 端点加 `plan` / `enterPlanMode` 字段 (DEBUG_INJECT=1 env 才开), 方便测 webui 客户端 UI
- ✅ `/api/debug/state` 端点加 `plan` / `enterPlanMode` 字段返回

## 测试方法 (DEBUG_INJECT=1)

启动 server 时加 `DEBUG_INJECT=1` env:

```powershell
cmd /c "set MCODE_USAGE_DEBUG=1&& set MCODE_ACP_DEBUG=1&& set DEBUG_INJECT=1&& node server.js"
```

注入 plan + goal + enterPlanMode + chat 文本:

```powershell
$body = '{"plan":{"active":true,"planId":"plan_1","title":"Test","summary":"Test","options":[{"label":"Agree","description":"Start"}]}, "goal":{"active":true,"text":"目标","status":"in_progress","duration":"1h"}, "enterPlanMode":{"active":true,"prompt":"Use Plan mode?"}, "appendChat":["Plan: 升级 plan", "## Summary", "描述", "", "Plan complete.", "1. Agree", "2. Skip"]}'
Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/debug/inject" -Method POST -Body $body -ContentType "application/json" -Headers @{"X-CID"="test-cid"} -UseBasicParsing
```

查 state:
```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/debug/state" -Headers @{"X-CID"="test-cid"} -UseBasicParsing
```

浏览器刷新 `?d=64` 应该看到:
- 右栏 GOAL section 出现
- plan 弹窗自动弹出 (state.plan.active = true)
- chat 里有 "Plan: 升级 plan" 块解析成 .plan-block (内嵌)

## 建议 (给 mavis / mcode team 提需求)

1. **mcode 0.1.4 acp 缺 goal/plan/mode 事件支持**: 即使 enum 里有 `plan_update` 名字, 实际不发。建议 mcode 0.1.5+:
   - 加 `/goal` slash command (暴露给 webui)
   - 加 `/plan` slash command
   - LLM 跑复杂任务时主动 emit `plan_update` 事件 (走 acp 协议)
   - LLM 切 plan/ask/normal mode 时 emit `current_mode_update`
2. **sub-agent 概念 mcode 0.1.4 整体没**: TUI 也没看到 subagent UI。 如果 mavis / mcode team 要做, 建议先在 mcode TUI 实现, acp 协议再跟。
3. **临时方案**: webui 用户可以**手动 prompt 让 mcode 输出** `Plan: 标题` + `Plan complete.` 文本, webui parseChatLines 能解析。 但 mcode 0.1.4 LLM 不一定会主动出 plan 文本, 需要 prompt 明确说 "先用 plan 模式给我方案"。

## 相关 commit / 版本

- **v0.5.bx-9** (本次): server.js + acp.mjs + debug inject 接 plan/goal/mode_update 事件处理 (0.1.5+ 自动 work)
- **v0.5.bx-8**: ask_user 工具 (mcode 0.1.4 ask_user) — 内嵌问卷 + 跳过/发送 + localStorage 持久化
- **v0.5.bx-7**: ask_user 工具初版 (questionnaire 渲染)
- **v0.5.ab**: Plan block / Ask block / Modal / EnterPlanMode — 客户端 UI 框架
- **v0.4.0**: Ask modal / Plan modal 初版
- **v0.5.aj**: /api/debug/inject 端点 (goal/todo/ask mock state 给浏览器测 UI)
