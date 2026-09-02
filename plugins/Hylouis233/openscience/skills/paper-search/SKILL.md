---
name: paper-search
description: >-
  当需要真正执行文献数据库 API 检索时加载：构建检索式（布尔组合、字段限定）、
  调用 OpenAlex / Crossref / arXiv 接口、遵守请求礼仪（限速、UA、指数退避）、
  把返回解析为统一 PaperDocument。通常由 literature-search 调用，不直接面向用户。
  同义场景：检索执行、API 查询、文献接口调用、query 构建、检索脚本运行、
  接口限速与重试、检索结果解析。
user-invocable: false
metadata:
  domains: [literature]
  last_reviewed: '2026-08-18'
---

# paper-search：检索执行规程

## 目的

为上层技能（literature-search 等）提供可执行的检索规程：如何构建 query、
如何调用 `scripts/search_papers.py`、如何遵守各数据源的请求礼仪、
如何解读与排序结果、如何处理失败。

脚本约定（`scripts/search_papers.py`，纯 Python 标准库实现，无第三方依赖）：

- 参数：`--query`（必填）、`--provider {openalex,crossref,arxiv}`（必填）、
  `--limit N`（默认 10，上限 50，超出自动截断）、`--format json`。
- 成功：stdout 输出 PaperDocument JSON 数组，退出码 0。
- 失败：stdout 输出 `{"error": {"provider", "type", "message"}}`，
  type ∈ `network | rate_limited | parse`，退出码 1；永不抛栈崩溃。
- 内置礼仪：请求间隔 ≥0.5s、单请求超时 30s、UA 携带联系邮箱占位。

## 前置检查

1. `scripts/search_papers.py` 存在；`python --version` 可用（3.8+）。
2. 网络可用；目标 provider 可达。
3. 已按上层路由确定 provider 与 query。

## 操作规程

### 1. query 构建

- 关键词以英文为主（三个 provider 对英文支持最好）；专业术语保留原文。
- 布尔与字段限定（按 provider 方言）：
  - OpenAlex：`search` 参数支持 AND / OR 与引号短语，如
    `"large language model" AND agent`；复杂字段过滤（年份、类型）由上层
    在结果上后置处理，当前脚本只暴露 search。
  - Crossref：`query` 为自由文本，偏题录精确匹配；查单篇文献时直接把标题
    或 DOI 作为 query 效果最佳。
  - arXiv：`search_query` 自动加 `all:` 前缀；需要字段限定时可在 query 中
    直接使用 `ti:`（标题）、`abs:`（摘要）、`au:`（作者），组合用 `+AND+` / `+OR+`。
- 单次 query 控制在 2-6 个核心词；过长的 query 会显著降低命中率。

### 2. 执行

```bash
python scripts/search_papers.py --query "large language model agents" \
  --provider openalex --limit 20 --format json
```

- 多个 provider 时逐次串行调用，不要并发轰炸同一数据源。
- 结果较大时重定向到临时文件再解析，避免终端输出截断。

### 3. 请求礼仪（politeness）

- 频率 ≤2 req/s；脚本已内置 ≥0.5s 请求间隔，上层批量调用时仍应串行执行。
- UA 中的联系邮箱是占位 `you@example.com`：正式使用前提醒用户替换为真实
  邮箱（OpenAlex polite pool 与 Crossref 均以此为诚信标识，提供更稳定服务）。
- 收到 `rate_limited` 时按指数退避重试：2s → 4s → 8s，最多 3 次；
  仍失败则把结构化 error 原样交还上层，不无限重试。

### 4. 结果解读与排序建议

- 各源默认相关性排序；解读时注意：
  - OpenAlex 结果元数据丰富，适合按「相关性 + 被引 + 年份」二次排序；
  - Crossref 偏题录精确匹配，前排结果通常就是目标文献；
  - arXiv 偏最新成果，注意区分预印本与正式发表版（条目含 journal_ref 时
    优先引用正式版）。
- 建议上层保留原始顺序，另存「建议阅读顺序」，不要在 papers.json 里原地重排。

### 5. 失败处理

- 逐字保留脚本输出的 error JSON，原样写入上层 manifest；
- `parse` 类错误记录响应片段（≤200 字符）便于排查；
- 任何失败都不改写成「0 条结果」。

### 6. provider 查询方言速查

| provider | 端点 | query 要点 |
| --- | --- | --- |
| openalex | `https://api.openalex.org/works?search=...&per-page=` | 支持 AND / OR、引号短语；带 mailto 进 polite pool |
| crossref | `https://api.crossref.org/works?query=...&rows=` | 自由文本题录匹配；查单篇直接给标题或 DOI |
| arxiv | `http://export.arxiv.org/api/query?search_query=all:...` | 字段前缀 ti: / abs: / au:；组合用 +AND+ / +OR+ |

`--limit` 与各源单页上限：脚本上限 50，三源单页均可满足；需要更多结果时
由上层分批翻页（当前脚本不暴露 start / cursor 参数）。

### 7. 常见失败与对策

| error.type | 典型原因 | 对策 |
| --- | --- | --- |
| network | 断网、DNS 失败、TLS 错误、超时 | 检查网络后重试；连续失败则终止并留痕 |
| rate_limited | 触发源站限流（HTTP 429 / 503） | 指数退避 2s→4s→8s，最多 3 次 |
| parse | 响应结构变化、空响应、XML 非法 | 记录响应片段，改小 limit 重试；仍失败则留痕 |
| 超时 | 源站响应慢或链路抖动 | 30s 超时归入 network，稍后重试 |

任何重试都不更换 query 内容；换 query 属于上层 literature-search 的决策。
脚本单请求超时固定 30s，超时归入 `network` 类错误；不要为「快一点」
而调小间隔或并发请求——被封 IP 的代价远大于多等几秒。

## 输出模板

### PaperDocument（stdout，成功时）

```json
[
  {
    "id": "https://doi.org/10.xxxx/yyyy",
    "title": "...",
    "authors": ["..."],
    "year": 2024,
    "venue": "...",
    "doi": "10.xxxx/yyyy",
    "url": "https://doi.org/10.xxxx/yyyy",
    "abstract": "...",
    "source": "crossref",
    "retrieved_at": "2026-08-18T00:00:00+00:00"
  }
]
```

### 错误对象（stdout，失败时，退出码 1）

```json
{"error": {"provider": "crossref", "type": "rate_limited", "message": "HTTP 429 ..."}}
```

## 本技能不做什么

- 不做多源合并与去重（交给 literature-search）。
- 不评价文献质量、不做证据提取（交给 literature-survey）。
- 不抓取付费墙全文；只取 API 公开的元数据与摘要。
- 不支持 openalex / crossref / arxiv 之外的源（扩展需先修改脚本）。
- 不缓存历史检索结果充当新结果。

## 收尾与下一步

1. 把 PaperDocument 数组或 error JSON 原样交还调用方。
2. 提示命中数与建议的二次排序方式。
3. 若连续 `rate_limited`，建议上层降低频率、稍后再试，或更换 provider。
4. 结果为空数组时区分「源站确实无命中」与「检索被静默截断」，
   后者按失败处理并留痕。
