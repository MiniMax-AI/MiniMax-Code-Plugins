# github-explore

> 给 AI 编码 agent 用的 `gh` CLI 发现 + 管理封装。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-3776ab.svg)](https://www.python.org/)
[![脚本数: 11](https://img.shields.io/badge/脚本-11-brightgreen.svg)](#脚本列表)
[![Schema: 3/9](https://img.shields.io/badge/schema-3%2F9-yellow.svg)](scripts/schemas)
[![依赖 gh CLI](https://img.shields.io/badge/依赖-gh%20CLI-181717.svg?logo=github)](https://cli.github.com/)

[English version](README.md) · 简体中文

---

## 这是什么

`github-explore` 是一个 agent skill，把"在 GitHub 上搜 X"这件事转成结构化、去重、相关性打分后的结果。它在 `gh search` 和 `gh repo view` 之上包了一层：智能过滤、语义多维度探索、分层输出——核心目的是**让 agent 的 context window 不被淹没**。

当你让 agent "找多 agent 协作相关的项目"，你不会想要一个按 star 排序的列表，把 ollama、langchain 这种通用 LLM 框架堆在最前面。你想要的是：经典项目（crewAI、autogen、MetaGPT、langgraph、camel、ChatDev、AutoGPT）排在最上面，协议层（A2A、ANP、ag-ui）作为单独维度，`awesome-*` 目录沉到最下面。**这个 skill 做的就是这件事**。

---

## 为什么需要它

裸 `gh search` 在 agent 研究场景下有三个结构性问题：

1. **默认按 star 排序 = 噪音。** 搜 `"multi-agent"` 出来 ollama（18 万星）和 langchain（14 万星）排第一，因为 GitHub 按热度排，不按相关度。
2. **没有语义轴。** "搜 Y 相关 repo" 是一维查询。真实主题有多面语义（框架 / 协议 / 模式），应该并行探索再合并去重。
3. **输出撑爆 context。** `gh search repos --json` 每个 repo 返回完整 body、日期、license 对象。50 个塞进 LLM 浪费几千 token。

`github-explore` 用一层薄 Python 解决这三点。

---

## 核心能力

- **多维度语义探索** — `explore.py` 让 agent 为每个主题定义 2-4 个语义轴，并行跑、合并去重，相关性得分综合了"跨轴命中数"、"经典锚点召回率"、"在 awesome list 里的信号"。
- **智能默认值** — 每个发现脚本默认过滤 fork 和 archived repo、设最低 star 门槛、按 `fullName` 去重、输出分层 markdown 摘要（约 3KB stdout）。
- **分层输出** — 完整报告自动写到 `%TEMP%/gh-explore-{topic}-{ts}.md`；agent 读摘要就行，要细节再拉文件。一次探索把 context 从 ~18KB 压到 ~2KB。
- **字段级契约** — `python scripts/<script>.py --schema` 打印 3 个支持脚本的输出 JSON 结构（`find_repos` / `explore` / `repo_summary`）；剩下 6 个 entry-point 脚本暂未暴露 `--schema`，其契约随代码维护。
- **不引入新 CLI 表面** — 每个脚本就是 `gh search` 或 `gh repo view` 的封装。去掉 skill 你照样能手动跑同样的 `gh` 命令；价值在过滤、去重、打分这套。

---

## 快速开始

```bash
# 1. 安装 skill（支持 Claude Code、Codex、Cursor 等 17+ agent CLI）
npx skills add Fectivnfy112357/github-explore

# Hermes Agent 用户：
hermes skills install https://raw.githubusercontent.com/Fectivnfy112357/github-explore/main/SKILL.md --force

# 2. 确认 gh CLI 已认证
gh auth status

# 3. 试一下（脚本位于安装后的 skill 目录，Claude Code 为 ~/.claude/skills/github-explore/）
cd ~/.claude/skills/github-explore
python scripts/find_repos.py "向量数据库" --language python --min-stars 500
python scripts/explore.py "多 agent 协作" \
  --axis "framework|multi-agent framework in:readme; collaborative agents in:readme" \
  --axis "protocol|A2A agent protocol in:readme; agent-to-agent communication in:readme"
```

每条命令往 stdout 写约 3KB 分层 markdown 摘要、往 temp 文件写完整报告。需要 JSON 加 `--format json`（**显式**；管道不会自动切）。

---

## 脚本列表

| 脚本 | 用途 | 支持 `--schema` | 说明 |
|---|---|---|---|
| `find_repos.py` | 多维过滤的智能 repo 搜索 | ✅ | 默认入口。多词自由文本跑双 scope（`in:readme` + 默认）提升语义召回。 |
| `explore.py` | 多维度主题探索 | ✅ | agent 内联定义轴。输出经典锚点 + 跨轴命中 + 每轴 top 5。 |
| `discover.py` | 从 seed 结果自动拓主题 | ❌ | 读 top seed 提取它们的 topic，逐个搜。快、机会主义。 |
| `trending.py` | 时间窗热门 repo | ❌ | 默认 7d；支持 `--topic`、`--language`、`--min-stars`。 |
| `repo_summary.py` | 单个 repo 深度概览 | ✅ | topic、语言、最近活跃、可 @ 用户、license。 |
| `find_similar.py` | 找替代项目 | ❌ | 跨语言选项 `--no-language`。 |
| `code_search.py` | 按 pattern 搜代码 | ❌ | `--repo`、`--org`、`--owner`、`--extension`、`--filename`。 |
| `search_issues.py` | 搜 issue / PR | ❌ | `--state`、`--type`、`--label`、`--author`、`--assignee`。 |
| `org_landscape.py` | 审计整个 org | ❌ | `--group-by {language,topic,activity,stars}`。 |
| `_lib.py` | 共享 helper | 不适用 | `ensure_auth`、`gh_json`、`parse_since`、`print_schema`。不直接调。 |
| `__init__.py` | 模块 docstring | 不适用 | 描述 scripts 包的约定。 |

**`--schema` 缺口**：9 个 entry-point 脚本里 6 个还没暴露 `--schema` CLI 参数。这 6 个的 schema 文件在 `scripts/schemas/` 里也暂缺。已支持的 3 个脚本（`find_repos` / `explore` / `repo_summary`）+ 现有的 `repo.schema.json` / `explore.schema.json` / `repo_summary.schema.json` 覆盖了最高频路径。

---

## 架构

```
                  ┌─────────────────────────────────────────────┐
                  │         Agent（LLM、coder 等）              │
                  │  - 读 SKILL.md 了解触发条件 + 协议          │
                  │  - 决定用哪个脚本 + 哪些轴                  │
                  └──────────────────┬──────────────────────────┘
                                     │ python scripts/<name>.py [args]
                                     ▼
            ┌────────────────────────────────────────────────────┐
            │  scripts/  （9 个入口 + _lib + __init__）          │
            │  ─────────────────────────────────────────────────│
            │  find_repos   explore   discover   trending       │
            │  repo_summary find_similar code_search            │
            │  search_issues org_landscape                       │
            │                                                    │
            │  共享：_lib.ensure_auth, _lib.gh_json,            │
            │        _lib.print_schema, _lib.parse_since         │
            └──────────────────┬─────────────────────────────────┘
                               │ subprocess.run(['gh', ...])
                               ▼
            ┌────────────────────────────────────────────────────┐
            │  gh CLI  （search repos / repo view / search code）│
            │  通过 gh auth status 认证。                        │
            └──────────────────┬─────────────────────────────────┘
                               │
                               ▼
            ┌────────────────────────────────────────────────────┐
            │  GitHub REST + Search API                          │
            │  ~5000/hr core / ~30/min search（已认证）          │
            └────────────────────────────────────────────────────┘

            输出：
            - stdout：~3KB 分层 markdown 摘要（默认）
            - stdout：完整 JSON（显式 --format json）
            - 磁盘：%TEMP%/gh-explore-{topic}-{ts}.md（始终写）
```

**两层，一个心智模型。** scripts 负责发现（搜 / 去重 / 打分 / 渲染）。直 `gh` 负责管理（建 / 改 / 合并 / 标 label / 跑 workflow）。`references/commands-*.md` 文档化管理类命令，不让 `SKILL.md` 臃肿。

---

## 何时用哪个

| 任务 | 工具 |
|---|---|
| 找某主题的 repo | `find_repos.py "<query>"` |
| 摸清整个领域全貌 | `explore.py "<topic>" --axis ...` |
| 自动拓到相关主题 | `discover.py "<seed>"` |
| 看最近热门 | `trending.py --window 7d` |
| 读懂一个 repo | `repo_summary.py owner/repo` |
| 找替代品 | `find_similar.py owner/repo` |
| 某 pattern 在哪用 | `code_search.py "<pattern>" --org ...` |
| 搜 issue / PR | `search_issues.py "<query>"` |
| 审计一个 org | `org_landscape.py <org>` |
| 建 repo、提 PR、加 label、跑 CI | `gh <command>`（查 `references/commands-*.md`） |

---

## 值得知道的设计取舍

这些是脚本里隐含的非显然决定，列出来免得你反推：

1. **`in:readme` 是多词自由文本的默认 scope。** description 太短消歧不了主题。`find_repos` 跑双 scope 再合并，对 `in:readme` 命中加相关性加成，让小而专的经典项目压过大而泛的通用 repo。
2. **`--exclude` 是后置过滤，不是 query 里的 `-term`。** GitHub 的 `-term` 排除词对 awesome list、tutorial 经常失效；这个 skill 在合并阶段按 `fullName` / `description` 子串过滤。
3. **`awesome-*` 目录打 `☰list` 标签并重度降权**，不删除。它们是另一类产物（合集 vs. 代码），应该排在真项目下面，但仍可发现。
4. **star 排序是兜底，不是默认。** `explore.py` 按相关性得分排序：经典锚点召回 + 跨轴命中 + log 缩放的 star 数。100★ 经典锚点永远压过 20 万★ 但只提了一嘴的通用 repo。
5. **输出分层，不内联。** stdout 控制在 ~3KB；完整结果写 temp 文件。这是 agent 循环跑多个主题时最大的 context 节省点。

---

## 贡献

欢迎 issue 和 PR。这是经过多次实际使用迭代出来的个人 skill；测试面是脚本本身，不是一套单元测试。

提 PR 之前：

1. 确认改动的脚本 `python scripts/<name>.py --help` 和（如果支持）`--schema` 还能跑通。
2. 新增脚本的话，往[脚本列表](#脚本列表)加一行，考虑是否要在 `scripts/schemas/` 加 schema 文件。
3. 保持分层输出约定：stdout 摘要 + temp 文件全量报告，没有例外。

---

## 许可证

MIT。详见 [LICENSE](LICENSE)。

## 致谢

由 贾晓源 ([@Fectivnfy112357](https://github.com/Fectivnfy112357)) 维护。
