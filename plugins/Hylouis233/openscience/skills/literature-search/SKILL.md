---
name: literature-search
description: >-
  当用户需要检索学术文献、按主题找论文、收集综述素材、查询某篇文献的元数据或
  DOI、追踪某方向最新进展或预印本、做开题文献调研时使用。同义场景：文献检索、
  论文搜索、查文献、找论文、文献调研、资料收集、题录补全、
  "帮我找关于 X 的论文""这个主题有哪些代表性工作""查一下这篇文献的 DOI 和出处"。
argument-hint: '[检索问题或关键词]'
metadata:
  domains: [literature]
  last_reviewed: '2026-08-18'
---

# literature-search：多源文献检索路由器

## 目的

把用户的检索问题路由到最合适的文献数据源（provider），执行检索，
多源结果去重后统一为 PaperDocument JSON 落盘，供 literature-survey 等下游
技能直接使用。

核心原则：诚实路由、失败留痕——哪个源失败了、为什么失败，必须结构化记录
在 manifest 中，不得静默缺失；也不得把失败伪装成「该源没有结果」。

## 前置检查

1. paper-search 技能与其脚本 `scripts/search_papers.py` 存在；`python` 可用。
2. 网络可用；离线时直接说明无法检索并终止。
3. 检索问题足够具体：若用户输入过于宽泛（如「人工智能」），先与用户收敛到
   一个可检索的问题或关键词组再执行。
4. 计算 slug：检索问题规范化（Unicode NFKC 规范化、转小写、去首尾空白、
   连续空白折叠为单个空格）后取 sha1 十六进制摘要前 8 位。

## 操作规程

### 1. 路由：按问题类型选 provider

| 问题类型 | 首选 provider | 当前版本说明 |
| --- | --- | --- |
| 综合主题检索 / 引文网络 / 领域全景 | OpenAlex | 脚本直连，覆盖广、元数据丰富 |
| 精确元数据 / DOI 解析 / 题录补全 | Crossref | 脚本直连，DOI 注册数据权威 |
| 生物医学 / 临床 / 生命科学 | PubMed | 当前版本脚本未直连；以 OpenAlex 兜底（其收录 PubMed 源文献），并在 manifest 记 warn |
| 预印本 / 最新进展 | arXiv（数理信息类）/ bioRxiv（生物类） | arXiv 脚本直连；bioRxiv 经 Crossref / OpenAlex 检索其 DOI，manifest 记 warn |
| 中文文献 | CNKI / 万方 | 转交本插件的 cn-literature 技能（CNKI 导出题录解析 + 万方 API），不在本技能内重复实现 |

路由决策与理由写入 manifest；用户也可直接指定 provider 跳过路由。

### 2. 执行检索

- 按 paper-search 技能的规程构建 query 并执行：
  `python scripts/search_papers.py --query "..." --provider <p> --limit <n> --format json`。
- 同一问题可路由到多个 provider；逐源串行执行、逐源记录结果。

### 3. 失败结构化记录

任一 provider 返回 `{"error": {...}}` 或执行异常时：

- 在 manifest 的 `errors` 数组记录：provider、type（`network` / `rate_limited` /
  `parse`）、message；
- 回复中如实告知「X 源本次检索失败及原因」；
- `rate_limited` → 按指数退避稍后重试一次；仍失败则留痕，
  不得当作「该源结果为 0」。

### 4. 多源去重与统一

- 合并各源返回的 PaperDocument 数组。
- 去重优先级：① DOI（统一小写、去掉 `https://doi.org/` 前缀后比较）；
  ② 标题模糊匹配（小写、去标点、折叠空白后比较；判定重复时保留元数据
  更全的一条）。
- 重复条目的 `source` 记录为来源列表（如 `["openalex", "crossref"]`）。
- 输出统一 PaperDocument：
  `{id, title, authors, year, venue, doi, url, abstract, source, retrieved_at}`
  （`source` 为字符串数组）。

### 5. 落盘

目录 `output/literature-search/<slug>/latest/`：

- `papers.json`：去重后的 PaperDocument 数组；
- `manifest.json`：query、路由决策、各源命中数、errors、执行时间、去重统计。

### 6. 路由决策示例

- 「帮我找 Transformer 相关的代表性工作」→ 综合主题 → OpenAlex；
- 「查 10.1145/xxxx 这篇的完整题录」→ 精确元数据 → Crossref；
- 「最近半年扩散模型有哪些预印本」→ 最新进展 → arXiv；
- 「肺癌筛查影像 AI 的临床研究」→ 生物医学 → OpenAlex 兜底并记 warn；
- 「查中文核心期刊上关于乡村振兴的研究」→ 中文文献 → 转交 cn-literature
  技能处理（CNKI 导出题录解析 + 万方 API）。

### 7. 合并顺序与字段取舍

- 多源执行顺序按路由表优先级：OpenAlex → Crossref → arXiv；
- 同一论文多源命中时按字段择优：DOI 以 Crossref 为准；abstract 以
  OpenAlex / arXiv 为准（Crossref 常缺摘要）；venue 以正式发表信息为准，
  预印本 venue 只在无正式版时保留；
- PubMed / bioRxiv 走兜底源时，manifest 记 warn：「该源经 OpenAlex /
  Crossref 间接覆盖，结果可能不完整」；
- 去重后被舍弃的条目不清空，在 manifest 记录其 id 以便追溯。

## 输出模板

### papers.json

```json
[
  {
    "id": "https://openalex.org/W0123456789",
    "title": "Attention Is All You Need",
    "authors": ["Ashish Vaswani", "Noam Shazeer"],
    "year": 2017,
    "venue": "Advances in Neural Information Processing Systems",
    "doi": "10.48550/arXiv.1706.03762",
    "url": "https://arxiv.org/abs/1706.03762",
    "abstract": "The dominant sequence transduction models ...",
    "source": ["openalex", "arxiv"],
    "retrieved_at": "2026-08-18T00:00:00+00:00"
  }
]
```

### manifest.json

```json
{
  "query": "large language model agents",
  "slug": "1a2b3c4d",
  "routing": [{"provider": "openalex", "reason": "综合主题检索"}],
  "hits": {"openalex": 20},
  "errors": [{"provider": "arxiv", "type": "rate_limited", "message": "HTTP 429"}],
  "dedup": {"before": 22, "after": 20},
  "executed_at": "2026-08-18T00:00:00+00:00"
}
```

## 本技能不做什么

- 不获取付费墙全文；abstract 之外的正文不可得时如实标注。
- 不评价论文质量、不筛选「重要」文献（排序建议由 paper-search 给出，
  质量判断留给 literature-survey 与用户）。
- 不在本技能内检索中文文献：CNKI / 万方需求转交 cn-literature 技能处理。
- 不把 provider 失败伪装成「检索结果为 0」。
- 不做综述分析与成文（交给 literature-survey / review-writing）。

## 收尾与下一步

1. 汇总：各源命中数、去重后数量、失败源及原因，5 行内说明。
2. 指向 `output/literature-search/<slug>/latest/papers.json`。
3. 建议下一步：运行 literature-survey 做证据提取与全局分析；
   或调整 query 重新检索（换关键词、换 provider、调 limit）。
4. 若全部 provider 均失败，明确告知「本次检索整体失败」，
   不产出空 papers.json 冒充成功。
