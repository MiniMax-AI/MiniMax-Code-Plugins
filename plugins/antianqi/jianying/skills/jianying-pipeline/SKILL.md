---
name: jianying-pipeline
description: 'Use when: 用户要的是【一件事做完】而不是单一步骤时 / 调完色还要出成片 / 改完草稿顺便审一遍 / 剪完口播再出成片 / 全流程走一遍 / 把这条片子从头做到尾. 触发词: 一站式做完 / 全流程走一遍 / 把整条流程走完 / 改完直接出片 / 顺便也出个片.'
displayNames:
  zh-Hans: 剪映·成片流水线（跨链 · 一份副本走到底）
license: Apache-2.0
compatibility: Requires Windows + 剪映 11.6 在运行（草稿与官方渲染都走本机命名管道）+ ffmpeg 6.0 + Python 3.9+ + JYAI_HOME 指向 JYAI 仓库. ★ 剪口播那条链还需要用户自带转写稿(SRT)——官方 ASR 在 agent runtime 里、拿不到.
metadata:
  author: antianqi
  version: "0.1.0"
  basis: "6 条链各自端到端 + 意图映射表（references/intent-map.json，21 条）+ 跨链共享会话约定（sessionId → 副本目录）"
---

# 剪映成片流水线（jianying-pipeline）

> **一句话定位**：用户要的是**一件事做完**（"调完色再出片"、"剪完口播再出成片"）时，
> 按本手册把 2~3 条链串起来，**共用同一份草稿副本**，每一步都用**语义判据**验收。

> ★ **现在有两条路**：① **模型按本手册一步步调**（灵活）② **`run_pipeline` 动词**（一条命令跑完一条预置路线，路线定义在 `references/pipeline-profiles.json`）。
> 需求只是"按路线走一遍"时用 ②；需要中途改参数/加确认点时用 ①。

> ★ **不确定该走哪条链时**可以先问一句：
> `node ${PLUGIN_ROOT}/scripts/classify-intent.mjs "<用户那句话>"`
> ⇒ 它给出【候选 + 命中词 + 置信度】（数据在 `references/intent-routes.json`），
> 但它只是**检索线索**（准确率由 `references/intent-testset.json` 量着，低于阈值会红）
> ⇒ **拿不准就按各 Skill 的 description 自己判断**，别把它的输出当判决。
>
> ★ **本 skill 只做编排，不做实现**：每一步都落到既有动词上（`draft_*` / `grade_apply` /
> `make_film` / `render_frames` / `verify_diff` / `talk-cut-*`），
> **参数怎么填**看 `references/intent-map.json`（"人话 → 参数"的机器可读版，21 条），
> **判据怎么定**看 `references/verify-discipline.md`。

## 什么时候用本 skill / 什么时候不用

| 用户要的是 | 用谁 |
|---|---|
| **一件事做完**（调完色还要出片 / 改完还要审 / 剪完还要出） | ★ **本 skill** |
| 只要调色出片 | `jianying-cut` |
| 只要改草稿 | `jianying-draft-edit` |
| 只要审片 | `jianying-review` |
| 只要剪口播 | `jianying-talk-cut` |
| 问参数怎么填 / 问验收口径 | `jianying-grade-chain` / `jianying-verify`（库） |

⇒ **单链条的活不要绕本 skill**（多一层编排 = 多一层出错的地方）。

## ★ 三条纪律（别破）

1. **先查缺什么前置** —— 缺前置就别开始，否则会做出黑屏/静音的成片。
   | 前置 | 不满足会怎样 | 怎么办 |
   |---|---|---|
   | **剪映在跑** | 草稿动词与官方渲染全部连不上 | 让用户先开剪映（不必开界面，但进程要在） |
   | **素材在盘上** | 官方渲出黑帧 ⇒ 成片 3 秒只有 3 KB | 先确认草稿里引用的素材路径存在 |
   | **口播链要 SRT** | 官方 ASR 拿不到 ⇒ 没有转写稿就剪不了 | ★ **必须让用户给 SRT**，不要自己编 |
   | **调色参数已知** | 不知道"暖一点"是多少 | 从 `intent-map.json` 查；查不到就按链语义推并**问用户确认** |

2. **一份副本走到底** —— 全流程只用**一个** `draft_open` 的副本。
   ⇒ `draft_open` 返回的 `sessionId`（给 `draft_*` 用）和 `dir`（副本目录，给 `make_film` / `render_frames` 用）
   **要一起往下传**。★ 不要每一步重新 `draft_open`（那会开多份副本，状态对不上）。

3. **每步都要判据** —— "没报错"不等于"生效"。
   ⇒ 改草稿用**语义判据**（`verify_diff` 的 `timeline` + `expect`），
   出片用**内建验收**（`make_film` 的双流/时长/响度断言），
   画面可见才需要像素判据（且**必须带 `noiseDir` 校准**）。

## 意图路由表：综合诉求 → 步骤序列

> ★ **机器可读版**：`references/pipeline-profiles.json`（4 条路线 / 18 个步骤）
> ★ 每一步的动词、参数、变量都由机械审计**按 schema 校验** ⇒ 写错会当场报出来。
> 下面的四条路径是它的人读展开（两边必须一致，审计 7k 会查）。

### 路径 A：调色并出成片（"把这个草稿调暖再出片"）

```bash
# ① 开副本（拿 sessionId + dir，后面两步都用它）
node ${PLUGIN_ROOT}/scripts/run-verb.mjs draft_open '{"draft":"<草稿库>\\<草稿名>","copy":true}'
#    ⇒ 记下返回里的 sessionId（ve-session-N）与 dir（副本目录）

# ② 出成片（画面来自官方渲染器；grade 由我们自己给 ⇒ 曲线类也能用）
#    ★ grade 的参数从 references/intent-map.json 取（"调暖一点" ⇒ adjustColor.temperature 0.15）
node ${PLUGIN_ROOT}/scripts/run-verb.mjs make_film '{
  "draft": "<①返回的 dir>",
  "outDir": "<输出目录>",
  "denoise": "auto",
  "grade": { "adjustColor": { "temperature": 0.15 } }
}'
#    ⇒ make_film 自带验收（双流齐备 + 时长对齐 ±1 帧 + 响度偏离 ≤1 LUFS）⇒ 失败会直接判失败

# ③（可选）画面级对比：原片 vs 成片 ⇒ 必须带 noiseDir 校准
node ${PLUGIN_ROOT}/scripts/run-verb.mjs render_frames '{"draft":"<①的 dir>","outDir":"<原片帧目录>"}'
node ${PLUGIN_ROOT}/scripts/run-verb.mjs verify_diff '{
  "beforeDir": "<原片帧目录>/frames", "afterDir": "<成片帧目录>/frames",
  "noiseDir": "<原片帧目录>/frames-again",
  "checks": ["visibility"]
}'
```

### 路径 B：改草稿并验收（"改完顺便审一遍"）

```bash
# ① 开副本 ⇒ ② 读结构拿 segmentId ⇒ ③ 改（可多次）⇒ ④ 落盘 ⇒ ⑤ 语义验收
node ${PLUGIN_ROOT}/scripts/run-verb.mjs draft_open  '{"draft":"<草稿库>\\<草稿名>","copy":true}'
node ${PLUGIN_ROOT}/scripts/run-verb.mjs draft_read  '{"sessionId":"ve-session-N"}'
node ${PLUGIN_ROOT}/scripts/run-verb.mjs draft_patch '{"op":"video.setVolume","sessionId":"ve-session-N","params":{"segmentId":"<uuid>","volume":0.25}}'
node ${PLUGIN_ROOT}/scripts/run-verb.mjs draft_commit '{"sessionId":"ve-session-N","realDraft":"<草稿库>\\<草稿名>"}'
# ⑤ 语义判据：★ 两份草稿必须是【裸草稿】（顶层就有 tracks）——draft_read 的响应外面还包了一层 draft
node ${PLUGIN_ROOT}/scripts/run-verb.mjs verify_diff '{
  "checks": ["timeline"],
  "beforeDraft": "<改前的裸草稿.json>", "afterDraft": "<改后的裸草稿.json>",
  "expect": { "segmentFieldChanged": "volume" }
}'
```

### 路径 C：剪口播并出成片（"把口播的废话剪了再出片"）

```bash
# ① ★ 先要 SRT（用户给的转写稿）——没有它就停，别自己编
# ② 开副本 + 读结构
node ${PLUGIN_ROOT}/scripts/run-verb.mjs draft_open '{"draft":"<草稿库>\\<草稿名>","copy":true}'
node ${PLUGIN_ROOT}/scripts/run-verb.mjs draft_read '{"sessionId":"ve-session-N"}'
# ③ 规划保留区间（产出"保留/删除"表 ⇒ ★ 必须给用户确认后再落刀）
node ${PLUGIN_ROOT}/scripts/talk-cut-plan.mjs --srt "<用户给的.srt>" --draft "<①的 dir>"
# ④ 用户确认后落稿（走 27 个官方 op 落草稿）
node ${PLUGIN_ROOT}/scripts/talk-cut-apply.mjs --plan "<上一步的 plan.json>" --sessionId "ve-session-N"
# ⑤ 落盘 + ⑥ 出成片（同路径 A 的 ②，draft 用 ① 的 dir）
node ${PLUGIN_ROOT}/scripts/run-verb.mjs draft_commit '{"sessionId":"ve-session-N","realDraft":"<草稿库>\\<草稿名>"}'
node ${PLUGIN_ROOT}/scripts/run-verb.mjs make_film '{"draft":"<①的 dir>","outDir":"<输出目录>","denoise":"auto"}'
```

### 路径 D：改完直接出片（"改完直接出个片"）

= **路径 B 的 ①~④** + **路径 A 的 ②**（`make_film` 的 `draft` 用同一个 `dir`）。

## ★ 跨链共享会话（这一节是本 skill 的核心）

| 东西 | 谁产出 | 谁消费 | 说明 |
|---|---|---|---|
| `sessionId`（`ve-session-N`） | `draft_open` | `draft_read` / `draft_patch` / `draft_commit` | 草稿改动的状态靠它串起来 |
| `dir`（副本目录） | `draft_open` | `make_film` / `render_frames` / `talk-cut-apply` | ★ **副本目录是草稿动词与出片动词之间的交接点** |
| `realDraft`（真草稿目录） | 用户给 | `draft_commit` | 只用于**落盘前的 sha 断言**（真草稿只读） |

⇒ ★ **`make_film` / `render_frames` 不接 `sessionId`，只接草稿目录** ⇒ 跨链时要把 `dir` 显式传过去。
⇒ ★ 真草稿**全程只读**：`draft_commit` 会逐文件 sha 断言真草稿没被改；被改了就会判失败（危险信号，立刻停）。

## 失败处理

| 症状 | 原因 | 怎么办 |
|---|---|---|
| `管道连不上` / `fetch failed` | 剪映没在跑（或刚启动、VE 还没就绪） | 让用户开剪映；**刚启动时等一下**（VE 要几十秒才起） |
| 成片只有几 KB、画面全黑 | 草稿引用的素材不在盘上 | 查素材路径；这是**输入问题**，不是链坏了 |
| `草稿读不出来（可能是官方加密封装）` | `verify_diff` 拿到的是**加密**草稿 | 传**裸草稿**（顶层有 tracks 的明文 JSON） |
| `timeline` 判 FAIL | 语义判据没看到预期字段变化 | ① `expect` 的字段名对不对 ② `beforeDraft`/`afterDraft` 是不是**改前/改后**两份 |
| `源画面几乎全黑 ⇒ 源没有可测信息` | 源本身没信息（不是调色没生效） | 换有大面积中间调/亮部的源 |
| 官方批量 op 报错 | ★ **官方没有批量 op** | 连着调多次 `draft_patch`（每次 `baseRevision` 会递增） |

## ★ 边界（不做什么 / 为什么 / 替代）

| 不做 | 为什么 | 替代 |
|---|---|---|
| **改真草稿** | 官方零文件监听 ⇒ 写盘不保证 GUI 立刻可见；且官方库只读是红线 | 人工在剪映里导入/替换副本 |
| **自己编 SRT / 自己转写口播** | 官方 ASR（`AnalyzeAsset`）在 agent runtime 里、拿不到 | ★ 让用户给 SRT |
| **用官方导出器出片** | 官方 CLI 侧被 −100007 / −100015 挡死，**不绕** | `make_film`（官方渲染器出画面 + 我们的调色/混音/编码） |
| **把曲线/HSL/色轮写回剪映预览** | 官方预览渲染器本身也不认这些（只认强度型调色） | 本地出片（`make_film --grade`） |
| **发布 / 上传多平台** | 发布侧另有 skill 体系 | `daily-platforms-export` 等 |
| **从零生成（AIGC 资产 / 一条龙生成）** | 生成线在 processor 沙箱里，取不到 | 不做 |

## 参考

- **参数怎么填**（人话 → 参数，机器可读 21 条）：`references/intent-map.json`
- **跨链路线**（4 条路线的机器可读定义）：`references/pipeline-profiles.json`
- **判据怎么定**（视野 / 噪声底 / 负向注入 / 语义优先）：`references/verify-discipline.md`
- **单链条的细节**：`jianying-cut` · `jianying-draft-edit` · `jianying-review` · `jianying-talk-cut`
- **官方 op 全集**（18 域 199 个）：`references/official-ops.md`
- **踩坑清单**：`references/pitfalls.md`
