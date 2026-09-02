---
name: r-analysis
description: >-
  当用户使用 R 做统计分析、流行病学建模、生物信息分析、ggplot 作图，说"用 R 跑一下""写个 R 脚本""rmarkdown 出报告""quarto 渲染""R 环境怎么管"时使用。本技能规定本地 R 分析的统一操作规程：renv 锁定依赖环境、脚本化非交互执行（Rscript 一条命令跑完）、sessionInfo() 必须记录进 provenance、rmarkdown/quarto 作为报告产物、产物落盘 output/<skill>/<slug>/latest/ 并与 record_run 集成。同义触发场景：R 分析、R 脚本、tidyverse、ggplot、RStudio、knitr、renv、R 统计。
argument-hint: '[分析任务描述]'
metadata:
  domains: [compute]
  last_reviewed: '2026-08-18'
---

# r-analysis：R 分析规程

## 目的

R 在统计与生物医学领域不可替代，但 R 工作流有两个经典的复现陷阱：包版本全局漂移（半年前能跑的脚本今天报错）和 RStudio 交互式执行（结果依赖"先点了哪个单元格"）。本技能把每一次 R 分析约束为可复现的最小闭环：

1. 环境可重建：renv 锁文件固定全部包版本；
2. 执行可重放：脚本化非交互，`Rscript` 一条命令从头跑到尾；
3. 环境可审计：`sessionInfo()` 输出必进 provenance 记录；
4. 产物可定位：报告走 rmarkdown/quarto 渲染，统一落盘 output 契约。

本技能与 python-analysis 平行：同一套目录契约、同一套 provenance 集成，差异只在 R 生态的工具链。不涉及远程执行（远程见 remote-compute / hpc-slurm）。

## 前置检查

1. 确认当前目录是工作区根目录（结构约定见 research-workspace）；本技能的产物 skill 名为 `r-analysis`。
2. 确认原始数据已在 `data/` 下且只读；R 里读数据一律用相对路径（`here::here("data", ...)` 或直接相对路径），不写绝对路径。
3. 检查项目根是否已有 `renv.lock`：有则用现有环境，不要另起炉灶；没有则按第 1 节初始化。
4. RStudio 用户注意：本技能要求的交付形态是"命令行可重放"，RStudio 里逐行运行可以用于探索，但进入产物的分析必须落成脚本。

## 1 · 环境：renv 锁定

首次建立环境：

```r
install.packages("renv")   # 仅此一个包装进全局库
renv::init()               # 生成 renv.lock、renv/ 与 .Rprofile
```

日常纪律：

1. 新装包用 `renv::install("包名")`，装完立即 `renv::snapshot()` 更新 `renv.lock`；
2. 换机器或重建环境时 `renv::restore()`，严格按锁文件还原，不"顺手升级"；
3. `renv.lock` 是产物的一部分，纳入版本管理与证据胶囊；`renv/` 目录本身不进版本控制（renv 默认 .gitignore 已处理）；
4. 升级包是有意决策：`renv::update()` 后重跑全部分析并登记新 provenance，不在论文冻结（evidence-capsule）之后升级。

## 2 · 随机种子与脚本化执行

1. 脚本开头固定种子：`set.seed(42)`；涉及并行或特定 RNG 时显式指定 `RNGkind` 并写进注释与 provenance note。
2. 交付形态是非交互脚本：`Rscript scripts/analyze-xxx.R` 一条命令跑完，无 `readline()`、无依赖编辑器状态。
3. 脚本放 `scripts/`，kebab-case 命名；参数集中在脚本顶部常量或 `commandArgs` 解析。
4. 种子值、R 版本、关键包版本写进 record_run 的 `--note`。

## 3 · sessionInfo() 必记录

R 的环境指纹是 `sessionInfo()`，等价于 Python 侧的 env_hash，必须留痕：

1. 每个分析脚本末尾输出会话信息到产物目录：

   ```r
   sink(file.path(out_dir, "session-info.txt"))
   print(sessionInfo())
   sink()
   ```

2. 登记 provenance 时把该文件一并作为产物路径，note 中摘要 R 版本与关键包版本：

   ```bash
   python <插件包路径>/skills/provenance-record/scripts/record_run.py \
     --path output/r-analysis/<slug>/latest/ \
     --tool "Rscript scripts/analyze-survival.R" \
     --note "生存分析，seed=42，R 4.4.1，survival 3.7-0，详见 session-info.txt"
   ```

3. 远程 R 任务同样抓回 session-info.txt 再登记（见 provenance-record 的远程一节）。

## 4 · 数据与产物

1. 原始数据只读：从 `data/` 读，永不写回；清洗产物另存（中间产物进 `output/r-analysis/<slug>/<timestamp>/`，复用数据集进 `derived/`），纠错走增补（research-workspace 只读原则）。
2. 落盘契约与其他分析 skill 一致：

   ```text
   output/r-analysis/<slug>/<timestamp>/   # 本次运行全部产物
   output/r-analysis/<slug>/latest/        # 运行结束后的完整副本
   ```

3. 图表双格式 300 dpi（与 python-analysis 相同约定）：

   ```r
   ggsave(file.path(out_dir, "km-curve.png"), p, dpi = 300, width = 6, height = 4)
   ggsave(file.path(out_dir, "km-curve.pdf"), p, width = 6, height = 4)
   ```

4. 统计结果（系数表、检验结果）同时落机器可读文件（CSV），报告数字须能指回该文件。

## 5 · 报告：rmarkdown / quarto

1. 给人看的报告用 rmarkdown（.Rmd）或 quarto（.qmd）撰写，渲染产物（HTML/PDF/DOCX）放进同一次运行的时间戳目录。
2. 报告中的数字尽量由代码内联生成（`` `r knitr::inline_expr(...)` `` / quarto 的 `{r}` 行内表达式），减少手抄数字；必须手抄时，对照产物 CSV 逐个核对。
3. 渲染命令同样脚本化（如 `Rscript -e "quarto::quarto_render('reports/xxx.qmd')"`），不用 RStudio 的 Knit 按钮作为唯一渲染途径。
4. 报告交付前可复用 python-analysis 的 `stats_integrity_check.py` 做数字体检（百分比、p 值、样本量、CI 的确定性检查），error 清零方可交付。

## 6 · 完整示例

一次 analysis 阶段的 R 分析闭环（虚构示例，slug 为 `3f9a1c7e`）：

```bash
# 1. 环境（首次）：R 内执行 renv::init()，之后每次分析前 renv::restore()
# 2. 跑分析脚本（非交互，一条命令）
Rscript scripts/analyze-survival.R
#    脚本内部：set.seed(42)；读 data/2026-08-cohort/；
#    产物写 output/r-analysis/3f9a1c7e/20260819-153000/（含 session-info.txt）

# 3. 渲染报告（同样脚本化）
Rscript -e "quarto::quarto_render('reports/survival-2026-08.qmd')"

# 4. 刷新 latest（先清空再放副本），然后登记 provenance
python <插件包路径>/skills/provenance-record/scripts/record_run.py \
  --path output/r-analysis/3f9a1c7e/latest/ \
  --tool "Rscript scripts/analyze-survival.R" \
  --session cli-2026-08-19-01 \
  --note "KM + Cox 分析，seed=42，R 4.4.1，survival 3.7-0，详见 session-info.txt"

# 5. 报告数字体检
python <插件路径>/skills/python-analysis/scripts/stats_integrity_check.py \
  --path reports/survival-2026-08.md --format json
```

每一步都可单独重跑：环境坏了重 `renv::restore()`，结果存疑重跑第 2 步（同种子应得同结果），报告改版只重跑第 3 步。这条链路上任何一环不可重放，都说明前面的规程有缺口，先补规程再继续。

## 输出模板

分析完成后的汇报：

```markdown
## R 分析完成（<任务名>）

- 环境：renv（renv.lock 已 snapshot），R <版本>
- 种子：set.seed(<N>)（已登记）
- 产物：output/r-analysis/<slug>/latest/（清单：…；含 session-info.txt）
- 报告：<渲染产物路径>
- provenance：已登记（note：…）

下一步：…
```

## 本技能不做什么

- 不替用户选统计模型与检验方法：模型适用性是领域判断，必要时标注 `[模型知识—待核实]` 并请用户确认。
- 不管理全局 R 安装：安装 R 本身、Rtools、系统库依赖向用户说明后由用户执行。
- 不动原始数据：清洗纠错一律生成新文件（research-workspace 只读原则）。
- 不覆盖 Python 生态：Python 分析走 python-analysis；混合项目两边产物分目录登记，互不混用 skill 名。
- 不做远程提交：集群上的 R 作业按 hpc-slurm 规程封装，本技能只管本地规程。

## 收尾与下一步

- 交付前清单：latest/ 已刷新、session-info.txt 在产物内、provenance 已登记、数字体检 error 清零。
- 结论支撑论文论断时进入 evidence-capsule 冻结（renv.lock + session-info.txt 一并打包）。
- 报告按 reviewer-protocol 接受发布前审查；error 级意见清零后交付。
- 任务运行时间长时改用 run-monitor 后台执行（`Rscript` 同样适用），会话不空等。
