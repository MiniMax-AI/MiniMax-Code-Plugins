---
name: run-monitor
description: >-
  当用户有耗时较长的本地任务需要后台执行，说"后台跑一下""这个任务要跑很久""帮我盯着这个任务""任务跑完了吗""看看日志"时使用。本技能定义长任务 Run 抽象（核心设计：不让人机等任务、轮询不耗 token）：run 目录 runs/<run_id>/{run.json, stdout.log, stderr.log}，run.json 记录 {id, cmd, cwd, pid, started, status, exit_code}；配套纯标准库脚本 run_task.py 提供 start（detached 后台启动，Windows/POSIX 跨平台）、status（pid 存活检查 + 退出码）、list、tail 四个子命令。同义触发场景：长任务、后台运行、任务监控、看进度、训练还没跑完、批处理脚本。
argument-hint: '[start|status|list|tail] [任务名]'
metadata:
  domains: [compute]
  last_reviewed: '2026-08-19'
---

# run-monitor：长任务 Run 管理

## 目的

本地长任务（模型训练、大批量数据处理、长时间仿真）最容易犯两个错：让人机会话**空等**任务结束（浪费上下文与时间），或者反复"看看好了没"**轮询刷屏**（每次都把日志灌进对话）。本技能的 Run 抽象解决这两点：

1. 任务以 detached 子进程后台运行，启动后立即交还控制权——**不让人机等任务**；
2. 状态落在磁盘文件（run.json + 日志）里，查询时只读摘要——**轮询不耗 token**；
3. 状态机只有三态：`running | exited | failed`，配合退出码，一眼可判。

本技能配套纯标准库脚本 `scripts/run_task.py`（Windows/POSIX 跨平台），任何能跑 Python 3 的机器都能用。远程任务的管理见 remote-compute / hpc-slurm，本技能只管本地进程。

## 前置检查

1. 确认当前目录是工作区根目录：run 目录固定为 `./runs/<run_id>/`，换目录启动等于另一套记录。
2. 确认任务本身可以在非交互 shell 里跑通（先手动试跑一条短命令验证命令行正确），不要拿没验证过的命令直接后台化。
3. run_id 命名 kebab-case（字母数字与 `-_.`），同一时刻同名 run 只能有一个在 running。
4. 评估任务时长：秒级任务直接同步跑完即可，不必后台化；分钟级以上的任务才值得 start——Run 抽象的收益是"不等任务"，短任务没有等待可省。
5. 确认命令的产物路径写在命令本身里（如 `--out output/...`）：后台任务脱离会话上下文，事后靠 run.json 的 cmd 字段追溯"它当时往哪写"，路径不明的命令先补参数再启动。

## 与各 skill 的分工

- python-analysis / r-analysis：分析规程本身；耗时超阈值时把执行环节交给本技能后台化。
- remote-compute / hpc-slurm：远程与集群任务的提交、抓回与登记；本技能只管**本地**进程，runs/ 不出本机（用本地 Run 登记 Slurm 作业状态查询的模式见 hpc-slurm 第 6 节）。
- provenance-record：Run 只管进程状态，产物来源登记统一走 record_run，两者互补不替代。

## Run 目录与 run.json schema

```text
runs/
└── <run_id>/
    ├── run.json      # 状态文件（唯一事实来源）
    ├── stdout.log    # 标准输出（每次 start 截断重写）
    └── stderr.log    # 标准错误
```

run.json 字段如下（`tags`、`note` 仅在 start 带 `--tag`/`--note` 时写入）：

| 字段 | 含义 |
| --- | --- |
| id | run 名（即目录名） |
| cmd | 执行的命令行 |
| cwd | 启动时的工作目录 |
| pid | 后台进程 pid（用于存活检查） |
| started | 启动时间，ISO 8601 带时区 |
| status | `running` / `exited`（退出码 0）/ `failed`（非零或被强杀） |
| exit_code | 退出码；running 或异常死亡时为 null |
| tags | 可选：`--tag` 重复给出的标签数组（如 `["slurm", "gpu01"]`），`list` 输出含 TAGS 列 |
| note | 可选：`--note` 给的自由文本备注 |

## 1 · start：后台启动

```bash
python <插件包路径>/skills/run-monitor/scripts/run_task.py \
  start --name cycle-fit --cmd "python scripts/analyze_cycle.py --seed 42"
```

- 启动方式跨平台 detached：POSIX 用 `start_new_session=True`（脱离控制终端），Windows 用 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`；stdout/stderr 重定向到日志文件。
- 启动成功后立即返回 pid 与 run 目录，**会话继续干别的，不要原地 sleep 等待**。
- 同名 run 仍在 running 时拒绝重复启动（防止双跑写乱产物）；已结束的同名 run 可被新 start 覆盖（日志随之重写）。
- `--tag`（可重复）与 `--note` 把标签与备注写进 run.json：跨项目、跨机器筛选用 tag（如 `--tag slurm --tag gpu01`，登记远程作业的模式见 hpc-slurm 第 6 节），背景说明用 note。

## 2 · status / list / tail：轻量查询

```bash
python <插件包路径>/.../run_task.py status --name cycle-fit   # 单个 run 的状态
python <插件包路径>/.../run_task.py list                       # 全部 run 一览
python <插件包路径>/.../run_task.py tail --name cycle-fit --lines 20
```

- status 的判定：run.json 已记录终态则直接采信；仍为 running 时做 pid 存活检查（POSIX `os.kill(pid, 0)`，Windows `OpenProcess` + `GetExitCodeProcess`），pid 已死但没落终态（被强杀）则判 `failed`。
- 查询结果只把**摘要**带进对话；需要看日志细节时用 `tail --lines N` 取末尾 N 行，不要整份 cat 进对话（日志可能上万行）。
- 建议的查看节奏：任务启动后先交还控制权，用户问起或自然节点（如下一步依赖其结果）时再 status 一次；不写忙等循环。

## 3 · 任务结束后

1. status 为 `exited`：确认产物符合预期，按产物性质归位（`output/<skill>/<slug>/` 契约），然后 record_run 登记，note 写 run_id、cmd、时长；
2. status 为 `failed`：tail stderr.log 定位原因，失败也要登记 provenance（paths 指向日志，note 写失败摘要）——失败的运行同样是研究历史；
3. 任务产物已被后续步骤引用后，run 目录可以保留作为执行痕迹；清理 runs/ 是用户的决定，skill 不自动删。

## 4 · 边界情形

1. **pid 复用**：进程退出后 pid 可能被系统回收复用，status 的 pid 检查在极端情况下会碰到"同名 pid 的无关进程"。run.json 已落终态时永远以文件为准，只有"running 且 pid 活着"才采信存活检查，误判窗口可忽略。
2. **机器重启 / 终端关闭**：detached 进程不依赖启动它的终端，关窗不影响任务；机器重启后残留 run 的 status 会判 failed（见"本技能不做什么"），按失败流程处理。
3. **同名覆盖**：已结束的 run 被同名 start 覆盖时，旧 stdout/stderr 日志随之重写；旧日志还有价值就先复制到产物目录再重启。
4. **日志膨胀**：任务日志可能涨到 GB 级，tail 只读末尾不受影响；磁盘紧张时提醒用户归档旧 run 目录，skill 不做日志轮转。
5. **并发上限**：run_task.py 不限制并发数；同时启动多个重型任务前提醒用户本机核数与内存，超售导致的 OOM 不属于本技能能兜住的范围。

## 5 · 完整示例

一次本地长任务的闭环（虚构示例）：

```bash
# 1. 启动（立即返回，会话不阻塞）
python <插件包路径>/skills/run-monitor/scripts/run_task.py \
  start --name cycle-fit --cmd "python scripts/analyze_cycle.py --seed 42"
#    → started run 'cycle-fit' (pid 37516) -> runs/cycle-fit/

# 2. 交还控制权；过一阵子在自然节点查询
python <插件包路径>/skills/run-monitor/scripts/run_task.py status --name cycle-fit
#    → status: running（继续干别的，不写 sleep 循环）

# 3. 再次查询：status: exited, exit_code: 0
python <插件包路径>/skills/run-monitor/scripts/run_task.py tail --name cycle-fit --lines 10

# 4. 产物归位 + provenance 登记（record_run 的 note 写 run_id 与 cmd）
python <插件包路径>/skills/provenance-record/scripts/record_run.py \
  --path output/python-analysis/<slug>/latest/ \
  --tool "run cycle-fit: python scripts/analyze_cycle.py --seed 42" \
  --note "run-monitor 后台执行，runs/cycle-fit/，exit 0"
```

失败时第 3 步显示 `status: failed, exit_code: <n>`，第 4 步的登记照常进行，paths 指向 `runs/cycle-fit/stderr.log`，note 写失败摘要——失败同样是研究历史。

## 输出模板

```markdown
## 后台任务已启动

- run_id：<name>（pid <pid>）
- 状态文件：runs/<name>/run.json；日志：runs/<name>/{stdout,stderr}.log
- 查询：run_task.py status --name <name>（结束时我再查，或随时问我）
```

```markdown
## 任务 <name> 已结束（<status>，exit_code=<n>）

- 关键输出：<tail 摘要，一两行>
- 产物归位：<路径>；provenance：已登记（note：…）
```

## 本技能不做什么

- 不做进程调度与资源控制：没有优先级、没有 CPU/内存限额、没有自动重启——它只是"后台跑 + 记状态"，不是作业调度器。
- 不做跨机管理：runs/ 是本地目录，远程任务按 remote-compute / hpc-slurm 的纪律抓回与登记。
- 不杀进程：需要取消任务时向用户报告 pid 由用户处置，skill 不主动 kill（guardrail 第 8 条精神）。
- 不持久化守护：机器重启后 run.json 里的 pid 失效，status 会把残留的 running 判为 failed，这是预期行为而非 bug。
- 不替代 provenance：run.json 记"进程状态"，record_run 记"产物来源"，任务结束必须走 provenance 登记才算闭环。

## 收尾与下一步

- 任务 exited：归位产物 → record_run → 刷新 latest（如适用）→ 汇报用户。
- 任务 failed：读日志 → 向用户报告失败摘要与建议 → 修复后可同名重新 start（旧日志被覆盖前如需要，先复制留存）。
- 多个长任务并发时，用 `list` 一览全局；任务多到一个屏幕放不下时，说明该上集群了——转 hpc-slurm。
