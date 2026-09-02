---
name: hpc-slurm
description: >-
  当用户需要向 Slurm 集群提交计算作业，说"提交集群任务""写个 sbatch 脚本""作业还在排队吗""批量跑一组参数""作业超时被杀了""GPU 作业怎么交"时使用。本技能规定 Slurm 集群的统一操作规程：sbatch 脚本模板（分区/时长/内存/GPU 指令 + set -euo pipefail + 环境导出 + 结束自动 rsync 产物）、squeue/sacct 状态查询口径、数组任务批量提交、超时与重排队策略、产物抓回与 record_run 登记。同义触发场景：Slurm、HPC、集群、超算、排队、批处理、job array、机时。连接与主机认知纪律沿用 remote-compute（别名、画像合同），本技能只规定作业生命周期。
argument-hint: '[作业描述或作业号]'
metadata:
  domains: [compute]
  last_reviewed: '2026-08-19'
---

# hpc-slurm：Slurm 集群作业规程

## 目的

Slurm 集群的算力是排队共享的：脚本写错浪费机时，资源虚报挤占同门队列，作业跑完不抓回等于没跑。本技能规定作业生命周期的五个环节：

1. 提交前：脚本模板化，资源申请有依据；
2. 队列中：状态查询口径统一，不盲目刷屏；
3. 批量时：数组任务替代循环提交；
4. 异常时：超时与失败有明确的重排队策略；
5. 完成后：产物自动 rsync 抓回 + record_run 登记。

**前置约束**：连接一律走 remote-compute 的别名与 ControlMaster 纪律；目标主机的分区、GPU、配额信息以 `.openscience/hosts/<alias>.yaml` 画像为准——画像没有的信息（如分区名）先探测（`sinfo`）再写进脚本，不臆造。

## 前置检查

1. 画像 `scheduler: slurm` 已确认；画像缺失或过期时先按 remote-compute 第 2 节探测。
2. 查可用分区与节点：`ssh <alias> 'sinfo -o "%P %a %l %D %N"'`，把目标分区、单作业时长上限写进画像 notes。
3. 提交计算作业消耗机时与队列资源，属 guardrail 第 8 条危险操作：**首次提交前向用户说明作业规模（核数、时长、分区、预计机时）并获得确认**；数组任务说明总任务数。
4. 数据与代码已同步到远程（rsync 上传），脚本内路径全部是远程路径。

## 1 · sbatch 脚本模板

作业脚本放本地 `scripts/slurm/<job-name>.sbatch`（纳入工作区管理），模板：

```bash
#!/bin/bash
#SBATCH --job-name=cycle-fit        # 短而可读，squeue 里认得出
#SBATCH --partition=gpu             # 以画像/sinfo 为准，不臆造分区名
#SBATCH --time=08:00:00             # 预留 20-50% 余量，不写分区上限
#SBATCH --mem=32G
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:1                # 无 GPU 作业删掉此行；型号需求以画像 gpu_summary 为准
#SBATCH --output=%x-%j.out          # <job-name>-<jobid>.out，便于归档
#SBATCH --error=%x-%j.err

set -euo pipefail                   # 任何命令失败立即终止作业，不带着错误继续跑

# ---- 环境导出（三选一，与画像 notes 中该集群的习惯一致）----
# module load cuda/12.2 anaconda/2024.02 && source activate myenv
# source "$HOME/.venv/bin/activate"
export PYTHONUNBUFFERED=1           # 日志实时可见，便于中途检查

# ---- 任务本体 ----
JOB_DIR="$HOME/runs/${SLURM_JOB_NAME}-${SLURM_JOB_ID}"
mkdir -p "$JOB_DIR"
cd "$JOB_DIR"
python3 "$HOME/code/analyze_cycle.py" --seed 42 --out "$JOB_DIR"

# ---- 结束自动 rsync 产物回本地工作区 ----
# 仅在登录节点可反向访问本地时可用；多数集群不通，改用完成后手动抓回（第 5 节）
rsync -avz "$JOB_DIR/" "<local-alias>:<工作区路径>/results/${SLURM_JOB_NAME}-${SLURM_JOB_ID}/" \
  || echo "WARN: auto rsync failed, fetch manually" >&2

echo "JOB_DONE $(date -Is)"
```

模板纪律：

1. `set -euo pipefail` 不可省：没有它，中间步骤失败后作业继续跑，产出半截结果还显示"完成"。
2. 资源申请按画像与实际需求填，不虚报（虚报挤占队列、拖长全组排队），也不少报（OOM/超时被杀浪费机时）。
3. 产物目录名带 `${SLURM_JOB_ID}`，同一脚本多次提交互不覆盖。
4. 环境导出让作业自包含：不依赖登录节点的交互式 shell 状态。

## 2 · 状态查询：squeue / sacct

统一口径，避免凭印象判断：

```bash
ssh <alias> 'squeue -u $USER'                      # 在队作业：R=运行 PD=排队
ssh <alias> 'sacct -j <jobid> --format=JobID,JobName,State,Elapsed,MaxRSS,ExitCode'
```

解读要点：

1. `PD`（排队）看 `squeue` 的 `NODELIST(REASON)`：`Resources`/`Priority` 是正常排队；`ReqNodeNotAvail` 等多为资源请求超分区配置，应改脚本而不是干等。
2. 作业结束后一律 `sacct` 确认 `State` 与 `ExitCode`：`COMPLETED` + `0:0` 才算成功；`TIMEOUT`/`OUT_OF_MEMORY` 按第 4 节处理。
3. 不轮询刷屏：查询间隔不低于分钟级；长作业用 run-monitor 思路"提交后离开，定期回来查"，不让人机空等。

## 3 · 批量作业：数组任务

同脚本多参数（多 seed、多数据分片）一律用 job array，禁止 for 循环逐条 sbatch：

```bash
#SBATCH --array=0-99%10            # 100 个任务，最多同时 10 个（%10 限制并发，别挤爆队列）

python3 "$HOME/code/analyze.py" --seed "$SLURM_ARRAY_TASK_ID" \
    --out "$HOME/runs/${SLURM_JOB_NAME}-${SLURM_ARRAY_JOB_ID}/task-${SLURM_ARRAY_TASK_ID}"
```

纪律：

1. 每个数组元素产物独立目录（带 task id），互不覆盖；
2. 首次跑大批量前先用 `--array=0-2` 小规模试跑，确认单任务资源估算正确，再提交全量；
3. 抓回时按 `${SLURM_ARRAY_JOB_ID}` 整目录 rsync，record_run 一条登记、note 写数组范围与失败元素。

## 4 · 超时与重排队策略

1. **TIMEOUT**：先查日志判断是"差一步"还是"差很远"。差一步：加大 `--time` 重交；差很远：检查是否有死循环或规模估计错误，修复后重交。同一作业连续两次 TIMEOUT 不得原样重交，必须先改东西。
2. **OUT_OF_MEMORY**：按 `sacct` 的 `MaxRSS` 实测值上调 `--mem`（留 20% 余量）重交。
3. **FAILED（非零退出）**：读 `.err` 定位，修复后重交；失败作业同样登记 provenance（paths 指向抓回的日志）。
4. **可断点续算的任务**：脚本内支持 checkpoint（存在则续跑），超时重交即自动续算；长任务优先设计成可续算的。
5. 重排队是新的资源消耗：批量重交前向用户说明失败原因与新增机时。

## 5 · 产物抓回与 record_run

自动 rsync（模板末尾）不通时，完成后手动抓回：

```bash
rsync -avz <alias>:~/runs/<job-name>-<jobid>/ results/<job-name>-<jobid>/
python <插件包路径>/skills/provenance-record/scripts/record_run.py \
  --path results/<job-name>-<jobid>/ \
  --tool "slurm job <jobid> (<job-name>.sbatch)" \
  --note "分区 <p>，8 核 32G 1×GPU，实际耗时 <Elapsed>，ExitCode 0:0，节点 <NodeList>"
```

不记录的运行等于不存在：note 里作业号、sacct 的 Elapsed/ExitCode/NodeList 缺一不可；远程环境版本（`module list` 摘要）有条件就附在 note 或抓回的日志里。

## 6 · 经 run_task 登记 Slurm 作业

sbatch 提交成功、拿到 jobid 后，立即把"盯这个作业"登记成一个本地 Run——用 run-monitor 的 Run 抽象统一管理本地与远程长任务：Run 只记录"任务叫什么、怎么查状态、查到了什么"，不关心任务跑在本机还是集群：

```bash
python <插件包路径>/skills/run-monitor/scripts/run_task.py \
  start --name <job-name>-<jobid> \
  --tag slurm --tag <cluster> \
  --cmd "ssh <alias> 'sacct -j <jobid> --format=State -n | head -1'"
```

模式说明：

1. **登记即交还**：start 把这条状态查询命令放到后台执行并立即返回，会话不空等；run.json 的 cmd 字段留下"当时用哪条命令查的"，口径与第 2 节一致，tags 与 note 一并落盘。
2. **轮询即重跑**：想看最新状态时同名再 start 一次（已 exited 的 run 允许被新 start 覆盖，日志随之重写），然后 `tail` 看这次查到的 State；查询间隔不低于分钟级的纪律不变，不写忙等循环。
3. **tags 即检索口径**：`--tag slurm --tag <cluster>` 让 `run_task list` 把集群作业与本地任务一眼分开；多集群、多作业并发时按 tag 认作业，不靠记忆。补充背景（分区、资源、预计时长）用 `--note` 写一句。
4. **终态与抓回纪律不变**：sacct 显示 COMPLETED/FAILED/TIMEOUT 后，产物抓回与 record_run 登记仍按第 5 节执行，一个字不改；Run 替代的是"人机空等"，不替代 provenance。

## 输出模板

```markdown
## Slurm 作业已提交（<job-name> @ <alias>）

- jobid：<id>，分区：<p>，资源：<核/内存/GPU/时长>
- 预计排队：<squeue 观察>；查询：ssh <alias> 'squeue -j <id>'
- 完成后：自动 rsync 至 results/<job-name>-<id>/ 或按第 5 节手动抓回 + record_run
```

## 本技能不做什么

- 不探测主机与管连接：别名、ControlMaster、画像合同、失败分支一律沿用 remote-compute，本文件不重复。
- 不保证队列策略最优：分区选择、机时估计给建议，最终以用户所在集群的实际规定（画像 notes）为准。
- 不自动 kill 作业：`scancel` 只建议不执行，除非用户当场明确确认（影响共享队列状态）。
- 不管非 Slurm 调度器：PBS/LSF 语法不同，本规程不套用；画像 scheduler 非 slurm 时按 remote-compute 的交互式方案。
- 不替用户盯梢：提交后告知查询命令即交还控制权，长周期作业由用户按节奏回来查（或按第 6 节用 run_task 登记）。

## 收尾与下一步

- 作业成功后：确认 rsync 完成、record_run 已登记、产物按契约归位（latest 刷新）。
- 批量作业：核对数组元素完整性（100 个任务 100 个产物目录），缺的按第 4 节补交。
- 结论进论文前：sbatch 脚本 + sacct 摘要 + 产物一并进 evidence-capsule 冻结。
- 作业失败：登记失败记录后诊断，诊断结论写进下一条 provenance note，形成可追溯的试错链。
