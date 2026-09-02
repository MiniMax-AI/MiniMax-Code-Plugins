---
name: python-analysis
description: >-
  当用户使用 Python 做科研数据分析、统计建模、机器学习实验或批量数据处理，说"用 Python 跑一下分析""做个统计""清洗数据""画结果图""跑个脚本"时使用。本技能规定本地 Python 分析的统一操作规程：环境优先 uv/venv 隔离、依赖写入 requirements.txt 并通过 record_run 记录环境指纹、随机种子固定并登记、原始数据只读（清洗另存新文件）、产物落盘 output/<skill>/<slug>/latest/、图表 PNG+PDF 双格式 300dpi，并附 stats_integrity_check.py 对报告数字做确定性体检。同义触发场景：Python 分析、跑数据、统计分析、数据处理、画图、pandas、matplotlib、分析环境怎么配。
argument-hint: '[分析任务描述]'
metadata:
  domains: [compute]
  last_reviewed: '2026-08-18'
---

# python-analysis：Python 分析规程

## 目的

Python 是科研计算的主力工具，也是"跑过一次就复现不出来"的重灾区：依赖版本漂移、随机种子没固定、原始数据被顺手改掉、图只存了屏幕截图。本技能把每一次本地 Python 分析约束为可复现的最小闭环：

1. 环境可重建：隔离环境 + requirements.txt + 环境指纹进 provenance；
2. 结果可复算：随机种子固定并写进记录；
3. 数据可追溯：原始数据只读，清洗产物另存；
4. 产物可定位：统一落盘 `output/<skill>/<slug>/`，图表双格式；
5. 报告数字可机检：交付前过一遍 `stats_integrity_check.py`。

本技能只规定规程，不规定具体算法；算法选择由研究问题决定（必要时标注 `[模型知识—待核实]` 并与用户确认）。

## 前置检查

1. 确认当前目录是工作区根目录（结构约定见 research-workspace）；产物路径契约 `output/<skill>/<slug>/latest/` 在这里同样适用，本技能的 `<skill>` 名即 `python-analysis`（用户自建脚本的分析产物可用 `analysis` 作为 skill 名，保持与既有产物一致即可）。
2. 确认原始数据已在 `data/` 下且按只读原则管理；数据还没就位时先停下来请用户放数据，不要用"示例数据"冒充真实数据跑分析。
3. 检查是否已有可用环境：项目根存在 `.venv/` 或 `requirements.txt` 时优先复用，不要每次分析都新建环境。
4. 涉及人体、患者、涉密数据的分析，先对照画像"伦理与数据合规要求"一节：红线数据不得离开规定机器，更不得上传到第三方在线工具（guardrail 第 8 条）。

## 1 · 环境：优先 uv，其次 venv

按以下优先级选择环境管理工具：

1. **uv**（已安装时）：`uv venv` 创建 `.venv/`，`uv pip install -r requirements.txt` 安装依赖。速度快、锁文件友好。
2. **venv + pip**（uv 不可用时）：`python -m venv .venv`，激活后 `pip install -r requirements.txt`。
3. 不用 conda 新建环境，除非画像"算力环境"一节明确写了 conda——与画像保持一致优先于本规程。

纪律：

- 每个项目一个 `.venv/`，放在工作区根目录；不在系统 Python 里 `pip install` 任何分析依赖。
- 新装依赖后立刻 `pip freeze > requirements.txt`（uv 同理）更新锁定；requirements.txt 是产物的一部分。
- 首次在某环境跑分析时，用 provenance-record 登记一次环境（脚本自动写 `.openscience/env/<hash>.txt`）；此后每次登记的 env_hash 自动关联。

## 2 · 随机种子：固定并登记

1. 脚本开头统一设种子：

   ```python
   import random
   import numpy as np

   SEED = 42
   random.seed(SEED)
   np.random.seed(SEED)
   ```

   用到其他带随机性的库（如 torch、sklearn 的 `random_state`）时，把同一个 SEED 传进去。
2. 种子值写进 record_run 的 `--note`（如 `seed=42`）；换种子重跑视为一次新实验，登记新记录并说明换种子的原因。
3. 不允许"先不固定种子看看效果"——探索性运行同样登记，大不了 note 里写"探索性，未固定种子"，让读者知道这条结果的复现等级。

## 3 · 数据：原始只读，清洗另存

1. 从 `data/` 读，永不写 `data/` 下已存在的文件；任何脚本检测到自己在覆盖 `data/` 文件，立即停止并报告（research-workspace 原始数据只读原则）。
2. 清洗、转换、筛选的产物是新文件：中间产物放 `output/python-analysis/<slug>/<timestamp>/`；需要跨分析复用的清洗后数据集放项目自建的 `derived/`（不存在则创建），并在 README 或 note 里写清由哪份原始数据经哪步处理而来。
3. 数据纠错走增补：发现原始数据有误时新存修正版 + `README-correction.md`，原文件保留。
4. 大文件读取失败（内存不足）时，改用分块（`pandas.read_csv(..., chunksize=...)`）或先抽样探索，不要在报告里假装全量分析过。

## 4 · 分析脚本：可重复执行

1. 脚本放 `scripts/`，命名 kebab-case（如 `analyze-cycle-life.py`）；一次性探索可以用 notebooks/，但进入产物的分析必须落成脚本。
2. 脚本满足"从头跑到尾不交互"：`python scripts/xxx.py` 一条命令完成，不弹 input()、不依赖 notebook 单元格顺序。
3. 参数用 argparse 或脚本顶部常量集中声明；硬编码路径只允许指向工作区内相对路径。
4. 输出目录按时间戳创建（`YYYYMMDD-HHMMSS`），本次全部产物写入其中。

## 5 · 产物落盘与图表规范

1. 目录契约（与 research-workspace 一致）：

   ```text
   output/python-analysis/<slug>/<timestamp>/   # 本次运行全部产物
   output/python-analysis/<slug>/latest/        # 运行结束后的完整副本
   ```

2. 图表一律双格式导出：PNG（预览、贴报告）+ PDF（排版、投稿矢量），均 300 dpi：

   ```python
   fig.savefig(out / "cycle-life.png", dpi=300, bbox_inches="tight")
   fig.savefig(out / "cycle-life.pdf", bbox_inches="tight")
   ```

3. 统计结果（表格、模型参数、p 值）同时落一份机器可读文件（CSV 或 JSON），不要只存在图里或打印在 stdout——报告里的每个数字都应能指回这份文件。
4. 运行结束后刷新 `latest/`（先清空再放副本），然后用 provenance-record 登记：

   ```bash
   python <插件包路径>/skills/provenance-record/scripts/record_run.py \
     --path output/python-analysis/<slug>/latest/ \
     --tool "python scripts/analyze-cycle-life.py" \
     --note "循环寿命分析，seed=42，数据 data/2026-08-cycling/"
   ```

## 6 · 报告数字体检：stats_integrity_check.py

分析结论写进 markdown 报告后、交付前，运行本技能自带脚本做确定性数字检查（纯标准库）：

```bash
python <插件路径>/skills/python-analysis/scripts/stats_integrity_check.py \
  --path reports/<报告>.md --format json
```

检查项：

1. 百分比在 0-100 内；同一行疑似构成组的百分比之和 ≈ 100±0.5；
2. p 值格式（`p<0.001` 或 `p=0.xxx`）与取值在 0-1 内；
3. `N=n` 多次出现时数值一致；
4. 置信区间下界不超过上界。

脚本输出 `{issues: [{check, location, detail, level}]}`，error 级问题修复前不得交付（guardrail 第 7 条）；脚本退出码为 1 表示存在 error 级问题，可接入流水线。脚本是确定性规则，不替代统计判断——它查"数字写得对不对"，不查"数字算得对不对"。

## 输出模板

分析完成后的汇报：

```markdown
## Python 分析完成（<任务名>）

- 环境：.venv/（uv / venv），requirements.txt 已更新，env_hash=<hash>
- 种子：seed=<N>（已登记）
- 产物：output/python-analysis/<slug>/latest/（清单：…）
- 图表：…（PNG+PDF，300dpi）
- 数字体检：stats_integrity_check 通过 / N 条 warn（列出）/ N 条 error（修复中）
- provenance：已登记（note：…）

下一步：…
```

## 本技能不做什么

- 不替用户选统计方法或模型：方法适用性是领域判断，本技能最多提示"该选择需要领域依据"，必要时标注 `[模型知识—待核实]` 并请用户确认。
- 不动原始数据：任何清洗、纠错都生成新文件（research-workspace 只读原则）。
- 不管理远程与集群任务：SSH 远程算力见 remote-compute，Slurm 集群见 hpc-slurm，长任务后台管理见 run-monitor。
- 不保证统计正确性：stats_integrity_check.py 只做格式与一致性机检，显著性解释、多重比较校正等仍需用户与 reviewer 把关。
- 不自动安装系统级软件：装 Python 本身、装 uv 属环境准备，向用户说明后由用户执行。

## 收尾与下一步

- 产物进入报告或论文前：刷新 `latest/`、确认 provenance 登记完整、跑 stats_integrity_check.py 清零 error。
- 分析结论要支撑论文级论断时，进入 evidence-capsule 冻结流程（脚本、环境、数据版本一并打包）。
- 报告交付前按 reviewer-protocol 接受审查；数字类意见（check=number）与本技能体检结果一并处理。
- 分析耗时超过分钟级时，改用 run-monitor 后台运行，不要让人机会话空等任务结束。
