---
name: research-workspace
description: >-
  当用户开始新研究项目、说"初始化工作区""建一下项目目录""检查目录结构""workspace""整理一下我的研究文件夹"，或任何 skill 发现当前目录不符合工作区约定时使用。本技能定义并维护科研工作区的标准目录结构（data/figures/notebooks/papers/reports/reviews/scripts/output/.openscience）、产物路径契约（output/<skill>/<slug>/latest/ 指向最近运行，历史运行按时间戳归档）与原始数据只读原则，并提供项目初始化与结构体检两套清单。同义触发场景：新建课题目录、项目结构检查、目录规范、产物放哪里、原始数据能不能改。
argument-hint: '[init|check]'
metadata:
  domains: [workspace, project-structure, data-management]
  last_reviewed: '2026-08-18'
---

# research-workspace：科研工作区约定

## 目的

研究产物散落于桌面和下载文件夹，是科研工作流最常见的崩坏起点。本技能规定一套统一的目录结构与路径契约，使得：

1. 任何 skill 都知道"产物该写到哪里""该去哪里读原始数据"；
2. 同一 skill 的多次运行互不覆盖，历史可追溯；
3. 新会话能通过目录结构 itself 恢复大部分上下文；
4. 原始数据永远保持到手时的样子，为证据胶囊（evidence-capsule）提供冻结基础。

## 前置检查

1. 确认当前工作目录是用户认定的项目根目录。拿不准时问用户："把 <当前路径> 当作本项目的工作区根目录，对吗？"
2. `init` 前检查目录是否已有内容：非空目录不报错，但初始化时只补缺、不改动已有文件（见"初始化清单"）。
3. `check` 模式只读不写，任何"顺手修复"都必须先向用户报告再执行。

## 标准目录结构

工作区根目录下的标准布局：

```text
<project-root>/
├── data/            # 原始数据，只读。到手后不再修改
├── figures/         # 论文/报告用图的最终版本（由 output 中的产物精选而来）
├── notebooks/       # Jupyter / Quarto 等交互式笔记本
├── papers/          # 论文与报告文稿（草稿与版本）
├── reports/         # 阶段性报告、组会材料、stage-report 的精选副本
├── reviews/         # 收到的审稿意见、发布前审查的记录
├── scripts/         # 可重复执行的脚本（分析、作图、数据处理）
├── output/          # 各 skill 的运行产物（结构见"产物路径契约"）
└── .openscience/    # 工作台元数据：provenance.jsonl、env/ 等
```

各目录的职责边界：

- **data/**：只进不出的原始数据。包括实验导出文件、下载的数据集、问卷原始答卷。子目录建议按来源或日期组织（如 `data/2026-08-xrd/`），但插件不强制。
- **figures/ 与 papers/**：放"准备给人看"的版本。过程稿在 output/ 里，只有被用户选中后才复制到这里。
- **output/**：机器产物的家。用户一般不需要手动整理这里——结构由契约保证。
- **.openscience/**：隐藏目录，记录工作台的运行状态。用户不需要直接编辑，但可以随时查看。`provenance-record` 写这里。

## 产物路径契约

所有 skill 的运行产物统一遵守：

```text
output/<skill 名>/<slug>/<timestamp>/    # 每次运行的完整产物
output/<skill 名>/<slug>/latest/         # 最近一次运行的副本（或指针）
```

规则：

1. **每次运行一个时间戳目录**：`<timestamp>` 格式为 `YYYYMMDD-HHMMSS`（本地时间）。一次运行产生的所有文件都放进同一个时间戳目录，不允许跨目录散落。
2. **latest 是副本不是链接**：运行结束时，把本次时间戳目录的内容完整复制到 `latest/`（先清空再放）。选副本而非符号链接，是因为 Windows 与部分远程文件系统对符号链接支持不一致；副本的代价是磁盘占用翻倍，产物通常很小，可以接受。
3. **读产物一律从 latest 读**：下游 skill 需要上游产物时，只引用 `output/<skill>/<slug>/latest/...` 路径，保证"用到的永远是最新批准的版本"。需要引用历史版本时写明完整时间戳路径。
4. **历史目录不删不改**：时间戳目录一旦写完就冻结。清理磁盘是用户的决定，skill 不得自动删除历史运行（guardrail 第 8 条）。
5. **slug 来源**：研究项目产物用 research-lifecycle 的 slug；与具体项目无关的产物（如画像修改记录）使用固定 slug `workspace`。
6. **已登记的例外**：evidence-loop 使用轮次目录 `output/evidence-loop/<slug>/<round>/`，是本契约的显式例外，替代 `latest/`（见该 skill 的产物结构说明）。

示例：

```text
output/
├── literature-search/
│   └── 3f9a1c7e/
│       ├── 20260818-101500/
│       │   ├── results-openalex.json
│       │   └── results-cnki.json
│       ├── 20260819-090000/
│       │   └── results-openalex.json
│       └── latest/            # 与 20260819-090000/ 内容相同
└── research-lifecycle/
    └── 3f9a1c7e/
        └── latest/
            ├── research-question.md
            └── hypothesis.md
```

## 原始数据只读原则

1. 文件进入 `data/` 即冻结：不改名、不编辑、不删除、不覆盖。
2. 一切清洗、转换、筛选都生成**新文件**：中间产物放 `output/<skill>/<slug>/`，清洗后需要复用的数据集放 `data/` 以外（建议 `output/` 或项目自建的 `derived/`）。
3. 数据纠错走"增补"而非"修改"：发现原始数据有误时，新存一份修正版并附说明文件（`README-correction.md` 写明哪份文件哪里错了），原文件保留。
4. 任何 skill 检测到自己在写 `data/` 下已存在的文件，必须停止并报告——这几乎一定是路径错误。
5. 大文件例外：原始数据体积巨大时（如测序原始数据），允许只存校验和与获取方式说明，但说明文件本身仍按只读原则管理。

## 1 · init：项目初始化清单

按顺序执行，每步完成后向用户报告：

1. 创建九个标准目录（已存在则跳过，不报错）。
2. 在 `.openscience/` 下初始化空文件：`provenance.jsonl`（不存在则创建空文件）；`env/` 子目录。
3. 生成工作区说明文件 `WORKSPACE.md`（根目录），内容：标准目录速查、产物路径契约、原始数据只读原则、本工作区初始化日期。已存在 WORKSPACE.md 时跳过不覆盖。
4. 检查 CLAUDE.md 画像状态：有 `[填空]` 时提醒用户先完成 `cold-start-interview`。
5. 如果用户提供了研究主题，顺手计算 slug 并创建 `output/research-lifecycle/<slug>/` 目录骨架，提示可以直接进入 research-lifecycle。
6. 用 provenance-record 登记本次初始化（paths 为创建的目录清单，note 为 "workspace init"）。

初始化是幂等的：重复运行 `init` 不产生任何破坏，只补齐缺失部分。

## 2 · check：结构体检清单

只读检查，输出体检报告：

1. 九个标准目录哪些缺失、哪些非空；
2. `output/` 下所有 `<skill>/<slug>/` 组合，各自的运行次数与 latest 是否同步（latest 内容与最新时间戳目录是否一致）；
3. `data/` 的健康度：是否有文件在过去 7 天内被修改（违反只读原则的信号，用文件 mtime 判断）；
4. `.openscience/provenance.jsonl` 是否存在、最后一条记录的时间；
5. 发现的问题按"建议修复 / 需要用户决定"分类列出，不自动动手。

## 3 · 多项目共存

一个工作区可以同时进行多个研究项目（多个 slug）。规则：

1. 每个项目的产物严格隔离在各自的 `<slug>/` 目录下，互不引用对方的时间戳目录；
2. `stage.yaml` 每个项目一份，放在 `output/<slug>/stage.yaml`（见 stage-gate），因此恢复进度时以项目为单位；
3. `data/` 是项目间共享的：同一批原始数据可以服务多个研究问题，子目录按来源组织即可，不必按项目复制；
4. `.openscience/provenance.jsonl` 是全局唯一一份，各项目的记录通过 paths 中的 slug 路径区分。

## 输出模板

`init` 完成后：

```markdown
## 工作区初始化完成

- 根目录：<path>
- 新建目录：…（列出，已存在的标 [已存在]）
- 元数据：.openscience/provenance.jsonl 已就绪
- 画像状态：完整 / 有 N 节 [填空]（建议先运行 cold-start-interview）

下一步：对 research-lifecycle 说出你的研究主题，或先运行 cold-start-interview。
```

`check` 完成后：

```markdown
## 工作区体检报告（<date>）

- 目录结构：9/9 就绪（缺失：…）
- 产物目录：N 个项目，M 次运行；latest 同步正常 / 异常（列出）
- 原始数据：只读原则正常 / 发现 N 个近期修改的文件（列出，[待复核]）
- provenance：最后记录 <时间>
- 建议：…
```

## 本技能不做什么

- 不整理 `output/` 以外的用户文件：桌面、下载文件夹里的历史文件是否迁入工作区由用户决定，本技能最多给出迁移建议清单。
- 不自动删除任何文件：包括"明显过期"的时间戳目录和"明显冗余"的副本（guardrail 第 8 条）。
- 不强制子目录结构：`data/` 内部怎么组织是用户自由，本技能只管根目录九件套。
- 不做备份：工作区约定降低混乱风险，但不替代备份策略；提醒用户重要工作区应有独立备份（本技能不实现）。
- 不管理 Git：工作区是否纳入版本控制、哪些目录进 .gitignore（通常 data/ 与 output/ 的历史目录不进）由用户决定，本技能被问到时可以给建议但不代执行。

## 收尾与下一步

- `init` 后：引导用户运行 `cold-start-interview`（画像未完成时）或直接进入 `research-lifecycle`。
- `check` 发现问题时：逐项给出修复建议并等待用户选择；修复动作（建目录、同步 latest）经用户同意后执行，删除类动作一律只建议不执行。
- 向用户说明契约的日常收益："以后任何 skill 的产物都去 `output/<skill>/<slug>/latest/` 找，历史版本在同名时间戳目录里，永远不用担心被覆盖。"
