---
name: task-tracker
description: 'Use when: 任务追踪与日报周报生成。用于记录老板工作进度、生成日报周报、持续追踪任务完成情况。.'
displayNames:
  zh-Hans: Task Tracker - 任务追踪与日报周报
metadata:
  openclaw_compat: true
  skill-bridge:
    classify_tier: pure
    classify_subtier: pure-wrapped-fix
    classify_reason: 1 hardcoded path group(s) found
---

# Task Tracker - 任务追踪与日报周报

## 核心文件
- 任务总表：`${OPENCLAW_WORKSPACE}/TASKS.md`

## 任务格式规范

### 日报格式（必须遵守）
- 内容顺序：**①直播 ②短视频 ③外卖 ④其他**
- 不显示大分类标题，直接按顺序列序号
- **不用任何符号**（✅❌🔄等都不用）
- 发到飞书，用文字不用语音
- **输出时：完整输出 TASKS.md 里记录的详细内容和进度，不简化**

### 明日计划原则
- **持续跟进的项必须列入**（如：城乡路京东外卖持续跟进）
- **今日新提到的跟进项也列入**（如：美团收银报价跟进）
- 不在本周计划里但老板提到的新任务 → 追加进明日计划

### 重要区分
- **日报只记老板的工作**（品牌运营 + 线上运营 + 外卖 + 品牌营销）
- **数据统计填表是狗蛋的工作，不记入日报**
- **系统升级、工具配置等狗蛋研发工作不记入日报**
- **狗蛋自己的研发/学习/技能提升工作不记入日报**，只记入 memory/daily/YYYY-MM-DD.md
- 老板告诉我进展 → 更新 TASKS.md（详细记录）
- 我自己的研发进展 → 更新 memory/daily/YYYY-MM-DD.md

### 重要区分
- **日报只记老板的工作**（品牌运营 + 线上运营 + 外卖 + 品牌营销）
- **数据统计填表是狗蛋的工作，不记入日报**
- **狗蛋自己的研发/学习/技能提升工作不记入日报**，只记入 memory/daily/YYYY-MM-DD.md
- 老板告诉我进展 → 更新 TASKS.md（详细记录）
- 我自己的研发进展 → 更新 memory/daily/YYYY-MM-DD.md

```
老板日报（YYYY-MM-DD）
今日工作：
1. ...
2. ...
明日计划：
1. ...
2. ...
```

### 周报格式
同日报格式，周六汇总一周数据+工作内容

### 任务格式
```
### 今日进展（YYYY-MM-DD）
- 具体工作内容

### 明日计划
- 延续任务（带进度说明）
- 新增任务
```

### 任务状态规则
- 今日未完成的 → 记录到明日计划
- 本周未完成的 → 记录到下周计划
- 狗蛋自己的研发/学习工作 → 不记录

## 使用场景

### 记录进展
老板告诉你工作进展 → 更新 TASKS.md

### 查询进度
老板问"现在任务进度" → 读取 TASKS.md 输出当前任务清单

### 生成日报
老板说"写日报" → 从 TASKS.md 当前日进展生成格式化日报，发到飞书

### 生成周报
老板说"写周报" → 从 TASKS.md 本周任务+进展生成，发到飞书

### 任务完成
老板说某任务完成了 → 更新 TASKS.md 中该任务状态为"已完成"，标注日期

### 新增任务
老板布置新任务 → 追加到 TASKS.md 当前周任务列表

## 追踪文件路径
`${OPENCLAW_WORKSPACE}/TASKS.md`

## Output contract

This skill does not produce files by itself; the converted openclaw skill should declare its outputs in a new section here. (Filled in by the user after first run.)

## Failure handling

If a required external tool or path is missing, surface the exact missing identifier to the user instead of guessing. Do not auto-install system packages. (Add skill-specific failure modes here.)
