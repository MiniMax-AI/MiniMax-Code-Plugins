---
name: cn-literature
description: >-
  当用户需要检索或整理中文文献（CNKI 知网、万方、维普、超星）、把中文数据库
  导出的题录文件解析成统一 PaperDocument、或把中文文献与英文检索结果合并去重
  时使用。同义场景：中文文献检索、知网导出题录解析、万方检索、Refworks/EndNote
  格式转换、"帮我把这份 CNKI 导出的 txt 整理成文献表""中文核心期刊上关于 X
  有哪些研究"。
argument-hint: '[检索主题]'
metadata:
  domains: [literature, chinese-literature]
  last_reviewed: '2026-08-18'
---

# cn-literature：中文文献检索与题录整理工作流

## 目的

把中文文献纳入与英文文献同一套 PaperDocument 产物体系。核心设计原则是
**诚实设计**：各中文数据库的能力边界差异很大，本技能对每个来源如实说明
"能做什么、不能做什么"，不假装有接口、不绕过平台限制。

各来源能力边界（必须先读再执行）：

- **CNKI（知网）**：无公开 API。本技能**不绕过验证码、不批量抓取**。
  推荐工作流是"人工检索 + 题录导出 + 脚本解析"：用户在 CNKI 官网检索，
  导出 Refworks 或 EndNote 格式题录文件，再用
  `scripts/parse_refworks.py` 解析为 PaperDocument。
- **万方**：有官方开放平台（`api.wanfangdata.com.cn`，按点计费）。
  已配置 `WANFANG_TOKEN` 环境变量时，可用
  `scripts/wanfang_search.py` 直接检索；未配置时走与 CNKI 相同的
  人工导出流程。
- **维普 / 超星**：无可用接口，请用户人工检索后把题录粘贴到会话中，
  由你手工整理为 PaperDocument。

## 前置检查

1. 网络可用与否决定不了 CNKI 流程（其核心是本地解析），但万方直接
   检索需要网络；离线时只做解析类工作。
2. 明确用户手里有什么：是"还没检索"（→ 引导官网检索）、"已有导出
   文件"（→ 解析）、还是"已粘贴题录"（→ 手工整理）。
3. 检查 `scripts/parse_refworks.py` 与 `scripts/wanfang_search.py`
   存在；`python` 可用。
4. 计算 slug：检索主题规范化（Unicode NFKC 规范化、转小写、去首尾空白、
   连续空白折叠为单个空格）后取 sha1 十六进制摘要前 8 位。

## 操作规程

### 1. 按来源选择工作流

| 来源 | 工作流 | 说明 |
| --- | --- | --- |
| CNKI | 人工检索 → 导出题录 → `parse_refworks.py` | 无公开 API，禁止绕过验证码与批量抓取 |
| 万方（已配 WANFANG_TOKEN） | `wanfang_search.py` 直接检索 | 官方开放平台，按点计费 |
| 万方（未配置 token） | 同 CNKI 人工导出流程 | 先告知配置方法，由用户选择 |
| 维普 / 超星 | 人工检索 → 粘贴题录 → 手工整理 | 无接口 |

### 2. CNKI 人工导出引导（未检索时给用户的话术要点）

1. 在 CNKI 官网用检索主题完成检索并勾选目标文献；
2. 选择"导出与分析"→ 导出格式选 **Refworks**（次选 EndNote）；
3. 保存为 UTF-8 编码的 `.txt` 文件，放到工作区；
4. 把文件路径交给本技能。

如实告知：CNKI 导出的题录是**仅元数据**（metadata-only），不含全文；
全文需用户凭机构权限自行下载，本技能不代为获取。

### 3. 解析题录文件

```bash
python scripts/parse_refworks.py --input <题录.txt> --format json --origin CNKI
```

- `--origin` 填来源名（CNKI / 万方 / 维普 / 超星），写入每条的 `source`
  字段，供下游按 guardrail 第 1 条标注 `[CNKI]`、`[万方]`。
- 脚本容错：未知标签跳过、缺字段留 null；解析结果逐条检查 title 是否
  为空，空 title 的条目挑出来交用户核对，不静默丢弃。
- EndNote 格式（%0/%T/%A 标签）与 Refworks 格式（RT/T1/A1 标签）结构
  类似；本脚本按 Refworks 标签解析，EndNote 导出文件请用户重新导出为
  Refworks，或由你手工整理。

### 4. 万方直接检索（仅已配置 token 时）

```bash
python scripts/wanfang_search.py --query "<检索主题>" --limit 20 --format json
```

- token 从环境变量 `WANFANG_TOKEN` 读取；未配置时脚本输出
  `{"error": {"type": "auth_missing", ...}}`，此时回到人工导出流程，
  并把配置指引转告用户。
- 接口字段以万方开放平台官方文档为准；上游变更时脚本输出
  `upstream_changed` 错误，如实转告用户，不自行猜字段修补结果。

### 5. 统一 PaperDocument 与标注规则

- 全部来源统一为：
  `{id, title, authors, year, venue, doi, url, abstract, source, retrieved_at}`
  （`source` 为字符串数组）。
- `source` 字段记录来源列表（如 `["CNKI"]`、`["万方"]`）；写入任何
  产物时按包根 CLAUDE.md guardrail 第 1 条在同句标注 `[CNKI]` / `[万方]`。
- 仅有元数据、无全文/无摘要的条目，在落盘 JSON 之外给用户的汇总中
  明确标注 **metadata-only**，下游 literature-survey 引用时不得把
  metadata-only 条目当作"已读原文"。
- 中文文献常缺 DOI：id 用 `来源:sha1(标题+首作者)前8位` 形式生成，
  保证同批去重稳定。

### 6. 与英文检索结果合并（可选）

- 若同主题已有 literature-search 的 `papers.json`，按同一去重规则合并：
  ① DOI（统一小写、去 `https://doi.org/` 前缀）；② 标题模糊匹配
  （小写、去标点、折叠空白）。
- 中英文重复条目（同一工作的不同语言版本）一般不算重复，保留两条并
  在 manifest 注明疑似同工作对，交用户判断。

### 7. 落盘

目录 `output/cn-literature/<slug>/latest/`：

- `papers.json`：PaperDocument 数组；
- `manifest.json`：主题、来源与各自条数、工作流类型（parse / api /
  manual）、metadata-only 条数、errors、执行时间。

## 输出模板

### papers.json

```json
[
  {
    "id": "CNKI:a1b2c3d4",
    "title": "钠离子电池层状氧化物正极材料研究进展",
    "authors": ["张三", "李四"],
    "year": 2023,
    "venue": "电化学",
    "doi": null,
    "url": null,
    "abstract": "钠离子电池因资源丰富……",
    "source": ["CNKI"],
    "retrieved_at": "2026-08-18T00:00:00+08:00"
  }
]
```

### manifest.json

```json
{
  "topic": "钠离子电池 正极材料",
  "slug": "1a2b3c4d",
  "workflow": {"CNKI": "parse", "万方": "api"},
  "counts": {"CNKI": 12, "万方": 8},
  "metadata_only": 20,
  "errors": [{"connector": "wanfang", "type": "auth_missing", "message": "WANFANG_TOKEN 未配置"}],
  "executed_at": "2026-08-18T00:00:00+08:00"
}
```

## 本技能不做什么

- 不绕过 CNKI 验证码、不批量抓取 CNKI 网页；无公开 API 就只用
  "人工检索 + 导出 + 解析"流程。
- 不获取付费墙全文；题录为 metadata-only 时如实标注。
- 不在未配置 WANFANG_TOKEN 时假装能直连万方。
- 不处理维普/超星的自动化检索；只整理用户粘贴的题录。
- 不把"某库未检索到"表述为"该研究不存在"——中文库覆盖各有盲区。
- 不做综述分析（交给 literature-survey）；与英文结果合并后如需核验
  引用，交给 citation-verify。

## 收尾与下一步

1. 汇总：各来源条数、metadata-only 条数、走了哪种工作流、失败及原因，
   5 行内说明。
2. 指向 `output/cn-literature/<slug>/latest/papers.json`。
3. 建议下一步：与 literature-search 结果合并后运行 literature-survey；
   或把 metadata-only 条目清单交给用户，由其凭机构权限补全文。
4. 若用户在 CNKI 导出环节遇到困难，回到第 2 步话术逐项排查（导出格式
   是否选 Refworks、编码是否 UTF-8），不提议任何绕过平台限制的做法。
