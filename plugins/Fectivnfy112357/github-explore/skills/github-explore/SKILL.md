---
name: github-explore
description: "Use when the user wants to search/discover/summarize/audit GitHub (find repos about X, explore a topic's landscape, what's trending, repo overview, similar projects, code search, issue/PR search, org audit) or run gh CLI operations. Prefer scripts/ for discovery; raw gh commands for management ops."
version: 2.1.0
author: Fectivnfy112357
license: MIT
---

# GitHub CLI (gh) + Discovery Scripts

## Overview

两个层：`scripts/` 里 9 个 Python 脚本负责**搜索/发现/审计**（统一过滤 fork/archived、默认 star 下限、智能去重、relevance 排序、分层摘要+落盘），直接调用 `gh` 负责**管理操作**（建 repo、提 PR、改 label、跑 workflow 等）。脚本已做搜索 gotchas 处理，发现类请求优先用脚本。

所有脚本输出格式 `--format {table,json,markdown}`，**默认 markdown**（分层摘要 + 落盘），`json` 供管道处理，`table` 窄终端 ASCII 视图。注意：**不会**因为 stdout 被管道就自动切 JSON——要 JSON 必须显式 `--format json`（见 Common Pitfalls #1）。

## 安全边界（Security boundaries）

- **默认只读**：9 个发现类脚本（find_repos / discover / explore / trending / repo_summary / find_similar / code_search / search_issues / org_landscape）只读，不改远端状态。
- **写操作需确认**（**全 `commands-*.md` 适用**，含 `commands-auth-config.md` 与 `commands-search-format.md`）：管理类 `gh` 写命令会改变**远端状态、本机凭据或配置**。执行前必须向用户明确：**目标**（哪个 repo / org / 资源 / host）、**影响范围**（改什么、是否可逆、是否触发下游）、**最小改动数据**，并得到**明确确认**后再执行。未经确认绝不执行写操作。具体适用范围与例外见 [references/SECURITY-NOTES.md](references/SECURITY-NOTES.md)。
  - 远端写：create / update / delete / close / merge / dispatch / rerun / cancel / set-default / fork / deploy-key …
  - 凭据写（`commands-auth-config.md`）：`gh auth login/logout/switch/setup-git/refresh --scopes …`——影响本机 git credential helper 与 token scopes，`refresh --scopes` 是**权限提升**。
  - 配置写（`commands-auth-config.md`）：`gh config set …` / `gh config clear-cache`——改 `~/.config/gh/`。
  - API mutation（`commands-search-format.md`）：`gh api --method POST|PUT|DELETE|PATCH …`；`gh api graphql` 中含 `mutation` 的 query——可触达任意 GitHub 资源（含 admin endpoint），影响面比 `gh issue` / `gh pr` 子命令更广。
- **禁止回显 token**：认证诊断只用 `gh auth status`（不回显 token）。禁用 `gh auth token`、`gh auth status --show-token`、`--with-token` 注入；`GH_TOKEN` 仅用于自动化（CI），不得打印到 transcript。
- **错误脱敏（honest scope）**：9 个发现脚本内部走 `_lib.warn/die()` 的 `redact_secrets()` 路径，自动遮 `ghp_*` / `github_pat_*` / `Bearer *` / `token=*` / `GH_TOKEN=*` / `GITHUB_TOKEN=*` 形态。**但 agent 在 Bash 工具里直接跑 `gh …` 时，stderr 不经过 Python wrapper，原样进 transcript**——分享前手动管道 `gh <cmd> 2>&1 | python scripts/redact_stderr.py`。脱敏是 best-effort，非常规 token 形态仍可能漏出。
- **`GH_HOST` / GitHub Enterprise 风险**：`GH_HOST` 会切换所有 `gh` 子命令的 API 流量目的地（纯 git 操作如 `git push` 不受 `GH_HOST` 影响，跟 `git remote` 走）；默认 `github.com`。切到 GHES on-prem（`github.acme.com`）必须用 `GH_ENTERPRISE_TOKEN` 而非 `GH_TOKEN`；切到 GHEC 租户（`*.ghe.com`）用 `GH_TOKEN`。`--hostname` 不是全局 flag，只在 `auth` / `api` / `attestation` 等约 11 个子命令上存在；通用切换姿势是 `GH_HOST=... gh <cmd>` 或 `gh auth switch --hostname X`。`gh auth status` 默认枚举所有已认证 host，不是只校验当前。skill 不限制、不校验、不警告 host 值——用户负责确保目的地正确；跨 host 误调用 = 跨凭据泄漏（写错组织的 issue / 错仓库开 PR / 错 token 触发 GHES workflow）。

## When to Use

- 「找 X 相关的 repo」「search repos about Y」→ `find_repos.py`
- 「摸清 X 领域全貌」「map out the field」→ `discover.py`（快）或 `explore.py`（有目的地多维度）
- 「最近热门 / trending」→ `trending.py`
- 「这个 repo 怎么样 / overview」→ `repo_summary.py`
- 「跟 X 类似 / alternatives」→ `find_similar.py`
- 「找代码片段 / where is pattern used」→ `code_search.py`
- 「找 issue/PR」→ `search_issues.py`
- 「审计整个 org / 按语言/活跃度/主题分组」→ `org_landscape.py`
- 「建 repo / 提 PR / 改 label / 跑 workflow」→ 直接 `gh`（命令索引见 references/ 下的 commands-* 系列，按类型查）；**写操作执行前必须明确目标/影响/最小数据并得到用户确认（见「安全边界」）**
- 不要用脚本做：管理类写操作（创建/修改/删除）。

## When to use which script — the deeper logic

- **单维问题**（搜 repo / 看 repo / 找 issue）→ 单发脚本。`find_repos.py` 是默认起点。
- **多词自由文本**：`find_repos` 默认跑**双 scope**（`in:readme` + 默认 scope）再 union，用「star 数 + 软 relevance 加成」排序——没有这个，高星通用 repo（如 ollama 之于 "observability platform"）会挤掉更对题的小项目。`--no-semantic` 关掉回到单搜索。
- **稀疏结果**：`find_repos` 返回 <5 且无 narrowing qualifier 时，stderr 会提示改用 `explore.py` 配显式 axes——概念型主题单轴搜覆盖不了。
- **数据驱动拓主题**：`discover.py` 从 seed 结果自动挖 topics 再逐个搜。快、便宜，但质量取决于 seed 是否干净。适合没有清晰维度概念时。
- **有目的地语义探索**（"map multi-agent collaboration"）→ `explore.py` + 内联 axes。agent 决定维度，脚本并行执行并输出软验证信号（awesome 交叉、跨轴计数、canonical 召回）。字段级探索用这个。
- `discover` 机会主义快；`explore` 刻意广。默认决策：先 `find_repos`，稀疏或多维就升级 `explore`。

## Quick start

```bash
# 搜索（多词自由文本自动双 scope + relevance）
python scripts/find_repos.py "vector database" --language python --min-stars 500

# 自动拓主题（快）
python scripts/discover.py "agent framework" --depth 6 --per-topic 5

# 有目的地多维度探索（inline axes，agent 定维度）
python scripts/explore.py "multi-agent" \
    --axis "framework|multi-agent framework in:readme; collaborative agents in:readme" \
    --axis "protocol|A2A; ANP; agent-to-agent"

# 时间窗 trending
python scripts/trending.py --window 7d --language rust
python scripts/trending.py --window 1m --topic llm --min-stars 100

# 单发
python scripts/repo_summary.py langchain-ai/langchain --format markdown
python scripts/find_similar.py vercel/next.js --limit 20
python scripts/code_search.py "def authenticate" --language python
python scripts/code_search.py "useEffect" --org vercel --extension tsx
python scripts/search_issues.py "memory leak" --repo langchain-ai/langchain
python scripts/search_issues.py "is:open is:issue label:bug" --org langchain-ai

# Org 审计
python scripts/org_landscape.py vercel --group-by language
python scripts/org_landscape.py langchain-ai --group-by activity
```

## Common options (多数脚本共享)

- `--format {table,json,markdown}` — 默认 markdown。`json` 管道处理，`table` 窄终端。
- `--limit N` / `--min-stars N` — 上限 / star 下限。
- `--include-forks` / `--include-archived` — 默认都排除，opt-in。
- 时间过滤：`--pushed-since 30d`、`--created-since 1y`（后缀 d/w/m/y）。

## find_repos.py 特定

- `--semantic`（默认开）/ `--no-semantic`：多词自由文本无 narrowing 时跑双 scope + union + relevance 排序。`--no-semantic` 回到单搜索。
- **narrowing qualifier 会关掉 dual-scope**：`--language`、`--topic`、`--owner`、`--org`、`--license`、`--pushed-since`、`--created-since`、`--max-stars` 任一出现 → 单搜索（否则 `in:readme` 会让 awesome-list 压过真实项目）。
- `--max-stars` 也计入 narrowing（`stars:<=N`）。
- JSON 输出带 `_rel` 字段（0-3 relevance 分）。
- 用户 `--owner` → `user:` qualifier；`--org` → `org:` qualifier（与 search_issues 一致）。

## explore.py（"map the field" 模式）

- **轴由 agent 定**，无维护 taxonomy 文件。`--axis "name|q1; q2 OR q3"`（`;` 或带空格的 `OR` 拆多角度，结果 union）。`--limit-per-axis` 默认 20。
- **查询要具体**：`agent framework` 会被 100k+ 星通用 repo 淹没；`multi-agent framework in:readme` 更准。语义查询建议 `in:readme`。
- **抽象/多义主题必须拆轴，不能直接搜主题词**（见下方"轴设计方法论"，这是抽象主题能否可用的关键）。
- **`--exclude TERM`（可重复，通用噪音过滤）**：匹配 fullName/description 子串，大小写不敏感。对抽象主题几乎必用：`--exclude awesome`（目录不是项目）、`--exclude tutorial`、`--exclude demo`、`--exclude osint` 等。脚本在后合并阶段统一过滤，跨所有轴、与查询写法无关——比在查询里拼 `-term` 可靠（实测 GitHub 的 `-term` 排除词经常失效，awesome-* 目录仍会混入）。
- **awesome-* 目录自动标记 `☰list` 并重度降权（-1000，不删除）**：目录 vs 项目语义不同。探项目类主题时它们沉到所有真实项目之后（可能被 `--limit-per-axis` 挤出 top N）；**若主题本身是资源合集/awesome 目录**（"awesome X 有哪些"），别用 explore 轴——用 `find_repos.py "awesome <topic>"` 直接搜目录。
- **`--min-stars` 挡不住语义噪音**：它只过滤低星，高星通用仓库（dify/OpenHands/torvalds/linux 这种 readme 概念密度高的）照样进来。去噪靠**查询精确化 + --exclude**，不是抬高 min-stars。
- **输出分层**：默认 stdout ≤ ~3KB——canonical anchors → 跨轴命中 → top 5/轴；`--full` 把完整报告打到 stdout；完整报告**总是**写盘（`%TEMP%/gh-explore-{topic}-{YYYYMMDD-HHMMSS}.md`，`--output PATH` 改路径，`--output` 隐含 `--full`）。
- **排序 relevance_score**：`_is_canonical` 100万 > `_backfilled` 10万 > `_in_awesome` 1万 > 跨轴数×1000 > log10(stars+1)×10，`_is_list`（awesome 目录）−1000 沉底。100 星 canonical 锚点永远压过 20 万星只提一嘴的通用 repo。
- **信号 flag**：`★canonical`（代码内建的必出锚点集，multi-agent/rag/agent 主题）、`↻Naxes`（N 轴都出现）、`✓awesome`（在 awesome list 里）、`☰list`（是 awesome 目录，不是项目）、`⚑backfilled`（anchor 缺失时用 core API 补拉）。
- **`--awesome` 真实成本**（重要，配额敏感）：每个 slug 变体 1 次 `gh search` + 找到后 1 次 readme API。多词 topic 最多 ~8 个变体 → **最多 ~8 次 search + 1 次 readme**，不是 1-2 次。默认关闭；要交叉验证才开。
- **canonical backfill 用 core API quota（5000/hr）**，不占 search quota（30/min），search 限流后仍可用。
- **canonical 锚点只覆盖热门主题**（multi-agent/rag/agent）：抽象新概念主题（"主动智能""自反馈自优化"）拿不到锚点验证，此时**轴设计的信噪比检查**就是唯一的质控手段——跑完看是否有轴被无关巨仓淹没，有就缩查询加排除。
- **轴质量观察指标（explore 自动输出，供判断非定论）**：每轴自动算 3 个原始信号——`semantic_hit_rate`（repo 描述命中查询显著词的比例）、`list_dir_ratio`（awesome 目录占比）、`top3_giant`（top3 是否全是 5 万+ 巨仓），JSON 模式在 `axes[i].quality`，table 在轴名后标 `低命中`/`☰d`/`⇧巨仓`，markdown 在轴标题下加一行注释。**只观测不下结论**：语义主题（in:readme 召回）的命中率天然偏低，会被误伤，所以指标是给 agent 看的线索，不是自动 verdict，绝不自动改查询。

### 轴设计方法论（抽象/多义主题必读）

抽象主题（人机协作、主动智能、自反馈自优化……）直接用主题词搜索必被泛词噪音淹没。通用拆法：

1. **拆成 2-4 个"可查询的具体语义单元"**，不是搜主题词本身。例：`主动智能` → `proactive assistance` / `anticipatory computing` / `agentic OS` / `autonomous agent operating system`。
2. **每个轴给 1-3 个查询角度**，角度要带限定词避免裸宽词。裸 `proactive AI` 会被 100k+ 通用 repo 淹没；`proactive context-aware AI partner in:readme` 才能捞到 MineContext 这种真相关项目。
3. **宽泛查询会退化为按 star 排序的宽匹配**：当轴查询太宽（如 `AI operating system in:readme`），GitHub 直接返回 torvalds/linux、vllm 这种巨仓——**信噪比检查的信号**：若某轴 top 全是明显无关的大仓库，说明查询太宽，缩到更具体语义。
4. **用 `--exclude` 处理可枚举的噪音类别**：awesome、tutorial、demo、osint、course、example……抽象主题几乎必用。
5. **min-stars 是最后手段**：只在低星噪音泛滥时抬它，别指望它去噪。
6. **先小后大**：先跑 2 轴验证信噪比，确认轴方向对了再扩到 4 轴，避免 8 轴全被污染浪费配额。

## 脚本输出 schema（`--format json` 通用）

所有发现类脚本 `--format json` 返回**相同字段命名**（GitHub API 原生 camelCase，**不是** snake_case）。**不要猜字段——读契约的两种方式**：

1. `python scripts/<script>.py --schema`（仅 3 个脚本支持：`find_repos` / `explore` / `repo_summary`，以及通过 `_lib.print_schema` 间接调）
2. 直接看 `explore.schema.json` / `repo.schema.json` / `repo_summary.schema.json` 三个契约文件（位于脚本目录下的 schemas 子目录；其他 6 个脚本的输出结构以 `gh search` 原生 JSON 字段为准，参考 `references/commands-search-format.md`）

三个契约文件的**关键差异**（猜错必踩的坑）：

| 脚本 | 输出位置 | 字段复数 | 最易踩 |
|---|---|---|---|
| find_repos 等发现类 | 顶层数组，每项一个 repo | `stargazersCount`/`forksCount`（复数） | `fullName` 不是 `full_name` |
| explore | 顶层 `{topic, axes:[...]}`，**repo 在 `axes[i].repos[j]`** | 复数 + 信号字段（`_is_canonical`/`_is_list` 等） | 在顶层找 repo |
| repo_summary | **嵌 `repo` 键下**（`d['repo']['stargazerCount']`） | `stargazerCount`/`forkCount`（单数） | 顶层直接取字段 |

> 各脚本完整参数以 `python scripts/<name>.py --help` 为权威。管道要 JSON 必须显式 `--format json`。

## 命令索引（references/，按需查阅）

管理类操作直接 `gh`，具体命令按类型查对应文件，不内联复制：

| 类型 | 文件 | 覆盖 |
|---|---|---|
| 认证/配置/结构 | `references/commands-auth-config.md` | 安装、auth、CLI 结构、config、环境变量、全局 flag |
| 仓库/Issue/PR | `references/commands-repo-issue-pr.md` | repo 全生命周期、issue、PR、常用开发流 |
| 搜索/格式化/API | `references/commands-search-format.md` | `gh search`、JSON/jq/模板输出、`gh api` |
| CI/CD | `references/commands-cicd.md` | run/workflow/cache/secret/variable/release |
| 杂项 | `references/commands-misc.md` | org、label、SSH/GPG、gist、codespace、alias、extension、ruleset |

## 搜索 gotchas（脚本已处理，agent 不必重踩）

1. `gh search` 的 `OR` 不符合直觉——`"A OR B"` 返回 0 结果。用 `;` 或带空格 `OR` 拆多 query。
2. 语义查询用 `in:readme`，description 太短。
3. `topic:` 作为硬过滤不可靠（项目打标签不一致）；优先 `stars:>=`。
4. GitHub 限流：认证 ~5000/hr API + search 30/min。脚本默认 `--max-workers 2` 守住 30/min；撞 403/429 有重试但会慢。8 轴 × 3 角度 = 24+ 次调用，注意配额。
5. `gh search repos` 的 JSON **没有 topics 字段**（只有 `gh repo view` 有）。`discover.py` 因此用 N+1 次 `repo view` 取 topics（只取前 10 个 seed）；`find_repos` 因此不做 self-echo 过滤。
6. 更多结果 ≠ 完整结果：文本搜索漏知名项目（`prometheus` 不写 "observability platform"）。生态型问题直接上 `explore.py --awesome`。

## 组装脚本（管道友好）

所有脚本 `--format json` 输出合法 JSON，可链式：

```bash
python scripts/discover.py "agent framework" --format json \
  | python -c "import json,sys; r=json.load(sys.stdin)['topics']; print('\n'.join(t for t,v in r.items() if v))"
python scripts/trending.py --window 30d --format json \
  | python -c "import json,sys,datetime; d=json.load(sys.stdin); print(len(d), 'trending repos')"
```

## Common Pitfalls

1. **以为管道会自动 JSON**（`__init__.py` 旧 docstring 说 "auto-select JSON when piped"——**假话**）。实际默认恒 markdown，要 JSON 必须 `--format json`。写管道命令时显式加 `--format json`，否则得到 markdown 文本无法 json.loads。
2. **explore 不传 `--axis`**：`die("Provide axes via --axis")`。axes 是必须的，不是可选。
3. **`--awesome` 成本低估**：多词 topic 会触发最多 ~8 次 `gh search` + 1 次 readme，配额紧张时慎用，或只对最终 topic 跑一次。
4. **explore 查询太泛**：`agent framework` 直接被大 repo 淹没。多角度、带 `in:readme`、带主题词。
5. **`gh search repos` JSON 字段是复数** `stargazersCount/forksCount`；`gh repo view` 是单数 `stargazerCount/forkCount`。手写 jq 时别混。
6. **repo_summary 的 users 段**是 `mentionableUsers`（仓库可见的可 @ 成员），标题叫 "Mentionable users"——不是 "被提及最多的用户"，别误解成社区活跃度。
7. **Windows 路径**：git-bash 下用 `C:/...` 或 `/c/...`；反斜杠结尾会转义错。

## Verification Checklist

- [ ] 用了正确的脚本（发现→脚本，管理→裸 gh）
- [ ] 管道场景显式 `--format json`
- [ ] explore 查询角度具体且带 `in:readme`（语义主题）
- [ ] 配额敏感时 `--max-workers 2`、`--awesome` 只跑一次
- [ ] org/repo 审计确认了过滤条件（fork/archived/stars）符合预期
- [ ] 管理操作按类型查 references/ 下的 commands-* 系列（不内联复制，不误用脚本）
- [ ] 发现类任务只用只读脚本，未触发任何远端写
- [ ] 写操作前已向用户明确目标/影响/最小数据并获得确认
- [ ] 认证诊断只用了 `gh auth status`，未回显任何 token
