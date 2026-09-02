---
name: scientific-databases
description: >-
  当用户需要查询科研专业数据库（生物医学实体与临床试验、材料结构与计算性质、
  宏观经济时间序列、气象与空间天气、水文地学数据）、或不确定某个数据需求该走
  哪个数据库 connector 时使用。同义场景：查数据库、材料数据查询、Materials
  Project 查结构、FRED 查经济数据、气象数据下载、临床 trial 检索、
  "帮我查一下某种材料的带隙""这个经济指标的时间序列去哪拿"。
argument-hint: '[数据需求或检索问题]'
metadata:
  domains: [data, biomedical, materials, economics, meteorology, geoscience]
  last_reviewed: '2026-08-18'
---

# scientific-databases：按域聚合的科研数据库检索规程

## 目的

把用户的专业数据需求路由到 `references/connectors.yaml` 中登记的
connector（MCP server 或直连 HTTP API），执行检索，把结果统一为
PaperDocument（文献类）或结构化 JSON（数据类）落盘，供下游技能使用。

核心原则与 literature-search 一致：诚实路由、失败留痕。此外本技能多一条
硬约束——**fail-closed 合规门禁**：凡是 `connectors.yaml` 里没有登记、
或登记为 deferred 的 connector，一律不得使用；宁可停下来告诉用户
"这个源当前不可用及原因"，也不临时找表外替代品静默顶替。

## 前置检查

1. `references/connectors.yaml` 存在且可读；它是 connector 合规的唯一
   权威清单。
2. 网络可用；离线时直接说明无法检索并终止。
3. 用户需求足够具体：若过于宽泛（如"查点材料数据"），先与用户收敛到
   具体物质/指标/时间范围再执行。
4. 计算 slug：需求描述规范化（Unicode NFKC 规范化、转小写、去首尾空白、
   连续空白折叠为单个空格）后取 sha1 十六进制摘要前 8 位。
5. 若需求实质是文献检索（找论文而非找数据），转交
   literature-search，不在本技能内重复实现。

## 操作规程

### 1. license gate（任何检索之前必须执行）

- 在 `references/connectors.yaml` 中查找目标 connector 条目：
  - 表中**没有**该条目 → 停止。告知用户"该数据源未登记，按 fail-closed
    原则不得使用"；如需新增，走 customize 流程先改表。
  - `status: deferred` → 停止。如实引用表中的 `reason` 字段说明暂缓
    原因（如 KEGG 学术许可限制），不得尝试绕过或找镜像顶替。
  - `status: needs-key` → 检查对应 `apiKeyEnv` 环境变量是否已配置；
    未配置则停止并给出配置指引（变量名、去哪申请），不替用户申请。
  - `status: active` → 放行。注意 `tested: false` 表示该条目尚未在本
    仓库实测，首次使用应先小规模试运行（limit 调小），确认可用后再放量，
    并把实测结果反馈给用户（建议其把 tested 改为 true）。
- license gate 的检查结果（哪个条目、哪个 status、放行还是停止）写入
  manifest 的 `license_gate` 字段。

### 2. 路由：域 → 推荐 connector

| 需求域 | 首选 connector | 备选 / 说明 |
| --- | --- | --- |
| 生医（实体、文献、临床试验） | biomcp | paper-search（文献聚合兜底）；KEGG/CADD/PanglaoDB 均 deferred，禁用 |
| 材料（结构、相图、计算性质） | materials-project | 无备选；未配 MP_API_KEY 即停 |
| 经济（宏观时间序列） | fred | 无备选；未配 FRED_API_KEY 即停 |
| 气象（预报、再分析、气候指标） | open-meteo | 免费无 key，注意免费档日额度 |
| 地学（空间天气） | spaceweather | NOAA SWPC，公开数据 |
| 地学（美国水文） | usgs-water | 仅美国站点；中国水文数据不在覆盖范围，如实告知 |
| 综合文献 | paper-search | 优先转交 literature-search |

路由决策与理由写入 manifest；用户也可直接指定 connector 跳过路由，
但 license gate 仍然必须过——指定表外 connector 与查不到条目同等处理。

### 3. politeness（礼貌访问）

- 请求速率 ≤ 2 req/s；批量任务在每次请求间至少间隔 0.5 秒。
- 遭遇 HTTP 429 / 503 时按指数退避重试（1s → 2s → 4s，最多 3 次）；
  仍失败则记 `rate_limited` 留痕，不得当作"结果为 0"。
- 批量上限：单次任务默认 ≤ 50 条记录；需要更大批量时先向用户说明
  数据源的速率政策并获确认（guardrail 第 8 条：联网批量下载属危险操作）。
- 带 User-Agent 发起直连 HTTP 请求；MCP server 类 connector 的速率由
  其自身实现控制，但批量上限与危险操作确认规则同样适用。

### 4. 执行检索

- MCP 类 connector（paper-search / biomcp / open-meteo）：调用其暴露的
  工具；工具不可用时（server 未启动、uvx 包不存在）如实记录错误，不伪装
  成"无结果"。
- HTTP 类 connector（materials-project / fred / spaceweather /
  usgs-water）：按其官方 API 文档构造请求；接口字段以各官方文档为准，
  解析失败按 `upstream_changed` 错误类型留痕。
- 逐源串行执行、逐源记录结果。

### 5. 失败结构化记录

任一 connector 返回错误或执行异常时：

- 在 manifest 的 `errors` 数组记录：connector、type（`network` /
  `rate_limited` / `auth_missing` / `upstream_changed` / `parse`）、
  message；
- 回复中如实告知"X connector 本次失败及原因"；
- **查不到 ≠ 不存在**：检索结果为 0 只说明"本次在该源未命中"，回复中
  必须用这个措辞，不得推断"该物质/指标不存在"；
- 失败不静默：禁止产出空结果文件冒充成功。

### 6. 结果统一与落盘

- 文献类结果（biomcp、paper-search 返回的论文条目）：统一为
  PaperDocument：
  `{id, title, authors, year, venue, doi, url, abstract, source, retrieved_at}`
  （`source` 为字符串数组）。
- 数据类结果（材料性质、经济序列、气象数据等）：保留该域原生结构，
  包一层统一信封：
  `{connector, query, domain, retrieved_at, records: [...]}`。
- 落盘目录 `output/scientific-databases/<slug>/latest/`：
  - `papers.json`：文献类 PaperDocument 数组（有文献结果时）；
  - `data.json`：数据类结构化结果（有数据结果时）；
  - `manifest.json`：query、license_gate、路由决策、各源命中数、
    errors、执行时间。
- 产物落盘后按工作区约定用 provenance-record 登记。

## 输出模板

### data.json（数据类信封）

```json
{
  "connector": "open-meteo",
  "query": "Beijing daily mean temperature 2020-2024",
  "domain": "气象",
  "retrieved_at": "2026-08-18T00:00:00+00:00",
  "records": [
    {"date": "2020-01-01", "tmean_c": -3.2}
  ]
}
```

### manifest.json

```json
{
  "query": "LiFePO4 band gap",
  "slug": "1a2b3c4d",
  "license_gate": {"connector": "materials-project", "status": "needs-key", "decision": "pass"},
  "routing": [{"connector": "materials-project", "reason": "材料计算性质"}],
  "hits": {"materials-project": 3},
  "errors": [{"connector": "fred", "type": "auth_missing", "message": "FRED_API_KEY 未配置"}],
  "executed_at": "2026-08-18T00:00:00+00:00"
}
```

## 本技能不做什么

- 不使用 `connectors.yaml` 之外的任何数据源（fail-closed）。
- 不绕过 deferred 条目的暂缓原因，不找镜像或替代品静默顶替。
- 不替用户申请或保管 API key；只检查环境变量是否已配置。
- 不做批量镜像式下载；超过批量上限的需求先确认再执行。
- 不把"检索结果为 0"表述为"数据不存在"，不把 connector 失败伪装成
  "无结果"。
- 不做文献综述与论文级检索（交给 literature-search / literature-survey）。
- 不对数据做科学解释与结论判断；只负责取数与留痕。

## 收尾与下一步

1. 汇总：license gate 结果、各 connector 命中数、失败源及原因，5 行内
   说明；结果为 0 的源用"本次未命中"措辞。
2. 指向 `output/scientific-databases/<slug>/latest/` 下的产物文件。
3. 建议下一步：数据进 analysis 阶段处理；文献类结果可交给
   literature-survey；needs-key 的源给出配置指引后等待用户配置。
4. 若全部 connector 均失败或被 gate 拦停，明确告知"本次检索整体未完成"，
   不产出空文件冒充成功；需要新增 connector 时建议走 customize 流程
   先更新 `connectors.yaml`。
