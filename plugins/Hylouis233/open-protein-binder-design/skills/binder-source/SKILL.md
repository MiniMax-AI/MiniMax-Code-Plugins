---
name: binder-source
description: >-
  当需要登记、查看、锁定或按白名单下载 binder 数据源文件时使用；对应 openbinder source list/inspect/lock/download 四个子命令。典型触发语："看看 anthropic-claude-binder-v1 这个源""inspect 一下远端文件列表""把源锁定到当前 revision""下载那个 README 小文件"。同义场景：数据源注册、source registry、pin revision、source.lock.json、下载白名单、download policy、blocked 文件、源不可用怎么办。
argument-hint: '[list|inspect <source_id>|lock <source_id>|download <source_id> <path>]'
metadata:
  domains: [protein-binder, data-source, provenance]
  last_reviewed: '2026-08-23'
---

# binder-source：数据源登记与白名单下载

## 目的

binder campaign 的一切分析都从"数据从哪来、锁在哪个版本、哪些文件允许落地"开始。本技能把这条纪律固化下来：源以 YAML manifest 登记在 `sources/`（名称、HF 仓库、pinned revision、license、attribution、下载策略），远端文件列表只读 inspect，revision 用 lock 钉死，下载只放行白名单内的小文件。它保证后续 replay / audit 引用的每一个字节都能回溯到一个 pinned revision 和一条 provenance 记录。

## 前置检查

1. 确认 `openbinder` CLI 已按本插件 README 的 pinned release 安装：`pip install "openbinder @ git+https://github.com/Hylouis233/open-protein-binder-design@v0.1.1"`，随后确认 `openbinder --help` 可用（或 `python -m openbinder`）。不要在 MiniMax Plugin 目录执行 `pip install -e ".[dev]"`；该目录不是 `openbinder` 的 Python source checkout。
2. 确认源已登记：`openbinder source list` 应列出目标 source_id（当前为 `anthropic-claude-binder-v1`）。未登记的源不能靠猜名字使用。
3. `inspect` / `lock` / `download` 需要网络访问 Hugging Face；离线环境下它们会以结构化错误失败（exit 2），这不是 bug，不得把失败当成"源不存在"。只有 `source list` 是纯本地的。
4. 产物落盘目录遵循 `output/binder-source/<slug>/<timestamp>/`；slug 由项目名确定，timestamp 每次运行一个。

## 1 · 查看与检查（list / inspect）

```bash
openbinder source list
openbinder source inspect anthropic-claude-binder-v1 --json
```

- `inspect` 是只读操作：列出 pinned revision 下的远端文件清单与字节估计，不下载任何内容。
- 注意 `size_unknown` 计数：大小未知的文件在下载策略里一律被拦（见下），inspect 时就要看清哪些文件后续不可下载。

## 2 · 锁定 revision（lock）

```bash
openbinder source lock anthropic-claude-binder-v1 --out source.lock.json
```

- 把当前远端 revision 钉进 `source.lock.json`，并写入 provenance；此后所有引用都以该 revision 为准。
- 发布方还在上传时（当前现状：`data/tables/`、`data/docs/`、`data/manifests/` 在 pinned revision 不存在），lock 到的就是不完整的版本——如实记录，等上传完成后重新 lock，绝不用旧 revision 冒充完整版。

## 3 · 白名单下载（download）

```bash
openbinder source download anthropic-claude-binder-v1 data/README.md --dest output/binder-source/<slug>/<timestamp>/
```

下载策略（deny-by-default，定义在源 manifest 的 `download_policy`）：

- 只放行 `allowed_files` 白名单（精确路径 + fnmatch 模式）内的文件；
- `blocked_patterns`（`*.pdb`、`*.pae*`、`*sensorgram*`、weights 等）在任何情况下不可下载；
- 单文件 ≤ 20 MB、会话累计 ≤ 50 MB、大小未知的文件一律拒绝；
- 违反任何一条返回结构化 `blocked` 错误（exit 2），包含被拒原因——**永不静默绕过**，也不得建议用户改策略绕过去；
- 每一笔实际下载都带字节数登记进 `.openscience/provenance.jsonl`（7 字段契约；该文件由 openbinder CLI 自行写入，未安装 openscience 插件也会照常登记）。

## 4 · 失败语义（必须原样转述给用户）

- `blocked`：策略拒绝，是**纪律生效**，不是故障；报告被拒的文件与规则。
- `unavailable` / 网络失败：源当前不可达或文件在 pinned revision 不存在，是 **source gap**，报告为 unavailable，**绝不当作阴性结果**（"没下到" ≠ "没有"）。
- 未知 source_id：exit 2 并列出已登记的源，不猜测。

## 输出模板

```markdown
## 数据源操作结果：<source_id>

- 操作：list / inspect / lock / download
- revision：<pinned revision 或 unresolved>
- 落地文件：<路径 + 字节数>（无下载则写"未下载任何文件"）
- 策略拦截：<被 blocked 的文件与原因；无则写"无">
- provenance：`.openscience/provenance.jsonl` 已登记 / 未产生写操作
- 风险与缺口：<如 tables 仍 unavailable、N 个文件大小未知不可下载>
```

## 本技能不做什么

- 不批量下载：不做数据集克隆、不碰 PDB/PAE/sensorgram 原始档案，白名单之外一律拒绝。
- 不修改源 manifest 来"方便"下载：策略变更是仓库级决策，不在技能执行中顺手改。
- 不把下载失败解释成数据不存在：failed lookup 是 source gap，不是阴性。
- 不登记假 provenance：没有实际发生的下载不写字节数记录。

## 收尾与下一步

- 向用户报告 revision、落地文件、被拦截项与缺口；提示 tables 类内容当前 unavailable 时，说明"等发布方完成上传后重新 `source lock`"。
- 下一步通常是 binder-protocol（把协议草稿编译成结构化 protocol）或 binder-replay（基于已锁定源回放 campaign）。
